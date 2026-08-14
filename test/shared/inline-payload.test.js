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

test('the base64 marker is ASCII case-insensitive per the URL Standard', () => {
  assert.equal(inlineDecodedBytes('data:image/png;BASE64,AAAA'), 3);
  assert.equal(inlineDecodedBytes('data:image/png;Base64,AAAA'), 3);
  assert.equal(inlineDecodedBytes('data:image/png;charset=utf-8;BASE64,AAAA'), 3);
  // "base64" NOT preceded by ';' is a mediatype substring, not the marker.
  assert.equal(inlineDecodedBytes('data:base64x/png,abcd'), 4);
});

test('isInlinePayloadTooLarge honours a caller-supplied cap', () => {
  assert.equal(isInlinePayloadTooLarge('data:image/png;base64,AAAA', 3), false);
  assert.equal(isInlinePayloadTooLarge('data:image/png;base64,AAAA', 2), true);
  assert.equal(isInlinePayloadTooLarge('https://cdn.test/photo.jpg', 1), false);
});
