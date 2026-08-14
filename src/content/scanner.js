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
 *  - The scan port reconnects and re-requests pending images when the MV3
 *    service worker dies mid-scan.
 */

import { MSG, PORT_SCAN, TARGET } from '../shared/messages.js';
import {
  MIN_IMAGE_EDGE,
  VIEWPORT_MARGIN,
  ENABLED_FLAG,
  DEV_BUILD,
  URL_CACHE_MAX,
  SCAN_PRIORITY_NEAR,
  SCAN_PRIORITY_VISIBLE,
} from '../shared/constants.js';
import { MAX_INLINE_SCAN_BYTES } from '../shared/inline-payload.js';
import {
  badgeAnchorPoint,
  classifyImageCandidate,
  classifyPaintedCandidate,
  cssBackgroundUrls,
  fittedImageRect,
  isHostTopmostAtPoint,
  isBackgroundWatchTag,
  isRectInViewport,
  resetImageObservation,
  shouldRenderBadge,
  shouldSuppressDuplicateBadge,
} from './candidate.js';
import { UrlRegistry } from './url-registry.js';
import { ModelGate } from './model-gate.js';

/** @typedef {import('../shared/messages.js').ScanUpdate} ScanUpdate */

/**
 * @typedef {Object} ImgState
 * @property {string} id
 * @property {string} url
 * @property {'pending' | 'scored' | 'unscannable' | 'no-model' | 'skipped'} phase
 * @property {HTMLElement | null} badge
 * @property {ScanUpdate | null} update
 * @property {number} epoch
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

let enabled = true;
let started = false;
let waitingForDocumentRoot = false;
const modelGate = new ModelGate();
/** Coalesces MODEL_READY + scored-exit so a double delivery does not bump epoch twice. */
let rescanQueued = false;
/** URLs already retried after a stale no-model while the model is proven usable. */
const staleNoModelRetried = new Set();

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
let nativeAnchorSeq = 0;
/**
 * Native anchor positioning lets Chromium move a badge in the same compositor
 * pass as its image. The wrapper remains in light DOM so its anchor name can
 * resolve to a page element; the visible badge stays inside a closed shadow.
 * @type {WeakMap<HTMLElement, {
 *   wrapper: HTMLElement,
 *   host: HTMLElement,
 *   anchorName: string,
 *   assignedAnchorNames: string,
 *   previousInlineAnchorNames: string,
 *   previousInlinePriority: string,
 *   scrollContainer: HTMLElement,
 *   positionLease: boolean,
 * }>}
 */
const nativeBadgeBindings = new WeakMap();
/**
 * Static scroll containers need to become containing blocks for their absolute
 * badge wrappers. Reference counting makes that temporary and reversible.
 * @type {WeakMap<HTMLElement, {
 *   count: number,
 *   previousInlinePosition: string,
 *   previousInlinePriority: string,
 * }>}
 */
const scrollContainerPositionLeases = new WeakMap();

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
    backdrop-filter: blur(2px);
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
  for (let parent = host.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    const scrollsY =
      /(auto|scroll|overlay)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight;
    const scrollsX =
      /(auto|scroll|overlay)/.test(style.overflowX) && parent.scrollWidth > parent.clientWidth;
    if (scrollsX || scrollsY) return parent;
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
 * Region a badge for `host` may occupy: the viewport, narrowed by the nearest
 * scrolling ancestor so a badge cannot be clamped outside its own scroller.
 * The container is passed in when the caller already has it cached.
 *
 * @param {HTMLElement} host
 * @param {HTMLElement} [scrollContainer]
 * @returns {{left: number, top: number, right: number, bottom: number}}
 */
function clipRectFor(host, scrollContainer) {
  const clip = {
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
  return clip;
}

/** @param {HTMLElement} container @returns {boolean} */
function acquireScrollContainerPosition(container) {
  if (container === document.documentElement) return false;
  const existing = scrollContainerPositionLeases.get(container);
  if (existing) {
    existing.count += 1;
    return true;
  }
  if (getComputedStyle(container).position !== 'static') return false;
  const lease = {
    count: 1,
    previousInlinePosition: container.style.getPropertyValue('position'),
    previousInlinePriority: container.style.getPropertyPriority('position'),
  };
  container.style.setProperty('position', 'relative', 'important');
  scrollContainerPositionLeases.set(container, lease);
  return true;
}

/** @param {HTMLElement} container */
function releaseScrollContainerPosition(container) {
  const lease = scrollContainerPositionLeases.get(container);
  if (!lease) return;
  lease.count -= 1;
  if (lease.count > 0) return;
  scrollContainerPositionLeases.delete(container);
  if (
    container.style.getPropertyValue('position') !== 'relative' ||
    container.style.getPropertyPriority('position') !== 'important'
  ) {
    return;
  }
  if (lease.previousInlinePosition) {
    container.style.setProperty(
      'position',
      lease.previousInlinePosition,
      lease.previousInlinePriority,
    );
  } else {
    container.style.removeProperty('position');
  }
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

function ensureOverlay() {
  if (overlayRoot) return overlayRoot;
  const host = document.createElement('div');
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
  if (!nativeAnchorPositioning) {
    const badge = document.createElement('div');
    ensureOverlay().appendChild(badge);
    return badge;
  }

  // positionBadge's hit test treats this single closed-shadow overlay as an
  // extension-owned node. Create it before that first placement check even
  // though the native badge itself is hosted by the scrolling container.
  ensureOverlay();

  const anchorName = `--aid-${pageId}-${++nativeAnchorSeq}`;
  const previousInlineAnchorNames = host.style.getPropertyValue('anchor-name');
  const previousInlinePriority = host.style.getPropertyPriority('anchor-name');
  const computedAnchorNames = getComputedStyle(host).getPropertyValue('anchor-name').trim();
  const assignedAnchorNames =
    computedAnchorNames && computedAnchorNames !== 'none'
      ? `${computedAnchorNames}, ${anchorName}`
      : anchorName;
  host.style.setProperty('anchor-name', assignedAnchorNames, 'important');

  const wrapper = document.createElement('div');
  wrapper.style.setProperty('all', 'initial', 'important');
  wrapper.style.setProperty('position', 'absolute', 'important');
  wrapper.style.setProperty('position-anchor', anchorName, 'important');
  wrapper.style.setProperty('left', 'anchor(left)', 'important');
  wrapper.style.setProperty('top', 'anchor(top)', 'important');
  // A zero-sized shadow host can be pruned from paint and the accessibility
  // tree even while its overflowing child is visible. Give the wrapper its
  // badge's intrinsic size; absolute positioning keeps it out of page layout.
  wrapper.style.setProperty('width', 'max-content', 'important');
  wrapper.style.setProperty('height', 'max-content', 'important');
  wrapper.style.setProperty('overflow', 'visible', 'important');
  wrapper.style.setProperty('pointer-events', 'none', 'important');
  wrapper.style.setProperty('z-index', '2147483647', 'important');

  const root = wrapper.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  // The native wrapper owns positioning; the shadow child only paints UI.
  style.textContent = `${overlayStyles}\n.badge { position: static; display: block; }`;
  const badge = document.createElement('div');
  root.append(style, badge);
  const scrollContainer = scrollContainerFor(host);
  const positionLease = acquireScrollContainerPosition(scrollContainer);
  scrollContainer.appendChild(wrapper);
  nativeBadgeBindings.set(badge, {
    wrapper,
    host,
    anchorName,
    assignedAnchorNames,
    previousInlineAnchorNames,
    previousInlinePriority,
    scrollContainer,
    positionLease,
  });
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
  if (!binding) {
    badge.remove();
    state.badge = null;
    return;
  }

  binding.wrapper.remove();
  if (binding.positionLease) releaseScrollContainerPosition(binding.scrollContainer);
  nativeBadgeBindings.delete(badge);
  const current = binding.host.style.getPropertyValue('anchor-name');
  if (current === binding.assignedAnchorNames) {
    if (binding.previousInlineAnchorNames) {
      binding.host.style.setProperty(
        'anchor-name',
        binding.previousInlineAnchorNames,
        binding.previousInlinePriority,
      );
    } else {
      binding.host.style.removeProperty('anchor-name');
    }
  } else {
    // Preserve a page update made while the badge existed; remove only ours.
    const remaining = current
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name && name !== binding.anchorName);
    if (remaining.length > 0) {
      binding.host.style.setProperty('anchor-name', remaining.join(', '), 'important');
    } else {
      binding.host.style.removeProperty('anchor-name');
    }
  }
  state.badge = null;
}

/** @param {HTMLElement} el @param {ImgState} state */
function renderBadge(el, state) {
  const u = state.update;
  if (!shouldRenderBadge(state.phase, u?.probability, window !== top)) {
    // Pending work is intentionally silent. Rendering an ellipsis immediately
    // for every candidate turns image search and gallery pages into a field of
    // extension controls, and layered preview images can briefly show several.
    removeBadge(state);
    if (openPopover?.state === state) closePopover();
    scheduleBadgeCollisionReconcile();
    return;
  }

  if (!state.badge) {
    state.badge = createBadge(el);
  }
  const b = state.badge;
  b.onclick = null;

  if (state.phase === 'no-model') {
    b.className = 'badge setup';
    b.textContent = 'SETUP';
    b.title = 'Open the extension popup to install the on-device model';
  } else if (u && typeof u.probability === 'number') {
    const pct = Math.round(u.probability * 100);
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
  const visible = positionBadge(el, b);
  scheduleBadgeCollisionReconcile();
  if (openPopover?.state === state) {
    if (visible) positionPopover(el, openPopover.el);
    else closePopover();
  }
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
  if (rescanQueued) return;
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
  const pct = Math.round(u.probability * 100);
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
  add(`P(AI) ${pct}%`);
  add(`${u.isAI ? 'Verdict: AI-generated' : 'Verdict: likely real'} at 0.65`, 'k');
  if (u.contributions?.length) {
    for (const c of u.contributions) {
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
 * @param {HTMLElement} host
 * @param {HTMLElement} badge
 * @returns {boolean}
 */
function positionBadge(host, badge) {
  const rect = paintedRect(host);
  const nativeBinding = nativeBadgeBindings.get(badge);
  if (rect.width <= 0 || rect.height <= 0 || isVisuallyHidden(host)) {
    badge.style.display = 'none';
    return false;
  }

  // Anchoring to the image's own corner loses the badge the moment that corner
  // scrolls off; clamp to the visible intersection so it tracks the edge.
  const anchor = badgeAnchorPoint({
    rect,
    clip: clipRectFor(host, nativeBinding?.scrollContainer),
    inset: BADGE_INSET,
    minVisible: BADGE_MIN_VISIBLE,
  });
  const anchorX = anchor.x;
  const anchorY = anchor.y;
  const overlayHost = overlayRoot?.host;
  /** @type {unknown[]} */
  const overlayNodes = [badge];
  if (nativeBinding) overlayNodes.push(nativeBinding.wrapper);
  if (setupNotice) overlayNodes.push(setupNotice);
  if (openPopover?.el) overlayNodes.push(openPopover.el);
  if (
    !anchor.visible ||
    !overlayHost ||
    !isHostTopmostAtPoint(host, document.elementsFromPoint(anchorX, anchorY), overlayHost, overlayNodes)
  ) {
    // The overlay intentionally sits above page UI. Hide its badge when the
    // labelled image has scrolled underneath a sticky header (or another page
    // control), otherwise the badge appears to float on the fixed chrome.
    badge.style.display = 'none';
    return false;
  }
  badge.style.display = '';
  if (nativeBinding) {
    // Anchor to the element's border box natively, then retain the painted-pixel
    // offset for object-fit:contain images. While the image is fully visible
    // these offsets are constant, so Chromium keeps moving the badge on the
    // compositor and setImportantStyle no-ops; they only change once the image
    // is clipped, and the scroll listener below refreshes them per frame.
    const box = host.getBoundingClientRect();
    const offsetX = anchorX - box.left;
    const offsetY = anchorY - box.top;
    setImportantStyle(nativeBinding.wrapper, 'left', `calc(anchor(left) + ${offsetX}px)`);
    setImportantStyle(nativeBinding.wrapper, 'top', `calc(anchor(top) + ${offsetY}px)`);
  } else {
    // Chrome 116-124 fallback: keep DOMRect and overlay in viewport space.
    badge.style.left = `${anchorX}px`;
    badge.style.top = `${anchorY}px`;
  }

  // Dev builds report the first badge placement once, so "created but
  // invisible" is distinguishable from "never created" without DevTools
  // element hunting.
  if (DEV_BUILD && !loggedFirstBadge) {
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
  return true;
}

let repositionScheduled = false;
let collisionReconcileScheduled = false;

function scheduleBadgeCollisionReconcile() {
  if (collisionReconcileScheduled) return;
  collisionReconcileScheduled = true;
  requestAnimationFrame(() => {
    collisionReconcileScheduled = false;
    reconcileBadgeCollisions();
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

function repositionAll() {
  if (repositionScheduled) return;
  repositionScheduled = true;
  requestAnimationFrame(() => {
    repositionScheduled = false;
    for (const [id, el] of byId) {
      const state = states.get(el);
      if (state?.badge) {
        if (!el.isConnected) sweepOne(id, el);
        else if (!positionBadge(el, state.badge) && openPopover?.state === state) closePopover();
      }
    }
    if (openPopover) {
      if (!openPopover.host.isConnected) closePopover();
      else positionPopover(openPopover.host, openPopover.el);
    }
    scheduleBadgeCollisionReconcile();
  });
}
// capture:true catches scrolls of nested containers, not just the page.
window.addEventListener('scroll', repositionAll, { capture: true, passive: true });
window.addEventListener('resize', repositionAll, { passive: true });

/** @param {string} id @param {HTMLElement} el */
function sweepOne(id, el) {
  const state = states.get(el);
  if (openPopover?.state === state) closePopover();
  removeBadge(state);
  states.delete(el);
  byId.delete(id);
  scheduleBadgeCollisionReconcile();
}

// ---------------------------------------------------------------------------
// Scan port (reconnects across service-worker restarts)

/** @type {chrome.runtime.Port | null} */
let port = null;

function ensurePort() {
  if (port) return port;
  port = chrome.runtime.connect({ name: PORT_SCAN });
  port.onMessage.addListener(onScanUpdate);
  port.onDisconnect.addListener(() => {
    // Reading lastError marks it checked — otherwise Chrome logs an
    // "Unchecked runtime.lastError" against the extension every time a tab
    // with an open port navigates into the back/forward cache.
    void chrome.runtime.lastError;
    port = null;
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
      void probeModelReadiness().then((status) => {
        if (status === 'recovered') return;
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
  port?.disconnect();
  port = null;
});

/** @param {HTMLElement} el @param {ImgState} state */
function requestScan(el, state) {
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
  const priority = isRectInViewport(rect, { width: window.innerWidth, height: window.innerHeight })
    ? SCAN_PRIORITY_VISIBLE
    : SCAN_PRIORITY_NEAR;

  ensurePort().postMessage({
    type: MSG.SCAN_REQUEST,
    id: state.id,
    url: state.url,
    width,
    height,
    priority,
  });
}

/** @param {{type: string} & ScanUpdate} msg */
function onScanUpdate(msg) {
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
 * @returns {boolean} true once this exact source is handled and may be unobserved
 */
function considerImage(img) {
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
      return false;
    }
  }

  if (state && state.url === url && state.epoch === epoch && state.phase !== 'no-model') {
    return true; // already handled this exact source in this epoch
  }
  if (state) {
    // src/srcset changed, epoch advanced (re-enable / model ready), or a
    // previous no-model result should be retried now that weights exist.
    removeBadge(state);
    byId.delete(state.id);
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
    states.set(img, { id: '', url, phase: 'skipped', badge: null, update: null, epoch });
    return true;
  }

  return beginScan(img, url);
}

/**
 * Keep a no-model image in `byId` so MODEL_READY / a later scored update can
 * retry it. Returning true without state unobserves the node forever if the
 * ready broadcast was already missed.
 * @param {HTMLElement} el
 * @param {string} url
 */
function beginScan(el, url) {
  const id = `${pageId}:${++seq}`;
  /** @type {ImgState} */
  const state = {
    id,
    url,
    phase: modelGate.unavailable ? 'no-model' : 'pending',
    badge: null,
    update: null,
    epoch,
  };
  states.set(el, state);
  byId.set(id, el);
  renderBadge(el, state);
  requestScan(el, state);
  return true;
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
    states.set(img, { id: '', url: blobUrl, phase: 'skipped', badge: null, update: null, epoch });
    io.unobserve(img);
  } finally {
    blobInFlight.delete(img);
  }
}

/**
 * CSS background-image candidate. Painted size only — there is no naturalWidth.
 * @param {HTMLElement} el
 * @returns {boolean}
 */
function considerBackground(el) {
  if (!enabled) return false;
  const urls = cssBackgroundUrls(getComputedStyle(el).backgroundImage);
  const url = urls.find((u) => /^(https?:|data:)/.test(u));
  if (!url) return true; // not a content image; stop watching

  let state = states.get(el);
  if (state && state.url === url && state.epoch === epoch && state.phase !== 'no-model') {
    return true;
  }
  if (state) {
    removeBadge(state);
    byId.delete(state.id);
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
    states.set(el, { id: '', url, phase: 'skipped', badge: null, update: null, epoch });
    return true;
  }

  return beginScan(el, url);
}

/** @param {Element} el */
function considerTarget(el) {
  if (el instanceof HTMLImageElement) return considerImage(el);
  if (el instanceof HTMLElement) return considerBackground(el);
  return true;
}

// Viewport-first: scanning is triggered ONLY from intersection callbacks.
// On-screen images are requested before rootMargin prefetch so they occupy
// the first fetch/infer slots on a crowded page.
const io = new IntersectionObserver(
  (entries) => {
    /** @type {Element[]} */
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
        visible.push(entry.target);
      } else {
        near.push(entry.target);
      }
    }
    for (const el of visible) {
      if (considerTarget(el)) io.unobserve(el);
    }
    for (const el of near) {
      if (considerTarget(el)) io.unobserve(el);
    }
  },
  { rootMargin: `${VIEWPORT_MARGIN}px` },
);

/** @param {ParentNode} root @param {(el: Element) => void} visit */
function walkTree(root, visit) {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node instanceof HTMLImageElement) {
      visit(node);
      if (node.shadowRoot) stack.push(node.shadowRoot);
      continue;
    }
    if (node instanceof Element) {
      visit(node);
      if (node.shadowRoot) stack.push(node.shadowRoot);
      for (let i = 0; i < node.children.length; i += 1) {
        const child = node.children[i];
        if (child) stack.push(child);
      }
    }
  }
}

/** @param {ParentNode} root */
function observeImages(root) {
  if (root instanceof HTMLImageElement) {
    io.observe(root);
    return;
  }
  if (root instanceof Element) {
    walkTree(root, (el) => {
      if (el instanceof HTMLImageElement) io.observe(el);
      else if (el instanceof HTMLElement && isBackgroundWatchTag(el.tagName)) io.observe(el);
    });
    return;
  }
  if ('querySelectorAll' in root) {
    for (const img of root.querySelectorAll('img')) io.observe(img);
  }
}

const mo = new MutationObserver((records) => {
  let removed = false;
  for (const rec of records) {
    for (const node of rec.addedNodes) {
      if (node instanceof Element) observeImages(node);
    }
    if (rec.removedNodes.length > 0) removed = true;
    if (rec.type === 'attributes' && rec.target instanceof Element) {
      // Re-observing an already observed element is a no-op. Reset it so an
      // intersecting lazy image whose first callback had no usable URL gets a
      // new callback for the assigned source — and so a CSS class swap that
      // paints a background image is not missed.
      resetImageObservation(io, rec.target);
    }
  }
  if (removed) {
    for (const [id, el] of byId) {
      if (!el.isConnected) sweepOne(id, el);
    }
  }
  // Menus such as Google Search autocomplete cover the feed by inserting or
  // restyling page elements without scrolling. Re-run the same hit test used
  // for sticky headers so badges underneath a newly opened overlay disappear
  // immediately (and return when it closes).
  repositionAll();
});

// ---------------------------------------------------------------------------
// Boot / teardown

function boot() {
  if (started) return;
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
  observeImages(root);
  mo.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'srcset', 'style', 'class'],
  });
  // One line, page console, so "is the scanner even running here?" is a
  // two-second question. Nothing sensitive is ever logged.
  console.info(
    `[ai-image-detector] scanner active in ${window === top ? 'top frame' : 'iframe'}, ` +
      `${document.images.length} <img> present at boot`,
  );
  if (DEV_BUILD && window === top) startHud();
}

// ---------------------------------------------------------------------------
// Dev HUD: a corner pill showing live counts. Dev builds only — compiled out
// of release entirely. Answers "is the scanner running here, and what is it
// deciding?" without opening DevTools.

function startHud() {
  const root = ensureOverlay();
  const hud = document.createElement('div');
  hud.className = 'hud';
  root.appendChild(hud);
  const tick = () => {
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
  setInterval(tick, 500);
}

function teardown() {
  started = false;
  epoch += 1;
  modelGate.reset();
  staleNoModelRetried.clear();
  clearSetupNotice();
  closePopover();
  io.disconnect();
  mo.disconnect();
  port?.disconnect();
  port = null;
  for (const [id, el] of byId) sweepOne(id, el);
  byId.clear();
  registry.reset();
}

function rescanVisible() {
  epoch += 1;
  observeImages(document.documentElement);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== MSG.MODEL_READY) return;
  applyModelReady();
});

chrome.storage.local
  .get(ENABLED_FLAG)
  .then((got) => {
    const v = got[ENABLED_FLAG];
    enabled = v === undefined ? true : Boolean(v);
    if (enabled) boot();
    else teardown();
  })
  .catch((err) => {
    // Fail OPEN, never silent. A rejected storage read (orphaned context after
    // an extension reload, storage unavailable) previously left the scanner
    // dead with no badge and no log — indistinguishable from "not injected".
    console.warn('[ai-image-detector] storage read failed, scanning anyway:', err);
    enabled = true;
    boot();
  });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(ENABLED_FLAG in changes)) return;
  const v = changes[ENABLED_FLAG]?.newValue;
  enabled = v === undefined ? true : Boolean(v);
  if (enabled) boot();
  else teardown();
});
