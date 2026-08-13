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
import { ENABLED_FLAG, SCAN_MEMO_MAX } from '../shared/constants.js';

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
// explicitly NOT a shipped lookup table (bounty rule 8).

/** @typedef {Record<string, {update: ScanUpdate, ts: number}>} ScanMemo */

/** @returns {Promise<ScanMemo>} */
async function memoRead() {
  const got = await chrome.storage.session.get('scanMemo');
  return /** @type {ScanMemo} */ (got['scanMemo'] ?? {});
}

/** @param {string} url @returns {Promise<ScanUpdate | null>} */
async function memoGet(url) {
  const scanMemo = await memoRead();
  const hit = scanMemo[url];
  return hit ? { ...hit.update } : null;
}

/** @param {string} url @param {ScanUpdate} update */
async function memoPut(url, update) {
  const scanMemo = await memoRead();
  scanMemo[url] = { update: { ...update, id: '' }, ts: Date.now() };
  const keys = Object.keys(scanMemo);
  if (keys.length > SCAN_MEMO_MAX) {
    keys
      .sort((a, b) => (scanMemo[a]?.ts ?? 0) - (scanMemo[b]?.ts ?? 0))
      .slice(0, keys.length - SCAN_MEMO_MAX)
      .forEach((k) => delete scanMemo[k]);
  }
  await chrome.storage.session.set({ scanMemo });
}

// ---------------------------------------------------------------------------
// Scan pipeline

/** @param {ScanRequest} req @returns {Promise<ScanUpdate>} */
async function scanOne(req) {
  const memoized = await memoGet(req.url);
  if (memoized) return { ...memoized, id: req.id };

  await ensureOffscreen();

  /** @type {InferResult} */
  const result = await chrome.runtime.sendMessage({
    type: MSG.INFER_RUN,
    target: TARGET.OFFSCREEN,
    id: req.id,
    url: req.url,
  });

  if (!result.ok) {
    /** @type {ScanUpdate} */
    const update =
      result.error === 'no-model'
        ? { id: req.id, state: 'no-model' }
        : { id: req.id, state: 'unscannable', error: result.error };
    return update;
  }

  const cfg = await loadFusionConfig();
  const fused = fuse([{ name: 'detector', raw: /** @type {number} */ (result.raw) }], cfg);

  /** @type {ScanUpdate} */
  const update = {
    id: req.id,
    state: 'scored',
    probability: fused.probability,
    isAI: fused.probability >= DECISION_THRESHOLD,
    engine: result.engine,
    contributions: fused.contributions.map((c) => ({ name: c.name, bits: c.bits })),
  };
  await memoPut(req.url, update);
  return update;
}

// ---------------------------------------------------------------------------
// Ports (content scripts) and one-shot messages (popup, offscreen)

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_SCAN) return;

  port.onMessage.addListener(async (msg) => {
    if (msg?.type !== MSG.SCAN_REQUEST) return;
    const { [ENABLED_FLAG]: enabled = true } = await chrome.storage.local.get(ENABLED_FLAG);
    if (!enabled) return;

    try {
      const update = await scanOne(msg);
      port.postMessage({ type: MSG.SCAN_UPDATE, ...update });
    } catch (err) {
      // Port may already be gone (tab closed) — that is fine.
      try {
        port.postMessage({
          type: MSG.SCAN_UPDATE,
          id: msg.id,
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
        const scanMemo = await memoRead();
        sendResponse({ model, scannedThisSession: Object.keys(scanMemo).length });
      })();
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

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    await ensureOffscreen();
    const status = await chrome.runtime.sendMessage({
      type: MSG.MODEL_STATUS_GET,
      target: TARGET.OFFSCREEN,
    });
    if (status?.state === 'missing') {
      await chrome.runtime.sendMessage({ type: MSG.MODEL_DOWNLOAD, target: TARGET.OFFSCREEN });
    }
  })().catch((err) => console.warn('[setup] model check failed:', err));
});
