/**
 * Offscreen inference host.
 *
 * WebGPU is unavailable in MV3 service workers, so all inference lives here
 * (ONNX Runtime Web, WASM execution provider, one thread).
 *
 * This document also fetches image bytes: it holds the same <all_urls> host
 * permission as the service worker, and fetching here avoids marshalling
 * megabytes through JSON runtime messages. Cookie policy: credentials are
 * NEVER sent with image fetches (privacy-first; auth-gated images simply
 * report unscannable).
 *
 * Engine states, honestly reported end-to-end:
 *   - real ORT inference over the verified Community Forensics ONNX artifact
 *   - MOCK engine behind the devMockInference flag, labeled 'mock' in every
 *     result — pipeline demos and e2e tests only, never a real verdict
 *   - otherwise: 'no-model', surfaced as a setup-required badge
 */

import { MSG, TARGET } from '../shared/messages.js';
import {
  MAX_IMAGE_BYTES,
  MAX_DECODE_PIXELS,
  IMAGE_FETCH_TIMEOUT_MS,
  INFER_JOB_TIMEOUT_MS,
  FETCH_CONCURRENCY,
  INFER_CONCURRENCY,
} from '../shared/constants.js';
import { isInlinePayloadTooLarge } from '../shared/inline-payload.js';
import {
  getInstalledModel,
  getInstalledModelBytes,
  getPartialDownloadProgress,
  downloadAndInstall,
  sha256Hex,
} from './download.js';
import { createOrtEngine } from './ort-engine.js';
import { createInferQueue } from './infer-queue.js';
import { bitmapGraphicStats } from './graphic-stats.js';

/** @typedef {import('./download.js').ModelManifestEntry} ModelManifestEntry */
/** @typedef {import('../shared/messages.js').ModelStatus} ModelStatus */

// ---------------------------------------------------------------------------
// Model manifest + status

/** @type {ModelManifestEntry[] | null} */
let manifestEntries = null;

/** @type {ModelStatus} */
let modelStatus = { state: 'missing' };

/** @type {Promise<Awaited<ReturnType<typeof createOrtEngine>>> | null} */
let enginePromise = null;

/** @type {Promise<ModelStatus> | null} */
let downloadPromise = null;

/**
 * Distinguishes "the engine cannot run the verified weights" from "a download
 * attempt failed". Only the former pins the error state: a failed download may
 * have since completed in OPFS, so its status must be recomputed on the next
 * poll instead of latching no-model for the rest of the session.
 */
let runtimeInitFailed = false;

async function loadManifest() {
  if (manifestEntries) return manifestEntries;
  const res = await fetch(chrome.runtime.getURL('models/manifest.json'));
  const json = await res.json();
  const entries = /** @type {ModelManifestEntry[]} */ (json.models ?? []);
  manifestEntries = entries.map((entry) =>
    entry.bundledPath ? { ...entry, url: chrome.runtime.getURL(entry.bundledPath) } : entry,
  );
  return /** @type {ModelManifestEntry[]} */ (manifestEntries);
}

/** @returns {Promise<ModelStatus>} */
async function refreshModelStatus() {
  // Status polls must never overwrite live progress with "missing".
  if (downloadPromise) return modelStatus;
  const entries = await loadManifest();
  const primary = entries[0];
  if (!primary || !primary.url || !primary.sha256) {
    // Reachable only in a release build, where `url` is deliberately null while
    // models/calibration/fused.json stays quarantined (the frozen native-format
    // nuisance battery fails; see its quarantineReason). The state stays even
    // though a local-model build never hits it: deleting it would leave a
    // release build silently scoring nothing. Point at the build that works
    // rather than reporting a dead end.
    modelStatus = {
      state: 'not-configured',
      detail:
        'the verified model artifact has no public setup URL yet. ' +
        'Build with npm run build:local-model to bundle the local weights.',
    };
    return modelStatus;
  }
  const file = await getInstalledModel(primary);
  if (downloadPromise) return modelStatus;
  const progress = file ? 0 : await getPartialDownloadProgress(primary);
  if (downloadPromise) return modelStatus;
  modelStatus = file
    ? { state: 'ready', modelId: primary.id, modelSha256: primary.sha256 ?? undefined }
    : { state: 'missing', ...(progress > 0 ? { progress } : {}) };
  return modelStatus;
}

/** @returns {Promise<ModelStatus>} */
async function runDownload() {
  let progress = 0;
  try {
    const entries = await loadManifest();
    const primary = entries[0];
    if (!primary) throw new Error('empty models/manifest.json');
    progress = await getPartialDownloadProgress(primary);
    modelStatus = { state: 'downloading', progress };
    await downloadAndInstall(primary, (nextProgress) => {
      progress = Math.max(progress, nextProgress);
      modelStatus = { state: 'downloading', progress };
      void chrome.runtime
        .sendMessage({ type: MSG.MODEL_PROGRESS, target: TARGET.SW, progress })
        .catch(() => {});
    });
    enginePromise = null;
    runtimeInitFailed = false;
    modelStatus = { state: 'ready', modelId: primary.id, modelSha256: primary.sha256 ?? undefined };
    scheduleEngineWarmup();
    return modelStatus;
  } catch (err) {
    modelStatus = {
      state: 'error',
      detail: err instanceof Error ? err.message : String(err),
      ...(progress > 0 ? { progress } : {}),
    };
    return modelStatus;
  }
}

/**
 * Join an active setup attempt instead of starting a second fetch/writer.
 * @returns {Promise<ModelStatus>}
 */
function startDownload() {
  if (downloadPromise) return downloadPromise;
  downloadPromise = runDownload().finally(() => {
    downloadPromise = null;
  });
  return downloadPromise;
}

/** @returns {Promise<ModelStatus>} */
function currentModelStatus() {
  if (downloadPromise) return Promise.resolve(modelStatus);
  // A runtime-init failure stays pinned — the weights verified, the engine is
  // what is broken, and re-reporting "ready" would restart the failing scans.
  // Any other error (a failed download attempt) is recomputed from OPFS, so a
  // completed install recovers without waiting on a manual retry or a restart.
  if (runtimeInitFailed && modelStatus.state === 'error') return Promise.resolve(modelStatus);
  return refreshModelStatus();
}

// ---------------------------------------------------------------------------
// Image acquisition

/**
 * Read a response body with a running byte cap.
 *
 * `blob()` buffers the whole response before anyone can measure it, so the old
 * post-hoc size check only ever fired after the bytes had already been paid
 * for. Streaming lets an oversized or endless response be abandoned mid-flight,
 * which matters most on the pages that serve them.
 *
 * @param {Response} res
 * @param {number} limit
 * @returns {Promise<ArrayBuffer>}
 */
async function readCapped(res, limit) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    throw new Error(`image too large: ${declared} bytes`);
  }
  if (!res.body) {
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > limit) throw new Error(`image too large: ${buffer.byteLength} bytes`);
    return buffer;
  }

  const reader = res.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) throw new Error(`image too large: exceeded ${limit} bytes`);
      chunks.push(value);
    }
  } finally {
    // Releasing the lock lets the abort below actually tear down the socket.
    reader.releaseLock();
  }

  const bytes = new ArrayBuffer(total);
  const view = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    view.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Fetch image bytes. No cookies, streaming size cap, hard timeout.
 *
 * Decode is deferred until the infer slot so we hold compressed bytes rather
 * than decoded bitmaps in the prefetch pipeline. The timeout is not defensive
 * polish: a hung acquire occupies a FETCH_CONCURRENCY slot. The evaluation
 * disables the network after setup, which is precisely the condition that
 * produces requests that never settle.
 *
 * @param {string} url
 * @returns {Promise<{bytes: ArrayBuffer, type: string}>}
 */
async function fetchImageBytes(url) {
  if (url.startsWith('blob:')) {
    // Content-script scanner converts page-scoped blob: URLs to data: URLs
    // before requesting a scan. Anything that still arrives as blob: cannot
    // be resolved from this document.
    throw new Error('blob: URLs not scannable from the offscreen document');
  }
  if (isInlinePayloadTooLarge(url)) {
    throw new Error('inline image too large to scan through extension messaging');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('image fetch timed out')), IMAGE_FETCH_TIMEOUT_MS);

  try {
    // force-cache is what keeps scanning working once the evaluation severs the
    // network: the page already loaded these bytes, so they are in the HTTP
    // cache and no new request is needed.
    const res = await fetch(url, {
      credentials: 'omit',
      cache: 'force-cache',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`image fetch failed: HTTP ${res.status}`);

    const bytes = await readCapped(res, MAX_IMAGE_BYTES);
    return { bytes, type: res.headers.get('content-type') ?? '' };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Engines

function ensureEngine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      const entries = await loadManifest();
      const primary = entries[0];
      if (!primary) throw new Error('empty models/manifest.json');
      const bytes = await getInstalledModelBytes(primary);
      if (!bytes) throw new Error(`installed model '${primary.id}' is missing or has the wrong size`);
      return createOrtEngine(primary, bytes);
    })();
    enginePromise.catch(() => {
      enginePromise = null;
    });
  }
  return enginePromise;
}

/**
 * Load WASM/WebGPU immediately, then give a real image a brief chance to own
 * the compiling first session.run. If no image arrives, an idle zero pass
 * warms the kernels as before. Skipped in unit tests (no chrome.runtime.id) so
 * fake ONNX bytes do not hang the Node runner on a WASM fetch.
 */
function scheduleEngineWarmup() {
  if (!chrome.runtime?.id) return;
  void ensureEngine()
    .then((engine) => {
      setTimeout(() => {
        void engine.warmup().catch(markRuntimeInitializationError);
      }, 150);
    })
    .catch(markRuntimeInitializationError);
}

/** @param {unknown} err */
function markRuntimeInitializationError(err) {
  // A verified weight file is necessary but not sufficient for a working
  // detector. Surface missing/incompatible ORT assets in the popup instead
  // of continuing to advertise READY while every scan fails.
  runtimeInitFailed = true;
  modelStatus = {
    state: 'error',
    detail: `runtime initialization failed: ${err instanceof Error ? err.message : String(err)}`,
  };
}

/**
 * @param {ImageBitmap} bitmap
 * @param {{graphicGated?: boolean}} [options]
 * @returns {Promise<{raw: number, nativeMax?: number, nativeMedian?: number}>}
 */
async function inferOrt(bitmap, options) {
  const engine = await ensureEngine();
  return engine.infer(bitmap, options);
}

/**
 * Deterministic mock: first 4 bytes of the content hash -> [0, 1]. Exists so
 * the full pipeline (badges, fusion, memoization, e2e) can run before weights
 * land. Labeled 'mock' in every result; the UI renders it as DEV MOCK.
 * @param {string} sha256
 * @returns {number}
 */
function inferMock(sha256) {
  return parseInt(sha256.slice(0, 8), 16) / 0xffffffff;
}

// ---------------------------------------------------------------------------
// Fetch pipeline + serialized infer slot

const inferQueue = createInferQueue({
  fetchConcurrency: FETCH_CONCURRENCY,
  inferConcurrency: INFER_CONCURRENCY,
  /** @param {import('../shared/messages.js').InferRequest} req */
  keyOf: (req) => req.id,
  /** @param {import('../shared/messages.js').InferRequest} req */
  priorityOf: (req) => (typeof req.priority === 'number' && Number.isFinite(req.priority) ? req.priority : 0),
  acquire: (req) => fetchImageBytes(req.url),
  run: (req, fetched) => runInferFromFetched(req, fetched),
});

/**
 * @param {import('../shared/messages.js').InferRequest} req
 * @returns {Promise<import('../shared/messages.js').InferResult>}
 */
function enqueueInfer(req) {
  return inferQueue.enqueue(req).catch((err) => ({ id: req.id, ok: false, error: String(err) }));
}

/**
 * Reject once the deadline passes, so a wedged job cannot own the queue.
 *
 * The fetch timeout alone is not enough: decode of a malformed image, or a WASM
 * session that never returns, would stall every image behind it just as
 * effectively. One job failing costs one image; a stalled queue costs the rest
 * of the page.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {AbortController} controller
 * @returns {Promise<T>}
 */
function withDeadline(promise, ms, controller) {
  /** @type {ReturnType<typeof setTimeout>} */
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`scan job exceeded ${ms}ms`);
      // Abort so an in-flight fetch is torn down rather than left running
      // against a queue that has already moved on.
      controller.abort(err);
      reject(err);
    }, ms);
  });
  return Promise.race([promise, /** @type {Promise<T>} */ (deadline)]).finally(() =>
    clearTimeout(timer),
  );
}

/**
 * @param {import('../shared/messages.js').InferRequest} req
 * @param {{bytes: ArrayBuffer, type: string}} fetched
 * @returns {Promise<import('../shared/messages.js').InferResult>}
 */
async function runInferFromFetched(req, fetched) {
  const controller = new AbortController();
  return withDeadline(runInferInner(req, fetched, controller.signal), INFER_JOB_TIMEOUT_MS, controller).catch(
    (err) => ({ id: req.id, ok: false, error: String(err) }),
  );
}

/**
 * @param {import('../shared/messages.js').InferRequest} req
 * @param {{bytes: ArrayBuffer, type: string}} fetched
 * @param {AbortSignal} signal
 * @returns {Promise<import('../shared/messages.js').InferResult>}
 */
async function runInferInner(req, fetched, signal) {
  const started = performance.now();
  try {
    if (signal.aborted) throw signal.reason ?? new Error('scan job aborted');
    // Some endpoints (Facebook's lookaside crawler proxy is one) answer a
    // cookieless fetch with 200 + text/html. Decoding that as an image wastes
    // the serialized infer slot and fails with an opaque InvalidStateError;
    // reject on the declared type instead. An empty or octet-stream type still
    // gets a decode attempt — createImageBitmap sniffs the actual bytes.
    const declaredType = fetched.type.split(';')[0]?.trim().toLowerCase() ?? '';
    if (
      declaredType &&
      !declaredType.startsWith('image/') &&
      declaredType !== 'application/octet-stream'
    ) {
      throw new Error(`response is not an image: ${fetched.type}`);
    }
    const blob = new Blob([fetched.bytes], { type: fetched.type });
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    try {
      // Decoded-size guard. MAX_IMAGE_BYTES bounds the wire size only; a
      // decompression bomb decodes small→huge, and the graphic-stats pass +
      // preprocessing canvases allocate O(pixels) per image.
      if (bitmap.width * bitmap.height > MAX_DECODE_PIXELS) {
        return {
          id: req.id,
          ok: false,
          error: `image too large decoded: ${bitmap.width}x${bitmap.height} exceeds ${MAX_DECODE_PIXELS} pixels`,
        };
      }
      const hashPromise = sha256Hex(fetched.bytes);
      // Content-type triage on the exact pixels the model will score. Cheap
      // (~83k native pixels), and it must come from this decode: a resized
      // copy would blur the flat/edge statistics it measures.
      const graphic = bitmapGraphicStats(bitmap);
      if (req.statsOnly) {
        // Evaluation tooling path: statistics without inference. Never used
        // by the scan pipeline, so it deliberately bypasses model status.
        return {
          id: req.id,
          ok: true,
          engine: 'stats',
          graphic,
          sha256: await hashPromise,
          ms: performance.now() - started,
        };
      }
      // Default status is 'missing' until the startup refresh lands. A scan
      // that arrives in that window used to return no-model even when the
      // OPFS install was already valid — and the content-script latch then
      // stopped enqueueing new images.
      const status =
        modelStatus.state === 'ready' ? modelStatus : await currentModelStatus();
      if (status.state === 'ready') {
        const [inferred, hash] = await Promise.all([
          inferOrt(bitmap, { graphicGated: graphic.gated }),
          hashPromise,
        ]);
        return {
          id: req.id,
          ok: true,
          raw: inferred.raw,
          ...(inferred.nativeMax != null ? { nativeMax: inferred.nativeMax } : {}),
          ...(inferred.nativeMedian != null ? { nativeMedian: inferred.nativeMedian } : {}),
          engine: 'ort',
          graphic,
          sha256: hash,
          modelSha256: status.modelSha256,
          ms: performance.now() - started,
        };
      }
      const hash = await hashPromise;
      if (__DEV_BUILD__ && req.allowMock) {
        return {
          id: req.id,
          ok: true,
          raw: inferMock(hash),
          engine: 'mock',
          graphic,
          sha256: hash,
          ms: performance.now() - started,
        };
      }
      return { id: req.id, ok: false, error: 'no-model' };
    } finally {
      bitmap.close();
    }
  } catch (err) {
    return { id: req.id, ok: false, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Message routing

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== TARGET.OFFSCREEN) return false;

  switch (msg.type) {
    case MSG.INFER_RUN:
      void enqueueInfer(msg).then(sendResponse);
      return true;
    case MSG.INFER_PRIORITY:
      sendResponse(inferQueue.reprioritize(msg.id, msg.priority));
      return false;
    case MSG.INFER_CANCEL:
      inferQueue.clear('disabled');
      sendResponse(true);
      return false;
    case MSG.MODEL_STATUS_GET:
      void currentModelStatus()
        .catch((err) => /** @type {ModelStatus} */ ({ state: 'error', detail: String(err) }))
        .then(sendResponse);
      return true;
    case MSG.MODEL_DOWNLOAD:
      void startDownload().then(sendResponse);
      return true;
    default:
      return false;
  }
});

// Prime the status cache so the first scan doesn't pay for it, and start
// engine warmup so the first badge does not wait on WASM/WebGPU compile.
void refreshModelStatus()
  .then((status) => {
    if (status.state === 'ready') scheduleEngineWarmup();
  })
  .catch(() => {});
