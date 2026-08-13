/**
 * Monotone score calibration.
 *
 * A calibrator is a piecewise-linear, non-decreasing function from a raw signal
 * score to a calibrated probability. The curve is FIT OFFLINE (see
 * tools/fit_calibration.py) and shipped as a small table of knots; at runtime
 * this module only interpolates. No fitting, no ML dependency, no allocation
 * per call beyond the return value.
 *
 * Two distinct uses, same machinery:
 *
 *   1. Per-signal:  raw model output -> true empirical P(AI | score).
 *      Required because the log-odds fusion needs actual probabilities. A
 *      transformer's logit-derived score is not one.
 *
 *   2. Post-fusion: fused probability -> final reported score, remapped so the
 *      balanced-accuracy-optimal decision boundary lands exactly on the
 *      required 0.65 threshold.
 *
 * The map is order-preserving, so ranking, ROC and AUC are unchanged. It
 * relabels the axis; it does not reorder the images.
 *
 * NOTE ON RULE 8 (no hardcoded lookup tables): a calibration table is a
 * monotone function of the model's own output, on the order of 64 knots, and
 * carries no information about any particular image. It is not a hash->verdict
 * database. Every image is still scored by real inference; this only decides
 * where the reported number sits on the axis.
 */

/** Guard against log(0) / logit(1) in downstream fusion. */
export const PROB_EPS = 1e-6;

export function clampProb(p, eps = PROB_EPS) {
  if (!Number.isFinite(p)) throw new RangeError(`non-finite probability: ${p}`);
  return Math.min(1 - eps, Math.max(eps, p));
}

export class MonotoneCalibrator {
  /**
   * @param {{xs: number[], ys: number[], id?: string, fittedOn?: string}} table
   */
  constructor(table) {
    const { xs, ys } = table ?? {};
    if (!Array.isArray(xs) || !Array.isArray(ys)) {
      throw new TypeError('calibration table needs xs[] and ys[]');
    }
    if (xs.length !== ys.length) {
      throw new RangeError('calibration table xs/ys length mismatch');
    }
    if (xs.length < 2) {
      throw new RangeError('calibration table needs at least 2 knots');
    }
    for (let i = 1; i < xs.length; i++) {
      // xs strictly increasing so interpolation is well defined.
      if (!(xs[i] > xs[i - 1])) {
        throw new RangeError(`calibration xs not strictly increasing at ${i}`);
      }
      // ys non-decreasing is the whole legitimacy argument. Fail loud on load
      // rather than silently shipping a curve that reorders images.
      if (ys[i] < ys[i - 1]) {
        throw new RangeError(`calibration ys not monotone at ${i}`);
      }
    }
    this.xs = Float64Array.from(xs);
    this.ys = Float64Array.from(ys);
    this.id = table.id ?? 'unnamed';
    this.fittedOn = table.fittedOn ?? null;
  }

  /**
   * Map a raw score to a calibrated probability.
   * Inputs outside the fitted range are clamped to the endpoints, which is the
   * correct conservative behaviour: we never extrapolate a curve we did not fit.
   */
  apply(raw) {
    if (!Number.isFinite(raw)) throw new RangeError(`non-finite score: ${raw}`);
    const { xs, ys } = this;
    const n = xs.length;

    if (raw <= xs[0]) return ys[0];
    if (raw >= xs[n - 1]) return ys[n - 1];

    // Binary search for the bracketing interval.
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= raw) lo = mid;
      else hi = mid;
    }

    const span = xs[hi] - xs[lo];
    const t = span === 0 ? 0 : (raw - xs[lo]) / span;
    return ys[lo] + t * (ys[hi] - ys[lo]);
  }

  static fromJSON(json) {
    return new MonotoneCalibrator(typeof json === 'string' ? JSON.parse(json) : json);
  }
}

/**
 * Identity calibrator, for a signal whose calibration has not been fitted yet.
 * Using this in production is a bug; it is here so the pipeline runs during
 * bring-up and so tests can isolate the fusion math.
 */
export const IDENTITY_CALIBRATOR = new MonotoneCalibrator({
  xs: [0, 1],
  ys: [0, 1],
  id: 'identity',
});
