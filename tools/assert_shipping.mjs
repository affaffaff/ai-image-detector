/** Assert that release metadata cannot outpace its evaluation evidence. */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} path @returns {any} */
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** @param {any} curve */
function assertMonotoneCurve(curve) {
  if (!Array.isArray(curve.xs) || !Array.isArray(curve.ys) || curve.xs.length !== curve.ys.length) {
    throw new Error('fused calibration must have equal xs/ys arrays');
  }
  if (curve.xs.length < 2 || curve.xs.length > 64) throw new Error('fused calibration must have 2..64 knots');
  for (let index = 0; index < curve.xs.length; index += 1) {
    const x = curve.xs[index];
    const y = curve.ys[index];
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
      throw new Error('fused calibration knots must be finite probabilities');
    }
    if (index > 0 && x <= curve.xs[index - 1]) throw new Error('fused calibration xs must increase');
    if (index > 0 && y < curve.ys[index - 1]) throw new Error('fused calibration ys must not decrease');
  }
}

/** @param {string} directory @returns {string[]} */
function walkFiles(directory) {
  const output = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) output.push(...walkFiles(path));
    else output.push(path);
  }
  return output;
}

/**
 * @param {{root?: string, dist?: string | null, localTest?: boolean}} [options]
 */
export function assertShippingContract({ root = ROOT, dist = null, localTest = false } = {}) {
  const manifest = readJson(join(root, 'models', 'manifest.json'));
  const primary = manifest.models?.[0];
  if (!primary) throw new Error('model manifest has no primary entry');
  if (primary.artifact?.precision !== 'dynamic-int8') {
    throw new Error('shipping model precision must be dynamic-int8');
  }
  if (!String(primary.artifact?.file ?? '').endsWith('-int8.onnx')) {
    throw new Error('shipping artifact filename must identify INT8');
  }
  if (primary.tiling?.mode !== 'official-center') {
    throw new Error('shipping preprocessing must be official-center (Resize440+CenterCrop384)');
  }
  if (primary.tiling?.aggregation !== 'single-crop') {
    throw new Error('shipping aggregation must be single-crop');
  }

  const curve = readJson(join(root, 'models', 'calibration', 'fused.json'));
  assertMonotoneCurve(curve);
  if (curve.inputScoreColumn !== 'score_official_browser') {
    throw new Error('shipping curve must consume score_official_browser');
  }
  if (
    curve.runtimePreprocessing !== 'official-center-resize440-crop384' ||
    curve.runtimeAggregation !== 'single-crop'
  ) {
    throw new Error('shipping curve does not match runtime preprocessing/aggregation');
  }
  if (curve.modelSha256 !== primary.sha256) throw new Error('shipping curve/model SHA-256 mismatch');
  if (primary.calibration?.id !== curve.id || primary.calibration?.inputScoreColumn !== curve.inputScoreColumn) {
    throw new Error('model manifest does not identify the exact fused curve contract');
  }

  const configuredForShipping = Boolean(primary.url) && !localTest;
  if (configuredForShipping) {
    if (curve.shippingStatus !== 'validated') {
      throw new Error('model URL cannot ship while calibration evidence is quarantined');
    }
    if (!curve.shippingGate?.passed || curve.heldOutBalancedAccuracy < 0.75) {
      throw new Error('shipping accuracy gate is absent or below 0.75 balanced accuracy');
    }
    if (!Array.isArray(curve.leakageAudits) || curve.leakageAudits.length === 0) {
      throw new Error('shipping curve has no leakage-audit evidence');
    }
    if (curve.leakageAudits.some((/** @type {any} */ audit) => audit.status !== 'pass' || audit.rocAuc >= 0.70)) {
      throw new Error('shipping curve references a failed leakage audit');
    }
    if (!curve.calibrationRowsSha256 || !curve.evalRowsSha256 || !curve.refitConfigSha256) {
      throw new Error('shipping curve lacks split/config hashes');
    }
  }

  if (dist) {
    const files = walkFiles(dist);
    const forbidden = files.filter((path) => /fp32.*\.onnx$/i.test(path));
    if (forbidden.length > 0) throw new Error(`FP32 artifact present in distribution: ${forbidden.join(', ')}`);
    // Official-center is the SHIPPED preprocessing, so its presence is required.
    // walkFiles returns OS-native separators; match both \\ and /.
    const ocInManifest = files.some(
      (path) => /models[\\/]manifest\.json$/i.test(path) && /official-center/.test(readFileSync(path, 'utf8')),
    );
    if (!ocInManifest) {
      throw new Error('distribution model manifest does not enable official-center preprocessing');
    }
    // ort-engine.js is an import, not an entry point: its code lands in the
    // offscreen bundle. Check the bundled engine for the official-center branch.
    const ocInEngine = files.some(
      (path) => /offscreen[\\/]offscreen\.js$/.test(path) && /official-center/.test(readFileSync(path, 'utf8')),
    );
    if (!ocInEngine) {
      throw new Error('distribution engine does not implement official-center preprocessing');
    }
  }
  return { configuredForShipping, curveStatus: curve.shippingStatus };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  const result = assertShippingContract();
  console.log(`shipping assertions ok (configured=${result.configuredForShipping}, curve=${result.curveStatus})`);
}
