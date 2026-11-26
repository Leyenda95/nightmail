// Mailbox encryption: mail is sealed to the address's X25519 key, based on MIP-0012 §6.4 `InboxEntry`.
// Envelope (62-byte header + ciphertext), spec in packages/test-vectors/crypto/README.md:
//
//   version (1) = 0x01 ‖ suite (1) = 0x01 ‖ ephemeral public key (32) ‖ nonce (12) ‖ tag (16) ‖ ciphertext
//   key = HKDF-SHA256(X25519(ephemeral, recipient), empty salt, "nightmail:mailbox:v1" ‖ eph pk ‖ rcpt pk)
//   AAD = version ‖ suite
//
// Unlike the MIP: variable length with padding inside the ciphertext, `info` binds both public keys
// (as in HPKE), and low-order keys are rejected, as are non-canonical ones when sealing (`info` carries
// the key bytes verbatim, so the recipient could not open).
import { createCipheriv, createDecipheriv, diffieHellman, hkdfSync, randomBytes } from 'node:crypto';
import { concatBytes, isAllZero, withWiped } from './bytes.ts';
import { KEY_LENGTH, isCanonicalX25519PublicKey, privateKeyObject, publicKeyObject, x25519PublicKey } from './keys.ts';
import { BUCKETS, MAX_BUCKET, MAX_PLAINTEXT_LENGTH, bucketFor, pad, unpad } from './padding.ts';

export const MAILBOX_DOMAIN = 'nightmail:mailbox:v1';
export const ENVELOPE_VERSION = 0x01;
export const ENVELOPE_SUITE = 0x01;
export const NONCE_LENGTH = 12;
export const TAG_LENGTH = 16;
export const ENVELOPE_HEADER_LENGTH = 2 + KEY_LENGTH + NONCE_LENGTH + TAG_LENGTH;
/** Largest envelope that will be opened; readers check it before allocating memory. */
export const MAX_ENVELOPE_LENGTH = ENVELOPE_HEADER_LENGTH + MAX_BUCKET;

const CIPHER = 'aes-256-gcm';
const HEADER = Uint8Array.of(ENVELOPE_VERSION, ENVELOPE_SUITE);
const DOMAIN_BYTES = new TextEncoder().encode(MAILBOX_DOMAIN);
const NO_SALT = new Uint8Array(0);
// Any secret key detects a low-order point: with one, the shared secret is always zero.
const PROBE_SECRET_KEY = new Uint8Array(KEY_LENGTH).fill(0x42);

const MESSAGES = {
  'invalid-key': 'invalid key',
  'too-large': 'message too large',
  'invalid-envelope': 'invalid envelope',
};

export type MailboxErrorCode = keyof typeof MESSAGES;

/**
 * The only mailbox crypto error. When opening, every envelope failure (version, ephemeral key,
 * tag, padding) yields `invalid-envelope` with the same message and no cause, so it never reveals
 * which step failed.
 */
export class MailboxCryptoError extends Error {
  readonly code: MailboxErrorCode;

  constructor(code: MailboxErrorCode) {
    super(MESSAGES[code]);
    this.name = 'MailboxCryptoError';
    this.code = code;
  }
}

/** Ephemeral key and nonce of one sealing. Only set by hand to generate test vectors. */
export type SealRandomness = { ephemeralSecretKey: Uint8Array; nonce: Uint8Array };

/** An all-zero shared secret reveals a low-order public key that contributes nothing from its side. */
export function requireContributory(sharedSecret: Uint8Array): Uint8Array {
  if (isAllZero(sharedSecret)) throw new MailboxCryptoError('invalid-key');
  return sharedSecret;
}

/** Any failure while handling a key (length, invalid point) surfaces as `invalid-key` with no further detail. */
function invalidKeyOnError<T>(compute: () => T): T {
  try {
    return compute();
  } catch {
    throw new MailboxCryptoError('invalid-key');
  }
}

function agree(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  // OpenSSL already fails on low-order points; the explicit check avoids relying on that.
  return invalidKeyOnError(() => requireContributory(diffieHellman({
    privateKey: privateKeyObject('x25519', secretKey),
    publicKey: publicKeyObject('x25519', publicKey),
  })));
}

/**
 * Can mail be encrypted to this X25519 public key? 32 bytes, canonical, not low order. Used to
 * discard an address when syncing the registry or at `RCPT TO`, before receiving the message:
 * `sealMailbox` throws `invalid-key` for exactly the keys this rejects.
 */
export function isUsableMailboxPublicKey(publicKey: Uint8Array): boolean {
  if (!(publicKey instanceof Uint8Array) || !isCanonicalX25519PublicKey(publicKey)) return false;
  try {
    agree(PROBE_SECRET_KEY, publicKey);
    return true;
  } catch {
    return false;
  }
}

export function deriveMailboxKey(
  sharedSecret: Uint8Array, ephemeralPublicKey: Uint8Array, recipientPublicKey: Uint8Array,
): Uint8Array {
  const info = concatBytes(DOMAIN_BYTES, ephemeralPublicKey, recipientPublicKey);
  return new Uint8Array(hkdfSync('sha256', sharedSecret, NO_SALT, info, KEY_LENGTH));
}

function sessionKey(
  secretKey: Uint8Array, peerPublicKey: Uint8Array, ephemeralPublicKey: Uint8Array, recipientPublicKey: Uint8Array,
): Uint8Array {
  const sharedSecret = agree(secretKey, peerPublicKey);
  return withWiped(sharedSecret, () => deriveMailboxKey(sharedSecret, ephemeralPublicKey, recipientPublicKey));
}

/**
 * Seals an already padded buffer and wipes `padded` afterwards (it is a plaintext copy).
 * Outside tests and vectors, always go through `sealMailbox`.
 */
export function sealPadded(recipientPublicKey: Uint8Array, padded: Uint8Array, randomness: SealRandomness): Uint8Array {
  const { ephemeralSecretKey, nonce } = randomness;
  return withWiped(padded, () => {
    if (nonce.length !== NONCE_LENGTH) throw new RangeError('the nonce must be 12 bytes');
    if (!isUsableMailboxPublicKey(recipientPublicKey)) throw new MailboxCryptoError('invalid-key');
    const ephemeralPublicKey = invalidKeyOnError(() => x25519PublicKey(ephemeralSecretKey));
    const key = sessionKey(ephemeralSecretKey, recipientPublicKey, ephemeralPublicKey, recipientPublicKey);
    const cipher = withWiped(key, () => createCipheriv(CIPHER, key, nonce));
    cipher.setAAD(HEADER);
    const ciphertext = cipher.update(padded);
    cipher.final();
    return concatBytes(HEADER, ephemeralPublicKey, nonce, cipher.getAuthTag(), ciphertext);
  });
}

/** Deterministic variant of `sealMailbox` for test vectors. Not the default API. */
export function sealMailboxDeterministic(
  recipientPublicKey: Uint8Array, plaintext: Uint8Array, randomness: SealRandomness,
): Uint8Array {
  // A string or array also has `length` and would silently be "encrypted" as zeros.
  if (!(plaintext instanceof Uint8Array)) throw new TypeError('the message must be a Uint8Array');
  if (plaintext.length > MAX_PLAINTEXT_LENGTH) throw new MailboxCryptoError('too-large');
  return sealPadded(recipientPublicKey, pad(plaintext), randomness);
}

/**
 * Encrypts `plaintext` to the recipient's X25519 public key with a fresh ephemeral key and nonce.
 * Throws `MailboxCryptoError` `invalid-key` (a key `isUsableMailboxPublicKey` rejects) or
 * `too-large` (over `MAX_PLAINTEXT_LENGTH` bytes), and `TypeError` if the message is not a `Uint8Array`.
 */
export function sealMailbox(recipientPublicKey: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const randomness = { ephemeralSecretKey: randomBytes(KEY_LENGTH), nonce: randomBytes(NONCE_LENGTH) };
  return withWiped(randomness.ephemeralSecretKey, () => sealMailboxDeterministic(recipientPublicKey, plaintext, randomness));
}

type Envelope = {
  header: Uint8Array; ephemeralPublicKey: Uint8Array; nonce: Uint8Array; tag: Uint8Array; ciphertext: Uint8Array;
};

function parseEnvelope(envelope: Uint8Array): Envelope | null {
  if (envelope.length < ENVELOPE_HEADER_LENGTH || envelope.length > MAX_ENVELOPE_LENGTH) return null;
  if (envelope[0] !== ENVELOPE_VERSION || envelope[1] !== ENVELOPE_SUITE) return null;
  const nonceStart = 2 + KEY_LENGTH, tagStart = nonceStart + NONCE_LENGTH;
  return {
    header: envelope.subarray(0, 2),
    ephemeralPublicKey: envelope.subarray(2, nonceStart),
    nonce: envelope.subarray(nonceStart, tagStart),
    tag: envelope.subarray(tagStart, ENVELOPE_HEADER_LENGTH),
    ciphertext: envelope.subarray(ENVELOPE_HEADER_LENGTH),
  };
}

function decrypt(recipientSecretKey: Uint8Array, recipientPublicKey: Uint8Array, envelope: Envelope): Uint8Array {
  const { header, ephemeralPublicKey, nonce, tag, ciphertext } = envelope;
  const key = sessionKey(recipientSecretKey, ephemeralPublicKey, ephemeralPublicKey, recipientPublicKey);
  const decipher = withWiped(key, () => createDecipheriv(CIPHER, key, nonce, { authTagLength: TAG_LENGTH }));
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  const padded = decipher.update(ciphertext);
  decipher.final(); // checks the tag; without it `padded` is unauthenticated
  return padded;
}

/** Copies the message into its own Uint8Array (not a view of a Buffer or of the padding) and wipes the padding. */
function takeMessage(padded: Uint8Array): Uint8Array | null {
  return withWiped(padded, () => {
    const message = unpad(padded);
    return message && Uint8Array.from(message);
  });
}

/**
 * Opens an envelope with the recipient's X25519 secret key. Any envelope failure throws the same
 * `MailboxCryptoError` (`invalid-envelope`); a secret key of the wrong length is a usage error
 * (`invalid-key`). The app uses the Rust core for this; this version serves tests and demo scripts.
 */
export function openMailbox(recipientSecretKey: Uint8Array, envelope: Uint8Array): Uint8Array {
  const recipientPublicKey = invalidKeyOnError(() => x25519PublicKey(recipientSecretKey));
  let plaintext: Uint8Array | null = null;
  try {
    const parsed = parseEnvelope(envelope);
    if (parsed) plaintext = takeMessage(decrypt(recipientSecretKey, recipientPublicKey, parsed));
  } catch {
    // Same error for every failure.
  }
  if (plaintext === null) throw new MailboxCryptoError('invalid-envelope');
  return plaintext;
}

/** Total envelope length for a message of `plaintextLength` bytes. */
export function envelopeLengthFor(plaintextLength: number): number {
  return ENVELOPE_HEADER_LENGTH + bucketFor(plaintextLength);
}

/** Bucket size of a stored envelope (its ciphertext length), the only size information ever exposed. */
export function bucketOfEnvelope(envelopeLength: number): number {
  const bucket = envelopeLength - ENVELOPE_HEADER_LENGTH;
  if (!BUCKETS.includes(bucket)) throw new RangeError('envelope length outside the bucket table');
  return bucket;
}
