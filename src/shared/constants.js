/**
 * Shared constants. Everything tunable-but-fixed lives here so there is one
 * place to audit. The decision threshold itself lives in src/fusion/fuse.js
 * (DECISION_THRESHOLD) — it is fixed by the product contract, not tunable.
 */

/**
 * Minimum edge (px) for an image to be worth scanning. Below this an image is
 * an icon, avatar or spacer: too little signal to score, and enough of them to
 * flood the queue.
 *
 * Measured against displayed size: a small file blown up to fill a hero slot
 * is still worth scanning, while a huge file rendered as a 20px avatar is not
 * worth blocking the queue on.
 *
 * Set to 64 rather than the earlier 128px threshold. Empirically 128 rejects EVERY
 * thumbnail on Google Images (238 images, 0 scanned) — an unusable detector on
 * one of the most image-heavy pages on the web, which fails the product's
 * everyday-browsing objective. Real forensic signal
 * survives well below 128px; revisit with measured per-size accuracy once the
 * benchmark replica exists, rather than guessing again.
 */
export const MIN_IMAGE_EDGE = 64;

/** Max image payload we will fetch for analysis (bytes). */
export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

/**
 * Hard deadline on fetching one image's bytes (ms).
 *
 * Load-bearing, not defensive: ONNX itself is serialized (INFER_CONCURRENCY = 1),
 * so a single fetch that never settles used to stall every remaining image on
 * the page. Bytes now download in parallel (FETCH_CONCURRENCY), but a hung
 * acquire still occupies a fetch slot. The evaluation cuts network access
 * after setup, which is exactly the condition that produces hanging requests —
 * an untimed fetch there costs coverage on every image queued behind it, and
 * lost coverage is lost balanced accuracy.
 */
export const IMAGE_FETCH_TIMEOUT_MS = 10_000;

/**
 * Hard deadline on decode plus ONNX for one image (ms). Image bytes now
 * download on the fetch pipeline with IMAGE_FETCH_TIMEOUT_MS; this deadline
 * starts when the infer slot is taken so a job queued behind a long page
 * cannot expire before it runs. Decode of a malformed image or a wedged WASM
 * session would still stall every image behind it.
 */
export const INFER_JOB_TIMEOUT_MS = 30_000;

/**
 * Max scored results the content script keeps keyed by URL.
 *
 * An infinite feed recycles thousands of URLs through one document; unbounded,
 * this map is a slow leak in exactly the long-lived page where scanning matters
 * most. Entries are pure memoization over real inference, so eviction only ever
 * costs a rescan.
 */
export const URL_CACHE_MAX = 400;

/** How far outside the viewport we begin scanning (px). */
export const VIEWPORT_MARGIN = 500;

/**
 * Concurrent ONNX session.run calls. Keep 1: the WASM/WebGPU session is
 * single-threaded (`ort.env.wasm.numThreads = 1`), and overlapping runs on
 * one session fights itself.
 */
export const INFER_CONCURRENCY = 1;

/**
 * How many images may fetch (and hold) bytes while the infer slot is busy.
 * Bytes, not decoded bitmaps — a 4K RGBA frame would blow RAM if we decoded
 * ahead. One extra slot is granted to a strictly higher-priority (visible)
 * job so prefetch buffers cannot stall an on-screen image.
 */
export const FETCH_CONCURRENCY = 4;

/** On-screen images jump the infer queue ahead of rootMargin prefetch. */
export const SCAN_PRIORITY_NEAR = 0;
export const SCAN_PRIORITY_VISIBLE = 1;

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
 * Unavailable in release builds.
 */
export const DEV_MOCK_DEFAULT = DEV_BUILD;

/** storage.local flag: master enable. Default true. */
export const ENABLED_FLAG = 'enabled';
