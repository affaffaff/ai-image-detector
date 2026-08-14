/**
 * Deterministic extension build: `npm run build` emits dist/, and the same
 * source tree MUST yield byte-identical output on every machine (the CI build
 * runs twice and compares hashes).
 *
 * Determinism rules:
 *  - esbuild is exact-pinned; its output embeds no timestamps or paths beyond
 *    stable relative entry names.
 *  - No sourcemaps in dist (they embed absolute paths).
 *  - Static assets are byte-copied, never regenerated (icons are committed).
 *  - Copy order is sorted; nothing derives from directory enumeration order.
 *
 * After writing, the script verifies that every file referenced by
 * manifest.json actually exists in dist/ — a broken reference fails the build
 * here, not at the evaluator's load-unpacked.
 */

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertShippingContract } from './assert_shipping.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');

/**
 * Dev builds (`npm run build:dev`) enable the mock engine by default so the
 * pipeline is visible without model weights, and rename the extension so a dev
 * build can never be mistaken for the real one. The RELEASE build — the one CI
 * verifies and maintainers reproduce — compiles __DEV_BUILD__ to false, which
 * dead-code-eliminates every mock default.
 */
const DEV = process.argv.includes('--dev');
const localModelIndex = process.argv.indexOf('--model');
const LOCAL_MODEL = localModelIndex >= 0 ? process.argv[localModelIndex + 1] : null;
if (localModelIndex >= 0 && !LOCAL_MODEL) {
  throw new Error('--model requires a path to an exported ONNX file');
}

assertShippingContract({ root: ROOT, localTest: Boolean(LOCAL_MODEL) });

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

// ---------------------------------------------------------------------------
// Bundles. Content scripts cannot be ES modules -> iife; extension pages and
// the module service worker use esm.

/** @type {{entry: string, out: string, format: 'esm' | 'iife'}[]} */
const bundles = [
  { entry: 'background/service-worker.js', out: 'background/service-worker.js', format: 'esm' },
  { entry: 'content/scanner.js', out: 'content/scanner.js', format: 'iife' },
  { entry: 'offscreen/offscreen.js', out: 'offscreen/offscreen.js', format: 'esm' },
  { entry: 'popup/popup.js', out: 'popup/popup.js', format: 'esm' },
];

for (const b of bundles) {
  await build({
    absWorkingDir: ROOT,
    // esbuild 0.28 on Windows can interpret `./src/...` as a package-like
    // entry and then walk above a restricted workspace while resolving it.
    // Absolute entry points are unambiguous and do not affect emitted paths
    // because every bundle already has an explicit outfile.
    entryPoints: [join(SRC, b.entry)],
    outfile: join(DIST, b.out),
    bundle: true,
    format: b.format,
    target: ['chrome116'],
    minify: false, // maintainers audit dist/ against src/ — keep it readable
    minifySyntax: true, // strips compile-time-false dev/mock paths from releases
    sourcemap: false,
    legalComments: 'inline',
    define: { __DEV_BUILD__: DEV ? 'true' : 'false' },
  });
}

// ---------------------------------------------------------------------------
// Static assets (sorted, explicit list — no glob enumeration order).

/** @type {[string, string][]} */
const copies = [
  [join(SRC, 'manifest.json'), join(DIST, 'manifest.json')],
  [join(SRC, 'offscreen/offscreen.html'), join(DIST, 'offscreen/offscreen.html')],
  [join(SRC, 'popup/popup.html'), join(DIST, 'popup/popup.html')],
  [join(ROOT, 'models/manifest.json'), join(DIST, 'models/manifest.json')],
  [
    join(ROOT, 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm'),
    join(DIST, 'ort/ort-wasm-simd-threaded.asyncify.wasm'),
  ],
  [
    join(ROOT, 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs'),
    join(DIST, 'ort/ort-wasm-simd-threaded.asyncify.mjs'),
  ],
];
for (const name of ['icon16.png', 'icon48.png', 'icon128.png']) {
  copies.push([join(SRC, 'icons', name), join(DIST, 'icons', name)]);
}
const localModelName = 'community-forensics-384-int8.onnx';
if (LOCAL_MODEL) {
  if (!existsSync(LOCAL_MODEL)) throw new Error(`local model not found: ${LOCAL_MODEL}`);
  copies.push([LOCAL_MODEL, join(DIST, 'models', localModelName)]);
}
// Explicit production allowlist. Diagnostic/experimental curves (especially
// center-crop evidence) must never hitch a ride in the package.
const calDir = join(ROOT, 'models/calibration');
if (existsSync(calDir)) {
  for (const f of ['detector.json', 'fused.json']) {
    if (existsSync(join(calDir, f))) copies.push([join(calDir, f), join(DIST, 'calibration', f)]);
  }
}

for (const [from, to] of copies) {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
}

// Dev builds are labeled in the extension list and popup title.
if (DEV || LOCAL_MODEL) {
  const path = join(DIST, 'manifest.json');
  const m = JSON.parse(readFileSync(path, 'utf8'));
  m.name = DEV ? `${m.name} (DEV — simulated scores)` : `${m.name} (Local Model)`;
  writeFileSync(path, JSON.stringify(m, null, 2) + '\n');
}

// A local-model build exists only for browser parity verification before the
// exported artifact is publicly hosted. The ordinary release build never
// bundles weights and continues to use the automatic setup download flow.
if (LOCAL_MODEL) {
  const modelPath = join(DIST, 'models', localModelName);
  const bytes = readFileSync(modelPath);
  const manifestPath = join(DIST, 'models', 'manifest.json');
  const modelManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const primary = modelManifest.models?.[0];
  if (!primary) throw new Error('models/manifest.json has no primary model entry');
  primary.url = null;
  primary.bundledPath = `models/${localModelName}`;
  primary.bytes = bytes.byteLength;
  primary.sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(manifestPath, JSON.stringify(modelManifest, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Post-build check: every path the manifest references must exist in dist.

const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));
/** @type {string[]} */
const referenced = [
  manifest.background?.service_worker,
  ...(manifest.content_scripts ?? []).flatMap((/** @type {{js?: string[], css?: string[]}} */ cs) => [
    ...(cs.js ?? []),
    ...(cs.css ?? []),
  ]),
  manifest.action?.default_popup,
  ...Object.values(manifest.action?.default_icon ?? {}),
  ...Object.values(manifest.icons ?? {}),
].filter(Boolean);

const missing = referenced.filter((p) => !existsSync(join(DIST, p)));
if (missing.length > 0) {
  console.error('manifest references missing files:', missing);
  process.exit(1);
}

// ONNX Runtime chooses its companion module/WASM variant at bundle time. Keep
// this check coupled to the emitted bundle so switching ORT entry points cannot
// silently copy a different variant and leave every browser scan failing at
// initWasm().
const offscreenBundle = readFileSync(join(DIST, 'offscreen', 'offscreen.js'), 'utf8');
const ortRuntimeAssets = [
  ...new Set(
    offscreenBundle.match(/ort-wasm-simd-threaded(?:\.[a-z]+)?\.(?:mjs|wasm)/g) ?? [],
  ),
];
const missingOrtRuntimeAssets = ortRuntimeAssets.filter(
  (name) => !existsSync(join(DIST, 'ort', name)),
);
if (ortRuntimeAssets.length === 0 || missingOrtRuntimeAssets.length > 0) {
  console.error(
    'ONNX Runtime bundle references missing companion assets:',
    missingOrtRuntimeAssets.length > 0 ? missingOrtRuntimeAssets : '(none detected in bundle)',
  );
  process.exit(1);
}
assertShippingContract({ root: ROOT, dist: DIST, localTest: Boolean(LOCAL_MODEL) });

console.log(
  `built dist/ [${DEV ? 'DEV — mock engine on by default' : 'RELEASE'}] — ` +
    `${bundles.length} bundles, ${copies.length} assets, manifest check ok`,
);
