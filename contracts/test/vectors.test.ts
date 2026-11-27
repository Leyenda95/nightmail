// The contract's hash formulas must not change without deliberately regenerating the vectors
// (shared by the app, the server and the sidecar).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeVectors, VECTORS_FILE } from '../scripts/vectors.ts';

test('the contract pure functions reproduce the shared vectors', () => {
  const expected = JSON.parse(readFileSync(VECTORS_FILE, 'utf8'));
  assert.deepEqual(computeVectors(), expected);
});

test('the vectors are not trivial: each hash differs from the others', () => {
  const v = computeVectors();
  const hashes = [v.ctx, v.operatorPk, v.bonoId, v.bonoLeafFree, v.bonoLeafPaid, v.slotNullifierMailbox3,
    v.slotNullifierAlias3, v.slotNullifierMailbox3Gen1, v.addressKey, v.aliasKey];
  assert.equal(new Set(hashes).size, hashes.length);
  assert.deepEqual(v.limits, { free: { mailbox: 1, alias: 2 }, paid: { mailbox: 5, alias: 20 } });
  assert.equal(v.noExpiry, String(2 ** 32 - 1));
  assert.deepEqual(v.oldPriceGrace, { minSeconds: '900', maxSeconds: '1200' });
});
