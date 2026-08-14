import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyImageCandidate,
  classifyPaintedCandidate,
  compareViewportCandidates,
  cssBackgroundUrls,
  fittedImageRect,
  badgeAnchorPoint,
  isHostTopmostAtPoint,
  isBackgroundWatchTag,
  isPageLayerOccluder,
  isPreviewPaneBox,
  attributeResetsObservation,
  insetClipForOccluder,
  isRectInViewport,
  isSameVisualInteractionOverlay,
  isSvgImageUrl,
  overflowCanScroll,
  overflowParentIsScroller,
  resetImageObservation,
  shouldHideBadgeForOccluder,
  shouldRenderBadge,
  shouldSuppressDuplicateBadge,
  shouldSuppressPendingBadge,
  smallerRectOverlap,
} from '../../src/content/candidate.js';

const base = {
  url: 'https://example.test/image.jpg',
  complete: true,
  naturalWidth: 240,
  naturalHeight: 160,
  displayedWidth: 240,
  displayedHeight: 160,
  minEdge: 64,
};

test('an intersecting lazy image without a source remains retryable', () => {
  assert.equal(classifyImageCandidate({ ...base, url: '' }), 'wait-source');
  assert.equal(
    classifyImageCandidate({ ...base, complete: false, naturalWidth: 0, naturalHeight: 0 }),
    'wait-load',
  );
});

test('on-screen boxes outrank rootMargin prefetch for infer-queue priority', () => {
  const viewport = { width: 1280, height: 720 };
  assert.equal(isRectInViewport({ top: 10, left: 10, bottom: 100, right: 100 }, viewport), true);
  assert.equal(isRectInViewport({ top: 800, left: 10, bottom: 900, right: 100 }, viewport), false);
  assert.equal(isRectInViewport({ top: -80, left: 10, bottom: -10, right: 100 }, viewport), false);
  assert.equal(
    isRectInViewport({ top: 700, left: 10, bottom: 780, right: 100 }, viewport),
    true,
    'a box that still intersects the bottom edge is visible',
  );
});

test('visible candidates are ordered by useful painted area, then viewport focus', () => {
  const viewport = { width: 1000, height: 800 };
  const hero = { top: 100, left: 100, bottom: 700, right: 900 };
  const thumbnail = { top: 10, left: 10, bottom: 110, right: 110 };
  assert.ok(compareViewportCandidates(hero, thumbnail, viewport) < 0);

  const centred = { top: 300, left: 400, bottom: 500, right: 600 };
  const corner = { top: 0, left: 0, bottom: 200, right: 200 };
  assert.ok(compareViewportCandidates(centred, corner, viewport) < 0);
});

test('displayed size can make a tiny thumbnail source eligible', () => {
  assert.equal(
    classifyImageCandidate({ ...base, naturalWidth: 1, naturalHeight: 1 }),
    'scan',
  );
  assert.equal(
    classifyImageCandidate({
      ...base,
      naturalWidth: 40,
      naturalHeight: 40,
      displayedWidth: 40,
      displayedHeight: 40,
    }),
    'skip',
  );
  assert.equal(
    classifyImageCandidate({
      ...base,
      naturalWidth: 512,
      naturalHeight: 512,
      displayedWidth: 32,
      displayedHeight: 32,
    }),
    'skip',
    'a high-resolution favicon is still a tiny painted decoration',
  );
});

test('SVG UI assets are skipped without rejecting rasterized SVG derivatives', () => {
  for (const url of [
    'https://cdn.test/logo.svg',
    'https://cdn.test/logo.svg?width=256',
    'data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C/svg%3E',
  ]) {
    assert.equal(isSvgImageUrl(url), true);
    assert.equal(classifyImageCandidate({ ...base, url }), 'skip');
  }
  assert.equal(isSvgImageUrl('https://cdn.test/logo.svg.png'), false);
  assert.equal(classifyImageCandidate({ ...base, url: 'https://cdn.test/logo.svg.png' }), 'scan');
  assert.equal(
    classifyPaintedCandidate({
      url: 'https://cdn.test/background.svg#hero',
      displayedWidth: 320,
      displayedHeight: 180,
      minEdge: 64,
    }),
    'skip',
  );
});

test('oversized or malformed data URLs are not scanned through extension messaging', () => {
  assert.equal(classifyImageCandidate({ ...base, url: 'data:image/png;base64' }), 'skip');
  assert.equal(
    classifyPaintedCandidate({
      url: 'data:image/png;base64',
      displayedWidth: 320,
      displayedHeight: 180,
      minEdge: 64,
    }),
    'skip',
  );
  assert.equal(classifyImageCandidate({ ...base, url: 'data:image/png;base64,AAAA' }), 'scan');
});

test('object-fit contain reports the painted image instead of its letterbox', () => {
  const box = { left: 100, top: 20, right: 500, bottom: 220, width: 400, height: 200 };
  assert.deepEqual(
    fittedImageRect({
      box,
      naturalWidth: 100,
      naturalHeight: 100,
      objectFit: 'contain',
      objectPosition: '100% 50%',
    }),
    { left: 300, top: 20, right: 500, bottom: 220, width: 200, height: 200 },
  );
  assert.deepEqual(
    fittedImageRect({
      box,
      naturalWidth: 800,
      naturalHeight: 200,
      objectFit: 'cover',
      objectPosition: '50% 50%',
    }),
    box,
  );
});

test('fittedImageRect handles a DOMRect-like box (fields on the prototype, not own props)', () => {
  // Regression: `{ ...box }` on a real DOMRect silently produces `{}` because
  // left/top/right/bottom/width/height are prototype accessors. That sent every
  // badge to the overlay's static position (0,0) instead of onto its image.
  const proto = {};
  /** @type {Array<[string, number]>} */
  const fields = [
    ['left', 100],
    ['top', 20],
    ['right', 500],
    ['bottom', 220],
    ['width', 400],
    ['height', 200],
  ];
  for (const [name, value] of fields) {
    Object.defineProperty(proto, name, { get: () => value });
  }
  const domRectLike = Object.create(proto);

  assert.deepEqual(
    fittedImageRect({
      box: domRectLike,
      naturalWidth: 100,
      naturalHeight: 100,
      objectFit: 'contain',
      objectPosition: '50% 50%',
    }),
    { left: 200, top: 20, right: 400, bottom: 220, width: 200, height: 200 },
  );
  assert.deepEqual(
    fittedImageRect({
      box: domRectLike,
      naturalWidth: 800,
      naturalHeight: 200,
      objectFit: 'cover',
      objectPosition: '50% 50%',
    }),
    { left: 100, top: 20, right: 500, bottom: 220, width: 400, height: 200 },
    'cover must return the full plain box, not an empty object',
  );
});

test('image class churn does not reset intersection observation', () => {
  assert.equal(attributeResetsObservation(true, 'src'), true);
  assert.equal(attributeResetsObservation(true, 'srcset'), true);
  assert.equal(attributeResetsObservation(true, 'class'), false);
  assert.equal(attributeResetsObservation(true, 'style'), false);
  assert.equal(attributeResetsObservation(true, 'href'), false);
  assert.equal(attributeResetsObservation(false, 'class'), true);
  assert.equal(attributeResetsObservation(false, 'style'), true);
  assert.equal(attributeResetsObservation(false, 'href'), false);
  assert.equal(attributeResetsObservation(false, 'src'), false);
});

test('sticky/fixed overflow:auto panes host overlays before they overflow', () => {
  const auto = {
    overflowX: 'visible',
    overflowY: 'auto',
    scrollWidth: 400,
    clientWidth: 400,
    scrollHeight: 400,
    clientHeight: 400,
    position: 'static',
  };
  assert.equal(overflowCanScroll('visible', 'auto'), true);
  assert.equal(overflowCanScroll('visible', 'visible'), false);
  assert.equal(overflowParentIsScroller(auto), false);
  assert.equal(overflowParentIsScroller({ ...auto, position: 'fixed' }), true);
  assert.equal(overflowParentIsScroller({ ...auto, position: 'sticky' }), true);
  assert.equal(overflowParentIsScroller({ ...auto, treatAsScroller: true }), true);
  assert.equal(
    overflowParentIsScroller({ ...auto, scrollHeight: 900 }),
    true,
    'an overflowing static scroller still hosts',
  );
  assert.equal(
    overflowParentIsScroller({ ...auto, overflowY: 'visible', overflowX: 'overlay', scrollWidth: 900 }),
    true,
  );
});

test('sticky headers and side preview panes inset the overlay clip', () => {
  const viewport = { left: 0, top: 0, right: 1200, bottom: 800 };
  assert.deepEqual(
    insetClipForOccluder(viewport, { left: 0, top: 0, right: 1200, bottom: 72 }),
    { left: 0, top: 72, right: 1200, bottom: 800 },
  );
  assert.deepEqual(
    insetClipForOccluder(viewport, { left: 720, top: 0, right: 1200, bottom: 800 }),
    { left: 0, top: 0, right: 720, bottom: 800 },
  );
  assert.deepEqual(
    insetClipForOccluder(viewport, { left: 0, top: 0, right: 1200, bottom: 800 }),
    viewport,
    'a full-viewport click catcher is not chrome',
  );
  assert.deepEqual(
    insetClipForOccluder(viewport, { left: 1160, top: 8, right: 1192, bottom: 40 }),
    viewport,
    'a corner widget does not raise the clip',
  );
  const belowHeader = insetClipForOccluder(viewport, { left: 0, top: 0, right: 1200, bottom: 72 });
  assert.deepEqual(
    insetClipForOccluder(belowHeader, { left: 720, top: 0, right: 1200, bottom: 800 }),
    { left: 0, top: 72, right: 720, bottom: 800 },
  );
});

test('a source mutation resets observation even when no scan state exists yet', () => {
  /** @type {Array<['unobserve' | 'observe', Element]>} */
  const calls = [];
  const image = /** @type {HTMLImageElement} */ (/** @type {unknown} */ ({}));
  const observer = /** @type {IntersectionObserver} */ (
    /** @type {unknown} */ ({
      /** @param {Element} target */
      unobserve(target) {
        calls.push(['unobserve', target]);
      },
      /** @param {Element} target */
      observe(target) {
        calls.push(['observe', target]);
      },
    })
  );

  resetImageObservation(observer, image);
  assert.deepEqual(calls, [
    ['unobserve', image],
    ['observe', image],
  ]);
});

test('image overlays show progress immediately and accept only finite completed scores', () => {
  assert.equal(shouldRenderBadge('pending', undefined), true);
  assert.equal(shouldRenderBadge('pending', 0.8), true);
  assert.equal(shouldRenderBadge('unscannable', undefined), false);
  assert.equal(shouldRenderBadge('no-model', undefined), false);
  assert.equal(shouldRenderBadge('no-model', undefined, true), true);
  assert.equal(shouldRenderBadge('scored', undefined), false);
  assert.equal(shouldRenderBadge('scored', Number.NaN), false);
  assert.equal(shouldRenderBadge('scored', 0), true);
  assert.equal(shouldRenderBadge('scored', 1), true);
});

test('a sticky page header hides the badge once it covers the image anchor', () => {
  const host = {
    /** @param {unknown} node */
    contains(node) {
      return node === imageChild;
    },
  };
  const imageChild = {
    /** @param {unknown} _node */
    contains(_node) {
      return false;
    },
  };
  const wrapper = {
    /** @param {unknown} node */
    contains(node) {
      return node === host;
    },
  };
  const stickyHeader = { contains: () => false };
  const overlayHost = { contains: () => false };

  assert.equal(isHostTopmostAtPoint(host, [overlayHost, imageChild, host], overlayHost), true);
  assert.equal(isHostTopmostAtPoint(host, [overlayHost, wrapper, host], overlayHost), true);
  assert.equal(
    isHostTopmostAtPoint(host, [overlayHost, stickyHeader, host], overlayHost),
    false,
  );

  const badge = { contains: () => false };
  assert.equal(
    isHostTopmostAtPoint(host, [badge, overlayHost, imageChild], overlayHost, [badge]),
    true,
    'a visible badge on the anchor must not hide itself on the next reposition',
  );

  assert.equal(
    isHostTopmostAtPoint(host, [overlayHost, stickyHeader, host], overlayHost, [], (element) =>
      element === stickyHeader,
    ),
    true,
    'the caller can admit a verified same-visual interaction layer',
  );
});

test('chrome or page layers hide a badge that is not on the image', () => {
  assert.equal(shouldHideBadgeForOccluder(true, 'fixed'), false);
  assert.equal(shouldHideBadgeForOccluder(true, 'sticky'), false);
  assert.equal(shouldHideBadgeForOccluder(true, 'absolute', true), false);
  assert.equal(shouldHideBadgeForOccluder(false, 'fixed'), true);
  assert.equal(shouldHideBadgeForOccluder(false, 'sticky'), true);
  assert.equal(
    shouldHideBadgeForOccluder(false, 'absolute'),
    false,
    'a covering media link must not swallow a finished score',
  );
  assert.equal(
    shouldHideBadgeForOccluder(false, 'absolute', true),
    true,
    'an autocomplete menu or dialog covering the image hides its badge too',
  );
  assert.equal(
    shouldHideBadgeForOccluder(false, 'absolute', false),
    false,
    'tile overlays inside the image box keep the badge',
  );
  assert.equal(shouldHideBadgeForOccluder(false, 'relative'), false);
  assert.equal(shouldHideBadgeForOccluder(false, 'static'), false);
  assert.equal(shouldHideBadgeForOccluder(false, ''), false);
});

test('isPageLayerOccluder only flags UI that spills past the image box', () => {
  const hostBox = { left: 100, top: 100, right: 300, bottom: 250 };
  assert.equal(
    isPageLayerOccluder(hostBox, { left: 40, top: 30, right: 560, bottom: 400 }),
    true,
    'an autocomplete menu blanketing the tile is page-layer UI',
  );
  assert.equal(
    isPageLayerOccluder(hostBox, { left: 100, top: 100, right: 300, bottom: 250 }),
    false,
    'a covering link matching the image box is the tile itself',
  );
  assert.equal(
    isPageLayerOccluder(hostBox, { left: 100, top: 210, right: 300, bottom: 250 }),
    false,
    'a caption strip inside the image box is the tile itself',
  );
  assert.equal(
    isPageLayerOccluder(hostBox, { left: 97, top: 100, right: 303, bottom: 250 }),
    false,
    'border-width overshoot within the margin is still the tile',
  );
  assert.equal(
    isPageLayerOccluder(hostBox, { left: 100, top: 100, right: 300, bottom: 260 }),
    true,
    'anything clearly spilling past the image is page-layer UI',
  );
});

test('cssBackgroundUrls extracts quoted, unquoted, and stacked urls', () => {
  assert.deepEqual(cssBackgroundUrls('none'), []);
  assert.deepEqual(cssBackgroundUrls('linear-gradient(red, blue)'), []);
  assert.deepEqual(cssBackgroundUrls('url("https://cdn.test/hero.jpg")'), [
    'https://cdn.test/hero.jpg',
  ]);
  assert.deepEqual(cssBackgroundUrls("url('https://cdn.test/a.jpg'), url(https://cdn.test/b.jpg)"), [
    'https://cdn.test/a.jpg',
    'https://cdn.test/b.jpg',
  ]);
  assert.deepEqual(cssBackgroundUrls('url("data:image/svg+xml;utf8,<svg></svg>")'), []);
  assert.deepEqual(cssBackgroundUrls('url("https://cdn.test/decoration.svg?v=2")'), []);
});

test('painted CSS boxes use displayed size only', () => {
  assert.equal(
    classifyPaintedCandidate({
      url: 'https://cdn.test/hero.jpg',
      displayedWidth: 320,
      displayedHeight: 180,
      minEdge: 64,
    }),
    'scan',
  );
  assert.equal(
    classifyPaintedCandidate({
      url: 'https://cdn.test/icon.jpg',
      displayedWidth: 24,
      displayedHeight: 24,
      minEdge: 64,
    }),
    'skip',
  );
  assert.equal(
    classifyPaintedCandidate({ url: '', displayedWidth: 400, displayedHeight: 400, minEdge: 64 }),
    'wait-source',
  );
});

test('structural tags are not watched as CSS-background candidates', () => {
  assert.equal(isBackgroundWatchTag('DIV'), true);
  assert.equal(isBackgroundWatchTag('SECTION'), true);
  assert.equal(isBackgroundWatchTag('SCRIPT'), false);
  assert.equal(isBackgroundWatchTag('IFRAME'), false);
});

test('rectangle overlap is measured against the smaller painted area', () => {
  const full = { left: 0, top: 0, right: 100, bottom: 100 };
  const inset = { left: 10, top: 10, right: 90, bottom: 90 };
  const adjacent = { left: 100, top: 0, right: 200, bottom: 100 };
  assert.equal(smallerRectOverlap(full, inset), 1);
  assert.equal(smallerRectOverlap(full, adjacent), 0);
});

test('the right-hand viewer is a large box past mid-page, not a related-strip thumb', () => {
  assert.equal(isPreviewPaneBox({ left: 900, width: 420, height: 280 }, 1200), true);
  assert.equal(isPreviewPaneBox({ left: 80, width: 420, height: 280 }, 1200), false);
  assert.equal(isPreviewPaneBox({ left: 900, width: 80, height: 80 }, 1200), false);
});

test('a settled verdict suppresses only a colliding pending badge on the same visual', () => {
  const visual = { left: 20, top: 50, right: 760, bottom: 541 };
  const badge = { left: 24, top: 54, right: 70, bottom: 72 };
  const pending = { host: visual, badge };
  assert.equal(
    shouldSuppressPendingBadge(pending, { phase: 'scored', host: visual, badge }),
    true,
  );
  assert.equal(
    shouldSuppressPendingBadge(pending, {
      phase: 'pending',
      host: visual,
      badge,
    }),
    false,
    'one pending candidate must not hide another before a verdict exists',
  );
  assert.equal(
    shouldSuppressPendingBadge(pending, {
      phase: 'scored',
      host: { left: 760, top: 50, right: 900, bottom: 541 },
      badge: { left: 760, top: 54, right: 810, bottom: 72 },
    }),
    false,
    'adjacent images keep independent badges',
  );
});

test('layered copies of one visual keep only the preferred badge', () => {
  const visual = { left: 20, top: 50, right: 760, bottom: 541 };
  const badge = { left: 24, top: 54, right: 70, bottom: 72 };
  assert.equal(
    shouldSuppressDuplicateBadge(
      {
        phase: 'scored',
        url: 'https://cdn.test/a.jpg',
        host: visual,
        badge: { left: 100, top: 100, right: 150, bottom: 120 },
      },
      { phase: 'scored', url: 'https://cdn.test/a.jpg', host: visual, badge },
    ),
    true,
    'the same URL is deduplicated even when a letterbox offsets one anchor',
  );
  assert.equal(
    shouldSuppressDuplicateBadge(
      { phase: 'scored', url: 'https://cdn.test/thumbnail.jpg', host: visual, badge },
      { phase: 'scored', url: 'https://cdn.test/full.jpg', host: visual, badge },
    ),
    true,
    'a full-size layer replaces its scored thumbnail layer',
  );
  assert.equal(
    shouldSuppressDuplicateBadge(
      {
        phase: 'scored',
        url: 'https://cdn.test/left.jpg',
        host: { left: 0, top: 0, right: 100, bottom: 100 },
        badge,
      },
      {
        phase: 'scored',
        url: 'https://cdn.test/right.jpg',
        host: { left: 100, top: 0, right: 200, bottom: 100 },
        badge,
      },
    ),
    false,
    'adjacent tiles remain independent even if their labels touch',
  );
});

const viewport = { left: 0, top: 0, right: 1000, bottom: 800 };

test('badge anchor sticks to the visible edge', () => {
  // Fully visible: plain inset from the image's own corner.
  assert.deepEqual(
    badgeAnchorPoint({ rect: { left: 100, top: 200, right: 400, bottom: 600 }, clip: viewport, inset: 4 }),
    { x: 104, y: 204, visible: true },
  );

  // Scrolled so the top of a tall image is above the viewport: the badge rides
  // the clipped edge instead of vanishing with the corner. This is the bug.
  assert.deepEqual(
    badgeAnchorPoint({ rect: { left: 100, top: -500, right: 400, bottom: 600 }, clip: viewport, inset: 4 }),
    { x: 104, y: 4, visible: true },
  );

  // Same on the horizontal axis for a wide image scrolled left.
  assert.deepEqual(
    badgeAnchorPoint({ rect: { left: -300, top: 200, right: 400, bottom: 600 }, clip: viewport, inset: 4 }),
    { x: 4, y: 204, visible: true },
  );
});

test('same-visual interaction overlays do not hide social-feed image badges', () => {
  const image = { left: 180.5, top: 200, right: 696.5, bottom: 543.734375 };
  const mediaLink = { left: 180.5, top: 200, right: 696.5, bottom: 543.328125 };
  assert.equal(
    isSameVisualInteractionOverlay({
      hostRect: image,
      overlayRect: mediaLink,
      hostAncestorDistance: 3,
      overlayAncestorDistance: 1,
      position: 'absolute',
    }),
    true,
    'an X-style sibling link matching the image is part of the same visual',
  );
  assert.equal(
    isSameVisualInteractionOverlay({
      hostRect: image,
      overlayRect: mediaLink,
      hostAncestorDistance: 3,
      overlayAncestorDistance: 1,
      position: 'fixed',
    }),
    false,
    'viewport-fixed UI remains an occluder',
  );
  assert.equal(
    isSameVisualInteractionOverlay({
      hostRect: image,
      overlayRect: mediaLink,
      hostAncestorDistance: 3,
      overlayAncestorDistance: 1,
      position: 'sticky',
    }),
    false,
    'sticky page UI remains an occluder',
  );
  assert.equal(
    isSameVisualInteractionOverlay({
      hostRect: image,
      overlayRect: { left: 180.5, top: 200, right: 696.5, bottom: 250 },
      hostAncestorDistance: 3,
      overlayAncestorDistance: 1,
      position: 'absolute',
    }),
    false,
    'a narrow toolbar inside the image is not treated as a full-media link',
  );
  assert.equal(
    isSameVisualInteractionOverlay({
      hostRect: image,
      overlayRect: mediaLink,
      hostAncestorDistance: 8,
      overlayAncestorDistance: 2,
      position: 'absolute',
    }),
    false,
    'a matching rectangle elsewhere in the page tree is unrelated',
  );
  assert.equal(
    isSameVisualInteractionOverlay({
      hostRect: image,
      overlayRect: { left: 180.5, top: 200, right: 180.5, bottom: 543.328125 },
      hostAncestorDistance: 3,
      overlayAncestorDistance: 1,
      position: 'absolute',
    }),
    false,
    'a zero-area element cannot represent the painted visual',
  );
});

test('badge anchor is clamped by a scrolling ancestor, not just the viewport', () => {
  const clip = { left: 50, top: 100, right: 500, bottom: 400 };
  // Image starts above its scroll container: clamp to the container, so the
  // badge cannot be drawn outside the scroller it belongs to.
  assert.deepEqual(
    badgeAnchorPoint({ rect: { left: 60, top: -200, right: 400, bottom: 300 }, clip, inset: 4 }),
    { x: 64, y: 104, visible: true },
  );
});

test('badge anchor hides an image that has genuinely left the visible region', () => {
  // Entirely above the viewport.
  assert.equal(
    badgeAnchorPoint({ rect: { left: 100, top: -900, right: 400, bottom: -100 }, clip: viewport, inset: 4 }).visible,
    false,
  );
  // Touching edge-on is not visible either (zero-area intersection).
  assert.equal(
    badgeAnchorPoint({ rect: { left: 100, top: -400, right: 400, bottom: 0 }, clip: viewport, inset: 4 }).visible,
    false,
  );
  // A sliver thinner than minVisible is suppressed rather than flickering.
  assert.equal(
    badgeAnchorPoint({
      rect: { left: 100, top: -400, right: 400, bottom: 10 },
      clip: viewport,
      inset: 4,
      minVisible: 24,
    }).visible,
    false,
  );
});

test('badge anchor never lands outside a sliver thinner than its inset', () => {
  // 2px of image visible at the bottom edge: a blind +4 would place the badge
  // past the image; the anchor stops at the far edge instead.
  const anchor = badgeAnchorPoint({
    rect: { left: 100, top: -400, right: 400, bottom: 2 },
    clip: viewport,
    inset: 4,
  });
  assert.deepEqual(anchor, { x: 104, y: 2, visible: true });
});
