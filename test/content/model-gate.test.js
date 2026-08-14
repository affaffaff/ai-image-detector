import test from 'node:test';
import assert from 'node:assert/strict';

import { ModelGate } from '../../src/content/model-gate.js';

test('the first no-model latches, later ones do not re-enter', () => {
  const gate = new ModelGate();
  assert.equal(gate.unavailable, false);
  assert.equal(gate.enter(), true);
  assert.equal(gate.unavailable, true);
  assert.equal(gate.enter(), false);
  assert.equal(gate.unavailable, true);
});

test('a scored result clears a missed MODEL_READY latch', () => {
  const gate = new ModelGate();
  gate.enter();
  assert.equal(gate.markUsable(), true);
  assert.equal(gate.unavailable, false);
  assert.equal(gate.provenUsable, true);
  assert.equal(gate.markUsable(), false);
});

test('scored is a no-op when the model was never reported missing', () => {
  const gate = new ModelGate();
  assert.equal(gate.markUsable(), false);
  assert.equal(gate.unavailable, false);
  assert.equal(gate.provenUsable, true);
});

test('a late no-model cannot re-latch after a scored verdict', () => {
  const gate = new ModelGate();
  gate.markUsable();
  assert.equal(gate.enter(), false);
  assert.equal(gate.unavailable, false);
});

test('a late no-model cannot re-latch after the latch was cleared', () => {
  const gate = new ModelGate();
  assert.equal(gate.enter(), true);
  assert.equal(gate.markUsable(), true);
  assert.equal(gate.enter(), false);
  assert.equal(gate.unavailable, false);
});

test('reset forgets both the latch and the usable proof', () => {
  const gate = new ModelGate();
  gate.markUsable();
  gate.reset();
  assert.equal(gate.unavailable, false);
  assert.equal(gate.provenUsable, false);
  assert.equal(gate.enter(), true);
});

test('allowProbe lifts the latch without proving the model works', () => {
  const gate = new ModelGate();
  assert.equal(gate.allowProbe(), false);
  gate.enter();
  assert.equal(gate.allowProbe(), true);
  assert.equal(gate.unavailable, false);
  assert.equal(gate.provenUsable, false);
  assert.equal(gate.enter(), true, 'a failed probe can re-latch');
});

test('allowProbe is a no-op after the model is proven usable', () => {
  const gate = new ModelGate();
  gate.markUsable();
  assert.equal(gate.allowProbe(), false);
  assert.equal(gate.unavailable, false);
});
