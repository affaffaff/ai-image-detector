import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { MonotoneCalibrator } from '../../src/fusion/calibration.js';
import { DECISION_THRESHOLD } from '../../src/fusion/fuse.js';
import {
  NATIVE_VETO_MAX_TAU,
  NATIVE_VETO_MIN_SHORT_EDGE,
  NATIVE_VETO_OFFICIAL_FLOOR,
  applyNativeTileVeto,
  shouldProbeNativeTiles,
} from '../../src/shared/native-veto.js';

/** Identity fused curve: reported P equals the raw score. */
/** @param {number} raw */
const identity = (raw) => raw;

test('native tiles are probed only when the official transform downscales an AI-looking crop', () => {
  assert.equal(
    shouldProbeNativeTiles({ shortEdge: NATIVE_VETO_MIN_SHORT_EDGE, officialScore: 0.9 }),
    false,
    'exactly the resize target is not a downscale',
  );
  assert.equal(shouldProbeNativeTiles({ shortEdge: 439, officialScore: 0.9 }), false);
  assert.equal(
    shouldProbeNativeTiles({ shortEdge: 441, officialScore: NATIVE_VETO_OFFICIAL_FLOOR - 1e-6 }),
    false,
    'official crop already cannot fuse to AI',
  );
  assert.equal(shouldProbeNativeTiles({ shortEdge: 441, officialScore: NATIVE_VETO_OFFICIAL_FLOOR }), true);
  assert.equal(shouldProbeNativeTiles({ shortEdge: 600, officialScore: 0.355 }), true);
  assert.equal(
    shouldProbeNativeTiles({ shortEdge: 600, officialScore: 0.9, graphicGated: true }),
    false,
    'graphic cap already owns the badge; native tiles cannot change it',
  );
});

test('veto fires only when fused P(AI) is an AI verdict and no native tile agrees', () => {
  const students = applyNativeTileVeto({
    probability: 0.75,
    nativeMax: 0.063,
    nativeMedian: 0.013,
    fuseNative: identity,
  });
  assert.equal(students.vetoed, true);
  assert.ok(students.probability < DECISION_THRESHOLD);
  assert.equal(students.probability, 0.013);

  const agrees = applyNativeTileVeto({
    probability: 0.75,
    nativeMax: NATIVE_VETO_MAX_TAU,
    nativeMedian: 0.4,
    fuseNative: identity,
  });
  assert.equal(agrees.vetoed, false);
  assert.equal(agrees.probability, 0.75);

  const alreadyReal = applyNativeTileVeto({
    probability: 0.45,
    nativeMax: 0.01,
    nativeMedian: 0.01,
    fuseNative: identity,
  });
  assert.equal(alreadyReal.vetoed, false);
  assert.equal(alreadyReal.probability, 0.45);
});

test('a native max just above the fused 0.65-knot cannot keep the AI badge', () => {
  const result = applyNativeTileVeto({
    probability: 0.75,
    nativeMax: 0.063,
    nativeMedian: 0.063,
    fuseNative: identity,
  });
  assert.equal(result.vetoed, true);
  assert.ok(result.probability < DECISION_THRESHOLD);
  assert.ok(result.probability > 0.06);
});

test('missing native evidence is not a veto', () => {
  const result = applyNativeTileVeto({ probability: 0.9, fuseNative: identity });
  assert.equal(result.vetoed, false);
  assert.equal(result.probability, 0.9);
});

test('Mount Fuji official miss is not a veto candidate (official crop already REAL)', () => {
  assert.equal(shouldProbeNativeTiles({ shortEdge: 600, officialScore: 0.019 }), false);
  const result = applyNativeTileVeto({
    probability: 0.45,
    nativeMax: 0.413,
    nativeMedian: 0.016,
    fuseNative: identity,
  });
  assert.equal(result.vetoed, false, 'rescue is rejected; official-REAL stays REAL');
});

test('Britannica students-activity: official AI crop is vetoed by native tiles on the shipped curve', () => {
  const fused = MonotoneCalibrator.fromJSON(
    JSON.parse(readFileSync(new URL('../../models/calibration/fused.json', import.meta.url), 'utf8')),
  );
  const officialRaw = 0.3549621058;
  const officialP = fused.apply(officialRaw);
  assert.ok(officialP >= DECISION_THRESHOLD, 'the bug: official crop badges AI');

  assert.equal(shouldProbeNativeTiles({ shortEdge: 600, officialScore: officialRaw }), true);
  const vetoed = applyNativeTileVeto({
    probability: officialP,
    nativeMax: 0.0625511602,
    nativeMedian: 0.0130681852,
    fuseNative: (raw) => fused.apply(raw),
  });
  assert.equal(vetoed.vetoed, true);
  assert.ok(vetoed.probability < DECISION_THRESHOLD);
});
