// @ts-nocheck -- standalone gallery screenshot capture, not extension runtime code.
/**
 * Capture presentation screenshots of the extension running real inference.
 *
 * Serves gallery/demo-images over a local HTTP server, loads a demo grid page
 * in headless Edge with dist/ loaded, waits for every badge to reach a scored
 * state through the real ORT pipeline, then captures screenshots into
 * gallery/shots/.
 *
 * Usage: node tools/capture_gallery.mjs
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const shotsDir = join(root, 'gallery', 'shots');
mkdirSync(shotsDir, { recursive: true });

const HTTP_PORT = 8712;
const CDP_PORT = 9337;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PROFILE = join(root, '.cache', 'edge-gallery');

const MIME = { '.html': 'text/html', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };

const IMAGES = [
  { file: 'ai-portrait.png', label: 'PORTRAIT A', kind: 'ai' },
  { file: 'real-portrait.jpg', label: 'PORTRAIT B', kind: 'real' },
  { file: 'ai-landscape.png', label: 'LANDSCAPE A', kind: 'ai' },
  { file: 'real-landscape.jpg', label: 'LANDSCAPE B', kind: 'real' },
  { file: 'ai-cat.png', label: 'SUBJECT A', kind: 'ai' },
  { file: 'real-cat.jpg', label: 'SUBJECT B', kind: 'real' },
];

const demoPage = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin:0; background:#04070f; font:12px/1.5 ui-monospace,Consolas,monospace; color:#c8d4f0; }
  header { padding:22px 34px 14px; border-bottom:1px solid rgba(0,240,255,.16); display:flex; justify-content:space-between; align-items:baseline; }
  h1 { margin:0; font-size:15px; letter-spacing:3px; color:#eaffff; text-shadow:0 0 10px rgba(0,240,255,.8); font-weight:700; }
  header span { color:#5b6b8c; font-size:10px; letter-spacing:2px; }
  .grid { display:grid; grid-template-columns:repeat(3,1fr); gap:22px; padding:26px 34px 34px; }
  figure { margin:0; }
  img { display:block; width:100%; height:240px; object-fit:cover; border:1px solid rgba(0,240,255,.14); }
  figcaption { padding:7px 2px 0; font-size:9px; letter-spacing:2px; color:#5b6b8c; }
</style></head><body>
  <header><h1>AI IMAGE DETECTOR</h1><span>LIVE ON-DEVICE SCAN // NEURAL FORENSICS</span></header>
  <div class="grid">
    ${IMAGES.map((img) => `<figure><img src="/demo-images/${img.file}" alt="${img.label}"><figcaption>${img.label} // 1536×1024 CLASS</figcaption></figure>`).join('\n    ')}
  </div>
</body></html>`;

// ---------- tiny static server ----------
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/' || url.pathname === '/demo.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(demoPage);
    return;
  }
  /** @type {string} */
  let pathname;
  try {
    // Malformed percent-encoding makes decodeURIComponent throw URIError;
    // without this catch one bad request crashed the capture run.
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    res.end('bad request');
    return;
  }
  const galleryRoot = join(root, 'gallery');
  const file = normalize(join(galleryRoot, pathname));
  // Containment: join() collapses `..`, so `/../../x` would otherwise escape
  // the gallery. Bare startsWith also admits SIBLING paths (`gallery-evil`),
  // so require the separator.
  if (file !== galleryRoot && !file.startsWith(galleryRoot + sep)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  try {
    const data = readFileSync(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((resolve) => server.listen(HTTP_PORT, '127.0.0.1', resolve));
console.error(`demo server on http://127.0.0.1:${HTTP_PORT}`);

// ---------- launch browser ----------
// dist/ is rebuilt by other work in this repo; load a frozen copy instead.
const distAbs = join(root, '.cache', 'gallery-dist');
const browser = spawn(EDGE, [
  '--headless=new',
  `--remote-debugging-port=${CDP_PORT}`,
  `--disable-extensions-except=${distAbs}`,
  `--load-extension=${distAbs}`,
  `--user-data-dir=${PROFILE}`,
  '--window-size=1440,960',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=msHubApps,msEdgeSyncConfirmation',
  'about:blank',
], { cwd: root, stdio: 'ignore' });

const cleanup = () => {
  try { browser.kill(); } catch {}
  server.close();
};
process.on('exit', cleanup);

const endpoint = `http://127.0.0.1:${CDP_PORT}`;
async function retry(fn, timeoutMs = 30_000, label = 'operation') {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { return await fn(); } catch (error) { lastError = error; await new Promise((r) => setTimeout(r, 300)); }
  }
  throw new Error(`${label} timed out: ${lastError?.message ?? 'unknown'}`);
}

class Cdp {
  constructor(url) { this.socket = new WebSocket(url); this.nextId = 1; this.pending = new Map(); }
  open() {
    return new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
      this.socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data));
        if (!message.id) return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      });
    });
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }
}

async function evaluate(cdp, sessionId, expression, awaitPromise = false) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, sessionId);
  if (result.exceptionDetails) throw new Error(`page evaluation failed: ${JSON.stringify(result.exceptionDetails).slice(0, 300)}`);
  return result.result?.value;
}

async function screenshot(cdp, sessionId, name) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  const path = join(shotsDir, name);
  writeFileSync(path, Buffer.from(shot.data, 'base64'));
  console.error(`saved ${path}`);
  return path;
}

const version = await retry(async () => {
  const response = await fetch(`${endpoint}/json/version`);
  if (!response.ok) throw new Error(`CDP HTTP ${response.status}`);
  return response.json();
}, 30_000, 'CDP connection');
console.error(`connected: ${version.Browser}`);

const cdp = new Cdp(version.webSocketDebuggerUrl);
await cdp.open();

// ---------- demo page first: the content script wakes the MV3 worker ----------
const pageTarget = await cdp.send('Target.createTarget', { url: `http://127.0.0.1:${HTTP_PORT}/demo.html` });
const pageSession = (await cdp.send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true })).sessionId;
await cdp.send('Runtime.enable', {}, pageSession);
await cdp.send('Page.enable', {}, pageSession);
await retry(async () => {
  const state = await evaluate(cdp, pageSession, 'document.readyState');
  if (state !== 'complete') throw new Error('page loading');
}, 30_000, 'demo page load');

// ---------- find the extension service worker ----------
const serviceWorker = await retry(async () => {
  const targets = await (await fetch(`${endpoint}/json`)).json();
  const match = targets.find((t) => t.type === 'service_worker' && t.url.endsWith('/background/service-worker.js'));
  if (!match) throw new Error(`service worker not found yet (targets: ${targets.map((t) => t.type).join(',')})`);
  return match;
}, 60_000, 'service worker discovery');
const extensionId = new URL(serviceWorker.url).host;
console.error(`extension id: ${extensionId}`);
const workerCdp = new Cdp(serviceWorker.webSocketDebuggerUrl);
await workerCdp.open();
await workerCdp.send('Runtime.enable');

// wait for the model to be ready and all six images scored
const expectedUrls = IMAGES.map((img) => `http://127.0.0.1:${HTTP_PORT}/demo-images/${img.file}`);
const scores = await retry(async () => {
  const memo = await evaluate(workerCdp, undefined, `chrome.storage.session.get('scanMemo').then(({scanMemo = {}}) => scanMemo)`, true);
  const found = {};
  for (const [url, entry] of Object.entries(memo)) {
    if (entry?.update?.state === 'scored') found[url] = entry.update;
  }
  const missing = expectedUrls.filter((url) => !found[url]);
  console.error(`scored ${expectedUrls.length - missing.length}/${expectedUrls.length}`);
  if (missing.length) throw new Error(`waiting for ${missing.length} score(s)`);
  return found;
}, 240_000, 'real inference scoring');
for (const img of IMAGES) {
  const url = `http://127.0.0.1:${HTTP_PORT}/demo-images/${img.file}`;
  const update = scores[url];
  console.error(`${img.file}: p=${update.probability?.toFixed(3)} ai=${update.isAI} engine=${update.engine}`);
}

// give badges a beat to render, then full-page shot
await new Promise((r) => setTimeout(r, 1500));
await screenshot(cdp, pageSession, '01-live-scan.png');

// ---------- badge detail popover (click first scored badge) ----------
const clickPoint = await evaluate(cdp, pageSession, `(() => {
  const img = document.querySelector('img');
  const rect = img.getBoundingClientRect();
  return { x: rect.left + 30, y: rect.top + 14 };
})()`);
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickPoint.x, y: clickPoint.y, button: 'left', clickCount: 1 }, pageSession);
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickPoint.x, y: clickPoint.y, button: 'left', clickCount: 1 }, pageSession);
await new Promise((r) => setTimeout(r, 900));
await screenshot(cdp, pageSession, '02-badge-detail.png');

// ---------- popup UI ----------
const popupTarget = await cdp.send('Target.createTarget', { url: `chrome-extension://${extensionId}/popup/popup.html` });
const popupSession = (await cdp.send('Target.attachToTarget', { targetId: popupTarget.targetId, flatten: true })).sessionId;
await cdp.send('Runtime.enable', {}, popupSession);
await cdp.send('Page.enable', {}, popupSession);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 460, deviceScaleFactor: 2, mobile: false }, popupSession);
await retry(async () => {
  const state = await evaluate(cdp, popupSession, `document.querySelector('#model-state')?.textContent ?? ''`);
  if (!state || state === '…') throw new Error('popup status not loaded');
  return state;
}, 30_000, 'popup status');
await new Promise((r) => setTimeout(r, 800));
await screenshot(cdp, popupSession, '03-popup.png');

console.log(JSON.stringify({ ok: true, shots: ['01-live-scan.png', '02-badge-detail.png', '03-popup.png'], scores: Object.fromEntries(IMAGES.map((img) => {
  const update = scores[`http://127.0.0.1:${HTTP_PORT}/demo-images/${img.file}`];
  return [img.file, { probability: update.probability, isAI: update.isAI, engine: update.engine }];
})) }, null, 2));

cleanup();
process.exit(0);
