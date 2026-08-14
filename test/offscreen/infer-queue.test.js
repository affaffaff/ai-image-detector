import test from 'node:test';
import assert from 'node:assert/strict';

import { createInferQueue } from '../../src/offscreen/infer-queue.js';

/** @template T */
function deferred() {
  /** @type {(value?: T) => void} */
  let resolve = () => {};
  /** @type {(reason?: unknown) => void} */
  let reject = () => {};
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('fetchConcurrency lets later jobs acquire while an earlier job infers', async () => {
  /** @type {string[]} */
  const acquireStarted = [];
  /** @type {string[]} */
  const runStarted = [];
  /** @type {Map<string, ReturnType<typeof deferred>>} */
  const acquires = new Map();
  /** @type {Map<string, ReturnType<typeof deferred>>} */
  const runs = new Map();

  const queue = createInferQueue({
    fetchConcurrency: 2,
    inferConcurrency: 1,
    acquire: (id) => {
      acquireStarted.push(id);
      const gate = deferred();
      acquires.set(id, gate);
      return gate.promise;
    },
    run: (id, acquired) => {
      runStarted.push(id);
      const gate = deferred();
      runs.set(id, gate);
      return gate.promise.then(() => acquired);
    },
  });

  const first = queue.enqueue('a');
  const second = queue.enqueue('b');
  await tick();
  assert.deepEqual(acquireStarted, ['a', 'b']);
  assert.deepEqual(runStarted, []);

  acquires.get('a')?.resolve('bytes-a');
  await tick();
  assert.deepEqual(runStarted, ['a']);

  acquires.get('b')?.resolve('bytes-b');
  await tick();
  assert.deepEqual(runStarted, ['a'], 'infer stays serial until the first run settles');

  runs.get('a')?.resolve();
  await tick();
  assert.deepEqual(runStarted, ['a', 'b']);
  runs.get('b')?.resolve();
  assert.equal(await first, 'bytes-a');
  assert.equal(await second, 'bytes-b');
});

test('a visible job infers before a prefetch job whose bytes arrived first', async () => {
  /** @type {Map<string, ReturnType<typeof deferred>>} */
  const acquires = new Map();
  /** @type {string[]} */
  const runOrder = [];

  const queue = createInferQueue({
    fetchConcurrency: 2,
    priorityOf: (req) => req.priority,
    acquire: (req) => {
      const gate = deferred();
      acquires.set(req.id, gate);
      return gate.promise;
    },
    run: async (req) => {
      runOrder.push(req.id);
      return req.id;
    },
  });

  const prefetch = queue.enqueue({ id: 'near', priority: 0 });
  const visible = queue.enqueue({ id: 'visible', priority: 1 });
  await tick();

  acquires.get('near')?.resolve('n');
  await tick();
  assert.deepEqual(runOrder, [], 'prefetch waits while the visible fetch is still in flight');

  acquires.get('visible')?.resolve('v');
  assert.equal(await visible, 'visible');
  assert.equal(await prefetch, 'near');
  assert.deepEqual(runOrder, ['visible', 'near']);
});

test('a later visible job can start fetching when prefetch buffers are already full', async () => {
  /** @type {Map<string, ReturnType<typeof deferred>>} */
  const acquires = new Map();
  /** @type {string[]} */
  const acquireStarted = [];
  /** @type {string[]} */
  const runOrder = [];

  const queue = createInferQueue({
    fetchConcurrency: 1,
    priorityOf: (req) => req.priority,
    acquire: (req) => {
      acquireStarted.push(req.id);
      const gate = deferred();
      acquires.set(req.id, gate);
      return gate.promise;
    },
    run: async (req) => {
      runOrder.push(req.id);
      return req.id;
    },
  });

  const prefetch = queue.enqueue({ id: 'near', priority: 0 });
  await tick();
  assert.deepEqual(acquireStarted, ['near']);

  const visible = queue.enqueue({ id: 'visible', priority: 1 });
  await tick();
  assert.deepEqual(acquireStarted, ['near', 'visible'], 'visible fetch bypasses a full prefetch slot');

  acquires.get('visible')?.resolve('v');
  await tick();
  assert.deepEqual(runOrder, ['visible']);

  acquires.get('near')?.resolve('n');
  assert.equal(await visible, 'visible');
  assert.equal(await prefetch, 'near');
  assert.deepEqual(runOrder, ['visible', 'near']);
});

test('an acquire failure settles that job and still drains the queue', async () => {
  /** @type {string[]} */
  const runStarted = [];
  /** @type {Map<string, ReturnType<typeof deferred>>} */
  const acquires = new Map();

  const queue = createInferQueue({
    fetchConcurrency: 2,
    acquire: (id) => {
      const gate = deferred();
      acquires.set(id, gate);
      return gate.promise;
    },
    run: async (id) => {
      runStarted.push(id);
      return id;
    },
  });

  const first = queue.enqueue('bad');
  const second = queue.enqueue('ok');
  await tick();
  acquires.get('bad')?.reject(new Error('fetch failed'));
  acquires.get('ok')?.resolve('bytes');

  await assert.rejects(first, /fetch failed/);
  assert.equal(await second, 'ok');
  assert.deepEqual(runStarted, ['ok']);
});
