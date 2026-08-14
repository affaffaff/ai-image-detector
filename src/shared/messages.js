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
  SCAN_PRIORITY: 'scan:priority',
  // SW -> content (same port)
  SCAN_UPDATE: 'scan:update',

  // SW -> offscreen
  INFER_RUN: 'infer:run',
  INFER_PRIORITY: 'infer:priority',
  INFER_CANCEL: 'infer:cancel',
  MODEL_STATUS_GET: 'model:status-get',
  MODEL_DOWNLOAD: 'model:download',

  // offscreen -> SW (unsolicited)
  MODEL_PROGRESS: 'model:progress',
  // SW -> content scripts (all frames): weights just became usable
  MODEL_READY: 'model:ready',

  // popup -> SW -> content: cosmetic blur of AI-scored images
  BLUR_SETTING: 'blur:setting',
  // popup -> SW -> content: master scan enable (mirrors blur:setting so the
  // active tab does not wait on chrome.storage.onChanged)
  ENABLED_SETTING: 'enabled:setting',

  // popup -> SW
  STATUS_GET: 'status:get',
  MODEL_RETRY: 'model:retry',
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
 * @property {number} [priority] - SCAN_PRIORITY_VISIBLE outranks prefetch
 *
 * @typedef {Object} ScanPriorityUpdate
 * @property {string} id        - id of the request that owns the URL scan
 * @property {number} priority  - newer visible work receives a larger value
 *
 * @typedef {Object} ScanUpdate
 * @property {string} id
 * @property {string} [url] - echoed from the request so waiters can settle
 *                            even if the requesting element has been removed
 * @property {ScanState} state
 * @property {number} [probability]  - final fused P(AI), post-calibration
 * @property {number} [display]      - integer the badge prints. A display-only
 *                                     monotone remap of `probability`
 *                                     (src/shared/display-score.js), sent from
 *                                     here because the calibration curve it is
 *                                     derived from lives in the SW. Never used
 *                                     for the verdict.
 * @property {boolean} [isAI]        - probability >= 0.65 (fixed threshold)
 * @property {'ort' | 'mock'} [engine]
 * @property {'graphic' | 'native-tiles'} [gate] - probability was capped
 *                                     below the threshold. `graphic`: pixels
 *                                     are flat graphics/text, not photographic
 *                                     content (src/shared/graphic-gate.js).
 *                                     `native-tiles`: the official downscale
 *                                     crop looked generated but native 384
 *                                     tiles did not agree (src/shared/native-veto.js).
 * @property {Array<{name: string, bits: number | null, reason?: string}>} [contributions]
 *                                     - log-odds contributions for the popover.
 *                                     The override path reports bits: Infinity,
 *                                     which JSON messaging delivers as null.
 * @property {string} [error]
 *
 * @typedef {Object} InferResult
 * @property {string} id
 * @property {boolean} ok
 * @property {number} [raw]          - raw detector score, pre-calibration
 *                                     (official-center crop; the native-tile
 *                                     veto never overwrites this)
 * @property {number} [nativeMax]    - strongest native 384 crop, present only
 *                                     when the official transform downscaled
 *                                     an AI-looking crop (src/shared/native-veto.js)
 * @property {number} [nativeMedian] - median of those native crops; omitted
 *                                     on early-abort when one tile already
 *                                     agreed with the official AI score
 * @property {'ort' | 'mock' | 'stats'} [engine] - 'stats' only for statsOnly
 *                                     tooling requests; never a verdict
 * @property {import('./graphic-gate.js').GraphicVerdict} [graphic]
 *                                   - pixel-statistics verdict for the
 *                                     graphic-content gate, measured on the
 *                                     same decoded bitmap that was scored
 * @property {string} [sha256]       - content hash, memo key
 * @property {string} [modelSha256]  - exact verified model artifact used
 * @property {number} [ms]
 * @property {string} [error]
 *
 * @typedef {Object} InferRequest
 * @property {string} id
 * @property {string} url
 * @property {boolean} allowMock - resolved by the service worker because
 *                                 offscreen documents only expose chrome.runtime
 * @property {number} [priority] - forwarded from the content-script scan request
 * @property {boolean} [statsOnly] - evaluation tooling only: decode and return
 *                                 graphic statistics without touching the model
 *
 * @typedef {'missing' | 'not-configured' | 'downloading' | 'ready' | 'error'} ModelState
 *
 * @typedef {Object} ModelStatus
 * @property {ModelState} state
 * @property {number} [progress]     - durable 0..1 partial progress while incomplete
 * @property {string} [detail]
 * @property {string} [modelId]
 * @property {string} [modelSha256]
 */

export {};
