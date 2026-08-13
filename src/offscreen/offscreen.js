/**
 * Offscreen inference host.
 *
 * WebGPU is unavailable in MV3 service workers, so all inference lives here
 * (ONNX Runtime Web; WebGPU as latency optimization, WASM as the path that
 * must clear the accuracy bar alone — ORT quirk: wasm.numThreads = 1).
 *
 * This document also fetches image bytes: it holds the same <all_urls> host
 * permission as the service worker, and fetching here avoids marshalling
 * megabytes through JSON runtime messages. Cookie policy: credentials are
 * NEVER sent with image fetches (privacy-first; auth-gated images simply
 * report unscannable).
 *
 * Engine states, honestly reported end-to-end:
 *   - real ORT inference (once bake-off weights land in models/manifest.json)
 *   - MOCK engine behind the devMockInference flag, labeled 'mock' in every
 *     result — pipeline demos and e2e tests only, never a real verdict
 *   - otherwise: 'no-model', surfaced as a setup-required badge
 */

import { MSG, TARGET } from '../shared/messages.js';
import { DEV_MOCK_FLAG, MAX_IMAGE_BYTES } from '../shared/constants.js';
import { getInstalledModel, downloadAndInstall, sha256Hex } from './download.js';

/** @typedef {import('./download.js').ModelManifestEntry} ModelManifestEntry */
/** @typedef {import('../shared/messages.js').ModelStatus} ModelStatus */

// ---------------------------------------------------------------------------
// Model manifest + status

/** @type {ModelManifestEntry[] | null} */
let manifestEntries = null;

/** @type {ModelStatus} */
let modelStatus = { state: 'missing' };

async function loadManifest() {
  if (manifestEntries) return manifestEntries;
  const res = await fetch(chrome.runtime.getURL('models/manifest.json'));
  const json = await res.json();
  manifestEntries = json.models ?? [];
  return /** @type {ModelManifestEntry[]} */ (manifestEntries);
}

/** @returns {Promise<ModelStatus>} */
async function refreshModelStatus() {
  const entries = await loadManifest();
  const primary = entries[0];
  if (!primary || !primary.url || !primary.sha256) {
    modelStatus = {
      state: 'not-configured',
      detail: 'models/manifest.json has no pinned weights yet (pre-bake-off build)',
    };
    return modelStatus;
  }
  const file = await getInstalledModel(primary);
  modelStatus = file ? { state: 'ready' } : { state: 'missing' };
  return modelStatus;
}

async function startDownload() {
  const entries = await loadManifest();
  const primary = entries[0];
  if (!primary) throw new Error('empty models/manifest.json');
  modelStatus = { state: 'downloading', progress: 0 };
  try {
    await downloadAndInstall(primary, (progress) => {
      modelStatus = { state: 'downloading', progress };
      void chrome.runtime
        .sendMessage({ type: MSG.MODEL_PROGRESS, target: TARGET.SW, progress })
        .catch(() => {});
    });
    modelStatus = { state: 'ready' };
  } catch (err) {
    modelStatus = { state: 'error', detail: String(err) };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Image acquisition

/**
 * Fetch and decode an image. No cookies, hard size cap, EXIF orientation
 * honoured so pixels match what the user actually sees.
 * @param {string} url
 * @returns {Promise<{bitmap: ImageBitmap, bytes: ArrayBuffer}>}
 */
async function acquireImage(url) {
  if (url.startsWith('blob:')) {
    // blob: URLs are scoped to the creating document; they cannot be resolved
    // here. The content script reports them; coverage decision revisited
    // before submission (rare on real pages, benchmark harness uses <img>).
    throw new Error('blob: URLs not scannable from the offscreen document');
  }
  const res = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
  if (!res.ok) throw new Error(`image fetch failed: HTTP ${res.status}`);
  const blob = await res.blob();
  if (blob.size > MAX_IMAGE_BYTES) throw new Error(`image too large: ${blob.size} bytes`);
  const bytes = await blob.arrayBuffer();
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  return { bitmap, bytes };
}

// ---------------------------------------------------------------------------
// Engines

/**
 * Real inference. Lands with the model bake-off: ORT session over the OPFS
 * weight file, tiling at NATIVE resolution (never whole-image resize — that
 * destroys the forensic signal), tile-vote aggregation.
 * @param {ImageBitmap} _bitmap
 * @returns {Promise<number>} raw detector score in [0, 1]
 */
async function inferOrt(_bitmap) {
  throw new Error('ORT engine not wired yet: models/manifest.json has no weights (pre-bake-off)');
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

async function devMockEnabled() {
  const got = await chrome.storage.local.get(DEV_MOCK_FLAG);
  return Boolean(got[DEV_MOCK_FLAG]);
}

// ---------------------------------------------------------------------------
// Serialized inference queue (concurrency 1 until measured)

/** @type {Promise<unknown>} */
let queueTail = Promise.resolve();

/**
 * @param {{id: string, url: string}} req
 * @returns {Promise<import('../shared/messages.js').InferResult>}
 */
function enqueueInfer(req) {
  const job = queueTail.then(() => runInfer(req));
  queueTail = job.catch(() => {});
  return job;
}

/**
 * @param {{id: string, url: string}} req
 * @returns {Promise<import('../shared/messages.js').InferResult>}
 */
async function runInfer(req) {
  const started = performance.now();
  try {
    const { bitmap, bytes } = await acquireImage(req.url);
    try {
      const hash = await sha256Hex(bytes);
      if (modelStatus.state === 'ready') {
        const raw = await inferOrt(bitmap);
        return { id: req.id, ok: true, raw, engine: 'ort', sha256: hash, ms: performance.now() - started };
      }
      if (await devMockEnabled()) {
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
      void refreshModelStatus()
        .catch((err) => /** @type {ModelStatus} */ ({ state: 'error', detail: String(err) }))
        .then(sendResponse);
      return true;
    case MSG.MODEL_DOWNLOAD:
      void startDownload()
        .then(() => sendResponse(modelStatus))
        .catch(() => sendResponse(modelStatus));
      return true;
    default:
      return false;
  }
});

// Prime the status cache so the first scan doesn't pay for it.
void refreshModelStatus().catch(() => {});
