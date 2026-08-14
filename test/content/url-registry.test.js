import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { UrlRegistry } from '../../src/content/url-registry.js';

/** @param {number} p */
const scored = (p) => /** @type {any} */ ({ id: '', state: 'scored', probability: p, isAI: p >= 0.65 });

describe('UrlRegistry: one request per URL', () => {
  test('first join sends, later joins ride along', () => {
    const reg = new UrlRegistry(10);
    assert.equal(reg.join('a.png', 'i1'), true, 'first caller must send the request');
    assert.equal(reg.join('a.png', 'i2'), false, 'second caller must not duplicate it');
    assert.equal(reg.join('a.png', 'i3'), false);

    const waiters = reg.settle('a.png');
    assert.deepEqual([...waiters].sort(), ['i1', 'i2', 'i3']);
  });

  test('reports the request owner so a duplicate can promote the shared job', () => {
    const reg = new UrlRegistry(10);
    reg.join('a.png', 'requester');
    reg.join('a.png', 'duplicate');
    assert.equal(reg.requestIdFor('a.png'), 'requester');
    assert.equal(reg.requestIdFor('missing.png'), null);
  });

  test('settling clears the entry so the next request is sent again', () => {
    const reg = new UrlRegistry(10);
    reg.join('a.png', 'i1');
    reg.settle('a.png');
    assert.equal(reg.join('a.png', 'i2'), true);
  });

  test('settle falls back to the reporting id when the entry is gone', () => {
    const reg = new UrlRegistry(10);
    assert.deepEqual([...reg.settle('gone.png', 'i9')], ['i9']);
  });

  test('a retry after settle lets every waiter join the new in-flight set', () => {
    const reg = new UrlRegistry(10);
    assert.equal(reg.join('a.png', 'i1'), true);
    assert.equal(reg.join('a.png', 'i2'), false);
    assert.deepEqual([...reg.settle('a.png')].sort(), ['i1', 'i2']);
    assert.equal(reg.join('a.png', 'i1'), true, 'first waiter sends the retry');
    assert.equal(reg.join('a.png', 'i2'), false, 'siblings ride along on the same retry');
    assert.deepEqual([...reg.settle('a.png')].sort(), ['i1', 'i2']);
  });

  test('settleById delivers waiters when the requester node is already gone', () => {
    const reg = new UrlRegistry(10);
    assert.equal(reg.join('a.png', 'requester'), true);
    assert.equal(reg.join('a.png', 'waiter'), false);

    const settled = reg.settleById('requester');
    assert.equal(settled?.url, 'a.png');
    assert.deepEqual([...(settled?.waiters ?? [])].sort(), ['requester', 'waiter']);
    assert.equal(reg.join('a.png', 'later'), true, 'URL is no longer in flight');
  });

  test('settleById returns null when the id was never in flight', () => {
    const reg = new UrlRegistry(10);
    assert.equal(reg.settleById('ghost'), null);
  });

  test('urlForWaiter finds the URL after the requester node is gone', () => {
    const reg = new UrlRegistry(10);
    assert.equal(reg.join('a.png', 'requester'), true);
    assert.equal(reg.join('a.png', 'waiter'), false);
    assert.equal(reg.urlForWaiter('requester'), 'a.png');
    assert.equal(reg.urlForWaiter('waiter'), 'a.png');
    assert.equal(reg.urlForWaiter('nobody'), null);
  });
});

describe('UrlRegistry: reset after the worker dies', () => {
  // Regression test. The service worker dies after ~30s idle; the content
  // script reconnects and re-requests everything still pending. Without reset()
  // those URLs still look in-flight, every re-request is dropped as a
  // duplicate, and the images stay `pending` for the life of the page.
  test('reset lets a stranded URL be requested again', () => {
    const reg = new UrlRegistry(10);
    assert.equal(reg.join('a.png', 'i1'), true);
    assert.equal(reg.join('a.png', 'i1'), false, 'still in flight before the drop');

    reg.reset();

    assert.equal(reg.join('a.png', 'i1'), true, 'after the port drops nothing is in flight');
  });

  test('reset keeps scored results — they outlive the worker', () => {
    const reg = new UrlRegistry(10);
    reg.remember('a.png', scored(0.9));
    reg.reset();
    assert.equal(reg.get('a.png')?.probability, 0.9);
  });
});

describe('UrlRegistry: bounded LRU cache', () => {
  test('evicts the least recently used past the cap', () => {
    const reg = new UrlRegistry(3);
    reg.remember('a', scored(0.1));
    reg.remember('b', scored(0.2));
    reg.remember('c', scored(0.3));
    reg.remember('d', scored(0.4));

    assert.equal(reg.cache.size, 3);
    assert.equal(reg.get('a'), null, 'oldest entry is gone');
    assert.equal(reg.get('d')?.probability, 0.4);
  });

  test('a read refreshes recency, so a recycled URL survives', () => {
    const reg = new UrlRegistry(3);
    reg.remember('a', scored(0.1));
    reg.remember('b', scored(0.2));
    reg.remember('c', scored(0.3));

    reg.get('a'); // an infinite feed scrolls 'a' back into view
    reg.remember('d', scored(0.4));

    assert.notEqual(reg.get('a'), null, 'recently read entry must not be evicted');
    assert.equal(reg.get('b'), null, 'the genuinely stale entry goes instead');
  });

  test('re-remembering the same URL does not grow the cache', () => {
    const reg = new UrlRegistry(3);
    reg.remember('a', scored(0.1));
    reg.remember('a', scored(0.9));
    assert.equal(reg.cache.size, 1);
    assert.equal(reg.get('a')?.probability, 0.9);
  });

  test('rejects a nonsense cap rather than silently unbounding', () => {
    assert.throws(() => new UrlRegistry(0), RangeError);
    assert.throws(() => new UrlRegistry(1.5), RangeError);
  });
});
