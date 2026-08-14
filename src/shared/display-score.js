/**
 * Display-only rescaling of the reported score.
 *
 * NOT part of the decision chain. `fuse()` produces the calibrated P(AI), and
 * the verdict is that number against the fixed 0.65 threshold — neither is
 * touched here. This module only decides which integer the badge prints.
 *
 * Why it has to exist: the reportable probability has an unreachable bottom.
 * With a single detector signal, `L = logit(p_detector)` is clamped to ±8 in
 * fuse.js, and the shipped fused curve maps σ(−8) = 3.4e-4 to 0.374. So an
 * image the detector is *maximally confident is real* reports 0.374 and badges
 * "37%", which a reader parses as "37% chance this is AI" — close to the
 * opposite of what was measured. On an ordinary page most real photographs sit
 * on that floor, so the number looks broken precisely when the detector is
 * working best.
 *
 * Raising the clamp does not fix it. The fused curve's own lowest knot is
 * 0.145, so ~14% is the hard floor of the probability no matter what fusion
 * does, and the bottom third of the scale stays unreachable. Only the display
 * can be fixed.
 *
 * The remap is piecewise-linear through three anchors:
 *
 *   reportable floor    ->  2    most confident REAL the pipeline can express
 *   0.65                -> 65    the fixed threshold, unmoved
 *   reportable ceiling  -> 98    most confident AI
 *
 * Monotone, so ranking, ROC, AUC and every accuracy number are unchanged; it
 * relabels the axis exactly as the calibration curves beneath it do. The
 * threshold keeps its familiar number so the badge, the popover and the
 * documented 0.65 contract all still agree. The ends are 2 and 98 rather than
 * 0 and 100 because they are clamp saturation, not certainty, and the badge
 * should not claim certainty the pipeline cannot express.
 *
 * The anchors come from the loaded calibration curve at runtime, never from a
 * literal: refitting `calibration/fused.json` moves the floor, and a stale
 * constant here would silently reintroduce the dead zone this removes.
 */

import { DECISION_THRESHOLD, DEFAULT_MAX_ABS_LOG_ODDS, sigmoid } from '../fusion/fuse.js';

/** Badge value for the most confident REAL the pipeline can express. */
export const DISPLAY_MIN = 2;
/** Badge value for the most confident AI the pipeline can express. */
export const DISPLAY_MAX = 98;
/** The fixed threshold keeps its familiar number on the badge. */
export const DISPLAY_THRESHOLD = 65;

/**
 * The probability range the pipeline can actually report, given the |L| clamp.
 * @param {import('../fusion/calibration.js').MonotoneCalibrator} fusedCalibrator
 * @param {number} [maxAbsLogOdds]
 * @returns {{min: number, max: number}}
 */
export function reportableRange(fusedCalibrator, maxAbsLogOdds = DEFAULT_MAX_ABS_LOG_ODDS) {
  return {
    min: fusedCalibrator.apply(sigmoid(-maxAbsLogOdds)),
    max: fusedCalibrator.apply(sigmoid(maxAbsLogOdds)),
  };
}

/**
 * @param {number} probability - calibrated P(AI) from fuse()
 * @param {boolean} isAI       - the verdict, already decided against 0.65
 * @param {{min: number, max: number}} range - from {@link reportableRange}
 * @returns {number} integer in [DISPLAY_MIN, DISPLAY_MAX]
 */
export function displayPercent(probability, isAI, range) {
  if (!Number.isFinite(probability)) throw new RangeError(`non-finite probability: ${probability}`);

  // The override path (C2PA) reports outside the fused range, and a refitted
  // curve could in principle put an endpoint on the wrong side of the
  // threshold. Clamping the anchors keeps both segments non-decreasing.
  const min = Math.min(range.min, DECISION_THRESHOLD);
  const max = Math.max(range.max, DECISION_THRESHOLD);

  let pct;
  if (probability <= DECISION_THRESHOLD) {
    const span = DECISION_THRESHOLD - min;
    const t = span > 0 ? (probability - min) / span : 1;
    pct = DISPLAY_MIN + t * (DISPLAY_THRESHOLD - DISPLAY_MIN);
  } else {
    const span = max - DECISION_THRESHOLD;
    const t = span > 0 ? (probability - DECISION_THRESHOLD) / span : 0;
    pct = DISPLAY_THRESHOLD + t * (DISPLAY_MAX - DISPLAY_THRESHOLD);
  }

  const rounded = Math.round(Math.min(DISPLAY_MAX, Math.max(DISPLAY_MIN, pct)));

  // The printed number must never contradict the badge colour. Rounding alone
  // puts p = 0.6499 on "65%" with a REAL verdict — the green 65% against a
  // 0.65 threshold that made the old scale look broken.
  return isAI ? Math.max(DISPLAY_THRESHOLD, rounded) : Math.min(DISPLAY_THRESHOLD - 1, rounded);
}
