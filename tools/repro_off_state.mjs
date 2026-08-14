// @ts-nocheck -- full cycle E2E: badge -> off (hidden) -> on (restored)
const endpoint = `http://127.0.0.1:9333`;

async function retry(fn, timeoutMs = 30_000, label = 'op') {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`${label}: ${lastError?.message ?? 'timeout'}`);
}

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const m = JSON.parse(String(event.data));
      if (!m.id) return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
    });
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(message));
    });
  }
}

const version = await (await fetch(`${endpoint}/json/version`)).json();
const cdp = new Cdp(version.webSocketDebuggerUrl);
await cdp.open();

async function evalOn(session, expression) {
  const r = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    session,
  );
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result?.value;
}

async function makePage() {
  return retry(async () => {
    const t = await cdp.send('Target.createTarget', { url: 'https://example.com' });
    const a = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    const session = a.sessionId;
    await cdp.send('Runtime.enable', {}, session);
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        const s = await evalOn(session, '({r: document.readyState, h: location.href})');
        if (s?.r === 'complete' && String(s?.h).startsWith('https://example.com')) break;
      } catch {}
      if (Date.now() > deadline) throw new Error('page never loaded');
      await new Promise((r) => setTimeout(r, 200));
    }
    return session;
  }, 30_000, 'make page');
}

async function swEval(expression) {
  return retry(async () => {
    const targets = await (await fetch(`${endpoint}/json`)).json();
    const sw = targets.find(
      (t) => t.type === 'service_worker' && t.url.includes('/background/service-worker.js'),
    );
    if (!sw) throw new Error('no SW target');
    const w = new Cdp(sw.webSocketDebuggerUrl);
    await w.open();
    await w.send('Runtime.enable');
    const r = await w.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    w.socket.close();
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result?.value;
  }, 20_000, 'sw eval');
}

const PROBE = `(() => {
  const overlays = [...document.querySelectorAll('[data-ai-image-detector="overlay"]')];
  const visible = overlays.filter((el) => {
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  });
  return {
    overlays: overlays.length,
    visible: visible.length,
    hideStyle: Boolean(document.getElementById('ai-image-detector-off')),
    hiddenMarkers: document.querySelectorAll('[data-ai-image-detector-hidden]').length,
  };
})()`;

// --- 1. badge appears ---
const page = await makePage();
await evalOn(
  page,
  `new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = 384; canvas.height = 384;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#e7904f'; ctx.fillRect(0, 0, 384, 384);
    const img = document.createElement('img');
    img.width = 384; img.height = 384;
    img.style.cssText = 'display:block;width:384px;height:384px';
    img.onload = () => resolve(true);
    img.onerror = () => reject(new Error('img fail'));
    img.src = canvas.toDataURL('image/png');
    document.body.appendChild(img);
  })`,
);
const before = await retry(async () => {
  const s = await evalOn(page, PROBE);
  if (!s || s.visible === 0) throw new Error(`no visible badge yet: ${JSON.stringify(s)}`);
  return s;
}, 30_000, 'badge visible');
console.log('1 ON    :', JSON.stringify(before));

// --- 2. Detection off ---
await swEval(`chrome.storage.local.set({ enabled: false }).then(() => 'ok')`);
const off = await retry(async () => {
  const s = await evalOn(page, PROBE);
  if (!s || s.visible !== 0) throw new Error(`still visible: ${JSON.stringify(s)}`);
  return s;
}, 10_000, 'badges hidden');
console.log('2 OFF   :', JSON.stringify(off));

// --- 3. Detection back on: badges restored, no hide remnants ---
await swEval(`chrome.storage.local.set({ enabled: true }).then(() => 'ok')`);
const on = await retry(async () => {
  const s = await evalOn(page, PROBE);
  if (!s || s.visible === 0 || s.hideStyle || s.hiddenMarkers !== 0) {
    throw new Error(`not restored: ${JSON.stringify(s)}`);
  }
  return s;
}, 15_000, 'badges restored');
console.log('3 RE-ON :', JSON.stringify(on));

console.log('PASS: off hides, on restores');
cdp.socket.close();
process.exit(0);
