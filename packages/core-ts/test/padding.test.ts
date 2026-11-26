import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUCKETS, LENGTH_PREFIX_BYTES, MAX_BUCKET, MAX_PLAINTEXT_LENGTH, MIN_BUCKET, bucketFor, pad, unpad,
} from '../src/padding.ts';
import { toHex } from '../src/bytes.ts';

test('the bucket table: powers of 2 from 4 KiB to 32 MiB', () => {
  assert.deepEqual([...BUCKETS], [
    4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288,
    1048576, 2097152, 4194304, 8388608, 16777216, 33554432,
  ]);
  assert.equal(MIN_BUCKET, 4096);
  assert.equal(MAX_BUCKET, 33554432);
  assert.equal(LENGTH_PREFIX_BYTES, 4);
  assert.equal(MAX_PLAINTEXT_LENGTH, 33554428);
  assert.ok(Object.isFrozen(BUCKETS));
});

test('bucketFor: the smallest bucket that fits the length prefix and the message', () => {
  assert.equal(bucketFor(0), 4096);
  assert.equal(bucketFor(1), 4096);
  for (const bucket of BUCKETS) {
    assert.equal(bucketFor(bucket - 4), bucket, `upper edge of ${bucket}`);
    assert.equal(bucketFor(bucket - 5), bucket, `just below the edge of ${bucket}`);
    if (bucket < MAX_BUCKET) assert.equal(bucketFor(bucket - 3), bucket * 2, `overflows ${bucket}`);
  }
  assert.equal(bucketFor(MAX_PLAINTEXT_LENGTH), MAX_BUCKET);
});

test('bucketFor rejects out-of-range lengths', () => {
  for (const bad of [MAX_PLAINTEXT_LENGTH + 1, MAX_BUCKET, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
    assert.throws(() => bucketFor(bad), RangeError, String(bad));
  }
});

test('pad: length (u32 big-endian), message and zeros up to the bucket', () => {
  const padded = pad(new Uint8Array([0xaa, 0xbb, 0xcc]));
  assert.equal(padded.length, 4096);
  assert.equal(toHex(padded.subarray(0, 8)), '00000003aabbcc00');
  assert.ok(padded.subarray(7).every((b) => b === 0));

  const empty = pad(new Uint8Array(0));
  assert.equal(empty.length, 4096);
  assert.ok(empty.every((b) => b === 0));

  const full = pad(new Uint8Array(4092).fill(0x11));
  assert.equal(full.length, 4096);
  assert.equal(toHex(full.subarray(0, 5)), '00000ffc11');
  assert.equal(full[4095], 0x11);

  const next = pad(new Uint8Array(4093).fill(0x22));
  assert.equal(next.length, 8192);
  assert.equal(toHex(next.subarray(0, 5)), '00000ffd22');
  assert.equal(next[4096], 0x22);
  assert.equal(next[4097], 0);
});

test('pad does not modify its input', () => {
  const message = new Uint8Array([1, 2, 3]);
  pad(message);
  assert.deepEqual([...message], [1, 2, 3]);
});

test('unpad recovers the exact message', () => {
  for (const length of [0, 1, 3, 4091, 4092, 4093, 70000]) {
    const message = new Uint8Array(length).map((_, i) => (i * 7 + 1) % 256);
    const out = unpad(pad(message));
    assert.ok(out !== null);
    assert.equal(toHex(out), toHex(message), `length ${length}`);
  }
});

test('unpad accepts paddings outside the table and ignores the padding content', () => {
  assert.equal(toHex(unpad(new Uint8Array([0, 0, 0, 2, 0xaa, 0xbb, 0x99, 0x77]))!), 'aabb');
  assert.equal(toHex(unpad(new Uint8Array([0, 0, 0, 2, 0xaa, 0xbb]))!), 'aabb');
  assert.equal(unpad(new Uint8Array([0, 0, 0, 0]))!.length, 0);
});

test('unpad returns null if the prefix does not fit or the declared length exceeds the content', () => {
  assert.equal(unpad(new Uint8Array(0)), null);
  assert.equal(unpad(new Uint8Array([0, 0, 0])), null);
  assert.equal(unpad(new Uint8Array([0, 0, 0, 1])), null);
  assert.equal(unpad(new Uint8Array([0, 0, 0, 3, 0xaa, 0xbb])), null);
  assert.equal(unpad(new Uint8Array([0xff, 0xff, 0xff, 0xff, 1, 2, 3, 4])), null);
  assert.equal(unpad(new Uint8Array([0x80, 0, 0, 0, 1, 2, 3, 4])), null);
});
