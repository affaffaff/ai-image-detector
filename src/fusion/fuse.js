/**
 * Calibrated log-odds fusion.
 *
 *   L = logit(prior) + Σ_i w_i · log( p_i / (1 − p_i) )
 *   P(AI) = σ(L)
 *
 * then a final monotone remap so the balanced-accuracy-optimal boundary sits on
 * the fixed 0.65 threshold.
 *
 * Order of operations matters and is easy to get wrong:
 *
 *   raw scores
 *     -> per-signal calibration        (scores become probabilities)
 *     -> log-odds sum with weights     (fusion)
 *     -> sigmoid                       (back to a probability)
 *     -> fused calibration + shift     (boundary lands on 0.65)
 *     -> compare against 0.65
 *
 * Calibrating only at the end is wrong: the fusion sums log-likelihood ratios,
 * and a raw score that is not a probability produces a meaningless LLR.
 */

import { MonotoneCalibrator, clampProb, PROB_EPS } from './calibration.js';

/** Fixed by the product contract; this is not a tunable. */
export const DECISION_THRESHOLD = 0.65;

/**
 * Default clamp on |L|. Limits how far correlated signals can stack into false
 * certainty.
 *
 * Exported because it also bounds the range of probabilities the pipeline can
 * ever report — with a single detector signal, nothing can land outside
 * [fusedCalibrator(σ(−8)), fusedCalibrator(σ(+8))]. The display layer derives
 * that range from this value rather than hardcoding the endpoints.
 */
export const DEFAULT_MAX_ABS_LOG_ODDS = 8;

/**
 * @param {number} p
 * @returns {number}
 */
export function logit(p) {
  const c = clampProb(p);
  return Math.log(c / (1 - c));
}

/**
 * @param {number} x
 * @returns {number}
 */
export function sigmoid(x) {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

/**
 * @typedef {Object} SignalReading
 * @property {string} name          - 'detector', 'residual-cnn', 'frequency', 'provenance'
 * @property {number} [raw]         - raw score, omitted if the signal did not fire
 * @property {boolean} [override]   - hard verdict, short-circuits fusion (C2PA only)
 * @property {number} [overrideP]   - probability to report when overriding
 * @property {string} [reason]      - human-readable, surfaced in the popover
 */

/**
 * @typedef {Object} SignalConfig
 * @property {MonotoneCalibrator} calibrator
 * @property {number} weight        - w_i, fitted offline from measured LLR
 *                                    quality and damped for correlated errors
 *                                    (w_i = α / (1 + ρ_i)). Not hand-tuned.
 */

/**
 * @typedef {Object} Contribution
 * @property {string} name
 * @property {number} bits        - w_i · LLR in bits; Infinity on the override path
 * @property {number} [raw]
 * @property {number} [calibrated]
 * @property {number} [weight]
 * @property {string} [reason]
 */

/**
 * @param {SignalReading[]} signals
 * @param {Object} cfg
 * @param {Record<string, SignalConfig>} cfg.signals
 * @param {number} [cfg.prior]           - base rate of AI images. Keep near 0.5:
 *                                         balanced accuracy weights both classes
 *                                         equally regardless of true prevalence.
 * @param {MonotoneCalibrator} cfg.fusedCalibrator
 * @param {number} [cfg.maxAbsLogOdds]   - clamp on |L|, limits how far correlated
 *                                         signals can stack into false certainty
 * @returns {{probability: number, isAI: boolean, contributions: Contribution[], path: 'override' | 'fusion'}}
 */
export function fuse(signals, cfg) {
  const {
    signals: signalCfg,
    prior = 0.5,
    fusedCalibrator,
    maxAbsLogOdds = DEFAULT_MAX_ABS_LOG_ODDS,
  } = cfg;

  if (!(fusedCalibrator instanceof MonotoneCalibrator)) {
    throw new TypeError('fusedCalibrator is required; without it the boundary is not at 0.65');
  }

  // --- Override path -------------------------------------------------------
  // A valid signed C2PA manifest is evidence of a different kind: it is a
  // cryptographic attestation, not a noisy vote. It short-circuits rather than
  // contributing log-odds that a confident detector could outweigh.
  const override = signals.find((s) => s.override);
  if (override) {
    const p = clampProb(override.overrideP ?? 1 - PROB_EPS);
    return {
      probability: p,
      isAI: p >= DECISION_THRESHOLD,
      contributions: [{ name: override.name, bits: Infinity, reason: override.reason ?? 'signed manifest' }],
      path: 'override',
    };
  }

  // --- Fusion path ---------------------------------------------------------
  let L = logit(prior);
  const contributions = [];

  for (const s of signals) {
    if (s.raw == null) continue; // signal did not fire; contributes nothing
    const conf = signalCfg[s.name];
    if (!conf) throw new Error(`no config for signal '${s.name}'`);

    const p = clampProb(conf.calibrator.apply(s.raw));
    const llr = Math.log(p / (1 - p));
    const term = conf.weight * llr;
    L += term;

    contributions.push({
      name: s.name,
      raw: s.raw,
      calibrated: p,
      weight: conf.weight,
      // Reported in bits for the per-image detail popover, so the UI can show
      // which signal actually drove the verdict.
      bits: term / Math.LN2,
    });
  }

  L = Math.max(-maxAbsLogOdds, Math.min(maxAbsLogOdds, L));

  const fusedRaw = sigmoid(L);
  const probability = clampProb(fusedCalibrator.apply(fusedRaw));

  return {
    probability,
    isAI: probability >= DECISION_THRESHOLD,
    contributions,
    path: 'fusion',
  };
}
