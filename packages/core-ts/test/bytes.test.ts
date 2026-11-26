import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concatBytes, fromHex, isAllZero, readUint32BE, toHex, uintBE, withWiped } from '../src/bytes.ts';

test('toHex and fromHex: lowercase, no 0x, round trip', () => {
  assert.equal(toHex(new Uint8Array([0, 1, 0xab, 0xff])), '0001abff');
  assert.equal(toHex(new Uint8Array(0)), '');
  assert.deepEqual([...fromHex('0001abff')], [0, 1, 0xab, 0xff]);
  assert.deepEqual([...fromHex('')], []);
  assert.ok(!Buffer.isBuffer(fromHex('00')), 'returns a Uint8Array, not a Buffer');
});

test('toHex honours the offset of a view', () => {
  const view = new Uint8Array([9, 9, 1, 2, 9]).subarray(2, 4);
  assert.equal(toHex(view), '0102');
});

test('fromHex rejects non-canonical hex and does not echo the input in the error', () => {
  for (const bad of ['0', 'abc', 'AB', '0x00', 'zz', '00 11', ' 00', '00\n', 'ab\ncd']) {
    assert.throws(() => fromHex(bad), { name: 'TypeError', message: 'invalid hex' }, bad);
  }
});

test('concatBytes joins in order and returns a copy', () => {
  const a = new Uint8Array([1, 2]);
  const out = concatBytes(a, new Uint8Array(0), new Uint8Array([3]));
  assert.equal(toHex(out), '010203');
  a[0] = 7;
  assert.equal(toHex(out), '010203');
  assert.equal(concatBytes().length, 0);
});

test('uintBE encodes unsigned integers in big-endian', () => {
  assert.equal(toHex(uintBE(0, 1)), '00');
  assert.equal(toHex(uintBE(255, 1)), 'ff');
  assert.equal(toHex(uintBE(0x0102, 2)), '0102');
  assert.equal(toHex(uintBE(65535, 2)), 'ffff');
  assert.equal(toHex(uintBE(1, 4)), '00000001');
  assert.equal(toHex(uintBE(0xfffffffc, 4)), 'fffffffc');
  assert.equal(toHex(uintBE(0, 8)), '0000000000000000');
  assert.equal(toHex(uintBE(1794873600, 8)), '000000006afb9900');
  assert.equal(toHex(uintBE(Number.MAX_SAFE_INTEGER, 8)), '001fffffffffffff');
});

test('uintBE rejects out-of-range or non-integer values', () => {
  const bad: [number, number][] = [
    [256, 1], [65536, 2], [2 ** 32, 4], [-1, 1], [-1, 8], [1.5, 2], [Number.NaN, 4],
    [Number.POSITIVE_INFINITY, 8], [Number.MAX_SAFE_INTEGER + 1, 8],
  ];
  for (const [value, width] of bad) assert.throws(() => uintBE(value, width), RangeError, `${value}/${width}`);
});

test('readUint32BE reads the first four bytes as unsigned', () => {
  assert.equal(readUint32BE(new Uint8Array([0, 0, 0, 0])), 0);
  assert.equal(readUint32BE(new Uint8Array([0, 0, 1, 2, 9])), 258);
  assert.equal(readUint32BE(new Uint8Array([0xff, 0xff, 0xff, 0xfc])), 0xfffffffc);
  assert.equal(readUint32BE(new Uint8Array([0x80, 0, 0, 0])), 2 ** 31);
  assert.equal(readUint32BE(new Uint8Array([7, 7, 0x01, 0x02, 0x03, 0x04]).subarray(2)), 0x01020304);
});

test('withWiped wipes the secret when done, also if the function throws', () => {
  const secret = new Uint8Array([1, 2, 3]);
  const result = withWiped(secret, () => {
    assert.equal(toHex(secret), '010203', 'intact while in use');
    return 42;
  });
  assert.equal(result, 42);
  assert.equal(toHex(secret), '000000');
  const again = new Uint8Array([9, 9]);
  assert.throws(() => withWiped(again, () => { throw new Error('boom'); }), /boom/);
  assert.equal(toHex(again), '0000');
});

test('isAllZero', () => {
  assert.equal(isAllZero(new Uint8Array(32)), true);
  assert.equal(isAllZero(new Uint8Array(0)), true);
  for (const i of [0, 15, 31]) {
    const b = new Uint8Array(32);
    b[i] = 1;
    assert.equal(isAllZero(b), false, `byte ${i}`);
  }
  assert.equal(isAllZero(new Uint8Array([0x80])), false);
});
