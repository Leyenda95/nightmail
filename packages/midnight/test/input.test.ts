// Input validation: strict hex and unsigned integers sized as in the contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromHex, InvalidInput, toHex, uint } from '../src/index.ts';

test('uint accepts number (from JSON) and bigint within range', () => {
  assert.equal(uint(3, 8, 'j'), 3n);
  assert.equal(uint(0, 8, 'j'), 0n);
  assert.equal(uint(255, 8, 'j'), 255n);
  assert.equal(uint(2 ** 32 - 1, 32, 'k'), 2n ** 32n - 1n);
  assert.equal(uint(7n, 8, 'j'), 7n);
});

test('uint rejects with InvalidInput what is not an unsigned integer of that size', () => {
  for (const bad of [256, -1, 1.5, NaN, Infinity, 2 ** 53, '1', null, undefined, true, 256n, -1n]) {
    assert.throws(() => uint(bad, 8, 'j'), InvalidInput, String(bad));
  }
});

test('fromHex: exactly that length, lowercase and without 0x', () => {
  assert.deepEqual(fromHex('00ff', 2, 'x'), new Uint8Array([0, 255]));
  assert.equal(toHex(fromHex('ab'.repeat(32), 32, 'x')), 'ab'.repeat(32));
  for (const bad of ['00FF', '0x00ff', '00f', '00ff00', '', 'zzzz', 42, null]) {
    assert.throws(() => fromHex(bad, 2, 'x'), InvalidInput, String(bad));
  }
});
