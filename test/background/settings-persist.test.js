// @ts-nocheck -- the service worker is loaded against a deliberately tiny Chrome fake.
import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * @param {{ delayGet?: boolean }} [opts]
 */
function installChromeFake(opts = {}) {
  /** @type {Array<Record<string, unknown>>} */
  const sets = [];
  /** @type {object[]} */
  const messages = [];
  let getContextsCalls = 0;
  /** @type {((value: Record<string, unknown>) => void) | null} */
  let resolveGet = null;
  const getPromise = opts.delayGet
    ? new Promise((resolve) => {
        resolveGet = resolve;
      })
    : Promise.resolve({});

  /** @type {((msg: object, sender: object, sendResponse: (v: unknown) => void) => boolean) | null} */
  let messageListener = null;
  /** @type {((port: object) => void) | null} */
  let connectListener = null;

  globalThis.__DEV_BUILD__ = false;
  globalThis.chrome = {
    runtime: {
      ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
      getContexts: async () => {
        getContextsCalls += 1;
        return [];
      },
      getURL: (path) => `chrome-extension://test/${path}`,
      onConnect: { addListener: (listener) => (connectListener = listener) },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener: (listener) => (messageListener = listener) },
      sendMessage: async (msg) => {
        messages.push(msg);
        return undefined;
      },
    },
    offscreen: {
      Reason: { WORKERS: 'WORKERS' },
      createDocument: async () => undefined,
    },
    storage: {
      local: {
        get: async () => getPromise,
        set: async (items) => {
          sets.push({ ...items });
        },
      },
      session: { get: async () => ({}), set: async () => undefined },
      onChanged: { addListener() {} },
    },
    tabs: {
      query: async () => [],
      sendMessage: async () => undefined,
    },
  };

  return {
    sets,
    messages,
    getContexts: () => getContextsCalls,
    resolveGet: (value) => {
      if (!resolveGet) throw new Error('get was not delayed');
      resolveGet(value);
    },
    messageListener: () => messageListener,
    connectListener: () => connectListener,
  };
}

async function sendSetting(listener, type, enabled) {
  return new Promise((resolve, reject) => {
    const keep = listener({ type, target: 'sw', enabled }, {}, resolve);
    if (keep !== true) reject(new Error(`${type} must keep the worker alive until persist finishes`));
  });
}

test.describe('popup setting persistence', { concurrency: false }, () => {
  test('popup Detection and Blur settings persist in the service worker', async (t) => {
    const originalChrome = globalThis.chrome;
    const originalDevBuild = globalThis.__DEV_BUILD__;
    const fake = installChromeFake();

    t.after(() => {
      if (originalChrome === undefined) delete globalThis.chrome;
      else globalThis.chrome = originalChrome;
      if (originalDevBuild === undefined) delete globalThis.__DEV_BUILD__;
      else globalThis.__DEV_BUILD__ = originalDevBuild;
    });

    await import(`../../src/background/service-worker.js?settings-persist=${Date.now()}`);
    const listener = fake.messageListener();
    assert.equal(typeof listener, 'function');

    const enabledResult = await sendSetting(listener, 'enabled:setting', false);
    assert.equal(enabledResult.ok, true);
    assert.equal(
      fake.sets.some((item) => item.enabled === false),
      true,
    );

    const blurResult = await sendSetting(listener, 'blur:setting', true);
    assert.equal(blurResult.ok, true);
    assert.equal(
      fake.sets.some((item) => item.blurAiOptIn === true),
      true,
    );
  });

  test('a stale storage.get cannot turn Detection back on after a live off', async (t) => {
    const originalChrome = globalThis.chrome;
    const originalDevBuild = globalThis.__DEV_BUILD__;
    const fake = installChromeFake({ delayGet: true });

    t.after(() => {
      if (originalChrome === undefined) delete globalThis.chrome;
      else globalThis.chrome = originalChrome;
      if (originalDevBuild === undefined) delete globalThis.__DEV_BUILD__;
      else globalThis.__DEV_BUILD__ = originalDevBuild;
    });

    await import(`../../src/background/service-worker.js?settings-stale-get=${Date.now()}`);
    const connect = fake.connectListener();
    const listener = fake.messageListener();
    assert.equal(typeof connect, 'function');
    assert.equal(typeof listener, 'function');

    connect({
      name: 'scan',
      onDisconnect: { addListener() {} },
      onMessage: { addListener() {} },
    });

    await sendSetting(listener, 'enabled:setting', false);
    fake.resolveGet({ enabled: true });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(fake.getContexts(), 0);
  });

  test('off then on in the same burst persists on and does not cancel inference', async (t) => {
    const originalChrome = globalThis.chrome;
    const originalDevBuild = globalThis.__DEV_BUILD__;
    const fake = installChromeFake();

    t.after(() => {
      if (originalChrome === undefined) delete globalThis.chrome;
      else globalThis.chrome = originalChrome;
      if (originalDevBuild === undefined) delete globalThis.__DEV_BUILD__;
      else globalThis.__DEV_BUILD__ = originalDevBuild;
    });

    await import(`../../src/background/service-worker.js?settings-toggle-burst=${Date.now()}`);
    const listener = fake.messageListener();
    assert.equal(typeof listener, 'function');

    const off = sendSetting(listener, 'enabled:setting', false);
    const on = sendSetting(listener, 'enabled:setting', true);
    const [offResult, onResult] = await Promise.all([off, on]);
    assert.equal(offResult.ok, true);
    assert.equal(onResult.ok, true);

    const enabledSets = fake.sets.filter((item) => Object.prototype.hasOwnProperty.call(item, 'enabled'));
    assert.deepEqual(
      enabledSets.map((item) => item.enabled),
      [true],
    );
    assert.equal(
      fake.messages.some((msg) => msg?.type === 'infer:cancel'),
      false,
    );
  });

  test('a SCAN_REQUEST while Detection is off still gets a terminal update', async (t) => {
    const originalChrome = globalThis.chrome;
    const originalDevBuild = globalThis.__DEV_BUILD__;
    const fake = installChromeFake();

    t.after(() => {
      if (originalChrome === undefined) delete globalThis.chrome;
      else globalThis.chrome = originalChrome;
      if (originalDevBuild === undefined) delete globalThis.__DEV_BUILD__;
      else globalThis.__DEV_BUILD__ = originalDevBuild;
    });

    await import(`../../src/background/service-worker.js?settings-disabled-reply=${Date.now()}`);
    const connect = fake.connectListener();
    const listener = fake.messageListener();
    assert.equal(typeof connect, 'function');
    assert.equal(typeof listener, 'function');

    await sendSetting(listener, 'enabled:setting', false);

    /** @type {object[]} */
    const posted = [];
    /** @type {(msg: object) => void | Promise<void>} */
    let onMsg = () => {};
    connect({
      name: 'scan',
      onDisconnect: { addListener() {} },
      onMessage: {
        addListener: (handler) => {
          onMsg = handler;
        },
      },
      postMessage: (msg) => {
        posted.push(msg);
      },
    });

    await onMsg({
      type: 'scan:request',
      id: 'img:1',
      url: 'https://example.test/a.jpg',
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(posted.length, 1);
    assert.equal(posted[0]?.type, 'scan:update');
    assert.equal(posted[0]?.state, 'unscannable');
    assert.equal(posted[0]?.error, 'disabled');
  });
});
