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
  IMAGE_FETCH_TIMEOUT_MS,
  INFER_JOB_TIMEOUT_MS,
} from '../shared/constants.js';
import { isInlinePayloadTooLarge } from '../shared/inline-payload.js';
import {
  getInstalledModel,
  getPartialDownloadProgress,
  downloadAndInstall,
  sha256Hex,
} from './download.js';
import { createOrtEngine } from './ort-engine.js';

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
    modelStatus = {
      state: 'not-configured',
      detail: 'the verified model artifact has no public setup URL yet',
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
    modelStatus = { state: 'ready', modelId: primary.id, modelSha256: primary.sha256 ?? undefined };
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
  if (downloadPromise || modelStatus.state === 'error') return Promise.resolve(modelStatus);
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
 * Fetch and decode an image. No cookies, streaming size cap, hard timeout, EXIF
 * orientation honoured so pixels match what the user actually sees.
 *
 * The timeout is not defensive polish. Inference is serialized, so one request
 * that never settles stalls every image queued behind it — and the evaluation
 * disables the network after setup, which is precisely the condition that
 * produces requests that never settle.
 *
 * @param {string} url
 * @param {AbortSignal} [signal]
 * @returns {Promise<{bitmap: ImageBitmap, bytes: ArrayBuffer}>}
 */
async function acquireImage(url, signal) {
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
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });

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
    const blob = new Blob([bytes], { type: res.headers.get('content-type') ?? '' });
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    return { bitmap, bytes };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// ---------------------------------------------------------------------------
// Engines

/**
 * Real inference: ORT session over the OPFS weight file, tiling at NATIVE
 * resolution (never whole-image resize — that destroys the forensic signal).
 * Tile probabilities use the manifest aggregation rule (max by default).
 * @param {ImageBitmap} bitmap
 * @returns {Promise<number>} raw detector score in [0, 1]
 */
async function inferOrt(bitmap) {
  if (!enginePromise) {
    enginePromise = (async () => {
      const entries = await loadManifest();
      const primary = entries[0];
      if (!primary) throw new Error('empty models/manifest.json');
      const file = await getInstalledModel(primary);
      if (!file) throw new Error(`installed model '${primary.id}' is missing or has the wrong size`);
      return createOrtEngine(primary, file);
    })();
    enginePromise.catch(() => {
      enginePromise = null;
    });
  }
  const engine = await enginePromise;
  return engine.infer(bitmap);
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
// Serialized inference queue (concurrency 1 until measured)

/** @type {Promise<unknown>} */
let queueTail = Promise.resolve();

/**
 * @param {import('../shared/messages.js').InferRequest} req
 * @returns {Promise<import('../shared/messages.js').InferResult>}
 */
function enqueueInfer(req) {
  const job = queueTail.then(() => runInfer(req));
  queueTail = job.catch(() => {});
  return job;
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
 * @returns {Promise<import('../shared/messages.js').InferResult>}
 */
async function runInfer(req) {
  const controller = new AbortController();
  return withDeadline(runInferInner(req, controller.signal), INFER_JOB_TIMEOUT_MS, controller).catch(
    (err) => ({ id: req.id, ok: false, error: String(err) }),
  );
}

/**
 * @param {import('../shared/messages.js').InferRequest} req
 * @param {AbortSignal} signal
 * @returns {Promise<import('../shared/messages.js').InferResult>}
 */
async function runInferInner(req, signal) {
  const started = performance.now();
  try {
    const { bitmap, bytes } = await acquireImage(req.url, signal);
    try {
      const hash = await sha256Hex(bytes);
      // Default status is 'missing' until the startup refresh lands. A scan
      // that arrives in that window used to return no-model even when the
      // OPFS install was already valid — and the content-script latch then
      // stopped enqueueing new images.
      const status =
        modelStatus.state === 'ready' ? modelStatus : await currentModelStatus();
      if (status.state === 'ready') {
        const raw = await inferOrt(bitmap);
        return {
          id: req.id,
          ok: true,
          raw,
          engine: 'ort',
          sha256: hash,
          modelSha256: status.modelSha256,
          ms: performance.now() - started,
        };
      }
      if (__DEV_BUILD__ && req.allowMock) {
        return {
          id: req.id,
          ok: true,
          raw: inferMock(hash),
          engine: 'mock',
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

// Prime the status cache so the first scan doesn't pay for it.
void refreshModelStatus().catch(() => {});
