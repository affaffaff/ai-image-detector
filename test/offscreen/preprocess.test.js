import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  DEFAULT_TILE_AGGREGATION,
  MODEL_INPUT_SIZE,
  aggregateTileProbabilities,
  axisOrigins,
  planOfficialCenterCrop,
  planNativeTiles,
  rgbaToImageNetNchw,
  sigmoid,
} from '../../src/offscreen/preprocess.js';

test('official preprocessing resizes the short edge then takes a centered 384 crop', () => {
  assert.deepEqual(planOfficialCenterCrop(768, 768), {
    resizedWidth: 440,
    resizedHeight: 440,
    left: 28,
    top: 28,
    cropSize: 384,
  });
  assert.deepEqual(planOfficialCenterCrop(1000, 500), {
    resizedWidth: 880,
    resizedHeight: 440,
    left: 248,
    top: 28,
    cropSize: 384,
  });
  assert.deepEqual(planOfficialCenterCrop(500, 1001), {
    resizedWidth: 440,
    resizedHeight: 880,
    left: 28,
    top: 248,
    cropSize: 384,
  });
  assert.throws(() => planOfficialCenterCrop(0, 100), /width/);
  assert.throws(() => planOfficialCenterCrop(100, 100, { shortEdge: 300 }), /cropSize/);
});

test('native tile origins cover both edges without resizing', () => {
  assert.deepEqual(axisOrigins(384), [0]);
  assert.deepEqual(axisOrigins(385), [0, 1]);
  assert.deepEqual(axisOrigins(1000), [0, 308, 616]);
  assert.deepEqual(axisOrigins(100), [-142]);
});

test('tile plan is deterministic and capped at nine crops', () => {
  const tiles = planNativeTiles(2000, 1200);
  assert.equal(tiles.length, 9);
  assert.deepEqual(tiles[0], { x: 0, y: 0, size: 384 });
  assert.deepEqual(tiles.at(-1), { x: 1616, y: 816, size: 384 });
});

test('RGBA conversion uses RGB NCHW order and ImageNet normalization', () => {
  const tensor = rgbaToImageNetNchw(new Uint8ClampedArray([255, 0, 128, 7]), 1, 1);
  assert.equal(tensor.length, 3);
  assert.ok(Math.abs((tensor[0] ?? NaN) - (1 - 0.485) / 0.229) < 1e-6);
  assert.ok(Math.abs((tensor[1] ?? NaN) - (0 - 0.456) / 0.224) < 1e-6);
  assert.ok(Math.abs((tensor[2] ?? NaN) - (128 / 255 - 0.406) / 0.225) < 1e-6);
});

test('sigmoid is stable and tile aggregation prefers local evidence', () => {
  assert.equal(sigmoid(0), 0.5);
  assert.ok(sigmoid(1000) > 0.999999);
  assert.ok(sigmoid(-1000) < 0.000001);
  const tiles = [0.1, 0.5, 0.9];
  assert.equal(aggregateTileProbabilities(tiles, 'mean-probability'), 0.5);
  assert.equal(aggregateTileProbabilities(tiles, 'max-probability'), 0.9);
  assert.equal(aggregateTileProbabilities(tiles, 'top2-mean-probability'), 0.7);
  assert.equal(aggregateTileProbabilities(tiles, 'top3-mean-probability'), 0.5);
  assert.equal(aggregateTileProbabilities(tiles), 0.9, 'default rule is max');
  assert.equal(aggregateTileProbabilities([0.4]), 0.4);
  assert.throws(() => aggregateTileProbabilities([]), /zero tiles/);
  assert.throws(() => aggregateTileProbabilities(tiles, 'median'), /unsupported/);
});

test('shipped primary model uses the official-center preprocessing', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const manifest = JSON.parse(readFileSync(join(root, 'models/manifest.json'), 'utf8'));
  const primary = manifest.models?.[0];
  assert.ok(primary, 'manifest must list a primary model');
  assert.equal(primary.tiling?.mode, 'official-center');
  assert.equal(primary.tiling?.nativeResolution, false);
  assert.equal(primary.tiling?.aggregation, 'single-crop');
  assert.equal(primary.tiling?.resizeShortEdge, 440);
  assert.equal(primary.tiling?.cropSize, MODEL_INPUT_SIZE);
  assert.equal(primary.calibration?.inputScoreColumn, 'score_official_browser');
  assert.equal(primary.preprocessing, undefined);
});
