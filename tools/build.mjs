/**
 * Deterministic extension build: `npm run build` emits dist/, and the same
 * source tree MUST yield byte-identical output on every machine (bounty
 * reproducibility requirement; CI builds twice and diffs).
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
    entryPoints: [join(SRC, b.entry)],
    outfile: join(DIST, b.out),
    bundle: true,
    format: b.format,
    target: ['chrome116'],
    minify: false, // maintainers audit dist/ against src/ — keep it readable
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
];
for (const name of ['icon16.png', 'icon48.png', 'icon128.png']) {
  copies.push([join(SRC, 'icons', name), join(DIST, 'icons', name)]);
}
// Fitted calibration curves ship with the extension once they exist.
const calDir = join(ROOT, 'models/calibration');
if (existsSync(calDir)) {
  for (const f of readdirSync(calDir).sort()) {
    if (f.endsWith('.json')) copies.push([join(calDir, f), join(DIST, 'calibration', f)]);
  }
}

for (const [from, to] of copies) {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
}

// Dev builds are labeled in the extension list and popup title.
if (DEV) {
  const path = join(DIST, 'manifest.json');
  const m = JSON.parse(readFileSync(path, 'utf8'));
  m.name = `${m.name} (DEV — simulated scores)`;
  writeFileSync(path, JSON.stringify(m, null, 2) + '\n');
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

console.log(
  `built dist/ [${DEV ? 'DEV — mock engine on by default' : 'RELEASE'}] — ` +
    `${bundles.length} bundles, ${copies.length} assets, manifest check ok`,
);
