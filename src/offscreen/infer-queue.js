/**
 * Fetch pipeline in front of a serialized infer slot.
 *
 * Image bytes can download while ONNX is busy. session.run cannot overlap on
 * the single WASM/WebGPU session (numThreads = 1). Visible jobs outrank
 * rootMargin prefetch both when starting a fetch and when taking the infer
 * slot. A ready prefetch job waits if a higher-priority fetch is still in
 * flight, so a just-scrolled-into-view image is not stuck behind a thumbnail
 * that happened to decode first.
 *
 * Occupancy is capped so we do not hold every page image's bytes in RAM while
 * the infer slot drains a long queue. One extra fetch slot is reserved for a
 * strictly higher-priority job so a visible image can start downloading even
 * when prefetch buffers are already full.
 */

/**
 * @template TReq
 * @template TAcquired
 * @template TResult
 * @typedef {Object} InferQueueOptions
 * @property {number} fetchConcurrency
 * @property {number} [inferConcurrency]
 * @property {(req: TReq) => number} [priorityOf]
 * @property {(req: TReq) => unknown} [keyOf]
 * @property {(req: TReq) => Promise<TAcquired>} acquire
 * @property {(req: TReq, acquired: TAcquired) => Promise<TResult>} run
 */

/**
 * @template TReq
 * @template TAcquired
 * @template TResult
 * @typedef {Object} InferJob
 * @property {TReq} req
 * @property {number} priority
 * @property {number} seq
 * @property {unknown} [key]
 * @property {TAcquired} [acquired]
 * @property {boolean} [dropped]
 * @property {Promise<TResult>} [promise]
 * @property {(value: TResult) => void} resolve
 * @property {(reason: unknown) => void} reject
 */

/**
 * @template TReq
 * @template TAcquired
 * @template TResult
 * @param {InferQueueOptions<TReq, TAcquired, TResult>} options
 */
export function createInferQueue(options) {
  const fetchConcurrency = options.fetchConcurrency;
  const inferConcurrency = options.inferConcurrency ?? 1;
  const priorityOf = options.priorityOf ?? (() => 0);
  const keyOf = options.keyOf;

  if (!Number.isInteger(fetchConcurrency) || fetchConcurrency <= 0) {
    throw new RangeError('fetchConcurrency must be a positive integer');
  }
  if (!Number.isInteger(inferConcurrency) || inferConcurrency <= 0) {
    throw new RangeError('inferConcurrency must be a positive integer');
  }

  let seq = 0;
  let inferActive = 0;
  /** @type {InferJob<TReq, TAcquired, TResult>[]} */
  const waiting = [];
  /** @type {InferJob<TReq, TAcquired, TResult>[]} */
  const fetching = [];
  /** @type {InferJob<TReq, TAcquired, TResult>[]} */
  const ready = [];
  /** @type {Map<unknown, InferJob<TReq, TAcquired, TResult>>} */
  const byKey = new Map();

  /** @param {InferJob<TReq, TAcquired, TResult>} job */
  function forget(job) {
    if (job.key !== undefined && byKey.get(job.key) === job) byKey.delete(job.key);
  }

  /**
   * @param {InferJob<TReq, TAcquired, TResult>} a
   * @param {InferJob<TReq, TAcquired, TResult>} b
   */
  function compare(a, b) {
    return b.priority - a.priority || a.seq - b.seq;
  }

  /** @param {InferJob<TReq, TAcquired, TResult>[]} list */
  function sortInPlace(list) {
    list.sort(compare);
  }

  /** @param {InferJob<TReq, TAcquired, TResult>[]} list */
  function maxPriority(list) {
    let highest = -Infinity;
    for (const job of list) {
      if (job.priority > highest) highest = job.priority;
    }
    return highest;
  }

  /** @param {InferJob<TReq, TAcquired, TResult>} job */
  function canStartFetch(job) {
    const occupancy = fetching.length + ready.length;
    if (occupancy < fetchConcurrency) return true;
    const occupiedMax = Math.max(maxPriority(ready), maxPriority(fetching));
    return job.priority > occupiedMax && occupancy < fetchConcurrency + 1;
  }

  /**
   * Admission is monotone in priority: the first branch of canStartFetch
   * ignores priority entirely, and the second only widens with it. So once the
   * highest-priority waiting job is refused, every job behind it is refused
   * too, and breaking is equivalent to scanning the whole list.
   * @returns {boolean} whether any job started fetching
   */
  function pumpFetches() {
    sortInPlace(waiting);
    let started = false;
    while (waiting.length > 0) {
      const job = waiting[0];
      if (!job || !canStartFetch(job)) break;
      waiting.shift();
      fetching.push(job);
      started = true;
      void Promise.resolve()
        .then(() => options.acquire(job.req))
        .then(
          (acquired) => {
            job.acquired = acquired;
            finishFetch(job, null);
          },
          (err) => finishFetch(job, err),
        );
    }
    return started;
  }

  /** @returns {boolean} whether any job took an infer slot */
  function pumpInfers() {
    sortInPlace(ready);
    // ONLY in-flight fetches may hold the infer slot open for higher-priority
    // work, because only they are guaranteed to reach `ready` on their own.
    //
    // Jobs left in `waiting` must NOT count here. pumpFetches has just refused
    // every one of them, which means occupancy is at its cap — and occupancy
    // only falls when a ready job takes the infer slot. Letting a waiting job
    // block that slot is therefore a cycle, not a delay: nothing fetches
    // because nothing infers, and nothing infers because something is waiting
    // to fetch. Priorities here are wall-clock-seeded per viewport batch, so
    // newly visible images always outrank queued ones and the cycle closes
    // permanently — the whole page freezes after the first few images.
    const blockedBy = maxPriority(fetching);
    let started = false;
    while (inferActive < inferConcurrency && ready.length > 0) {
      const next = ready[0];
      if (!next) break;
      if (blockedBy > next.priority) break;
      ready.shift();
      inferActive += 1;
      started = true;
      const acquired = /** @type {TAcquired} */ (next.acquired);
      void Promise.resolve()
        .then(() => options.run(next.req, acquired))
        .then(next.resolve, next.reject)
        .finally(() => {
          forget(next);
          inferActive -= 1;
          pump();
        });
    }
    return started;
  }

  /**
   * Run both stages to a fixed point. They gate each other in both directions:
   * a started fetch raises the bar the infer slot waits for, and a started
   * infer frees the occupancy a waiting fetch needs. One pass in a fixed order
   * leaves the freed fetch slot idle until some unrelated event pumps again,
   * which wastes exactly the download-while-ONNX-is-busy overlap this queue
   * exists to provide. Each iteration that continues has moved a job out of
   * `waiting` or out of `ready`, so this terminates.
   */
  function pump() {
    for (;;) {
      const fetchStarted = pumpFetches();
      const inferStarted = pumpInfers();
      if (!fetchStarted && !inferStarted) return;
    }
  }

  /**
   * @param {InferJob<TReq, TAcquired, TResult>} job
   * @param {unknown} err
   */
  function finishFetch(job, err) {
    if (job.dropped) return;
    const idx = fetching.indexOf(job);
    if (idx >= 0) fetching.splice(idx, 1);
    if (err) {
      forget(job);
      job.reject(err);
    }
    else ready.push(job);
    pump();
  }

  /**
   * Drop every job that has not entered `run`. In-flight session.run cannot
   * be aborted; those promises still settle and the caller discards them.
   * Fetch completions after this are ignored so a cancelled acquire cannot
   * resurrect work.
   * @param {string} [reason]
   */
  function clear(reason = 'cancelled') {
    const err = new Error(reason);
    /** @param {InferJob<TReq, TAcquired, TResult>} job */
    const drop = (job) => {
      job.dropped = true;
      forget(job);
      job.reject(err);
    };
    for (const job of waiting) drop(job);
    waiting.length = 0;
    for (const job of fetching) drop(job);
    fetching.length = 0;
    for (const job of ready) drop(job);
    ready.length = 0;
  }

  /**
   * @param {TReq} req
   * @returns {Promise<TResult>}
   */
  function enqueue(req) {
    const key = keyOf ? keyOf(req) : undefined;
    if (key !== undefined) {
      const existing = byKey.get(key);
      if (existing && !existing.dropped && existing.promise) {
        const nextPriority = priorityOf(req);
        if (nextPriority > existing.priority) {
          existing.priority = nextPriority;
          existing.req = req;
          pump();
        }
        return existing.promise;
      }
    }
    /** @type {InferJob<TReq, TAcquired, TResult>} */
    const job = {
      req,
      priority: priorityOf(req),
      seq: ++seq,
      ...(key !== undefined ? { key } : {}),
      resolve: () => {},
      reject: () => {},
    };
    const promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    job.promise = promise;
    if (job.key !== undefined) byKey.set(job.key, job);
    waiting.push(job);
    pump();
    return promise;
  }

  /**
   * Raise queued work when its image enters the actual viewport. Fetching and
   * ready jobs both participate in priority blocking, so updating either is
   * enough to keep newly viewed images ahead of stale prefetch work.
   *
   * @param {unknown} key
   * @param {number} priority
   * @returns {boolean}
   */
  function reprioritize(key, priority) {
    if (!Number.isFinite(priority)) return false;
    const job = byKey.get(key);
    if (!job || priority <= job.priority) return false;
    job.priority = priority;
    pump();
    return true;
  }

  return { enqueue, reprioritize, clear };
}
