/**
 * Shared constants. Everything tunable-but-fixed lives here so there is one
 * place to audit. The decision threshold itself lives in src/fusion/fuse.js
 * (DECISION_THRESHOLD) — it is fixed by the bounty rules, not tunable.
 */

/**
 * Minimum natural edge (px) for an image to be worth scanning. Icons, spacers
 * and thumbnails below this carry too little signal and flood the queue.
 * Brief: skip <~128–200px.
 */
export const MIN_IMAGE_EDGE = 128;

/** Max image payload we will fetch for analysis (bytes). */
export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

/** How far outside the viewport we begin scanning (px). */
export const VIEWPORT_MARGIN = 500;

/** Concurrent inferences in the offscreen document. Keep 1 until measured. */
export const INFER_CONCURRENCY = 1;

/** Max entries in the session-scoped scan memo (chrome.storage.session). */
export const SCAN_MEMO_MAX = 500;

/**
 * storage.local flag: when truthy, the offscreen host runs a deterministic
 * MOCK engine (score derived from the image hash) so the pipeline can be
 * demoed and e2e-tested without model weights. Every mock result is labeled
 * `engine: "mock"` end-to-end and rendered as DEV MOCK in the UI. It can never
 * be mistaken for, or accidentally shipped as, real inference.
 */
export const DEV_MOCK_FLAG = 'devMockInference';

/** storage.local flag: master enable. Default true. */
export const ENABLED_FLAG = 'enabled';
