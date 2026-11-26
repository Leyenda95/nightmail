// Raw X25519 and Ed25519 keys (32 bytes) <-> `node:crypto` key objects.
// A secret key is always the 32-byte seed (RFC 7748, RFC 8032), the same input taken by
// `x25519-dalek` (`StaticSecret::from`) and `ed25519-dalek` (`SigningKey::from_bytes`).
import { createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { toHex } from './bytes.ts';

export const KEY_LENGTH = 32;

export type Curve = 'x25519' | 'ed25519';

// RFC 8410 DER prefixes for a 32-byte key; only the last OID byte differs between curves.
const OID_SUFFIX: Record<Curve, string> = { x25519: '6e', ed25519: '70' };
const spkiHeader = (curve: Curve) => Buffer.from(`302a300506032b65${OID_SUFFIX[curve]}032100`, 'hex');
const pkcs8Header = (curve: Curve) => Buffer.from(`302e020100300506032b65${OID_SUFFIX[curve]}04220420`, 'hex');

function requireKeyLength(raw: Uint8Array): void {
  if (raw.length !== KEY_LENGTH) throw new TypeError('the key must be 32 bytes');
}

export function publicKeyObject(curve: Curve, raw: Uint8Array): KeyObject {
  requireKeyLength(raw);
  return createPublicKey({ key: Buffer.concat([spkiHeader(curve), raw]), format: 'der', type: 'spki' });
}

export function privateKeyObject(curve: Curve, raw: Uint8Array): KeyObject {
  requireKeyLength(raw);
  return createPrivateKey({ key: Buffer.concat([pkcs8Header(curve), raw]), format: 'der', type: 'pkcs8' });
}

function publicKeyFromSecret(curve: Curve, secretKey: Uint8Array): Uint8Array {
  const spki = createPublicKey(privateKeyObject(curve, secretKey)).export({ format: 'der', type: 'spki' });
  return Uint8Array.from(spki.subarray(spki.length - KEY_LENGTH));
}

export function x25519PublicKey(secretKey: Uint8Array): Uint8Array {
  return publicKeyFromSecret('x25519', secretKey);
}

export function ed25519PublicKey(secretKey: Uint8Array): Uint8Array {
  return publicKeyFromSecret('ed25519', secretKey);
}

/**
 * 32 random bytes for a single key: either an X25519 secret key or an Ed25519 seed, never both.
 * In the app, each address's encryption and signing keys come from separate HKDF derivations.
 * Intended for tests and scripts.
 */
export function generateSecretKey(): Uint8Array {
  return Uint8Array.from(randomBytes(KEY_LENGTH));
}

// The 7 `y` values of the Ed25519 low-order points (the 8 torsion points plus their non-canonical
// encodings), with the sign bit cleared. Same list as libsodium's `ge25519_has_small_order`.
// OpenSSL does not reject them on verify, and with such a key a valid signature can be forged
// without knowing any secret.
const ED25519_LOW_ORDER_Y = new Set([
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
]);

/** Public keys are public data, so this comparison need not be constant time. */
export function isLowOrderEd25519PublicKey(publicKey: Uint8Array): boolean {
  if (publicKey.length !== KEY_LENGTH) return false;
  const y = Uint8Array.from(publicKey);
  y[KEY_LENGTH - 1]! &= 0x7f;
  return ED25519_LOW_ORDER_Y.has(toHex(y));
}

/**
 * Do the low 255 bits encode a value below p = 2^255 - 19? The only ones that do not are
 * p .. 2^255 - 1: first byte >= 0xed, the next 30 bytes 0xff and the last (without bit 255) 0x7f.
 */
function isCanonicalFieldElement(bytes: Uint8Array): boolean {
  if (bytes[0]! < 0xed || (bytes[KEY_LENGTH - 1]! & 0x7f) !== 0x7f) return true;
  return !bytes.subarray(1, KEY_LENGTH - 1).every((byte) => byte === 0xff);
}

/**
 * Is this the canonical encoding of an X25519 public key (32 bytes, bit 255 clear, u < p)?
 * X25519 ignores bit 255 and reduces mod p, so a non-canonical key "works", but its bytes differ
 * from the ones the key holder derives from their secret key.
 */
export function isCanonicalX25519PublicKey(publicKey: Uint8Array): boolean {
  return publicKey.length === KEY_LENGTH && (publicKey[KEY_LENGTH - 1]! & 0x80) === 0 && isCanonicalFieldElement(publicKey);
}

/**
 * Can this Ed25519 key authenticate a mailbox? 32 bytes, canonical `y`, not low order. It does not
 * check that the point is on the curve: with such a key no signature verifies anyway. Used to
 * discard an address when syncing the registry, before accepting requests for it.
 */
export function isUsableAuthPublicKey(publicKey: Uint8Array): boolean {
  return publicKey instanceof Uint8Array && publicKey.length === KEY_LENGTH
    && isCanonicalFieldElement(publicKey) && !isLowOrderEd25519PublicKey(publicKey);
}
