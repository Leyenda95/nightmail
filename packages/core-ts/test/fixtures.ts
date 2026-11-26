// Constants and helpers shared by the tests and the vector generator.
import { createCipheriv, diffieHellman } from 'node:crypto';
import { concatBytes, fromHex } from '../src/bytes.ts';
import { privateKeyObject, publicKeyObject, x25519PublicKey } from '../src/keys.ts';
import { deriveMailboxKey } from '../src/mailbox.ts';
import type { SealRandomness } from '../src/mailbox.ts';

/** Raw X25519, without the low-order check of the code under test. */
export function x25519(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  return Uint8Array.from(diffieHellman({
    privateKey: privateKeyObject('x25519', secretKey), publicKey: publicKeyObject('x25519', publicKey),
  }));
}

/**
 * Envelope with an arbitrary header (version ‖ suite) and a tag valid for it. Anyone who knows the
 * public key can build one; used to check that the opener checks the header and does not rely on
 * the tag alone.
 */
export function sealWithHeader(
  header: Uint8Array, recipientPublicKey: Uint8Array, padded: Uint8Array, randomness: SealRandomness,
): Uint8Array {
  const { ephemeralSecretKey, nonce } = randomness;
  const ephemeralPublicKey = x25519PublicKey(ephemeralSecretKey);
  const key = deriveMailboxKey(x25519(ephemeralSecretKey, recipientPublicKey), ephemeralPublicKey, recipientPublicKey);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(header);
  const ciphertext = cipher.update(padded);
  cipher.final();
  return concatBytes(header, ephemeralPublicKey, nonce, cipher.getAuthTag(), ciphertext);
}

/** Curve25519 low-order points (u coordinate), plus two variants with the high bit set. */
export const X25519_LOW_ORDER: readonly string[] = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800',
  '5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b880',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
];

/** The 14 encodings of Ed25519 low-order points (7 `y` values, with and without the sign bit). */
export const ED25519_LOW_ORDER: readonly string[] = [
  '0100000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000080',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000080',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
];

/** Trivial Ed25519 signature: R = identity point, S = 0. */
export const TRIVIAL_SIGNATURE: Uint8Array = fromHex(`01${'00'.repeat(63)}`);

/** Non-canonical X25519 keys (bit 255 set or u >= p) that are not low order, so the exchange "works". */
export const X25519_NON_CANONICAL: readonly string[] = [
  'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882bcf',
  '0200000000000000000000000000000000000000000000000000000000000080',
  'f0ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
];
