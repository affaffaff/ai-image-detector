import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  MonotoneCalibrator,
  IDENTITY_CALIBRATOR,
  clampProb,
  PROB_EPS,
} from '../../src/fusion/calibration.js';

/** @param {number} a @param {number} b @param {number} [tol] */
function approx(a, b, tol = 1e-12) {
  assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b} (tol ${tol})`);
}

describe('clampProb', () => {
  test('passes through interior values', () => {
    approx(clampProb(0.5), 0.5);
    approx(clampProb(0.123), 0.123);
  });

  test('clamps to [eps, 1-eps]', () => {
    approx(clampProb(0), PROB_EPS);
    approx(clampProb(1), 1 - PROB_EPS);
    approx(clampProb(-5), PROB_EPS);
    approx(clampProb(7), 1 - PROB_EPS);
  });

  test('honours a custom eps', () => {
    approx(clampProb(0, 0.01), 0.01);
    approx(clampProb(1, 0.01), 0.99);
  });

  test('throws on non-finite input', () => {
    assert.throws(() => clampProb(NaN), RangeError);
    assert.throws(() => clampProb(Infinity), RangeError);
    assert.throws(() => clampProb(-Infinity), RangeError);
  });
});

describe('MonotoneCalibrator validation', () => {
  test('rejects missing or malformed tables', () => {
    // @ts-expect-error deliberate bad input
    assert.throws(() => new MonotoneCalibrator(undefined), TypeError);
    // @ts-expect-error deliberate bad input
    assert.throws(() => new MonotoneCalibrator({}), TypeError);
    // @ts-expect-error deliberate bad input
    assert.throws(() => new MonotoneCalibrator({ xs: [0, 1] }), TypeError);
  });

  test('rejects length mismatch', () => {
    assert.throws(
      () => new MonotoneCalibrator({ xs: [0, 1], ys: [0, 0.5, 1] }),
      RangeError,
    );
  });

  test('rejects fewer than 2 knots', () => {
    assert.throws(() => new MonotoneCalibrator({ xs: [0], ys: [0] }), RangeError);
    assert.throws(() => new MonotoneCalibrator({ xs: [], ys: [] }), RangeError);
  });

  test('rejects non-strictly-increasing xs', () => {
    assert.throws(
      () => new MonotoneCalibrator({ xs: [0, 0.5, 0.5, 1], ys: [0, 0.2, 0.4, 1] }),
      /xs not strictly increasing/,
    );
    assert.throws(
      () => new MonotoneCalibrator({ xs: [0, 0.6, 0.4, 1], ys: [0, 0.2, 0.4, 1] }),
      /xs not strictly increasing/,
    );
  });

  test('rejects decreasing ys — the legitimacy guard', () => {
    assert.throws(
      () => new MonotoneCalibrator({ xs: [0, 0.5, 1], ys: [0, 0.7, 0.6] }),
      /ys not monotone/,
    );
  });

  test('accepts flat (non-decreasing) ys', () => {
    const c = new MonotoneCalibrator({ xs: [0, 0.5, 1], ys: [0.3, 0.3, 0.9] });
    approx(c.apply(0.25), 0.3);
  });
});

describe('MonotoneCalibrator.apply', () => {
  const curve = new MonotoneCalibrator({
    xs: [0, 0.5, 1],
    ys: [0.1, 0.65, 0.9],
    id: 'test-curve',
  });

  test('returns exact values at knots', () => {
    approx(curve.apply(0), 0.1);
    approx(curve.apply(0.5), 0.65);
    approx(curve.apply(1), 0.9);
  });

  test('interpolates linearly between knots', () => {
    approx(curve.apply(0.25), 0.1 + 0.5 * (0.65 - 0.1)); // 0.375
    approx(curve.apply(0.75), 0.65 + 0.5 * (0.9 - 0.65)); // 0.775
  });

  test('clamps outside the fitted range instead of extrapolating', () => {
    approx(curve.apply(-100), 0.1);
    approx(curve.apply(100), 0.9);
  });

  test('throws on non-finite score', () => {
    assert.throws(() => curve.apply(NaN), RangeError);
    assert.throws(() => curve.apply(Infinity), RangeError);
  });

  test('is monotone non-decreasing across a dense sweep', () => {
    let prev = -Infinity;
    for (let i = 0; i <= 1000; i++) {
      const y = curve.apply(-0.2 + (1.4 * i) / 1000);
      assert.ok(y >= prev, `monotonicity violated at step ${i}: ${y} < ${prev}`);
      prev = y;
    }
  });

  test('binary search agrees with the source function on a 64-knot table', () => {
    // y = x^2 is monotone on [0, 1]; a 64-knot piecewise-linear fit should be
    // exact at knots and within the chord error bound between them.
    const xs = Array.from({ length: 64 }, (_, i) => i / 63);
    const ys = xs.map((x) => x * x);
    const c = new MonotoneCalibrator({ xs, ys });
    for (const x of xs) approx(c.apply(x), x * x, 1e-12);
    // Max chord deviation for f''=2 over segment width h is f''·h²/8 = h²/4,
    // attained at segment midpoints.
    const h = 1 / 63;
    for (let i = 0; i < 500; i++) {
      const x = i / 499;
      assert.ok(Math.abs(c.apply(x) - x * x) <= (h * h) / 4 + 1e-12);
    }
  });
});

describe('fromJSON and metadata', () => {
  test('accepts an object', () => {
    const c = MonotoneCalibrator.fromJSON({ xs: [0, 1], ys: [0, 1], id: 'a' });
    assert.equal(c.id, 'a');
    approx(c.apply(0.4), 0.4);
  });

  test('accepts a JSON string and preserves metadata', () => {
    const c = MonotoneCalibrator.fromJSON(
      JSON.stringify({ xs: [0, 1], ys: [0.2, 0.8], id: 'sig', fittedOn: 'cal.npy' }),
    );
    assert.equal(c.id, 'sig');
    assert.equal(c.fittedOn, 'cal.npy');
    approx(c.apply(0.5), 0.5);
  });

  test('defaults id/fittedOn when absent', () => {
    const c = new MonotoneCalibrator({ xs: [0, 1], ys: [0, 1] });
    assert.equal(c.id, 'unnamed');
    assert.equal(c.fittedOn, null);
  });
});

describe('IDENTITY_CALIBRATOR', () => {
  test('is the identity on [0, 1]', () => {
    assert.equal(IDENTITY_CALIBRATOR.id, 'identity');
    approx(IDENTITY_CALIBRATOR.apply(0.3), 0.3);
    approx(IDENTITY_CALIBRATOR.apply(0), 0);
    approx(IDENTITY_CALIBRATOR.apply(1), 1);
  });
});
