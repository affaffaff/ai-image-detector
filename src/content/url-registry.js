/**
 * Per-URL scan bookkeeping for the content script.
 *
 * Two jobs, both keyed by image URL rather than by element, because one URL can
 * back many <img> nodes on a page and must only be scanned once:
 *
 *   - `cache`     memoized scored results, bounded LRU
 *   - `inFlight`  which URLs already have a request out, and who is waiting
 *
 * Extracted from scanner.js so these semantics are unit-testable without a DOM
 * or a live extension context. The invariant that motivated the extraction:
 * `reset()` MUST clear inFlight. Its entries mean "a request is already out for
 * this URL", which stops being true the moment the service worker dies. Leaving
 * them in place makes every re-request look like a duplicate and silently
 * strands those images as `pending` forever.
 */

/** @typedef {import('../shared/messages.js').ScanUpdate} ScanUpdate */

export class UrlRegistry {
  /** @param {number} cacheMax */
  constructor(cacheMax) {
    if (!Number.isInteger(cacheMax) || cacheMax <= 0) {
      throw new RangeError('cacheMax must be a positive integer');
    }
    this.cacheMax = cacheMax;
    /** @type {Map<string, ScanUpdate>} */
    this.cache = new Map();
    /** @type {Map<string, Set<string>>} */
    this.inFlight = new Map();
  }

  /**
   * Memoized result for a URL, or null. A hit refreshes recency so a URL an
   * infinite feed keeps recycling is not the one we evict.
   * @param {string} url
   * @returns {ScanUpdate | null}
   */
  get(url) {
    const hit = this.cache.get(url);
    if (!hit) return null;
    this.cache.delete(url);
    this.cache.set(url, hit);
    return hit;
  }

  /**
   * Memoize a scored result, evicting the least recently used past the cap.
   * Map preserves insertion order, which is what makes this an LRU.
   * @param {string} url
   * @param {ScanUpdate} update
   */
  remember(url, update) {
    this.cache.delete(url);
    this.cache.set(url, update);
    while (this.cache.size > this.cacheMax) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }

  /**
   * Register an image as waiting on a URL.
   * @param {string} url
   * @param {string} id
   * @returns {boolean} true if the caller must send the request; false if one
   *                    is already out and this id has been added as a waiter.
   */
  join(url, id) {
    const existing = this.inFlight.get(url);
    if (existing) {
      existing.add(id);
      return false;
    }
    this.inFlight.set(url, new Set([id]));
    return true;
  }

  /**
   * URL that currently has this image id waiting, or null.
   * Needed when the requesting element has been removed (infinite scroll)
   * but other images on the same URL are still waiting for the result.
   * @param {string} id
   * @returns {string | null}
   */
  urlForWaiter(id) {
    for (const [url, waiters] of this.inFlight) {
      if (waiters.has(id)) return url;
    }
    return null;
  }

  /**
   * Take every id waiting on a URL and clear the entry.
   * @param {string} url
   * @param {string} [fallbackId] - used when the entry is already gone
   * @returns {Set<string>}
   */
  settle(url, fallbackId) {
    const waiters = this.inFlight.get(url) ?? new Set(fallbackId ? [fallbackId] : []);
    this.inFlight.delete(url);
    return waiters;
  }

  /**
   * Find the in-flight URL that includes this requester id, then settle it.
   * Needed when the requesting DOM node is gone (infinite scroll) but other
   * images on the same URL are still waiting.
   * @param {string} id
   * @returns {{url: string, waiters: Set<string>} | null}
   */
  settleById(id) {
    for (const [url, waiters] of this.inFlight) {
      if (waiters.has(id)) {
        this.inFlight.delete(url);
        return { url, waiters };
      }
    }
    return null;
  }

  /**
   * Forget every in-flight request. Call when the port drops: the worker that
   * owned those requests is gone, so nothing is actually in flight any more.
   * Do not call this for a single `no-model` result — other URLs may still
   * score, and their co-waiters live in this map.
   * The cache is deliberately kept — those are real inference results and
   * survive a worker restart perfectly well.
   */
  reset() {
    this.inFlight.clear();
  }
}
