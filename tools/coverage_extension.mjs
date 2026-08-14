// @ts-nocheck -- standalone CDP coverage utility, not extension runtime code.
/**
 * Measure live-site scan coverage through the real extension pipeline.
 *
 * Run a dev build in a fresh Chromium profile. The dev mock replaces only the
 * final model inference; candidate discovery, anonymous image fetch, byte cap,
 * decoding, service-worker routing, memoization, and badges are all real.
 *
 * Example:
 *   npm run build:dev
 *   msedge --headless=new --remote-debugging-port=9333 \
 *     --disable-extensions-except=dist --load-extension=dist \
 *     --user-data-dir=.cache/edge-coverage about:blank
 *   npm run coverage:browser -- --url "BBC News=https://www.bbc.com/news"
 */

const DEFAULT_SITES = [
  { name: 'Google Images', url: 'https://www.google.com/search?udm=2&q=photography' },
  { name: 'BBC News', url: 'https://www.bbc.com/news' },
  { name: 'The Guardian', url: 'https://www.theguardian.com/international' },
  { name: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Main_Page' },
];

function readPositiveInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got '${raw}'`);
  }
  return value;
}

function parseArgs(argv) {
  const sites = [];
  let port = null;
  let out = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--port') {
      const raw = argv[++index];
      port = Number(raw);
      if (!Number.isInteger(port) || port <= 0) throw new Error(`--port must be a positive integer, got '${raw}'`);
      continue;
    }
    if (arg === '--out') {
      out = argv[++index];
      if (!out) throw new Error('--out requires a JSON file path');
      continue;
    }
    if (arg !== '--url') {
      throw new Error(`unknown argument '${arg}' (expected --port N or --url "Name=https://...")`);
    }
    const spec = argv[++index];
    if (!spec) throw new Error('--url requires "Name=https://..." or "https://..."');
    const separator = spec.indexOf('=http');
    const name = separator > 0 ? spec.slice(0, separator) : new URL(spec).host;
    const url = separator > 0 ? spec.slice(separator + 1) : spec;
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`unsupported URL '${url}'`);
    sites.push({ name, url: parsed.href });
  }
  return { out, port, sites: sites.length > 0 ? sites : DEFAULT_SITES };
}

const args = parseArgs(process.argv.slice(2));
const port = args.port ?? readPositiveInteger('AID_CDP_PORT', 9333);
const pageTimeoutMs = readPositiveInteger('AID_COVERAGE_TIMEOUT_MS', 30_000);
const maxScrolls = readPositiveInteger('AID_COVERAGE_MAX_SCROLLS', 5);
const sites = args.sites;
const endpoint = `http://127.0.0.1:${port}`;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function retry(fn, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw lastError ?? new Error('operation timed out');
}

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) listener(message);
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
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

function remoteValue(value) {
  if (Object.hasOwn(value, 'value')) return String(value.value);
  return String(value.description ?? value.unserializableValue ?? '');
}

function parseHud(text) {
  const match = text.match(
    /AID dev\b.*?(\d+) img.*?(\d+) tracked.*?(\d+) scored.*?(\d+) pending.*?(\d+) failed.*?(\d+) setup.*?(\d+) too-small/,
  );
  if (!match) return null;
  const [, images, tracked, scored, pending, failed, setup, skipped] = match;
  return Object.fromEntries(
    Object.entries({ images, tracked, scored, pending, failed, setup, skipped }).map(([key, value]) => [
      key,
      Number(value),
    ]),
  );
}

function classifyFailure(error) {
  const text = error.toLowerCase();
  const http = text.match(/http\s+(\d{3})/);
  if (http) return `http-${http[1]}`;
  if (text.includes('timed out') || text.includes('timeout')) return 'timeout';
  if (text.includes('failed to fetch') || text.includes('networkerror')) return 'network';
  if (text.includes('too large') || text.includes('exceeded')) return 'size-limit';
  if (text.includes('decode') || text.includes('imagebitmap')) return 'decode';
  return 'other';
}

function urlHost(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'data:' ? 'data:' : url.host;
  } catch {
    return 'unknown';
  }
}

async function pageSnapshot(cdp, sessionId) {
  const evaluated = await cdp.send(
    'Runtime.evaluate',
    {
      expression: `({
        href: location.href,
        title: document.title,
        readyState: document.readyState,
        images: document.images.length,
        pageHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
        viewportHeight: innerHeight,
      })`,
      returnByValue: true,
    },
    sessionId,
  );
  return evaluated.result?.value ?? {};
}

async function hudSnapshot(cdp, sessionId) {
  const tree = await cdp.send('Accessibility.getFullAXTree', {}, sessionId);
  const values = (tree.nodes ?? []).flatMap((node) => [node.name?.value, node.value?.value]);
  for (const value of values) {
    if (typeof value !== 'string' || !value.includes('AID dev')) continue;
    const parsed = parseHud(value);
    if (parsed) return { text: value, ...parsed };
  }
  return null;
}

async function waitForLoad(cdp, sessionId) {
  return retry(async () => {
    const snapshot = await pageSnapshot(cdp, sessionId);
    if (!['interactive', 'complete'].includes(snapshot.readyState)) {
      throw new Error(`document is still ${snapshot.readyState ?? 'unavailable'}`);
    }
    return snapshot;
  }, Math.min(pageTimeoutMs, 20_000));
}

async function recordEligibleCandidates(cdp, sessionId) {
  const evaluated = await cdp.send(
    'Runtime.evaluate',
    {
      expression: String.raw`new Promise((resolve) => {
        const state = globalThis.__AID_COVERAGE_SEEN__ ??= {
          images: new WeakSet(),
          backgrounds: new WeakSet(),
          imageCount: 0,
          backgroundCount: 0,
        };
        const roots = [document];
        const images = [];
        const elements = [];
        while (roots.length > 0) {
          const root = roots.pop();
          for (const element of root.querySelectorAll('*')) {
            elements.push(element);
            if (element instanceof HTMLImageElement) images.push(element);
            if (element.shadowRoot) roots.push(element.shadowRoot);
          }
        }
        const inScanBand = (rect) =>
          rect.right >= -500 && rect.left <= innerWidth + 500 &&
          rect.bottom >= -500 && rect.top <= innerHeight + 500;
        const eligibleImages = [];
        for (const image of images) {
          const rect = image.getBoundingClientRect();
          const url = image.currentSrc || image.src;
          const eligible = /^(https?:|data:)/.test(url) &&
            !/\.svg(?:[?#]|$)/i.test(url) && !/^data:image\/svg(?:\+xml)?[;,]/i.test(url) &&
            image.complete &&
            image.naturalWidth > 0 && image.naturalHeight > 0 &&
            Math.min(rect.width, rect.height) >= 64 && inScanBand(rect);
          if (!eligible) continue;
          eligibleImages.push({
            element: image,
            sample: {
              host: (() => { try { return new URL(url).host || new URL(url).protocol; } catch { return 'unknown'; } })(),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              top: Math.round(rect.top),
              left: Math.round(rect.left),
              loading: image.loading,
            },
          });
        }
        const ignored = new Set([
          'SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'NOSCRIPT', 'BR', 'HR',
          'TEMPLATE', 'IFRAME', 'SVG', 'PATH', 'CANVAS', 'VIDEO', 'AUDIO',
          'SOURCE', 'TRACK', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION',
        ]);
        const eligibleBackgrounds = [];
        for (const element of elements) {
          if (!(element instanceof HTMLElement) || ignored.has(element.tagName)) continue;
          const rect = element.getBoundingClientRect();
          if (Math.min(rect.width, rect.height) < 64 || !inScanBand(rect)) continue;
          const background = getComputedStyle(element).backgroundImage;
          if (!/url\(\s*['\"]?(?:https?:|data:)/i.test(background)) continue;
          eligibleBackgrounds.push(element);
        }
        const intersecting = new Set();
        const candidates = [
          ...eligibleImages.map((item) => item.element),
          ...eligibleBackgrounds,
        ];
        const finish = () => {
          observer.disconnect();
          const currentImageItems = eligibleImages.filter((item) => intersecting.has(item.element));
          const currentBackgroundItems = eligibleBackgrounds.filter((element) => intersecting.has(element));
          for (const item of currentImageItems) {
            if (!state.images.has(item.element)) {
              state.images.add(item.element);
              state.imageCount += 1;
            }
          }
          for (const element of currentBackgroundItems) {
            if (!state.backgrounds.has(element)) {
              state.backgrounds.add(element);
              state.backgroundCount += 1;
            }
          }
          resolve({
            currentImages: currentImageItems.length,
            currentBackgrounds: currentBackgroundItems.length,
            seenImages: state.imageCount,
            seenBackgrounds: state.backgroundCount,
            seenTotal: state.imageCount + state.backgroundCount,
            currentImageSamples: currentImageItems.map((item) => item.sample),
          });
        };
        const observer = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) if (entry.isIntersecting) intersecting.add(entry.target);
          },
          { rootMargin: '500px' },
        );
        for (const candidate of candidates) observer.observe(candidate);
        setTimeout(finish, 50);
      })`,
      awaitPromise: true,
      returnByValue: true,
    },
    sessionId,
  );
  if (evaluated.exceptionDetails) return null;
  return evaluated.result?.value ?? null;
}

async function scrollPage(cdp, sessionId) {
  let candidates = await recordEligibleCandidates(cdp, sessionId);
  for (let index = 0; index < maxScrolls; index += 1) {
    const evaluated = await cdp.send(
      'Runtime.evaluate',
      {
        expression: `(() => {
          const height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
          const next = Math.min(height - innerHeight, Math.round((height - innerHeight) * ${(maxScrolls <= 1 ? 1 : 'INDEX / DENOMINATOR')}));
          scrollTo({top: Math.max(0, next), behavior: 'instant'});
          return {top: scrollY, height, viewport: innerHeight};
        })()`.replace('INDEX / DENOMINATOR', `${index} / ${maxScrolls - 1}`),
        returnByValue: true,
      },
      sessionId,
    );
    if (evaluated.exceptionDetails) break;
    await delay(750);
    candidates = await recordEligibleCandidates(cdp, sessionId);
  }
  return candidates;
}

async function waitForSettled(cdp, sessionId) {
  const deadline = Date.now() + pageTimeoutMs;
  let last = null;
  let stable = 0;
  while (Date.now() < deadline) {
    const hud = await hudSnapshot(cdp, sessionId);
    if (hud) {
      const signature = `${hud.tracked}:${hud.scored}:${hud.pending}:${hud.failed}:${hud.setup}`;
      stable = signature === last ? stable + 1 : 0;
      last = signature;
      if (hud.pending === 0 && stable >= 2) return { hud, timedOut: false };
    }
    await delay(500);
  }
  return { hud: await hudSnapshot(cdp, sessionId), timedOut: true };
}

const version = await retry(async () => {
  const response = await fetch(`${endpoint}/json/version`);
  if (!response.ok) throw new Error(`CDP HTTP ${response.status}`);
  return response.json();
});

const cdp = new Cdp(version.webSocketDebuggerUrl);
await cdp.open();

const results = [];
for (const site of sites) {
  console.error(`[coverage] ${site.name}: ${site.url}`);
  const failures = [];
  const scannerFrames = [];
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const sessionId = attached.sessionId;

  cdp.on('Runtime.consoleAPICalled', (message) => {
    if (message.sessionId !== sessionId) return;
    const args = (message.params?.args ?? []).map(remoteValue);
    if (args[0]?.startsWith('[ai-image-detector] scanner active')) scannerFrames.push(args.join(' '));
    if (!args[0]?.startsWith('[ai-image-detector] image could not be analyzed:')) return;
    failures.push({
      category: classifyFailure(args[1] ?? ''),
      error: args[1] ?? 'unknown error',
      urlHost: urlHost(args[2] ?? ''),
    });
  });

  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Accessibility.enable', {}, sessionId);
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    { width: 1365, height: 900, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );

  let navigationError = null;
  let eligible = null;
  try {
    const navigated = await cdp.send('Page.navigate', { url: site.url }, sessionId);
    if (navigated.errorText) throw new Error(navigated.errorText);
    await waitForLoad(cdp, sessionId);
    await delay(1_500);
    eligible = await scrollPage(cdp, sessionId);
  } catch (error) {
    navigationError = String(error);
  }

  const settled = navigationError
    ? { hud: await hudSnapshot(cdp, sessionId), timedOut: false }
    : await waitForSettled(cdp, sessionId);
  const page = await pageSnapshot(cdp, sessionId).catch(() => ({}));
  const hud = settled.hud;
  const failureCounts = Object.fromEntries(
    [...new Set(failures.map((failure) => failure.category))]
      .sort()
      .map((category) => [category, failures.filter((failure) => failure.category === category).length]),
  );
  const completed = hud ? hud.scored + hud.failed + hud.setup : 0;
  results.push({
    name: site.name,
    requestedUrl: site.url,
    finalUrl: page.href ?? null,
    title: page.title ?? null,
    navigationError,
    scannerActive: scannerFrames.length > 0,
    scannerFrames: scannerFrames.length,
    domImages: page.images ?? null,
    eligibleTopFrameNow: eligible ? eligible.currentImages + eligible.currentBackgrounds : null,
    eligibleTopFrameSeen: eligible?.seenTotal ?? null,
    eligibleImagesSeen: eligible?.seenImages ?? null,
    eligibleBackgroundsSeen: eligible?.seenBackgrounds ?? null,
    eligibleImageSamples: eligible?.currentImageSamples?.slice(0, 10) ?? [],
    tracked: hud?.tracked ?? null,
    scored: hud?.scored ?? null,
    failed: hud?.failed ?? null,
    pending: hud?.pending ?? null,
    setup: hud?.setup ?? null,
    fetchDecodeSuccess: completed > 0 && hud ? hud.scored / completed : null,
    timedOut: settled.timedOut,
    failureCounts,
    failures,
  });
  await cdp.send('Target.closeTarget', { targetId: target.targetId });
}

const report = JSON.stringify(
  {
    measuredAt: new Date().toISOString(),
    browser: version.Browser,
    mode: 'dev-mock (real discovery/fetch/decode; mock inference only)',
    viewport: { width: 1365, height: 900 },
    maxScrolls,
    pageTimeoutMs,
    results,
  },
  null,
  2,
);
if (args.out) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { dirname, resolve } = await import('node:path');
  const path = resolve(args.out);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${report}\n`, 'utf8');
  console.error(`[coverage] wrote ${path}`);
}
console.log(report);
cdp.socket.close();
