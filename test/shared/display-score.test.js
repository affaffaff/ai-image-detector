import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { MonotoneCalibrator } from '../../src/fusion/calibration.js';
import { DECISION_THRESHOLD, DEFAULT_MAX_ABS_LOG_ODDS, sigmoid } from '../../src/fusion/fuse.js';
import {
  DISPLAY_MAX,
  DISPLAY_MIN,
  DISPLAY_THRESHOLD,
  displayPercent,
  reportableRange,
} from '../../src/shared/display-score.js';

const shipped = MonotoneCalibrator.fromJSON(
  JSON.parse(readFileSync(new URL('../../models/calibration/fused.json', import.meta.url), 'utf8')),
);
const shippedRange = reportableRange(shipped);

test('reportableRange is the clamp image, not the curve endpoints', () => {
  // The clamp on |L| means the curve's own endpoints are unreachable.
  assert.equal(shippedRange.min, shipped.apply(sigmoid(-DEFAULT_MAX_ABS_LOG_ODDS)));
  assert.equal(shippedRange.max, shipped.apply(sigmoid(DEFAULT_MAX_ABS_LOG_ODDS)));
  assert.ok(shippedRange.min > shipped.apply(0), 'floor sits above the curve minimum');
  assert.ok(shippedRange.max < shipped.apply(1), 'ceiling sits below the curve maximum');
});

test('the shipped floor badges in single digits instead of 37%', () => {
  // The regression this module exists for: a maximally-confident REAL used to
  // print 37%, which reads as "37% chance this is AI".
  assert.equal(Math.round(shippedRange.min * 100), 37);
  assert.equal(displayPercent(shippedRange.min, false, shippedRange), DISPLAY_MIN);
  assert.ok(DISPLAY_MIN <= 10);
});

test('anchors land exactly on their targets', () => {
  assert.equal(displayPercent(shippedRange.min, false, shippedRange), DISPLAY_MIN);
  assert.equal(displayPercent(DECISION_THRESHOLD, true, shippedRange), DISPLAY_THRESHOLD);
  assert.equal(displayPercent(shippedRange.max, true, shippedRange), DISPLAY_MAX);
});

test('the printed number never contradicts the verdict', () => {
  // Rounding alone puts these on 65 — the green "65%" against a 0.65 threshold.
  const justUnder = DECISION_THRESHOLD - 1e-9;
  assert.equal(displayPercent(justUnder, false, shippedRange), DISPLAY_THRESHOLD - 1);
  assert.equal(displayPercent(DECISION_THRESHOLD, true, shippedRange), DISPLAY_THRESHOLD);
  for (const p of [0.3743, 0.5, 0.6499, 0.64999999]) {
    assert.ok(displayPercent(p, false, shippedRange) < DISPLAY_THRESHOLD, `real ${p}`);
  }
  for (const p of [0.65, 0.6501, 0.8, 0.95]) {
    assert.ok(displayPercent(p, true, shippedRange) >= DISPLAY_THRESHOLD, `ai ${p}`);
  }
});

test('monotone: ranking survives the remap', () => {
  let previous = -Infinity;
  for (let i = 0; i <= 400; i++) {
    const p = shippedRange.min + (i / 400) * (shippedRange.max - shippedRange.min);
    const pct = displayPercent(p, p >= DECISION_THRESHOLD, shippedRange);
    assert.ok(pct >= previous, `not monotone at p=${p}`);
    previous = pct;
  }
});

test('the whole reachable range is used, without a dead zone at the bottom', () => {
  const seen = new Set();
  for (let i = 0; i <= 2000; i++) {
    const p = shippedRange.min + (i / 2000) * (shippedRange.max - shippedRange.min);
    seen.add(displayPercent(p, p >= DECISION_THRESHOLD, shippedRange));
  }
  assert.ok(seen.has(DISPLAY_MIN) && seen.has(DISPLAY_MAX));
  // Old scale reached 37..95 (59 values). The remap must do better than that.
  assert.ok(seen.size > 90, `only ${seen.size} distinct badge values`);
});

test('override-path probabilities clamp instead of overflowing the scale', () => {
  // fuse() returns ~1 on a signed C2PA manifest, well outside the fused range.
  assert.equal(displayPercent(1 - 1e-6, true, shippedRange), DISPLAY_MAX);
  assert.equal(displayPercent(1e-6, false, shippedRange), DISPLAY_MIN);
});

test('rejects a non-finite probability rather than printing NaN%', () => {
  assert.throws(() => displayPercent(NaN, false, shippedRange), RangeError);
});

test('identity bring-up calibration still produces a usable scale', () => {
  const identity = new MonotoneCalibrator({ xs: [0, 1], ys: [0, 1] });
  const range = reportableRange(identity);
  assert.equal(displayPercent(range.min, false, range), DISPLAY_MIN);
  assert.equal(displayPercent(range.max, true, range), DISPLAY_MAX);
  assert.equal(displayPercent(DECISION_THRESHOLD, true, range), DISPLAY_THRESHOLD);
});

test('a degenerate range cannot invert a segment', () => {
  const flat = { min: 0.9, max: 0.91 }; // both anchors above the threshold
  const low = displayPercent(0.2, false, flat);
  const high = displayPercent(0.95, true, flat);
  assert.ok(low < DISPLAY_THRESHOLD && high >= DISPLAY_THRESHOLD);
  assert.ok(low >= DISPLAY_MIN && high <= DISPLAY_MAX);
});
