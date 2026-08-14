import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isInlinePayloadTooLarge,
  isSessionMemoizableUrl,
  inlineDecodedBytes,
} from '../../src/shared/inline-payload.js';

test('session memo only stores http(s) URLs, never inline image payloads', () => {
  assert.equal(isSessionMemoizableUrl('https://cdn.test/photo.jpg'), true);
  assert.equal(isSessionMemoizableUrl('http://cdn.test/photo.jpg'), true);
  assert.equal(isSessionMemoizableUrl('data:image/png;base64,AAAA'), false);
  assert.equal(isSessionMemoizableUrl('blob:https://cdn.test/uuid'), false);
});

test('inlineDecodedBytes estimates base64 and raw data: payloads', () => {
  assert.equal(inlineDecodedBytes('https://cdn.test/photo.jpg'), 0);
  assert.equal(inlineDecodedBytes('data:image/png;base64,AAAA'), 3);
  assert.equal(inlineDecodedBytes('data:image/png,abcd'), 4);
  assert.equal(inlineDecodedBytes('data:image/png;base64'), Number.POSITIVE_INFINITY);
});

test('isInlinePayloadTooLarge honours a caller-supplied cap', () => {
  assert.equal(isInlinePayloadTooLarge('data:image/png;base64,AAAA', 3), false);
  assert.equal(isInlinePayloadTooLarge('data:image/png;base64,AAAA', 2), true);
  assert.equal(isInlinePayloadTooLarge('https://cdn.test/photo.jpg', 1), false);
});
