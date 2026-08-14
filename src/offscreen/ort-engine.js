/** ONNX Runtime engine for the primary Community Forensics model. */

// Must load before onnxruntime-web: ORT's WebGPU init always passes
// `powerPreference` to requestAdapter, which Chromium warns about on Windows.
import { silenceWindowsWebGpuPowerPreference } from './webgpu-windows.js';
import * as ort from 'onnxruntime-web/webgpu';
import {
  DEFAULT_TILE_AGGREGATION,
  MODEL_INPUT_SIZE,
  TILE_AGGREGATION,
  aggregateTileProbabilities,
  bitmapOfficialCenterToNchw,
  bitmapTileToNchw,
  planNativeTiles,
  sigmoid,
} from './preprocess.js';
import {
  NATIVE_VETO_MAX_TAU,
  shouldProbeNativeTiles,
} from '../shared/native-veto.js';

/** @type {Set<string>} */
const ALLOWED_AGGREGATION = new Set(Object.values(TILE_AGGREGATION));

/**
 * @typedef {Object} RuntimeModelEntry
 * @property {string} id
 * @property {{name?: string, width?: number, height?: number}} [input]
 * @property {{name?: string, semantic?: string}} [output]
 * @property {{mode?: string, maxAxisSamples?: number, aggregation?: string, nativeResolution?: boolean}} [tiling]
 *   tiling.mode: 'official-center' -> authors' Resize(440)+CenterCrop(384) single
 *   crop (on-distribution for this checkpoint; shipped). 'native-grid' or absent
 *   -> native-resolution tile voting (kept as an alternative mode).
 */

let wasmConfigured = false;

function configureWasm() {
  if (wasmConfigured) return;
  silenceWindowsWebGpuPowerPreference();
  // Extensions are not cross-origin isolated. Threads do not initialize
  // reliably here, and the WASM path is the compatibility baseline.
  // Measured: numThreads = 4 cuts inference 900ms -> 511ms and keeps the direct
  // logit bit-identical, but the page path then badges 20% where direct scores
  // 44%. Threads stay off until that divergence is understood.
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = chrome.runtime.getURL('ort/');
  // ORT's native logger writes through Emscripten stderr, which DevTools
  // renders as console.error regardless of the record's own severity. The
  // W-level partial-EP-assignment notice is expected for this INT8 graph
  // (WebGPU declines the quantized ops; shape ops stay on CPU by design), so
  // it is noise dressed as failure. Keep genuine errors.
  ort.env.logLevel = 'error';
  wasmConfigured = true;
}

/** WebGPU is a latency path. WASM must still clear the accuracy bar alone. */
export function gpuAvailable() {
  const nav = /** @type {{gpu?: unknown} | undefined} */ (globalThis.navigator);
  return Boolean(nav?.gpu);
}

/**
 * @param {readonly string[]} executionProviders
 */
function sessionOptions(executionProviders) {
  return {
    executionProviders: [...executionProviders],
    executionMode: /** @type {const} */ ('sequential'),
    graphOptimizationLevel: /** @type {const} */ ('all'),
    // The native session logger is independent of env.logLevel; without this
    // the session_state.cc EP-assignment warnings still reach stderr. 3 = ERROR.
    logSeverityLevel: /** @type {const} */ (3),
  };
}

/**
 * Prefer WebGPU when the adapter exists; fall back to WASM if session
 * creation fails (unsupported INT8 ops, missing JSEP files, blocked GPU).
 * The fallback copy keeps the original buffer intact if the first attempt
 * transfers or detaches it.
 *
 * Do not narrow this to ['wasm'] without re-running the eval: dropping the
 * WebGPU EP moves the raw logit for an identical fixture from 0.0013843990 to
 * 0.0018267749 (44% -> 46% badge), which shifts every score against a
 * threshold the rules forbid retuning.
 *
 * @param {ArrayBuffer} bytes
 */
async function createSession(bytes) {
  const wasm = sessionOptions(['wasm']);
  if (gpuAvailable()) {
    try {
      return await ort.InferenceSession.create(bytes.slice(0), sessionOptions(['webgpu', 'wasm']));
    } catch (err) {
      console.warn('[ai-image-detector] WebGPU session failed, using WASM:', err);
    }
  }
  return ort.InferenceSession.create(bytes, wasm);
}

/**
 * First session.run compiles WASM/WebGPU kernels. Doing it here means the
 * first real image only pays for fetch + one forward pass.
 *
 * @param {ort.InferenceSession} session
 * @param {string} inputName
 * @param {string} outputName
 */
async function warmupSession(session, inputName, outputName) {
  const zeros = new Float32Array(3 * MODEL_INPUT_SIZE * MODEL_INPUT_SIZE);
  const input = new ort.Tensor('float32', zeros, [1, 3, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE]);
  /** @type {ort.Tensor | undefined} */
  let output;
  try {
    const results = await session.run({ [inputName]: input }, [outputName]);
    output = results[outputName];
  } finally {
    input.dispose();
    output?.dispose();
  }
}

/**
 * Center-first native 384 crops, aborted as soon as one tile reaches the
 * veto tau. Cost profile: official-REAL images pay nothing; graphic-gated
 * images pay nothing extra (the cap already owns the badge); official-AI
 * photographs that native tiles agree with pay one extra pass; the rare
 * resampling-artifact false positive pays the full grid so we can report
 * the native median.
 *
 * @param {ImageBitmap} bitmap
 * @param {number} officialScore
 * @param {(bitmap: ImageBitmap, data: Float32Array) => Promise<number>} runSingle
 * @param {boolean} [graphicGated]
 * @returns {Promise<{nativeMax?: number, nativeMedian?: number}>}
 */
async function probeNativeVetoTiles(bitmap, officialScore, runSingle, graphicGated) {
  if (
    !shouldProbeNativeTiles({
      shortEdge: Math.min(bitmap.width, bitmap.height),
      officialScore,
      graphicGated,
    })
  ) {
    return {};
  }

  const tiles = planNativeTiles(bitmap.width, bitmap.height);
  const cx = bitmap.width / 2;
  const cy = bitmap.height / 2;
  tiles.sort((a, b) => {
    const da = (a.x + a.size / 2 - cx) ** 2 + (a.y + a.size / 2 - cy) ** 2;
    const db = (b.x + b.size / 2 - cx) ** 2 + (b.y + b.size / 2 - cy) ** 2;
    return da - db;
  });

  /** @type {number[]} */
  const probabilities = [];
  for (const tile of tiles) {
    const probability = await runSingle(bitmap, bitmapTileToNchw(bitmap, tile));
    probabilities.push(probability);
    if (probability >= NATIVE_VETO_MAX_TAU) {
      return { nativeMax: probability };
    }
  }
  const ordered = [...probabilities].sort((a, b) => a - b);
  const mid = Math.floor(ordered.length / 2);
  return {
    nativeMax: /** @type {number} */ (ordered[ordered.length - 1]),
    nativeMedian: /** @type {number} */ (ordered[mid]),
  };
}

/**
 * @param {RuntimeModelEntry} entry
 * @param {ArrayBuffer} modelBytes
 */
export async function createOrtEngine(entry, modelBytes) {
  configureWasm();
  const session = await createSession(modelBytes);
  let hasRun = false;
  let runTail = Promise.resolve();

  const teardown = async () => {
    await session.release();
  };

  /**
   * Keep warmup and real inference off the session at the same time. A real
   * image that arrives during the warmup grace period becomes the compiling
   * first run itself, avoiding an otherwise redundant zero pass before the
   * first badge.
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  const runExclusive = (task) => {
    const next = runTail.then(task, task);
    runTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const inputName = entry.input?.name ?? session.inputNames[0];
  const outputName = entry.output?.name ?? session.outputNames[0];
  if (!inputName || !session.inputNames.includes(inputName)) {
    await teardown();
    throw new Error(`model input '${inputName ?? '(missing)'}' does not match ONNX graph`);
  }
  if (!outputName || !session.outputNames.includes(outputName)) {
    await teardown();
    throw new Error(`model output '${outputName ?? '(missing)'}' does not match ONNX graph`);
  }
  if (entry.input?.width != null && entry.input.width !== MODEL_INPUT_SIZE) {
    await teardown();
    throw new Error(`unsupported model input width: ${entry.input.width}`);
  }
  if (entry.input?.height != null && entry.input.height !== MODEL_INPUT_SIZE) {
    await teardown();
    throw new Error(`unsupported model input height: ${entry.input.height}`);
  }
  if (entry.output?.semantic && entry.output.semantic !== 'fake-logit') {
    await teardown();
    throw new Error(`unsupported model output semantic: ${entry.output.semantic}`);
  }
  const centerCrop = entry.tiling?.mode === 'official-center';
  if (entry.tiling?.mode && !centerCrop && entry.tiling.mode !== 'native-grid') {
    await teardown();
    throw new Error(`unsupported production preprocessing mode: ${entry.tiling.mode}`);
  }
  if (!centerCrop && entry.tiling?.nativeResolution === false) {
    await teardown();
    throw new Error('whole-image resize is not a supported inference path');
  }
  const aggregation = entry.tiling?.aggregation ?? DEFAULT_TILE_AGGREGATION;
  if (!centerCrop && !ALLOWED_AGGREGATION.has(aggregation)) {
    await teardown();
    throw new Error(`unsupported tile aggregation: ${aggregation}`);
  }

  /**
   * @param {ImageBitmap} bitmap
   * @param {Float32Array} data
   * @returns {Promise<number>}
   */
  const runSingle = async (bitmap, data) => {
    return runExclusive(async () => {
      const input = new ort.Tensor('float32', data, [1, 3, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE]);
      /** @type {ort.Tensor | undefined} */
      let output;
      try {
        const results = await session.run({ [inputName]: input }, [outputName]);
        output = results[outputName];
        const first = output?.data[0];
        const logit = typeof first === 'bigint' ? Number(first) : first;
        if (typeof logit !== 'number' || !Number.isFinite(logit)) {
          throw new Error('ONNX detector returned a non-finite logit');
        }
        hasRun = true;
        return sigmoid(logit);
      } finally {
        input.dispose();
        output?.dispose();
      }
    });
  };

  return {
    async warmup() {
      if (hasRun) return;
      await runExclusive(async () => {
        if (hasRun) return;
        await warmupSession(session, inputName, outputName);
        hasRun = true;
      });
    },
    /**
     * @param {ImageBitmap} bitmap
     * @param {{graphicGated?: boolean}} [options]
     * @returns {Promise<{raw: number, nativeMax?: number, nativeMedian?: number}>}
     */
    async infer(bitmap, options) {
      if (centerCrop) {
        // Authors' eval transform: Resize(440 short edge) + CenterCrop(384).
        // Single crop; no tile voting. This is the shipped on-distribution path.
        const raw = await runSingle(bitmap, bitmapOfficialCenterToNchw(bitmap));
        const native = await probeNativeVetoTiles(bitmap, raw, runSingle, options?.graphicGated);
        return { raw, ...native };
      }
      const tiles = planNativeTiles(bitmap.width, bitmap.height, {
        tileSize: MODEL_INPUT_SIZE,
        maxAxisSamples: entry.tiling?.maxAxisSamples,
      });
      const probabilities = [];
      for (const tile of tiles) {
        const data = bitmapTileToNchw(bitmap, tile);
        probabilities.push(await runSingle(bitmap, data));
      }
      return { raw: aggregateTileProbabilities(probabilities, aggregation) };
    },
    async release() {
      await runTail;
      await teardown();
    },
  };
}
