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
 * @property {TAcquired} [acquired]
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

  function pump() {
    sortInPlace(waiting);
    while (waiting.length > 0) {
      const job = waiting[0];
      if (!job || !canStartFetch(job)) break;
      waiting.shift();
      fetching.push(job);
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

    sortInPlace(ready);
    const blockedBy = Math.max(maxPriority(fetching), maxPriority(waiting));
    while (inferActive < inferConcurrency && ready.length > 0) {
      const next = ready[0];
      if (!next) break;
      if (blockedBy > next.priority) break;
      ready.shift();
      inferActive += 1;
      const acquired = /** @type {TAcquired} */ (next.acquired);
      void Promise.resolve()
        .then(() => options.run(next.req, acquired))
        .then(next.resolve, next.reject)
        .finally(() => {
          inferActive -= 1;
          pump();
        });
    }
  }

  /**
   * @param {InferJob<TReq, TAcquired, TResult>} job
   * @param {unknown} err
   */
  function finishFetch(job, err) {
    const idx = fetching.indexOf(job);
    if (idx >= 0) fetching.splice(idx, 1);
    if (err) job.reject(err);
    else ready.push(job);
    pump();
  }

  /**
   * @param {TReq} req
   * @returns {Promise<TResult>}
   */
  function enqueue(req) {
    /** @type {InferJob<TReq, TAcquired, TResult>} */
    const job = {
      req,
      priority: priorityOf(req),
      seq: ++seq,
      resolve: () => {},
      reject: () => {},
    };
    const promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    waiting.push(job);
    pump();
    return promise;
  }

  return { enqueue };
}
