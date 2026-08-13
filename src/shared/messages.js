/**
 * Message protocol. Every runtime message crossing a context boundary
 * (content ⇄ service worker ⇄ offscreen ⇄ popup) is declared here.
 *
 * chrome.runtime messaging JSON-serializes payloads, so no ArrayBuffers cross
 * a boundary: the offscreen document fetches image bytes itself (it holds the
 * same <all_urls> host permission as the service worker; content-script canvas
 * is tainted cross-origin and is never used for pixels).
 *
 * Naming: `<area>:<verb>`. The `target` field routes between SW and offscreen,
 * which share chrome.runtime.onMessage.
 */

export const MSG = Object.freeze({
  // content -> SW (long-lived port, name PORT_SCAN)
  SCAN_REQUEST: 'scan:request',
  // SW -> content (same port)
  SCAN_UPDATE: 'scan:update',

  // SW -> offscreen
  INFER_RUN: 'infer:run',
  MODEL_STATUS_GET: 'model:status-get',
  MODEL_DOWNLOAD: 'model:download',

  // offscreen -> SW (unsolicited)
  MODEL_PROGRESS: 'model:progress',

  // popup -> SW
  STATUS_GET: 'status:get',
});

/** Port name for the content-script scan channel. */
export const PORT_SCAN = 'scan';

/** `target` values for messages on the shared runtime channel. */
export const TARGET = Object.freeze({
  OFFSCREEN: 'offscreen',
  SW: 'sw',
});

/**
 * Scan lifecycle states, content-script side.
 * pending      queued or in flight
 * scored       verdict available
 * unscannable  fetch/decode failed (auth-gated, oversized, broken, …)
 * no-model     model weights not installed yet — badge shows setup state
 * @typedef {'pending' | 'scored' | 'unscannable' | 'no-model'} ScanState
 */

/**
 * @typedef {Object} ScanRequest
 * @property {string} id        - page-session-unique image id
 * @property {string} url       - absolute URL (http/https/data/blob)
 * @property {number} width     - naturalWidth
 * @property {number} height    - naturalHeight
 *
 * @typedef {Object} ScanUpdate
 * @property {string} id
 * @property {ScanState} state
 * @property {number} [probability]  - final fused P(AI), post-calibration
 * @property {boolean} [isAI]        - probability >= 0.65 (fixed threshold)
 * @property {'ort' | 'mock'} [engine]
 * @property {Array<{name: string, bits: number}>} [contributions]
 * @property {string} [error]
 *
 * @typedef {Object} InferResult
 * @property {string} id
 * @property {boolean} ok
 * @property {number} [raw]          - raw detector score, pre-calibration
 * @property {'ort' | 'mock'} [engine]
 * @property {string} [sha256]       - content hash, memo key
 * @property {number} [ms]
 * @property {string} [error]
 *
 * @typedef {'missing' | 'not-configured' | 'downloading' | 'ready' | 'error'} ModelState
 *
 * @typedef {Object} ModelStatus
 * @property {ModelState} state
 * @property {number} [progress]     - 0..1 while downloading
 * @property {string} [detail]
 */

export {};
