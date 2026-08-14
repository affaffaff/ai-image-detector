import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertShippingContract } from '../../tools/assert_shipping.mjs';

test('shipping contract keeps an unconfigured model explicitly quarantined', () => {
  const result = assertShippingContract();
  assert.equal(result.configuredForShipping, false);
  assert.equal(result.curveStatus, 'quarantined');
});

test('a public URL cannot bypass a failed native nuisance battery', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ai-image-detector-shipping-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(join(process.cwd(), 'models'), join(root, 'models'), { recursive: true });

  const manifestPath = join(root, 'models', 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.models[0].url = 'https://example.invalid/immutable/model.onnx';
  writeFileSync(manifestPath, JSON.stringify(manifest));

  const curvePath = join(root, 'models', 'calibration', 'fused.json');
  const curve = JSON.parse(readFileSync(curvePath, 'utf8'));
  curve.shippingStatus = 'validated';
  writeFileSync(curvePath, JSON.stringify(curve));

  assert.throws(
    () => assertShippingContract({ root }),
    /passing frozen native-format nuisance battery/,
  );
});
