/** WASM-only ONNX Runtime engine for the primary Community Forensics model. */

import * as ort from 'onnxruntime-web/wasm';
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
  // Extensions are not cross-origin isolated. Threads do not initialize
  // reliably here, and the WASM path is the compatibility baseline.
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = chrome.runtime.getURL('ort/');
  wasmConfigured = true;
}

/**
 * @param {RuntimeModelEntry} entry
 * @param {File} modelFile
 */
export async function createOrtEngine(entry, modelFile) {
  configureWasm();
  const bytes = await modelFile.arrayBuffer();
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: ['wasm'],
    executionMode: 'sequential',
    graphOptimizationLevel: 'all',
  });

  const inputName = entry.input?.name ?? session.inputNames[0];
  const outputName = entry.output?.name ?? session.outputNames[0];
  if (!inputName || !session.inputNames.includes(inputName)) {
    await session.release();
    throw new Error(`model input '${inputName ?? '(missing)'}' does not match ONNX graph`);
  }
  if (!outputName || !session.outputNames.includes(outputName)) {
    await session.release();
    throw new Error(`model output '${outputName ?? '(missing)'}' does not match ONNX graph`);
  }
  if (entry.input?.width != null && entry.input.width !== MODEL_INPUT_SIZE) {
    await session.release();
    throw new Error(`unsupported model input width: ${entry.input.width}`);
  }
  if (entry.input?.height != null && entry.input.height !== MODEL_INPUT_SIZE) {
    await session.release();
    throw new Error(`unsupported model input height: ${entry.input.height}`);
  }
  if (entry.output?.semantic && entry.output.semantic !== 'fake-logit') {
    await session.release();
    throw new Error(`unsupported model output semantic: ${entry.output.semantic}`);
  }
  const centerCrop = entry.tiling?.mode === 'official-center';
  if (entry.tiling?.mode && !centerCrop && entry.tiling.mode !== 'native-grid') {
    await session.release();
    throw new Error(`unsupported production preprocessing mode: ${entry.tiling.mode}`);
  }
  if (!centerCrop && entry.tiling?.nativeResolution === false) {
    await session.release();
    throw new Error('whole-image resize is not a supported inference path');
  }
  const aggregation = entry.tiling?.aggregation ?? DEFAULT_TILE_AGGREGATION;
  if (!centerCrop && !ALLOWED_AGGREGATION.has(aggregation)) {
    await session.release();
    throw new Error(`unsupported tile aggregation: ${aggregation}`);
  }

  /**
   * @param {ImageBitmap} bitmap
   * @param {Float32Array} data
   * @returns {Promise<number>}
   */
  const runSingle = async (bitmap, data) => {
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
      return sigmoid(logit);
    } finally {
      input.dispose();
      output?.dispose();
    }
  }

  return {
    /** @param {ImageBitmap} bitmap @returns {Promise<number>} */
    async infer(bitmap) {
      if (centerCrop) {
        // Authors' eval transform: Resize(440 short edge) + CenterCrop(384).
        // Single crop; no tile voting. This is the shipped on-distribution path.
        const data = bitmapOfficialCenterToNchw(bitmap);
        return runSingle(bitmap, data);
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
      return aggregateTileProbabilities(probabilities, aggregation);
    },
    async release() {
      await session.release();
    },
  };
}
