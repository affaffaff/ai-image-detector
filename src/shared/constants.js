/**
 * Shared constants. Everything tunable-but-fixed lives here so there is one
 * place to audit. The decision threshold itself lives in src/fusion/fuse.js
 * (DECISION_THRESHOLD) — it is fixed by the bounty rules, not tunable.
 */

/**
 * Minimum edge (px) for an image to be worth scanning. Below this an image is
 * an icon, avatar or spacer: too little signal to score, and enough of them to
 * flood the queue.
 *
 * Measured against max(natural, displayed) — a small file blown up to fill a
 * hero slot is still worth scanning, and a huge file rendered as a 20px avatar
 * is not worth blocking the queue on.
 *
 * Set to 64, not the 128 the brief suggested. Empirically 128 rejects EVERY
 * thumbnail on Google Images (238 images, 0 scanned) — an unusable detector on
 * one of the most image-heavy pages on the web, which fails the bounty's
 * "genuinely useful for everyday browsing" objective. Real forensic signal
 * survives well below 128px; revisit with measured per-size accuracy once the
 * benchmark replica exists, rather than guessing again.
 */
export const MIN_IMAGE_EDGE = 64;

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

/**
 * True only in `npm run build:dev` output. Release builds compile this to
 * `false`, so the mock engine is off by default and its branch is dead-code
 * eliminated. A shipped build must never display a fabricated score unless a
 * user deliberately opts in.
 */
export const DEV_BUILD = __DEV_BUILD__;

/**
 * Default state of the mock engine when the user has never touched the toggle:
 * ON for dev builds (load unpacked and immediately see the pipeline work),
 * OFF for release builds.
 */
export const DEV_MOCK_DEFAULT = DEV_BUILD;

/** storage.local flag: master enable. Default true. */
export const ENABLED_FLAG = 'enabled';
