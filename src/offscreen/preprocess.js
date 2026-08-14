/**
 * Community Forensics browser preprocessing.
 *
 * The released 384px checkpoint consumes ImageNet-normalized RGB tensors in
 * NCHW order. The authors' published eval uses Resize(short edge = 440) then a
 * 384×384 center crop. That whole-image resize is kept here for bake-off
 * comparisons only.
 *
 * Shipped inference tiles at native resolution and aggregates with a sparse
 * vote (max / top-k). Mean-of-tiles washes out the local forensic signal;
 * measured on our replica, mean was the worst rule of the set.
 */

export const MODEL_INPUT_SIZE = 384;
/**
 * Also the scanner's source-upgrade gate: below this short edge the resize
 * becomes an upscale, so the scanner goes looking for a larger source
 * (src/content/source-upgrade.js). Declared here rather than in
 * shared/constants.js because that module reads the build-time __DEV_BUILD__
 * global and so cannot be imported by the offscreen unit tests.
 */
export const OFFICIAL_RESIZE_SHORT_EDGE = 440;
/** @type {readonly [number, number, number]} */
export const IMAGENET_MEAN = Object.freeze([0.485, 0.456, 0.406]);
/** @type {readonly [number, number, number]} */
export const IMAGENET_STD = Object.freeze([0.229, 0.224, 0.225]);
export const DEFAULT_MAX_AXIS_SAMPLES = 3;

/** Shipped and bake-off tile-vote rules. Mean is kept for comparison only. */
export const TILE_AGGREGATION = Object.freeze({
  MEAN: 'mean-probability',
  MAX: 'max-probability',
  TOP2: 'top2-mean-probability',
  TOP3: 'top3-mean-probability',
});

/** Sparse local evidence: any high-scoring crop can carry the image. */
export const DEFAULT_TILE_AGGREGATION = TILE_AGGREGATION.MAX;

/**
 * @typedef {{resizedWidth: number, resizedHeight: number, left: number, top: number, cropSize: number}} CenterCropPlan
 */

/**
 * Plan the authors' Resize(440) + CenterCrop(384) evaluation transform.
 * PIL/torchvision integer conversion floors the computed long edge; matching
 * that detail avoids a one-pixel browser/offline drift on odd aspect ratios.
 *
 * @param {number} width
 * @param {number} height
 * @param {{shortEdge?: number, cropSize?: number}} [options]
 * @returns {CenterCropPlan}
 */
export function planOfficialCenterCrop(width, height, options = {}) {
  const shortEdge = options.shortEdge ?? OFFICIAL_RESIZE_SHORT_EDGE;
  const cropSize = options.cropSize ?? MODEL_INPUT_SIZE;
  for (const [name, value] of Object.entries({ width, height, shortEdge, cropSize })) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive integer`);
    }
  }
  if (cropSize > shortEdge) throw new RangeError('cropSize cannot exceed resized short edge');

  let resizedWidth;
  let resizedHeight;
  if (width <= height) {
    resizedWidth = shortEdge;
    resizedHeight = Math.max(shortEdge, Math.floor((height * shortEdge) / width));
  } else {
    resizedHeight = shortEdge;
    resizedWidth = Math.max(shortEdge, Math.floor((width * shortEdge) / height));
  }
  return {
    resizedWidth,
    resizedHeight,
    left: Math.floor((resizedWidth - cropSize) / 2),
    top: Math.floor((resizedHeight - cropSize) / 2),
    cropSize,
  };
}

/** @typedef {{x: number, y: number, size: number}} NativeTile */

/**
 * Evenly spaced crop origins that include both edges. A negative origin means
 * the image is smaller than the tile and must be mean-padded, not resized.
 *
 * @param {number} length
 * @param {number} tileSize
 * @param {number} maxSamples
 * @returns {number[]}
 */
export function axisOrigins(length, tileSize = MODEL_INPUT_SIZE, maxSamples = DEFAULT_MAX_AXIS_SAMPLES) {
  if (!Number.isInteger(length) || length <= 0) throw new RangeError('image edge must be a positive integer');
  if (!Number.isInteger(tileSize) || tileSize <= 0) throw new RangeError('tile size must be a positive integer');
  if (!Number.isInteger(maxSamples) || maxSamples <= 0) {
    throw new RangeError('maxSamples must be a positive integer');
  }

  if (length <= tileSize) return [Math.floor((length - tileSize) / 2)];

  const last = length - tileSize;
  const count = Math.min(maxSamples, Math.ceil(length / tileSize));
  if (count === 1) return [Math.round(last / 2)];
  return Array.from({ length: count }, (_, i) => Math.round((last * i) / (count - 1)));
}

/**
 * Plan a deterministic edge-covering native-resolution tile grid.
 * The default is at most 3x3 = 9 inference passes per image.
 *
 * @param {number} width
 * @param {number} height
 * @param {{tileSize?: number, maxAxisSamples?: number}} [options]
 * @returns {NativeTile[]}
 */
export function planNativeTiles(width, height, options = {}) {
  const tileSize = options.tileSize ?? MODEL_INPUT_SIZE;
  const maxAxisSamples = options.maxAxisSamples ?? DEFAULT_MAX_AXIS_SAMPLES;
  const xs = axisOrigins(width, tileSize, maxAxisSamples);
  const ys = axisOrigins(height, tileSize, maxAxisSamples);
  return ys.flatMap((y) => xs.map((x) => ({ x, y, size: tileSize })));
}

/**
 * Convert RGBA bytes to an ImageNet-normalized float32 NCHW tensor.
 * Kept independent from Canvas so parity can be unit-tested in Node.
 *
 * @param {Uint8ClampedArray | Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @returns {Float32Array}
 */
export function rgbaToImageNetNchw(rgba, width, height) {
  const pixels = width * height;
  if (rgba.length !== pixels * 4) {
    throw new RangeError(`expected ${pixels * 4} RGBA bytes, got ${rgba.length}`);
  }

  const output = new Float32Array(pixels * 3);
  for (let i = 0; i < pixels; i += 1) {
    const source = i * 4;
    output[i] = ((rgba[source] ?? 0) / 255 - IMAGENET_MEAN[0]) / IMAGENET_STD[0];
    output[pixels + i] = ((rgba[source + 1] ?? 0) / 255 - IMAGENET_MEAN[1]) / IMAGENET_STD[1];
    output[pixels * 2 + i] = ((rgba[source + 2] ?? 0) / 255 - IMAGENET_MEAN[2]) / IMAGENET_STD[2];
  }
  return output;
}

/** @type {OffscreenCanvas | null} */
let workCanvas = null;
/** @type {OffscreenCanvasRenderingContext2D | null} */
let workCtx = null;

/**
 * @param {number} width
 * @param {number} height
 * @returns {OffscreenCanvasRenderingContext2D}
 */
function getWorkContext(width, height) {
  if (!workCanvas || !workCtx || workCanvas.width !== width || workCanvas.height !== height) {
    workCanvas = new OffscreenCanvas(width, height);
    workCtx = workCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
  }
  if (!workCtx) throw new Error('2D canvas unavailable for model preprocessing');
  return workCtx;
}

/**
 * Rasterize one crop without rescaling and return its input tensor data.
 *
 * @param {ImageBitmap} bitmap
 * @param {NativeTile} tile
 * @returns {Float32Array}
 */
export function bitmapTileToNchw(bitmap, tile) {
  const ctx = getWorkContext(tile.size, tile.size);

  // Rounded ImageNet mean maps to approximately zero after normalization.
  ctx.fillStyle = 'rgb(124, 116, 104)';
  ctx.fillRect(0, 0, tile.size, tile.size);

  const sx = Math.max(0, tile.x);
  const sy = Math.max(0, tile.y);
  const dx = sx - tile.x;
  const dy = sy - tile.y;
  const copyWidth = Math.min(tile.size - dx, bitmap.width - sx);
  const copyHeight = Math.min(tile.size - dy, bitmap.height - sy);
  if (copyWidth <= 0 || copyHeight <= 0) throw new Error('tile does not intersect the image');

  // Equal source/destination dimensions are the native-resolution invariant.
  ctx.drawImage(bitmap, sx, sy, copyWidth, copyHeight, dx, dy, copyWidth, copyHeight);
  const rgba = ctx.getImageData(0, 0, tile.size, tile.size).data;
  return rgbaToImageNetNchw(rgba, tile.size, tile.size);
}

/**
 * Rasterize the official whole-image evaluation transform and return NCHW.
 * The resize is deliberately materialized before cropping, matching the
 * two-step torchvision/PIL pipeline used by the checkpoint authors.
 *
 * @param {ImageBitmap} bitmap
 * @returns {Float32Array}
 */
export function bitmapOfficialCenterToNchw(bitmap) {
  const plan = planOfficialCenterCrop(bitmap.width, bitmap.height);
  const ctx = getWorkContext(plan.resizedWidth, plan.resizedHeight);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, plan.resizedWidth, plan.resizedHeight);
  const rgba = ctx.getImageData(plan.left, plan.top, plan.cropSize, plan.cropSize).data;
  return rgbaToImageNetNchw(rgba, plan.cropSize, plan.cropSize);
}

/** @param {number} value @returns {number} */
export function sigmoid(value) {
  return value >= 0 ? 1 / (1 + Math.exp(-value)) : Math.exp(value) / (1 + Math.exp(value));
}

/**
 * Combine native-resolution tile probabilities.
 *
 * Mean is the weakest forensic vote: one generated crop drowned by eight
 * uneventful ones looks "real". Max treats a single smoking-gun crop as
 * sufficient. Top-2 / top-3 average the highest crops so one noisy JPEG
 * block is less likely to flip a real photo.
 *
 * @param {number[]} probabilities
 * @param {string} [rule]
 * @returns {number}
 */
export function aggregateTileProbabilities(probabilities, rule = DEFAULT_TILE_AGGREGATION) {
  if (probabilities.length === 0) throw new RangeError('cannot aggregate zero tiles');
  /** @type {number[]} */
  const values = [];
  for (const probability of probabilities) {
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new RangeError(`invalid tile probability: ${probability}`);
    }
    values.push(probability);
  }

  if (rule === TILE_AGGREGATION.MEAN) {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }
  if (rule === TILE_AGGREGATION.MAX) {
    return /** @type {number} */ (Math.max(...values));
  }
  if (rule === TILE_AGGREGATION.TOP2 || rule === TILE_AGGREGATION.TOP3) {
    const k = rule === TILE_AGGREGATION.TOP2 ? 2 : 3;
    const top = [...values].sort((a, b) => b - a).slice(0, Math.min(k, values.length));
    return top.reduce((sum, value) => sum + value, 0) / top.length;
  }
  throw new RangeError(`unsupported tile aggregation: ${rule}`);
}
