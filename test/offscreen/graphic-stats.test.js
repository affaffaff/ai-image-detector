import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GRAPHIC_PATCH_GRID,
  GRAPHIC_PATCH_SIZE,
  planGraphicAxis,
  planGraphicPatches,
} from '../../src/offscreen/graphic-stats.js';

test('small images use one full-image patch', () => {
  assert.deepEqual(planGraphicPatches(64, 40), [{ x: 0, y: 0, width: 64, height: 40 }]);
});

test('an axis shorter than the patch spans the whole axis', () => {
  assert.deepEqual(planGraphicAxis(80), [{ origin: 0, size: 80 }]);
  assert.deepEqual(planGraphicAxis(GRAPHIC_PATCH_SIZE), [{ origin: 0, size: GRAPHIC_PATCH_SIZE }]);
});

test('large images get an edge-covering 3x3 grid at native resolution', () => {
  const patches = planGraphicPatches(1000, 700);
  assert.equal(patches.length, GRAPHIC_PATCH_GRID * GRAPHIC_PATCH_GRID);
  const xs = [...new Set(patches.map((p) => p.x))];
  const ys = [...new Set(patches.map((p) => p.y))];
  assert.deepEqual(xs, [0, 452, 904]); // both edges included
  assert.deepEqual(ys, [0, 302, 604]);
  for (const patch of patches) {
    assert.equal(patch.width, GRAPHIC_PATCH_SIZE);
    assert.equal(patch.height, GRAPHIC_PATCH_SIZE);
    assert.ok(patch.x + patch.width <= 1000);
    assert.ok(patch.y + patch.height <= 700);
  }
});

test('axes barely longer than a patch stay inside the image', () => {
  const spans = planGraphicAxis(100);
  assert.equal(spans.length, 2);
  for (const span of spans) {
    assert.ok(span.origin >= 0);
    assert.ok(span.origin + span.size <= 100);
  }
});

test('rejects non-positive axes', () => {
  assert.throws(() => planGraphicAxis(0), RangeError);
  assert.throws(() => planGraphicPatches(10, -1), RangeError);
});
