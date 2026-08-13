import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { fuse, logit, sigmoid, DECISION_THRESHOLD } from '../../src/fusion/fuse.js';
import { MonotoneCalibrator, IDENTITY_CALIBRATOR, PROB_EPS } from '../../src/fusion/calibration.js';

/** @param {number} a @param {number} b @param {number} [tol] */
function approx(a, b, tol = 1e-9) {
  assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b} (tol ${tol})`);
}

/** Identity-calibrated single/multi signal config for isolating the math. */
function identityCfg(weights = /** @type {Record<string, number>} */ ({ detector: 1 })) {
  /** @type {Record<string, {calibrator: MonotoneCalibrator, weight: number}>} */
  const signals = {};
  for (const [name, weight] of Object.entries(weights)) {
    signals[name] = { calibrator: IDENTITY_CALIBRATOR, weight };
  }
  return { signals, fusedCalibrator: IDENTITY_CALIBRATOR };
}

describe('logit / sigmoid', () => {
  test('sigmoid(0) is 0.5 and both tails are stable', () => {
    approx(sigmoid(0), 0.5);
    assert.ok(sigmoid(-800) >= 0 && sigmoid(-800) < 1e-12);
    assert.ok(sigmoid(800) <= 1 && sigmoid(800) > 1 - 1e-12);
    assert.ok(Number.isFinite(sigmoid(-800)) && Number.isFinite(sigmoid(800)));
  });

  test('sigmoid inverts logit on the open interval', () => {
    for (const p of [0.01, 0.2, 0.5, 0.65, 0.9, 0.99]) {
      approx(sigmoid(logit(p)), p, 1e-12);
    }
  });

  test('logit clamps the closed endpoints instead of diverging', () => {
    assert.ok(Number.isFinite(logit(0)));
    assert.ok(Number.isFinite(logit(1)));
    approx(logit(0), Math.log(PROB_EPS / (1 - PROB_EPS)), 1e-6);
  });
});

describe('the fixed threshold', () => {
  test('DECISION_THRESHOLD is 0.65 — fixed by the bounty, not a tunable', () => {
    assert.equal(DECISION_THRESHOLD, 0.65);
  });
});

describe('fuse: config validation', () => {
  test('throws without a fusedCalibrator', () => {
    // @ts-expect-error deliberate bad config
    assert.throws(() => fuse([], { signals: {} }), TypeError);
  });

  test('throws on a signal with no config', () => {
    assert.throws(
      () => fuse([{ name: 'mystery', raw: 0.5 }], identityCfg({ detector: 1 })),
      /no config for signal 'mystery'/,
    );
  });
});

describe('fuse: override path (C2PA)', () => {
  test('short-circuits with the given probability', () => {
    const r = fuse(
      [{ name: 'provenance', override: true, overrideP: 0.99, reason: 'signed manifest: DALL-E' }],
      identityCfg(),
    );
    assert.equal(r.path, 'override');
    approx(r.probability, 0.99);
    assert.equal(r.isAI, true);
    assert.equal(r.contributions.length, 1);
    assert.equal(r.contributions[0]?.bits, Infinity);
    assert.equal(r.contributions[0]?.reason, 'signed manifest: DALL-E');
  });

  test('a camera-capture attestation overrides toward real', () => {
    const r = fuse(
      [
        { name: 'provenance', override: true, overrideP: 0.01, reason: 'signed capture manifest' },
        { name: 'detector', raw: 0.97 }, // confident detector must NOT outvote it
      ],
      identityCfg(),
    );
    assert.equal(r.path, 'override');
    approx(r.probability, 0.01);
    assert.equal(r.isAI, false);
  });

  test('defaults to near-certain AI when overrideP omitted', () => {
    const r = fuse([{ name: 'provenance', override: true }], identityCfg());
    approx(r.probability, 1 - PROB_EPS, 1e-12);
    assert.equal(r.isAI, true);
  });

  test('clamps an out-of-range overrideP', () => {
    const r = fuse([{ name: 'provenance', override: true, overrideP: 1.5 }], identityCfg());
    assert.ok(r.probability <= 1 - PROB_EPS);
  });
});

describe('fuse: fusion path math', () => {
  test('single identity-calibrated signal with weight 1 passes through', () => {
    const r = fuse([{ name: 'detector', raw: 0.8 }], identityCfg());
    assert.equal(r.path, 'fusion');
    approx(r.probability, 0.8, 1e-9);
  });

  test('no signals firing returns the prior', () => {
    const r = fuse([], identityCfg());
    approx(r.probability, 0.5, 1e-12);
    assert.equal(r.isAI, false);
  });

  test('signals without raw are skipped, not zero-counted', () => {
    const r = fuse(
      [{ name: 'detector', raw: 0.8 }, { name: 'frequency' }],
      identityCfg({ detector: 1, frequency: 1 }),
    );
    approx(r.probability, 0.8, 1e-9);
    assert.equal(r.contributions.length, 1);
  });

  test('weight scales the log-likelihood ratio', () => {
    // L = 2 * log(0.8/0.2) = 2 ln 4; sigmoid = 16/17
    const r = fuse([{ name: 'detector', raw: 0.8 }], identityCfg({ detector: 2 }));
    approx(r.probability, 16 / 17, 1e-9);
  });

  test('symmetric disagreement cancels to the prior', () => {
    const r = fuse(
      [
        { name: 'detector', raw: 0.8 },
        { name: 'frequency', raw: 0.2 },
      ],
      identityCfg({ detector: 1, frequency: 1 }),
    );
    approx(r.probability, 0.5, 1e-9);
  });

  test('a non-0.5 prior shifts the result', () => {
    const cfg = { ...identityCfg(), prior: 0.65 };
    const r = fuse([], cfg);
    approx(r.probability, 0.65, 1e-9);
  });

  test('maxAbsLogOdds caps stacked certainty', () => {
    const cfg = { ...identityCfg({ a: 1, b: 1, c: 1 }), maxAbsLogOdds: 2 };
    const r = fuse(
      [
        { name: 'a', raw: 0.99 },
        { name: 'b', raw: 0.99 },
        { name: 'c', raw: 0.99 },
      ],
      cfg,
    );
    approx(r.probability, sigmoid(2), 1e-12);
  });

  test('default clamp still applies at ±8', () => {
    const cfg = identityCfg({ a: 5, b: 5 });
    const r = fuse(
      [
        { name: 'a', raw: 1 - PROB_EPS },
        { name: 'b', raw: 1 - PROB_EPS },
      ],
      cfg,
    );
    approx(r.probability, sigmoid(8), 1e-12);
  });
});

describe('fuse: calibration order is load-bearing', () => {
  test('per-signal calibrator is applied BEFORE the log-odds sum', () => {
    // Raw detector output lives on [-10, 10]; the calibrator maps it to a
    // probability. If fuse used raw directly, clampProb(5) would give ~1-eps
    // and the LLR would explode. Through the calibrator: p = 0.75.
    const cal = new MonotoneCalibrator({ xs: [-10, 10], ys: [0, 1] });
    const r = fuse(
      [{ name: 'detector', raw: 5 }],
      { signals: { detector: { calibrator: cal, weight: 1 } }, fusedCalibrator: IDENTITY_CALIBRATOR },
    );
    approx(r.probability, 0.75, 1e-9);
  });

  test('fused calibrator places the boundary on 0.65', () => {
    // The 0.65-shift map from tools/fit_calibration.py with t* = 0.5:
    // [0, 0.5] -> [0, 0.65], [0.5, 1] -> [0.65, 1].
    const shift = new MonotoneCalibrator({ xs: [0, 0.5, 1], ys: [0, 0.65, 1] });
    const cfg = { ...identityCfg(), fusedCalibrator: shift };

    // A signal at exactly the model's own optimal cut (0.5) must land exactly
    // on the fixed threshold and be classified AI (>=).
    const atCut = fuse([{ name: 'detector', raw: 0.5 }], cfg);
    approx(atCut.probability, 0.65, 1e-9);
    assert.equal(atCut.isAI, true);

    // Just below the cut -> below threshold -> real.
    const below = fuse([{ name: 'detector', raw: 0.49 }], cfg);
    assert.ok(below.probability < 0.65);
    assert.equal(below.isAI, false);

    // Just above -> AI.
    const above = fuse([{ name: 'detector', raw: 0.51 }], cfg);
    assert.ok(above.probability > 0.65);
    assert.equal(above.isAI, true);
  });

  test('decision at exactly 0.65 is AI (>= comparison)', () => {
    const exact = new MonotoneCalibrator({ xs: [0, 1], ys: [0.65, 0.65] });
    const r = fuse([{ name: 'detector', raw: 0.3 }], { ...identityCfg(), fusedCalibrator: exact });
    assert.equal(r.probability, 0.65);
    assert.equal(r.isAI, true);
  });
});

describe('fuse: contributions for the explainability popover', () => {
  test('reports name, raw, calibrated, weight and exact bits', () => {
    const r = fuse([{ name: 'detector', raw: 0.8 }], identityCfg());
    assert.equal(r.contributions.length, 1);
    const c = r.contributions[0];
    assert.equal(c?.name, 'detector');
    approx(c?.raw ?? NaN, 0.8);
    approx(c?.calibrated ?? NaN, 0.8, 1e-12);
    assert.equal(c?.weight, 1);
    // log2(0.8/0.2) = 2 bits exactly.
    approx(c?.bits ?? NaN, 2, 1e-9);
  });

  test('negative evidence yields negative bits', () => {
    const r = fuse([{ name: 'frequency', raw: 0.2 }], identityCfg({ frequency: 1 }));
    approx(r.contributions[0]?.bits ?? NaN, -2, 1e-9);
  });
});
