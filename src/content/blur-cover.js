/**
 * Cosmetic AI blur. CSS `filter: blur()` samples transparent pixels outside
 * the image, which are treated as black — that is the triangular dark
 * corners. Scale the cover clone just enough that those fringe pixels sit
 * outside an overflow clip, then fade the cover in so the toggle does not pop.
 */

/** CSS blur radius on the cover clone, in px. */
export const AI_BLUR_PX = 22;

/** Cover fade / filter duration. Keep in sync with `.blur-veil` CSS. */
export const AI_BLUR_MS = 280;

/**
 * Scale a clipped clone so a Gaussian of `blurPx` cannot paint its
 * transparent-edge fringe inside the visible box.
 * @param {number} width
 * @param {number} height
 * @param {number} [blurPx]
 */
export function blurCoverScale(width, height, blurPx = AI_BLUR_PX) {
  const min = Math.min(width, height);
  if (!(min > 0) || !Number.isFinite(min)) return 1.2;
  // Radius on each side, plus a few px so the darker corner (two edges)
  // is past the clip rather than sitting on it.
  return Math.min(2.4, Math.max(1.12, 1 + (2 * blurPx + 8) / min));
}
