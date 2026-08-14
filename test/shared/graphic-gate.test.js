import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GRAPHIC_GATE_THRESHOLDS,
  GRAPHIC_MIN_PIXELS,
  GRAPHIC_PALETTE_MAX_TRACKED,
  GRAPHIC_PROBABILITY_CAP,
  accumulateGraphicStats,
  applyGraphicCap,
  createGraphicAccumulator,
  evaluateGraphicGate,
  finalizeGraphicStats,
} from '../../src/shared/graphic-gate.js';

/**
 * @param {number} width
 * @param {number} height
 * @param {(x: number, y: number) => [number, number, number]} paint
 */
function rgbaOf(width, height, paint) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x, y);
      const o = (y * width + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  }
  return data;
}

/**
 * @param {number} width
 * @param {number} height
 * @param {(x: number, y: number) => [number, number, number]} paint
 */
function statsOf(width, height, paint) {
  const acc = createGraphicAccumulator();
  accumulateGraphicStats(acc, rgbaOf(width, height, paint), width, height);
  return finalizeGraphicStats(acc);
}

/**
 * Deterministic LCG so "noise" images are reproducible.
 * @param {number} seed
 */
function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

test('flat two-tone logo with hard edges gates as graphic', () => {
  // White field with a solid dark rounded-square block: a sticker/logo shape.
  const stats = statsOf(96, 96, (x, y) => {
    const inBlock = x >= 24 && x < 72 && y >= 24 && y < 72;
    return inBlock ? [16, 32, 160] : [255, 255, 255];
  });
  assert.equal(stats.distinctColors, 2);
  assert.ok(stats.flatFraction > 0.9, `flat ${stats.flatFraction}`);
  assert.ok(stats.softFraction < 0.01, `soft ${stats.softFraction}`);
  assert.ok(stats.hardFraction > 0.004, `hard ${stats.hardFraction}`);
  assert.ok(stats.top8Mass > 0.99, `top8 ${stats.top8Mass}`);
  assert.equal(evaluateGraphicGate(stats), true);
});

test('text-like stroke pattern gates as graphic', () => {
  // Vertical 2px dark strokes every 8px in a band, like rendered glyph stems.
  const stats = statsOf(128, 128, (x, y) => {
    const inBand = y >= 32 && y < 96;
    const stroke = inBand && x % 8 < 2;
    return stroke ? [20, 20, 20] : [250, 250, 250];
  });
  assert.equal(evaluateGraphicGate(stats), true);
});

test('sensor-like noise never gates', () => {
  const rng = makeRng(7);
  const stats = statsOf(96, 96, () => {
    const v = Math.floor(rng() * 256);
    return [v, Math.floor(rng() * 256), Math.floor(rng() * 256)];
  });
  assert.ok(stats.flatFraction < 0.2, `flat ${stats.flatFraction}`);
  assert.equal(evaluateGraphicGate(stats), false);
});

test('photographic texture (smooth content + noise floor) never gates', () => {
  // Slow 2D ramp plus +/-4-level noise: the texture every camera and every
  // diffusion decoder leaves in "flat" regions.
  const rng = makeRng(21);
  const stats = statsOf(96, 96, (x, y) => {
    const base = 90 + x / 2 + y / 3;
    const n = () => Math.max(0, Math.min(255, Math.round(base + (rng() - 0.5) * 8)));
    return [n(), n(), n()];
  });
  assert.ok(stats.softFraction > GRAPHIC_GATE_THRESHOLDS.maxSoftFraction, `soft ${stats.softFraction}`);
  assert.equal(evaluateGraphicGate(stats), false);
});

test('near-flat AI-decoder-style field with mild noise never gates', () => {
  const rng = makeRng(3);
  const stats = statsOf(96, 96, () => {
    const v = 200 + Math.round((rng() - 0.5) * 6);
    return [v, v, v];
  });
  // Plenty of dead-flat pairs, but the mild noise shows up as soft texture.
  assert.ok(stats.softFraction > GRAPHIC_GATE_THRESHOLDS.maxSoftFraction, `soft ${stats.softFraction}`);
  assert.equal(evaluateGraphicGate(stats), false);
});

test('smooth designed gradient fails the palette test, does not gate', () => {
  // 1 luma level per pixel column: every adjacent diff is "flat", but the
  // palette spreads across bins, so top-8 mass stays low.
  const stats = statsOf(256, 64, (x) => [x, x, x]);
  assert.ok(stats.flatFraction > 0.9, `flat ${stats.flatFraction}`);
  assert.ok(stats.top8Mass < GRAPHIC_GATE_THRESHOLDS.minTop8Mass, `top8 ${stats.top8Mass}`);
  assert.equal(evaluateGraphicGate(stats), false);
});

test('flat but edge-free field (crushed sky, blown highlight) does not gate', () => {
  const stats = statsOf(96, 96, () => [8, 8, 12]);
  assert.equal(stats.hardFraction, 0);
  assert.equal(evaluateGraphicGate(stats), false);
});

test('tiny samples never gate', () => {
  const stats = statsOf(16, 16, (x) => (x % 4 < 2 ? [0, 0, 0] : [255, 255, 255]));
  assert.ok(stats.pixels < GRAPHIC_MIN_PIXELS);
  assert.equal(evaluateGraphicGate(stats), false);
});

test('one photographic patch among flat ones blocks the gate', () => {
  const acc = createGraphicAccumulator();
  // Eight patches of clean sticker-like content...
  for (let i = 0; i < 8; i += 1) {
    accumulateGraphicStats(
      acc,
      rgbaOf(48, 48, (x) => (x % 12 < 3 ? [10, 10, 10] : [255, 255, 255])),
      48,
      48,
    );
  }
  // ...and one patch of photographic texture (a subject the web JPEG could
  // not flatten). The global soft fraction stays small; the patch maximum
  // must catch it anyway.
  const rng = makeRng(11);
  accumulateGraphicStats(
    acc,
    rgbaOf(48, 48, () => {
      const v = 128 + Math.round((rng() - 0.5) * 14);
      return [v, v, v];
    }),
    48,
    48,
  );
  const stats = finalizeGraphicStats(acc);
  assert.ok(stats.softFraction < GRAPHIC_GATE_THRESHOLDS.maxSoftFraction, `soft ${stats.softFraction}`);
  assert.ok(stats.maxPatchSoft > GRAPHIC_GATE_THRESHOLDS.maxPatchSoftFraction, `maxPatchSoft ${stats.maxPatchSoft}`);
  assert.equal(evaluateGraphicGate(stats), false);
});

test('accumulating patches matches one combined pass over the same pixels', () => {
  /** @param {number} x @param {number} y @returns {[number, number, number]} */
  const paint = (x, y) => (x >= 10 && x < 20 && y >= 4 && y < 40 ? [0, 0, 0] : [240, 240, 240]);
  const whole = statsOf(48, 48, paint);

  const acc = createGraphicAccumulator();
  // Two horizontal halves: gradient pairs inside each half only.
  accumulateGraphicStats(acc, rgbaOf(48, 24, (x, y) => paint(x, y)), 48, 24);
  accumulateGraphicStats(acc, rgbaOf(48, 24, (x, y) => paint(x, y + 24)), 48, 24);
  const split = finalizeGraphicStats(acc);

  assert.equal(split.pixels, whole.pixels);
  assert.equal(split.distinctColors, whole.distinctColors);
  assert.equal(split.top8Mass, whole.top8Mass);
  // The split loses exactly one row of vertical pairs (48 comparisons).
  assert.equal(split.gradientPixels, whole.gradientPixels - 48);
});

test('palette tracking saturates without corrupting the denominator', () => {
  const acc = createGraphicAccumulator();
  // 128x128 unique-ish colors: (x, y) -> spread across all 32k bins.
  const data = rgbaOf(128, 128, (x, y) => [(x * 2) % 256, (y * 2) % 256, ((x ^ y) * 2) % 256]);
  accumulateGraphicStats(acc, data, 128, 128);
  const stats = finalizeGraphicStats(acc);
  assert.ok(stats.distinctColors <= GRAPHIC_PALETTE_MAX_TRACKED);
  assert.equal(stats.pixels, 128 * 128);
  assert.ok(stats.top8Mass < 0.1, `top8 ${stats.top8Mass}`);
});

test('rejects RGBA length mismatches and bad dimensions', () => {
  const acc = createGraphicAccumulator();
  assert.throws(() => accumulateGraphicStats(acc, new Uint8ClampedArray(12), 2, 2), RangeError);
  assert.throws(() => accumulateGraphicStats(acc, new Uint8ClampedArray(0), 0, 2), RangeError);
});

test('applyGraphicCap caps only above the cap and reports it', () => {
  const capped = applyGraphicCap(0.92);
  assert.equal(capped.probability, GRAPHIC_PROBABILITY_CAP);
  assert.equal(capped.capped, true);

  const untouched = applyGraphicCap(0.2);
  assert.equal(untouched.probability, 0.2);
  assert.equal(untouched.capped, false);

  const exact = applyGraphicCap(GRAPHIC_PROBABILITY_CAP);
  assert.equal(exact.probability, GRAPHIC_PROBABILITY_CAP);
  assert.equal(exact.capped, false);
});

test('the cap sits strictly below the fixed decision threshold', () => {
  assert.ok(GRAPHIC_PROBABILITY_CAP < 0.65);
});
