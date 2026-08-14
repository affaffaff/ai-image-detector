// @ts-nocheck -- standalone CDP evaluation utility, not extension runtime code.
/** Score a CSV manifest through the exact built Edge/ORT-Web extension path. */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, resolve } from 'node:path';

const args = process.argv.slice(2);
function valueAfter(flag) {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1]) throw new Error(`${flag} is required`);
  return args[index + 1];
}

const manifestPath = resolve(valueAfter('--set'));
const outputPath = resolve(valueAfter('--out'));
const port = Number(process.env.AID_CDP_PORT ?? 9333);
const endpoint = `http://127.0.0.1:${port}`;

function parseCsv(text) {
  const records = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      if (row.some((value) => value !== '')) records.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/, ''));
    records.push(row);
  }
  if (quoted) throw new Error('unterminated quoted CSV field');
  const [header, ...body] = records;
  if (!header) throw new Error('empty CSV');
  return {
    header,
    rows: body.map((values, rowIndex) => {
      if (values.length !== header.length) {
        throw new Error(`CSV row ${rowIndex + 2} has ${values.length} fields; expected ${header.length}`);
      }
      return Object.fromEntries(header.map((name, index) => [name, values[index]]));
    }),
  };
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeCsv(header, rows) {
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) lines.push(header.map((name) => csvCell(row[name])).join(','));
  writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

function mimeFor(path) {
  return {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
  }[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

async function retry(fn, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
  throw lastError ?? new Error('operation timed out');
}

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
  }

  async open() {
    await new Promise((resolvePromise, reject) => {
      this.socket.addEventListener('open', resolvePromise, { once: true });
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

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
}

const parsed = parseCsv(readFileSync(manifestPath, 'utf8').replace(/^﻿/, ''));
for (const required of [
  'image_id',
  'path',
  'label',
  'generator',
  'split',
  'phash',
  'degradation',
  'cluster_id',
  'image_sha256',
  'dataset_manifest_sha256',
]) {
  if (!parsed.header.includes(required)) throw new Error(`manifest is missing '${required}'`);
}
if (parsed.rows.length === 0) throw new Error('manifest has no rows');

const version = await retry(async () => {
  const response = await fetch(`${endpoint}/json/version`);
  if (!response.ok) throw new Error(`CDP HTTP ${response.status}`);
  return response.json();
});
// Wake the extension service worker before looking for it: MV3 terminates
// the SW after ~30s idle, and it only restarts on an extension event. The
// offscreen document is always alive, so message it and have it ping the SW.
async function wakeServiceWorker() {
  const targets = await fetch(endpoint + '/json').then((r) => r.json());
  const offscreen = targets.find(
    (t) => t.type === 'background_page' && t.url.includes('/offscreen/offscreen.html'),
  );
  if (!offscreen) return false;
  const wakeCdp = new Cdp(offscreen.webSocketDebuggerUrl);
  await wakeCdp.open();
  await wakeCdp.send('Runtime.enable');
  await wakeCdp.send('Runtime.evaluate', {
    expression: 'chrome.runtime.sendMessage({type: "status:get", target: "sw"}).then(() => "woke").catch(() => "err")',
    awaitPromise: true,
    returnByValue: true,
  });
  wakeCdp.socket.close();
  return true;
}
await wakeServiceWorker();

const targets = await retry(async () => {
  const response = await fetch(`${endpoint}/json`);
  if (!response.ok) throw new Error(`target list HTTP ${response.status}`);
  const values = await response.json();
  if (!values.some((target) => target.type === 'service_worker')) {
    throw new Error('extension service worker target not found');
  }
  return values;
}, 30_000);
const serviceWorker = targets.find(
  (target) => target.type === 'service_worker' && target.url.endsWith('/background/service-worker.js'),
);
if (!serviceWorker) throw new Error('AI detector service worker target not found');

const cdp = new Cdp(serviceWorker.webSocketDebuggerUrl);
await cdp.open();
await cdp.send('Runtime.enable');
await retry(async () => {
  const evaluated = await cdp.send('Runtime.evaluate', {
    expression: `chrome.runtime.sendMessage({type: 'model:status-get', target: 'offscreen'})`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (evaluated.exceptionDetails) throw new Error('model status request failed');
  if (evaluated.result?.value?.state !== 'ready') {
    throw new Error(`model is still ${evaluated.result?.value?.state ?? 'unavailable'}`);
  }
  return evaluated;
}, 60_000);

const outputRows = [];
try {
  for (let index = 0; index < parsed.rows.length; index += 1) {
    const row = parsed.rows[index];
    const imagePath = isAbsolute(row.path) ? row.path : resolve(dirname(manifestPath), row.path);
    const bytes = readFileSync(imagePath);
    const dataUrl = `data:${mimeFor(imagePath)};base64,${bytes.toString('base64')}`;
    const evaluated = await cdp.send('Runtime.evaluate', {
      expression: `chrome.runtime.sendMessage({
        type: 'infer:run',
        target: 'offscreen',
        id: ${JSON.stringify(`browser-score-${index}`)},
        url: ${JSON.stringify(dataUrl)},
        allowMock: false,
      })`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (evaluated.exceptionDetails) throw new Error(`browser evaluation failed for ${row.image_id}`);
    const result = evaluated.result?.value;
    if (!result?.ok || result.engine !== 'ort' || !Number.isFinite(result.raw)) {
      throw new Error(`ORT failed for ${row.image_id}: ${JSON.stringify(result)}`);
    }
    if (result.sha256 !== row.image_sha256) {
      throw new Error(`input image hash mismatch for ${row.image_id}`);
    }
    if (!/^[0-9a-f]{64}$/.test(result.modelSha256 ?? '')) {
      throw new Error(`runtime did not identify the model artifact for ${row.image_id}`);
    }
    outputRows.push({
      ...row,
      score_official_browser: result.raw.toFixed(10),
      score: result.raw.toFixed(10),
      model_sha256: result.modelSha256,
      browser: version.Browser,
      image_sha256: result.sha256,
      inference_ms: Number(result.ms).toFixed(1),
    });
    if ((index + 1) % 10 === 0 || index + 1 === parsed.rows.length) {
      console.error(`[${index + 1}/${parsed.rows.length}] ${row.image_id} = ${result.raw.toFixed(6)}`);
    }
  }
} finally {
  cdp.socket.close();
}

const generated = ['score_official_browser', 'score', 'model_sha256', 'browser', 'image_sha256', 'inference_ms'];
const header = [...parsed.header.filter((name) => !generated.includes(name)), ...generated];
writeCsv(header, outputRows);
console.log(JSON.stringify({ browser: version.Browser, images: outputRows.length, out: outputPath }));
