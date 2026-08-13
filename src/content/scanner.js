/**
 * Content-script scanner: finds candidate images, requests verdicts, renders
 * score badges. Runs in every frame (all_frames: true — iframes are covered;
 * an evaluation harness that renders images inside a frame still gets scanned).
 *
 * Pixel access happens elsewhere: cross-origin canvas is tainted, so the
 * offscreen document fetches bytes itself. This script only observes the DOM.
 *
 * Engineering notes (each one is a competitor's shipped bug, avoided here):
 *  - Viewport prioritization is real: scans are requested from the
 *    IntersectionObserver callback only. There is no "querySelectorAll and
 *    queue everything" path that defeats it.
 *  - Per-element state lives in a WeakMap; removed images are swept and their
 *    badges removed — no unbounded growth on infinite-scroll pages.
 *  - Badges live in a closed shadow root so page CSS cannot restyle them, and
 *    are repositioned on capture-phase scroll events so nested scroll
 *    containers do not cause drift.
 *  - The scan port reconnects and re-requests pending images when the MV3
 *    service worker dies mid-scan.
 */

import { MSG, PORT_SCAN } from '../shared/messages.js';
import { MIN_IMAGE_EDGE, VIEWPORT_MARGIN, ENABLED_FLAG, DEV_BUILD } from '../shared/constants.js';

/** @typedef {import('../shared/messages.js').ScanUpdate} ScanUpdate */

/**
 * @typedef {Object} ImgState
 * @property {string} id
 * @property {string} url
 * @property {'pending' | 'scored' | 'unscannable' | 'no-model' | 'skipped'} phase
 * @property {HTMLElement | null} badge
 * @property {ScanUpdate | null} update
 */

let seq = 0;
const pageId = Math.random().toString(36).slice(2, 8);

/** @type {WeakMap<HTMLImageElement, ImgState>} */
const states = new WeakMap();
/** @type {Map<string, HTMLImageElement>} */
const byId = new Map();
/** @type {Map<string, ScanUpdate>} */
const urlCache = new Map();
/** @type {Map<string, Set<string>>} */
const pendingByUrl = new Map();

let enabled = true;

// ---------------------------------------------------------------------------
// Badge overlay (closed shadow root; page CSS cannot reach in)

/** @type {ShadowRoot | null} */
let overlayRoot = null;

function ensureOverlay() {
  if (overlayRoot) return overlayRoot;
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647;';
  overlayRoot = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    .badge {
      position: absolute;
      font: 600 11px/1.6 system-ui, sans-serif;
      color: #fff;
      padding: 0 7px;
      border-radius: 9px;
      pointer-events: auto;
      cursor: default;
      white-space: nowrap;
      box-shadow: 0 1px 4px rgba(0,0,0,.35);
      user-select: none;
    }
    .pending { background: rgba(90,90,96,.85); }
    .ai      { background: rgba(196,42,42,.92); }
    .real    { background: rgba(34,122,84,.92); }
    .setup   { background: rgba(178,124,0,.92); }
    .mock    { outline: 2px dashed rgba(255,255,255,.75); }
    .hud {
      position: fixed;
      bottom: 8px;
      left: 8px;
      background: rgba(20,20,26,.92);
      color: #f0b429;
      font: 600 11px/1.8 ui-monospace, monospace;
      padding: 0 10px;
      border-radius: 10px;
      border: 1px solid rgba(240,180,41,.4);
      pointer-events: none;
    }
  `;
  overlayRoot.appendChild(style);
  document.documentElement.appendChild(host);
  return overlayRoot;
}

/** @param {HTMLImageElement} img @param {ImgState} state */
function renderBadge(img, state) {
  const root = ensureOverlay();
  if (!state.badge) {
    state.badge = document.createElement('div');
    root.appendChild(state.badge);
  }
  const b = state.badge;
  const u = state.update;

  if (state.phase === 'pending') {
    b.className = 'badge pending';
    b.textContent = '…';
    b.title = 'Analyzing on-device';
  } else if (state.phase === 'scored' && u && typeof u.probability === 'number') {
    const pct = Math.round(u.probability * 100);
    b.className = `badge ${u.isAI ? 'ai' : 'real'}${u.engine === 'mock' ? ' mock' : ''}`;
    b.textContent = u.isAI ? `AI ${pct}%` : `${pct}%`;
    b.title =
      (u.engine === 'mock' ? 'DEV MOCK — not real inference\n' : '') +
      `P(AI-generated) = ${pct}% — analyzed on-device` +
      (u.contributions?.length
        ? '\n' + u.contributions.map((c) => `${c.name}: ${c.bits.toFixed(2)} bits`).join('\n')
        : '');
  } else if (state.phase === 'no-model') {
    b.className = 'badge setup';
    b.textContent = 'setup';
    b.title = 'Model weights not installed yet — open the extension popup';
  } else {
    // unscannable/skipped: no badge noise on broken or trivial images
    b.remove();
    state.badge = null;
    return;
  }
  positionBadge(img, b);
}

let loggedFirstBadge = false;

/** @param {HTMLImageElement} img @param {HTMLElement} badge */
function positionBadge(img, badge) {
  const rect = img.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    badge.style.display = 'none';
    return;
  }
  badge.style.display = '';
  badge.style.left = `${rect.left + window.scrollX + 4}px`;
  badge.style.top = `${rect.top + window.scrollY + 4}px`;

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
        left: badge.style.left,
        top: badge.style.top,
        renderedW: Math.round(br.width),
        renderedH: Math.round(br.height),
        hostConnected: badge.isConnected,
      }),
    );
  }
}

let repositionScheduled = false;
function repositionAll() {
  if (repositionScheduled) return;
  repositionScheduled = true;
  requestAnimationFrame(() => {
    repositionScheduled = false;
    for (const [id, img] of byId) {
      const state = states.get(img);
      if (state?.badge) {
        if (!img.isConnected) sweepOne(id, img);
        else positionBadge(img, state.badge);
      }
    }
  });
}
// capture:true catches scrolls of nested containers, not just the page.
window.addEventListener('scroll', repositionAll, { capture: true, passive: true });
window.addEventListener('resize', repositionAll, { passive: true });

/** @param {string} id @param {HTMLImageElement} img */
function sweepOne(id, img) {
  const state = states.get(img);
  state?.badge?.remove();
  if (state) state.badge = null;
  byId.delete(id);
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
    // SW died or extension reloaded: re-request everything still pending.
    setTimeout(() => {
      for (const [, img] of byId) {
        const s = states.get(img);
        if (s && s.phase === 'pending') requestScan(img, s);
      }
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

/** @param {HTMLImageElement} img @param {ImgState} state */
function requestScan(img, state) {
  const cached = urlCache.get(state.url);
  if (cached) {
    applyUpdate(img, state, cached);
    return;
  }
  let waiters = pendingByUrl.get(state.url);
  const alreadyInFlight = Boolean(waiters);
  if (!waiters) {
    waiters = new Set();
    pendingByUrl.set(state.url, waiters);
  }
  waiters.add(state.id);
  if (alreadyInFlight) return; // one request per URL; all waiters share it

  ensurePort().postMessage({
    type: MSG.SCAN_REQUEST,
    id: state.id,
    url: state.url,
    width: img.naturalWidth,
    height: img.naturalHeight,
  });
}

/** @param {{type: string} & ScanUpdate} msg */
function onScanUpdate(msg) {
  if (msg.type !== MSG.SCAN_UPDATE) return;
  const img = byId.get(msg.id);
  if (!img) return;
  const state = states.get(img);
  if (!state) return;

  if (msg.state === 'scored') urlCache.set(state.url, msg);

  // Deliver to every image waiting on this URL, not just the requester.
  const waiters = pendingByUrl.get(state.url) ?? new Set([msg.id]);
  pendingByUrl.delete(state.url);
  for (const id of waiters) {
    const el = byId.get(id);
    const s = el && states.get(el);
    if (el && s) applyUpdate(el, s, msg);
  }
}

/** @param {HTMLImageElement} img @param {ImgState} state @param {ScanUpdate} update */
function applyUpdate(img, state, update) {
  state.phase = update.state;
  state.update = { ...update, id: state.id };
  renderBadge(img, state);
}

// ---------------------------------------------------------------------------
// Candidate discovery

/** @param {HTMLImageElement} img */
function considerImage(img) {
  if (!enabled) return;
  let state = states.get(img);
  const url = img.currentSrc || img.src;

  if (state && state.url === url) return; // already handled this exact source
  if (state) {
    // src/srcset changed (lazy-load swap): reset and rescan.
    state.badge?.remove();
    byId.delete(state.id);
  }

  if (!url || !/^(https?:|data:)/.test(url)) return;

  if (!img.complete || img.naturalWidth === 0) {
    img.addEventListener('load', () => considerImage(img), { once: true });
    return;
  }
  if (Math.min(img.naturalWidth, img.naturalHeight) < MIN_IMAGE_EDGE) {
    states.set(img, { id: '', url, phase: 'skipped', badge: null, update: null });
    return;
  }

  const id = `${pageId}:${++seq}`;
  state = { id, url, phase: 'pending', badge: null, update: null };
  states.set(img, state);
  byId.set(id, img);
  renderBadge(img, state);
  requestScan(img, state);
}

// Viewport-first: scanning is triggered ONLY from intersection callbacks.
const io = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        considerImage(/** @type {HTMLImageElement} */ (entry.target));
        io.unobserve(entry.target);
      }
    }
  },
  { rootMargin: `${VIEWPORT_MARGIN}px` },
);

/** @param {ParentNode} root */
function observeImages(root) {
  if (root instanceof HTMLImageElement) {
    io.observe(root);
    return;
  }
  for (const img of root.querySelectorAll('img')) io.observe(img);
}

const mo = new MutationObserver((records) => {
  let removed = false;
  for (const rec of records) {
    for (const node of rec.addedNodes) {
      if (node instanceof Element) observeImages(node);
    }
    if (rec.removedNodes.length > 0) removed = true;
    if (
      rec.type === 'attributes' &&
      rec.target instanceof HTMLImageElement &&
      states.has(rec.target)
    ) {
      io.observe(rec.target); // re-evaluate on next intersection
    }
  }
  if (removed) {
    for (const [id, img] of byId) {
      if (!img.isConnected) sweepOne(id, img);
    }
  }
});

// ---------------------------------------------------------------------------
// Boot / teardown

function boot() {
  observeImages(document);
  mo.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'srcset'],
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
    for (const img of document.images) {
      const s = states.get(img);
      if (!s) continue;
      if (s.phase === 'skipped') skipped++;
      else if (s.phase === 'scored') scored++;
      else if (s.phase === 'pending') queued++;
    }
    hud.textContent = `AID dev · ${imgs} img · ${scored} scored · ${queued} pending · ${skipped} too-small`;
  };
  tick();
  setInterval(tick, 500);
}

function teardown() {
  io.disconnect();
  mo.disconnect();
  for (const [id, img] of byId) sweepOne(id, img);
  byId.clear();
  pendingByUrl.clear();
}

chrome.storage.local
  .get(ENABLED_FLAG)
  .then((got) => {
    const v = got[ENABLED_FLAG];
    enabled = v === undefined ? true : Boolean(v);
    if (enabled) boot();
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
