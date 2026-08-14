/**
 * Chromium on Windows logs a chrome://extensions warning whenever
 * GPU.requestAdapter is called with `powerPreference` (crbug.com/369219127).
 * The option is ignored there; ONNX Runtime still always passes it
 * (`env.webgpu.powerPreference`, often undefined). That warning then shows
 * up as an extension "error" even though inference is fine.
 *
 * Strip the key on Windows before ORT's requestAdapter runs. Other platforms
 * keep the option. Idempotent per GPU object.
 */

/** @type {WeakSet<object>} */
const wrapped = new WeakSet();

/**
 * @typedef {{requestAdapter: Function}} GpuLike
 */

/**
 * @param {unknown} options
 * @returns {unknown}
 */
function stripPowerPreference(options) {
  if (!options || typeof options !== 'object' || !Object.prototype.hasOwnProperty.call(options, 'powerPreference')) {
    return options;
  }
  const rest = { .../** @type {Record<string, unknown>} */ (options) };
  delete rest.powerPreference;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/**
 * @param {GpuLike} target
 * @returns {boolean}
 */
function wrapRequestAdapter(target) {
  if (wrapped.has(target) || typeof target.requestAdapter !== 'function') return false;
  const original = target.requestAdapter;
  /**
   * @this {GpuLike}
   * @param {unknown} [options]
   * @returns {unknown}
   */
  function wrappedRequestAdapter(options) {
    return original.call(this, stripPowerPreference(options));
  }
  try {
    target.requestAdapter = wrappedRequestAdapter;
  } catch {
    return false;
  }
  wrapped.add(target);
  return true;
}

/**
 * @param {GpuLike | null | undefined} [gpu]
 * @param {string} [userAgent]
 * @returns {boolean} whether a wrapper was installed on at least one object
 */
export function silenceWindowsWebGpuPowerPreference(gpu, userAgent) {
  const agent = userAgent ?? globalThis.navigator?.userAgent ?? '';
  if (!/Windows/i.test(agent)) return false;

  let did = false;
  const target = gpu ?? /** @type {{gpu?: GpuLike} | undefined} */ (globalThis.navigator)?.gpu;
  if (target) did = wrapRequestAdapter(target) || did;
  return did;
}

silenceWindowsWebGpuPowerPreference();
