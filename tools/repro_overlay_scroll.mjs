// @ts-nocheck -- scratch repro harness; CDP client modeled on smoke_extension.mjs
/**
 * Overlay repro: badges vs a page-layer overlay (fake autocomplete menu).
 *
 *   node tools/repro_overlay_scroll.mjs
 *
 * Launches Chrome with dist/ loaded, serves a synthetic image grid, and saves
 * screenshots for each state under test/fixtures/overlay-scroll/:
 *   repro-a-loaded.png          badges at tile corners
 *   repro-b-dropdown.png        menu open, idle: covered badges must hide
 *   repro-c-dropdown-scroll.png menu open, after scroll: still hidden
 *   repro-d-midscroll.png       mid-scroll frame: badges glued to corners
 *   repro-e-closed.png          menu closed: badges back
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SHOT_DIR = join(root, 'test', 'fixtures', 'overlay-scroll');
const CHROME = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CDP_PORT = 9444;

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; background: #202124; font-family: sans-serif; }
  #grid { display: grid; grid-template-columns: repeat(5, 220px); gap: 12px; padding: 12px; padding-top: 76px; }
  #grid img { width: 220px; height: 220px; display: block; border-radius: 8px; }
  #header {
    position: fixed; top: 0; left: 0; right: 0; height: 60px; z-index: 50;
    background: #1f1f1f; border-bottom: 1px solid #3c4043; color: #e8eaed;
    display: flex; align-items: center; padding: 0 20px; box-sizing: border-box;
  }
  #menu {
    position: absolute; left: 60px; top: 60px; width: 760px; height: 560px;
    background: #303134; border-radius: 12px; z-index: 100; display: none;
    box-shadow: 0 8px 30px rgba(0,0,0,.6); padding: 20px; color: #e8eaed;
  }
</style></head><body>
<div id="grid"></div>
<div id="header">fake fixed header</div>
<div id="menu"><h2>fake autocomplete menu</h2><p>covers the grid like Google suggestions</p></div>
<script>
  const grid = document.getElementById('grid');
  for (let i = 0; i < 60; i++) {
    const c = document.createElement('canvas');
    c.width = 220; c.height = 220;
    const g = c.getContext('2d');
    g.fillStyle = 'hsl(' + ((i * 47) % 360) + ',70%,55%)';
    g.fillRect(0, 0, 220, 220);
    g.fillStyle = '#fff';
    g.font = 'bold 60px sans-serif';
    g.fillText(String(i), 20, 120);
    const img = document.createElement('img');
    img.src = c.toDataURL('image/png');
    grid.appendChild(img);
  }
  window.toggleMenu = (on) => {
    document.getElementById('menu').style.display = on ? 'block' : 'none';
  };
</script></body></html>`;

function serve() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE_HTML);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpVersion() {
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (res.ok) return await res.json();
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('CDP endpoint never came up');
    await sleep(250);
  }
}

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.socket.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
        if (text.includes('ai-image-detector')) console.log('[page]', text.slice(0, 300));
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }
  open() {
    return new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

async function main() {
  const server = await serve();
  const pageUrl = `http://127.0.0.1:${server.address().port}/`;
  const profile = mkdtempSync(join(tmpdir(), 'aid-repro-'));
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    `--load-extension=${join(root, 'dist')}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--headless=new',
    '--window-size=1280,900',
    'about:blank',
  ], { stdio: 'ignore' });

  const cleanup = () => {
    try { chrome.kill('SIGKILL'); } catch { /* already dead */ }
    server.close();
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* locked */ }
  };
  process.on('exit', cleanup);

  try {
    const version = await cdpVersion();
    console.log('browser:', version.Browser);
    const cdp = new Cdp(version.webSocketDebuggerUrl);
    await cdp.open();

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);

    const evaluate = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true,
      }, sessionId);
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };
    const shot = async (name) => {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      mkdirSync(SHOT_DIR, { recursive: true });
      writeFileSync(join(SHOT_DIR, name), Buffer.from(data, 'base64'));
      console.log('saved', join('test/fixtures/overlay-scroll', name));
    };

    console.log('page:', pageUrl);
    await cdp.send('Page.navigate', { url: pageUrl }, sessionId);
    await sleep(4000); // mock engine badges

    const state = await evaluate(`(() => ({
      nativeAnchor: CSS.supports('position-anchor: --aid-anchor') && CSS.supports('left: anchor(left)'),
      overlays: document.querySelectorAll('[data-ai-image-detector]').length,
      images: document.images.length,
    }))()`);
    console.log('page state:', JSON.stringify(state));

    await shot('repro-a-loaded.png');

    await evaluate('window.toggleMenu(true)');
    await sleep(1200); // mutation -> idle hit test
    await shot('repro-b-dropdown.png');

    await evaluate('window.scrollTo(0, 500)');
    await sleep(300); // mid-settle: badges must NOT flash over the menu
    await shot('repro-c-dropdown-scroll.png');
    await sleep(1200);
    await shot('repro-c2-settled.png');

    await evaluate('window.toggleMenu(false)');
    await sleep(1200);
    await shot('repro-e-closed.png');

    // Drift probe: continuous wheel scrolling, capture a frame mid-gesture.
    await evaluate('window.scrollTo(0, 0)');
    await sleep(800);
    const screencast = async () => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 640, y: 450, deltaX: 0, deltaY: 240 }, sessionId);
    };
    for (let i = 0; i < 12; i++) {
      await screencast();
      if (i === 5) await shot('repro-d-midscroll.png');
      await sleep(40);
    }
    await sleep(800);
    await shot('repro-d2-settled.png');

    await cdp.send('Target.closeTarget', { targetId });
  } finally {
    cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
