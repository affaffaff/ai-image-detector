/**
 * Native-tile veto of a downscaled official-crop AI verdict.
 *
 * The shipped transform is Resize(short edge 440) + CenterCrop(384). When
 * that resize *downscales*, bilinear interpolation can manufacture the same
 * mid-frequency structure the detector reads as generation, and the official
 * crop then badges a real photograph as AI. Measured on the Britannica
 * students-activity photograph: official 0.355 (AI) against six native 384
 * crops whose max is 0.063.
 *
 * The veto is a second look at the same pixels, never a lookup. It fires
 * only when all of:
 *
 *   1. the official transform actually downscaled (short edge > 440);
 *   2. the official crop is high enough that it would fuse to AI;
 *   3. the graphic-content gate did not already cap the verdict;
 *   4. every native-resolution 384 crop is still below NATIVE_VETO_MAX_TAU.
 *
 * (1) is the regime where the artifact exists. (2) is the only case that
 * can produce a false AI badge — a real-looking official crop is left
 * alone. (3) is the same reason the service worker never applies this
 * veto after a graphic cap: extra native passes cannot change a badge
 * already clamped below 0.65, and logos/charts otherwise paid a full
 * tile grid on every hit. (4) is "not a single native tile agrees", so
 * the official AI score has no support at the resolution the checkpoint
 * was trained on.
 *
 * Family (gated native-max veto) was selected on the FIT split of the
 * web-realistic replica. Tau was picked on the CALIBRATION split among the
 * FIT plateau. The eval split is not used to choose the rule.
 *
 * This is a cap, not an override: C2PA still outranks it, an image the
 * official crop already called real is unchanged, and the detector still
 * runs. The reported probability is the fused native-median (what the
 * tiles actually said), clamped below 0.65 so the badge colour matches.
 *
 * Rescue (flipping official-REAL to AI because one native tile is high) was
 * measured on the same splits and is rejected: it recovers a handful of
 * official-crop misses at a TNR cost the FIT split cannot see, because FIT
 * TPR sits at 0.51 against eval TPR 0.82.
 */

import { DECISION_THRESHOLD } from '../fusion/fuse.js';
import { clampProb } from '../fusion/calibration.js';

/**
 * Strongest native tile still counts as "does not agree with an AI verdict".
 *
 * Selected on the calibration split among the FIT-split plateau
 * (tau 0.03–0.20 all within 0.002 FIT BA of each other). 0.1 is the
 * rounder of the two calibration-tied values (0.08 / 0.1).
 */
export const NATIVE_VETO_MAX_TAU = 0.1;

/**
 * Below this official-crop score the fused curve cannot produce an AI
 * verdict (the shipped 0.65-knot is 0.0583), so native tiles would be
 * spent on images whose badge is already REAL. Kept slightly under the
 * knot so a refit that moves tStar down a little still probes. Must stay
 * at or below the fused-curve 0.65-knot; raise it only after a refit.
 */
export const NATIVE_VETO_OFFICIAL_FLOOR = 0.05;

/**
 * The official transform's resize target. Below this short edge the resize
 * is an upscale, which is a different failure mode (and the scanner's
 * source-upgrade path). Duplicated from preprocess.js so this module stays
 * importable from the service worker without pulling canvas code.
 */
export const NATIVE_VETO_MIN_SHORT_EDGE = 440;

/**
 * @param {Object} input
 * @param {number} input.shortEdge
 * @param {number} input.officialScore
 * @param {boolean} [input.graphicGated]
 * @returns {boolean}
 */
export function shouldProbeNativeTiles(input) {
  if (input.graphicGated) return false;
  return (
    input.shortEdge > NATIVE_VETO_MIN_SHORT_EDGE &&
    input.officialScore >= NATIVE_VETO_OFFICIAL_FLOOR
  );
}

/**
 * @param {Object} input
 * @param {number} input.probability - fused P(AI) from the official crop
 * @param {number} [input.nativeMax]
 * @param {number} [input.nativeMedian]
 * @param {(raw: number) => number} input.fuseNative - fused calibrator on a raw score
 * @returns {{probability: number, vetoed: boolean}}
 */
export function applyNativeTileVeto(input) {
  const { probability, nativeMax, nativeMedian, fuseNative } = input;
  if (!Number.isFinite(probability)) {
    throw new RangeError(`non-finite probability: ${probability}`);
  }
  if (probability < DECISION_THRESHOLD) return { probability, vetoed: false };
  if (typeof nativeMax !== 'number' || !(nativeMax < NATIVE_VETO_MAX_TAU)) {
    return { probability, vetoed: false };
  }

  const nativeRaw = Number.isFinite(nativeMedian) ? /** @type {number} */ (nativeMedian) : nativeMax;
  const fromNative = clampProb(fuseNative(nativeRaw));
  // The native median is the honest report. Clamp it below the fixed
  // threshold so a native_max of 0.06 (just above the fused 0.65-knot)
  // cannot keep an AI badge after we have already decided the official
  // crop was a resampling artifact.
  const capped = Math.min(probability, fromNative, DECISION_THRESHOLD - 1e-6);
  return { probability: capped, vetoed: capped < probability };
}
