// @ts-nocheck -- compact DevTools Protocol client used only by the smoke command.
/** Browser E2E smoke for release/no-model, dev/mock, and local/ORT builds. */

import { readFileSync } from 'node:fs';

const fusedCalibration = JSON.parse(
  readFileSync(new URL('../models/calibration/fused.json', import.meta.url), 'utf8'),
);
const smokeImagePath = process.env.AID_SMOKE_IMAGE;
const smokeImageDataUrl = smokeImagePath
  ? `data:${smokeImagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'};base64,${readFileSync(smokeImagePath).toString('base64')}`
  : null;
const expectedMode = process.env.AID_EXPECT_MODE ?? 'ort';
if (!['no-model', 'mock', 'ort'].includes(expectedMode)) {
  throw new Error(`AID_EXPECT_MODE must be no-model, mock, or ort; got '${expectedMode}'`);
}

function applyCalibration(raw, table = fusedCalibration) {
  const { xs, ys } = table;
  if (raw <= xs[0]) return ys[0];
  if (raw >= xs.at(-1)) return ys.at(-1);
  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= raw) lo = mid;
    else hi = mid;
  }
  const t = (raw - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] + t * (ys[hi] - ys[lo]);
}

const port = Number(process.env.AID_CDP_PORT ?? 9333);
const endpoint = `http://127.0.0.1:${port}`;

async function retry(fn, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError ?? new Error('operation timed out');
}

const version = await retry(async () => {
  const response = await fetch(`${endpoint}/json/version`);
  if (!response.ok) throw new Error(`CDP HTTP ${response.status}`);
  return response.json();
});

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
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
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

const cdp = new Cdp(version.webSocketDebuggerUrl);
await cdp.open();
console.error('connected to browser CDP');

const pageTarget = await cdp.send('Target.createTarget', { url: 'https://example.com' });
console.error(`created page target ${pageTarget.targetId}`);
const pageAttached = await cdp.send('Target.attachToTarget', {
  targetId: pageTarget.targetId,
  flatten: true,
});
const pageSession = pageAttached.sessionId;
await cdp.send('Runtime.enable', {}, pageSession);
await retry(async () => {
  const evaluated = await cdp.send(
    'Runtime.evaluate',
    {
      expression: '({readyState: document.readyState, href: location.href})',
      returnByValue: true,
    },
    pageSession,
  );
  const state = evaluated.result?.value;
  if (state?.readyState !== 'complete' || !String(state?.href ?? '').startsWith('https://example.com')) {
    throw new Error(`page is still navigating: ${JSON.stringify(state)}`);
  }
  return evaluated;
});
console.error('attached to page target');

const injected = await cdp.send(
  'Runtime.evaluate',
  {
    expression: `new Promise((resolve, reject) => {
      document.body.innerHTML = '<main><h1>Detector smoke test</h1></main>';
      const canvas = document.createElement('canvas');
      canvas.width = 384;
      canvas.height = 384;
      const context = canvas.getContext('2d');
      const gradient = context.createLinearGradient(0, 0, 384, 384);
      gradient.addColorStop(0, '#153a72');
      gradient.addColorStop(0.5, '#e7904f');
      gradient.addColorStop(1, '#183d26');
      context.fillStyle = gradient;
      context.fillRect(0, 0, 384, 384);
      context.fillStyle = '#f7f3e9';
      context.font = 'bold 48px sans-serif';
      context.fillText('REAL ORT', 65, 205);
      const image = document.createElement('img');
      image.id = 'detector-smoke-image';
      image.width = 384;
      image.height = 384;
      image.style.cssText = 'display:block;width:384px;height:384px';
      image.onload = () => resolve({url: image.currentSrc, width: image.naturalWidth, height: image.naturalHeight});
      image.onerror = () => reject(new Error('smoke image failed to load'));
      image.src = ${smokeImageDataUrl ? JSON.stringify(smokeImageDataUrl) : "canvas.toDataURL('image/png')"};
      document.querySelector('main').appendChild(image);
    })`,
    awaitPromise: true,
    returnByValue: true,
  },
  pageSession,
);
if (injected.exceptionDetails) throw new Error('page image injection failed');
console.error(
  `injected image ${JSON.stringify({
    ...injected.result?.value,
    url: String(injected.result?.value?.url ?? '').slice(0, 32) + '…',
  })}`,
);

const serviceWorker = await retry(async () => {
  const response = await fetch(`${endpoint}/json`);
  if (!response.ok) throw new Error(`target list HTTP ${response.status}`);
  const targets = await response.json();
  const match = targets.find(
    (target) =>
      target.type === 'service_worker' && target.url.endsWith('/background/service-worker.js'),
  );
  if (!match) throw new Error('extension service worker target not found');
  return match;
}, 30_000);
console.error(`found service worker ${serviceWorker.url}`);
const workerCdp = new Cdp(serviceWorker.webSocketDebuggerUrl);
await workerCdp.open();
await workerCdp.send('Runtime.enable');
console.error('attached to service worker');

const statusEvaluation = await retry(async () => {
  const evaluated = await workerCdp.send(
    'Runtime.evaluate',
    {
      expression: `Promise.race([
        chrome.runtime.sendMessage({type: 'model:status-get', target: 'offscreen'}),
        new Promise((resolve) => setTimeout(() => resolve({state: 'status-timeout'}), 5000)),
      ])`,
      awaitPromise: true,
      returnByValue: true,
    },
  );
  if (evaluated.exceptionDetails) throw new Error('extension status request failed');
  const state = evaluated.result?.value?.state;
  if (expectedMode === 'ort' && state !== 'ready') {
    throw new Error(`model is still ${state ?? 'unavailable'}`);
  }
  if (expectedMode !== 'ort' && !['missing', 'not-configured'].includes(state)) {
    throw new Error(`expected an unavailable model, got ${state ?? 'unavailable'}`);
  }
  return evaluated;
}, 60_000);
console.error(`preflight status: ${JSON.stringify(statusEvaluation.result?.value)}`);

const directInference = await workerCdp.send('Runtime.evaluate', {
  expression: `chrome.runtime.sendMessage({
    type: 'infer:run',
    target: 'offscreen',
    id: 'direct-smoke',
    url: ${JSON.stringify(injected.result?.value?.url)},
    allowMock: ${expectedMode === 'mock'},
  })`,
  awaitPromise: true,
  returnByValue: true,
});
if (directInference.exceptionDetails) throw new Error('direct inference request failed');
console.error(`direct inference: ${JSON.stringify(directInference.result?.value)}`);
const directRaw = directInference.result?.value?.raw;
if (expectedMode === 'no-model') {
  if (directInference.result?.value?.ok || directInference.result?.value?.error !== 'no-model') {
    throw new Error(`expected no-model inference result: ${JSON.stringify(directInference.result?.value)}`);
  }
} else if (directInference.result?.value?.engine !== expectedMode || !Number.isFinite(directRaw)) {
  throw new Error(
    `${expectedMode} inference did not return a finite raw score: ${JSON.stringify(directInference.result?.value)}`,
  );
}

async function accessibleText() {
  const tree = await cdp.send('Accessibility.getFullAXTree', {}, pageSession);
  return (tree.nodes ?? [])
    .flatMap((node) => [node.name?.value, node.value?.value, node.description?.value])
    .filter((value) => typeof value === 'string' && value.length > 0);
}

const expectedBadge = await retry(async () => {
  const text = await accessibleText();
  if (expectedMode === 'no-model') {
    const notice = 'AI detector · setup required';
    if (!text.includes(notice)) {
      throw new Error(`setup notice is not exposed: ${JSON.stringify(text)}`);
    }
    return notice;
  }
  if (expectedMode === 'mock') {
    if (!text.includes('MOCK')) throw new Error(`mock badge is not exposed: ${JSON.stringify(text)}`);
    return 'MOCK';
  }
  const score = text.find((value) => /^(?:AI )?\d+%$/.test(value));
  if (!score) throw new Error(`scored badge is not exposed: ${JSON.stringify(text)}`);
  return score;
}, 30_000);

const pageState = await cdp.send(
  'Runtime.evaluate',
  {
    expression: `({
      images: [...document.images].map((image) => ({
        src: image.currentSrc.slice(0, 32) + '…',
        complete: image.complete,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        rect: image.getBoundingClientRect().toJSON(),
      })),
      overlayHosts: [...document.documentElement.children].filter(
        (element) => element.style.zIndex === '2147483647'
      ).length,
    })`,
    returnByValue: true,
  },
  pageSession,
);
console.error(`page state: ${JSON.stringify(pageState.result?.value)}`);
if (pageState.result?.value?.overlayHosts !== 1) {
  throw new Error(`expected one isolated overlay host: ${JSON.stringify(pageState.result?.value)}`);
}

const injectedUrl = injected.result?.value?.url;
const result = expectedMode === 'no-model' ? {
  url: injectedUrl,
  update: { state: 'no-model', badge: expectedBadge },
} : !/^https?:/.test(injectedUrl) ? (() => {
  // Inline URLs are deliberately excluded from chrome.storage.session: the
  // URL contains the image bytes and would quickly exhaust the extension's
  // quota. Validate the visible result against the direct inference instead
  // of waiting for a memo entry that must never exist.
  const probability = applyCalibration(directRaw);
  const isAI = probability >= 0.65;
  const expectedInlineBadge = expectedMode === 'mock'
    ? 'MOCK'
    : `${isAI ? 'AI ' : ''}${Math.round(probability * 100)}%`;
  if (expectedBadge !== expectedInlineBadge) {
    throw new Error(
      `inline badge calibration mismatch: got ${expectedBadge}, expected ${expectedInlineBadge}`,
    );
  }
  return {
    url: injectedUrl,
    update: { state: 'scored', probability, isAI, engine: expectedMode },
  };
})() : await retry(async () => {
  const evaluated = await workerCdp.send(
    'Runtime.evaluate',
    {
      expression: `chrome.storage.session.get('scanMemo').then(({scanMemo = {}}) => scanMemo)`,
      awaitPromise: true,
      returnByValue: true,
    },
  );
  if (evaluated.exceptionDetails) throw new Error('could not read extension session memo');
  const memo = evaluated.result?.value ?? {};
  const url = injectedUrl;
  const stored = memo[url];
  if (!stored) throw new Error('real inference for the injected image has not completed yet');
  if (stored?.update?.state !== 'scored' || stored.update.engine !== expectedMode) {
    throw new Error(`unexpected scan update: ${JSON.stringify(stored?.update)}`);
  }
  const expectedProbability = applyCalibration(directRaw);
  if (Math.abs(stored.update.probability - expectedProbability) > 1e-6) {
    throw new Error(
      `browser calibration mismatch: got ${stored.update.probability}, expected ${expectedProbability}`,
    );
  }
  return { url, update: stored.update };
}, 120_000);

console.log(
  JSON.stringify(
    {
      chrome: version.Browser,
      mode: expectedMode,
      extensionId: new URL(serviceWorker.url).host,
      image: {
        width: injected.result?.value?.width,
        height: injected.result?.value?.height,
        urlPrefix: String(injected.result?.value?.url ?? '').slice(0, 32) + '…',
      },
      result: {
        urlPrefix: String(result.url).slice(0, 32) + '…',
        raw: directRaw,
        update: {
          ...result.update,
          url: String(result.update.url ?? result.url).slice(0, 32) + '...',
        },
      },
    },
    null,
    2,
  ),
);
cdp.socket.close();
workerCdp.socket.close();
