/**
 * Pure candidate classification shared by the DOM scanner and its tests.
 * Waiting states deliberately are not terminal: lazy image components often
 * intersect before they assign a usable source or finish decoding it.
 */

import { isInlinePayloadTooLarge } from '../shared/inline-payload.js';

/**
 * @param {Object} input
 * @param {string} input.url
 * @param {boolean} input.complete
 * @param {number} input.naturalWidth
 * @param {number} input.naturalHeight
 * @param {number} input.displayedWidth
 * @param {number} input.displayedHeight
 * @param {number} input.minEdge
 * @returns {'wait-source' | 'wait-load' | 'skip' | 'scan'}
 */
export function classifyImageCandidate(input) {
  if (!input.url || !/^(https?:|data:)/.test(input.url)) return 'wait-source';
  // Vector UI assets are not model inputs. createImageBitmap support for SVG
  // fetched from an extension context is inconsistent (Wikipedia wordmarks
  // fail in current Chromium), and raster-forensics scores would be
  // meaningless even when decoding succeeds.
  if (isSvgImageUrl(input.url)) return 'skip';
  if (isInlinePayloadTooLarge(input.url)) return 'skip';
  if (!input.complete || input.naturalWidth === 0 || input.naturalHeight === 0) {
    return 'wait-load';
  }

  const displayedEdge = Math.min(input.displayedWidth, input.displayedHeight);
  // Eligibility follows the pixels the user can actually see. Search pages
  // routinely use a 256px source for a 24px favicon/avatar; natural size made
  // those tiny decorations look like scan-worthy images and covered the page
  // in badges. A genuinely upscaled thumbnail still passes because its painted
  // size is large enough to be useful.
  return displayedEdge < input.minEdge ? 'skip' : 'scan';
}

/**
 * Copy a DOMRect-like box into a plain object with the six fields every caller
 * reads. `{ ...box }` is NOT safe here: DOMRect's left/top/right/bottom/width/
 * height are prototype accessors, not own properties, so spreading a real
 * DOMRect silently produces `{}` — which sent every badge to the overlay's
 * static position (0,0) instead of onto its image. Regression: candidate.test.js
 * 'handles a DOMRect-like box'.
 *
 * @param {{left: number, top: number, right: number, bottom: number, width: number, height: number}} box
 * @returns {{left: number, top: number, right: number, bottom: number, width: number, height: number}}
 */
function plainRect(box) {
  return {
    left: box.left,
    top: box.top,
    right: box.right,
    bottom: box.bottom,
    width: box.width,
    height: box.height,
  };
}

/**
 * Rectangle occupied by the visible pixels of an <img>. getBoundingClientRect
 * describes the element box, not the image inside an object-fit: contain box;
 * image viewers commonly leave hundreds of black pixels in that difference.
 *
 * @param {Object} input
 * @param {{left: number, top: number, right: number, bottom: number, width: number, height: number}} input.box
 * @param {number} input.naturalWidth
 * @param {number} input.naturalHeight
 * @param {string} input.objectFit
 * @param {string} input.objectPosition
 * @returns {{left: number, top: number, right: number, bottom: number, width: number, height: number}}
 */
export function fittedImageRect(input) {
  const { box, naturalWidth, naturalHeight } = input;
  if (!(box.width > 0 && box.height > 0 && naturalWidth > 0 && naturalHeight > 0)) {
    return plainRect(box);
  }

  const containScale = Math.min(box.width / naturalWidth, box.height / naturalHeight);
  let width = box.width;
  let height = box.height;
  switch (input.objectFit) {
    case 'contain':
      width = naturalWidth * containScale;
      height = naturalHeight * containScale;
      break;
    case 'none':
      width = naturalWidth;
      height = naturalHeight;
      break;
    case 'scale-down': {
      const scale = Math.min(1, containScale);
      width = naturalWidth * scale;
      height = naturalHeight * scale;
      break;
    }
    // cover and fill paint every part of the element box. Returning the box is
    // also correct for a cropped cover image: overlays belong in its top-left.
    case 'cover':
    case 'fill':
    default:
      return plainRect(box);
  }

  const tokens = input.objectPosition.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const first = tokens[0] ?? '50%';
  const second = tokens[1] ?? '50%';
  const verticalFirst = first === 'top' || first === 'bottom';
  const xToken = verticalFirst ? second : first;
  const yToken = verticalFirst ? first : second;
  /** @param {string} token @param {number} free */
  const positionOffset = (token, free) => {
    if (token === 'left' || token === 'top') return 0;
    if (token === 'center') return free / 2;
    if (token === 'right' || token === 'bottom') return free;
    if (token.endsWith('%')) {
      const value = Number.parseFloat(token);
      return Number.isFinite(value) ? (free * value) / 100 : free / 2;
    }
    if (token.endsWith('px')) {
      const value = Number.parseFloat(token);
      return Number.isFinite(value) ? value : free / 2;
    }
    return free / 2;
  };

  const rawLeft = box.left + positionOffset(xToken, box.width - width);
  const rawTop = box.top + positionOffset(yToken, box.height - height);
  const left = Math.max(box.left, rawLeft);
  const top = Math.max(box.top, rawTop);
  const right = Math.min(box.right, rawLeft + width);
  const bottom = Math.min(box.bottom, rawTop + height);
  return {
    left,
    top,
    right,
    bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

/**
 * CSS backgrounds have no naturalWidth. Eligibility is the painted box, which
 * is what the user actually sees and what the private web-realistic set will
 * contain (hero tiles, cards, lazy masonry).
 *
 * @param {Object} input
 * @param {string} input.url
 * @param {number} input.displayedWidth
 * @param {number} input.displayedHeight
 * @param {number} input.minEdge
 * @returns {'wait-source' | 'skip' | 'scan'}
 */
export function classifyPaintedCandidate(input) {
  if (!input.url || !/^(https?:|data:)/.test(input.url)) return 'wait-source';
  if (isSvgImageUrl(input.url)) return 'skip';
  if (isInlinePayloadTooLarge(input.url)) return 'skip';
  return Math.min(input.displayedWidth, input.displayedHeight) < input.minEdge ? 'skip' : 'scan';
}

/** @param {string} url */
export function isSvgImageUrl(url) {
  const value = url.trim().toLowerCase();
  return /^data:image\/svg(?:\+xml)?[;,]/.test(value) || /\.svg(?:[?#]|$)/.test(value);
}

/**
 * Extract image URLs from a CSS `background-image` value.
 * Gradients and `none` are ignored. Chrome's computed style usually already
 * absolutizes relative URLs; we still skip empty tokens.
 *
 * @param {string} value
 * @returns {string[]}
 */
export function cssBackgroundUrls(value) {
  if (!value || value === 'none') return [];
  /** @type {string[]} */
  const urls = [];
  const re = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
  for (let match = re.exec(value); match; match = re.exec(value)) {
    const raw = (match[2] ?? '').trim();
    if (!raw) continue;
    // Skip mask-like SVG placeholders; real photos are http(s)/data raster.
    if (isSvgImageUrl(raw)) continue;
    urls.push(raw);
  }
  return urls;
}

/**
 * Tags that never paint a content image as a CSS background. Observing them
 * would multiply IntersectionObserver entries on every page for no coverage.
 *
 * @param {string} tagName
 * @returns {boolean}
 */
export function isBackgroundWatchTag(tagName) {
  switch (tagName) {
    case 'SCRIPT':
    case 'STYLE':
    case 'LINK':
    case 'META':
    case 'HEAD':
    case 'NOSCRIPT':
    case 'BR':
    case 'HR':
    case 'TEMPLATE':
    case 'IFRAME':
    case 'SVG':
    case 'PATH':
    case 'CANVAS':
    case 'VIDEO':
    case 'AUDIO':
    case 'SOURCE':
    case 'TRACK':
    case 'INPUT':
    case 'TEXTAREA':
    case 'SELECT':
    case 'OPTION':
      return false;
    default:
      return true;
  }
}

/**
 * Calling observe() twice is a no-op. Reset first so an intersecting lazy
 * image receives a fresh callback after src/srcset changes.
 * @param {IntersectionObserver} observer
 * @param {Element} image
 */
export function resetImageObservation(observer, image) {
  observer.unobserve(image);
  observer.observe(image);
}

/**
 * Whether a painted box intersects the viewport (no rootMargin). Used to
 * give on-screen images infer-queue priority over prefetch candidates.
 *
 * @param {{top: number, left: number, bottom: number, right: number}} rect
 * @param {{width: number, height: number}} viewport
 * @returns {boolean}
 */
export function isRectInViewport(rect, viewport) {
  return rect.bottom > 0 && rect.right > 0 && rect.top < viewport.height && rect.left < viewport.width;
}

/**
 * Page overlays communicate completed verdicts only. A pending scan is an
 * implementation detail; rendering an ellipsis for every visible candidate
 * covers image-heavy pages in controls and exposes duplicate viewer layers
 * before they can be reconciled.
 *
 * @param {string} phase
 * @param {unknown} probability
 * @param {boolean} [inNestedFrame]
 * @returns {boolean}
 */
export function shouldRenderBadge(phase, probability, inNestedFrame = false) {
  if (phase === 'scored' && typeof probability === 'number' && Number.isFinite(probability)) {
    return true;
  }
  // Top frame already has the corner setup notice. Nested frames do not, and
  // the eval harness often paints images only inside an iframe.
  return Boolean(inNestedFrame) && phase === 'no-model';
}

/**
 * Whether the page element at an overlay anchor belongs to the image being
 * labelled. Overlay UI (the shadow host, the badge itself, the setup notice)
 * is skipped first: those nodes sit on the same viewport point by design, and
 * counting them as "covering" the image would hide the badge on the next
 * reposition. Sticky headers then hide badges naturally when their images
 * scroll behind them.
 *
 * @param {{contains(node: unknown): boolean}} host
 * @param {{contains(node: unknown): boolean}[]} hitStack
 * @param {unknown} overlayHost
 * @param {unknown[]} [overlayNodes]
 * @returns {boolean}
 */
export function isHostTopmostAtPoint(host, hitStack, overlayHost, overlayNodes = []) {
  const skip = new Set(overlayNodes);
  const top = hitStack.find((element) => element !== overlayHost && !skip.has(element));
  return Boolean(top && (top === host || host.contains(top) || top.contains(host)));
}

/**
 * Fraction of the smaller rectangle covered by the intersection.
 * Plain rectangle objects keep this unit-testable without a browser DOM.
 *
 * @param {{left: number, top: number, right: number, bottom: number}} a
 * @param {{left: number, top: number, right: number, bottom: number}} b
 * @returns {number}
 */
export function smallerRectOverlap(a, b) {
  const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const intersection = width * height;
  const areaA = Math.max(0, a.right - a.left) * Math.max(0, a.bottom - a.top);
  const areaB = Math.max(0, b.right - b.left) * Math.max(0, b.bottom - b.top);
  const smaller = Math.min(areaA, areaB);
  return smaller > 0 ? intersection / smaller : 0;
}

/**
 * Whether a pending ellipsis is redundant with a settled badge for the same
 * painted visual area. This catches an <img> and its background/wrapper being
 * tracked separately without suppressing pending badges on adjacent images.
 *
 * @param {{host: {left: number, top: number, right: number, bottom: number}, badge: {left: number, top: number, right: number, bottom: number}}} pending
 * @param {{phase: string, host: {left: number, top: number, right: number, bottom: number}, badge: {left: number, top: number, right: number, bottom: number}}} settled
 * @returns {boolean}
 */
export function shouldSuppressPendingBadge(pending, settled) {
  if (settled.phase !== 'scored' && settled.phase !== 'no-model') return false;
  const badgesCollide = smallerRectOverlap(pending.badge, settled.badge) > 0;
  const sameVisualArea = smallerRectOverlap(pending.host, settled.host) >= 0.8;
  return badgesCollide && sameVisualArea;
}

/**
 * A badge anchored to the image's own top-left corner disappears as soon as
 * that corner scrolls out of view, which for a tall image means losing the
 * label while most of the picture is still on screen. Anchor to the top-left
 * of the image's *visible* intersection instead, so the badge slides along the
 * clipped edge and stays put until the image genuinely leaves.
 *
 * `clip` is the viewport intersected with any scrolling ancestor, so a badge
 * inside a scroll container never escapes it.
 *
 * Regression: candidate.test.js 'badge anchor sticks to the visible edge'.
 *
 * @param {Object} input
 * @param {{left: number, top: number, right: number, bottom: number}} input.rect painted image rect, viewport coords
 * @param {{left: number, top: number, right: number, bottom: number}} input.clip visible region, viewport coords
 * @param {number} input.inset padding from the visible corner, in px
 * @param {number} [input.minVisible] hide below this many visible px on either axis
 * @returns {{x: number, y: number, visible: boolean}}
 */
export function badgeAnchorPoint(input) {
  const { rect, clip, inset } = input;
  const minVisible = input.minVisible ?? 0;
  const left = Math.max(rect.left, clip.left);
  const top = Math.max(rect.top, clip.top);
  const right = Math.min(rect.right, clip.right);
  const bottom = Math.min(rect.bottom, clip.bottom);
  if (!(right - left > minVisible && bottom - top > minVisible)) {
    return { x: 0, y: 0, visible: false };
  }
  // Inset from the visible corner, but never past the far edge: on a sliver
  // thinner than the inset that would place the badge outside the image.
  return { x: Math.min(left + inset, right), y: Math.min(top + inset, bottom), visible: true };
}

/**
 * Layered image viewers often retain a thumbnail, a full-resolution <img>, and
 * a CSS-background fallback for the same visual. Pick one overlay for that
 * painted area. A settled result may also replace a pending overlay even when
 * the viewer gave its layers different URLs.
 *
 * @param {{phase: string, url: string, host: {left: number, top: number, right: number, bottom: number}, badge: {left: number, top: number, right: number, bottom: number}}} candidate
 * @param {{phase: string, url: string, host: {left: number, top: number, right: number, bottom: number}, badge: {left: number, top: number, right: number, bottom: number}}} keeper
 * @returns {boolean}
 */
export function shouldSuppressDuplicateBadge(candidate, keeper) {
  const sameVisualArea = smallerRectOverlap(candidate.host, keeper.host) >= 0.8;
  if (!sameVisualArea) return false;
  // One URL painted in overlapping boxes is one visual even when a letterbox
  // or wrapper offset puts the two overlay anchors at different coordinates.
  if (candidate.url === keeper.url) return true;
  const badgesCollide = smallerRectOverlap(candidate.badge, keeper.badge) > 0;
  // Different URLs are common for a preview thumbnail and its full-resolution
  // replacement. If both occupy the same visual and their labels collide,
  // showing two (possibly different) scores is always worse than keeping the
  // higher-priority overlay selected by the caller.
  return badgesCollide;
}
