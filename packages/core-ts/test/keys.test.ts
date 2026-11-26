import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verify } from 'node:crypto';
import {
  KEY_LENGTH, ed25519PublicKey, generateSecretKey, isCanonicalX25519PublicKey, isLowOrderEd25519PublicKey,
  isUsableAuthPublicKey, publicKeyObject, x25519PublicKey,
} from '../src/keys.ts';
import { fromHex, toHex } from '../src/bytes.ts';
import { ED25519_LOW_ORDER, TRIVIAL_SIGNATURE, X25519_NON_CANONICAL } from './fixtures.ts';

test('x25519PublicKey reproduces RFC 7748 §6.1', () => {
  const alice = fromHex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
  assert.equal(toHex(x25519PublicKey(alice)), '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a');
  const bob = fromHex('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb');
  assert.equal(toHex(x25519PublicKey(bob)), 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f');
});

test('ed25519PublicKey reproduces RFC 8032 §7.1 (the secret key is the 32-byte seed)', () => {
  const seed = fromHex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
  assert.equal(toHex(ed25519PublicKey(seed)), 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
});

test('public keys are 32-byte Uint8Arrays, not Buffers', () => {
  const secret = generateSecretKey();
  for (const pk of [x25519PublicKey(secret), ed25519PublicKey(secret)]) {
    assert.equal(pk.length, KEY_LENGTH);
    assert.ok(!Buffer.isBuffer(pk));
  }
});

test('generateSecretKey: 32 random bytes', () => {
  const a = generateSecretKey(), b = generateSecretKey();
  assert.equal(a.length, 32);
  assert.notEqual(toHex(a), toHex(b));
});

test('keys whose length is not 32 are rejected without echoing their content', () => {
  for (const length of [0, 31, 33, 64]) {
    const key = new Uint8Array(length).fill(0x5a);
    for (const fn of [x25519PublicKey, ed25519PublicKey, (k: Uint8Array) => publicKeyObject('x25519', k)]) {
      assert.throws(() => fn(key), (e: Error) => e instanceof TypeError && !e.message.includes('5a'), `length ${length}`);
    }
  }
});

test('isLowOrderEd25519PublicKey recognises the 14 low-order encodings', () => {
  assert.equal(ED25519_LOW_ORDER.length, 14);
  for (const hex of ED25519_LOW_ORDER) assert.equal(isLowOrderEd25519PublicKey(fromHex(hex)), true, hex);
});

test('the listed keys really are low order: OpenSSL accepts a trivial signature for them', () => {
  // With a low-order key, the signature (R = identity, S = 0) verifies for at least 1 in 8 messages.
  for (const hex of ED25519_LOW_ORDER) {
    const key = publicKeyObject('ed25519', fromHex(hex));
    const forged = Array.from({ length: 200 }, (_, i) => i).some((i) => verify(null, Buffer.from([i]), key, TRIVIAL_SIGNATURE));
    assert.ok(forged, hex);
  }
});

test('isLowOrderEd25519PublicKey does not flag normal keys or inputs of another length', () => {
  const seed = fromHex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
  assert.equal(isLowOrderEd25519PublicKey(ed25519PublicKey(seed)), false);
  for (let i = 0; i < 20; i++) assert.equal(isLowOrderEd25519PublicKey(ed25519PublicKey(generateSecretKey())), false);
  // A normal key one bit away from a low-order one.
  const near = fromHex(ED25519_LOW_ORDER[0]!);
  near[5] = 1;
  assert.equal(isLowOrderEd25519PublicKey(near), false);
  assert.equal(isLowOrderEd25519PublicKey(new Uint8Array(31)), false);
  assert.equal(isLowOrderEd25519PublicKey(new Uint8Array(33)), false);
});

test('isLowOrderEd25519PublicKey does not modify its input', () => {
  const key = fromHex('ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
  isLowOrderEd25519PublicKey(key);
  assert.equal(key[31], 0xff);
});

test('isCanonicalX25519PublicKey: 32 bytes, bit 255 cleared and u < p', () => {
  const canonical = [
    '0000000000000000000000000000000000000000000000000000000000000000',
    'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f',
    'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', // p − 1
    'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7e',
    'fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe7f',
    'fffeffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
    'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff3f',
    'ed00000000000000000000000000000000000000000000000000000000000000',
  ];
  for (const hex of canonical) assert.equal(isCanonicalX25519PublicKey(fromHex(hex)), true, hex);
  const nonCanonical = [
    ...X25519_NON_CANONICAL,
    'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', // p
    'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', // p + 1
    '0000000000000000000000000000000000000000000000000000000000000080',
  ];
  for (const hex of nonCanonical) assert.equal(isCanonicalX25519PublicKey(fromHex(hex)), false, hex);
  for (const length of [0, 31, 33]) assert.equal(isCanonicalX25519PublicKey(new Uint8Array(length)), false, `length ${length}`);
});

test('a public key derived from a secret key is always canonical', () => {
  for (let i = 0; i < 50; i++) assert.equal(isCanonicalX25519PublicKey(x25519PublicKey(generateSecretKey())), true);
});

test('isUsableAuthPublicKey: 32 bytes, canonical and not low order', () => {
  const seed = fromHex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
  assert.equal(isUsableAuthPublicKey(ed25519PublicKey(seed)), true);
  // The sign bit (bit 255) is a legitimate part of an Ed25519 key.
  const candidates = Array.from({ length: 64 }, (_, i) => ed25519PublicKey(new Uint8Array(32).fill(i + 1)));
  const withSignBit = candidates.filter((key) => (key[31]! & 0x80) !== 0);
  assert.ok(withSignBit.length > 0 && withSignBit.length < candidates.length, 'there are keys with and without the sign bit');
  for (const key of candidates) assert.equal(isUsableAuthPublicKey(key), true);
  for (const hex of ED25519_LOW_ORDER) assert.equal(isUsableAuthPublicKey(fromHex(hex)), false, hex);
  const nonCanonicalY = [
    'f0ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
    'f0ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  ];
  for (const hex of nonCanonicalY) assert.equal(isUsableAuthPublicKey(fromHex(hex)), false, hex);
  for (const length of [0, 31, 33]) assert.equal(isUsableAuthPublicKey(new Uint8Array(length).fill(7)), false, `length ${length}`);
  const notBytes = ['d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', Array(32).fill(7), null, undefined];
  for (const value of notBytes) assert.equal(isUsableAuthPublicKey(value as never), false);
});
