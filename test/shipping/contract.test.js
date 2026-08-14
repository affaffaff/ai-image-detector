import test from 'node:test';
import assert from 'node:assert/strict';

import { assertShippingContract } from '../../tools/assert_shipping.mjs';

test('shipping contract keeps an unconfigured model explicitly quarantined', () => {
  const result = assertShippingContract();
  assert.equal(result.configuredForShipping, false);
  assert.equal(result.curveStatus, 'quarantined');
});
