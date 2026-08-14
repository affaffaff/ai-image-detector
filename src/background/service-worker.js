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

import { fuse, DECISION_THRESHOLD, logit } from '../fusion/fuse.js';
import { MonotoneCalibrator, IDENTITY_CALIBRATOR } from '../fusion/calibration.js';
import { applyGraphicCap } from '../shared/graphic-gate.js';
import { applyNativeTileVeto } from '../shared/native-veto.js';
import { displayPercent, reportableRange } from '../shared/display-score.js';
import { MSG, PORT_SCAN, TARGET } from '../shared/messages.js';
import {
  BLUR_AI_FLAG,
  DEV_MOCK_DEFAULT,
  DEV_MOCK_FLAG,
  ENABLED_FLAG,
  SCAN_MEMO_MAX,
  SCAN_PRIORITY_NEAR,
  enabledFromStorage,
  readStoredFlag,
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

/** @type {{signals: Record<string, {calibrator: MonotoneCalibrator, weight: number}>, fusedCalibrator: MonotoneCalibrator, displayRange: {min: number, max: number}} | null} */
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
  const fusedCalibrator = fusedCal ?? IDENTITY_CALIBRATOR;
  fusionCfg = {
    signals: {
      detector: { calibrator: detectorCal ?? IDENTITY_CALIBRATOR, weight: 1 },
    },
    fusedCalibrator,
    // Derived from the curve that just loaded, so a refit moves the badge
    // scale with it. See src/shared/display-score.js.
    displayRange: reportableRange(fusedCalibrator),
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
/**
 * False until chrome.storage has answered, so a worker that woke for a new
 * tab cannot scan with the first-run default while Detection is actually off.
 */
let scanningEnabled = false;
/** Set when a live ENABLED_SETTING / storage change arrives, so a stale initial get cannot turn it back on. */
let receivedLiveEnabled = false;
/** Bumped when Detection turns off so in-flight scanOne results are dropped. */
let scanEpoch = 0;
/**
 * Viewport promotions that arrived before `INFER_RUN` was keyed. Without this,
 * `reprioritize` is a no-op and the job keeps the prefetch rank.
 * Bounded: entries are consumed by takeScanPriority when the scan is sent, but
 * a scan that ends early (memo hit, Detection off) or a priority update that
 * arrives after its request never is — on an infinite feed that is one stale
 * entry per image for the life of the worker.
 * @type {Map<string, number>}
 */
const pendingScanPriority = new Map();
/** Hard bound on stale promotions; Map order is insertion order. */
const PENDING_SCAN_PRIORITY_MAX = 1000;
/** @type {boolean | null} */
let allowMockCache = null;

const settingsReady = chrome.storage.local
  .get([ENABLED_FLAG, DEV_MOCK_FLAG])
  .then((got) => {
    const enabled = readStoredFlag(receivedLiveEnabled, got[ENABLED_FLAG], true);
    if (enabled !== null) scanningEnabled = enabled;
    const mockSetting = got[DEV_MOCK_FLAG];
    allowMockCache =
      __DEV_BUILD__ && (mockSetting === undefined ? DEV_MOCK_DEFAULT : Boolean(mockSetting));
  })
  .catch(() => {
    if (!receivedLiveEnabled) scanningEnabled = true;
  });

chrome.storage.onChanged?.addListener((changes, area) => {
  if (area !== 'local') return;
  if (ENABLED_FLAG in changes && !receivedLiveEnabled) {
    scanningEnabled = enabledFromStorage(changes[ENABLED_FLAG]?.newValue);
    if (!scanningEnabled) stopScanning();
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

/**
 * Increments chain through this promise so concurrent scanOne completions
 * cannot read the same count and both write current + 1.
 * @type {Promise<void>}
 */
let scanCountWrite = Promise.resolve();

function scanCountIncrement() {
  scanCountWrite = scanCountWrite
    .then(async () => {
      const current = await scanCountEnsure();
      scanCountCache = current + 1;
      await chrome.storage.session.set({ scanCount: scanCountCache });
    })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Scan pipeline

function stopScanning() {
  scanEpoch += 1;
  scanningEnabled = false;
  void chrome.runtime
    .sendMessage({ type: MSG.INFER_CANCEL, target: TARGET.OFFSCREEN })
    .catch(() => {
      /* offscreen document may not exist while Detection is off */
    });
}

/** @param {number} epoch */
function scanningStopped(epoch) {
  return !scanningEnabled || epoch !== scanEpoch;
}

/** @param {string | undefined} id @param {number} priority */
function rememberScanPriority(id, priority) {
  if (typeof id !== 'string' || !Number.isFinite(priority)) return;
  const prev = pendingScanPriority.get(id);
  if (prev == null || priority > prev) pendingScanPriority.set(id, priority);
  // Evict the oldest promotions past the cap. An entry whose scan request
  // resolved from the memo (or while disabled) is never consumed by
  // takeScanPriority, so without a bound the map grows per image scanned.
  while (pendingScanPriority.size > PENDING_SCAN_PRIORITY_MAX) {
    const oldest = pendingScanPriority.keys().next();
    if (oldest.done) break;
    pendingScanPriority.delete(oldest.value);
  }
}

/** @param {ScanRequest} req */
function takeScanPriority(req) {
  const boosted = typeof req.id === 'string' ? pendingScanPriority.get(req.id) : undefined;
  if (typeof req.id === 'string') pendingScanPriority.delete(req.id);
  const base = typeof req.priority === 'number' ? req.priority : SCAN_PRIORITY_NEAR;
  return boosted != null && boosted > base ? boosted : base;
}

/** @param {chrome.runtime.Port} port @param {object} update */
function postPortUpdate(port, update) {
  try {
    port.postMessage({ type: MSG.SCAN_UPDATE, ...update });
  } catch {
    /* disconnected */
  }
}

/** @param {ScanRequest} req @param {number} epoch @returns {Promise<ScanUpdate>} */
async function scanOne(req, epoch) {
  // Early exits never reach takeScanPriority, so consume any parked promotion
  // here — otherwise every memo-hit or disabled scan strands one map entry.
  const dropParkedPriority = () => {
    if (typeof req.id === 'string') pendingScanPriority.delete(req.id);
  };
  if (scanningStopped(epoch)) {
    dropParkedPriority();
    return { id: req.id, url: req.url, state: 'unscannable', error: 'disabled' };
  }
  const memoized = await memoGet(req.url);
  if (scanningStopped(epoch)) {
    dropParkedPriority();
    return { id: req.id, url: req.url, state: 'unscannable', error: 'disabled' };
  }
  if (memoized) {
    dropParkedPriority();
    return { ...memoized, id: req.id, url: req.url };
  }

  await ensureOffscreen();
  if (scanningStopped(epoch)) {
    dropParkedPriority();
    return { id: req.id, url: req.url, state: 'unscannable', error: 'disabled' };
  }

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
    priority: takeScanPriority(req),
  });
  if (scanningStopped(epoch)) {
    return { id: req.id, url: req.url, state: 'unscannable', error: 'disabled' };
  }

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
  let probability = fused.probability;
  const contributions = fused.contributions.map((c) => ({
    name: c.name,
    bits: c.bits,
    ...(c.reason ? { reason: c.reason } : {}),
  }));

  // Graphic-content gate: flat vector art / text / charts are outside the
  // detector's photo-vs-generated training domain, and its confident scores
  // there are noise. Cap — never boost — the fused probability below the
  // fixed threshold. A C2PA override is cryptographic evidence and is never
  // capped (fuse() returns before this on the override path).
  /** @type {'graphic' | 'native-tiles' | undefined} */
  let gate;
  if (fused.path === 'fusion' && result.graphic?.gated) {
    const capped = applyGraphicCap(probability);
    if (capped.capped) {
      // Report the cap in the same log-odds currency as the other rows in
      // the popover, so the verdict stays auditable. Do not set `gate` when
      // the fused score was already below the cap — the popover would claim
      // a cap that did not change the verdict.
      contributions.push({
        name: 'graphic-content cap',
        bits: (logit(capped.probability) - logit(probability)) / Math.LN2,
      });
      gate = 'graphic';
    }
    probability = capped.probability;
  }

  // Native-tile veto: the official Resize(440)+CenterCrop can manufacture
  // generation-like structure when it downscales. If every native 384 crop
  // still looks real, the official AI score is a resampling artifact — cap
  // it the same way the graphic gate does. Official-REAL images are never
  // flipped (rescue was measured and rejected).
  if (fused.path === 'fusion' && probability >= DECISION_THRESHOLD) {
    const veto = applyNativeTileVeto({
      probability,
      nativeMax: result.nativeMax,
      nativeMedian: result.nativeMedian,
      fuseNative: (raw) => cfg.fusedCalibrator.apply(raw),
    });
    if (veto.vetoed) {
      contributions.push({
        name: 'native-tile veto',
        bits: (logit(veto.probability) - logit(probability)) / Math.LN2,
      });
      probability = veto.probability;
      gate = 'native-tiles';
    }
  }
  if (scanningStopped(epoch)) {
    return { id: req.id, url: req.url, state: 'unscannable', error: 'disabled' };
  }
  const isAI = probability >= DECISION_THRESHOLD;

  /** @type {ScanUpdate} */
  const update = {
    id: req.id,
    url: req.url,
    state: 'scored',
    probability,
    display: displayPercent(probability, isAI, cfg.displayRange),
    isAI,
    // statsOnly results never reach scanOne; the scan pipeline only ever
    // produces real or mock verdicts.
    engine: /** @type {'ort' | 'mock'} */ (result.engine),
    ...(gate ? { gate } : {}),
    contributions,
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
  // the page's own image loading. Skip all of that while Detection is off.
  void settingsReady.then(() => {
    if (!scanningEnabled) return;
    void ensureOffscreen().catch(() => {});
    void loadFusionConfig().catch(() => {});
    void memoEnsure().catch(() => {});
  });

  // A content-script port that dies because its tab entered the back/forward
  // cache sets lastError here, on this side of the channel. Leaving it unread
  // is the "Unchecked runtime.lastError" Chrome attributes to the extension.
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
  });

  port.onMessage.addListener(async (msg) => {
    if (msg?.type === MSG.SCAN_PRIORITY) {
      await settingsReady.catch(() => {});
      if (!scanningEnabled) return;
      rememberScanPriority(msg.id, msg.priority);
      void ensureOffscreen()
        .then(() =>
          chrome.runtime.sendMessage({
            type: MSG.INFER_PRIORITY,
            target: TARGET.OFFSCREEN,
            id: msg.id,
            priority: msg.priority,
          }),
        )
        .catch(() => {});
      return;
    }
    if (msg?.type !== MSG.SCAN_REQUEST) return;
    await settingsReady.catch(() => {});
    if (!scanningEnabled) {
      if (typeof msg.id === 'string') pendingScanPriority.delete(msg.id);
      postPortUpdate(port, {
        id: msg.id,
        url: msg.url,
        state: 'unscannable',
        error: 'disabled',
      });
      return;
    }

    const epoch = scanEpoch;
    try {
      const update = await scanOne(msg, epoch);
      postPortUpdate(port, update);
    } catch (err) {
      postPortUpdate(port, {
        id: msg.id,
        url: msg.url,
        state: 'unscannable',
        error: scanningStopped(epoch) ? 'disabled' : String(err),
      });
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
    case MSG.ENABLED_SETTING:
      receivedLiveEnabled = true;
      // Fanout messages omit `target`. Re-broadcasting those would loop
      // through every tab while the popup is open and freeze the page.
      // Persist here: the popup document is destroyed on click-away, which
      // used to cancel its chrome.storage.local.set.
      if (msg.target === TARGET.SW) {
        void persistAndBroadcastEnabled(Boolean(msg.enabled)).then(
          () => sendResponse({ ok: true }),
          () => sendResponse({ ok: false }),
        );
        return true;
      }
      scanningEnabled = Boolean(msg.enabled);
      if (!scanningEnabled) stopScanning();
      return false;
    case MSG.BLUR_SETTING:
      if (msg.target === TARGET.SW) {
        void persistAndBroadcastBlur(Boolean(msg.enabled)).then(
          () => sendResponse({ ok: true }),
          () => sendResponse({ ok: false }),
        );
        return true;
      }
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
  await fanoutToTabs(message);
}

/** Dropped when a newer Detection toggle arrives before persist finishes. */
let enabledWriteGen = 0;
/** Dropped when a newer Blur toggle arrives before persist finishes. */
let blurWriteGen = 0;

/** @param {boolean} enabled */
async function persistAndBroadcastEnabled(enabled) {
  const gen = ++enabledWriteGen;
  // Yield so off→on in the same burst keeps only the last value. Cancelling
  // inference on the off half used to freeze pending images after re-enable.
  await Promise.resolve();
  if (gen !== enabledWriteGen) return;
  scanningEnabled = enabled;
  if (!enabled) stopScanning();
  await chrome.storage.local.set({ [ENABLED_FLAG]: enabled });
  if (gen !== enabledWriteGen) return;
  await broadcastEnabledSetting(enabled);
}

/** @param {boolean} enabled */
async function persistAndBroadcastBlur(enabled) {
  const gen = ++blurWriteGen;
  await Promise.resolve();
  if (gen !== blurWriteGen) return;
  await chrome.storage.local.set({ [BLUR_AI_FLAG]: enabled });
  if (gen !== blurWriteGen) return;
  await broadcastBlurSetting(enabled);
}

/** @param {boolean} enabled */
async function broadcastEnabledSetting(enabled) {
  await fanoutToTabs({ type: MSG.ENABLED_SETTING, enabled });
}

/** @param {boolean} enabled */
async function broadcastBlurSetting(enabled) {
  await fanoutToTabs({ type: MSG.BLUR_SETTING, enabled });
}

/** @param {object} message */
async function fanoutToTabs(message) {
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    /* no extension-page listeners yet */
  }
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


