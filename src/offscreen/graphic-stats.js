/**
 * Bitmap adapter for the graphic-content gate (src/shared/graphic-gate.js).
 *
 * Reads native-resolution patches — copies, never rescales. Resampling would
 * blend hard vector edges into soft "photographic" gradients and manufacture
 * new colors, erasing exactly the statistics the gate measures. Same
 * invariant, same reason, as the model preprocessing in preprocess.js.
 *
 * Patches are spread edge-to-edge on a grid so an image that is photographic
 * ANYWHERE (a meme caption over a photo, a product shot on white) presents
 * its texture to the accumulator and stays with the detector.
 */

import {
  accumulateGraphicStats,
  createGraphicAccumulator,
  evaluateGraphicGate,
  finalizeGraphicStats,
} from '../shared/graphic-gate.js';

/** Patch edge (native pixels). 9 patches = ~83k pixels, well under 1ms. */
export const GRAPHIC_PATCH_SIZE = 96;

/** Max patches per axis. */
export const GRAPHIC_PATCH_GRID = 3;

/**
 * @typedef {{x: number, y: number, width: number, height: number}} GraphicPatch
 */

/**
 * Evenly spaced patch origins covering both edges, clamped inside the image.
 * An axis shorter than the patch yields one full-axis span.
 *
 * @param {number} length
 * @param {number} patch
 * @param {number} maxSamples
 * @returns {Array<{origin: number, size: number}>}
 */
export function planGraphicAxis(length, patch = GRAPHIC_PATCH_SIZE, maxSamples = GRAPHIC_PATCH_GRID) {
  if (!Number.isInteger(length) || length <= 0) throw new RangeError('image edge must be a positive integer');
  if (length <= patch) return [{ origin: 0, size: length }];
  const count = Math.min(maxSamples, Math.ceil(length / patch));
  const last = length - patch;
  if (count === 1) return [{ origin: Math.round(last / 2), size: patch }];
  return Array.from({ length: count }, (_, i) => ({
    origin: Math.round((last * i) / (count - 1)),
    size: patch,
  }));
}

/**
 * @param {number} width
 * @param {number} height
 * @returns {GraphicPatch[]}
 */
export function planGraphicPatches(width, height) {
  const xs = planGraphicAxis(width);
  const ys = planGraphicAxis(height);
  return ys.flatMap((y) => xs.map((x) => ({ x: x.origin, y: y.origin, width: x.size, height: y.size })));
}

/** @type {OffscreenCanvas | null} */
let patchCanvas = null;
/** @type {OffscreenCanvasRenderingContext2D | null} */
let patchCtx = null;

/**
 * @param {number} width
 * @param {number} height
 * @returns {OffscreenCanvasRenderingContext2D}
 */
function getPatchContext(width, height) {
  if (!patchCanvas || !patchCtx || patchCanvas.width !== width || patchCanvas.height !== height) {
    patchCanvas = new OffscreenCanvas(width, height);
    patchCtx = patchCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
  }
  if (!patchCtx) throw new Error('2D canvas unavailable for graphic statistics');
  return patchCtx;
}

/**
 * Measure a decoded image and decide the gate.
 *
 * Transparent regions composite onto white — the background most pages give
 * a transparent sticker — so a logo cut-out reads as the flat field a viewer
 * actually sees.
 *
 * @param {ImageBitmap} bitmap
 * @returns {import('../shared/graphic-gate.js').GraphicVerdict}
 */
export function bitmapGraphicStats(bitmap) {
  const acc = createGraphicAccumulator();
  for (const patch of planGraphicPatches(bitmap.width, bitmap.height)) {
    const ctx = getPatchContext(patch.width, patch.height);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, patch.width, patch.height);
    // Equal source/destination dimensions: the native-resolution invariant.
    ctx.drawImage(bitmap, patch.x, patch.y, patch.width, patch.height, 0, 0, patch.width, patch.height);
    const rgba = ctx.getImageData(0, 0, patch.width, patch.height).data;
    accumulateGraphicStats(acc, rgba, patch.width, patch.height);
  }
  const stats = finalizeGraphicStats(acc);
  const gated = evaluateGraphicGate(stats);
  return { ...stats, gated };
}
