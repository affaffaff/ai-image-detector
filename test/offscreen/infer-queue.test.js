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

test('a queued image is promoted when it enters the viewport later', async () => {
  /** @type {Map<string, ReturnType<typeof deferred>>} */
  const acquires = new Map();
  /** @type {string[]} */
  const runOrder = [];

  const queue = createInferQueue({
    fetchConcurrency: 2,
    keyOf: (req) => req.id,
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

  const stale = queue.enqueue({ id: 'stale', priority: 1 });
  const current = queue.enqueue({ id: 'current', priority: 0 });
  await tick();
  acquires.get('stale')?.resolve('s');
  assert.equal(queue.reprioritize('current', 2), true);
  await tick();
  assert.deepEqual(runOrder, [], 'stale ready work waits for the promoted fetch');
  acquires.get('current')?.resolve('c');

  assert.equal(await current, 'current');
  assert.equal(await stale, 'stale');
  assert.deepEqual(runOrder, ['current', 'stale']);
  assert.equal(queue.reprioritize('current', 3), false, 'settled jobs leave the priority index');
});

test('a full fetch pipeline still drains while higher-priority work waits', async () => {
  /** @type {Map<string, ReturnType<typeof deferred>>} */
  const acquires = new Map();
  /** @type {string[]} */
  const acquireStarted = [];
  /** @type {string[]} */
  const runOrder = [];

  const queue = createInferQueue({
    fetchConcurrency: 2,
    inferConcurrency: 1,
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

  // Two prefetch jobs fill the pipeline, then a visible job takes the reserved
  // extra slot. Occupancy is now at its hard cap.
  const nearA = queue.enqueue({ id: 'near-a', priority: 0 });
  const nearB = queue.enqueue({ id: 'near-b', priority: 0 });
  await tick();
  const visible = queue.enqueue({ id: 'visible', priority: 5 });
  await tick();
  assert.deepEqual(acquireStarted, ['near-a', 'near-b', 'visible']);

  // A newly visible image outranks everything already in the pipeline but
  // cannot start a fetch: every slot, reserve included, is occupied.
  const newest = queue.enqueue({ id: 'newest', priority: 6 });
  await tick();
  assert.deepEqual(acquireStarted, ['near-a', 'near-b', 'visible'], 'newest waits for a slot');

  acquires.get('near-a')?.resolve('a');
  acquires.get('near-b')?.resolve('b');
  acquires.get('visible')?.resolve('v');
  await tick();

  // Every fetch has landed and nothing is inferring. A waiting job that cannot
  // start a fetch must not hold the infer slot — that is a permanent stall.
  assert.deepEqual(runOrder, ['visible'], 'the infer slot is not held by unstartable waiting work');
  assert.deepEqual(
    acquireStarted,
    ['near-a', 'near-b', 'visible', 'newest'],
    'taking the infer slot frees a fetch slot in the same pump',
  );

  acquires.get('newest')?.resolve('n');
  assert.equal(await visible, 'visible');
  assert.equal(await newest, 'newest');
  assert.equal(await nearA, 'near-a');
  assert.equal(await nearB, 'near-b');
  assert.deepEqual(runOrder, ['visible', 'newest', 'near-a', 'near-b']);
});

test('an image-heavy feed drains under wall-clock batch priorities', async () => {
  // Models the scanner's real traffic shape end to end: viewport batches seed
  // their priorities from Date.now(), so every later batch outranks everything
  // already queued; scrolling promotes queued images above in-flight ones; and
  // inference is far slower than a cache-warm fetch, so bytes pile up in the
  // ready buffer while the single infer slot works. That is the combination
  // that wedges a queue which lets unstartable waiting work hold the infer
  // slot: the page stops scanning after the first image or two, permanently.
  /** @param {number} ms */
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  /** @type {string[]} */
  const completed = [];

  const queue = createInferQueue({
    fetchConcurrency: 4,
    inferConcurrency: 1,
    keyOf: (req) => req.id,
    priorityOf: (req) => req.priority,
    acquire: async (req) => {
      await delay(1);
      return req.id;
    },
    run: async (req) => {
      await delay(4);
      completed.push(req.id);
      return req.id;
    },
  });

  /** @type {Promise<string>[]} */
  const pending = [];
  /** @type {string[]} */
  const ids = [];
  let clock = 1_000_000;
  for (let batch = 0; batch < 5; batch += 1) {
    clock += 1000; // a later viewport batch always outranks earlier work
    for (let index = 0; index < 8; index += 1) {
      const id = `b${batch}-i${index}`;
      ids.push(id);
      pending.push(queue.enqueue({ id, priority: clock + (8 - index) / 9 }));
    }
    await delay(6);
    // Images already queued scroll into view and are promoted above everything
    // currently holding a fetch slot.
    for (const id of ids.slice(-4)) queue.reprioritize(id, clock + 500);
    await delay(6);
  }

  // A wedged queue never settles at all, so bound the wait rather than hanging
  // the runner until the suite-level timeout.
  const drained = await Promise.race([
    Promise.all(pending).then(() => 'drained'),
    delay(4000).then(() => 'stalled'),
  ]);
  assert.equal(drained, 'drained', 'the queue drains instead of wedging');
  assert.equal(completed.length, ids.length, 'every image reached inference');
  assert.deepEqual([...completed].sort(), [...ids].sort(), 'no image is dropped');
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

test('clear drops queued and fetching jobs and does not infer them later', async () => {
  /** @type {string[]} */
  const acquireStarted = [];
  /** @type {string[]} */
  const runStarted = [];
  /** @type {Map<string, ReturnType<typeof deferred>>} */
  const acquires = new Map();

  const queue = createInferQueue({
    fetchConcurrency: 1,
    acquire: (id) => {
      acquireStarted.push(id);
      const gate = deferred();
      acquires.set(id, gate);
      return gate.promise;
    },
    run: async (id) => {
      runStarted.push(id);
      return id;
    },
  });

  const fetching = queue.enqueue('fetching');
  const waiting = queue.enqueue('waiting');
  await tick();
  assert.deepEqual(acquireStarted, ['fetching']);

  queue.clear('disabled');
  await assert.rejects(fetching, /disabled/);
  await assert.rejects(waiting, /disabled/);

  acquires.get('fetching')?.resolve('bytes');
  await tick();
  assert.deepEqual(runStarted, [], 'a fetch that finishes after clear must not run');

  const after = queue.enqueue('after');
  await tick();
  acquires.get('after')?.resolve('ok');
  await tick();
  assert.equal(await after, 'after');
  assert.deepEqual(runStarted, ['after']);
});

test('clear does not reject a job already inside run', async () => {
  /** @type {Map<string, ReturnType<typeof deferred>>} */
  const runs = new Map();
  const queue = createInferQueue({
    fetchConcurrency: 1,
    acquire: async (id) => id,
    run: (id) => {
      const gate = deferred();
      runs.set(id, gate);
      return gate.promise.then(() => id);
    },
  });

  const first = queue.enqueue('a');
  const second = queue.enqueue('b');
  await tick();
  assert.equal(runs.has('a'), true);

  queue.clear('disabled');
  await assert.rejects(second, /disabled/);
  runs.get('a')?.resolve();
  assert.equal(await first, 'a');
});

test('a second enqueue with the same key joins the existing job', async () => {
  /** @type {string[]} */
  const acquireStarted = [];
  const queue = createInferQueue({
    fetchConcurrency: 2,
    inferConcurrency: 1,
    keyOf: (req) => req.id,
    priorityOf: (req) => req.priority,
    acquire: async (req) => {
      acquireStarted.push(req.id);
      return req.id;
    },
    run: async (req) => req.id,
  });

  const first = queue.enqueue({ id: 'same', priority: 0 });
  const duplicate = queue.enqueue({ id: 'same', priority: 5 });
  const other = queue.enqueue({ id: 'other', priority: 0 });
  await tick();
  assert.deepEqual(acquireStarted, ['same', 'other']);
  assert.equal(await first, 'same');
  assert.equal(await duplicate, 'same');
  assert.equal(await other, 'other');
  assert.equal(queue.reprioritize('same', 6), false, 'settled duplicate left the index once');
});
