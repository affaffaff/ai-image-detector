/**
 * MV3 service worker: message router and scan orchestrator.
 *
 * Lifetime rules this file is built around:
 *  - The SW dies after ~30s idle. NO scan state lives in SW memory — the
 *    session memo is chrome.storage.session, and content scripts re-request
 *    in-flight scans when their port drops.
 *  - Inference and image fetching live in the offscreen document (WebGPU is
 *    unavailable here; bytes never cross a JSON message boundary).
 *  - Fusion runs here: it is pure math on small numbers, and keeping it in
 *    one place means one code path to audit for the calibration order.
 */

import { fuse, DECISION_THRESHOLD } from '../fusion/fuse.js';
import { MonotoneCalibrator, IDENTITY_CALIBRATOR } from '../fusion/calibration.js';
import { MSG, PORT_SCAN, TARGET } from '../shared/messages.js';
import {
  DEV_MOCK_DEFAULT,
  DEV_MOCK_FLAG,
  ENABLED_FLAG,
  SCAN_MEMO_MAX,
  SCAN_PRIORITY_NEAR,
} from '../shared/constants.js';
import { isSessionMemoizableUrl } from '../shared/inline-payload.js';

/** @typedef {import('../shared/messages.js').ScanRequest} ScanRequest */
/** @typedef {import('../shared/messages.js').ScanUpdate} ScanUpdate */
/** @typedef {import('../shared/messages.js').InferResult} InferResult */

// ---------------------------------------------------------------------------
// Offscreen document lifecycle

const OFFSCREEN_URL = 'offscreen/offscreen.html';

/** @type {Promise<void> | null} */
let creatingOffscreen = null;

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (contexts.length > 0) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification:
          'ONNX Runtime Web inference (WASM/WebGPU) is unavailable in MV3 service workers',
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

// ---------------------------------------------------------------------------
// Fusion configuration
//
// Calibration curves are fitted OFFLINE (tools/fit_calibration.py) on a
// dedicated split and shipped as JSON knot tables. Until fitted curves land,
// the identity calibrator keeps the pipeline runnable — that state is a
// BRING-UP state, warned loudly, never a production configuration.

/** @type {{signals: Record<string, {calibrator: MonotoneCalibrator, weight: number}>, fusedCalibrator: MonotoneCalibrator} | null} */
let fusionCfg = null;

/** @param {string} path */
async function tryLoadCalibrator(path) {
  try {
    const res = await fetch(chrome.runtime.getURL(path));
    if (!res.ok) return null;
    return MonotoneCalibrator.fromJSON(await res.json());
  } catch {
    return null;
  }
}

async function loadFusionConfig() {
  if (fusionCfg) return fusionCfg;
  const detectorCal = await tryLoadCalibrator('calibration/detector.json');
  const fusedCal = await tryLoadCalibrator('calibration/fused.json');
  if (!detectorCal || !fusedCal) {
    console.warn(
      '[fusion] fitted calibration not found — running BRING-UP identity calibration. ' +
        'Scores are NOT placed on the 0.65 boundary. Do not evaluate accuracy in this state.',
    );
  }
  fusionCfg = {
    signals: {
      detector: { calibrator: detectorCal ?? IDENTITY_CALIBRATOR, weight: 1 },
    },
    fusedCalibrator: fusedCal ?? IDENTITY_CALIBRATOR,
  };
  return fusionCfg;
}

// ---------------------------------------------------------------------------
// Session memo (chrome.storage.session — survives SW death, dies with browser)
//
// Runtime memoization of images already scanned this session. This is a
// cache over real inference results, recomputed from pixels every session —
// explicitly NOT a shipped lookup table.

/** @typedef {Record<string, {update: ScanUpdate, ts: number}>} ScanMemo */

/** @type {ScanMemo | null} */
let memoCache = null;
/** @type {Promise<ScanMemo> | null} */
let memoLoad = null;
let scanningEnabled = true;
/** @type {boolean | null} */
let allowMockCache = null;

void chrome.storage.local.get([ENABLED_FLAG, DEV_MOCK_FLAG]).then((got) => {
  const enabled = got[ENABLED_FLAG];
  scanningEnabled = enabled === undefined ? true : Boolean(enabled);
  const mockSetting = got[DEV_MOCK_FLAG];
  allowMockCache =
    __DEV_BUILD__ && (mockSetting === undefined ? DEV_MOCK_DEFAULT : Boolean(mockSetting));
}).catch(() => {});

chrome.storage.onChanged?.addListener((changes, area) => {
  if (area !== 'local') return;
  if (ENABLED_FLAG in changes) {
    const v = changes[ENABLED_FLAG]?.newValue;
    scanningEnabled = v === undefined ? true : Boolean(v);
  }
  if (DEV_MOCK_FLAG in changes) {
    const mockSetting = changes[DEV_MOCK_FLAG]?.newValue;
    allowMockCache =
      __DEV_BUILD__ && (mockSetting === undefined ? DEV_MOCK_DEFAULT : Boolean(mockSetting));
  }
});

/** @returns {Promise<ScanMemo>} */
async function memoRead() {
  const got = await chrome.storage.session.get('scanMemo');
  return /** @type {ScanMemo} */ (got['scanMemo'] ?? {});
}

/** @returns {Promise<ScanMemo>} */
async function memoEnsure() {
  if (memoCache) return memoCache;
  if (!memoLoad) {
    memoLoad = memoRead()
      .then((scanMemo) => {
        memoCache = scanMemo;
        return scanMemo;
      })
      .catch((err) => {
        memoLoad = null;
        throw err;
      });
  }
  return memoLoad;
}

/** @param {string} url @returns {Promise<ScanUpdate | null>} */
async function memoGet(url) {
  if (!isSessionMemoizableUrl(url)) return null;
  const scanMemo = await memoEnsure();
  const hit = scanMemo[url];
  return hit ? { ...hit.update } : null;
}

/** @param {string} url @param {ScanUpdate} update */
function memoPut(url, update) {
  if (!isSessionMemoizableUrl(url)) return;
  const write = async () => {
    const scanMemo = await memoEnsure();
    scanMemo[url] = { update: { ...update, id: '' }, ts: Date.now() };
    const keys = Object.keys(scanMemo);
    if (keys.length > SCAN_MEMO_MAX) {
      keys
        .sort((a, b) => (scanMemo[a]?.ts ?? 0) - (scanMemo[b]?.ts ?? 0))
        .slice(0, keys.length - SCAN_MEMO_MAX)
        .forEach((k) => delete scanMemo[k]);
    }
    await chrome.storage.session.set({ scanMemo });
  };
  // Persist in the background. The badge must not wait on serializing the
  // whole session memo through chrome.storage.
  void write().catch(() => {});
}

/**
 * Count of completed scans this session.
 *
 * Deliberately NOT derived from the session memo. The memo only holds http(s)
 * URLs (`isSessionMemoizableUrl`), so counting its keys reported 0 on any page
 * whose images are inline data: payloads — Google Images being the worst case,
 * where a fully working scanner still showed "Scanned this session: 0". The
 * counter must describe work done, not what happened to be cacheable.
 *
 * Lives in chrome.storage.session because the service worker dies after ~30s
 * idle; the in-memory value is a write-through cache, not the source of truth.
 */
/** @type {number | null} */
let scanCountCache = null;
/** @type {Promise<number> | null} */
let scanCountLoad = null;

/** @returns {Promise<number>} */
async function scanCountEnsure() {
  if (scanCountCache !== null) return scanCountCache;
  if (!scanCountLoad) {
    scanCountLoad = chrome.storage.session
      .get('scanCount')
      .then((got) => {
        const value = got['scanCount'];
        scanCountCache = typeof value === 'number' && Number.isFinite(value) ? value : 0;
        return scanCountCache;
      })
      .catch((err) => {
        scanCountLoad = null;
        throw err;
      });
  }
  return scanCountLoad;
}

function scanCountIncrement() {
  const write = async () => {
    const current = await scanCountEnsure();
    scanCountCache = current + 1;
    await chrome.storage.session.set({ scanCount: scanCountCache });
  };
  void write().catch(() => {});
}

// ---------------------------------------------------------------------------
// Scan pipeline

/** @param {ScanRequest} req @returns {Promise<ScanUpdate>} */
async function scanOne(req) {
  const memoized = await memoGet(req.url);
  if (memoized) return { ...memoized, id: req.id, url: req.url };

  await ensureOffscreen();

  const allowMock =
    allowMockCache ??
    (__DEV_BUILD__ && DEV_MOCK_DEFAULT);

  /** @type {InferResult} */
  const result = await chrome.runtime.sendMessage({
    type: MSG.INFER_RUN,
    target: TARGET.OFFSCREEN,
    id: req.id,
    url: req.url,
    allowMock,
    priority: typeof req.priority === 'number' ? req.priority : SCAN_PRIORITY_NEAR,
  });

  if (!result.ok) {
    /** @type {ScanUpdate} */
    const update =
      result.error === 'no-model'
        ? { id: req.id, url: req.url, state: 'no-model' }
        : { id: req.id, url: req.url, state: 'unscannable', error: result.error };
    return update;
  }

  const cfg = await loadFusionConfig();
  const fused = fuse([{ name: 'detector', raw: /** @type {number} */ (result.raw) }], cfg);

  /** @type {ScanUpdate} */
  const update = {
    id: req.id,
    url: req.url,
    state: 'scored',
    probability: fused.probability,
    isAI: fused.probability >= DECISION_THRESHOLD,
    engine: result.engine,
    contributions: fused.contributions.map((c) => ({ name: c.name, bits: c.bits })),
  };
  memoPut(req.url, update);
  scanCountIncrement();
  return update;
}

// ---------------------------------------------------------------------------
// Ports (content scripts) and one-shot messages (popup, offscreen)

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_SCAN) return;

  // Creating the offscreen host (and therefore starting engine warmup) on
  // connect — not on the first SCAN_REQUEST — overlaps WASM compile with
  // the page's own image loading.
  void ensureOffscreen().catch(() => {});
  void loadFusionConfig().catch(() => {});
  void memoEnsure().catch(() => {});

  port.onMessage.addListener(async (msg) => {
    if (msg?.type !== MSG.SCAN_REQUEST) return;
    if (!scanningEnabled) {
      try {
        port.postMessage({
          type: MSG.SCAN_UPDATE,
          id: msg.id,
          url: msg.url,
          state: 'unscannable',
          error: 'disabled',
        });
      } catch {
        /* disconnected */
      }
      return;
    }

    try {
      const update = await scanOne(msg);
      port.postMessage({ type: MSG.SCAN_UPDATE, ...update });
    } catch (err) {
      // Port may already be gone (tab closed) — that is fine.
      try {
        port.postMessage({
          type: MSG.SCAN_UPDATE,
          id: msg.id,
          url: msg.url,
          state: 'unscannable',
          error: String(err),
        });
      } catch {
        /* disconnected */
      }
    }
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || (msg.target && msg.target !== TARGET.SW)) return false;

  switch (msg.type) {
    case MSG.STATUS_GET:
      void (async () => {
        await ensureOffscreen();
        const model = await chrome.runtime.sendMessage({
          type: MSG.MODEL_STATUS_GET,
          target: TARGET.OFFSCREEN,
        });
        sendResponse({ model, scannedThisSession: await scanCountEnsure() });
      })().catch((err) => {
        sendResponse({
          model: {
            state: 'error',
            detail: err instanceof Error ? err.message : String(err),
          },
          scannedThisSession: 0,
        });
      });
      return true;
    case MSG.MODEL_RETRY:
      void recoverModel('popup').then(sendResponse).catch((err) => {
        sendResponse({
          state: 'error',
          detail: err instanceof Error ? err.message : String(err),
        });
      });
      return true;
    case MSG.MODEL_PROGRESS:
      // Progress events exist for a future setup UI; popup polls for now.
      return false;
    default:
      return false;
  }
});

// ---------------------------------------------------------------------------
// Setup: the weight download must be automatic and obvious (the evaluator
// installs, lets it download, then cuts the network).

async function notifyModelReady() {
  const message = { type: MSG.MODEL_READY };
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    /* no extension-page listeners yet */
  }
  // runtime.sendMessage misses tabs whose content script is not listening yet
  // (install/startup recovery often wins that race). Fan out per tab so an
  // already-open page that latched on a transient no-model still recovers.
  if (!chrome.tabs?.query || !chrome.tabs?.sendMessage) return;
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs.map((tab) =>
        tab.id == null
          ? Promise.resolve()
          : chrome.tabs.sendMessage(tab.id, message).catch(() => {
              /* chrome://, Web Store, discarded, or no content script */
            }),
      ),
    );
  } catch {
    /* tabs.query can reject in restricted contexts */
  }
}

/** @type {Promise<import('../shared/messages.js').ModelStatus> | null} */
let modelRecoveryPromise = null;

/**
 * All setup entry points join one recovery flight. The offscreen host also
 * locks the actual fetch, so this remains safe if the service worker restarts
 * while a download is still running.
 *
 * @param {'installed' | 'startup' | 'popup'} source
 * @returns {Promise<import('../shared/messages.js').ModelStatus>}
 */
function recoverModel(source) {
  if (modelRecoveryPromise) return modelRecoveryPromise;
  modelRecoveryPromise = (async () => {
    await ensureOffscreen();
    let status = await chrome.runtime.sendMessage({
      type: MSG.MODEL_STATUS_GET,
      target: TARGET.OFFSCREEN,
    });
    if (status?.state === 'missing' || status?.state === 'error' || status?.state === 'downloading') {
      status = await chrome.runtime.sendMessage({
        type: MSG.MODEL_DOWNLOAD,
        target: TARGET.OFFSCREEN,
      });
    }
    if (status?.state === 'ready') await notifyModelReady();
    if (status?.state === 'error') {
      console.warn(`[setup:${source}] model recovery paused:`, status.detail ?? 'unknown error');
    }
    return status;
  })().finally(() => {
    modelRecoveryPromise = null;
  });
  return modelRecoveryPromise;
}

function scheduleModelRecovery(/** @type {'installed' | 'startup'} */ source) {
  void recoverModel(source).catch((err) =>
    console.warn(
      `[setup:${source}] model check failed:`,
      err instanceof Error ? err.message : String(err),
    ),
  );
}

chrome.runtime.onInstalled.addListener(() => {
  scheduleModelRecovery('installed');
});

chrome.runtime.onStartup.addListener(() => {
  scheduleModelRecovery('startup');
});
