import test from 'node:test';
import assert from 'node:assert/strict';

import { gpuAvailable } from '../../src/offscreen/ort-engine.js';

test('Node has no WebGPU adapter, so the engine falls back to WASM', () => {
  assert.equal(gpuAvailable(), false);
});
