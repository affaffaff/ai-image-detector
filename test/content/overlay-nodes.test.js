import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LEGACY_HOST_SELECTOR,
  LEGACY_OVERLAY_SELECTOR,
  OVERLAY_ATTR,
  OVERLAY_ATTR_VALUE,
  OVERLAY_HIDE_STYLE_ID,
  OVERLAY_INLINE_HIDE_ATTR,
  OVERLAY_SELECTOR,
  clearOverlayHide,
  hideOverlayNodeInline,
  hideOverlayNodes,
  isOverlayNode,
  markOverlayNode,
  overlayNodesIn,
  removeOverlayNodes,
  restoreOverlayNodeInline,
} from '../../src/content/overlay-nodes.js';

test('markOverlayNode stamps the teardown selector', () => {
  /** @type {Record<string, string>} */
  const attrs = {};
  markOverlayNode({
    setAttribute(name, value) {
      attrs[name] = value;
    },
  });
  assert.equal(attrs[OVERLAY_ATTR], OVERLAY_ATTR_VALUE);
  assert.equal(OVERLAY_SELECTOR, `[${OVERLAY_ATTR}="${OVERLAY_ATTR_VALUE}"]`);
});

test('isOverlayNode matches marked hosts and leftover native wrappers, not images', () => {
  assert.equal(
    isOverlayNode({
      localName: 'div',
      getAttribute(/** @type {string} */ name) {
        return name === OVERLAY_ATTR ? OVERLAY_ATTR_VALUE : null;
      },
    }),
    true,
  );
  assert.equal(
    isOverlayNode({
      localName: 'div',
      getAttribute(/** @type {string} */ name) {
        return name === 'style' ? 'position-anchor: --aid-ab12-1' : null;
      },
    }),
    true,
  );
  assert.equal(
    isOverlayNode({
      localName: 'img',
      getAttribute(/** @type {string} */ name) {
        return name === 'style' ? 'anchor-name: --aid-ab12-1' : null;
      },
    }),
    false,
  );
  // A page div that merely uses an --aid-* custom property (no anchor
  // positioning) is page content: hiding/removing it on teardown is a bug.
  assert.equal(
    isOverlayNode({
      localName: 'div',
      getAttribute(/** @type {string} */ name) {
        return name === 'style' ? 'color: var(--aid-brand, red)' : null;
      },
    }),
    false,
  );
});

test('overlayNodesIn collects marked, leftover wrapper, and 0x0 host nodes once', () => {
  const marked = { id: 'marked', remove() {} };
  const legacy = { id: 'legacy', remove() {} };
  const host = { id: 'host', remove() {} };
  const nodes = overlayNodesIn({
    querySelectorAll(selector) {
      if (selector === OVERLAY_SELECTOR) return [marked, legacy];
      if (selector === LEGACY_OVERLAY_SELECTOR) return [legacy];
      if (selector === LEGACY_HOST_SELECTOR) return [host];
      return [];
    },
  });
  assert.deepEqual(
    nodes.map((node) => /** @type {{id: string}} */ (/** @type {unknown} */ (node)).id),
    ['marked', 'legacy', 'host'],
  );
});

test('removeOverlayNodes deletes leftover native wrappers, last first', () => {
  const removed = /** @type {string[]} */ ([]);
  const marked = {
    id: 'a',
    remove() {
      removed.push(this.id);
    },
  };
  const leftover = {
    id: 'b',
    remove() {
      removed.push(this.id);
    },
  };
  removeOverlayNodes({
    querySelectorAll(selector) {
      if (selector === OVERLAY_SELECTOR) return [marked];
      if (selector === LEGACY_OVERLAY_SELECTOR) return [leftover];
      return [];
    },
  });
  assert.deepEqual(removed, ['b', 'a']);
});

test('hideOverlayNodes inserts a one-shot stylesheet', () => {
  /** @type {Record<string, {id: string, textContent: string, remove: () => void}>} */
  const byId = {};
  /** @type {{id: string, textContent: string}[]} */
  const appended = [];
  const doc = {
    getElementById(/** @type {string} */ id) {
      return byId[id] ?? null;
    },
    createElement(/** @type {string} */ tag) {
      assert.equal(tag, 'style');
      return {
        id: '',
        textContent: '',
        remove() {
          delete byId[OVERLAY_HIDE_STYLE_ID];
        },
      };
    },
    documentElement: {
      appendChild(/** @type {{id: string, textContent: string}} */ node) {
        byId[node.id] = {
          ...node,
          remove() {
            delete byId[OVERLAY_HIDE_STYLE_ID];
          },
        };
        appended.push(node);
      },
    },
  };
  hideOverlayNodes(doc);
  hideOverlayNodes(doc);
  assert.equal(appended.length, 1);
  assert.equal(appended[0]?.id, OVERLAY_HIDE_STYLE_ID);
  assert.equal(appended[0]?.textContent.includes(OVERLAY_SELECTOR), true);
  clearOverlayHide(doc);
  assert.equal(doc.getElementById(OVERLAY_HIDE_STYLE_ID), null);
});

/** Minimal inline-style stand-in with priority support. */
function fakeStyle(/** @type {Record<string, {value: string, priority: string}>} */ initial = {}) {
  const props = new Map(Object.entries(initial));
  return {
    getPropertyValue: (/** @type {string} */ name) => props.get(name)?.value ?? '',
    getPropertyPriority: (/** @type {string} */ name) => props.get(name)?.priority ?? '',
    setProperty(/** @type {string} */ name, /** @type {string} */ value, /** @type {string} */ priority = '') {
      props.set(name, { value, priority });
    },
    removeProperty(/** @type {string} */ name) {
      const prev = props.get(name)?.value ?? '';
      props.delete(name);
      return prev;
    },
  };
}

function fakeNode(/** @type {Record<string, {value: string, priority: string}>} */ styleInit = {}) {
  /** @type {Record<string, string>} */
  const attrs = {};
  return {
    style: fakeStyle(styleInit),
    getAttribute: (/** @type {string} */ name) => attrs[name] ?? null,
    setAttribute(/** @type {string} */ name, /** @type {string} */ value) {
      attrs[name] = value;
    },
    removeAttribute(/** @type {string} */ name) {
      delete attrs[name];
    },
    remove() {},
  };
}

test('inline hide beats wrapper !important styles and restores them', () => {
  // Native-anchor wrapper: inline display:block !important, which the hide
  // stylesheet cannot override — the exact node the stylesheet-only hide left
  // painted while Detection was off.
  const wrapper = fakeNode({ display: { value: 'block', priority: 'important' } });
  hideOverlayNodeInline(wrapper);
  assert.equal(wrapper.style.getPropertyValue('display'), 'none');
  assert.equal(wrapper.style.getPropertyPriority('display'), 'important');
  restoreOverlayNodeInline(wrapper);
  assert.equal(wrapper.style.getPropertyValue('display'), 'block');
  assert.equal(wrapper.style.getPropertyPriority('display'), 'important');
});

test('inline hide is idempotent and keeps the ORIGINAL declaration', () => {
  const wrapper = fakeNode({ display: { value: 'block', priority: 'important' } });
  hideOverlayNodeInline(wrapper);
  hideOverlayNodeInline(wrapper);
  restoreOverlayNodeInline(wrapper);
  assert.equal(wrapper.style.getPropertyValue('display'), 'block');
  assert.equal(wrapper.style.getPropertyPriority('display'), 'important');
});

test('restore removes the declaration for nodes that had no inline display', () => {
  const host = fakeNode();
  hideOverlayNodeInline(host);
  assert.equal(host.style.getPropertyValue('display'), 'none');
  restoreOverlayNodeInline(host);
  assert.equal(host.style.getPropertyValue('display'), '');
});

test('restore is a no-op on nodes the hide never touched', () => {
  const node = fakeNode({ display: { value: 'grid', priority: '' } });
  restoreOverlayNodeInline(node);
  assert.equal(node.style.getPropertyValue('display'), 'grid');
});

test('hideOverlayNodes hides existing overlay nodes inline; clearOverlayHide restores them', () => {
  const wrapper = fakeNode({ display: { value: 'block', priority: 'important' } });
  const host = fakeNode();
  /** @type {Record<string, {remove: () => void}>} */
  const byId = {};
  const doc = {
    getElementById(/** @type {string} */ id) {
      return byId[id] ?? null;
    },
    createElement() {
      return { id: '', textContent: '' };
    },
    documentElement: {
      appendChild(/** @type {{id: string, remove?: () => void}} */ node) {
        byId[node.id] = {
          remove() {
            delete byId[node.id];
          },
        };
      },
    },
    querySelectorAll(/** @type {string} */ selector) {
      if (selector === OVERLAY_SELECTOR) return [wrapper, host];
      if (selector === `[${OVERLAY_INLINE_HIDE_ATTR}]`) {
        return [wrapper, host].filter(
          (n) => n.getAttribute(OVERLAY_INLINE_HIDE_ATTR) !== null,
        );
      }
      return [];
    },
  };
  hideOverlayNodes(doc);
  assert.equal(wrapper.style.getPropertyValue('display'), 'none');
  assert.equal(host.style.getPropertyValue('display'), 'none');
  assert.equal(doc.getElementById(OVERLAY_HIDE_STYLE_ID) !== null, true);
  clearOverlayHide(doc);
  assert.equal(wrapper.style.getPropertyValue('display'), 'block');
  assert.equal(wrapper.style.getPropertyPriority('display'), 'important');
  assert.equal(host.style.getPropertyValue('display'), '');
  assert.equal(doc.getElementById(OVERLAY_HIDE_STYLE_ID), null);
});
