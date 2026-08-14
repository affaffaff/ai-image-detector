// src/fusion/calibration.js
function clampProb(p, eps = 1e-6) {
  if (!Number.isFinite(p)) throw new RangeError(`non-finite probability: ${p}`);
  return Math.min(1 - eps, Math.max(eps, p));
}
var MonotoneCalibrator = class _MonotoneCalibrator {
  /**
   * @param {{xs: number[], ys: number[], id?: string, fittedOn?: string}} table
   */
  constructor(table) {
    let { xs, ys } = table ?? {};
    if (!Array.isArray(xs) || !Array.isArray(ys))
      throw new TypeError("calibration table needs xs[] and ys[]");
    if (xs.length !== ys.length)
      throw new RangeError("calibration table xs/ys length mismatch");
    if (xs.length < 2)
      throw new RangeError("calibration table needs at least 2 knots");
    for (let i = 1; i < xs.length; i++) {
      let xPrev = (
        /** @type {number} */
        xs[i - 1]
      );
      if (!(/** @type {number} */
      xs[i] > xPrev))
        throw new RangeError(`calibration xs not strictly increasing at ${i}`);
      let yPrev = (
        /** @type {number} */
        ys[i - 1]
      );
      if (/** @type {number} */
      ys[i] < yPrev)
        throw new RangeError(`calibration ys not monotone at ${i}`);
    }
    this.xs = Float64Array.from(xs), this.ys = Float64Array.from(ys), this.id = table.id ?? "unnamed", this.fittedOn = table.fittedOn ?? null;
  }
  /**
   * Map a raw score to a calibrated probability.
   * Inputs outside the fitted range are clamped to the endpoints, which is the
   * correct conservative behaviour: we never extrapolate a curve we did not fit.
   * @param {number} raw
   * @returns {number}
   */
  apply(raw) {
    if (!Number.isFinite(raw)) throw new RangeError(`non-finite score: ${raw}`);
    let { xs, ys } = this, n = xs.length;
    if (raw <= /** @type {number} */
    xs[0]) return (
      /** @type {number} */
      ys[0]
    );
    if (raw >= /** @type {number} */
    xs[n - 1]) return (
      /** @type {number} */
      ys[n - 1]
    );
    let lo = 0, hi = n - 1;
    for (; hi - lo > 1; ) {
      let mid = lo + hi >> 1;
      /** @type {number} */
      xs[mid] <= raw ? lo = mid : hi = mid;
    }
    let xLo = (
      /** @type {number} */
      xs[lo]
    ), xHi = (
      /** @type {number} */
      xs[hi]
    ), yLo = (
      /** @type {number} */
      ys[lo]
    ), yHi = (
      /** @type {number} */
      ys[hi]
    ), span = xHi - xLo, t = span === 0 ? 0 : (raw - xLo) / span;
    return yLo + t * (yHi - yLo);
  }
  /**
   * @param {string | {xs: number[], ys: number[], id?: string, fittedOn?: string}} json
   * @returns {MonotoneCalibrator}
   */
  static fromJSON(json) {
    return new _MonotoneCalibrator(typeof json == "string" ? JSON.parse(json) : json);
  }
}, IDENTITY_CALIBRATOR = new MonotoneCalibrator({
  xs: [0, 1],
  ys: [0, 1],
  id: "identity"
});

// src/fusion/fuse.js
var DECISION_THRESHOLD = 0.65, DEFAULT_MAX_ABS_LOG_ODDS = 8;
function logit(p) {
  let c = clampProb(p);
  return Math.log(c / (1 - c));
}
function sigmoid(x) {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  let e = Math.exp(x);
  return e / (1 + e);
}
function fuse(signals, cfg) {
  let {
    signals: signalCfg,
    prior = 0.5,
    fusedCalibrator,
    maxAbsLogOdds = DEFAULT_MAX_ABS_LOG_ODDS
  } = cfg;
  if (!(fusedCalibrator instanceof MonotoneCalibrator))
    throw new TypeError("fusedCalibrator is required; without it the boundary is not at 0.65");
  let override = signals.find((s) => s.override);
  if (override) {
    let p = clampProb(override.overrideP ?? 1 - 1e-6);
    return {
      probability: p,
      isAI: p >= DECISION_THRESHOLD,
      contributions: [{ name: override.name, bits: 1 / 0, reason: override.reason ?? "signed manifest" }],
      path: "override"
    };
  }
  let L = logit(prior), contributions = [];
  for (let s of signals) {
    if (s.raw == null) continue;
    let conf = signalCfg[s.name];
    if (!conf) throw new Error(`no config for signal '${s.name}'`);
    let p = clampProb(conf.calibrator.apply(s.raw)), llr = Math.log(p / (1 - p)), term = conf.weight * llr;
    L += term, contributions.push({
      name: s.name,
      raw: s.raw,
      calibrated: p,
      weight: conf.weight,
      // Reported in bits for the per-image detail popover, so the UI can show
      // which signal actually drove the verdict.
      bits: term / Math.LN2
    });
  }
  L = Math.max(-maxAbsLogOdds, Math.min(maxAbsLogOdds, L));
  let fusedRaw = sigmoid(L), probability = clampProb(fusedCalibrator.apply(fusedRaw));
  return {
    probability,
    isAI: probability >= DECISION_THRESHOLD,
    contributions,
    path: "fusion"
  };
}

// src/shared/graphic-gate.js
var GRAPHIC_GATE_THRESHOLDS = Object.freeze({
  /** Most of the sampled area must be dead flat. */
  minFlatFraction: 0.7,
  /** Almost no photographic mid-band texture is tolerated overall. */
  maxSoftFraction: 0.18,
  /** Some hard structure (text/line/edge) must exist. */
  minHardFraction: 5e-4,
  /** The palette must be concentrated. */
  minTop8Mass: 0.68,
  /** And no single patch may look photographic on its own. */
  maxPatchSoftFraction: 0.16
}), GRAPHIC_PROBABILITY_CAP = 0.35;
function applyGraphicCap(probability) {
  let capped = Math.min(probability, GRAPHIC_PROBABILITY_CAP);
  return { probability: capped, capped: capped < probability };
}

// src/shared/native-veto.js
var NATIVE_VETO_MAX_TAU = 0.1;
function applyNativeTileVeto(input) {
  let { probability, nativeMax, nativeMedian, fuseNative } = input;
  if (!Number.isFinite(probability))
    throw new RangeError(`non-finite probability: ${probability}`);
  if (probability < DECISION_THRESHOLD) return { probability, vetoed: !1 };
  if (typeof nativeMax != "number" || !(nativeMax < NATIVE_VETO_MAX_TAU))
    return { probability, vetoed: !1 };
  let nativeRaw = Number.isFinite(nativeMedian) ? (
    /** @type {number} */
    nativeMedian
  ) : nativeMax, fromNative = clampProb(fuseNative(nativeRaw)), capped = Math.min(probability, fromNative, DECISION_THRESHOLD - 1e-6);
  return { probability: capped, vetoed: capped < probability };
}

// src/shared/display-score.js
var DISPLAY_MIN = 2, DISPLAY_MAX = 98, DISPLAY_THRESHOLD = 65;
function reportableRange(fusedCalibrator, maxAbsLogOdds = DEFAULT_MAX_ABS_LOG_ODDS) {
  return {
    min: fusedCalibrator.apply(sigmoid(-maxAbsLogOdds)),
    max: fusedCalibrator.apply(sigmoid(maxAbsLogOdds))
  };
}
function displayPercent(probability, isAI, range) {
  if (!Number.isFinite(probability)) throw new RangeError(`non-finite probability: ${probability}`);
  let min = Math.min(range.min, DECISION_THRESHOLD), max = Math.max(range.max, DECISION_THRESHOLD), pct;
  if (probability <= DECISION_THRESHOLD) {
    let span = DECISION_THRESHOLD - min, t = span > 0 ? (probability - min) / span : 1;
    pct = DISPLAY_MIN + t * (DISPLAY_THRESHOLD - DISPLAY_MIN);
  } else {
    let span = max - DECISION_THRESHOLD, t = span > 0 ? (probability - DECISION_THRESHOLD) / span : 0;
    pct = DISPLAY_THRESHOLD + t * (DISPLAY_MAX - DISPLAY_THRESHOLD);
  }
  let rounded = Math.round(Math.min(DISPLAY_MAX, Math.max(DISPLAY_MIN, pct)));
  return isAI ? Math.max(DISPLAY_THRESHOLD, rounded) : Math.min(DISPLAY_THRESHOLD - 1, rounded);
}

// src/shared/messages.js
var MSG = Object.freeze({
  // content -> SW (long-lived port, name PORT_SCAN)
  SCAN_REQUEST: "scan:request",
  SCAN_PRIORITY: "scan:priority",
  // SW -> content (same port)
  SCAN_UPDATE: "scan:update",
  // SW -> offscreen
  INFER_RUN: "infer:run",
  INFER_PRIORITY: "infer:priority",
  INFER_CANCEL: "infer:cancel",
  MODEL_STATUS_GET: "model:status-get",
  MODEL_DOWNLOAD: "model:download",
  // offscreen -> SW (unsolicited)
  MODEL_PROGRESS: "model:progress",
  // SW -> content scripts (all frames): weights just became usable
  MODEL_READY: "model:ready",
  // popup -> SW -> content: cosmetic blur of AI-scored images
  BLUR_SETTING: "blur:setting",
  // popup -> SW -> content: master scan enable (mirrors blur:setting so the
  // active tab does not wait on chrome.storage.onChanged)
  ENABLED_SETTING: "enabled:setting",
  // popup -> SW
  STATUS_GET: "status:get",
  MODEL_RETRY: "model:retry"
}), PORT_SCAN = "scan", TARGET = Object.freeze({
  OFFSCREEN: "offscreen",
  SW: "sw"
});

// src/shared/constants.js
var DEV_MOCK_FLAG = "devMockInference";
var ENABLED_FLAG = "enabled";
function flagFromStorage(value, fallback) {
  return value === void 0 ? fallback : !!value;
}
function readStoredFlag(liveApplied, stored, fallback) {
  return liveApplied ? null : flagFromStorage(stored, fallback);
}
function enabledFromStorage(value) {
  return flagFromStorage(value, !0);
}
var BLUR_AI_FLAG = "blurAiOptIn";

// src/shared/inline-payload.js
function isSessionMemoizableUrl(url) {
  return url.startsWith("https:") || url.startsWith("http:");
}

// src/background/service-worker.js
var OFFSCREEN_URL = "offscreen/offscreen.html", creatingOffscreen = null;
async function ensureOffscreen() {
  (await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]
  })).length > 0 || (creatingOffscreen || (creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.WORKERS],
    justification: "ONNX Runtime Web inference (WASM/WebGPU) is unavailable in MV3 service workers"
  }).finally(() => {
    creatingOffscreen = null;
  })), await creatingOffscreen);
}
var fusionCfg = null;
async function tryLoadCalibrator(path) {
  try {
    let res = await fetch(chrome.runtime.getURL(path));
    return res.ok ? MonotoneCalibrator.fromJSON(await res.json()) : null;
  } catch {
    return null;
  }
}
async function loadFusionConfig() {
  if (fusionCfg) return fusionCfg;
  let detectorCal = await tryLoadCalibrator("calibration/detector.json"), fusedCal = await tryLoadCalibrator("calibration/fused.json");
  (!detectorCal || !fusedCal) && console.warn(
    "[fusion] fitted calibration not found \u2014 running BRING-UP identity calibration. Scores are NOT placed on the 0.65 boundary. Do not evaluate accuracy in this state."
  );
  let fusedCalibrator = fusedCal ?? IDENTITY_CALIBRATOR;
  return fusionCfg = {
    signals: {
      detector: { calibrator: detectorCal ?? IDENTITY_CALIBRATOR, weight: 1 }
    },
    fusedCalibrator,
    // Derived from the curve that just loaded, so a refit moves the badge
    // scale with it. See src/shared/display-score.js.
    displayRange: reportableRange(fusedCalibrator)
  }, fusionCfg;
}
var memoCache = null, memoLoad = null, scanningEnabled = !1, receivedLiveEnabled = !1, scanEpoch = 0, pendingScanPriority = /* @__PURE__ */ new Map(), PENDING_SCAN_PRIORITY_MAX = 1e3, allowMockCache = null, settingsReady = chrome.storage.local.get([ENABLED_FLAG, DEV_MOCK_FLAG]).then((got) => {
  let enabled = readStoredFlag(receivedLiveEnabled, got[ENABLED_FLAG], !0);
  enabled !== null && (scanningEnabled = enabled);
  let mockSetting = got[DEV_MOCK_FLAG];
  allowMockCache = !1;
}).catch(() => {
  receivedLiveEnabled || (scanningEnabled = !0);
});
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area === "local" && (ENABLED_FLAG in changes && !receivedLiveEnabled && (scanningEnabled = enabledFromStorage(changes[ENABLED_FLAG]?.newValue), scanningEnabled || stopScanning()), DEV_MOCK_FLAG in changes)) {
    let mockSetting = changes[DEV_MOCK_FLAG]?.newValue;
    allowMockCache = !1;
  }
});
async function memoRead() {
  return (
    /** @type {ScanMemo} */
    (await chrome.storage.session.get("scanMemo")).scanMemo ?? {}
  );
}
async function memoEnsure() {
  return memoCache || (memoLoad || (memoLoad = memoRead().then((scanMemo) => (memoCache = scanMemo, scanMemo)).catch((err) => {
    throw memoLoad = null, err;
  })), memoLoad);
}
async function memoGet(url) {
  if (!isSessionMemoizableUrl(url)) return null;
  let hit = (await memoEnsure())[url];
  return hit ? { ...hit.update } : null;
}
function memoPut(url, update) {
  if (!isSessionMemoizableUrl(url)) return;
  (async () => {
    let scanMemo = await memoEnsure();
    scanMemo[url] = { update: { ...update, id: "" }, ts: Date.now() };
    let keys = Object.keys(scanMemo);
    keys.length > 500 && keys.sort((a, b) => (scanMemo[a]?.ts ?? 0) - (scanMemo[b]?.ts ?? 0)).slice(0, keys.length - 500).forEach((k) => delete scanMemo[k]), await chrome.storage.session.set({ scanMemo });
  })().catch(() => {
  });
}
var scanCountCache = null, scanCountLoad = null;
async function scanCountEnsure() {
  return scanCountCache !== null ? scanCountCache : (scanCountLoad || (scanCountLoad = chrome.storage.session.get("scanCount").then((got) => {
    let value = got.scanCount;
    return scanCountCache = typeof value == "number" && Number.isFinite(value) ? value : 0, scanCountCache;
  }).catch((err) => {
    throw scanCountLoad = null, err;
  })), scanCountLoad);
}
var scanCountWrite = Promise.resolve();
function scanCountIncrement() {
  scanCountWrite = scanCountWrite.then(async () => {
    scanCountCache = await scanCountEnsure() + 1, await chrome.storage.session.set({ scanCount: scanCountCache });
  }).catch(() => {
  });
}
function stopScanning() {
  scanEpoch += 1, scanningEnabled = !1, chrome.runtime.sendMessage({ type: MSG.INFER_CANCEL, target: TARGET.OFFSCREEN }).catch(() => {
  });
}
function scanningStopped(epoch) {
  return !scanningEnabled || epoch !== scanEpoch;
}
function rememberScanPriority(id, priority) {
  if (typeof id != "string" || !Number.isFinite(priority)) return;
  let prev = pendingScanPriority.get(id);
  for ((prev == null || priority > prev) && pendingScanPriority.set(id, priority); pendingScanPriority.size > PENDING_SCAN_PRIORITY_MAX; ) {
    let oldest = pendingScanPriority.keys().next();
    if (oldest.done) break;
    pendingScanPriority.delete(oldest.value);
  }
}
function takeScanPriority(req) {
  let boosted = typeof req.id == "string" ? pendingScanPriority.get(req.id) : void 0;
  typeof req.id == "string" && pendingScanPriority.delete(req.id);
  let base = typeof req.priority == "number" ? req.priority : 0;
  return boosted != null && boosted > base ? boosted : base;
}
function postPortUpdate(port, update) {
  try {
    port.postMessage({ type: MSG.SCAN_UPDATE, ...update });
  } catch {
  }
}
async function scanOne(req, epoch) {
  let dropParkedPriority = () => {
    typeof req.id == "string" && pendingScanPriority.delete(req.id);
  };
  if (scanningStopped(epoch))
    return dropParkedPriority(), { id: req.id, url: req.url, state: "unscannable", error: "disabled" };
  let memoized = await memoGet(req.url);
  if (scanningStopped(epoch))
    return dropParkedPriority(), { id: req.id, url: req.url, state: "unscannable", error: "disabled" };
  if (memoized)
    return dropParkedPriority(), { ...memoized, id: req.id, url: req.url };
  if (await ensureOffscreen(), scanningStopped(epoch))
    return dropParkedPriority(), { id: req.id, url: req.url, state: "unscannable", error: "disabled" };
  let allowMock = allowMockCache ?? !1, result = await chrome.runtime.sendMessage({
    type: MSG.INFER_RUN,
    target: TARGET.OFFSCREEN,
    id: req.id,
    url: req.url,
    allowMock,
    priority: takeScanPriority(req)
  });
  if (scanningStopped(epoch))
    return { id: req.id, url: req.url, state: "unscannable", error: "disabled" };
  if (!result.ok)
    return result.error === "no-model" ? { id: req.id, url: req.url, state: "no-model" } : { id: req.id, url: req.url, state: "unscannable", error: result.error };
  let cfg = await loadFusionConfig(), fused = fuse([{ name: "detector", raw: (
    /** @type {number} */
    result.raw
  ) }], cfg), probability = fused.probability, contributions = fused.contributions.map((c) => ({
    name: c.name,
    bits: c.bits,
    ...c.reason ? { reason: c.reason } : {}
  })), gate;
  if (fused.path === "fusion" && result.graphic?.gated) {
    let capped = applyGraphicCap(probability);
    capped.capped && (contributions.push({
      name: "graphic-content cap",
      bits: (logit(capped.probability) - logit(probability)) / Math.LN2
    }), gate = "graphic"), probability = capped.probability;
  }
  if (fused.path === "fusion" && probability >= DECISION_THRESHOLD) {
    let veto = applyNativeTileVeto({
      probability,
      nativeMax: result.nativeMax,
      nativeMedian: result.nativeMedian,
      fuseNative: (raw) => cfg.fusedCalibrator.apply(raw)
    });
    veto.vetoed && (contributions.push({
      name: "native-tile veto",
      bits: (logit(veto.probability) - logit(probability)) / Math.LN2
    }), probability = veto.probability, gate = "native-tiles");
  }
  if (scanningStopped(epoch))
    return { id: req.id, url: req.url, state: "unscannable", error: "disabled" };
  let isAI = probability >= DECISION_THRESHOLD, update = {
    id: req.id,
    url: req.url,
    state: "scored",
    probability,
    display: displayPercent(probability, isAI, cfg.displayRange),
    isAI,
    // statsOnly results never reach scanOne; the scan pipeline only ever
    // produces real or mock verdicts.
    engine: (
      /** @type {'ort' | 'mock'} */
      result.engine
    ),
    ...gate ? { gate } : {},
    contributions
  };
  return memoPut(req.url, update), scanCountIncrement(), update;
}
chrome.runtime.onConnect.addListener((port) => {
  port.name === PORT_SCAN && (settingsReady.then(() => {
    scanningEnabled && (ensureOffscreen().catch(() => {
    }), loadFusionConfig().catch(() => {
    }), memoEnsure().catch(() => {
    }));
  }), port.onDisconnect.addListener(() => {
    chrome.runtime.lastError;
  }), port.onMessage.addListener(async (msg) => {
    if (msg?.type === MSG.SCAN_PRIORITY) {
      if (await settingsReady.catch(() => {
      }), !scanningEnabled) return;
      rememberScanPriority(msg.id, msg.priority), ensureOffscreen().then(
        () => chrome.runtime.sendMessage({
          type: MSG.INFER_PRIORITY,
          target: TARGET.OFFSCREEN,
          id: msg.id,
          priority: msg.priority
        })
      ).catch(() => {
      });
      return;
    }
    if (msg?.type !== MSG.SCAN_REQUEST) return;
    if (await settingsReady.catch(() => {
    }), !scanningEnabled) {
      typeof msg.id == "string" && pendingScanPriority.delete(msg.id), postPortUpdate(port, {
        id: msg.id,
        url: msg.url,
        state: "unscannable",
        error: "disabled"
      });
      return;
    }
    let epoch = scanEpoch;
    try {
      let update = await scanOne(msg, epoch);
      postPortUpdate(port, update);
    } catch (err) {
      postPortUpdate(port, {
        id: msg.id,
        url: msg.url,
        state: "unscannable",
        error: scanningStopped(epoch) ? "disabled" : String(err)
      });
    }
  }));
});
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target && msg.target !== TARGET.SW) return !1;
  switch (msg.type) {
    case MSG.STATUS_GET:
      return (async () => {
        await ensureOffscreen();
        let model = await chrome.runtime.sendMessage({
          type: MSG.MODEL_STATUS_GET,
          target: TARGET.OFFSCREEN
        });
        sendResponse({ model, scannedThisSession: await scanCountEnsure() });
      })().catch((err) => {
        sendResponse({
          model: {
            state: "error",
            detail: err instanceof Error ? err.message : String(err)
          },
          scannedThisSession: 0
        });
      }), !0;
    case MSG.MODEL_RETRY:
      return recoverModel("popup").then(sendResponse).catch((err) => {
        sendResponse({
          state: "error",
          detail: err instanceof Error ? err.message : String(err)
        });
      }), !0;
    case MSG.ENABLED_SETTING:
      return receivedLiveEnabled = !0, msg.target === TARGET.SW ? (persistAndBroadcastEnabled(!!msg.enabled).then(
        () => sendResponse({ ok: !0 }),
        () => sendResponse({ ok: !1 })
      ), !0) : (scanningEnabled = !!msg.enabled, scanningEnabled || stopScanning(), !1);
    case MSG.BLUR_SETTING:
      return msg.target === TARGET.SW ? (persistAndBroadcastBlur(!!msg.enabled).then(
        () => sendResponse({ ok: !0 }),
        () => sendResponse({ ok: !1 })
      ), !0) : !1;
    default:
      return !1;
  }
});
async function notifyModelReady() {
  let message = { type: MSG.MODEL_READY };
  await fanoutToTabs(message);
}
var enabledWriteGen = 0, blurWriteGen = 0;
async function persistAndBroadcastEnabled(enabled) {
  let gen = ++enabledWriteGen;
  await Promise.resolve(), gen === enabledWriteGen && (scanningEnabled = enabled, enabled || stopScanning(), await chrome.storage.local.set({ [ENABLED_FLAG]: enabled }), gen === enabledWriteGen && await broadcastEnabledSetting(enabled));
}
async function persistAndBroadcastBlur(enabled) {
  let gen = ++blurWriteGen;
  await Promise.resolve(), gen === blurWriteGen && (await chrome.storage.local.set({ [BLUR_AI_FLAG]: enabled }), gen === blurWriteGen && await broadcastBlurSetting(enabled));
}
async function broadcastEnabledSetting(enabled) {
  await fanoutToTabs({ type: MSG.ENABLED_SETTING, enabled });
}
async function broadcastBlurSetting(enabled) {
  await fanoutToTabs({ type: MSG.BLUR_SETTING, enabled });
}
async function fanoutToTabs(message) {
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
  }
  if (!(!chrome.tabs?.query || !chrome.tabs?.sendMessage))
    try {
      let tabs = await chrome.tabs.query({});
      await Promise.all(
        tabs.map(
          (tab) => tab.id == null ? Promise.resolve() : chrome.tabs.sendMessage(tab.id, message).catch(() => {
          })
        )
      );
    } catch {
    }
}
var modelRecoveryPromise = null;
function recoverModel(source) {
  return modelRecoveryPromise || (modelRecoveryPromise = (async () => {
    await ensureOffscreen();
    let status = await chrome.runtime.sendMessage({
      type: MSG.MODEL_STATUS_GET,
      target: TARGET.OFFSCREEN
    });
    return (status?.state === "missing" || status?.state === "error" || status?.state === "downloading") && (status = await chrome.runtime.sendMessage({
      type: MSG.MODEL_DOWNLOAD,
      target: TARGET.OFFSCREEN
    })), status?.state === "ready" && await notifyModelReady(), status?.state === "error" && console.warn(`[setup:${source}] model recovery paused:`, status.detail ?? "unknown error"), status;
  })().finally(() => {
    modelRecoveryPromise = null;
  }), modelRecoveryPromise);
}
function scheduleModelRecovery(source) {
  recoverModel(source).catch(
    (err) => console.warn(
      `[setup:${source}] model check failed:`,
      err instanceof Error ? err.message : String(err)
    )
  );
}
chrome.runtime.onInstalled.addListener(() => {
  scheduleModelRecovery("installed");
});
chrome.runtime.onStartup.addListener(() => {
  scheduleModelRecovery("startup");
});
