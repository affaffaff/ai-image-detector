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
 * Attribute mutations that must reset IntersectionObserver.
 *
 * `<img>` only resets on `src`/`srcset`. class/style hover churn on a search
 * grid would otherwise re-enter considerImage for every tile, on the same
 * main thread the page scrolls on. Background candidates still reset on
 * class/style so a CSS swap that paints `url()` is not missed. `href` never
 * resets; search-thumb upgrades are a separate retry.
 *
 * @param {boolean} isImage
 * @param {string | null} attributeName
 * @returns {boolean}
 */
export function attributeResetsObservation(isImage, attributeName) {
  if (isImage) return attributeName === 'src' || attributeName === 'srcset';
  return attributeName === 'class' || attributeName === 'style';
}

const OVERFLOW_SCROLLS = /(auto|scroll|overlay)/;

/**
 * Whether CSS overflow on an ancestor can scroll (even if it is not
 * overflowing yet). Sticky/fixed preview panes often start `overflow:auto`
 * before their content is taller than the pane.
 *
 * @param {string} overflowX
 * @param {string} overflowY
 * @returns {boolean}
 */
export function overflowCanScroll(overflowX, overflowY) {
  return OVERFLOW_SCROLLS.test(overflowX) || OVERFLOW_SCROLLS.test(overflowY);
}

/**
 * Whether this ancestor should host native overlay wrappers.
 * Sticky/fixed panes with overflow:auto count even before they overflow —
 * waiting for scrollHeight > clientHeight leaves overlays `position:fixed`
 * on the document, which then detach when the pane's own scrollbar moves.
 *
 * @param {{
 *   overflowX: string,
 *   overflowY: string,
 *   scrollWidth: number,
 *   clientWidth: number,
 *   scrollHeight: number,
 *   clientHeight: number,
 *   position: string,
 *   treatAsScroller?: boolean,
 * }} input
 * @returns {boolean}
 */
export function overflowParentIsScroller(input) {
  if (!overflowCanScroll(input.overflowX, input.overflowY)) return false;
  if (input.position === 'fixed' || input.position === 'sticky' || input.treatAsScroller) {
    return true;
  }
  return (
    (OVERFLOW_SCROLLS.test(input.overflowY) && input.scrollHeight > input.clientHeight) ||
    (OVERFLOW_SCROLLS.test(input.overflowX) && input.scrollWidth > input.clientWidth)
  );
}

/**
 * Shrink a clip rectangle by sticky/fixed page chrome that does not contain
 * the image. A header covering the top of the viewport raises `clip.top`; a
 * right-hand preview pane lowers `clip.right`. Full-viewport click catchers
 * and corner widgets are ignored so they cannot eat the whole overlay area.
 *
 * @param {{left: number, top: number, right: number, bottom: number}} clip
 * @param {{left: number, top: number, right: number, bottom: number}} occluder
 * @returns {{left: number, top: number, right: number, bottom: number}}
 */
export function insetClipForOccluder(clip, occluder) {
  const clipW = clip.right - clip.left;
  const clipH = clip.bottom - clip.top;
  if (!(clipW > 0 && clipH > 0)) return clip;
  const overlapW = Math.max(
    0,
    Math.min(clip.right, occluder.right) - Math.max(clip.left, occluder.left),
  );
  const overlapH = Math.max(
    0,
    Math.min(clip.bottom, occluder.bottom) - Math.max(clip.top, occluder.top),
  );
  if (!(overlapW > 0 && overlapH > 0)) return clip;
  if (overlapW >= clipW * 0.95 && overlapH >= clipH * 0.95) return clip;

  const next = { left: clip.left, top: clip.top, right: clip.right, bottom: clip.bottom };
  if (occluder.top <= clip.top + 1 && occluder.bottom < clip.top + clipH * 0.5 && overlapW >= clipW * 0.5) {
    next.top = Math.max(next.top, occluder.bottom);
  }
  if (occluder.bottom >= clip.bottom - 1 && occluder.top > clip.bottom - clipH * 0.5 && overlapW >= clipW * 0.5) {
    next.bottom = Math.min(next.bottom, occluder.top);
  }
  if (occluder.left <= clip.left + 1 && occluder.right < clip.left + clipW * 0.5 && overlapH >= clipH * 0.5) {
    next.left = Math.max(next.left, occluder.right);
  }
  if (occluder.right >= clip.right - 1 && occluder.left >= clip.left + clipW * 0.4 && overlapH >= clipH * 0.5) {
    next.right = Math.min(next.right, occluder.left);
  }
  return next;
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
 * Stable, user-focused order for candidates that are already on screen.
 * Larger visible regions go first, followed by the candidate nearest the
 * viewport centre and finally normal reading order. IntersectionObserver entry
 * order is browser scheduling detail and must not decide which image gets the
 * serialized inference slot first.
 *
 * @param {{top: number, left: number, bottom: number, right: number}} a
 * @param {{top: number, left: number, bottom: number, right: number}} b
 * @param {{width: number, height: number}} viewport
 * @returns {number}
 */
export function compareViewportCandidates(a, b, viewport) {
  /** @param {{top: number, left: number, bottom: number, right: number}} rect */
  const visibleArea = (rect) => {
    const width = Math.max(0, Math.min(rect.right, viewport.width) - Math.max(rect.left, 0));
    const height = Math.max(0, Math.min(rect.bottom, viewport.height) - Math.max(rect.top, 0));
    return width * height;
  };
  const areaDifference = visibleArea(b) - visibleArea(a);
  if (areaDifference !== 0) return areaDifference;

  const viewportX = viewport.width / 2;
  const viewportY = viewport.height / 2;
  /** @param {{top: number, left: number, bottom: number, right: number}} rect */
  const centreDistance = (rect) => {
    const x = (Math.max(rect.left, 0) + Math.min(rect.right, viewport.width)) / 2;
    const y = (Math.max(rect.top, 0) + Math.min(rect.bottom, viewport.height)) / 2;
    return (x - viewportX) ** 2 + (y - viewportY) ** 2;
  };
  return centreDistance(a) - centreDistance(b) || a.top - b.top || a.left - b.left;
}

/**
 * A compact pending badge makes scan progress deterministic and immediate;
 * the same node is updated in place when the verdict arrives. Collision
 * reconciliation removes duplicate viewer layers before paint settles.
 *
 * @param {string} phase
 * @param {unknown} probability
 * @param {boolean} [inNestedFrame]
 * @returns {boolean}
 */
export function shouldRenderBadge(phase, probability, inNestedFrame = false) {
  if (phase === 'pending') return true;
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
 * @param {(element: unknown) => boolean} [isAssociatedOverlay]
 * @returns {boolean}
 */
export function isHostTopmostAtPoint(
  host,
  hitStack,
  overlayHost,
  overlayNodes = [],
  isAssociatedOverlay = () => false,
) {
  const skip = new Set(overlayNodes);
  const top = hitStack.find((element) => element !== overlayHost && !skip.has(element));
  return Boolean(
    top && (top === host || host.contains(top) || top.contains(host) || isAssociatedOverlay(top)),
  );
}

/**
 * Whether an element painted above an image's badge anchor is page-layer UI
 * rather than part of the image's own tile.
 *
 * Badges paint on a layer above the page so tile overlays (covering links,
 * captions, scrims) cannot swallow a finished score. That backfires when the
 * page opens its own layer — a search autocomplete menu, a dialog, a lightbox
 * backdrop: the image is covered but the badge still paints, floating in
 * empty space as if it belonged to the menu. Tile overlays live INSIDE the
 * image's element box (a covering <a> matches it, captions sit within it);
 * page layers spill past it. An occluder that extends beyond the host's
 * border box is not part of the tile, so the badge hides with its image —
 * the badge behaves as if it sat on the same layer as the picture.
 *
 * Compare against the element box, not the painted (object-fit) rect: a
 * letterboxed covering link extends past the painted pixels yet is still the
 * image's own interaction layer.
 *
 * @param {{left: number, top: number, right: number, bottom: number}} hostBox
 * @param {{left: number, top: number, right: number, bottom: number}} occluderBox
 * @param {number} [margin]
 * @returns {boolean}
 */
export function isPageLayerOccluder(hostBox, occluderBox, margin = 4) {
  return (
    occluderBox.left < hostBox.left - margin ||
    occluderBox.top < hostBox.top - margin ||
    occluderBox.right > hostBox.right + margin ||
    occluderBox.bottom > hostBox.bottom + margin
  );
}

/**
 * Hide a badge when viewport chrome or a page layer covers its anchor.
 *
 * The old rule was "hide unless the image itself is the topmost hit". Card
 * captions, gradient scrims, and covering <a> layers fail that test even
 * though they are part of the same picture, so a finished scan never painted
 * its score. Keep the label unless the occluder is `fixed`/`sticky` chrome
 * (headers, cookie banners) or page-layer UI that spills past the image's own
 * box (autocomplete menus, dialogs) — both cover the image while the badge
 * would keep painting one layer above, detached from the hidden picture.
 *
 * @param {boolean} hostIsTopmost
 * @param {string} [occluderPosition]
 * @param {boolean} [pageLayerOccludes]
 * @returns {boolean}
 */
export function shouldHideBadgeForOccluder(
  hostIsTopmost,
  occluderPosition = '',
  pageLayerOccludes = false,
) {
  if (hostIsTopmost) return false;
  if (occluderPosition === 'fixed' || occluderPosition === 'sticky') return true;
  return pageLayerOccludes;
}

/**
 * Whether an element above an image is a local interaction layer for that same
 * painted visual. Social feeds commonly place an empty, absolutely positioned
 * link over the media instead of wrapping the <img> (X/Twitter is one example).
 * A DOM-containment-only hit test mistakes that link for unrelated page chrome
 * and hides an otherwise completed badge.
 *
 * The geometry and ancestry limits distinguish those media links from sticky
 * headers and modal/cookie overlays: the layer must nearly match the image,
 * share a close visual container, and must not be viewport-fixed.
 *
 * @param {Object} input
 * @param {{left: number, top: number, right: number, bottom: number}} input.hostRect
 * @param {{left: number, top: number, right: number, bottom: number}} input.overlayRect
 * @param {number} input.hostAncestorDistance
 * @param {number} input.overlayAncestorDistance
 * @param {string} input.position
 * @returns {boolean}
 */
export function isSameVisualInteractionOverlay(input) {
  if (input.position === 'fixed' || input.position === 'sticky') return false;
  if (input.hostAncestorDistance > 4 || input.overlayAncestorDistance > 2) return false;

  const hostWidth = Math.max(0, input.hostRect.right - input.hostRect.left);
  const hostHeight = Math.max(0, input.hostRect.bottom - input.hostRect.top);
  const overlayWidth = Math.max(0, input.overlayRect.right - input.overlayRect.left);
  const overlayHeight = Math.max(0, input.overlayRect.bottom - input.overlayRect.top);
  const hostArea = hostWidth * hostHeight;
  const overlayArea = overlayWidth * overlayHeight;
  if (!(hostArea > 0 && overlayArea > 0)) return false;

  const intersectionWidth = Math.max(
    0,
    Math.min(input.hostRect.right, input.overlayRect.right) -
      Math.max(input.hostRect.left, input.overlayRect.left),
  );
  const intersectionHeight = Math.max(
    0,
    Math.min(input.hostRect.bottom, input.overlayRect.bottom) -
      Math.max(input.hostRect.top, input.overlayRect.top),
  );
  // Intersection over the larger area rejects narrow toolbars that happen to
  // sit wholly inside a large image (smaller-area overlap would call that 1).
  return (intersectionWidth * intersectionHeight) / Math.max(hostArea, overlayArea) >= 0.85;
}

/**
 * Right-hand image-search viewer (Google Images pane, Bing detail column).
 * Related-strip thumbs in that column are smaller than 160px.
 *
 * @param {{left: number, width: number, height: number}} box
 * @param {number} viewportWidth
 * @returns {boolean}
 */
export function isPreviewPaneBox(box, viewportWidth) {
  return box.left > viewportWidth * 0.45 && Math.min(box.width, box.height) > 160;
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
