import test from 'node:test';
import assert from 'node:assert/strict';

import { AI_BLUR_PX, blurCoverScale } from '../../src/content/blur-cover.js';

test('cover scale grows the clone past a 22px transparent fringe', () => {
  const scale = blurCoverScale(240, 240);
  const extraPerSide = ((scale - 1) * 240) / 2;
  assert.ok(
    extraPerSide >= AI_BLUR_PX + 4,
    `expected ≥26px inset, got ${extraPerSide.toFixed(2)}`,
  );
});

test('narrow thumbs scale harder so corners still clip', () => {
  const thumb = blurCoverScale(64, 240);
  const wide = blurCoverScale(240, 240);
  assert.ok(thumb > wide);
  const extraPerSide = ((thumb - 1) * 64) / 2;
  assert.ok(extraPerSide >= AI_BLUR_PX + 4);
});

test('degenerate boxes stay at a usable default instead of Infinity', () => {
  assert.equal(blurCoverScale(0, 100), 1.2);
  assert.equal(blurCoverScale(-10, 40), 1.2);
  assert.equal(blurCoverScale(Number.NaN, 40), 1.2);
});

test('tiny images cap so the clone does not explode', () => {
  assert.equal(blurCoverScale(8, 8), 2.4);
});
