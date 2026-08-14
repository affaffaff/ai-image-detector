import test from 'node:test';
import assert from 'node:assert/strict';

import { silenceWindowsWebGpuPowerPreference } from '../../src/offscreen/webgpu-windows.js';

test('Windows requestAdapter drops powerPreference and keeps the rest', async () => {
  /** @type {unknown} */
  let seen;
  const gpu = {
    requestAdapter: async function requestAdapter(/** @type {unknown} */ options) {
      seen = options;
      return { ok: true };
    },
  };
  assert.equal(
    silenceWindowsWebGpuPowerPreference(gpu, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'),
    true,
  );
  const result = await gpu.requestAdapter({
    powerPreference: 'high-performance',
    forceFallbackAdapter: false,
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(seen, { forceFallbackAdapter: false });
  assert.equal(Object.prototype.hasOwnProperty.call(/** @type {object} */ (seen), 'powerPreference'), false);
});

test('Windows requestAdapter strips even an undefined powerPreference (ORT default)', async () => {
  /** @type {unknown} */
  let seen;
  const gpu = {
    requestAdapter: async function requestAdapter(/** @type {unknown} */ options) {
      seen = options;
      return null;
    },
  };
  assert.equal(
    silenceWindowsWebGpuPowerPreference(gpu, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0'),
    true,
  );
  await gpu.requestAdapter({ powerPreference: undefined, forceFallbackAdapter: undefined });
  assert.equal(Object.prototype.hasOwnProperty.call(/** @type {object} */ (seen), 'powerPreference'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(/** @type {object} */ (seen), 'forceFallbackAdapter'), true);
});

test('non-Windows adapters are left alone', async () => {
  let calls = 0;
  const gpu = {
    requestAdapter: async function requestAdapter(/** @type {unknown} */ options) {
      calls += 1;
      return options;
    },
  };
  assert.equal(
    silenceWindowsWebGpuPowerPreference(gpu, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'),
    false,
  );
  const options = { powerPreference: 'low-power' };
  assert.equal(await gpu.requestAdapter(options), options);
  assert.equal(calls, 1);
});
