/**
 * Page-local latch: after the first `no-model` scan result, stop enqueueing
 * new inference jobs until the model is known to be usable again.
 *
 * MODEL_READY is not the only recovery signal. The service worker may emit it
 * before this tab's content script is listening, and a later `scored` update
 * is itself proof that weights are installed. Without clearing on `scored`,
 * `considerImage` would keep dropping newly visible images after a transient
 * no-model (engine status still catching up, or a download that finished
 * while this document was already scanning).
 *
 * Once the model is proven usable, a late `no-model` from a request that
 * started before that must not re-latch. Scan jobs run concurrently in the
 * service worker, so an older negative can arrive after a `scored` verdict.
 */

export class ModelGate {
  constructor() {
    this.unavailable = false;
    /** True after MODEL_READY or any scored verdict this page session. */
    this.provenUsable = false;
  }

  /** @returns {boolean} true if this call newly entered the unavailable state */
  enter() {
    if (this.provenUsable || this.unavailable) return false;
    this.unavailable = true;
    return true;
  }

  /**
   * Record that weights work. Clears the latch if it was set.
   * @returns {boolean} true if the latch was set and is now cleared
   */
  markUsable() {
    this.provenUsable = true;
    if (!this.unavailable) return false;
    this.unavailable = false;
    return true;
  }

  /**
   * Lift the latch for one probe request without claiming the model works.
   * Used after a service-worker restart: MODEL_READY may already have been
   * sent, and scored replies cannot arrive while `requestScan` is blocked.
   * @returns {boolean} true if a probe request may now be sent
   */
  allowProbe() {
    if (this.provenUsable || !this.unavailable) return false;
    this.unavailable = false;
    return true;
  }

  reset() {
    this.unavailable = false;
    this.provenUsable = false;
  }
}
