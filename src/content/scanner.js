/**
 * Content-script scanner: finds candidate images, requests verdicts, renders
 * score badges. Runs in every frame (all_frames: true — iframes are covered;
 * an evaluation harness that renders images inside a frame still gets scanned).
 *
 * Pixel access happens elsewhere: cross-origin canvas is tainted, so the
 * offscreen document fetches bytes itself. This script only observes the DOM.
 *
 * Engineering notes for common browser-scanning failure modes:
 *  - Viewport prioritization is real: scans are requested from the
 *    IntersectionObserver callback only. There is no "querySelectorAll and
 *    queue everything" path that defeats it.
 *  - Per-element state lives in a WeakMap; removed images are swept and their
 *    badges removed — no unbounded growth on infinite-scroll pages.
 *  - Badges live in a closed shadow root so page CSS cannot restyle them.
 *    Modern Chromium anchors them to image elements in the compositor; older
 *    versions fall back to viewport coordinates and capture-phase scrolls.
 *    Scroll/mutation handlers do not hit-test every badge on the page main
 *    thread — clip offsets update only when needed, and occlusion waits for
 *    idle. Hidden tabs do not start new scans (they would occupy the shared
 *    fetch pipeline).
 *  - The scan port reconnects and re-requests pending images when the MV3
 *    service worker dies mid-scan.
 */

import { MSG, PORT_SCAN, TARGET } from '../shared/messages.js';
import {
  MIN_IMAGE_EDGE,
  VIEWPORT_MARGIN,
  ENABLED_FLAG,
  BLUR_AI_FLAG,
  BLUR_AI_DEFAULT,
  DEV_BUILD,
  URL_CACHE_MAX,
  SCAN_PRIORITY_NEAR,
  SCAN_PRIORITY_VISIBLE,
  UPGRADE_PROBE_LIMIT,
  UPGRADE_PROBE_TIMEOUT_MS,
  UPGRADE_PROBE_CONCURRENCY,
  UPGRADE_ASPECT_TOLERANCE,
  enabledFromStorage,
  blurFromStorage,
  readStoredFlag,
} from '../shared/constants.js';
// The upgrade gate is exactly the preprocessing resize target — one number, so
// it is imported from where preprocessing declares it rather than copied.
import { OFFICIAL_RESIZE_SHORT_EDGE } from '../offscreen/preprocess.js';
import {
  imageResourceKey,
  imageUrlFromQuery,
  isSearchThumbnail,
  upgradeCandidates,
} from './source-upgrade.js';
import { MAX_INLINE_SCAN_BYTES } from '../shared/inline-payload.js';
import {
  badgeAnchorPoint,
  classifyImageCandidate,
  classifyPaintedCandidate,
  compareViewportCandidates,
  cssBackgroundUrls,
  fittedImageRect,
  isHostTopmostAtPoint,
  isBackgroundWatchTag,
  isPageLayerOccluder,
  isRectInViewport,
  isPreviewPaneBox,
  isSameVisualInteractionOverlay,
  resetImageObservation,
  attributeResetsObservation,
  insetClipForOccluder,
  overflowCanScroll,
  overflowParentIsScroller,
  shouldHideBadgeForOccluder,
  shouldRenderBadge,
  shouldSuppressDuplicateBadge,
  smallerRectOverlap,
} from './candidate.js';
import { UrlRegistry } from './url-registry.js';
import { ModelGate } from './model-gate.js';
import { AI_BLUR_MS, AI_BLUR_PX, blurCoverScale } from './blur-cover.js';
import {
  OVERLAY_HIDE_STYLE_ID,
  clearOverlayHide,
  hideOverlayNodeInline,
  hideOverlayNodes,
  isOverlayNode,
  markOverlayNode,
  removeOverlayNodes,
} from './overlay-nodes.js';

/** @typedef {import('../shared/messages.js').ScanUpdate} ScanUpdate */

/**
 * @typedef {Object} ImgState
 * @property {string} id
 * @property {string} url
 * @property {'pending' | 'scored' | 'unscannable' | 'no-model' | 'skipped'} phase
 * @property {HTMLElement | null} badge
 * @property {ScanUpdate | null} update
 * @property {number} epoch
 * @property {number} priority
 * @property {boolean} [holdScan] - pending badge only; a better source or blob
 *   payload is still being resolved, so inference must not start yet
 * @property {boolean} [blurRevealed] - user clicked this AI image to unblur it
 * @property {boolean} [blurForced] - user chose Blur on this image from the badge
 * @property {HTMLButtonElement | null} [unblurVeil]
 * @property {boolean} [overlayParked] - host is far off screen; the native
 *   anchor wrapper keeps its badge glued to the image without any JS, so the
 *   per-scroll-frame pass skips it until it nears the viewport again
 * @property {boolean} [badgeOccluded] - fallback path only: last hit test found
 *   page UI (chrome or a page layer) covering the badge anchor; deferred scroll
 *   repositions keep the badge hidden until the next real hit test clears it
 *   the badge hidden until the next real hit test clears it
 */

/**
 * @typedef {Object} RenderedBadge
 * @property {string} id
 * @property {string} phase
 * @property {string} url
 * @property {boolean} isImage
 * @property {{left: number, top: number, right: number, bottom: number}} host
 * @property {{left: number, top: number, right: number, bottom: number}} badge
 * @property {HTMLElement} element
 */

let seq = 0;
const pageId = Math.random().toString(36).slice(2, 8);
/** Bumped on teardown and on model-ready so already-seen images are eligible again. */
let epoch = 0;

/** @type {WeakMap<HTMLElement, ImgState>} */
const states = new WeakMap();
/** @type {Map<string, HTMLElement>} */
const byId = new Map();
/** Bounded per-URL result cache + in-flight bookkeeping. See url-registry.js. */
const registry = new UrlRegistry(URL_CACHE_MAX);
/** @type {WeakSet<HTMLImageElement>} */
const waitingForLoad = new WeakSet();
/** @type {WeakMap<HTMLImageElement, {src: string, dataUrl: string}>} */
const blobResolved = new WeakMap();
/** @type {WeakSet<HTMLImageElement>} */
const blobInFlight = new WeakSet();
/**
 * Resolved larger-source lookup, keyed by the src it was resolved for so a
 * later src change re-resolves. `url: null` records "checked, nothing better",
 * which is the common case and must not be re-probed on every pass. `note`
 * carries why an upgrade did not happen, so the popover can say what was
 * actually scored instead of leaving a surprising verdict unexplained.
 * @type {WeakMap<HTMLImageElement, {src: string, url: string | null, note?: string | null}>}
 */
const upgradeResolved = new WeakMap();
/** @type {WeakSet<HTMLImageElement>} */
const upgradeInFlight = new WeakSet();
/**
 * Search-engine thumbnails waiting for the page to name the original
 * (`imgres?imgurl=`). They are not in `byId` yet — scoring the re-encode is
 * what made a Google Images tile badge AI while the preview of the same file
 * did not.
 * @type {Set<HTMLImageElement>}
 */
const waitingForOrigin = new Set();
/**
 * Intersection targets seen while the tab was hidden. Hidden tabs must not
 * start scans — they would occupy the shared fetch pipeline — but they stay
 * observed so becoming visible can drain this set.
 * @type {Set<Element>}
 */
const deferredWhileHidden = new Set();
/** @type {WeakSet<HTMLImageElement>} */
const searchThumbFallbackDue = new WeakSet();
/** @type {WeakMap<HTMLImageElement, ReturnType<typeof setTimeout>>} */
const searchThumbFallbackTimer = new WeakMap();

/** Last search-thumbnail the user pointed at, so a later preview original can land on that tile. */
/** @type {HTMLImageElement | null} */
let lastActivatedThumb = null;
/**
 * The file the right-hand viewer is showing. Grid tiles that name the same
 * picture (or the tile that opened the viewer) are forced onto this URL so
 * both badges are one scan job.
 * @type {{ url: string, keys: Set<string> } | null}
 */
let viewerOriginal = null;

/** False until chrome.storage answers, so a new tab cannot scan before it knows Detection is off. */
let enabled = false;
/** Set when a live ENABLED_SETTING / storage change arrives, so a stale initial get cannot turn it back on. */
let receivedLiveEnabled = false;
/** Cosmetic: blur images already scored as AI. Off until the popup toggle. */
let blurAiImages = BLUR_AI_DEFAULT;
/** Set when a live BLUR_SETTING / storage change arrives, so a stale initial get cannot turn blur back off. */
let receivedLiveBlur = false;
let started = false;
let contextInvalidated = false;
let waitingForDocumentRoot = false;
const modelGate = new ModelGate();
/** Coalesces MODEL_READY + scored-exit so a double delivery does not bump epoch twice. */
let rescanQueued = false;
/** URLs already retried after a stale no-model while the model is proven usable. */
const staleNoModelRetried = new Set();

// Queue priority is shared by every tab/frame through the offscreen document.
// Wall-clock recency therefore matters: a newly visible image in the active
// tab must outrank work that was visible in a different tab several seconds
// ago. The local monotonic guard also distinguishes multiple callbacks in the
// same millisecond.
let lastVisiblePriorityBase = 0;

function nextVisiblePriorityBase() {
  lastVisiblePriorityBase = Math.max(Date.now(), lastVisiblePriorityBase + 1);
  return SCAN_PRIORITY_VISIBLE + lastVisiblePriorityBase;
}

/** @param {HTMLElement} el */
function currentScanPriority(el) {
  if (document.visibilityState === 'hidden') return SCAN_PRIORITY_NEAR;
  const rect = el.getBoundingClientRect();
  return isRectInViewport(rect, { width: window.innerWidth, height: window.innerHeight })
    ? nextVisiblePriorityBase() + 0.5
    : SCAN_PRIORITY_NEAR;
}

// ---------------------------------------------------------------------------
// Badge overlay (closed shadow root; page CSS cannot reach in)

/** @type {ShadowRoot | null} */
let overlayRoot = null;
// Anchor-positioned badges move with their images in Chromium's compositor,
// avoiding the one-frame hitch caused by fixed coordinates updated from a
// scroll listener. Chrome 116-124 retain the proven viewport-coordinate path.
const nativeAnchorPositioning =
  typeof CSS !== 'undefined' &&
  CSS.supports('anchor-name: --aid-anchor') &&
  CSS.supports('position-anchor: --aid-anchor') &&
  CSS.supports('left: anchor(left)');
const nativeAnchorFill =
  nativeAnchorPositioning &&
  typeof CSS !== 'undefined' &&
  CSS.supports('right: anchor(right)') &&
  CSS.supports('bottom: anchor(bottom)');
let nativeAnchorSeq = 0;
/**
 * CSS anchor positioning is tree-scoped: a wrapper appended to the document
 * (or a light-DOM scroll container) can never resolve an `anchor-name` set on
 * an element inside a shadow tree, so badges/veils for shadow-hosted images
 * would resolve `anchor()` to nothing and paint at the wrapper's static flow
 * position — top-left of the page, detached from the image. The viewport
 * fallback positions from `getBoundingClientRect()`, which crosses shadow
 * boundaries, so use it there. `getRootNode() !== document` is the shadow
 * check; it avoids referencing the `ShadowRoot` global (missing in test shims).
 * @param {HTMLElement} host
 */
function nativeAnchorWorksFor(host) {
  return nativeAnchorPositioning && host.getRootNode() === document;
}
/**
 * One compositor-tracked `anchor-name` per image. Badges and Show veils share
 * it so enabling blur does not rewrite the name the badge is already bound to.
 * @type {WeakMap<HTMLElement, {
 *   name: string,
 *   assignedAnchorNames: string,
 *   previousInlineAnchorNames: string,
 *   previousInlinePriority: string,
 *   refs: number,
 * }>}
 */
const hostAnchorNames = new WeakMap();
/**
 * Native anchor positioning lets Chromium move a badge in the same compositor
 * pass as its image. The wrapper is the image's next light-DOM sibling — same
 * stacking context as the picture, so page UI layers and scroller clipping
 * treat badge and image identically; the visible badge stays inside a closed
 * shadow so page CSS cannot restyle it.
 * @type {WeakMap<HTMLElement, {
 *   wrapper: HTMLElement,
 *   host: HTMLElement,
 *   anchorName: string,
 * }>}
 */
const nativeBadgeBindings = new WeakMap();
/**
 * Show veils cover the whole image, so they cannot live in the badge wrapper.
 * Same sibling-mounted compositor binding as badges.
 * @type {WeakMap<HTMLElement, {
 *   wrapper: HTMLElement,
 *   host: HTMLElement,
 *   anchorName: string,
 * }>}
 */
const nativeVeilBindings = new WeakMap();
/**
 * First-frame / scored badge placement retries. Native wrappers often fail
 * elementsFromPoint before layout; two animation frames recover without
 * waiting for a scroll. A verdict resets this so pending misses cannot
 * leave a finished score at display:none.
 * @type {WeakMap<HTMLElement, number>}
 */
const badgePlacementRetries = new WeakMap();

const overlayStyles = `
  .badge {
    position: fixed;
    font: 700 10px/1.7 ui-monospace, Consolas, "Cascadia Mono", monospace;
    color: #eaffff;
    letter-spacing: .4px;
    padding: 0 7px;
    border-radius: 3px;
    border: 1px solid transparent;
    pointer-events: auto;
    cursor: default;
    white-space: nowrap;
    user-select: none;
  }
  .badge::before {
    content: "";
    position: absolute;
    top: 1px; left: 1px;
    width: 4px; height: 4px;
    border-top: 1px solid currentColor;
    border-left: 1px solid currentColor;
    opacity: .85;
    pointer-events: none;
  }
  .ai {
    background: rgba(30,4,18,.88);
    color: #ff4d8d;
    border-color: rgba(255,45,120,.85);
    box-shadow: 0 0 10px rgba(255,45,120,.45), inset 0 0 6px rgba(255,45,120,.18);
  }
  .real {
    background: rgba(2,16,14,.88);
    color: #00ff9f;
    border-color: rgba(0,255,159,.7);
    box-shadow: 0 0 8px rgba(0,255,159,.35), inset 0 0 6px rgba(0,255,159,.14);
  }
  .mock {
    background: rgba(4,7,15,.88);
    color: #00f0ff;
    border-color: rgba(0,240,255,.6);
    box-shadow: 0 0 8px rgba(0,240,255,.25);
  }
  .pending {
    background: rgba(4,7,15,.82);
    color: #8feaf2;
    border-color: rgba(143,234,242,.48);
    box-shadow: 0 0 7px rgba(0,240,255,.18);
    opacity: .82;
  }
  .setup {
    background: rgba(18,12,2,.88);
    color: #ffd257;
    border-color: rgba(251,191,36,.75);
    box-shadow: 0 0 8px rgba(251,191,36,.35);
  }
  .setup-notice {
    position: fixed;
    right: 14px;
    bottom: 14px;
    max-width: min(280px, calc(100vw - 28px));
    box-sizing: border-box;
    background: rgba(18,12,2,.94);
    color: #ffd257;
    font: 700 11px/1.45 ui-monospace, Consolas, "Cascadia Mono", monospace;
    letter-spacing: .25px;
    padding: 8px 11px;
    border: 1px solid rgba(251,191,36,.7);
    border-radius: 4px;
    box-shadow: 0 4px 18px rgba(0,0,0,.38), 0 0 8px rgba(251,191,36,.2);
    pointer-events: none;
  }
  .badge.scored { cursor: pointer; }
  /* Provisional: this number came from the rendered thumbnail and a
     full-resolution re-scan is in flight. */
  .badge.restating { opacity: .55; }
  .popover {
    position: fixed;
    min-width: 200px;
    max-width: 280px;
    background: rgba(5,9,20,.97);
    color: #c8d4f0;
    font: 11px/1.55 ui-monospace, Consolas, "Cascadia Mono", monospace;
    padding: 10px 12px;
    border-radius: 3px;
    border: 1px solid rgba(0,240,255,.45);
    box-shadow: 0 0 18px rgba(0,240,255,.22), 0 4px 18px rgba(0,0,0,.55);
    pointer-events: auto;
    z-index: 1;
  }
  .popover > div:first-child {
    color: #00f0ff;
    font-weight: 700;
    font-size: 13px;
    letter-spacing: .5px;
    text-shadow: 0 0 8px rgba(0,240,255,.6);
    margin-bottom: 2px;
  }
  .popover .k { color: #5b6b8c; letter-spacing: .3px; }
  .popover .bits { color: #00f0ff; font-variant-numeric: tabular-nums; }
  .popover .blur-toggle {
    display: block;
    width: 100%;
    margin-top: 8px;
    padding: 6px 8px;
    border: 1px solid rgba(255,45,120,.75);
    border-radius: 2px;
    background: rgba(255,45,120,.12);
    color: #ffd0e2;
    font: 700 10px/1.2 ui-monospace, Consolas, "Cascadia Mono", monospace;
    letter-spacing: 1.1px;
    text-transform: uppercase;
    cursor: pointer;
  }
  .popover .blur-toggle:hover { background: rgba(255,45,120,.22); }
  .popover .blur-toggle.show {
    border-color: rgba(0,240,255,.55);
    background: rgba(0,240,255,.1);
    color: #c8f7ff;
  }
  .popover .blur-toggle.show:hover { background: rgba(0,240,255,.18); }
  .blur-veil {
    position: fixed;
    display: flex;
    align-items: center;
    justify-content: center;
    appearance: none;
    -webkit-appearance: none;
    border: 0;
    outline: none;
    box-shadow: none;
    padding: 0;
    margin: 0;
    overflow: hidden;
    background: transparent;
    color: #f4f7ff;
    font: 700 11px/1.2 ui-monospace, Consolas, "Cascadia Mono", monospace;
    letter-spacing: 1.2px;
    text-transform: uppercase;
    cursor: pointer;
    pointer-events: auto;
    z-index: 0;
  }
  .blur-clip {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
    border-radius: inherit;
  }
  .blur-clone {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    max-width: none;
    max-height: none;
    margin: 0;
    padding: 0;
    border: 0;
    display: block;
    pointer-events: none;
    object-fit: cover;
    transform: scale(var(--aid-blur-scale, 1.2));
    transform-origin: center;
    filter: blur(0);
    opacity: 0;
    transition: filter ${AI_BLUR_MS}ms ease, opacity ${AI_BLUR_MS}ms ease;
  }
  .blur-dim {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: rgba(12, 2, 10, 0);
    transition: background ${AI_BLUR_MS}ms ease;
  }
  .blur-veil-label {
    position: relative;
    z-index: 1;
    opacity: 0;
    transition: opacity ${AI_BLUR_MS}ms ease;
    text-shadow: 0 1px 8px rgba(0, 0, 0, 0.85);
  }
  .blur-veil.in .blur-clone {
    opacity: 1;
    filter: blur(${AI_BLUR_PX}px);
  }
  .blur-veil.in .blur-dim { background: rgba(12, 2, 10, 0.38); }
  .blur-veil.in .blur-veil-label { opacity: 1; }
  .blur-veil.bg-cover {
    backdrop-filter: blur(0);
    transition: backdrop-filter ${AI_BLUR_MS}ms ease;
  }
  .blur-veil.bg-cover.in { backdrop-filter: blur(${AI_BLUR_PX}px); }
  @media (prefers-reduced-motion: reduce) {
    .blur-clone, .blur-dim, .blur-veil-label, .blur-veil.bg-cover {
      transition: none;
    }
  }
  .hud {
    position: fixed;
    bottom: 10px;
    left: 10px;
    background: rgba(4,7,15,.94);
    color: #00f0ff;
    font: 600 11px/1.8 ui-monospace, Consolas, "Cascadia Mono", monospace;
    letter-spacing: 1px;
    padding: 0 12px;
    border-radius: 2px;
    border: 1px solid rgba(0,240,255,.5);
    box-shadow: 0 0 12px rgba(0,240,255,.3);
    pointer-events: none;
  }
`;

/** @param {HTMLElement} host @returns {HTMLElement} */
function scrollContainerFor(host) {
  /** @type {HTMLElement | null} */
  let nearestOverflowCapable = null;
  for (
    let parent = host.parentElement;
    parent && parent !== document.documentElement;
    parent = parent.parentElement
  ) {
    const style = getComputedStyle(parent);
    const pos = style.position;
    if (
      overflowParentIsScroller({
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        scrollWidth: parent.scrollWidth,
        clientWidth: parent.clientWidth,
        scrollHeight: parent.scrollHeight,
        clientHeight: parent.clientHeight,
        position: pos,
      })
    ) {
      return parent;
    }
    if (!nearestOverflowCapable && overflowCanScroll(style.overflowX, style.overflowY)) {
      nearestOverflowCapable = parent;
    }
    // Inner overflow:auto inside a sticky/fixed pane (Google Images preview)
    // must host the overlay even before it overflows. Otherwise we promote to
    // position:fixed on the document and the pane's own scrollbar detaches it.
    if ((pos === 'fixed' || pos === 'sticky') && nearestOverflowCapable) {
      return nearestOverflowCapable;
    }
  }
  return document.documentElement;
}

/** Padding between the visible image corner and the badge, in CSS px. */
const BADGE_INSET = 4;
/** Below this many visible px on an axis, a badge is more noise than label. */
const BADGE_MIN_VISIBLE = 24;
/** Vertical drop from the badge anchor to its popover, in CSS px. */
const POPOVER_DROP = 18;

/**
 * Ancestor walk cache for {@link clipRectFor}. Every badge is repositioned on
 * every scroll frame, and an image-heavy page carries hundreds of them, so the
 * getComputedStyle walk must not run per badge per frame. Cached for the
 * element's lifetime, matching the assumption the native binding already makes
 * by resolving its scroll container once at badge creation.
 * @type {WeakMap<HTMLElement, HTMLElement>}
 */
const scrollContainerCache = new WeakMap();

/**
 * Sticky/fixed page chrome sampled once per overlay pass. A Google Images
 * header or preview pane would otherwise clamp badges to the viewport edge
 * and paint Show veils on top of the search box.
 * @type {{el: Element, box: {left: number, top: number, right: number, bottom: number}}[] | null}
 */
let pageChromeCache = null;

function invalidatePageChrome() {
  pageChromeCache = null;
}

/** @param {Element} el */
function isExtensionOverlayElement(el) {
  return el === overlayRoot?.host || isOverlayNode(el);
}

/** @param {number} x @param {number} y @returns {Element | null} */
function pageChromeAt(x, y) {
  const stack = document.elementsFromPoint(x, y);
  for (let i = 0; i < stack.length; i++) {
    const el = stack[i];
    if (!(el instanceof Element) || isExtensionOverlayElement(el)) continue;
    const pos = getComputedStyle(el).position;
    if (pos === 'fixed' || pos === 'sticky') return el;
  }
  return null;
}

function pageChromeOccluders() {
  if (pageChromeCache) return pageChromeCache;
  /** @type {{el: Element, box: DOMRect}[]} */
  const found = [];
  const seen = new Set();
  const width = window.innerWidth;
  const height = window.innerHeight;
  if (width > 0 && height > 0) {
    /**
     * @param {number} x
     * @param {number} y
     */
    const sample = (x, y) => {
      const el = pageChromeAt(x, y);
      if (!el || seen.has(el)) return;
      seen.add(el);
      found.push({ el, box: el.getBoundingClientRect() });
    };
    sample(width / 2, 1);
    sample(width / 2, height - 2);
    sample(1, height / 2);
    sample(width - 2, height / 2);
    // Inside a typical right-hand preview pane; the far edge is often the
    // page scrollbar rather than the pane itself.
    sample(width * 0.75, height / 2);
  }
  pageChromeCache = found;
  return found;
}

/**
 * Region a badge for `host` may occupy: the viewport, narrowed by the nearest
 * scrolling ancestor and by sticky/fixed page chrome that does not contain
 * the image, so a badge cannot ride the search bar or cover a preview pane.
 * The container is passed in when the caller already has it cached.
 *
 * @param {HTMLElement} host
 * @param {HTMLElement} [scrollContainer]
 * @returns {{left: number, top: number, right: number, bottom: number}}
 */
function clipRectFor(host, scrollContainer) {
  /** @type {{left: number, top: number, right: number, bottom: number}} */
  let clip = {
    left: 0,
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
  };
  let container = scrollContainer ?? scrollContainerCache.get(host);
  if (!container) {
    container = scrollContainerFor(host);
    scrollContainerCache.set(host, container);
  }
  if (container && container !== document.documentElement) {
    const box = container.getBoundingClientRect();
    clip.left = Math.max(clip.left, box.left);
    clip.top = Math.max(clip.top, box.top);
    clip.right = Math.min(clip.right, box.right);
    clip.bottom = Math.min(clip.bottom, box.bottom);
  }
  const chrome = pageChromeOccluders();
  for (let i = 0; i < chrome.length; i++) {
    const item = chrome[i];
    if (!item || item.el.contains(host)) continue;
    clip = insetClipForOccluder(clip, item.box);
  }
  return clip;
}

/** @param {HTMLElement} element @param {string} property @param {string} value */
function setImportantStyle(element, property, value) {
  if (
    element.style.getPropertyValue(property) === value &&
    element.style.getPropertyPriority(property) === 'important'
  ) {
    return;
  }
  element.style.setProperty(property, value, 'important');
}

/** @param {HTMLElement} host @returns {string} */
function acquireHostAnchorName(host) {
  const existing = hostAnchorNames.get(host);
  if (existing) {
    existing.refs += 1;
    return existing.name;
  }
  const name = `--aid-${pageId}-${++nativeAnchorSeq}`;
  const previousInlineAnchorNames = host.style.getPropertyValue('anchor-name');
  const previousInlinePriority = host.style.getPropertyPriority('anchor-name');
  const computedAnchorNames = getComputedStyle(host).getPropertyValue('anchor-name').trim();
  const assignedAnchorNames =
    computedAnchorNames && computedAnchorNames !== 'none'
      ? `${computedAnchorNames}, ${name}`
      : name;
  host.style.setProperty('anchor-name', assignedAnchorNames, 'important');
  hostAnchorNames.set(host, {
    name,
    assignedAnchorNames,
    previousInlineAnchorNames,
    previousInlinePriority,
    refs: 1,
  });
  return name;
}

/** @param {HTMLElement} host */
function releaseHostAnchorName(host) {
  const existing = hostAnchorNames.get(host);
  if (!existing) return;
  existing.refs -= 1;
  if (existing.refs > 0) return;
  hostAnchorNames.delete(host);
  const current = host.style.getPropertyValue('anchor-name');
  if (current === existing.assignedAnchorNames) {
    if (existing.previousInlineAnchorNames) {
      host.style.setProperty(
        'anchor-name',
        existing.previousInlineAnchorNames,
        existing.previousInlinePriority,
      );
    } else {
      host.style.removeProperty('anchor-name');
    }
    return;
  }
  const remaining = current
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name && name !== existing.name);
  if (remaining.length > 0) {
    host.style.setProperty('anchor-name', remaining.join(', '), 'important');
  } else {
    host.style.removeProperty('anchor-name');
  }
}

/**
 * Light-DOM wrapper so `position-anchor` can see the image's `anchor-name`.
 * Visible UI stays in the closed shadow.
 *
 * The wrapper is the image's next DOM sibling with a small z-index: it paints
 * in the image's OWN stacking context, above the picture and its z-auto tile
 * overlays, and below any real page layer (autocomplete menu, dialog, sticky
 * header) that covers the picture. Same layer as the image by construction —
 * no occlusion hit tests, no clip math, and the hosting scroller or viewport
 * clips the wrapper exactly like the picture, all on the compositor.
 * @param {HTMLElement} host
 * @param {{ zIndex: string, fill: boolean }} options
 * @returns {{
 *   wrapper: HTMLElement,
 *   root: ShadowRoot,
 *   host: HTMLElement,
 *   anchorName: string,
 * }}
 */
function createNativeAnchorWrapper(host, options) {
  const anchorName = acquireHostAnchorName(host);
  const wrapper = document.createElement('div');
  wrapper.style.setProperty('all', 'initial', 'important');
  wrapper.style.setProperty('display', 'block', 'important');
  wrapper.style.setProperty('position', 'absolute', 'important');
  wrapper.style.setProperty('position-anchor', anchorName, 'important');
  wrapper.style.setProperty('left', 'anchor(left)', 'important');
  wrapper.style.setProperty('top', 'anchor(top)', 'important');
  if (options.fill) {
    wrapper.style.setProperty('box-sizing', 'border-box', 'important');
    if (nativeAnchorFill) {
      wrapper.style.setProperty('right', 'anchor(right)', 'important');
      wrapper.style.setProperty('bottom', 'anchor(bottom)', 'important');
      wrapper.style.setProperty('width', 'auto', 'important');
      wrapper.style.setProperty('height', 'auto', 'important');
    }
  } else {
    wrapper.style.setProperty('width', 'max-content', 'important');
    wrapper.style.setProperty('height', 'max-content', 'important');
  }
  // Fill wrappers (Show veils) clip the scaled blur clone. Badge wrappers stay
  // visible so the score pill can paint past a 0×0 anchor box.
  wrapper.style.setProperty('overflow', options.fill ? 'hidden' : 'visible', 'important');
  wrapper.style.setProperty('pointer-events', 'none', 'important');
  wrapper.style.setProperty('z-index', options.zIndex, 'important');
  const root = wrapper.attachShadow({ mode: 'closed' });
  markOverlayNode(wrapper);
  host.after(wrapper);
  // A wrapper created while Detection is off (an in-flight scan resolving
  // during teardown) must not paint: its inline !important styles beat the
  // hide stylesheet, so hide it inline like hideOverlayNodes does.
  if (document.getElementById(OVERLAY_HIDE_STYLE_ID)) hideOverlayNodeInline(wrapper);
  return { wrapper, root, host, anchorName };
}

/**
 * A framework that recycles a tile can move the image and strand its wrapper
 * in the old parent (or drop it entirely). Re-seat the wrapper as the image's
 * next sibling; anchor positioning does the rest.
 * @param {{wrapper: HTMLElement, host: HTMLElement}} binding
 */
function reseatNativeAnchorWrapper(binding) {
  const { wrapper, host } = binding;
  if (
    host.isConnected &&
    (wrapper.parentElement !== host.parentElement || wrapper.previousElementSibling !== host)
  ) {
    host.after(wrapper);
  }
}

/**
 * @param {{
 *   wrapper: HTMLElement,
 *   host: HTMLElement,
 * }} binding
 */
function destroyNativeAnchorWrapper(binding) {
  binding.wrapper.remove();
  releaseHostAnchorName(binding.host);
}

function ensureOverlay() {
  if (overlayRoot) return overlayRoot;
  const host = document.createElement('div');
  markOverlayNode(host);
  host.style.cssText =
    'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
  overlayRoot = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = overlayStyles;
  overlayRoot.appendChild(style);
  document.documentElement.appendChild(host);
  return overlayRoot;
}

/** @param {HTMLElement} host @returns {HTMLElement} */
function createBadge(host) {
  if (!nativeAnchorWorksFor(host)) {
    const badge = document.createElement('div');
    ensureOverlay().appendChild(badge);
    return badge;
  }

  ensureOverlay();

  const binding = createNativeAnchorWrapper(host, {
    // Above the image, z-auto tile overlays, and the Show veil (z-index 1);
    // below any page layer that covers the tile (menus, dialogs, headers).
    zIndex: '2',
    fill: false,
  });
  const style = document.createElement('style');
  // The native wrapper owns positioning; the shadow child only paints UI.
  style.textContent = `${overlayStyles}\n.badge { position: static; display: block; }`;
  const badge = document.createElement('div');
  binding.root.append(style, badge);
  nativeBadgeBindings.set(badge, binding);
  return badge;
}

/**
 * Remove a badge and undo the non-layout anchor marker placed on its image.
 * @param {ImgState | undefined} state
 */
function removeBadge(state) {
  const badge = state?.badge;
  if (!badge) return;
  const binding = nativeBadgeBindings.get(badge);
  if (binding) {
    const host = binding.host;
    badgePlacementRetries.delete(host);
    destroyNativeAnchorWrapper(binding);
    nativeBadgeBindings.delete(badge);
    if (!state.unblurVeil) overlayActivityObserver.unobserve(host);
  } else {
    badge.remove();
  }
  state.badge = null;
}

/**
 * The integer the badge and popover print. Computed in the service worker,
 * which owns the calibration curve it is derived from; the raw probability is
 * only a fallback for an update that predates the field.
 * @param {ScanUpdate} u
 */
function displayScoreOf(u) {
  if (typeof u.display === 'number') return u.display;
  return Math.round(/** @type {number} */ (u.probability) * 100);
}

/** @type {WeakMap<HTMLElement, ReturnType<typeof setTimeout>>} */
const blurHideTimers = new WeakMap();
/**
 * The transitionend fallback listener paired with each hide timer. Both must
 * be cancelled together: re-arming a veil mid-fade (blur toggled off→on inside
 * the 280ms transition) used to leave this listener attached, and the re-show
 * transition's own transitionend then destroyed the live veil.
 * @type {WeakMap<HTMLElement, () => void>}
 */
const blurHideFinishers = new WeakMap();

/**
 * @param {ImgState} state
 * @returns {boolean}
 */
function shouldBlurImage(state) {
  const u = state.update;
  if (!u || u.state !== 'scored' || !u.isAI || u.engine === 'mock') return false;
  if (state.blurRevealed) return false;
  return Boolean(blurAiImages || state.blurForced);
}

/** @returns {number} */
function blurHideDelayMs() {
  try {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 0;
  } catch {
    /* matchMedia is missing in some test shims */
  }
  return AI_BLUR_MS + 40;
}

/**
 * The reveal gesture's target and when it happened. The reveal runs on
 * pointerdown so the page cannot cancel it first — but canceling pointerdown
 * does NOT cancel the gesture's click (click is its own PointerEvent). By
 * click time the image is already revealed, so the hit test below finds
 * nothing and the click falls through to the page: revealing an AI image
 * inside a link also NAVIGATED to that link. Suppress the click that belongs
 * to a reveal gesture (same spot, sub-second).
 * @type {{el: HTMLElement, at: number} | null}
 */
let lastRevealGesture = null;

/**
 * Clicks on search-result tiles hit a covering <a>/overlay, not the <img>.
 * Walk the composed path for a tracked host, then fall back to painted-rect
 * hit-testing. pointerdown runs before the page can cancel `click`.
 * @param {MouseEvent} ev
 */
function onDocumentUnblurClick(ev) {
  const path = ev.composedPath();
  if (openPopover && path.includes(openPopover.el)) return;
  for (const node of path) {
    if (node instanceof HTMLElement && node.classList.contains('badge')) return;
    if (node instanceof HTMLElement && node.classList.contains('blur-veil')) return;
  }

  if (ev.type === 'click' && lastRevealGesture) {
    const gesture = lastRevealGesture;
    lastRevealGesture = null;
    if (Date.now() - gesture.at < 600) {
      const rect = gesture.el.isConnected ? paintedRect(gesture.el) : null;
      if (
        rect &&
        ev.clientX >= rect.left &&
        ev.clientX <= rect.right &&
        ev.clientY >= rect.top &&
        ev.clientY <= rect.bottom
      ) {
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
    }
  }

  /** @type {HTMLElement | null} */
  let hit = null;
  for (const node of path) {
    if (node === document || node === document.documentElement || node === document.body) break;
    if (!(node instanceof HTMLElement)) continue;
    if (states.has(node) && shouldBlurImage(/** @type {ImgState} */ (states.get(node)))) {
      hit = node;
      break;
    }
    for (const el of byId.values()) {
      const state = states.get(el);
      if (!state || !shouldBlurImage(state)) continue;
      if (node.contains(el)) {
        hit = el;
        break;
      }
    }
    if (hit) break;
  }
  if (!hit) {
    const x = ev.clientX;
    const y = ev.clientY;
    for (const el of byId.values()) {
      const state = states.get(el);
      if (!state || !shouldBlurImage(state)) continue;
      const rect = paintedRect(el);
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
      hit = el;
      break;
    }
  }
  if (!hit) return;
  const state = states.get(hit);
  if (!state) return;
  ev.preventDefault();
  ev.stopPropagation();
  if (ev.type === 'pointerdown') lastRevealGesture = { el: hit, at: Date.now() };
  revealBlurredImage(hit, state);
}

/**
 * @param {HTMLElement} el
 * @param {ImgState} state
 */
function revealBlurredImage(el, state) {
  if (!shouldBlurImage(state)) return;
  state.blurRevealed = true;
  syncImageBlur(el, state);
}

document.addEventListener('pointerdown', rememberActivatedThumb, true);
document.addEventListener('pointerdown', onDocumentUnblurClick, true);
document.addEventListener('click', onDocumentUnblurClick, true);

/** @param {HTMLElement} wrapper */
function setVeilAnchorFill(wrapper) {
  setImportantStyle(wrapper, 'left', 'anchor(left)');
  setImportantStyle(wrapper, 'top', 'anchor(top)');
  setImportantStyle(wrapper, 'right', 'anchor(right)');
  setImportantStyle(wrapper, 'bottom', 'anchor(bottom)');
  setImportantStyle(wrapper, 'width', 'auto');
  setImportantStyle(wrapper, 'height', 'auto');
}

/** @param {HTMLElement} host @param {HTMLElement} veil */
function positionUnblurVeil(host, veil) {
  const rect = paintedRect(host);
  const binding = nativeVeilBindings.get(veil);
  if (rect.width <= 0 || rect.height <= 0 || isVisuallyHidden(host)) {
    if (binding) setImportantStyle(binding.wrapper, 'display', 'none');
    else veil.style.display = 'none';
    return;
  }
  if (binding) {
    // Sibling-mounted fill wrapper: anchor() stretches the veil to the image's
    // four edges so size and position ride the compositor — including
    // hover/transform on Google Images related thumbs — and the hosting
    // scroller or viewport clips it exactly like the picture. No clip math.
    reseatNativeAnchorWrapper(binding);
    setImportantStyle(binding.wrapper, 'display', 'block');
    setVeilAnchorFill(binding.wrapper);
    syncBlurCover(host, veil);
    return;
  }
  veil.style.display = 'flex';
  veil.style.left = `${rect.left}px`;
  veil.style.top = `${rect.top}px`;
  veil.style.width = `${rect.width}px`;
  veil.style.height = `${rect.height}px`;
  syncBlurCover(host, veil);
}

/**
 * Size the overflow-clipped clone so Gaussian fringe (transparent = black)
 * sits outside the visible box. Never filter the page <img> itself — that is
 * what painted the triangular corners.
 * @param {HTMLElement} host
 * @param {HTMLElement} veil
 */
/**
 * @param {HTMLElement} host
 * @param {HTMLElement} veil
 * @param {number} [clipWidth]
 * @param {number} [clipHeight]
 */
function syncBlurCover(host, veil, clipWidth, clipHeight) {
  const box = host.getBoundingClientRect();
  const width = clipWidth ?? box.width;
  const height = clipHeight ?? box.height;
  veil.style.setProperty('--aid-blur-scale', String(blurCoverScale(width, height)));
  const fit = getComputedStyle(host);
  if (fit.borderRadius) veil.style.borderRadius = fit.borderRadius;
  const clone = veil.querySelector('.blur-clone');
  if (!(clone instanceof HTMLImageElement) || !(host instanceof HTMLImageElement)) return;
  const src = host.currentSrc || host.src;
  if (src && clone.src !== src) clone.src = src;
  clone.style.objectFit = fit.objectFit;
  clone.style.objectPosition = fit.objectPosition;
}

/** @param {HTMLElement} el @param {ImgState} state */
function ensureUnblurVeil(el, state) {
  if (state.unblurVeil) return state.unblurVeil;
  watchOverlayActivity(el);
  const veil = document.createElement('button');
  veil.type = 'button';
  veil.className = el instanceof HTMLImageElement ? 'blur-veil' : 'blur-veil bg-cover';
  veil.title = 'Click to show this image';
  if (el instanceof HTMLImageElement) {
    const clip = document.createElement('span');
    clip.className = 'blur-clip';
    clip.setAttribute('aria-hidden', 'true');
    const clone = document.createElement('img');
    clone.className = 'blur-clone';
    clone.alt = '';
    clone.draggable = false;
    clone.decoding = 'async';
    clip.appendChild(clone);
    veil.appendChild(clip);
  }
  const dim = document.createElement('span');
  dim.className = 'blur-dim';
  dim.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.className = 'blur-veil-label';
  label.textContent = 'Show';
  veil.append(dim, label);
  /** @param {PointerEvent} ev */
  const stopUnhidePointer = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  };
  veil.addEventListener('pointerdown', stopUnhidePointer);
  veil.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    revealBlurredImage(el, state);
  });
  if (!nativeAnchorWorksFor(el) || !nativeAnchorFill) {
    ensureOverlay().appendChild(veil);
    state.unblurVeil = veil;
    return veil;
  }

  ensureOverlay();
  const binding = createNativeAnchorWrapper(el, {
    // Sibling layer below the badge (z-index 2), above the image.
    zIndex: '1',
    fill: true,
  });
  const style = document.createElement('style');
  style.textContent = `${overlayStyles}\n.blur-veil { position: static; display: flex; width: 100%; height: 100%; box-sizing: border-box; }`;
  binding.root.append(style, veil);
  nativeVeilBindings.set(veil, binding);
  state.unblurVeil = veil;
  return veil;
}

/** @param {HTMLElement} veil */
function cancelBlurHide(veil) {
  const timer = blurHideTimers.get(veil);
  if (timer) {
    clearTimeout(timer);
    blurHideTimers.delete(veil);
  }
  const finish = blurHideFinishers.get(veil);
  if (finish) {
    veil.removeEventListener('transitionend', finish);
    blurHideFinishers.delete(veil);
  }
}

/** @param {ImgState} state */
function destroyUnblurVeil(state) {
  const veil = state.unblurVeil;
  if (!veil) return;
  cancelBlurHide(veil);
  const binding = nativeVeilBindings.get(veil);
  if (binding) {
    destroyNativeAnchorWrapper(binding);
    nativeVeilBindings.delete(veil);
    if (!state.badge) overlayActivityObserver.unobserve(binding.host);
  } else {
    veil.remove();
  }
  state.unblurVeil = null;
}

/** Immediate teardown — sweep / Detection-off / src replacement. */
/** @param {ImgState} state */
function removeUnblurVeil(state) {
  destroyUnblurVeil(state);
}

/** Animated hide when the user toggles blur off or reveals one image. */
/** @param {ImgState} state */
function dismissUnblurVeil(state) {
  const veil = state.unblurVeil;
  if (!veil) return;
  cancelBlurHide(veil);
  const delay = blurHideDelayMs();
  if (delay === 0 || !veil.classList.contains('in')) {
    destroyUnblurVeil(state);
    return;
  }
  veil.classList.remove('in');
  veil.style.pointerEvents = 'none';
  const finish = () => {
    blurHideFinishers.delete(veil);
    if (state.unblurVeil !== veil) return;
    destroyUnblurVeil(state);
  };
  blurHideFinishers.set(veil, finish);
  veil.addEventListener('transitionend', finish, { once: true });
  blurHideTimers.set(veil, setTimeout(finish, delay));
}

/** @param {ImgState} state @param {HTMLElement} veil */
function armBlurVeil(state, veil) {
  cancelBlurHide(veil);
  veil.style.pointerEvents = '';
  const show = () => {
    if (state.unblurVeil !== veil || !shouldBlurImage(state)) return;
    veil.classList.add('in');
  };
  if (veil.classList.contains('in')) return;
  const arm = () => requestAnimationFrame(() => requestAnimationFrame(show));
  const clone = veil.querySelector('.blur-clone');
  if (clone instanceof HTMLImageElement && !clone.complete) {
    clone.addEventListener('load', arm, { once: true });
    clone.addEventListener('error', arm, { once: true });
    return;
  }
  arm();
}

/** @param {HTMLElement} el @param {ImgState} state */
function syncImageBlur(el, state) {
  const want = shouldBlurImage(state);
  if (want) {
    const veil = ensureUnblurVeil(el, state);
    positionUnblurVeil(el, veil);
    armBlurVeil(state, veil);
  } else {
    dismissUnblurVeil(state);
  }
}

function syncAllImageBlurs() {
  for (const el of byId.values()) {
    const state = states.get(el);
    if (state) syncImageBlur(el, state);
  }
}

/** @param {HTMLElement} el @param {ImgState} state */
function renderBadge(el, state) {
  // Detection-off hides overlays with a stylesheet and keeps the nodes. Do
  // not tear badges down here — that is what made off→on freeze a busy page.
  if (!enabled) return;
  syncImageBlur(el, state);
  const u = state.update;
  const pendingOutsideViewport =
    state.phase === 'pending' &&
    (document.visibilityState === 'hidden' ||
      !isRectInViewport(paintedRect(el), {
        width: window.innerWidth,
        height: window.innerHeight,
      }));
  if (pendingOutsideViewport || !shouldRenderBadge(state.phase, u?.probability, window !== top)) {
    removeBadge(state);
    if (openPopover?.state === state) closePopover();
    scheduleBadgeCollisionReconcile();
    return;
  }

  let created = false;

  if (!state.badge) {
    state.badge = createBadge(el);
    created = true;
    watchOverlayActivity(el);
  }
  // Pending placement retries must not stick a later verdict at display:none.
  // A scored/setup update always gets a fresh two-frame placement window.
  if (created || state.phase === 'scored' || state.phase === 'no-model') {
    badgePlacementRetries.delete(el);
  }
  const b = state.badge;
  b.onclick = null;

  if (state.phase === 'pending' && u && typeof u.probability === 'number') {
    // Re-scanning the same picture at a better resolution. Restate the score
    // already on screen, dimmed, rather than dropping back to a spinner \u2014 the
    // number is still the best answer available until the upgrade lands.
    const pct = displayScoreOf(u);
    b.className = `badge scored restating ${u.engine === 'mock' ? 'mock' : u.isAI ? 'ai' : 'real'}`;
    b.textContent = u.engine === 'mock' ? 'MOCK' : u.isAI ? `AI ${pct}%` : `${pct}%`;
    b.title = 'Re-analyzing at full resolution';
  } else if (state.phase === 'pending') {
    b.className = 'badge pending';
    b.textContent = 'AI \u2026';
    b.title = state.holdScan ? 'Finding a full-resolution source' : 'Analyzing this image on-device';
  } else if (state.phase === 'no-model') {
    b.className = 'badge setup';
    b.textContent = 'SETUP';
    b.title = 'Open the extension popup to install the on-device model';
  } else if (u && typeof u.probability === 'number') {
    const pct = displayScoreOf(u);
    const mock = u.engine === 'mock';
    b.className = `badge scored ${mock ? 'mock' : u.isAI ? 'ai' : 'real'}`;
    b.textContent = mock ? 'MOCK' : u.isAI ? `AI ${pct}%` : `${pct}%`;
    b.title = mock ? 'Simulated pipeline result — not an AI verdict' : 'Click for on-device score details';
    b.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      togglePopover(el, state);
    };
  }
  // Paint the score this frame even if layout/hit-testing is still settling.
  // Retries below apply sticky-header hiding without waiting for a scroll.
  const deferHitTest = created || state.phase === 'scored' || state.phase === 'no-model';
  const visible = positionBadge(el, b, { deferHitTest });
  scheduleBadgeCollisionReconcile();
  if (openPopover?.state === state) {
    if (visible) positionPopover(el, openPopover.el);
    else closePopover();
  }
  if (created || deferHitTest || !visible) scheduleBadgePlacementRetry(el, state);
}

let loggedFirstBadge = false;
/** @type {HTMLElement | null} */
let setupNotice = null;

function showSetupNotice() {
  if (window !== top || setupNotice) return;
  setupNotice = document.createElement('div');
  setupNotice.className = 'setup-notice';
  setupNotice.textContent = 'AI detector · setup required';
  setupNotice.title = 'Open the extension popup to install the on-device model';
  ensureOverlay().appendChild(setupNotice);
}

function clearSetupNotice() {
  setupNotice?.remove();
  setupNotice = null;
}

function enterModelUnavailableState() {
  if (!modelGate.enter()) return;
  // Do not registry.reset() here. Other URLs are still in flight in the
  // service worker; dropping their waiters would strand duplicate <img>s on
  // the same URL when those jobs later score. Port disconnect is the only
  // place in-flight is actually stale.
  closePopover();
  for (const [, el] of byId) {
    const state = states.get(el);
    if (!state || (state.phase !== 'pending' && state.phase !== 'no-model')) continue;
    state.phase = 'no-model';
    renderBadge(el, state);
  }
  showSetupNotice();
  void probeModelReadiness();
}

function applyModelReady() {
  if (!enabled) return;
  staleNoModelRetried.clear();
  const alreadyProven = modelGate.provenUsable;
  const wasLatched = modelGate.markUsable();
  clearSetupNotice();
  // Skip the epoch bump when this tab already has scored badges — startup
  // recovery rebroadcasts MODEL_READY whenever weights are on disk.
  if (wasLatched || !alreadyProven) scheduleRescanVisible();
}

/**
 * Ask the service worker whether weights are already usable. Recovers a tab
 * that latched on `no-model` after MODEL_READY was broadcast with no listener.
 * @returns {Promise<'already' | 'recovered' | 'unavailable'>}
 */
function probeModelReadiness() {
  if (modelGate.provenUsable) return Promise.resolve('already');
  return new Promise((resolve) => {
    let settled = false;
    /** @param {'already' | 'recovered' | 'unavailable'} status */
    const finish = (status) => {
      if (settled) return;
      settled = true;
      resolve(status);
    };
    try {
      chrome.runtime.sendMessage({ type: MSG.STATUS_GET, target: TARGET.SW }, (response) => {
        void chrome.runtime.lastError;
        if (response?.model?.state === 'ready') {
          applyModelReady();
          finish('recovered');
          return;
        }
        finish('unavailable');
      });
    } catch {
      finish('unavailable');
    }
  });
}

function scheduleRescanVisible() {
  if (!enabled || rescanQueued) return;
  rescanQueued = true;
  queueMicrotask(() => {
    rescanQueued = false;
    rescanVisible();
  });
}

/** A scored verdict means weights are usable, even if MODEL_READY was missed. */
function onModelBecameUsable() {
  const firstProof = !modelGate.provenUsable;
  const wasLatched = modelGate.markUsable();
  if (firstProof) staleNoModelRetried.clear();
  if (!wasLatched) return;
  clearSetupNotice();
  scheduleRescanVisible();
}

/**
 * A no-model reply that lost the race with a scored verdict or MODEL_READY.
 * Re-queue that URL once; never re-latch or demote images that already scored.
 * @param {string} url
 * @param {string} fallbackId
 */
function retryStaleNoModel(url, fallbackId) {
  const waiters = registry.settle(url, fallbackId);
  const already = staleNoModelRetried.has(url);
  if (!already) staleNoModelRetried.add(url);

  for (const id of waiters) {
    const el = byId.get(id);
    const state = el && states.get(el);
    if (!el || !state || state.phase === 'scored') continue;
    if (already) {
      state.phase = 'no-model';
      renderBadge(el, state);
      continue;
    }
    state.phase = 'pending';
    state.update = null;
    viewportPriorityObserver.observe(el);
    renderBadge(el, state);
    requestScan(el, state);
  }
}

/** @type {{state: ImgState, el: HTMLElement, host: HTMLElement} | null} */
let openPopover = null;

function closePopover() {
  openPopover?.el.remove();
  openPopover = null;
}

/** @param {HTMLElement} host @param {ImgState} state */
function togglePopover(host, state) {
  if (openPopover?.state === state) {
    closePopover();
    return;
  }
  closePopover();
  const u = state.update;
  if (!u || typeof u.probability !== 'number') return;
  const root = ensureOverlay();
  const pop = document.createElement('div');
  pop.className = 'popover';
  const pct = displayScoreOf(u);
  /**
   * @param {string} text
   * @param {string} [className]
   */
  const add = (text, className) => {
    const row = document.createElement('div');
    if (className) row.className = className;
    row.textContent = text;
    pop.appendChild(row);
  };
  if (u.engine === 'mock') {
    add('MOCK PIPELINE');
    add('Simulated test only — not an AI verdict', 'k');
    add('Use the local-model build for real on-device scores.', 'k');
    pop.addEventListener('click', (ev) => ev.stopPropagation());
    root.appendChild(pop);
    openPopover = { state, el: pop, host };
    positionPopover(host, pop);
    return;
  }
  add(`AI score ${pct}%`);
  add(`${u.isAI ? 'Verdict: AI-generated' : 'Verdict: likely real'} at 0.65`, 'k');
  // The badge prints a rescaled axis (src/shared/display-score.js), so keep the
  // number the verdict was actually taken on visible and auditable.
  add(`calibrated P(AI) ${u.probability.toFixed(3)}`, 'k');
  // Checked against the upgrade record, not against the element's src: a
  // blob: image also scans a URL that differs from its src, and that is not an
  // upgrade. Resolution is the single biggest lever on this verdict, so the
  // popover always says which pixels produced it.
  const upgrade = host instanceof HTMLImageElement ? upgradeResolved.get(host) : undefined;
  if (upgrade?.url && upgrade.url === state.url) {
    add('scored the full-resolution original', 'k');
  } else if (upgrade?.note) {
    add(`scored the page thumbnail — ${upgrade.note}`, 'k');
  }
  if (u.gate === 'graphic') {
    // The cap itself is listed in the contributions rows; this line says why.
    add('flat graphics/text detected — not photographic content, so the photo detector\u2019s score is capped below the AI threshold', 'k');
  } else if (u.gate === 'native-tiles') {
    add('the downscaled crop looked generated; native-resolution tiles did not agree, so the score is the tiles\u2019', 'k');
  }
  if (u.isAI) {
    const btn = document.createElement('button');
    btn.type = 'button';
    const blurred = shouldBlurImage(state);
    btn.className = `blur-toggle${blurred ? ' show' : ''}`;
    btn.textContent = blurred ? 'Show image' : 'Blur image';
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const currentlyBlurred = shouldBlurImage(state);
      if (currentlyBlurred) {
        state.blurRevealed = true;
        state.blurForced = false;
      } else {
        state.blurRevealed = false;
        state.blurForced = true;
      }
      syncImageBlur(host, state);
      const nowBlurred = shouldBlurImage(state);
      btn.className = `blur-toggle${nowBlurred ? ' show' : ''}`;
      btn.textContent = nowBlurred ? 'Show image' : 'Blur image';
    });
    pop.appendChild(btn);
  }
  if (u.contributions?.length) {
    for (const c of u.contributions) {
      // The C2PA override path reports bits: Infinity, which chrome.runtime
      // messaging JSON-serializes to null. toFixed on null throws inside this
      // click handler and leaves a dead badge — render the reason instead.
      if (typeof c.bits !== 'number' || !Number.isFinite(c.bits)) {
        add(`${c.name}: ${c.reason ?? 'override'}`, 'bits');
        continue;
      }
      const sign = c.bits >= 0 ? '+' : '';
      add(`${c.name}: ${sign}${c.bits.toFixed(2)} bits`, 'bits');
    }
  }
  add('Analyzed on this device. Nothing left the browser.', 'k');
  pop.addEventListener('click', (ev) => ev.stopPropagation());
  root.appendChild(pop);
  openPopover = { state, el: pop, host };
  positionPopover(host, pop);
}

/**
 * Track the same clamped corner the badge uses, so an open popover stays
 * attached to its badge instead of drifting off with the image's real corner.
 * @param {HTMLElement} host @param {HTMLElement} pop
 */
function positionPopover(host, pop) {
  const anchor = badgeAnchorPoint({
    rect: paintedRect(host),
    clip: clipRectFor(host),
    inset: BADGE_INSET,
  });
  pop.style.left = `${anchor.x}px`;
  pop.style.top = `${anchor.y + POPOVER_DROP}px`;
}

document.addEventListener(
  'click',
  (ev) => {
    if (!openPopover) return;
    const path = ev.composedPath();
    if (path.includes(openPopover.el)) return;
    if (openPopover.state.badge && path.includes(openPopover.state.badge)) return;
    closePopover();
  },
  true,
);

/** @param {HTMLElement} host */
function paintedRect(host) {
  const box = host.getBoundingClientRect();
  if (!(host instanceof HTMLImageElement) || !host.naturalWidth || !host.naturalHeight) {
    return box;
  }
  const style = getComputedStyle(host);
  return fittedImageRect({
    box,
    naturalWidth: host.naturalWidth,
    naturalHeight: host.naturalHeight,
    objectFit: style.objectFit,
    objectPosition: style.objectPosition,
  });
}

/** @param {HTMLElement} host */
function isVisuallyHidden(host) {
  /** @type {HTMLElement | null} */
  let el = host;
  while (el) {
    const style = getComputedStyle(el);
    if (
      style.display === 'none' ||
      style.visibility !== 'visible' ||
      style.contentVisibility === 'hidden' ||
      Number.parseFloat(style.opacity) <= 0.01
    ) {
      return true;
    }
    el = el.parentElement;
  }
  return false;
}

/**
 * Measure how locally a hit-test element and image are related in the DOM.
 * Returns null when their only common root is outside the Element tree.
 * @param {Element} host
 * @param {Element} overlay
 */
function commonAncestorDistances(host, overlay) {
  let hostDistance = 0;
  /** @type {Element | null} */
  let hostNode = host;
  for (; hostNode && hostDistance <= 4; hostNode = hostNode.parentElement) {
    let overlayDistance = 0;
    /** @type {Element | null} */
    let overlayNode = overlay;
    for (; overlayNode && overlayDistance <= 2; overlayNode = overlayNode.parentElement) {
      if (hostNode === overlayNode) return { hostDistance, overlayDistance };
      overlayDistance += 1;
    }
    hostDistance += 1;
  }
  return null;
}

/**
 * Accept same-visual click targets that are siblings of the image, while still
 * rejecting sticky headers and unrelated overlays above it.
 * @param {HTMLElement} host
 * @param {{left: number, top: number, right: number, bottom: number}} hostRect
 * @param {unknown} hit
 */
function isAssociatedInteractionOverlay(host, hostRect, hit) {
  if (!(hit instanceof Element)) return false;
  const distances = commonAncestorDistances(host, hit);
  if (!distances) return false;
  return isSameVisualInteractionOverlay({
    hostRect,
    overlayRect: hit.getBoundingClientRect(),
    hostAncestorDistance: distances.hostDistance,
    overlayAncestorDistance: distances.overlayDistance,
    position: getComputedStyle(hit).position,
  });
}

/**
 * @param {HTMLElement} host
 * @param {HTMLElement} badge
 * @param {{deferHitTest?: boolean}} [options]
 * @returns {boolean}
 */
function positionBadge(host, badge, options) {
  const rect = paintedRect(host);
  const nativeBinding = nativeBadgeBindings.get(badge);
  if (
    rect.width <= 0 ||
    rect.height <= 0 ||
    (!options?.deferHitTest && isVisuallyHidden(host))
  ) {
    badge.style.display = 'none';
    return false;
  }

  if (nativeBinding) {
    // The wrapper is the image's next sibling in the image's own stacking
    // context: page layers (autocomplete menus, dialogs, sticky headers) cover
    // the badge exactly when they cover the picture, and the hosting scroller
    // or viewport clips it natively. No clip math, no occlusion hit tests —
    // the compositor does all of it.
    reseatNativeAnchorWrapper(nativeBinding);
    badge.style.display = '';
    // The offsets encode ONLY the static object-fit letterbox (painted rect vs
    // border box), never the scroll position, so scroll frames never rewrite
    // them and Chromium keeps the badge glued to the picture.
    const box = host.getBoundingClientRect();
    const offsetX = rect.left - box.left + BADGE_INSET;
    const offsetY = rect.top - box.top + BADGE_INSET;
    setImportantStyle(nativeBinding.wrapper, 'left', `calc(anchor(left) + ${offsetX}px)`);
    setImportantStyle(nativeBinding.wrapper, 'top', `calc(anchor(top) + ${offsetY}px)`);
    logFirstBadgePlacement(badge);
    return true;
  }

  // Chrome 116-124 fallback: fixed viewport coordinates refreshed from the
  // scroll listener, plus the occlusion machinery the native path gets for
  // free from the stacking order. Anchoring to the image's own corner loses
  // the badge the moment that corner scrolls off; clamp to the visible
  // intersection so it tracks the edge.
  const clip = clipRectFor(host);
  const anchor = badgeAnchorPoint({
    rect,
    clip,
    inset: BADGE_INSET,
    minVisible: BADGE_MIN_VISIBLE,
  });
  const anchorX = anchor.x;
  const anchorY = anchor.y;
  const overlayHost = overlayRoot?.host;
  /** @type {unknown[]} */
  const overlayNodes = [badge];
  if (setupNotice) overlayNodes.push(setupNotice);
  if (openPopover?.el) overlayNodes.push(openPopover.el);
  const hostState = states.get(host);
  if (hostState?.unblurVeil) {
    overlayNodes.push(hostState.unblurVeil);
    const veilBinding = nativeVeilBindings.get(hostState.unblurVeil);
    if (veilBinding) overlayNodes.push(veilBinding.wrapper);
  }
  if (!anchor.visible || !overlayHost) {
    badge.style.display = 'none';
    return false;
  }
  if (!options?.deferHitTest) {
    const hitStack = document.elementsFromPoint(anchorX, anchorY);
    const hostIsTopmost = isHostTopmostAtPoint(
      host,
      hitStack,
      overlayHost,
      overlayNodes,
      (hit) => isAssociatedInteractionOverlay(host, rect, hit),
    );
    let occluderPosition = '';
    let pageLayerOccludes = false;
    if (!hostIsTopmost) {
      const skip = new Set(overlayNodes);
      const occluder = hitStack.find((element) => element !== overlayHost && !skip.has(element));
      if (occluder instanceof Element) {
        occluderPosition = getComputedStyle(occluder).position;
        // Page layers (autocomplete menus, dialogs) cover the image without
        // being fixed/sticky. Badge and image share a layer: if the page's
        // own layer hides the picture, the badge hides with it instead of
        // floating one layer above in empty space.
        pageLayerOccludes = isPageLayerOccluder(
          host.getBoundingClientRect(),
          occluder.getBoundingClientRect(),
        );
      }
    }
    const hideForOccluder = shouldHideBadgeForOccluder(
      hostIsTopmost,
      occluderPosition,
      pageLayerOccludes,
    );
    if (hostState) hostState.badgeOccluded = hideForOccluder;
    if (hideForOccluder) {
      // Covering links and card overlays are not chrome. Only hide when the
      // image has scrolled under a sticky/fixed control or sits beneath page
      // UI that outgrows its tile, otherwise a finished scan never paints its
      // score.
      badge.style.display = 'none';
      return false;
    }
  } else if (hostState?.badgeOccluded) {
    // Scroll frames reposition without a hit test. Keep the badge parked until
    // the idle hit test re-verifies it, otherwise it flashes back over the
    // page layer (autocomplete menu, dialog) that hid it for the whole scroll.
    badge.style.display = 'none';
    return false;
  }
  badge.style.display = '';
  // Chrome 116-124 fallback: keep DOMRect and overlay in viewport space.
  badge.style.left = `${anchorX}px`;
  badge.style.top = `${anchorY}px`;
  logFirstBadgePlacement(badge);
  return true;
}

/**
 * Dev builds report the first badge placement once, so "created but
 * invisible" is distinguishable from "never created" without DevTools
 * element hunting.
 * @param {HTMLElement} badge
 */
function logFirstBadgePlacement(badge) {
  if (DEV_BUILD && !loggedFirstBadge && badge.classList.contains('scored')) {
    loggedFirstBadge = true;
    const br = badge.getBoundingClientRect();
    console.info(
      '[ai-image-detector] first badge placed:',
      JSON.stringify({
        text: badge.textContent,
        left: Math.round(br.left),
        top: Math.round(br.top),
        renderedW: Math.round(br.width),
        renderedH: Math.round(br.height),
        hostConnected: badge.isConnected,
      }),
    );
  }
}

/**
 * Native wrappers and sticky overlays often make the first elementsFromPoint
 * miss. Two animation frames is enough for layout without waiting on scroll
 * or on inference to finish.
 * @param {HTMLElement} el
 * @param {ImgState} state
 */
function scheduleBadgePlacementRetry(el, state) {
  if (contextInvalidated) return;
  const used = badgePlacementRetries.get(el) ?? 0;
  if (used >= 2) return;
  badgePlacementRetries.set(el, used + 1);
  requestAnimationFrame(() => {
    if (!extensionAlive()) return;
    const current = states.get(el);
    if (current !== state || !state.badge) return;
    const visible = positionBadge(el, state.badge);
    if (openPopover?.state === state && !visible) closePopover();
    scheduleBadgeCollisionReconcile();
    if (visible) badgePlacementRetries.delete(el);
    else scheduleBadgePlacementRetry(el, state);
  });
}

let repositionScheduled = false;
let collisionReconcileScheduled = false;
let idleHitTestScheduled = false;
let searchThumbRetryScheduled = false;
let pendingHitTest = false;
let pendingAllowNativeSkip = true;
/** Last scroll event time; idle hit tests wait for scrolling to settle. */
let lastScrollAt = 0;
/** Idle hit tests stay deferred until scrolling has paused this long (ms). */
const SCROLL_SETTLE_MS = 180;

/**
 * @param {() => void} fn
 * @param {number} [timeout]
 */
function scheduleIdle(fn, timeout = 160) {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => fn(), { timeout });
    return;
  }
  setTimeout(fn, Math.min(timeout, 48));
}

function scheduleIdleHitTest() {
  if (idleHitTestScheduled || contextInvalidated || byId.size === 0) return;
  idleHitTestScheduled = true;
  scheduleIdle(() => {
    idleHitTestScheduled = false;
    if (!enabled || !started || contextInvalidated) return;
    // requestIdleCallback's timeout fires mid-scroll, and a per-badge
    // elementsFromPoint pass competes with the compositor for the main thread
    // the page is scrolling on. Defer until scrolling settles.
    if (performance.now() - lastScrollAt < SCROLL_SETTLE_MS) {
      scheduleIdleHitTest();
      return;
    }
    repositionAll({ hitTest: true });
  });
}

function scheduleSearchThumbnailUpgradeRetry() {
  if (searchThumbRetryScheduled || contextInvalidated) return;
  searchThumbRetryScheduled = true;
  scheduleIdle(() => {
    searchThumbRetryScheduled = false;
    if (!enabled || !started || contextInvalidated) return;
    retrySearchThumbnailUpgrades();
  }, 250);
}

function scheduleBadgeCollisionReconcile() {
  if (collisionReconcileScheduled || contextInvalidated) return;
  collisionReconcileScheduled = true;
  requestAnimationFrame(() => {
    collisionReconcileScheduled = false;
    if (!extensionAlive()) return;
    try {
      reconcileBadgeCollisions();
    } catch {
      // Closed-shadow badges throw "Extension context invalidated" after a
      // reload; getBoundingClientRect is the usual site.
      contextInvalidated = true;
    }
  });
}

/**
 * Image viewers can paint the same visual through a thumbnail, a full-size
 * <img>, and a wrapper background. Keep exactly one overlay per painted area,
 * preferring a settled verdict and then a real <img> over a fallback wrapper.
 */
function reconcileBadgeCollisions() {
  /** @type {RenderedBadge[]} */
  const rendered = [];
  for (const [id, host] of byId) {
    const state = states.get(host);
    const badge = state?.badge;
    if (!state || !badge?.isConnected || badge.style.display === 'none') continue;
    badge.style.visibility = '';
    rendered.push({
      id,
      phase: state.phase,
      url: state.url,
      isImage: host instanceof HTMLImageElement,
      host: paintedRect(host),
      badge: badge.getBoundingClientRect(),
      element: badge,
    });
  }

  /** @param {RenderedBadge} item */
  const priority = (item) =>
    (item.phase === 'scored' ? 4 : item.phase === 'no-model' ? 3 : 1) +
    (item.isImage ? 1 : 0);
  rendered.sort((a, b) => priority(b) - priority(a));
  /** @type {RenderedBadge[]} */
  const keepers = [];
  for (const item of rendered) {
    if (keepers.some((keeper) => shouldSuppressDuplicateBadge(item, keeper))) {
      item.element.style.visibility = 'hidden';
    } else {
      keepers.push(item);
    }
  }
}

/**
 * @param {{hitTest?: boolean, allowNativeSkip?: boolean}} [options]
 */
function repositionAll(options) {
  if (!enabled || !started || contextInvalidated) return;
  if (options?.hitTest) {
    pendingHitTest = true;
    pendingAllowNativeSkip = false;
  }
  if (options?.allowNativeSkip === false) pendingAllowNativeSkip = false;
  if (repositionScheduled) return;
  repositionScheduled = true;
  requestAnimationFrame(() => {
    const hitTest = pendingHitTest;
    const allowNativeSkip = pendingAllowNativeSkip;
    pendingHitTest = false;
    pendingAllowNativeSkip = true;
    repositionScheduled = false;
    if (!extensionAlive()) return;
    try {
      invalidatePageChrome();
      for (const [id, el] of byId) {
        const state = states.get(el);
        if (!state) continue;
        if (!el.isConnected) {
          sweepOne(id, el);
          continue;
        }
        // Parked hosts are far off screen: the native anchor wrapper keeps
        // their overlays glued to the image without any JS, so measuring and
        // rewriting them on every scroll frame is pure main-thread cost that
        // grows with every image ever badged. overlayActivityObserver wakes
        // them before they re-enter the viewport.
        if (nativeAnchorPositioning && state.overlayParked && openPopover?.host !== el) {
          continue;
        }
        if (allowNativeSkip && nativeAnchorPositioning && openPopover?.host !== el) {
          // Native anchor wrappers need no per-scroll-frame JS: static offsets
          // plus natural scroller/viewport clipping keep the overlay glued to
          // the image. Shadow-DOM hosts fall back to viewport coordinates
          // (nativeAnchorWorksFor): nothing compositor-tracked holds their
          // badge on the image, so a scroll frame must still rewrite its
          // position. Only hosts with a real native binding may skip.
          const binding =
            (state.badge && nativeBadgeBindings.get(state.badge)) ||
            (state.unblurVeil && nativeVeilBindings.get(state.unblurVeil));
          if (binding) continue;
        }
        if (state.unblurVeil) positionUnblurVeil(el, state.unblurVeil);
        if (state.badge) {
          if (!positionBadge(el, state.badge, { deferHitTest: !hitTest }) && openPopover?.state === state) {
            closePopover();
          }
        }
      }
      if (openPopover) {
        if (!openPopover.host.isConnected) closePopover();
        else positionPopover(openPopover.host, openPopover.el);
      }
      if (hitTest) scheduleBadgeCollisionReconcile();
      else scheduleIdleHitTest();
    } catch {
      markContextInvalidated();
    }
  });
}
// capture:true catches scrolls of nested containers, not just the page.
window.addEventListener(
  'scroll',
  () => {
    lastScrollAt = performance.now();
    repositionAll();
  },
  { capture: true, passive: true },
);
window.addEventListener('resize', () => repositionAll({ allowNativeSkip: false }), { passive: true });

/** @param {string} id @param {HTMLElement} el */
function sweepOne(id, el) {
  const state = states.get(el);
  if (openPopover?.state === state) closePopover();
  if (state) removeUnblurVeil(state);
  removeBadge(state);
  viewportPriorityObserver.unobserve(el);
  layoutObserver.unobserve(el);
  overlayActivityObserver.unobserve(el);
  states.delete(el);
  byId.delete(id);
  if (el instanceof HTMLImageElement) {
    waitingForOrigin.delete(el);
    clearSearchThumbFallback(el);
  }
  scheduleBadgeCollisionReconcile();
}

// ---------------------------------------------------------------------------
// Scan port (reconnects across service-worker restarts)

/** @type {chrome.runtime.Port | null} */
let port = null;

// An extension reload, update, or disable orphans every content script already
// running in an open tab. The script keeps executing, but every chrome.* call
// throws "Extension context invalidated" from then on. That is unrecoverable
// from this side — only a page reload re-injects a live script — so the goal is
// to stop cleanly instead of throwing an uncaught error on each attempt.
/** True between pagehide and the matching pageshow so bfcache does not look like a dead worker. */
let suppressPortReconnect = false;
/** @type {ReturnType<typeof setInterval> | null} */
let hudTimer = null;

function extensionAlive() {
  if (contextInvalidated) return false;
  try {
    // chrome.runtime.id reads back undefined once the context is torn down.
    if (Boolean(chrome.runtime?.id)) return true;
  } catch {
    // Accessing chrome.runtime itself throws after an extension reload.
  }
  markContextInvalidated();
  return false;
}

/**
 * Stop an orphaned content script. After an extension reload every chrome.*
 * call and every access to an extension-owned node (closed-shadow badges)
 * throws "Extension context invalidated". Observers and rAF keep firing on
 * the old script until we disconnect them; only a page reload injects a live
 * one.
 */
function markContextInvalidated() {
  if (contextInvalidated) return;
  contextInvalidated = true;
  enabled = false;
  started = false;
  port = null;
  if (hudTimer) {
    clearInterval(hudTimer);
    hudTimer = null;
  }
  try {
    io.disconnect();
  } catch {
    /* already dead */
  }
  try {
    viewportPriorityObserver.disconnect();
  } catch {
    /* already dead */
  }
  try {
    overlayActivityObserver.disconnect();
  } catch {
    /* already dead */
  }
  try {
    layoutObserver.disconnect();
  } catch {
    /* already dead */
  }
  try {
    mo.disconnect();
  } catch {
    /* already dead */
  }
  try {
    closePopover();
  } catch {
    /* overlay node may already be inert */
  }
  try {
    hideOverlayNodes(document);
    removeOverlayNodes(document);
  } catch {
    /* already detached */
  }
  overlayRoot = null;
  deferredWhileHidden.clear();
  cancelUpgradeProbeWaiters();
  for (const [id, el] of [...byId]) {
    try {
      sweepOne(id, el);
    } catch {
      byId.delete(id);
      states.delete(el);
    }
  }
}

/** @returns {chrome.runtime.Port | null} */
function ensurePort() {
  if (port) return port;
  if (!extensionAlive()) return null;
  /** @type {chrome.runtime.Port} */
  let connected;
  try {
    connected = chrome.runtime.connect({ name: PORT_SCAN });
  } catch {
    // Lost the context between the liveness check and the connect.
    markContextInvalidated();
    return null;
  }
  port = connected;
  connected.onMessage.addListener(onScanUpdate);
  connected.onDisconnect.addListener(() => {
    // Reading lastError marks it checked — otherwise Chrome logs an
    // "Unchecked runtime.lastError" against the extension every time a tab
    // with an open port navigates into the back/forward cache.
    try {
      void chrome.runtime.lastError;
    } catch {
      markContextInvalidated();
      return;
    }
    // Pause and a later boot can replace this port before Chromium delivers
    // onDisconnect. Clearing the new port would drop live scans until reload.
    if (port !== connected) return;
    port = null;
    if (suppressPortReconnect || contextInvalidated || !enabled) return;
    if (!extensionAlive()) return;
    // Anything the dead worker was holding is gone with it. An inFlight entry
    // means "a request is already out for this URL" — after a disconnect that
    // is false for every entry, and leaving them in place makes the re-request
    // below short-circuit as a duplicate and never send, stranding every
    // in-flight image in `pending` for the life of the page. That is the exact
    // failure this reconnect exists to prevent. Covered by url-registry.test.js.
    registry.reset();
    // SW died or extension reloaded: re-request everything still pending.
    // no-model images are not pending — the latch converted them — so also
    // probe whether weights are usable now. Covered by model-gate.test.js.
    setTimeout(() => {
      if (suppressPortReconnect || !enabled || !extensionAlive()) return;
      void probeModelReadiness().then((status) => {
        if (status === 'recovered' || !enabled || !extensionAlive()) return;
        /** @type {HTMLElement | null} */
        let probeEl = null;
        /** @type {ImgState | null} */
        let probeState = null;
        for (const [, el] of byId) {
          const s = states.get(el);
          if (!s) continue;
          if (s.phase === 'pending') requestScan(el, s);
          else if (status === 'unavailable' && s.phase === 'no-model' && !probeEl) {
            probeEl = el;
            probeState = s;
          }
        }
        if (probeEl && probeState && modelGate.allowProbe()) {
          probeState.phase = 'pending';
          probeState.update = null;
          viewportPriorityObserver.observe(probeEl);
          renderBadge(probeEl, probeState);
          requestScan(probeEl, probeState);
        }
      });
    }, 250);
  });
  return port;
}

// Disconnect proactively when this page enters the back/forward cache, so the
// channel closes cleanly instead of being torn down by the browser. ensurePort
// reconnects lazily if the page is restored and scanning resumes.
window.addEventListener('pagehide', () => {
  suppressPortReconnect = true;
  try {
    port?.disconnect();
  } catch {
    markContextInvalidated();
  }
  port = null;
  // The worker is gone from this tab's point of view. Leaving inFlight set
  // strands pending badges after a bfcache restore: requestScan thinks a
  // reply is still coming.
  registry.reset();
});

window.addEventListener('pageshow', (event) => {
  suppressPortReconnect = false;
  if (!event.persisted || !extensionAlive()) return;
  // bfcache can miss storage.onChanged while frozen; re-read so Detection
  // off still holds after the user opens a new tab and comes back. A live
  // toggle that already landed must win over this snapshot.
  void chrome.storage.local
    .get([ENABLED_FLAG, BLUR_AI_FLAG])
    .then((got) => {
      const blur = readStoredFlag(receivedLiveBlur, got[BLUR_AI_FLAG], BLUR_AI_DEFAULT);
      if (blur !== null) applyBlurSetting(blur);
      const nextEnabled = readStoredFlag(receivedLiveEnabled, got[ENABLED_FLAG], true);
      if (nextEnabled !== null) applyEnabledSetting(nextEnabled);
      if (enabled) retryPendingScans();
    })
    .catch(() => {});
});

/** @param {HTMLElement} el @param {ImgState} state @param {number} [requestedPriority] */
function requestScan(el, state, requestedPriority) {
  if (!enabled || state.holdScan) return;
  const cached = registry.get(state.url);
  if (cached) {
    applyUpdate(el, state, cached);
    return;
  }
  if (modelGate.unavailable) {
    state.phase = 'no-model';
    renderBadge(el, state);
    return;
  }
  // One request per URL; every other image on that URL rides along.
  if (!registry.join(state.url, state.id)) return;

  const rect = el.getBoundingClientRect();
  const width = el instanceof HTMLImageElement && el.naturalWidth ? el.naturalWidth : Math.round(rect.width);
  const height = el instanceof HTMLImageElement && el.naturalHeight ? el.naturalHeight : Math.round(rect.height);
  const priority = requestedPriority ?? currentScanPriority(el);
  state.priority = Math.max(state.priority, priority);

  ensurePort()?.postMessage({
    type: MSG.SCAN_REQUEST,
    id: state.id,
    url: state.url,
    width,
    height,
    priority: state.priority,
  });
}

/** @returns {number} */
function countPendingScans() {
  let n = 0;
  for (const el of byId.values()) {
    const state = states.get(el);
    if (state?.phase === 'pending' && !state.holdScan) n += 1;
  }
  return n;
}

/** After bfcache restore, re-issue every pending request the freeze dropped. */
function retryPendingScans() {
  if (!enabled) return;
  for (const el of byId.values()) {
    const state = states.get(el);
    if (!state || state.phase !== 'pending' || state.holdScan) continue;
    requestScan(el, state, state.priority);
  }
}

/**
 * Promote the one in-flight URL job when any of its DOM copies enters the
 * viewport. This updates queued/fetched work in-place; it does not duplicate
 * inference or disturb URL memoization.
 * @param {ImgState} state
 * @param {number} priority
 */
function promoteScan(state, priority) {
  if (state.phase !== 'pending' || priority <= state.priority) return;
  state.priority = priority;
  const requestId = registry.requestIdFor(state.url);
  if (!requestId) return;
  ensurePort()?.postMessage({ type: MSG.SCAN_PRIORITY, id: requestId, priority });
}

/** @param {{type: string} & ScanUpdate} msg */
function onScanUpdate(msg) {
  if (!enabled) return;
  if (msg.type !== MSG.SCAN_UPDATE) return;
  const img = byId.get(msg.id);
  const state = img ? states.get(img) : undefined;
  // Prefer the echoed URL: the requesting node is often already gone on
  // infinite-scroll feeds, but other waiters on the same URL are not.
  const url = msg.url ?? state?.url ?? registry.urlForWaiter(msg.id);
  if (!url) return;

  if (msg.state === 'no-model' && modelGate.provenUsable) {
    retryStaleNoModel(url, msg.id);
    return;
  }
  if (msg.state === 'no-model') enterModelUnavailableState();

  if (msg.state === 'scored') registry.remember(url, msg);

  for (const id of registry.settle(url, msg.id)) {
    const el = byId.get(id);
    const s = el && states.get(el);
    if (el && s) applyUpdate(el, s, msg);
  }
}

/** @param {HTMLElement} el @param {ImgState} state @param {ScanUpdate} update */
function applyUpdate(el, state, update) {
  state.phase = update.state;
  state.update = { ...update, id: state.id };
  if (update.state !== 'pending') viewportPriorityObserver.unobserve(el);
  if (update.state === 'no-model') enterModelUnavailableState();
  else if (update.state === 'scored') onModelBecameUsable();
  if (DEV_BUILD && update.state === 'unscannable') {
    console.warn('[ai-image-detector] image could not be analyzed:', update.error, state.url);
  }
  renderBadge(el, state);
}

// ---------------------------------------------------------------------------
// Candidate discovery

/**
 * Attempt to turn a visible DOM image into a scan job.
 * @param {HTMLImageElement} img
 * @param {number} [priority]
 * @returns {boolean} true once this exact source is handled and may be unobserved
 */
function considerImage(img, priority) {
  if (!enabled) return false;
  let state = states.get(img);
  let url = img.currentSrc || img.src;

  // blob: URLs are document-scoped; the offscreen host cannot fetch them.
  // Resolve in this page (the only context that can) and scan the data URL.
  if (url.startsWith('blob:')) {
    const cachedBlob = blobResolved.get(img);
    if (cachedBlob && cachedBlob.src === url) {
      url = cachedBlob.dataUrl;
    } else {
      if (!blobInFlight.has(img)) {
        blobInFlight.add(img);
        void resolveBlobUrl(img, url);
      }
      showAwaitingSourceBadge(img, url);
      return false;
    }
  }

  // A thumbnail below the model's resize target would be UPSCALED into the
  // detector — its weakest regime, and one that skews toward false AI verdicts
  // on real photographs. Prefer a full-resolution source for the same image
  // when the page offers one. Candidates have to be loaded to be trusted, so
  // this mirrors the blob: path: bail now, re-enter once the answer is cached.
  // Runs only for loaded images; an unloaded one takes the wait-load path below
  // and comes back here with real dimensions.
  let isUpgradeRescan = false;
  if (img.complete && img.naturalWidth > 0) {
    const cachedUpgrade = upgradeResolved.get(img);
    const searchThumb = isSearchThumbnail(url);
    if (searchThumb && viewerOriginal && thumbBelongsToViewer(img, viewerOriginal.keys)) {
      // The right-hand viewer already named this picture. Score that file,
      // not the tile's imgurl or the encrypted-tbn re-encode.
      if (cachedUpgrade?.url !== viewerOriginal.url || cachedUpgrade.src !== url) {
        upgradeResolved.set(img, { src: url, url: viewerOriginal.url });
      }
      url = viewerOriginal.url;
      isUpgradeRescan = true;
    } else if (cachedUpgrade && cachedUpgrade.src === url && cachedUpgrade.url) {
      url = cachedUpgrade.url;
      isUpgradeRescan = true;
    } else if (upgradeInFlight.has(img)) {
      // A weak (linked) candidate is still being probed. Do not score the
      // thumbnail in the meantime: that is the Google Images grid-vs-preview
      // mismatch (tile badges the re-encode, preview badges the original).
      showAwaitingSourceBadge(img, url);
      return false;
    } else if (!cachedUpgrade || cachedUpgrade.src !== url || (searchThumb && !cachedUpgrade.url)) {
      const candidates = upgradeCandidatesFor(img, url);
      if (candidates.length === 0) {
        // Search-engine thumbs are the exception: Google attaches imgres?imgurl=
        // after first paint, so a miss must not be sticky — and must not be
        // scored. The encrypted-tbn JPEG is what made Hello Kitty art badge
        // AI 94% in the grid while the named original gated to 2% in preview.
        if (searchThumb && !searchThumbFallbackDue.has(img)) {
          waitingForOrigin.add(img);
          scheduleSearchThumbFallback(img);
          showAwaitingSourceBadge(img, url);
          return false;
        }
        if (!searchThumb) upgradeResolved.set(img, { src: url, url: null });
      } else {
        const sameFile = candidates.find((c) => c.confidence === 'same-file');
        if (sameFile) {
          // The page already named the original (imgurl, srcset, mediawiki).
          // Scan that URL now so a grid tile and the preview pane share one
          // job and one badge, instead of the thumbnail's false-AI score.
          waitingForOrigin.delete(img);
          clearSearchThumbFallback(img);
          upgradeResolved.set(img, { src: url, url: sameFile.url });
          url = sameFile.url;
          isUpgradeRescan = true;
        } else {
          upgradeInFlight.add(img);
          showAwaitingSourceBadge(img, url);
          void resolveUpgrade(img, url, candidates);
          return false;
        }
      }
    }
  }

  if (
    state &&
    state.url === url &&
    state.epoch === epoch &&
    state.phase !== 'no-model' &&
    state.phase !== 'skipped' &&
    !state.holdScan
  ) {
    // Keep watching search thumbs that still have no original: Google often
    // hydrates imgres?imgurl= after the first intersection callback. A
    // finished score (fallback already ran) must unobserve — MutationObserver
    // retries when the original lands.
    if (isSearchThumbnail(img.currentSrc || img.src) && !upgradeResolved.get(img)?.url) {
      if (state.phase === 'pending' || state.holdScan) return false;
      return true;
    }
    return true; // already handled this exact source in this epoch
  }
  // Carried into the replacement state only when the same picture is being
  // re-scanned at a better resolution, so the badge restates its current number
  // instead of blinking back to "AI …". Never carried across a real src change:
  // that is a different image and its score would be a lie.
  /** @type {ScanUpdate | null} */
  let carriedUpdate = null;
  let carriedBlurRevealed = false;
  let carriedBlurForced = false;
  if (state) {
    if (isUpgradeRescan && state.phase === 'scored') {
      carriedUpdate = state.update;
      carriedBlurRevealed = Boolean(state.blurRevealed);
      carriedBlurForced = Boolean(state.blurForced);
    }
    const wasSkipped = state.phase === 'skipped';
    // src/srcset changed, epoch advanced (re-enable / model ready), or a
    // previous no-model result should be retried now that weights exist.
    removeUnblurVeil(state);
    removeBadge(state);
    byId.delete(state.id);
    viewportPriorityObserver.unobserve(img);
    if (!wasSkipped) layoutObserver.unobserve(img);
    states.delete(img);
  }

  const rect = paintedRect(img);
  const candidate = classifyImageCandidate({
    url,
    complete: img.complete,
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
    displayedWidth: rect.width,
    displayedHeight: rect.height,
    minEdge: MIN_IMAGE_EDGE,
  });

  // Lazy image components commonly intersect before assigning src/srcset.
  // Keep observing them: a later source mutation resets the observation and
  // gives the now-usable image a fresh intersection callback.
  if (candidate === 'wait-source') return false;

  if (candidate === 'wait-load') {
    if (!waitingForLoad.has(img)) {
      waitingForLoad.add(img);
      img.addEventListener(
        'load',
        () => {
          waitingForLoad.delete(img);
          if (considerImage(img)) io.unobserve(img);
        },
        { once: true },
      );
    }
    return false;
  }
  if (candidate === 'skip') {
    states.set(img, {
      id: '',
      url,
      phase: 'skipped',
      badge: null,
      update: null,
      epoch,
      priority: SCAN_PRIORITY_NEAR,
    });
    if (Math.min(rect.width, rect.height) < MIN_IMAGE_EDGE) layoutObserver.observe(img);
    else layoutObserver.unobserve(img);
    return true;
  }

  // An upgrade rescan ADOPTED its URL from an existing binding — the viewer
  // original is already stamped on every matching tile, so there is nothing
  // new to publish. Publishing here also recurses without a base case: this
  // element's state was torn down above and is not rebuilt until beginScan,
  // so publishViewerOriginal → bindThumbToViewer → considerImage re-enters
  // this same element and overflows the stack (Google Images preview pane).
  if (
    !isUpgradeRescan &&
    !isSearchThumbnail(url) &&
    isPreviewPaneBox(img.getBoundingClientRect(), innerWidth)
  ) {
    publishViewerOriginal(img, url);
  }

  return beginScan(img, url, priority, carriedUpdate, carriedBlurRevealed, carriedBlurForced);
}

/**
 * Keep a no-model image in `byId` so MODEL_READY / a later scored update can
 * retry it. Returning true without state unobserves the node forever if the
 * ready broadcast was already missed.
 * @param {HTMLElement} el
 * @param {string} url
 * @param {number} [requestedPriority]
 * @param {ScanUpdate | null} [carriedUpdate] - previous verdict to keep on the
 *   badge while a higher-resolution re-scan of the SAME picture is in flight
 * @param {boolean} [carriedBlurRevealed]
 * @param {boolean} [carriedBlurForced]
 */
function beginScan(
  el,
  url,
  requestedPriority = currentScanPriority(el),
  carriedUpdate = null,
  carriedBlurRevealed = false,
  carriedBlurForced = false,
) {
  if (el instanceof HTMLImageElement) {
    waitingForOrigin.delete(el);
    clearSearchThumbFallback(el);
  }
  const id = `${pageId}:${++seq}`;
  /** @type {ImgState} */
  const state = {
    id,
    url,
    phase: modelGate.unavailable ? 'no-model' : 'pending',
    badge: null,
    update: carriedUpdate,
    epoch,
    priority: requestedPriority,
    ...(carriedBlurRevealed ? { blurRevealed: true } : {}),
    ...(carriedBlurForced ? { blurForced: true } : {}),
  };
  states.set(el, state);
  byId.set(id, el);
  layoutObserver.observe(el);
  viewportPriorityObserver.observe(el);
  renderBadge(el, state);
  requestScan(el, state, requestedPriority);
  return true;
}

/**
 * Keep a spinner on the image while blob inlining or a larger-source hunt
 * finishes. Scoring the thumbnail in that window is the grid-vs-preview
 * mismatch; showing nothing for hundreds of milliseconds looks stalled.
 * @param {HTMLElement} el
 * @param {string} url
 */
function showAwaitingSourceBadge(el, url) {
  if (!enabled || modelGate.unavailable) return;
  const rect = paintedRect(el);
  if (Math.min(rect.width, rect.height) < MIN_IMAGE_EDGE) return;

  const existing = states.get(el);
  if (existing && existing.epoch === epoch) {
    if (existing.holdScan && existing.phase === 'pending') {
      existing.url = url;
      existing.priority = Math.max(existing.priority, currentScanPriority(el));
      renderBadge(el, existing);
      return;
    }
    if (existing.phase !== 'skipped') return;
  }
  if (existing) {
    removeUnblurVeil(existing);
    removeBadge(existing);
    byId.delete(existing.id);
    viewportPriorityObserver.unobserve(el);
    layoutObserver.unobserve(el);
    states.delete(el);
  }

  const id = `${pageId}:${++seq}`;
  /** @type {ImgState} */
  const state = {
    id,
    url,
    phase: 'pending',
    badge: null,
    update: null,
    epoch,
    priority: currentScanPriority(el),
    holdScan: true,
  };
  states.set(el, state);
  byId.set(id, el);
  layoutObserver.observe(el);
  viewportPriorityObserver.observe(el);
  renderBadge(el, state);
}

/**
 * Same-visual overlay <a> next to an image. Search grids (Google Images) and
 * social feeds (X/Twitter) often put the imgurl / media link beside the <img>
 * rather than wrapping it, so `closest('a')` misses the original.
 * @param {HTMLImageElement} img
 * @returns {string | null}
 */
function overlaySourceHref(img) {
  const closest = img.closest('a');
  const hostRect = paintedRect(img);
  const imgArea = Math.max(0, hostRect.width * hostRect.height);
  /** @type {HTMLElement | null} */
  let ancestor = img.parentElement;
  for (let hostDistance = 1; ancestor && hostDistance <= 4; ancestor = ancestor.parentElement, hostDistance++) {
    const rootBox = ancestor.getBoundingClientRect();
    const rootArea = Math.max(0, rootBox.width * rootBox.height);
    if (imgArea > 0 && rootArea > imgArea * 12) break;
    const links = ancestor.querySelectorAll('a[href]');
    for (const node of links) {
      if (!(node instanceof HTMLAnchorElement) || !node.href || node === closest) continue;
      if (node.contains(img)) continue;
      const overlayRect = node.getBoundingClientRect();
      if (
        isSameVisualInteractionOverlay({
          hostRect,
          overlayRect,
          hostAncestorDistance: hostDistance,
          overlayAncestorDistance: 1,
          position: getComputedStyle(node).position,
        })
      ) {
        return node.href;
      }
    }
  }
  return null;
}

/** Query keys that name the original file, not the article. */
const ORIGIN_HREF = /[?&](?:imgurl|mediaurl|imageurl|image_url|ou|iu)=/i;

/**
 * Every href that might name this image's original. Google Images often puts
 * `imgres?imgurl=` on a descendant overlay or a sibling of a wrapper, not on
 * `img.closest('a')`.
 * @param {HTMLImageElement} img
 * @returns {string[]}
 */
function collectSourceHrefs(img) {
  /** @type {string[]} */
  const hrefs = [];
  const seen = new Set();
  /** @param {string | null | undefined} href */
  const add = (href) => {
    if (!href || seen.has(href)) return;
    seen.add(href);
    hrefs.push(href);
  };

  add(img.closest('a')?.href);
  add(overlaySourceHref(img));
  add(originHrefAtPoint(img));

  const hostRect = paintedRect(img);
  const imgArea = Math.max(0, hostRect.width * hostRect.height);
  /** @type {HTMLElement | null} */
  let root = img.parentElement;
  for (let depth = 1; root && depth <= 8 && root !== document.body; depth += 1, root = root.parentElement) {
    const rootBox = root.getBoundingClientRect();
    const rootArea = Math.max(0, rootBox.width * rootBox.height);
    const links =
      imgArea > 0 && rootArea > imgArea * 12
        ? root.querySelectorAll(':scope > a[href], :scope > * > a[href]')
        : root.querySelectorAll('a[href]');
    for (const a of links) {
      if (!(a instanceof HTMLAnchorElement) || !a.href) continue;
      if (!ORIGIN_HREF.test(a.href) && a !== img.closest('a')) continue;
      const box = a.getBoundingClientRect();
      const overlap = smallerRectOverlap(hostRect, {
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
      });
      if (a.contains(img) || overlap >= 0.25) add(a.href);
    }
  }

  const box = hostRect;
  if (box.left > innerWidth * 0.45 && Math.min(box.width, box.height) > 160) {
    add(location.href);
  }
  return hrefs;
}

/**
 * Covering search-result links are often nested (`div > a[href*=imgurl]`), so
 * a sibling walk misses them. The original is the href sitting on top of the
 * painted pixels.
 * @param {HTMLImageElement} img
 * @returns {string | null}
 */
function originHrefAtPoint(img) {
  const hostRect = paintedRect(img);
  if (!(hostRect.width > 0 && hostRect.height > 0)) return null;
  const x = hostRect.left + hostRect.width / 2;
  const y = hostRect.top + hostRect.height / 2;
  if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return null;
  try {
    for (const node of document.elementsFromPoint(x, y)) {
      if (!(node instanceof Element)) continue;
      const a = node instanceof HTMLAnchorElement ? node : node.closest('a');
      if (a?.href && ORIGIN_HREF.test(a.href)) return a.href;
    }
  } catch {
    return null;
  }
  return null;
}

/** @param {HTMLImageElement} img */
function clearSearchThumbFallback(img) {
  const timer = searchThumbFallbackTimer.get(img);
  if (timer) {
    clearTimeout(timer);
    searchThumbFallbackTimer.delete(img);
  }
}

/** @param {HTMLImageElement} img */
function scheduleSearchThumbFallback(img) {
  if (searchThumbFallbackDue.has(img) || searchThumbFallbackTimer.has(img)) return;
  searchThumbFallbackTimer.set(
    img,
    setTimeout(() => {
      searchThumbFallbackTimer.delete(img);
      searchThumbFallbackDue.add(img);
      if (considerImage(img)) io.unobserve(img);
    }, 800),
  );
}

/** Origins the viewer is naming for this picture. Grid tiles that name any of these are the same result. */
/** @param {HTMLImageElement} img @param {string} scanUrl @returns {Set<string>} */
function viewerOriginKeys(img, scanUrl) {
  /** @type {Set<string>} */
  const keys = new Set();
  /** @param {string | null | undefined} href */
  const add = (href) => {
    const key = imageResourceKey(href);
    if (key) keys.add(key);
  };
  add(scanUrl);
  add(imageUrlFromQuery(location.href));
  for (const href of collectSourceHrefs(img)) {
    add(imageUrlFromQuery(href));
    add(href);
  }
  const hostRect = paintedRect(img);
  for (const a of document.links) {
    if (!ORIGIN_HREF.test(a.href)) continue;
    const box = a.getBoundingClientRect();
    const overlap = smallerRectOverlap(hostRect, {
      left: box.left,
      top: box.top,
      right: box.right,
      bottom: box.bottom,
    });
    if (overlap < 0.15) continue;
    add(imageUrlFromQuery(a.href));
  }
  return keys;
}

/** @param {HTMLImageElement} img @param {Set<string>} keys */
function thumbNamesViewer(img, keys) {
  for (const href of collectSourceHrefs(img)) {
    const inner = imageUrlFromQuery(href) || href;
    const key = imageResourceKey(inner);
    if (key && keys.has(key)) return true;
  }
  return false;
}

/** @param {HTMLImageElement} img @param {Set<string>} keys */
function thumbBelongsToViewer(img, keys) {
  return thumbNamesViewer(img, keys);
}

/** @param {HTMLImageElement | null | undefined} thumb */
function bindThumbToViewer(thumb) {
  if (!thumb?.isConnected || !viewerOriginal) return;
  const src = thumb.currentSrc || thumb.src;
  if (!isSearchThumbnail(src) || src === viewerOriginal.url) return;
  const prev = upgradeResolved.get(thumb);
  const state = states.get(thumb);
  if (prev?.url === viewerOriginal.url && prev.src === src && state?.url === viewerOriginal.url) {
    return;
  }
  waitingForOrigin.delete(thumb);
  clearSearchThumbFallback(thumb);
  upgradeResolved.set(thumb, { src, url: viewerOriginal.url });
  if (considerImage(thumb)) io.unobserve(thumb);
}

/** Re-entrancy guard for publishViewerOriginal — see its doc comment. */
let publishingViewerOriginal = false;

/**
 * Stamp the viewer's file onto every grid tile that is this result.
 * Re-entrancy-guarded: bindThumbToViewer re-enters considerImage, and any
 * path back into this loop while it is still walking document.images would
 * recurse (or re-bind tiles already bound by the outer pass).
 * @param {HTMLImageElement} img
 * @param {string} scanUrl
 */
function publishViewerOriginal(img, scanUrl) {
  if (publishingViewerOriginal) return;
  if (!scanUrl || isSearchThumbnail(scanUrl)) return;
  try {
    const parsed = new URL(scanUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
  } catch {
    return;
  }
  const viewer = { url: scanUrl, keys: viewerOriginKeys(img, scanUrl) };
  viewerOriginal = viewer;
  publishingViewerOriginal = true;
  try {
    if (lastActivatedThumb) bindThumbToViewer(lastActivatedThumb);
    for (const thumb of document.images) {
      if (thumb === lastActivatedThumb) continue;
      if (!isSearchThumbnail(thumb.currentSrc || thumb.src)) continue;
      if (!thumbNamesViewer(thumb, viewer.keys)) continue;
      bindThumbToViewer(thumb);
    }
  } finally {
    publishingViewerOriginal = false;
  }
}

/** @param {Event} ev */
function rememberActivatedThumb(ev) {
  if (!(ev instanceof MouseEvent)) return;
  const path = ev.composedPath();
  for (const node of path) {
    if (!(node instanceof HTMLElement)) continue;
    // Show/unhide is cosmetic. Treating it as a grid-tile activation copied
    // the preview original onto the thumbnail and rescored AI → 2%.
    if (node.classList.contains('blur-veil')) return;
    if (node.classList.contains('blur-toggle')) return;
  }
  /** @type {HTMLImageElement | null} */
  let hit = null;
  for (const node of ev.composedPath()) {
    if (node instanceof HTMLImageElement) {
      hit = node;
      break;
    }
  }
  if (!hit) {
    const x = ev.clientX;
    const y = ev.clientY;
    let bestArea = Infinity;
    for (const img of document.images) {
      const rect = img.getBoundingClientRect();
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
      if (Math.min(rect.width, rect.height) < MIN_IMAGE_EDGE) continue;
      const area = rect.width * rect.height;
      if (area >= bestArea) continue;
      bestArea = area;
      hit = img;
    }
  }
  if (hit && isSearchThumbnail(hit.currentSrc || hit.src)) {
    const st = states.get(hit);
    const skipAdopt = Boolean(st && shouldBlurImage(st));
    if (skipAdopt) return;
    lastActivatedThumb = hit;
    const bind = Boolean(viewerOriginal && thumbNamesViewer(hit, viewerOriginal.keys));
    if (bind) bindThumbToViewer(hit);
  }
}

function retrySearchThumbnailUpgrades() {
  for (const img of waitingForOrigin) {
    if (!img.isConnected) {
      waitingForOrigin.delete(img);
      clearSearchThumbFallback(img);
      continue;
    }
    if (considerImage(img)) io.unobserve(img);
  }
  for (const el of byId.values()) {
    if (!(el instanceof HTMLImageElement)) continue;
    const src = el.currentSrc || el.src;
    if (!isSearchThumbnail(src)) continue;
    const bound = upgradeResolved.get(el)?.url;
    if (viewerOriginal ? bound === viewerOriginal.url : bound) continue;
    if (considerImage(el)) io.unobserve(el);
  }
}

/**
 * Larger-source candidates for one image, read off the DOM.
 * @param {HTMLImageElement} img
 * @param {string} url
 * @returns {import('./source-upgrade.js').UpgradeCandidate[]}
 */
function upgradeCandidatesFor(img, url) {
  const picture = img.parentElement instanceof HTMLPictureElement ? img.parentElement : null;
  const hrefs = collectSourceHrefs(img);
  return upgradeCandidates({
    current: url,
    shortEdge: Math.min(img.naturalWidth, img.naturalHeight),
    minShortEdge: OFFICIAL_RESIZE_SHORT_EDGE,
    base: document.baseURI,
    srcset: img.getAttribute('srcset') ?? picture?.querySelector('source[srcset]')?.getAttribute('srcset'),
    dataset: { ...img.dataset },
    linkHref: hrefs[0] ?? null,
    linkHrefs: hrefs.length > 1 ? hrefs.slice(1) : undefined,
    limit: UPGRADE_PROBE_LIMIT,
  });
}

let upgradeProbesActive = 0;
/** @type {Array<{resolve: () => void, reject: (reason?: unknown) => void}>} */
const upgradeProbeWaiters = [];

function acquireUpgradeProbeSlot() {
  if (upgradeProbesActive < UPGRADE_PROBE_CONCURRENCY) {
    upgradeProbesActive += 1;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    upgradeProbeWaiters.push({
      resolve: () => resolve(undefined),
      reject,
    });
  }).then(() => {
    upgradeProbesActive += 1;
  });
}

function releaseUpgradeProbeSlot() {
  upgradeProbesActive = Math.max(0, upgradeProbesActive - 1);
  const next = upgradeProbeWaiters.shift();
  if (next) next.resolve();
}

function cancelUpgradeProbeWaiters() {
  const err = new Error('cancelled');
  while (upgradeProbeWaiters.length > 0) {
    upgradeProbeWaiters.shift()?.reject(err);
  }
}

/**
 * Load a candidate far enough to read its intrinsic size.
 *
 * Dimensions are not tainted data, so this needs no CORS and never touches
 * pixels — and it warms the HTTP cache the offscreen fetch will hit moments
 * later. `no-referrer` deliberately matches how the offscreen host will fetch
 * it: a candidate that only loads because the page sent a Referer would pass
 * here and then 403 there, and we would have swapped a scannable thumbnail for
 * an unscannable original.
 *
 * @param {string} url
 * @returns {Promise<{width: number, height: number} | null>}
 */
function probeImageSize(url) {
  return acquireUpgradeProbeSlot().then(() =>
    new Promise((resolve) => {
      const probe = new Image();
      /** @type {ReturnType<typeof setTimeout>} */
      let timer;
      /** @param {{width: number, height: number} | null} value */
      const done = (value) => {
        clearTimeout(timer);
        probe.onload = null;
        probe.onerror = null;
        resolve(value);
      };
      timer = setTimeout(() => {
        // Replace the src to abort the stalled download. '' would resolve
        // against the document base URL and re-fetch the PAGE itself as an
        // "image"; an empty data: URL aborts without that spurious request.
        probe.src = 'data:,';
        done(null);
      }, UPGRADE_PROBE_TIMEOUT_MS);
      probe.onload = () =>
        done(probe.naturalWidth > 0 ? { width: probe.naturalWidth, height: probe.naturalHeight } : null);
      probe.onerror = () => done(null);
      probe.referrerPolicy = 'no-referrer';
      probe.decoding = 'async';
      probe.src = url;
    }).finally(releaseUpgradeProbeSlot),
  );
}

/**
 * Probe ranked candidates and keep the first that is genuinely bigger and still
 * the same picture. Records the outcome either way — including "nothing better"
 * — so a failed hunt costs one pass, not one per intersection.
 *
 * @param {HTMLImageElement} img
 * @param {string} src
 * @param {import('./source-upgrade.js').UpgradeCandidate[]} candidates
 */
async function resolveUpgrade(img, src, candidates) {
  const renderedAspect = img.naturalWidth / img.naturalHeight;
  const renderedShortEdge = Math.min(img.naturalWidth, img.naturalHeight);
  /** @type {string | null} */
  let chosen = null;
  /** @type {string | null} */
  let note = 'no larger source found';
  try {
    for (const candidate of candidates) {
      const probed = await probeImageSize(candidate.url);
      if (!probed) {
        // Missing, hotlink-blocked, or not an image at all.
        note = 'full-resolution source unreachable';
        continue;
      }
      if (Math.min(probed.width, probed.height) <= renderedShortEdge) {
        // A srcset descriptor lied, or the "original" is the thumbnail again.
        note = 'no larger source found';
        continue;
      }
      // Geometry is only consulted where provenance is weak. A search grid
      // crops its thumbnails, so a same-file original legitimately differs in
      // aspect from the tile naming it — vetoing that would discard the one
      // source that scores correctly. See source-upgrade.js.
      if (
        candidate.confidence === 'linked' &&
        Math.abs(Math.log(probed.width / probed.height / renderedAspect)) > UPGRADE_ASPECT_TOLERANCE
      ) {
        note = 'linked image is a different picture';
        continue;
      }
      chosen = candidate.url;
      note = null;
      break;
    }
  } catch (err) {
    note = 'source upgrade failed';
    if (DEV_BUILD) console.warn('[ai-image-detector] source upgrade failed:', err);
  } finally {
    upgradeResolved.set(img, { src, url: chosen, note });
    upgradeInFlight.delete(img);
    if (considerImage(img)) io.unobserve(img);
  }
}

/**
 * @param {HTMLImageElement} img
 * @param {string} blobUrl
 */
async function resolveBlobUrl(img, blobUrl) {
  try {
    const res = await fetch(blobUrl);
    const blob = await res.blob();
    if (blob.size > MAX_INLINE_SCAN_BYTES) {
      throw new Error(`blob too large to inline: ${blob.size} bytes`);
    }
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(/** @type {string} */ (reader.result));
      reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
      reader.readAsDataURL(blob);
    });
    blobResolved.set(img, { src: blobUrl, dataUrl });
    if (considerImage(img)) io.unobserve(img);
  } catch (err) {
    if (DEV_BUILD) console.warn('[ai-image-detector] blob: image not scannable:', err);
    const existing = states.get(img);
    if (existing) {
      removeUnblurVeil(existing);
      removeBadge(existing);
      byId.delete(existing.id);
      viewportPriorityObserver.unobserve(img);
      layoutObserver.unobserve(img);
    }
    states.set(img, {
      id: '',
      url: blobUrl,
      phase: 'skipped',
      badge: null,
      update: null,
      epoch,
      priority: SCAN_PRIORITY_NEAR,
    });
    io.unobserve(img);
  } finally {
    blobInFlight.delete(img);
  }
}

/**
 * CSS background-image candidate. Painted size only — there is no naturalWidth.
 * @param {HTMLElement} el
 * @param {number} [priority]
 * @returns {boolean}
 */
function considerBackground(el, priority) {
  if (!enabled) return false;
  const urls = cssBackgroundUrls(getComputedStyle(el).backgroundImage);
  const url = urls.find((u) => /^(https?:|data:)/.test(u));
  if (!url) return true; // not a content image; stop watching

  let state = states.get(el);
  if (
    state &&
    state.url === url &&
    state.epoch === epoch &&
    state.phase !== 'no-model' &&
    state.phase !== 'skipped'
  ) {
    return true;
  }
  if (state) {
    const wasSkipped = state.phase === 'skipped';
    removeUnblurVeil(state);
    removeBadge(state);
    byId.delete(state.id);
    viewportPriorityObserver.unobserve(el);
    if (!wasSkipped) layoutObserver.unobserve(el);
    states.delete(el);
  }

  const rect = el.getBoundingClientRect();
  const candidate = classifyPaintedCandidate({
    url,
    displayedWidth: rect.width,
    displayedHeight: rect.height,
    minEdge: MIN_IMAGE_EDGE,
  });
  if (candidate === 'wait-source') return false;
  if (candidate === 'skip') {
    states.set(el, {
      id: '',
      url,
      phase: 'skipped',
      badge: null,
      update: null,
      epoch,
      priority: SCAN_PRIORITY_NEAR,
    });
    if (Math.min(rect.width, rect.height) < MIN_IMAGE_EDGE) layoutObserver.observe(el);
    else layoutObserver.unobserve(el);
    return true;
  }

  return beginScan(el, url, priority);
}

/** @param {Element} el @param {number} [priority] */
function considerTarget(el, priority) {
  if (!enabled) return false;
  if (isOverlayNode(el)) return true;
  if (el instanceof HTMLImageElement) return considerImage(el, priority);
  if (el instanceof HTMLElement) return considerBackground(el, priority);
  return true;
}

/**
 * Assign one recency band to a viewport callback, then deterministic rank
 * within it. A later viewport always outranks stale visible work while the
 * largest/most central image in one paint gets the first slot.
 * @param {{target: Element, rect: {top: number, left: number, bottom: number, right: number}}[]} items
 * @param {(target: Element, priority: number) => void} visit
 */
function forEachVisibleByPriority(items, visit) {
  if (items.length === 0) return;
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  items.sort((a, b) => {
    const imageOrder = Number(b.target instanceof HTMLImageElement) - Number(a.target instanceof HTMLImageElement);
    return imageOrder || compareViewportCandidates(a.rect, b.rect, viewport);
  });
  const base = nextVisiblePriorityBase();
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item) continue;
    const rank = (items.length - i) / (items.length + 1);
    visit(item.target, base + rank);
  }
}

// Root-margin discovery starts downloads early. This second observer tracks
// the real viewport so a prefetched job can be promoted when the user reaches
// it instead of remaining behind stale work for the life of the queue.
const viewportPriorityObserver = new IntersectionObserver(
  (entries) => {
    if (!enabled || !started || contextInvalidated) return;
    if (document.visibilityState === 'hidden') return;
    const visible = entries
      .filter((entry) => entry.isIntersecting && entry.target instanceof Element)
      .map((entry) => ({ target: entry.target, rect: entry.boundingClientRect }));
    forEachVisibleByPriority(visible, (target, priority) => {
      if (!(target instanceof HTMLElement)) return;
      const state = states.get(target);
      if (state) {
        promoteScan(state, priority);
        if (state.phase === 'pending') renderBadge(target, state);
      }
    });
    if (visible.length > 0) repositionAll();
  },
  { rootMargin: '0px' },
);

// Layout commonly settles after an image's first intersection callback. A
// transient 0x0/thumbnail-sized box must not become a permanent skip, and a
// scored badge must follow responsive image/container resizing.
const layoutObserver = new ResizeObserver((entries) => {
  if (!enabled || !started || contextInvalidated) return;
  let reposition = false;
  for (const entry of entries) {
    if (!(entry.target instanceof HTMLElement)) continue;
    const state = states.get(entry.target);
    if (
      state?.phase === 'skipped' &&
      Math.min(entry.contentRect.width, entry.contentRect.height) >= MIN_IMAGE_EDGE
    ) {
      resetImageObservation(io, entry.target);
    }
    if (state?.badge || state?.unblurVeil) reposition = true;
  }
  if (reposition) repositionAll({ allowNativeSkip: false });
});

/**
 * How far outside the viewport an overlay host may drift before its per-frame
 * clip work is parked (px). Generous enough that the wake-up pass always lands
 * before the first pixel becomes visible, even on a fast flick scroll.
 */
const OVERLAY_ACTIVITY_MARGIN = 512;

/**
 * Scored hosts leave viewportPriorityObserver, so nothing else notices when a
 * badged image scrolls far away or comes back. While a host is outside this
 * margin its native anchor wrapper keeps the badge glued to the image without
 * any JS — repositionAll skips it instead of measuring and rewriting every
 * badge ever placed on every scroll frame. Re-entry clears the parked flag and
 * triggers repositionAll, which re-measures the host so a badge hidden (or
 * offset) while off screen is corrected before it is seen.
 */
const overlayActivityObserver = new IntersectionObserver(
  (entries) => {
    if (!enabled || !started || contextInvalidated) return;
    let wake = false;
    for (const entry of entries) {
      if (!(entry.target instanceof HTMLElement)) continue;
      const state = states.get(entry.target);
      if (!state) continue;
      const parked = !entry.isIntersecting;
      if (Boolean(state.overlayParked) === parked) continue;
      state.overlayParked = parked;
      if (!parked && (state.badge || state.unblurVeil)) wake = true;
    }
    if (wake) repositionAll();
  },
  { rootMargin: `${OVERLAY_ACTIVITY_MARGIN}px` },
);

/**
 * Park/wake tracking only pays off where native anchor positioning can hold
 * an overlay on its image without JS; the fixed-coordinate fallback still
 * needs per-frame updates.
 * @param {HTMLElement} el
 */
function watchOverlayActivity(el) {
  if (nativeAnchorPositioning) overlayActivityObserver.observe(el);
}

// Viewport-first: scanning is triggered ONLY from intersection callbacks.
// On-screen images are requested before rootMargin prefetch so they occupy
// the first fetch/infer slots on a crowded page.
const io = new IntersectionObserver(
  (entries) => {
    if (!enabled || !started || contextInvalidated) return;
    if (document.visibilityState === 'hidden') {
      for (const entry of entries) {
        if (entry.isIntersecting && entry.target instanceof Element) {
          deferredWhileHidden.add(entry.target);
        }
      }
      return;
    }
    /** @type {{target: Element, rect: DOMRectReadOnly}[]} */
    const visible = [];
    /** @type {Element[]} */
    const near = [];
    for (const entry of entries) {
      if (!entry.isIntersecting || !(entry.target instanceof Element)) continue;
      if (
        isRectInViewport(entry.boundingClientRect, {
          width: window.innerWidth,
          height: window.innerHeight,
        })
      ) {
        visible.push({ target: entry.target, rect: entry.boundingClientRect });
      } else {
        near.push(entry.target);
      }
    }
    forEachVisibleByPriority(visible, (el, priority) => {
      if (considerTarget(el, priority)) io.unobserve(el);
    });
    for (const el of near) {
      if (considerTarget(el, SCAN_PRIORITY_NEAR)) io.unobserve(el);
    }
  },
  { rootMargin: `${VIEWPORT_MARGIN}px` },
);

document.addEventListener('visibilitychange', () => {
  if (!enabled || !started || contextInvalidated) return;
  if (document.visibilityState === 'hidden') return;
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  /** @type {{target: Element, rect: DOMRectReadOnly}[]} */
  const resumedVisible = [];
  /** @type {Element[]} */
  const resumedNear = [];
  for (const el of deferredWhileHidden) {
    if (!(el instanceof Element) || !el.isConnected) continue;
    const rect = el.getBoundingClientRect();
    if (isRectInViewport(rect, viewport)) resumedVisible.push({ target: el, rect });
    else resumedNear.push(el);
  }
  deferredWhileHidden.clear();
  forEachVisibleByPriority(resumedVisible, (el, priority) => {
    if (considerTarget(el, priority)) io.unobserve(el);
  });
  const leftoverNear = resumedNear;
  scheduleIdle(() => {
    if (!enabled || !started || contextInvalidated) return;
    for (const el of leftoverNear) {
      if (el.isConnected && considerTarget(el, SCAN_PRIORITY_NEAR)) io.unobserve(el);
    }
  }, 400);
  /** @type {{target: Element, rect: DOMRectReadOnly}[]} */
  const visible = [];
  for (const [, el] of byId) {
    const state = states.get(el);
    if (state?.phase !== 'pending') continue;
    const rect = el.getBoundingClientRect();
    if (isRectInViewport(rect, viewport)) {
      visible.push({ target: el, rect });
    }
  }
  forEachVisibleByPriority(visible, (target, priority) => {
    if (!(target instanceof HTMLElement)) return;
    const state = states.get(target);
    if (state) {
      promoteScan(state, priority);
      if (state.phase === 'pending') renderBadge(target, state);
    }
  });
  repositionAll({ hitTest: true });
});

// Opacity/transform transitions can make the first placement hit-test occur
// before the image is actually paint-visible. These events do not necessarily
// resize or mutate the DOM, so retry occlusion on idle — never on every
// transitionend in a CSS-heavy page.
/** @param {Event} ev */
function onCompositorSettle(ev) {
  if (!(ev.target instanceof Element) || isOverlayNode(ev.target)) return;
  if (ev.target instanceof HTMLElement) {
    if (ev.target.classList.contains('badge') || ev.target.classList.contains('blur-veil')) return;
  }
  scheduleIdleHitTest();
}
document.addEventListener('transitionend', onCompositorSettle, { capture: true, passive: true });
document.addEventListener('animationend', onCompositorSettle, { capture: true, passive: true });

/** @param {ParentNode} root @param {(el: Element) => void} visit */
function walkTree(root, visit) {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (isOverlayNode(node)) continue;
    if (node instanceof HTMLImageElement) {
      visit(node);
      if (node.shadowRoot) stack.push(node.shadowRoot);
      continue;
    }
    if (node instanceof Element) {
      visit(node);
      if (node.shadowRoot) stack.push(node.shadowRoot);
      // Reverse-push for a LIFO stack so traversal/observation still follows
      // document reading order. The old loop visited the last card first,
      // making first-badge order depend on page structure.
      for (let i = node.children.length - 1; i >= 0; i -= 1) {
        const child = node.children[i];
        if (child) stack.push(child);
      }
    }
  }
}

/**
 * Settled verdicts keep their badges across Detection off. Re-observing them
 * on resume would re-enter considerImage for every tile on the page.
 * @param {Element} el
 */
function needsDiscoveryObserve(el) {
  if (!(el instanceof HTMLElement)) return true;
  const state = states.get(el);
  if (!state) return true;
  if (state.holdScan) return true;
  return state.phase !== 'scored' && state.phase !== 'unscannable';
}

/** @param {ParentNode} root */
function observeImages(root) {
  if (!enabled) return;
  if (root instanceof Element && isOverlayNode(root)) return;
  if (root instanceof HTMLImageElement) {
    if (needsDiscoveryObserve(root)) io.observe(root);
    return;
  }
  if (root instanceof Element) {
    /** @type {HTMLImageElement[]} */
    const images = [];
    /** @type {HTMLElement[]} */
    const backgrounds = [];
    walkTree(root, (el) => {
      if (el instanceof HTMLImageElement) images.push(el);
      else if (el instanceof HTMLElement && isBackgroundWatchTag(el.tagName)) backgrounds.push(el);
    });
    // Register real image nodes first. Background coverage still follows, but
    // thousands of ordinary wrapper elements no longer get to decide which
    // IntersectionObserver entries are handled before the page's images.
    for (const image of images) {
      if (needsDiscoveryObserve(image)) io.observe(image);
    }
    // Booting on an image-heavy document would otherwise register thousands of
    // wrapper IntersectionObservers before first paint. Incremental card
    // insertions stay synchronous so a newly painted hero is not delayed.
    if (root === document.documentElement && backgrounds.length > 32) {
      const deferred = backgrounds;
      scheduleIdle(() => {
        if (!enabled || !started || contextInvalidated) return;
        for (const background of deferred) {
          if (background.isConnected && needsDiscoveryObserve(background)) io.observe(background);
        }
      }, 400);
    } else {
      for (const background of backgrounds) {
        if (needsDiscoveryObserve(background)) io.observe(background);
      }
    }
    return;
  }
  if ('querySelectorAll' in root) {
    for (const img of root.querySelectorAll('img')) {
      if (needsDiscoveryObserve(img)) io.observe(img);
    }
  }
}

/** @param {Element} root */
function stopObservingTree(root) {
  walkTree(root, (el) => {
    io.unobserve(el);
    viewportPriorityObserver.unobserve(el);
    layoutObserver.unobserve(el);
    overlayActivityObserver.unobserve(el);
  });
}

const mo = new MutationObserver((records) => {
  if (!enabled || !started || contextInvalidated) return;
  let removed = false;
  let occlusionDirty = false;
  let retryThumbs = false;
  /** @type {Element[]} */
  const removedRoots = [];
  /** @type {Set<Element>} */
  const resetTargets = new Set();
  for (const rec of records) {
    for (const node of rec.addedNodes) {
      if (node instanceof Element && !isOverlayNode(node)) {
        observeImages(node);
        occlusionDirty = true;
        if (node instanceof HTMLAnchorElement || node.querySelector?.('a[href]')) {
          retryThumbs = true;
        }
      }
    }
    if (rec.removedNodes.length > 0) {
      removed = true;
      occlusionDirty = true;
      for (const node of rec.removedNodes) {
        if (node instanceof Element) removedRoots.push(node);
      }
    }
    if (rec.type === 'attributes' && rec.target instanceof Element) {
      if (isOverlayNode(rec.target)) continue;
      const name = rec.attributeName;
      if (rec.target instanceof HTMLImageElement) {
        if (attributeResetsObservation(true, name)) resetTargets.add(rec.target);
      } else if (name === 'href') {
        retryThumbs = true;
      } else if (attributeResetsObservation(false, name)) {
        occlusionDirty = true;
        if (rec.target instanceof HTMLElement && isBackgroundWatchTag(rec.target.tagName)) {
          resetTargets.add(rec.target);
        }
      }
    }
  }
  for (const el of resetTargets) resetImageObservation(io, el);
  if (retryThumbs) scheduleSearchThumbnailUpgradeRetry();
  if (removed) {
    for (const root of removedRoots) {
      // A framework can move a node in one mutation batch; its added-node path
      // already re-observed it, so only clean up roots that stayed detached.
      if (!root.isConnected) stopObservingTree(root);
    }
    for (const [id, el] of byId) {
      if (!el.isConnected) sweepOne(id, el);
    }
  }
  // Menus such as Google Search autocomplete cover the feed by inserting or
  // restyling page elements without scrolling. Occlusion is hit-tested on idle
  // so a class-churning grid does not elementsFromPoint every badge per frame.
  if (occlusionDirty) scheduleIdleHitTest();
});

// ---------------------------------------------------------------------------
// Boot / teardown

function boot() {
  if (started || contextInvalidated || !enabled) return;
  try {
    clearOverlayHide(document);
  } catch {
    /* document may not have a root yet */
  }
  // Wake the service worker and create the offscreen host while the page's
  // DOM is still being parsed, so the first badge does not wait on WASM.
  ensurePort();

  // document_start runs before Chromium guarantees a documentElement. Warm
  // the inference path immediately, then attach discovery as soon as the root
  // exists. The observer still sees every image added after that point.
  const root = document.documentElement;
  if (!root) {
    if (!waitingForDocumentRoot) {
      waitingForDocumentRoot = true;
      document.addEventListener(
        'readystatechange',
        () => {
          waitingForDocumentRoot = false;
          if (enabled) boot();
        },
        { once: true },
      );
    }
    return;
  }

  started = true;
  reobserveTrackedElements();
  observeImages(root);
  mo.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'srcset', 'style', 'class', 'href'],
  });
  resumePendingScans();
  syncAllImageBlurs();
  if (byId.size > 0) repositionAll({ allowNativeSkip: false });
  // One line, page console, so "is the scanner even running here?" is a
  // two-second question. Nothing sensitive is ever logged.
  console.info(
    `[ai-image-detector] scanner active in ${window === top ? 'top frame' : 'iframe'}, ` +
      `${document.images.length} <img> present at boot`,
  );
  if (DEV_BUILD && window === top) startHud();
}

function reobserveTrackedElements() {
  for (const el of byId.values()) {
    if (!el.isConnected) continue;
    layoutObserver.observe(el);
    viewportPriorityObserver.observe(el);
    const state = states.get(el);
    if (state?.badge || state?.unblurVeil) watchOverlayActivity(el);
  }
}

function resumePendingScans() {
  for (const [, el] of byId) {
    if (!el.isConnected) continue;
    const state = states.get(el);
    if (!state || state.holdScan) continue;
    if (state.phase === 'pending' || state.phase === 'no-model') requestScan(el, state);
  }
}

// ---------------------------------------------------------------------------
// Dev HUD: a corner pill showing live counts. Dev builds only — compiled out
// of release entirely. Answers "is the scanner running here, and what is it
// deciding?" without opening DevTools.

function startHud() {
  const root = ensureOverlay();
  let hud = root.querySelector('.hud');
  if (!hud) {
    hud = document.createElement('div');
    hud.className = 'hud';
    root.appendChild(hud);
  }
  if (hudTimer) {
    clearInterval(hudTimer);
    hudTimer = null;
  }
  const tick = () => {
    if (!extensionAlive()) return;
    const imgs = document.images.length;
    let queued = 0;
    let scored = 0;
    let skipped = 0;
    let failed = 0;
    let setup = 0;
    for (const [, el] of byId) {
      const s = states.get(el);
      if (!s) continue;
      if (s.phase === 'skipped') skipped++;
      else if (s.phase === 'scored') scored++;
      else if (s.phase === 'pending') queued++;
      else if (s.phase === 'unscannable') failed++;
      else if (s.phase === 'no-model') setup++;
    }
    hud.textContent =
      `AID dev · ${imgs} img · ${byId.size} tracked · ${scored} scored · ${queued} pending · ` +
      `${failed} failed · ${setup} setup · ${skipped} too-small`;
  };
  tick();
  hudTimer = setInterval(tick, 500);
}

/** Latest Detection value. Popup + SW fanout + storage.onChanged can all arrive. */
let enabledWanted = false;
/** @type {ReturnType<typeof setTimeout> | null} */
let enabledApplyTimer = null;

/** @param {boolean} on */
function applyEnabledSetting(on) {
  enabledWanted = Boolean(on);
  // Hide in this turn so off feels instant; the expensive pause waits one
  // task so a matching on in the same burst never tears the page down.
  if (!enabledWanted) {
    try {
      hideOverlayNodes(document);
    } catch {
      /* document may already be going away */
    }
  }
  if (enabledApplyTimer != null) return;
  enabledApplyTimer = setTimeout(flushEnabledSetting, 0);
}

function flushEnabledSetting() {
  enabledApplyTimer = null;
  const next = enabledWanted;
  if (next) {
    if (enabled && started) {
      try {
        clearOverlayHide(document);
      } catch {
        /* document may not have a root yet */
      }
      return;
    }
    enabled = true;
    if (!started) boot();
    return;
  }
  if (!enabled && !started) return;
  enabled = false;
  if (started) pauseScanning();
}

/**
 * Detection off: hide overlays and stop observers. Keep scored badges in the
 * DOM so turning it back on does not rebuild every native-anchor wrapper.
 */
function pauseScanning() {
  enabled = false;
  started = false;
  try {
    io.disconnect();
    viewportPriorityObserver.disconnect();
    layoutObserver.disconnect();
    overlayActivityObserver.disconnect();
    mo.disconnect();
  } catch {
    /* observers may already be idle */
  }
  if (hudTimer) {
    clearInterval(hudTimer);
    hudTimer = null;
  }
  try {
    hideOverlayNodes(document);
  } catch {
    /* document may already be going away */
  }
  try {
    closePopover();
  } catch {
    /* overlay may already be inert */
  }
  const openPort = port;
  port = null;
  try {
    openPort?.disconnect();
  } catch {
    markContextInvalidated();
  }
  registry.reset();
  cancelUpgradeProbeWaiters();
  if (!lastActivatedThumb?.isConnected) lastActivatedThumb = null;
}

function rescanVisible() {
  if (!enabled || !started) return;
  epoch += 1;
  observeImages(document.documentElement);
}

/** @param {boolean} on */
function applyBlurSetting(on) {
  const next = Boolean(on);
  const changed = next !== blurAiImages;
  blurAiImages = next;
  if (changed) {
    for (const el of byId.values()) {
      const state = states.get(el);
      if (!state) continue;
      state.blurRevealed = false;
      if (!next) state.blurForced = false;
    }
  }
  syncAllImageBlurs();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!extensionAlive()) return;
  if (msg?.type === MSG.ENABLED_SETTING) {
    receivedLiveEnabled = true;
    applyEnabledSetting(Boolean(msg.enabled));
    return;
  }
  if (msg?.type === MSG.BLUR_SETTING) {
    receivedLiveBlur = true;
    applyBlurSetting(msg.enabled);
    return;
  }
  if (msg?.type !== MSG.MODEL_READY) return;
  applyModelReady();
});

chrome.storage.local
  .get([ENABLED_FLAG, BLUR_AI_FLAG])
  .then((got) => {
    const blur = readStoredFlag(receivedLiveBlur, got[BLUR_AI_FLAG], BLUR_AI_DEFAULT);
    if (blur !== null) applyBlurSetting(blur);
    const nextEnabled = readStoredFlag(receivedLiveEnabled, got[ENABLED_FLAG], true);
    if (nextEnabled !== null) applyEnabledSetting(nextEnabled);
  })
  .catch((err) => {
    if (receivedLiveEnabled) return;
    const message = err instanceof Error ? err.message : String(err);
    if (/context invalidated/i.test(message)) {
      markContextInvalidated();
      return;
    }
    // Fail OPEN, never silent. A rejected storage read (storage unavailable)
    // previously left the scanner dead with no badge and no log —
    // indistinguishable from "not injected".
    console.warn('[ai-image-detector] storage read failed, scanning anyway:', err);
    enabled = true;
    boot();
  });

chrome.storage.onChanged.addListener((changes, area) => {
  if (!extensionAlive()) return;
  if (area !== 'local') return;
  if (BLUR_AI_FLAG in changes) {
    receivedLiveBlur = true;
    applyBlurSetting(blurFromStorage(changes[BLUR_AI_FLAG]?.newValue));
  }
  if (!(ENABLED_FLAG in changes)) return;
  receivedLiveEnabled = true;
  applyEnabledSetting(enabledFromStorage(changes[ENABLED_FLAG]?.newValue));
});
