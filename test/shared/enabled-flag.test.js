import test from 'node:test';
import assert from 'node:assert/strict';

/** @type {typeof globalThis & { __DEV_BUILD__?: boolean }} */
const g = globalThis;
g.__DEV_BUILD__ = false;
const {
  BLUR_AI_DEFAULT,
  blurFromStorage,
  enabledFromStorage,
  flagFromStorage,
  readStoredFlag,
} = await import('../../src/shared/constants.js');

test('missing storage key is first-run on', () => {
  assert.equal(enabledFromStorage(undefined), true);
});

test('a stored off stays off', () => {
  assert.equal(enabledFromStorage(false), false);
  assert.equal(enabledFromStorage(true), true);
});

test('blur defaults off and a stored off stays off', () => {
  assert.equal(BLUR_AI_DEFAULT, false);
  assert.equal(blurFromStorage(undefined), false);
  assert.equal(blurFromStorage(false), false);
  assert.equal(blurFromStorage(true), true);
});

test('flagFromStorage keeps a stored false', () => {
  assert.equal(flagFromStorage(undefined, true), true);
  assert.equal(flagFromStorage(false, true), false);
});

test('a live toggle wins over a stale storage.get', () => {
  assert.equal(readStoredFlag(true, true, false), null);
  assert.equal(readStoredFlag(true, false, true), null);
  assert.equal(readStoredFlag(false, false, true), false);
  assert.equal(readStoredFlag(false, undefined, true), true);
  assert.equal(readStoredFlag(false, undefined, false), false);
});
