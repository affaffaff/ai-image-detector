// @ts-nocheck -- the service worker is loaded against a deliberately tiny Chrome fake.
import test from 'node:test';
import assert from 'node:assert/strict';

test('browser startup retries an interrupted model while offline without wedging popup retry', async (t) => {
  const originalChrome = globalThis.chrome;
  const originalDevBuild = globalThis.__DEV_BUILD__;
  let startupListener = null;
  let messageListener = null;
  const sent = [];

  globalThis.__DEV_BUILD__ = false;
  globalThis.chrome = {
    runtime: {
      ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
      getContexts: async () => [{ contextType: 'OFFSCREEN_DOCUMENT' }],
      getURL: (path) => `chrome-extension://test/${path}`,
      onConnect: { addListener() {} },
      onInstalled: { addListener() {} },
      onStartup: { addListener: (listener) => (startupListener = listener) },
      onMessage: { addListener: (listener) => (messageListener = listener) },
      sendMessage: async (message) => {
        sent.push(message);
        if (message.type === 'model:status-get') {
          return { state: 'missing', progress: 0.5 };
        }
        if (message.type === 'model:download') {
          return { state: 'error', progress: 0.5, detail: 'Failed to fetch' };
        }
        return undefined;
      },
    },
    offscreen: {
      Reason: { WORKERS: 'WORKERS' },
      createDocument: async () => undefined,
    },
    storage: {
      local: { get: async () => ({}), set: async () => undefined },
      session: { get: async () => ({}), set: async () => undefined },
    },
  };

  t.after(() => {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
    if (originalDevBuild === undefined) delete globalThis.__DEV_BUILD__;
    else globalThis.__DEV_BUILD__ = originalDevBuild;
  });

  await import(`../../src/background/service-worker.js?startup-recovery=${Date.now()}`);
  assert.equal(typeof startupListener, 'function');
  assert.equal(typeof messageListener, 'function');

  startupListener();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    sent.slice(0, 2).map((message) => message.type),
    ['model:status-get', 'model:download'],
  );

  const retryResult = await new Promise((resolve) => {
    assert.equal(
      messageListener({ type: 'model:retry', target: 'sw' }, {}, resolve),
      true,
    );
  });
  assert.equal(retryResult.state, 'error');
  assert.equal(retryResult.progress, 0.5);
  assert.equal(sent.filter((message) => message.type === 'model:download').length, 2);
});

test('model recovery notifies already-open tabs when weights are ready', async (t) => {
  const originalChrome = globalThis.chrome;
  const originalDevBuild = globalThis.__DEV_BUILD__;
  let startupListener = null;
  const sent = [];
  const tabMessages = [];

  globalThis.__DEV_BUILD__ = false;
  globalThis.chrome = {
    runtime: {
      ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
      getContexts: async () => [{ contextType: 'OFFSCREEN_DOCUMENT' }],
      getURL: (path) => `chrome-extension://test/${path}`,
      onConnect: { addListener() {} },
      onInstalled: { addListener() {} },
      onStartup: { addListener: (listener) => (startupListener = listener) },
      onMessage: { addListener() {} },
      sendMessage: async (message) => {
        sent.push(message);
        if (message.type === 'model:status-get') {
          return { state: 'ready', modelId: 'primary', modelSha256: 'a'.repeat(64) };
        }
        return undefined;
      },
    },
    offscreen: {
      Reason: { WORKERS: 'WORKERS' },
      createDocument: async () => undefined,
    },
    storage: {
      local: { get: async () => ({}), set: async () => undefined },
      session: { get: async () => ({}), set: async () => undefined },
    },
    tabs: {
      query: async () => [{ id: 7 }, { id: 8 }, {}],
      sendMessage: async (id, message) => {
        tabMessages.push({ id, message });
      },
    },
  };

  t.after(() => {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
    if (originalDevBuild === undefined) delete globalThis.__DEV_BUILD__;
    else globalThis.__DEV_BUILD__ = originalDevBuild;
  });

  await import(`../../src/background/service-worker.js?ready-notify=${Date.now()}`);
  assert.equal(typeof startupListener, 'function');
  startupListener();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    sent.some((message) => message.type === 'model:ready'),
    true,
  );
  assert.deepEqual(
    tabMessages.map((entry) => entry.id),
    [7, 8],
  );
  assert.equal(
    tabMessages.every((entry) => entry.message.type === 'model:ready'),
    true,
  );
});
