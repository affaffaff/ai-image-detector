/**
 * Graphic-content gate: keeps flat vector art, text stickers, charts and UI
 * screenshots from being called AI by a detector that has never seen them.
 *
 * The primary model is trained to separate photographs from generated images.
 * Rasterized vector graphics are outside both classes, and the model's logit
 * on them is noise — measured on Google Images thumbnails it lands above the
 * 0.65 threshold often enough to badge hand-drawn stickers "AI 90%". That is
 * a false-positive class the balanced-accuracy benchmark punishes directly:
 * web-realistic real sets contain logos, charts and text screenshots.
 *
 * This module measures whether the pixels even look photographic. Four
 * statistics, all computed on native-resolution patches (never resized —
 * resampling manufactures gradients that erase exactly this signal):
 *
 *   flatFraction  fraction of adjacent-pixel pairs with |Δluma| <= 2.
 *                 Vector fills are exactly constant; photographs and
 *                 diffusion outputs carry a sensor/decoder noise floor.
 *   softFraction  fraction with |Δluma| in (2, 24) — photographic texture.
 *                 This is the strongest single "it is a photo" signal.
 *   hardFraction  fraction with |Δluma| >= 24 — text strokes, chart lines,
 *                 logo boundaries. Requiring some hard edges keeps crushed
 *                 night skies and blown highlights (flat but edge-free) with
 *                 the detector instead of gating them.
 *   top8Mass      fraction of sampled pixels covered by the 8 most common
 *                 5-bit-quantized RGB colors. Flat art uses a small palette;
 *                 photos and gradients spread across many bins.
 *   maxPatchSoft  the highest per-patch soft fraction. Aggressive web JPEG
 *                 flattens a photo's sky or studio wall until the GLOBAL
 *                 numbers read "vector art", but the subject still shows
 *                 photographic texture in at least one patch. True graphics
 *                 are flat in every patch. Measured directly on degraded
 *                 fit-split photos: without this term the gate fires on
 *                 beach-sky and white-wall photographs.
 *
 * The gate fires only when ALL statistics agree, and the service worker then caps
 * the fused probability below the fixed threshold (GRAPHIC_PROBABILITY_CAP).
 * It is a cap, not an override: the detector still runs, its score is still
 * reported, C2PA still outranks everything, and an image the detector already
 * called real is unchanged.
 *
 * Rule-8 note: every number here is computed from the image's own pixels at
 * scan time. There is no lookup, no fingerprint, no shipped answer.
 *
 * Thresholds were frozen from measured distributions on the FIT split only
 * (never the eval split) plus a locally generated graphics nuisance set; see
 * docs/GRAPHIC_GATE.md for the measurement.
 *
 * This module must stay dependency-free (no chrome.*, no build-time globals):
 * it is imported by the offscreen document, the service worker and the Node
 * unit tests alike.
 */

/** |Δluma| at or below this is "dead flat" (vector fill, padded background). */
export const GRAPHIC_FLAT_TOLERANCE = 2;

/** |Δluma| at or above this is a hard vector-style edge (text, line art). */
export const GRAPHIC_HARD_EDGE = 24;

/** Channel quantization for the palette histogram: 8-bit -> 5-bit bins. */
export const GRAPHIC_PALETTE_SHIFT = 3;

/** How many top palette bins count toward the concentration mass. */
export const GRAPHIC_PALETTE_TOP_K = 8;

/**
 * Stop tracking NEW palette bins beyond this many. Pixels in untracked bins
 * still count toward the denominator, so top-K mass stays honest; only the
 * distinct-color count saturates. Bounds memory on adversarial inputs.
 */
export const GRAPHIC_PALETTE_MAX_TRACKED = 4096;

/** Below this many sampled pixels the statistics are too thin to act on. */
export const GRAPHIC_MIN_PIXELS = 1024;

/**
 * Decision thresholds, ALL required simultaneously. Frozen from the fit-split
 * sweep in tools/fit_graphic_gate.py plus the generated graphics nuisance set;
 * measured fire rates are recorded in docs/GRAPHIC_GATE.md. Do not hand-tune;
 * re-run the sweep.
 */
export const GRAPHIC_GATE_THRESHOLDS = Object.freeze({
  /** Most of the sampled area must be dead flat. */
  minFlatFraction: 0.7,
  /** Almost no photographic mid-band texture is tolerated overall. */
  maxSoftFraction: 0.18,
  /** Some hard structure (text/line/edge) must exist. */
  minHardFraction: 0.0005,
  /** The palette must be concentrated. */
  minTop8Mass: 0.68,
  /** And no single patch may look photographic on its own. */
  maxPatchSoftFraction: 0.16,
});

/**
 * Where a gated image's probability is capped. Comfortably below the fixed
 * 0.65 decision threshold, comfortably above zero: "confident this is not a
 * photographic AI image", not "certainty". The verdict at 0.65 becomes
 * "real"; the badge shows a low score; the popover says why.
 */
export const GRAPHIC_PROBABILITY_CAP = 0.35;

/**
 * @typedef {Object} GraphicStats
 * @property {number} pixels          - RGBA pixels sampled across all patches
 * @property {number} gradientPixels  - adjacent pairs measured (right + down)
 * @property {number} flatFraction
 * @property {number} softFraction
 * @property {number} hardFraction
 * @property {number} top8Mass
 * @property {number} maxPatchSoft    - highest soft fraction of any one patch
 * @property {number} distinctColors  - saturates at GRAPHIC_PALETTE_MAX_TRACKED
 *
 * @typedef {GraphicStats & {gated: boolean}} GraphicVerdict
 */

/**
 * @typedef {Object} GraphicAccumulator
 * @property {number} pixels
 * @property {number} gradientPixels
 * @property {number} flat
 * @property {number} soft
 * @property {number} hard
 * @property {number} maxPatchSoft
 * @property {Map<number, number>} colors
 */

/** @returns {GraphicAccumulator} */
export function createGraphicAccumulator() {
  return { pixels: 0, gradientPixels: 0, flat: 0, soft: 0, hard: 0, maxPatchSoft: 0, colors: new Map() };
}

/**
 * Fold one native-resolution patch into the accumulator.
 *
 * Gradients use the right and down neighbor inside the same patch, so patch
 * boundaries never manufacture false edges. Integer BT.601 luma keeps the
 * whole pass allocation-free apart from one Int32Array per call.
 *
 * @param {GraphicAccumulator} acc
 * @param {Uint8ClampedArray | Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 */
export function accumulateGraphicStats(acc, rgba, width, height) {
  const pixels = width * height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError('patch dimensions must be positive integers');
  }
  if (rgba.length !== pixels * 4) {
    throw new RangeError(`expected ${pixels * 4} RGBA bytes, got ${rgba.length}`);
  }

  const luma = new Int32Array(pixels);
  for (let i = 0; i < pixels; i += 1) {
    const o = i * 4;
    const r = rgba[o] ?? 0;
    const g = rgba[o + 1] ?? 0;
    const b = rgba[o + 2] ?? 0;
    luma[i] = (77 * r + 150 * g + 29 * b) >> 8;

    const key =
      ((r >> GRAPHIC_PALETTE_SHIFT) << 10) |
      ((g >> GRAPHIC_PALETTE_SHIFT) << 5) |
      (b >> GRAPHIC_PALETTE_SHIFT);
    const seen = acc.colors.get(key);
    if (seen !== undefined) acc.colors.set(key, seen + 1);
    else if (acc.colors.size < GRAPHIC_PALETTE_MAX_TRACKED) acc.colors.set(key, 1);
  }
  acc.pixels += pixels;

  const gradientsBefore = acc.gradientPixels;
  const softBefore = acc.soft;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const here = /** @type {number} */ (luma[row + x]);
      if (x + 1 < width) {
        classifyGradient(acc, Math.abs(/** @type {number} */ (luma[row + x + 1]) - here));
      }
      if (y + 1 < height) {
        classifyGradient(acc, Math.abs(/** @type {number} */ (luma[row + width + x]) - here));
      }
    }
  }

  // One accumulate call is one patch: track the most photographic patch seen.
  const patchGradients = acc.gradientPixels - gradientsBefore;
  if (patchGradients > 0) {
    acc.maxPatchSoft = Math.max(acc.maxPatchSoft, (acc.soft - softBefore) / patchGradients);
  }
}

/**
 * @param {GraphicAccumulator} acc
 * @param {number} magnitude
 */
function classifyGradient(acc, magnitude) {
  acc.gradientPixels += 1;
  if (magnitude <= GRAPHIC_FLAT_TOLERANCE) acc.flat += 1;
  else if (magnitude >= GRAPHIC_HARD_EDGE) acc.hard += 1;
  else acc.soft += 1;
}

/**
 * @param {GraphicAccumulator} acc
 * @returns {GraphicStats}
 */
export function finalizeGraphicStats(acc) {
  const g = acc.gradientPixels;
  let top8 = 0;
  if (acc.pixels > 0 && acc.colors.size > 0) {
    const counts = [...acc.colors.values()].sort((a, b) => b - a);
    for (let i = 0; i < Math.min(GRAPHIC_PALETTE_TOP_K, counts.length); i += 1) {
      top8 += /** @type {number} */ (counts[i]);
    }
  }
  return {
    pixels: acc.pixels,
    gradientPixels: g,
    flatFraction: g > 0 ? acc.flat / g : 0,
    softFraction: g > 0 ? acc.soft / g : 0,
    hardFraction: g > 0 ? acc.hard / g : 0,
    top8Mass: acc.pixels > 0 ? top8 / acc.pixels : 0,
    maxPatchSoft: acc.maxPatchSoft,
    distinctColors: acc.colors.size,
  };
}

/**
 * @param {GraphicStats} stats
 * @returns {boolean}
 */
export function evaluateGraphicGate(stats) {
  const t = GRAPHIC_GATE_THRESHOLDS;
  const checks = {
    pixels: stats.pixels >= GRAPHIC_MIN_PIXELS,
    flat: stats.flatFraction >= t.minFlatFraction,
    soft: stats.softFraction <= t.maxSoftFraction,
    hard: stats.hardFraction >= t.minHardFraction,
    top8: stats.top8Mass >= t.minTop8Mass,
    patch: stats.maxPatchSoft <= t.maxPatchSoftFraction,
  };
  const gated = checks.pixels && checks.flat && checks.soft && checks.hard && checks.top8 && checks.patch;
  return gated;
}

/**
 * Cap a fused probability for a gated image. Pure so the service worker's
 * one-line call site and the tests share the same arithmetic.
 *
 * @param {number} probability - calibrated P(AI) from fuse()
 * @returns {{probability: number, capped: boolean}}
 */
export function applyGraphicCap(probability) {
  const capped = Math.min(probability, GRAPHIC_PROBABILITY_CAP);
  return { probability: capped, capped: capped < probability };
}
