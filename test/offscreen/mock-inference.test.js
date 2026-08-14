// @ts-nocheck -- this test deliberately supplies a minimal browser API surface.
import test from 'node:test';
import assert from 'node:assert/strict';

test('mock inference works when the offscreen context exposes runtime but not storage', async (t) => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const originalDevBuild = globalThis.__DEV_BUILD__;

  let onMessage = null;
  globalThis.__DEV_BUILD__ = true;
  globalThis.chrome = {
    runtime: {
      getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: {
        addListener: (listener) => {
          onMessage = listener;
        },
      },
      sendMessage: async () => undefined,
    },
  };

  const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/models/manifest.json')) {
      return new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(imageBytes, {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    });
  };
  globalThis.createImageBitmap = async () => ({ close() {} });

  t.after(() => {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
    globalThis.createImageBitmap = originalCreateImageBitmap;
    if (originalDevBuild === undefined) delete globalThis.__DEV_BUILD__;
    else globalThis.__DEV_BUILD__ = originalDevBuild;
  });

  await import(`../../src/offscreen/offscreen.js?test=${Date.now()}`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof onMessage, 'function');
  assert.equal(globalThis.chrome.storage, undefined);

  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('offscreen response timed out')), 2000);
    const keepChannelOpen = onMessage(
      {
        type: 'infer:run',
        target: 'offscreen',
        id: 'test-image',
        url: 'https://example.test/image.png',
        allowMock: true,
      },
      {},
      (response) => {
        clearTimeout(timeout);
        resolve(response);
      },
    );
    assert.equal(keepChannelOpen, true);
  });

  assert.equal(result.ok, true);
  assert.equal(result.engine, 'mock');
  assert.equal(result.id, 'test-image');
  assert.equal(typeof result.raw, 'number');
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
});
