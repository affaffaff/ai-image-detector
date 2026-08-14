// @ts-nocheck -- OPFS and extension APIs are intentionally represented by small fakes.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  downloadAndInstall,
  getPartialDownloadProgress,
  sha256Hex,
} from '../../src/offscreen/download.js';

class MemoryDirectory {
  constructor() {
    this.files = new Map();
  }

  async getFileHandle(name, options = {}) {
    if (!this.files.has(name)) {
      if (!options.create) throw new DOMException('Not found', 'NotFoundError');
      this.files.set(name, new Uint8Array());
    }
    return new MemoryFileHandle(this, name);
  }

  async removeEntry(name) {
    if (!this.files.delete(name)) throw new DOMException('Not found', 'NotFoundError');
  }

  seed(name, bytes) {
    this.files.set(name, Uint8Array.from(bytes));
  }

  read(name) {
    const bytes = this.files.get(name);
    return bytes ? Uint8Array.from(bytes) : null;
  }
}

class MemoryFileHandle {
  constructor(directory, name) {
    this.directory = directory;
    this.name = name;
  }

  async getFile() {
    const bytes = this.directory.read(this.name);
    if (!bytes) throw new DOMException('Not found', 'NotFoundError');
    return {
      size: bytes.byteLength,
      arrayBuffer: async () => bytes.slice().buffer,
    };
  }

  async createWritable(options = {}) {
    let bytes = options.keepExistingData
      ? (this.directory.read(this.name) ?? new Uint8Array())
      : new Uint8Array();
    let position = 0;
    return {
      seek: async (nextPosition) => {
        position = nextPosition;
      },
      write: async (value) => {
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        const required = position + chunk.byteLength;
        if (required > bytes.byteLength) {
          const grown = new Uint8Array(required);
          grown.set(bytes);
          bytes = grown;
        }
        bytes.set(chunk, position);
        position = required;
      },
      close: async () => {
        this.directory.seed(this.name, bytes);
      },
    };
  }

  async move(nextName) {
    const bytes = this.directory.read(this.name);
    if (!bytes) throw new DOMException('Not found', 'NotFoundError');
    this.directory.seed(nextName, bytes);
    this.directory.files.delete(this.name);
    this.name = nextName;
  }
}

function installOpfs(t) {
  const directory = new MemoryDirectory();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      storage: {
        getDirectory: async () => ({
          getDirectoryHandle: async () => directory,
        }),
      },
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete globalThis.navigator;
  });
  return directory;
}

function replaceFetch(t, implementation) {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  t.after(() => {
    globalThis.fetch = original;
  });
}

function bytesResponse(bytes, init = {}) {
  return new Response(Uint8Array.from(bytes), init);
}

function interruptedResponse(firstChunk) {
  let pullCount = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (pullCount++ === 0) controller.enqueue(Uint8Array.from(firstChunk));
        else controller.error(new Error('connection reset'));
      },
    }),
    { status: 200 },
  );
}

async function entry(id, bytes) {
  return {
    id,
    url: `https://models.example/${id}.onnx`,
    bytes: bytes.byteLength,
    sha256: await sha256Hex(bytes.slice().buffer),
  };
}

test('an interrupted download resumes from its durable partial', async (t) => {
  const directory = installOpfs(t);
  const artifact = Uint8Array.of(1, 2, 3, 4, 5, 6);
  const model = await entry('resume', artifact);
  const requests = [];
  replaceFetch(t, async (_url, options) => {
    requests.push(options);
    if (requests.length === 1) return interruptedResponse(artifact.slice(0, 3));
    return bytesResponse(artifact.slice(3), {
      status: 206,
      headers: {
        'Content-Length': '3',
        'Content-Range': 'bytes 3-5/6',
      },
    });
  });

  await assert.rejects(downloadAndInstall(model), /connection reset/);
  assert.deepEqual(directory.read('resume.part'), artifact.slice(0, 3));
  assert.equal(await getPartialDownloadProgress(model), 0.5);

  const installed = await downloadAndInstall(model);
  assert.equal(installed.size, artifact.byteLength);
  assert.equal(requests[1].headers.Range, 'bytes=3-');
  assert.deepEqual(directory.read('resume'), artifact);
  assert.equal(directory.read('resume.part'), null);
});

test('a server that ignores Range restarts cleanly without duplicating bytes', async (t) => {
  const directory = installOpfs(t);
  const artifact = Uint8Array.of(10, 20, 30, 40, 50, 60);
  const model = await entry('ignored-range', artifact);
  directory.seed('ignored-range.part', artifact.slice(0, 2));
  const progress = [];
  replaceFetch(t, async (_url, options) => {
    assert.equal(options.headers.Range, 'bytes=2-');
    return bytesResponse(artifact, { status: 200, headers: { 'Content-Length': '6' } });
  });

  await downloadAndInstall(model, (value) => progress.push(value));
  assert.deepEqual(directory.read('ignored-range'), artifact);
  assert.ok(progress.every((value, index) => index === 0 || value >= progress[index - 1]));
});

test('HTTP 416 discards a stale partial and retries once from byte zero', async (t) => {
  const directory = installOpfs(t);
  const artifact = Uint8Array.of(7, 8, 9, 10, 11, 12);
  const model = await entry('range-416', artifact);
  directory.seed('range-416.part', artifact.slice(0, 2));
  const ranges = [];
  replaceFetch(t, async (_url, options) => {
    ranges.push(options.headers.Range);
    if (ranges.length === 1) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': 'bytes */6' },
      });
    }
    return bytesResponse(artifact, { status: 200, headers: { 'Content-Length': '6' } });
  });

  await downloadAndInstall(model);
  assert.deepEqual(ranges, ['bytes=2-', undefined]);
  assert.deepEqual(directory.read('range-416'), artifact);
});

test('a wrong hash deletes the untrusted partial and never installs it', async (t) => {
  const directory = installOpfs(t);
  const artifact = Uint8Array.of(1, 1, 2, 3, 5, 8);
  const model = await entry('wrong-hash', artifact);
  replaceFetch(t, async () => bytesResponse(Uint8Array.of(8, 5, 3, 2, 1, 1)));

  await assert.rejects(downloadAndInstall(model), /hash mismatch/);
  assert.equal(directory.read('wrong-hash.part'), null);
  assert.equal(directory.read('wrong-hash'), null);
});

test('an offline restart reports retained progress and leaves the partial resumable', async (t) => {
  const directory = installOpfs(t);
  const artifact = Uint8Array.of(2, 4, 6, 8, 10, 12);
  const model = await entry('offline-restart', artifact);
  directory.seed('offline-restart.part', artifact.slice(0, 3));
  let range = null;
  replaceFetch(t, async (_url, options) => {
    range = options.headers.Range;
    throw new TypeError('Failed to fetch');
  });

  const progress = [];
  await assert.rejects(downloadAndInstall(model, (value) => progress.push(value)), /Failed to fetch/);
  assert.equal(range, 'bytes=3-');
  assert.deepEqual(progress, [0.5]);
  assert.deepEqual(directory.read('offline-restart.part'), artifact.slice(0, 3));
});

test('offscreen download messages are single-flight and status polling preserves progress', async (t) => {
  const directory = installOpfs(t);
  const artifact = Uint8Array.of(3, 1, 4, 1, 5, 9);
  const model = await entry('single-flight', artifact);
  const originalChrome = globalThis.chrome;
  const originalDevBuild = globalThis.__DEV_BUILD__;
  let listener = null;
  let modelFetches = 0;
  let releaseBody;
  const bodyGate = new Promise((resolve) => {
    releaseBody = resolve;
  });

  globalThis.__DEV_BUILD__ = false;
  globalThis.chrome = {
    runtime: {
      getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: { addListener: (nextListener) => (listener = nextListener) },
      sendMessage: async () => undefined,
    },
  };
  t.after(() => {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
    if (originalDevBuild === undefined) delete globalThis.__DEV_BUILD__;
    else globalThis.__DEV_BUILD__ = originalDevBuild;
  });

  replaceFetch(t, async (input) => {
    if (String(input).endsWith('/models/manifest.json')) {
      return new Response(JSON.stringify({ models: [model] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    modelFetches += 1;
    return new Response(
      new ReadableStream({
        async start(controller) {
          controller.enqueue(artifact.slice(0, 3));
          await bodyGate;
          controller.enqueue(artifact.slice(3));
          controller.close();
        },
      }),
      { headers: { 'Content-Length': String(artifact.byteLength) } },
    );
  });

  await import(`../../src/offscreen/offscreen.js?single-flight=${Date.now()}`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof listener, 'function');

  const send = (message) =>
    new Promise((resolve) => {
      assert.equal(listener(message, {}, resolve), true);
    });
  const first = send({ type: 'model:download', target: 'offscreen' });
  const second = send({ type: 'model:download', target: 'offscreen' });
  await new Promise((resolve) => setImmediate(resolve));
  const during = await send({ type: 'model:status-get', target: 'offscreen' });

  assert.equal(modelFetches, 1);
  assert.equal(during.state, 'downloading');
  assert.equal(during.progress, 0.5);
  releaseBody();
  const ready = { state: 'ready', modelId: model.id, modelSha256: model.sha256 };
  assert.deepEqual(await Promise.all([first, second]), [ready, ready]);
  assert.deepEqual(directory.read('single-flight'), artifact);
});
