/**
 * Light-DOM markers for every node the scanner injects into the page.
 * Native-anchor badges live outside the closed-shadow overlay host, so
 * teardown cannot rely on removing that host alone.
 */

export const OVERLAY_ATTR = 'data-ai-image-detector';
export const OVERLAY_ATTR_VALUE = 'overlay';
export const OVERLAY_SELECTOR = `[${OVERLAY_ATTR}="${OVERLAY_ATTR_VALUE}"]`;
/**
 * Native wrappers from builds that did not stamp {@link OVERLAY_ATTR}.
 * Requires BOTH `position-anchor` and the `--aid-` prefix: a bare
 * `div[style*="--aid-"]` also matched page elements that merely use an
 * `--aid-*` custom property, and Detection-off / teardown then hid or REMOVED
 * page nodes. `position-anchor` with our prefix is wrapper-specific.
 */
export const LEGACY_OVERLAY_SELECTOR = 'div[style*="position-anchor"][style*="--aid-"]';
/** 0×0 overlay host used for hit-testing and non-native badges. */
export const LEGACY_HOST_SELECTOR =
  'div[style*="z-index:2147483647"][style*="width:0"][style*="height:0"]';
export const OVERLAY_HIDE_STYLE_ID = 'ai-image-detector-off';
export const OVERLAY_HIDE_CSS = `${OVERLAY_SELECTOR},${LEGACY_OVERLAY_SELECTOR},${LEGACY_HOST_SELECTOR}{display:none!important;visibility:hidden!important;pointer-events:none!important}`;

/**
 * Records that a node was hidden inline by {@link hideOverlayNodes}, with the
 * previous inline `display` declaration encoded as JSON `[value, priority]`.
 *
 * Native-anchor wrappers carry INLINE `all: initial !important` and
 * `display: block !important` (page CSS must not restyle them). An inline
 * !important declaration beats the hide stylesheet's !important rules, so on
 * any browser with anchor positioning the stylesheet alone left every badge
 * painted while Detection was off. The hide must therefore also be inline —
 * and reversible, since badges survive an off→on cycle by design.
 */
export const OVERLAY_INLINE_HIDE_ATTR = 'data-ai-image-detector-hidden';

/**
 * Hide one overlay node inline, recording the previous `display` declaration
 * for {@link restoreOverlayNodeInline}. No-op on nodes already hidden.
 * @param {{
 *   getAttribute?: (name: string) => string | null,
 *   setAttribute?: (name: string, value: string) => void,
 *   style?: {
 *     getPropertyValue: (name: string) => string,
 *     getPropertyPriority: (name: string) => string,
 *     setProperty: (name: string, value: string, priority?: string) => void,
 *   },
 * }} node
 */
export function hideOverlayNodeInline(node) {
  const style = node.style;
  if (!style || typeof style.setProperty !== 'function') return;
  if (typeof node.getAttribute === 'function' && node.getAttribute(OVERLAY_INLINE_HIDE_ATTR)) {
    return;
  }
  const previous = JSON.stringify([
    style.getPropertyValue('display'),
    style.getPropertyPriority('display'),
  ]);
  style.setProperty('display', 'none', 'important');
  node.setAttribute?.(OVERLAY_INLINE_HIDE_ATTR, previous);
}

/**
 * Undo {@link hideOverlayNodeInline}. No-op on nodes it never hid.
 * @param {{
 *   getAttribute?: (name: string) => string | null,
 *   removeAttribute?: (name: string) => void,
 *   style?: {
 *     setProperty: (name: string, value: string, priority?: string) => void,
 *     removeProperty: (name: string) => string,
 *   },
 * }} node
 */
export function restoreOverlayNodeInline(node) {
  if (typeof node.getAttribute !== 'function') return;
  const recorded = node.getAttribute(OVERLAY_INLINE_HIDE_ATTR);
  if (!recorded) return;
  node.removeAttribute?.(OVERLAY_INLINE_HIDE_ATTR);
  const style = node.style;
  if (!style || typeof style.setProperty !== 'function') return;
  try {
    const [value, priority] = /** @type {[string, string]} */ (JSON.parse(recorded));
    if (value) style.setProperty('display', value, priority || '');
    else style.removeProperty('display');
  } catch {
    style.removeProperty('display');
  }
}

const OVERLAY_FIND_SELECTORS = [
  OVERLAY_SELECTOR,
  LEGACY_OVERLAY_SELECTOR,
  LEGACY_HOST_SELECTOR,
];

/** @param {{setAttribute: (name: string, value: string) => void}} node */
export function markOverlayNode(node) {
  node.setAttribute(OVERLAY_ATTR, OVERLAY_ATTR_VALUE);
}

/** @param {unknown} node */
export function isOverlayNode(node) {
  if (!node || typeof node !== 'object') return false;
  const el = /** @type {{getAttribute?: (name: string) => string | null, localName?: string}} */ (
    node
  );
  if (typeof el.getAttribute !== 'function') return false;
  if (el.getAttribute(OVERLAY_ATTR) === OVERLAY_ATTR_VALUE) return true;
  if (el.localName !== 'div') return false;
  const style = el.getAttribute('style');
  // Same tightening as LEGACY_OVERLAY_SELECTOR: an unstamped wrapper sets
  // position-anchor to our --aid-* name; a page div with an --aid-* custom
  // property but no anchor positioning is page content, not our overlay.
  return (
    typeof style === 'string' && style.includes('position-anchor') && style.includes('--aid-')
  );
}

/**
 * @param {{querySelectorAll: (selector: string) => ArrayLike<{remove: () => void}>}} root
 * @returns {{remove: () => void}[]}
 */
export function overlayNodesIn(root) {
  /** @type {Set<{remove: () => void}>} */
  const seen = new Set();
  /** @type {{remove: () => void}[]} */
  const nodes = [];
  for (const selector of OVERLAY_FIND_SELECTORS) {
    const list = root.querySelectorAll(selector);
    for (let i = 0; i < list.length; i++) {
      const node = list[i];
      if (!node || seen.has(node)) continue;
      seen.add(node);
      nodes.push(node);
    }
  }
  return nodes;
}

/**
 * Instant hide, before the slower DOM removals. One stylesheet mutation so
 * Google Images does not relayout fifty times while badges are still painted —
 * plus an inline hide on every existing overlay node, because native-anchor
 * wrappers carry inline !important styles that beat the stylesheet.
 * @param {{
 *   createElement: (tag: string) => {id: string, textContent: string},
 *   documentElement?: {appendChild: Function} | null,
 *   getElementById?: (id: string) => unknown,
 *   querySelectorAll?: (selector: string) => ArrayLike<unknown>,
 * }} doc
 */
export function hideOverlayNodes(doc) {
  const root = doc.documentElement;
  if (!root) return;
  if (typeof doc.getElementById !== 'function' || !doc.getElementById(OVERLAY_HIDE_STYLE_ID)) {
    const style = doc.createElement('style');
    style.id = OVERLAY_HIDE_STYLE_ID;
    style.textContent = OVERLAY_HIDE_CSS;
    root.appendChild(style);
  }
  if (typeof doc.querySelectorAll !== 'function') return;
  const nodes = overlayNodesIn(
    /** @type {{querySelectorAll: (selector: string) => ArrayLike<{remove: () => void}>}} */ (
      /** @type {unknown} */ (doc)
    ),
  );
  for (let i = 0; i < nodes.length; i++) {
    const node = /** @type {Parameters<typeof hideOverlayNodeInline>[0] | undefined} */ (nodes[i]);
    if (node) hideOverlayNodeInline(node);
  }
}

/** @param {{getElementById?: (id: string) => {remove?: () => void} | null | undefined, querySelectorAll?: (selector: string) => ArrayLike<unknown>}} doc */
export function clearOverlayHide(doc) {
  const el = typeof doc.getElementById === 'function' ? doc.getElementById(OVERLAY_HIDE_STYLE_ID) : null;
  el?.remove?.();
  if (typeof doc.querySelectorAll !== 'function') return;
  const hidden = doc.querySelectorAll(`[${OVERLAY_INLINE_HIDE_ATTR}]`);
  for (let i = 0; i < hidden.length; i++) {
    const node = /** @type {Parameters<typeof restoreOverlayNodeInline>[0] | undefined} */ (
      hidden[i]
    );
    if (node) restoreOverlayNodeInline(node);
  }
}

/**
 * @param {{querySelectorAll: (selector: string) => ArrayLike<{remove: () => void}>}} root
 */
export function removeOverlayNodes(root) {
  const nodes = overlayNodesIn(root);
  for (let i = nodes.length - 1; i >= 0; i--) {
    nodes[i]?.remove();
  }
}
