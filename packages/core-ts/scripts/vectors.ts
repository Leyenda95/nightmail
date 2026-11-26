// Known-answer vectors for mailbox encryption, request signing and end-to-end mail. This package's
// tests check them and the Rust core must reproduce them.
//   node scripts/vectors.ts   → writes packages/test-vectors/crypto/{mailbox,request-auth,e2e-mail}.json
//   (changing the format requires deliberately regenerating them; the spec is in that folder's README)
import { createCipheriv, createHash, verify } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { concatBytes, fromHex, toHex, uintBE } from '../src/bytes.ts';
import { ed25519PublicKey, publicKeyObject, x25519PublicKey } from '../src/keys.ts';
import {
  ENVELOPE_HEADER_LENGTH, ENVELOPE_SUITE, ENVELOPE_VERSION, MAILBOX_DOMAIN, MAX_ENVELOPE_LENGTH, NONCE_LENGTH, TAG_LENGTH,
  deriveMailboxKey, envelopeLengthFor, sealMailboxDeterministic, sealPadded,
} from '../src/mailbox.ts';
import { BUCKETS, LENGTH_PREFIX_BYTES, MAX_BUCKET, MAX_PLAINTEXT_LENGTH, bucketFor } from '../src/padding.ts';
import {
  ADDR_KEY_LENGTH, MAILBOX_API_VERSION, MAX_CLOCK_SKEW_SECONDS, REQUEST_AUTH_DOMAIN, REQUEST_NONCE_LENGTH,
  SIGNATURE_LENGTH, ed25519Sign, encodeRequest, signRequest,
} from '../src/request-auth.ts';
import type { MailboxRequest } from '../src/request-auth.ts';
import {
  MAIL_FIXED_LENGTH, MAIL_MAGIC, MAIL_SIGNATURE_DOMAIN, MAIL_VERSION, MAX_MAIL_DATE, MAX_MAIL_LENGTH, MAX_SUBJECT_LENGTH,
  MESSAGE_ID_LENGTH, encodeMailPayload, sealMailDeterministic, signMail,
} from '../src/mail.ts';
import type { OutgoingMail } from '../src/mail.ts';
import { NONCE_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, canonicalHost, encodeAuthHeaders } from '../src/transport.ts';
import {
  ED25519_LOW_ORDER, TRIVIAL_SIGNATURE, X25519_LOW_ORDER, X25519_NON_CANONICAL, sealWithHeader, x25519,
} from '../test/fixtures.ts';

const VECTORS_DIR = new URL('../../test-vectors/crypto/', import.meta.url);
export const MAILBOX_VECTORS_FILE = fileURLToPath(new URL('mailbox.json', VECTORS_DIR));
export const REQUEST_AUTH_VECTORS_FILE = fileURLToPath(new URL('request-auth.json', VECTORS_DIR));
export const MAIL_VECTORS_FILE = fileURLToPath(new URL('e2e-mail.json', VECTORS_DIR));

const utf8 = (text: string) => new TextEncoder().encode(text);
const sha256 = (bytes: Uint8Array) => Uint8Array.from(createHash('sha256').update(bytes).digest());

/** Fixed "random" values for the vectors: SHA-256("nightmail:test-vectors:" ‖ label). */
export const seed = (label: string) => sha256(utf8(`nightmail:test-vectors:${label}`));

const PATTERN_PERIOD = 251;
const PATTERN_BLOCK = Uint8Array.from({ length: PATTERN_PERIOD }, (_, i) => i);

/** Filler message for the large vectors: byte `i` is `i mod 251`. */
export function patternBytes(length: number): Uint8Array {
  return length === 0 ? new Uint8Array(0) : Uint8Array.from(Buffer.alloc(length, PATTERN_BLOCK));
}

const SMALL_MAIL = [
  'From: tienda@example.com',
  'To: nube.verde.k7m2q9xa4b3c@nightmail.local',
  'Subject: =?UTF-8?Q?Tu_pedido_ha_salido_=F0=9F=93=A6?=',
  'Date: Tue, 17 Nov 2026 10:00:00 +0000',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Hola: tu pedido nº 1234 ya está en camino. ¡Gracias!',
  '',
].join('\r\n');

// ---------- Mailbox encryption ----------

const recipientSecretKey = seed('mailbox:recipient');
const recipientPublicKey = x25519PublicKey(recipientSecretKey);

// The labels passed here are seed data, not names: several keep their original Spanish wording
// because changing a label changes the stored vectors.
const randomnessFor = (label: string) => ({
  ephemeralSecretKey: seed(`mailbox:eph:${label}`),
  nonce: seed(`mailbox:nonce:${label}`).subarray(0, NONCE_LENGTH),
});

type SealVector = {
  name: string;
  plaintextLength: number;
  /** The message in hex, or `plaintextPattern` if it is the `i mod 251` pattern. */
  plaintext?: string;
  plaintextPattern?: string;
  ephemeralSecretKey: string;
  ephemeralPublicKey: string;
  nonce: string;
  sharedSecret: string;
  key: string;
  bucket: number;
  envelopeLength: number;
  envelopeSha256: string;
  /** Only in the small vectors; the others carry just `envelopeSha256`. */
  envelope?: string;
};

/** A full sealing with intermediate values. The whole envelope is included only if `inline`. */
function sealVector(name: string, label: string, plaintext: Uint8Array, inline: boolean): SealVector {
  const { ephemeralSecretKey, nonce } = randomnessFor(label);
  const ephemeralPublicKey = x25519PublicKey(ephemeralSecretKey);
  const sharedSecret = x25519(ephemeralSecretKey, recipientPublicKey);
  const envelope = sealMailboxDeterministic(recipientPublicKey, plaintext, { ephemeralSecretKey, nonce });
  return {
    name,
    plaintextLength: plaintext.length,
    ...(inline ? { plaintext: toHex(plaintext) } : { plaintextPattern: 'i mod 251' }),
    ephemeralSecretKey: toHex(ephemeralSecretKey),
    ephemeralPublicKey: toHex(ephemeralPublicKey),
    nonce: toHex(nonce),
    sharedSecret: toHex(sharedSecret),
    key: toHex(deriveMailboxKey(sharedSecret, ephemeralPublicKey, recipientPublicKey)),
    bucket: bucketFor(plaintext.length),
    envelopeLength: envelope.length,
    envelopeSha256: toHex(sha256(envelope)),
    ...(inline ? { envelope: toHex(envelope) } : {}),
  };
}

function sealVectors() {
  const inline = [
    sealVector('empty', 'vacío', new Uint8Array(0), true),
    sealVector('short text', 'texto corto', utf8('Hola, NightMail'), true),
    sealVector('small mail', 'correo pequeño', utf8(SMALL_MAIL), true),
  ];
  const edges = BUCKETS.flatMap((bucket) => {
    const largest = bucket - LENGTH_PREFIX_BYTES;
    const fits = sealVector(
      `bucket ${bucket}: the largest message that fits (${largest} bytes)`,
      `tramo ${bucket}: el mayor mensaje que cabe (${largest} bytes)`, patternBytes(largest), false,
    );
    if (bucket === MAX_BUCKET) return [fits];
    return [fits, sealVector(
      `bucket ${bucket * 2}: the smallest message that no longer fits in ${bucket} (${largest + 1} bytes)`,
      `tramo ${bucket * 2}: el menor mensaje que ya no cabe en ${bucket} (${largest + 1} bytes)`, patternBytes(largest + 1), false,
    )];
  });
  return [...inline, ...edges];
}

/** Lengths at the edges of each bucket, without encrypting anything. */
function paddingVectors() {
  const lengths = [0, 1, ...BUCKETS.flatMap((b) => [b - 5, b - 4, b - 3])].filter((n) => n <= MAX_PLAINTEXT_LENGTH);
  return lengths.map((plaintextLength) => ({
    plaintextLength, bucket: bucketFor(plaintextLength), envelopeLength: envelopeLengthFor(plaintextLength),
  }));
}

function kdfVectors() {
  const cases = [
    { sharedSecret: seed('kdf:shared:1'), ephemeralPublicKey: seed('kdf:eph:1'), recipient: seed('kdf:recipient:1') },
    { sharedSecret: new Uint8Array(32).fill(0xff), ephemeralPublicKey: new Uint8Array(32).fill(0x01), recipient: new Uint8Array(32).fill(0x02) },
  ];
  return cases.map(({ sharedSecret, ephemeralPublicKey, recipient }) => ({
    sharedSecret: toHex(sharedSecret),
    ephemeralPublicKey: toHex(ephemeralPublicKey),
    recipientPublicKey: toHex(recipient),
    info: toHex(concatBytes(utf8(MAILBOX_DOMAIN), ephemeralPublicKey, recipient)),
    key: toHex(deriveMailboxKey(sharedSecret, ephemeralPublicKey, recipient)),
  }));
}

/** Small envelope with custom padding (outside the bucket table; readers accept it). */
function sealRaw(name: string, paddedHex: string): Uint8Array {
  return sealPadded(recipientPublicKey, fromHex(paddedHex), randomnessFor(name));
}

const HOLA_PADDED = `00000004${toHex(utf8('hola'))}0000000000000000`;

function openVectors() {
  // [name, seed label, padded, plaintext]
  const cases: [string, string, string, string][] = [
    ['padding outside the bucket table', 'relleno fuera de la tabla de tramos', HOLA_PADDED, 'hola'],
    ['padding with non-zero bytes (the reader ignores them)', 'relleno con bytes no nulos (el lector los ignora)', `00000002${toHex(utf8('ho'))}ffff`, 'ho'],
    ['empty message without padding', 'mensaje vacío sin relleno', '00000000', ''],
  ];
  return cases.map(([name, label, padded, text]) => ({
    name, recipientSecretKey: toHex(recipientSecretKey), envelope: toHex(sealRaw(label, padded)), plaintext: toHex(utf8(text)),
  }));
}

/**
 * Envelope with a valid tag for a low-order ephemeral key: the key comes from HKDF over an all-zero
 * shared secret. Only an implementation that checks for a non-zero shared secret rejects it
 * (README §1.5, step 2).
 */
function sealWithZeroSharedSecret(ephemeralPublicKey: Uint8Array, nonce: Uint8Array): Uint8Array {
  const header = Uint8Array.of(ENVELOPE_VERSION, ENVELOPE_SUITE);
  const key = deriveMailboxKey(new Uint8Array(32), ephemeralPublicKey, recipientPublicKey);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(header);
  const ciphertext = cipher.update(fromHex(HOLA_PADDED));
  cipher.final();
  return concatBytes(header, ephemeralPublicKey, nonce, cipher.getAuthTag(), ciphertext);
}

function openFailureVectors() {
  const good = sealRaw('fallos', HOLA_PADDED);
  const altered = (offset: number, change: (byte: number) => number) => {
    const copy = Uint8Array.from(good);
    copy[offset] = change(copy[offset]!);
    return copy;
  };
  const flip = (offset: number) => altered(offset, (byte) => byte ^ 0x01);
  const forged = (name: string, header: number[]) =>
    sealWithHeader(Uint8Array.from(header), recipientPublicKey, fromHex(HOLA_PADDED), randomnessFor(name));
  const tagStart = ENVELOPE_HEADER_LENGTH - TAG_LENGTH;
  const cases: [string, Uint8Array, Uint8Array?][] = [
    ['tag altered', flip(tagStart)],
    ['tag altered (last byte)', flip(ENVELOPE_HEADER_LENGTH - 1)],
    ['ciphertext altered', flip(ENVELOPE_HEADER_LENGTH)],
    ['nonce altered', flip(tagStart - 1)],
    ['ephemeral key altered', flip(2)],
    ['ephemeral key with bit 255 flipped (same shared secret, different info)', altered(2 + 31, (byte) => byte ^ 0x80)],
    ['unknown version (0x02)', altered(0, () => 0x02)],
    ['version 0x00', altered(0, () => 0x00)],
    ['unknown suite (0x02)', altered(1, () => 0x02)],
    ['version 0x02 with a tag valid for that header (AAD = 02 01)', forged('versión forjada', [0x02, 0x01])],
    ['suite 0x02 with a tag valid for that header (AAD = 01 02)', forged('suite forjada', [0x01, 0x02])],
    ['extra byte at the end', concatBytes(good, new Uint8Array(1))],
    ['last byte missing', good.subarray(0, good.length - 1)],
    ['header only', good.subarray(0, ENVELOPE_HEADER_LENGTH)],
    ['incomplete header', good.subarray(0, ENVELOPE_HEADER_LENGTH - 1)],
    ['empty envelope', new Uint8Array(0)],
    ['another recipient key', good, seed('mailbox:other-recipient')],
    ['valid tag, declared length larger than the content', sealRaw('longitud excesiva', `00000005${toHex(utf8('hola'))}`)],
    ['valid tag, padding shorter than the length prefix', sealRaw('relleno corto', '000000')],
    ...X25519_LOW_ORDER.map((point): [string, Uint8Array] => [
      `low-order ephemeral key ${point.slice(0, 8)}…${point.slice(-2)}`,
      concatBytes(good.subarray(0, 2), fromHex(point), good.subarray(2 + 32)),
    ]),
    ...X25519_LOW_ORDER.map((point): [string, Uint8Array] => [
      `low-order ephemeral key ${point.slice(0, 8)}…${point.slice(-2)} with a valid tag (shared secret = 0)`,
      sealWithZeroSharedSecret(fromHex(point), randomnessFor(`orden bajo con etiqueta válida ${point}`).nonce),
    ]),
  ];
  return cases.map(([name, envelope, secretKey = recipientSecretKey]) => ({
    name, recipientSecretKey: toHex(secretKey), envelope: toHex(envelope),
  }));
}

/**
 * Envelope with a valid tag but larger than the maximum: it must be rejected by length, before
 * allocating memory. Not stored in full; its padding is `paddedLength` zero bytes.
 */
function oversizedVector() {
  const randomness = randomnessFor('sobre mayor que el máximo');
  const paddedLength = MAX_BUCKET + 1;
  const envelope = sealPadded(recipientPublicKey, new Uint8Array(paddedLength), randomness);
  return {
    name: 'valid tag, but the envelope exceeds the maximum (zero padding: empty message)',
    recipientSecretKey: toHex(recipientSecretKey),
    ephemeralSecretKey: toHex(randomness.ephemeralSecretKey),
    nonce: toHex(randomness.nonce),
    paddedLength,
    envelopeLength: envelope.length,
    envelopeSha256: toHex(sha256(envelope)),
  };
}

export function computeMailboxVectors() {
  return {
    note: 'NightMail mailbox encryption. Generated by packages/core-ts (npm run vectors); the specification '
      + 'is in README.md. Lowercase hex without 0x. The opener (the Rust core) must reproduce `seal` with the '
      + 'given ephemeral key and nonce, open `open` and reject `openFailures`.',
    constants: {
      domain: MAILBOX_DOMAIN,
      version: ENVELOPE_VERSION,
      suite: ENVELOPE_SUITE,
      headerLength: ENVELOPE_HEADER_LENGTH,
      nonceLength: NONCE_LENGTH,
      tagLength: TAG_LENGTH,
      lengthPrefixBytes: LENGTH_PREFIX_BYTES,
      buckets: [...BUCKETS],
      maxPlaintextLength: MAX_PLAINTEXT_LENGTH,
      maxEnvelopeLength: MAX_ENVELOPE_LENGTH,
    },
    recipient: { secretKey: toHex(recipientSecretKey), publicKey: toHex(recipientPublicKey) },
    kdf: kdfVectors(),
    padding: paddingVectors(),
    seal: sealVectors(),
    open: openVectors(),
    openFailures: openFailureVectors(),
    openFailureOversized: oversizedVector(),
    sealFailures: {
      plaintextLengthTooLarge: MAX_PLAINTEXT_LENGTH + 1,
      lowOrderRecipientPublicKeys: [...X25519_LOW_ORDER],
      nonCanonicalRecipientPublicKeys: [...X25519_NON_CANONICAL],
    },
  };
}

// ---------- Request signing ----------

const authSecretKey = seed('auth:secret');
const authPublicKey = ed25519PublicKey(authSecretKey);
// Sample addrKey; for signing it is just any 32 bytes.
const addrKey = fromHex('621068aeef170d87aab62215f32c563c6ef3d198cf39b86a0fb109c4d2046c54');

const baseRequest: MailboxRequest = {
  host: 'nightmail.local',
  version: MAILBOX_API_VERSION,
  method: 'GET',
  path: `/v1/box/${toHex(addrKey)}/messages?since=0`,
  addrKey,
  timestamp: 1794873600,
  nonce: seed('auth:nonce').subarray(0, REQUEST_NONCE_LENGTH),
};

const requestJson = (request: MailboxRequest) => ({
  ...request, addrKey: toHex(request.addrKey), nonce: toHex(request.nonce),
});

function validVectors() {
  const cases: [string, Partial<MailboxRequest>][] = [
    ['message list', {}],
    ['one message', { path: `/v1/box/${toHex(addrKey)}/messages/42` }],
    ['host with port', { host: '127.0.0.1:8443' }],
    ['IPv6 host with port', { host: '[::1]:8443' }],
    ['timestamp 0', { timestamp: 0 }],
    ['maximum timestamp (2^53 − 1)', { timestamp: Number.MAX_SAFE_INTEGER }],
    ['another method, minimal path and version 255', { method: 'DELETE', path: '/', version: 255 }],
    ['2048-character path (the longest)', { path: `${baseRequest.path}${'0'.repeat(2048 - baseRequest.path.length)}` }],
    ['path with every allowed character type', { path: '/v1/Box/a-b_c.d~e/%C3%B1?x=1&y=%20' }],
    ['path with dots that are not a . or .. segment', { path: '/.well-known/a..b/...?next=/../x' }],
  ];
  return cases.map(([name, change]) => {
    const request = { ...baseRequest, ...change };
    const signature = signRequest(authSecretKey, request);
    return {
      name, request: requestJson(request), message: toHex(encodeRequest(request)), signature: toHex(signature),
      headers: encodeAuthHeaders({ timestamp: request.timestamp, nonce: request.nonce, signature }),
    };
  });
}

/** S + L: the same signature with a non-canonical S, which must be rejected (RFC 8032 §5.1.7). */
function nonCanonicalS(signature: Uint8Array): Uint8Array {
  const L = 2n ** 252n + 27742317777372353535851937790883648493n;
  const half = SIGNATURE_LENGTH / 2;
  let s = signature.subarray(half).reduceRight((acc, byte) => (acc << 8n) | BigInt(byte), 0n) + L;
  const out = Uint8Array.from(signature);
  for (let i = half; i < SIGNATURE_LENGTH; i++) {
    out[i] = Number(s & 0xffn);
    s >>= 8n;
  }
  return out;
}

/** First request for which an Ed25519 verifier that does not check the key accepts the trivial signature. */
function forgeableRequest(lowOrderKey: Uint8Array): MailboxRequest {
  const key = publicKeyObject('ed25519', lowOrderKey);
  // Works for at least 1 in 8 messages; the limit only prevents an endless loop if the encoding stops depending on the timestamp.
  for (let timestamp = 0; timestamp < 1000; timestamp++) {
    const request = { ...baseRequest, timestamp };
    if (verify(null, encodeRequest(request), key, TRIVIAL_SIGNATURE)) return request;
  }
  throw new Error('no forgeable request found');
}

function invalidVectors() {
  const signature = signRequest(authSecretKey, baseRequest);
  const flip = (offset: number) => {
    const copy = Uint8Array.from(signature);
    copy[offset]! ^= 0x01;
    return copy;
  };
  const otherSecretKey = seed('auth:other-secret');
  const changes: [string, Partial<MailboxRequest>][] = [
    ['another host', { host: 'otro.local' }],
    ['another version', { version: 2 }],
    ['another method', { method: 'DELETE' }],
    ['another path', { path: `/v1/box/${toHex(addrKey)}/messages?since=1` }],
    ['another addrKey', { addrKey: seed('auth:other-addr-key') }],
    ['another timestamp', { timestamp: baseRequest.timestamp + 1 }],
    ['another nonce', { nonce: seed('auth:other-nonce').subarray(0, REQUEST_NONCE_LENGTH) }],
  ];
  const cases: [string, Uint8Array, MailboxRequest, Uint8Array][] = [
    ['signature altered (R)', authPublicKey, baseRequest, flip(0)],
    ['signature altered (S)', authPublicKey, baseRequest, flip(SIGNATURE_LENGTH / 2)],
    ...changes.map(([name, change]): [string, Uint8Array, MailboxRequest, Uint8Array] => [
      `signature is for another request: ${name}`, authPublicKey, { ...baseRequest, ...change }, signature,
    ]),
    ['another public key', ed25519PublicKey(otherSecretKey), baseRequest, signature],
    ['signed with another key', authPublicKey, baseRequest, signRequest(otherSecretKey, baseRequest)],
    ['63-byte signature', authPublicKey, baseRequest, signature.subarray(0, SIGNATURE_LENGTH - 1)],
    ['65-byte signature', authPublicKey, baseRequest, concatBytes(signature, new Uint8Array(1))],
    ['empty signature', authPublicKey, baseRequest, new Uint8Array(0)],
    ['non-canonical S (S + L)', authPublicKey, baseRequest, nonCanonicalS(signature)],
    ['31-byte public key', authPublicKey.subarray(0, 31), baseRequest, signature],
    ...ED25519_LOW_ORDER.map((hex): [string, Uint8Array, MailboxRequest, Uint8Array] => {
      const key = fromHex(hex);
      return [`low-order key ${hex.slice(0, 8)}…${hex.slice(-2)} with trivial signature`, key, forgeableRequest(key), TRIVIAL_SIGNATURE];
    }),
  ];
  return cases.map(([name, publicKey, request, sig]) => ({
    name, authPublicKey: toHex(publicKey), request: requestJson(request), signature: toHex(sig),
  }));
}

function rejectedRequestVectors() {
  const cases: [string, keyof MailboxRequest, Partial<MailboxRequest>][] = [
    ['host with uppercase', 'host', { host: 'NightMail.local' }],
    ['empty host', 'host', { host: '' }],
    ['host with path', 'host', { host: 'nightmail.local/x' }],
    ['256-byte host', 'host', { host: 'a'.repeat(256) }],
    ['version 256', 'version', { version: 256 }],
    ['lowercase method', 'method', { method: 'get' }],
    ['empty method', 'method', { method: '' }],
    ['17-letter method', 'method', { method: 'A'.repeat(17) }],
    ['path without leading slash', 'path', { path: 'v1/box' }],
    ['path with a space', 'path', { path: '/v1/box/a b' }],
    ['path with a non-ASCII character', 'path', { path: '/v1/box/ñ' }],
    ['path with a line break', 'path', { path: '/v1/box\n' }],
    ['path with an ASCII character outside the allowed set (!)', 'path', { path: '/v1/box/a!b' }],
    ['path with a colon', 'path', { path: '/v1/box/a:b' }],
    ['path with a fragment', 'path', { path: '/v1/box/a#b' }],
    ['path with a .. segment', 'path', { path: '/v1/box/../x' }],
    ['path with a . segment', 'path', { path: '/v1/./box' }],
    ['path ending in ..', 'path', { path: '/v1/box/..' }],
    ['path with an encoded .. segment', 'path', { path: '/v1/box/%2e%2e/x' }],
    ['path with a half-encoded uppercase .. segment', 'path', { path: '/v1/box/.%2E/x' }],
    ['path with an encoded . segment before the query', 'path', { path: '/v1/box/%2e?since=0' }],
    ['path with a plus sign', 'path', { path: '/v1/box/a?b=c+d' }],
    ['2049-byte path', 'path', { path: `/${'a'.repeat(2048)}` }],
    ['31-byte addrKey', 'addrKey', { addrKey: addrKey.subarray(0, ADDR_KEY_LENGTH - 1) }],
    ['negative timestamp', 'timestamp', { timestamp: -1 }],
    ['timestamp with decimals', 'timestamp', { timestamp: 1794873600.5 }],
    ['15-byte nonce', 'nonce', { nonce: baseRequest.nonce.subarray(0, REQUEST_NONCE_LENGTH - 1) }],
    ['17-byte nonce', 'nonce', { nonce: concatBytes(baseRequest.nonce, new Uint8Array(1)) }],
  ];
  return cases.map(([name, field, change]) => ({ name, field, request: requestJson({ ...baseRequest, ...change }) }));
}

/** Signed `host` derived from the configured base URL (server and client compute it independently). */
function hostVectors() {
  const baseUrls = [
    'http://nightmail.local:2526', 'http://NightMail.Local:80/', 'https://nightmail.local:443', 'https://nightmail.local:80',
    'http://nightmail.local:443/v1', 'http://127.0.0.1:8080', 'https://[::1]:8443/', 'http://[::1]',
  ];
  return baseUrls.map((baseUrl) => ({ baseUrl, host: canonicalHost(baseUrl) }));
}

/** Header values the server rejects (one at a time, applied to the headers of the first valid vector). */
function rejectedHeaderVectors() {
  const cases: [string, string, string][] = [
    ['timestamp with a leading zero', TIMESTAMP_HEADER, '01794873600'],
    ['timestamp with a sign', TIMESTAMP_HEADER, '+1794873600'],
    ['timestamp with decimals', TIMESTAMP_HEADER, '1794873600.0'],
    ['timestamp with a space', TIMESTAMP_HEADER, ' 1794873600'],
    ['timestamp in exponential notation', TIMESTAMP_HEADER, '1e9'],
    ['empty timestamp', TIMESTAMP_HEADER, ''],
    ['timestamp larger than 2^53 − 1', TIMESTAMP_HEADER, '9007199254740992'],
    ['repeated timestamp (joined with a comma)', TIMESTAMP_HEADER, '1794873600, 1794873600'],
    ['uppercase nonce', NONCE_HEADER, toHex(baseRequest.nonce).toUpperCase()],
    ['15-byte nonce', NONCE_HEADER, toHex(baseRequest.nonce).slice(2)],
    ['nonce with 0x', NONCE_HEADER, `0x${toHex(baseRequest.nonce).slice(2)}`],
    ['uppercase signature', SIGNATURE_HEADER, toHex(signRequest(authSecretKey, baseRequest)).toUpperCase()],
    ['63-byte signature', SIGNATURE_HEADER, toHex(signRequest(authSecretKey, baseRequest)).slice(2)],
    ['base64 signature', SIGNATURE_HEADER, Buffer.from(signRequest(authSecretKey, baseRequest)).toString('base64')],
  ];
  return cases.map(([name, header, value]) => ({ name, header, value }));
}

/** Base URLs that are not http(s) or whose authority cannot be signed; client and server reject them at start-up. */
const REJECTED_BASE_URLS = ['http://mail_server:8080', 'ftp://nightmail.local', 'nightmail.local:2526', 'nightmail.local', ''];

function timeWindowVectors() {
  const now = baseRequest.timestamp, tolerance = MAX_CLOCK_SKEW_SECONDS;
  const cases: [number, number, boolean][] = [
    [0, tolerance, true], [tolerance, tolerance, true], [-tolerance, tolerance, true],
    [tolerance + 1, tolerance, false], [-tolerance - 1, tolerance, false], [3600, tolerance, false],
    [5, 5, true], [6, 5, false], [0, 0, true], [1, 0, false],
  ];
  return cases.map(([delta, toleranceSeconds, accepted]) => ({ timestamp: now + delta, now, toleranceSeconds, accepted }));
}

export function computeRequestAuthVectors() {
  return {
    note: 'Ed25519 signing of mailbox requests. Generated by packages/core-ts (npm run vectors); the '
      + 'specification is in README.md. Lowercase hex without 0x. The signer (the Rust core) must reproduce '
      + '`message`, `signature` and `headers` of every `valid` entry, and `host` of every `hosts` entry.',
    constants: {
      domain: REQUEST_AUTH_DOMAIN,
      version: MAILBOX_API_VERSION,
      addrKeyLength: ADDR_KEY_LENGTH,
      nonceLength: REQUEST_NONCE_LENGTH,
      signatureLength: SIGNATURE_LENGTH,
      maxClockSkewSeconds: MAX_CLOCK_SKEW_SECONDS,
      timestampHeader: TIMESTAMP_HEADER,
      nonceHeader: NONCE_HEADER,
      signatureHeader: SIGNATURE_HEADER,
    },
    auth: { secretKey: toHex(authSecretKey), publicKey: toHex(authPublicKey) },
    encodingExample: {
      domain: toHex(utf8(REQUEST_AUTH_DOMAIN)),
      host: toHex(concatBytes(uintBE(baseRequest.host.length, 2), utf8(baseRequest.host))),
      version: toHex(uintBE(baseRequest.version, 1)),
      method: toHex(concatBytes(uintBE(baseRequest.method.length, 2), utf8(baseRequest.method))),
      path: toHex(concatBytes(uintBE(baseRequest.path.length, 2), utf8(baseRequest.path))),
      addrKey: toHex(baseRequest.addrKey),
      timestamp: toHex(uintBE(baseRequest.timestamp, 8)),
      nonce: toHex(baseRequest.nonce),
    },
    valid: validVectors(),
    invalid: invalidVectors(),
    rejectedRequests: rejectedRequestVectors(),
    rejectedHeaders: rejectedHeaderVectors(),
    hosts: hostVectors(),
    rejectedBaseUrls: REJECTED_BASE_URLS,
    timeWindow: timeWindowVectors(),
    lowOrderPublicKeys: [...ED25519_LOW_ORDER],
  };
}

// ---------- End-to-end mail ----------

const MAIL_MAGIC_BYTES = utf8(MAIL_MAGIC);
const MAIL_DOMAIN_BYTES = utf8(MAIL_SIGNATURE_DOMAIN);
const ED25519_IDENTITY = fromHex(`01${'00'.repeat(31)}`);

type VectorAddress = { authSecretKey: Uint8Array; addrKey: Uint8Array; address: string };

const vectorAddress = (label: string, address: string): VectorAddress =>
  ({ authSecretKey: seed(`mail:${label}:auth`), addrKey: seed(`mail:${label}:addr-key`), address });

const mailSender = vectorAddress('sender', 'nube.verde.k7m2q9xa4b3c@nightmail.local');
const mailOther = vectorAddress('other', 'ana@nightmail.local');
// Same auth key as the sender: the directory only has to map each addrKey and text to a key.
const mailLongSender = { ...vectorAddress('long-sender', `${'a'.repeat(64)}@${'b'.repeat(190)}`), authSecretKey: mailSender.authSecretKey };
const mailRecipient = { ...vectorAddress('recipient', 'juan@nightmail.local'), encSecretKey: seed('mail:recipient:enc') };
const mailLongRecipient = { ...vectorAddress('long-recipient', `${'c'.repeat(64)}@${'d'.repeat(190)}`), encSecretKey: mailRecipient.encSecretKey };
const lowOrderSender = { addrKey: seed('mail:low-order:addr-key'), address: 'cero@nightmail.local', authPublicKey: ED25519_IDENTITY };

const partyOf = ({ addrKey, address }: { addrKey: Uint8Array; address: string }) => ({ addrKey, address });
const partyJson = ({ addrKey, address }: { addrKey: Uint8Array; address: string }) => ({ addrKey: toHex(addrKey), address });

const baseMail: OutgoingMail = {
  messageId: seed('mail:message-id').subarray(0, MESSAGE_ID_LENGTH),
  date: 1794873600,
  sender: partyOf(mailSender),
  recipient: partyOf(mailRecipient),
  subject: 'Reunión del martes',
  body: 'Hola Juan,\r\n\r\nNos vemos el martes a las 10.\r\n',
};

/** Filler body for the large vectors: byte `i` is `a` + `i mod 26`. */
export function mailBodyPattern(length: number): string {
  return Buffer.alloc(length, 'abcdefghijklmnopqrstuvwxyz').toString('latin1');
}

const variableLength = (mail: OutgoingMail) =>
  mail.sender.address.length + mail.recipient.address.length + utf8(mail.subject).length;

/** Body length that makes the encoded mail exactly `total` bytes. */
const bodyLengthFor = (mail: OutgoingMail, total: number) => total - MAIL_FIXED_LENGTH - variableLength(mail);

/** Mail as JSON; a large body goes as `bodyPattern` + `bodyLength`. */
function mailJson(mail: OutgoingMail, patternBody = false) {
  const { messageId, date, sender, recipient, subject, body } = mail;
  return {
    messageId: toHex(messageId), date, sender: partyJson(sender), recipient: partyJson(recipient), subject,
    ...(patternBody ? { bodyPattern: 'a + i mod 26', bodyLength: body.length } : { body }),
  };
}

/** Fields of the payload, each already encoded (length prefix included). Used to break the rules on purpose. */
function payloadParts(mail: OutgoingMail) {
  const subject = utf8(mail.subject), body = utf8(mail.body);
  const address = (text: string) => concatBytes(uintBE(text.length, 1), utf8(text));
  return {
    magic: MAIL_MAGIC_BYTES,
    version: Uint8Array.of(MAIL_VERSION),
    messageId: mail.messageId,
    date: uintBE(mail.date, 8),
    senderAddrKey: mail.sender.addrKey,
    senderAddress: address(mail.sender.address),
    recipientAddrKey: mail.recipient.addrKey,
    recipientAddress: address(mail.recipient.address),
    subject: concatBytes(uintBE(subject.length, 2), subject),
    body: concatBytes(uintBE(body.length, 4), body),
  };
}

type PayloadParts = ReturnType<typeof payloadParts>;

const rawPayload = (change: Partial<PayloadParts>, mail = baseMail) =>
  concatBytes(...Object.values({ ...payloadParts(mail), ...change }));

const signPayload = (secretKey: Uint8Array, payload: Uint8Array, domain = MAIL_DOMAIN_BYTES) =>
  ed25519Sign(secretKey, concatBytes(domain, payload));

/** `payload ‖ signature` for a payload that may break the rules (the signature is valid). */
const signedRaw = (change: Partial<PayloadParts>, mail = baseMail) => {
  const payload = rawPayload(change, mail);
  return concatBytes(payload, signPayload(mailSender.authSecretKey, payload));
};

const mailRandomness = (label: string) => ({
  ephemeralSecretKey: seed(`mail:eph:${label}`),
  nonce: seed(`mail:nonce:${label}`).subarray(0, NONCE_LENGTH),
});

function mailValidVectors() {
  const longest = { ...baseMail, body: '' };
  const largest = { ...longest, body: mailBodyPattern(bodyLengthFor(longest, MAX_MAIL_LENGTH)) };
  const cases: [string, OutgoingMail, Uint8Array][] = [
    ['typical mail', baseMail, mailSender.authSecretKey],
    ['empty subject and body', { ...baseMail, subject: '', body: '' }, mailSender.authSecretKey],
    ['accents, emoji, tabs and mixed line breaks', {
      ...baseMail, subject: 'Reunión 📅 del martes', body: 'Línea 1\nLínea 2\n\tsangría\r\n¡Gracias! 🙂',
    }, mailSender.authSecretKey],
    ['body starting with a byte order mark (kept as is)', { ...baseMail, body: '﻿Hola' }, mailSender.authSecretKey],
    ['joiners allowed: emoji sequence with ZWJ (U+200D), Persian with ZWNJ (U+200C), a lone CR in the body', {
      ...baseMail, subject: 'Familia \u{1f468}‍\u{1f469}‍\u{1f467}', body: 'می‌خواهم\rfin',
    }, mailSender.authSecretKey],
    ['longest subject (1024 bytes: 512 × ñ)', { ...baseMail, subject: 'ñ'.repeat(MAX_SUBJECT_LENGTH / 2) }, mailSender.authSecretKey],
    ['longest addresses (64 + 1 + 190 bytes)', {
      ...baseMail, sender: partyOf(mailLongSender), recipient: partyOf(mailLongRecipient),
    }, mailLongSender.authSecretKey],
    ['date 0', { ...baseMail, date: 0 }, mailSender.authSecretKey],
    ['largest date (9999-12-31 23:59:59 UTC)', { ...baseMail, date: MAX_MAIL_DATE }, mailSender.authSecretKey],
    ['largest mail (25 MiB in total)', largest, mailSender.authSecretKey],
  ];
  return cases.map(([name, mail, authSecretKey]) => {
    const inline = mail !== largest;
    const payload = encodeMailPayload(mail);
    const signature = signPayload(authSecretKey, payload);
    const randomness = mailRandomness(name);
    const envelope = sealMailDeterministic(authSecretKey, x25519PublicKey(mailRecipient.encSecretKey), mail, randomness);
    return {
      name,
      mail: mailJson(mail, !inline),
      payloadLength: payload.length,
      payloadSha256: toHex(sha256(payload)),
      ...(inline ? { payload: toHex(payload) } : {}),
      signature: toHex(signature),
      ephemeralSecretKey: toHex(randomness.ephemeralSecretKey),
      nonce: toHex(randomness.nonce),
      envelopeLength: envelope.length,
      envelopeSha256: toHex(sha256(envelope)),
      ...(inline ? { envelope: toHex(envelope) } : {}),
    };
  });
}

const L_ED25519 = 2n ** 252n + 27742317777372353535851937790883648493n;
const littleEndian = (bytes: Uint8Array) => bytes.reduceRight((acc, byte) => (acc << 8n) | BigInt(byte), 0n);

function littleEndianBytes(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0, rest = value; i < 32; i++, rest >>= 8n) out[i] = Number(rest & 0xffn);
  return out;
}

/** The Ed25519 secret scalar `a` of a seed (RFC 8032 §5.1.5: SHA-512, low half, clamped). */
function ed25519Scalar(secretKey: Uint8Array): bigint {
  const h = Uint8Array.from(createHash('sha512').update(secretKey).digest().subarray(0, 32));
  h[0]! &= 248;
  h[31]! &= 127;
  h[31]! |= 64;
  return littleEndian(h);
}

/** k = SHA-512(R ‖ A ‖ M) mod L, with R and A as encoded (not reduced, not decoded). */
const challenge = (r: Uint8Array, publicKey: Uint8Array, message: Uint8Array) =>
  littleEndian(createHash('sha512').update(r).update(publicKey).update(message).digest()) % L_ED25519;

/**
 * Valid Ed25519 equation with R = identity: S = k·a, k = SHA-512(R ‖ A ‖ M). Only the key holder can
 * build it. With the canonical encoding (`01 00 … 00`) OpenSSL accepts it and `verify_strict` does
 * not; with another encoding of the identity (`rBytes`), a verifier that decoded R and compared
 * points would accept it.
 */
function identityRSignature(secretKey: Uint8Array, message: Uint8Array, rBytes = ED25519_IDENTITY): Uint8Array {
  const k = challenge(rBytes, ed25519PublicKey(secretKey), message);
  return concatBytes(rBytes, littleEndianBytes((k * ed25519Scalar(secretKey)) % L_ED25519));
}

// Minimal edwards25519 arithmetic (extended coordinates, a = −1), only to build the mixed-order key
// vectors: Node's crypto has no point operations. Variable time, test data only.
const P_25519 = 2n ** 255n - 19n;
type EdPoint = { x: bigint; y: bigint; z: bigint; t: bigint };
const modP = (value: bigint) => ((value % P_25519) + P_25519) % P_25519;

function powP(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  for (let b = modP(base), e = exponent; e > 0n; e >>= 1n, b = (b * b) % P_25519) {
    if (e & 1n) result = (result * b) % P_25519;
  }
  return result;
}

const invP = (value: bigint) => powP(value, P_25519 - 2n);
const ED_D = modP(-121665n * invP(121666n));
const SQRT_M1 = powP(2n, (P_25519 - 1n) / 4n);
const ED_IDENTITY_POINT: EdPoint = { x: 0n, y: 1n, z: 1n, t: 0n };

/** Unified addition (add-2008-hwcd-3), also valid for doubling. */
function edAdd(p: EdPoint, q: EdPoint): EdPoint {
  const a = modP((p.y - p.x) * (q.y - q.x)), b = modP((p.y + p.x) * (q.y + q.x));
  const c = modP(2n * ED_D * p.t * q.t), d = modP(2n * p.z * q.z);
  const e = b - a, f = d - c, g = d + c, h = b + a;
  return { x: modP(e * f), y: modP(g * h), z: modP(f * g), t: modP(e * h) };
}

function edMul(scalar: bigint, point: EdPoint): EdPoint {
  let result = ED_IDENTITY_POINT;
  for (let n = scalar, add = point; n > 0n; n >>= 1n, add = edAdd(add, add)) {
    if (n & 1n) result = edAdd(result, add);
  }
  return result;
}

function edDecode(bytes: Uint8Array): EdPoint {
  const y = littleEndian(bytes) & (2n ** 255n - 1n);
  const u = modP(y * y - 1n), v = modP(ED_D * y * y + 1n);
  let x = powP(u * invP(v), (P_25519 + 3n) / 8n);
  if (modP(v * x * x - u) !== 0n) x = modP(x * SQRT_M1);
  if (modP(v * x * x - u) !== 0n) throw new Error('not a curve point');
  if ((x & 1n) !== BigInt(bytes[31]! >> 7)) x = modP(-x);
  return { x, y, z: 1n, t: modP(x * y) };
}

function edEncode(point: EdPoint): Uint8Array {
  const zInverse = invP(point.z);
  const out = littleEndianBytes(modP(point.y * zInverse));
  out[31]! |= Number(modP(point.x * zInverse) & 1n) << 7;
  return out;
}

const ED_BASE = edDecode(fromHex(`58${'66'.repeat(31)}`));
// A point of order 8 (it is in the low-order list of README §2.1).
const ED_TORSION_8 = edDecode(fromHex('c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a'));

/**
 * A key with a small-order component: A = a·B + T, T of order 8. It is not of low order, so it is
 * usable, and its holder signs as usual (R = r·B, S = r + k·a). The check S·B − k·A = R − k·T then
 * holds without the cofactor only when 8 divides k: OpenSSL and `verify_strict` (both without the
 * cofactor) agree on every signature, while a verifier with the cofactor would accept them all.
 */
const mixedOrderSecretKey = seed('mail:mixed-order:auth');
const mixedOrderSender = {
  addrKey: seed('mail:mixed-order:addr-key'),
  address: 'mixta@nightmail.local',
  authPublicKey: edEncode(edAdd(edMul(ed25519Scalar(mixedOrderSecretKey), ED_BASE), ED_TORSION_8)),
};

function checkEdwardsArithmetic() {
  const same = (a: Uint8Array, b: Uint8Array) => toHex(a) === toHex(b);
  if (!same(edEncode(edMul(ed25519Scalar(mixedOrderSecretKey), ED_BASE)), ed25519PublicKey(mixedOrderSecretKey))) {
    throw new Error('edwards25519 arithmetic does not match the Ed25519 public key');
  }
  const identity = edEncode(ED_IDENTITY_POINT);
  if (!same(edEncode(edMul(8n, ED_TORSION_8)), identity) || same(edEncode(edMul(4n, ED_TORSION_8)), identity)) {
    throw new Error('the torsion point is not of order 8');
  }
}

/** A signature by the mixed-order key holder whose k is (or is not) a multiple of 8. */
function mixedOrderSignature(payload: Uint8Array, multipleOf8: boolean): Uint8Array {
  checkEdwardsArithmetic();
  const message = concatBytes(MAIL_DOMAIN_BYTES, payload);
  for (let i = 0; ; i++) {
    const r = littleEndian(createHash('sha512').update(`mail:mixed-order:r:${i}`).digest()) % L_ED25519;
    const rBytes = edEncode(edMul(r, ED_BASE));
    const k = challenge(rBytes, mixedOrderSender.authPublicKey, message);
    if ((k % 8n === 0n) !== multipleOf8) continue;
    const signature = concatBytes(rBytes, littleEndianBytes((r + k * ed25519Scalar(mixedOrderSecretKey)) % L_ED25519));
    const accepted = verify(null, message, publicKeyObject('ed25519', mixedOrderSender.authPublicKey), signature);
    if (accepted !== multipleOf8) throw new Error('the plain verifier does not give the expected verdict');
    return signature;
  }
}

/** The vector only proves something if a plain Ed25519 verifier (OpenSSL) accepts the signature. */
function acceptedByPlainVerifier(publicKey: Uint8Array, payload: Uint8Array, signature: Uint8Array): Uint8Array {
  if (!verify(null, concatBytes(MAIL_DOMAIN_BYTES, payload), publicKeyObject('ed25519', publicKey), signature)) {
    throw new Error('the plain verifier rejects this vector: it would test nothing');
  }
  return signature;
}

function mailUnverifiedVectors() {
  const payload = encodeMailPayload(baseMail);
  const signature = signPayload(mailSender.authSecretKey, payload);
  const altered = (offset: number) => {
    const copy = concatBytes(payload, signature);
    copy[offset]! ^= 0x01;
    return copy;
  };
  const subjectOffset = Object.values(payloadParts(baseMail)).slice(0, 8).reduce((n, part) => n + part.length, 0) + 2;
  const signedAs = (mail: OutgoingMail, secretKey = mailSender.authSecretKey) => signMail(secretKey, mail);
  const withSignature = (sig: Uint8Array, mail = baseMail) => concatBytes(encodeMailPayload(mail), sig);
  const lowOrderMail = { ...baseMail, sender: partyOf(lowOrderSender) };
  const lowOrderPayload = encodeMailPayload(lowOrderMail);
  // The sender's own addrKey and alias, signed with its own key, but `@` another domain.
  const foreignDomainSender = { ...partyOf(mailSender), address: mailSender.address.replace(/@.*$/, '@otro.example') };
  const cases: [string, Uint8Array, OutgoingMail][] = [
    ['signature altered (R)', altered(payload.length), baseMail],
    ['signature altered (S)', altered(payload.length + SIGNATURE_LENGTH / 2), baseMail],
    ['subject altered after signing (R → S)', altered(subjectOffset), { ...baseMail, subject: 'Seunión del martes' }],
    ['signed for another recipient (addrKey and address)', signedAs({ ...baseMail, recipient: partyOf(mailOther) }),
      { ...baseMail, recipient: partyOf(mailOther) }],
    ['signed for another addrKey with this address text',
      signedAs({ ...baseMail, recipient: { ...partyOf(mailRecipient), addrKey: mailOther.addrKey } }),
      { ...baseMail, recipient: { ...partyOf(mailRecipient), addrKey: mailOther.addrKey } }],
    ['signed for this addrKey with another address text',
      signedAs({ ...baseMail, recipient: { ...partyOf(mailRecipient), address: mailOther.address } }),
      { ...baseMail, recipient: { ...partyOf(mailRecipient), address: mailOther.address } }],
    ['forged sender: claims another registered address, signed with the real sender key',
      signedAs({ ...baseMail, sender: partyOf(mailOther) }), { ...baseMail, sender: partyOf(mailOther) }],
    ['sender not in the directory', signedAs({ ...baseMail, sender: { addrKey: seed('mail:unknown'), address: 'nadie@nightmail.local' } }),
      { ...baseMail, sender: { addrKey: seed('mail:unknown'), address: 'nadie@nightmail.local' } }],
    ['sender addrKey with the address text of another one',
      signedAs({ ...baseMail, sender: { ...partyOf(mailSender), address: mailOther.address } }),
      { ...baseMail, sender: { ...partyOf(mailSender), address: mailOther.address } }],
    ['sender addrKey and alias text, in another domain (the local part alone is not the address)',
      signedAs({ ...baseMail, sender: foreignDomainSender }), { ...baseMail, sender: foreignDomainSender }],
    ['signed with another key', signedAs(baseMail, mailOther.authSecretKey), baseMail],
    ['signed under the request domain (nightmail:mailbox-api:v1)',
      withSignature(signPayload(mailSender.authSecretKey, payload, utf8(REQUEST_AUTH_DOMAIN))), baseMail],
    ['signed without a domain', withSignature(ed25519Sign(mailSender.authSecretKey, payload)), baseMail],
    ['non-canonical S (S + L)', withSignature(nonCanonicalS(signature)), baseMail],
    ['R = identity, built by the key holder (a plain verifier accepts it)', withSignature(acceptedByPlainVerifier(
      ed25519PublicKey(mailSender.authSecretKey), payload,
      identityRSignature(mailSender.authSecretKey, concatBytes(MAIL_DOMAIN_BYTES, payload)),
    )), baseMail],
    ['R = identity encoded with y = p + 1 (non-canonical), built by the key holder', withSignature(identityRSignature(
      mailSender.authSecretKey, concatBytes(MAIL_DOMAIN_BYTES, payload), fromHex(`ee${'ff'.repeat(30)}7f`),
    )), baseMail],
    ['R = identity with the sign bit set, built by the key holder', withSignature(identityRSignature(
      mailSender.authSecretKey, concatBytes(MAIL_DOMAIN_BYTES, payload), fromHex(`01${'00'.repeat(30)}80`),
    )), baseMail],
    ['low-order sender key with the trivial signature (a plain verifier accepts it)', withSignature(
      acceptedByPlainVerifier(lowOrderSender.authPublicKey, lowOrderPayload, TRIVIAL_SIGNATURE), lowOrderMail,
    ), lowOrderMail],
  ];
  return cases.map(([name, plaintext, mail]) => ({ name, plaintext: toHex(plaintext), mail: mailJson(mail) }));
}

/** Mail from the mixed-order key (`mixedOrderSender`): the verdict depends on k, the same on both sides. */
function mailMixedOrderVectors() {
  const mail = { ...baseMail, sender: partyOf(mixedOrderSender) };
  const payload = encodeMailPayload(mail);
  const cases: [string, boolean][] = [
    ['k multiple of 8: verifies without the cofactor', true],
    ['k not a multiple of 8: only a verifier with the cofactor would accept it', false],
  ];
  return cases.map(([name, senderVerified]) => ({
    name,
    plaintext: toHex(concatBytes(payload, mixedOrderSignature(payload, senderVerified))),
    mail: mailJson(mail),
    senderVerified,
  }));
}

function mailOpenFailureVectors() {
  const good = signMail(mailSender.authSecretKey, baseMail);
  const body = (bytes: Uint8Array) => concatBytes(uintBE(bytes.length, 4), bytes);
  const subject = (bytes: Uint8Array) => concatBytes(uintBE(bytes.length, 2), bytes);
  const address = (text: string) => concatBytes(uintBE(utf8(text).length, 1), utf8(text));
  const otherMagic = Uint8Array.from(MAIL_MAGIC_BYTES);
  otherMagic[0] = 0x4e;
  const cases: [string, Uint8Array][] = [
    ['empty', new Uint8Array(0)],
    ['magic only', MAIL_MAGIC_BYTES],
    ['another magic (N instead of n), signed', signedRaw({ magic: otherMagic })],
    ['unknown version 0x02, signed', signedRaw({ version: Uint8Array.of(0x02) })],
    ['version 0x00, signed', signedRaw({ version: Uint8Array.of(0x00) })],
    ['last byte missing', good.subarray(0, good.length - 1)],
    ['signature missing', good.subarray(0, good.length - SIGNATURE_LENGTH)],
    ['cut in the middle of the body', good.subarray(0, good.length - SIGNATURE_LENGTH - 10)],
    ['extra byte at the end', concatBytes(good, new Uint8Array(1))],
    ['body length one past the end', concatBytes(rawPayload({
      body: concatBytes(uintBE(utf8(baseMail.body).length + 1, 4), utf8(baseMail.body)),
    }), signPayload(mailSender.authSecretKey, rawPayload({})))],
    ['empty sender address, signed', signedRaw({ senderAddress: Uint8Array.of(0) })],
    ['sender address with uppercase, signed', signedRaw({ senderAddress: address('Nube.verde.k7m2q9xa4b3c@nightmail.local') })],
    ['sender address with a non-ASCII character, signed', signedRaw({ senderAddress: address('ñu@nightmail.local') })],
    ['sender address with two @, signed', signedRaw({ senderAddress: address('a@b@nightmail.local') })],
    ['recipient address without @, signed', signedRaw({ recipientAddress: address('juan.nightmail.local') })],
    ['subject of 1025 bytes, signed', signedRaw({ subject: subject(new Uint8Array(1025).fill(0x61)) })],
    ['subject with a line break, signed', signedRaw({ subject: subject(utf8('Hola\r\nBcc: x')) })],
    ['subject with DEL, signed', signedRaw({ subject: subject(utf8('Hola\x7f')) })],
    ['invalid UTF-8 in the subject, signed', signedRaw({ subject: subject(Uint8Array.of(0x48, 0xff)) })],
    ['body with a cut UTF-8 sequence, signed', signedRaw({ body: body(concatBytes(utf8('hola'), Uint8Array.of(0xc3))) })],
    ['body with an overlong UTF-8 encoding, signed', signedRaw({ body: body(Uint8Array.of(0xc0, 0xaf)) })],
    ['body with a UTF-8 encoded surrogate, signed', signedRaw({ body: body(Uint8Array.of(0xed, 0xa0, 0x80)) })],
    ['body with NUL, signed', signedRaw({ body: body(utf8('ho\0la')) })],
    ['subject with a right-to-left override (U+202E), signed', signedRaw({ subject: subject(utf8('factura ‮fdp.exe')) })],
    ['subject with a C1 control (U+0085), signed', signedRaw({ subject: subject(utf8('Hola\u0085Bcc: x')) })],
    ['subject starting with a byte order mark, signed', signedRaw({ subject: subject(utf8('﻿Hola')) })],
    ['body with ESC, signed', signedRaw({ body: body(utf8('hola \x1b[2Jadios')) })],
    ['body with DEL, signed', signedRaw({ body: body(utf8('hola\x7f')) })],
    ['body with a right-to-left isolate (U+2067), signed', signedRaw({ body: body(utf8('hola ⁧abc⁩')) })],
    ['body with a zero width space (U+200B), signed', signedRaw({ body: body(utf8('ho​la')) })],
    ['body with a byte order mark after the first character, signed', signedRaw({ body: body(utf8('h﻿ola')) })],
    ['date one second after 9999-12-31 23:59:59 UTC, signed', signedRaw({ date: uintBE(MAX_MAIL_DATE + 1, 8) })],
    ['date 2^53, signed', signedRaw({ date: concatBytes(uintBE(2 ** 21, 4), uintBE(0, 4)) })],
    ['date 2^64 − 1, signed', signedRaw({ date: new Uint8Array(8).fill(0xff) })],
  ];
  if (cases.some(([, plaintext]) => toHex(plaintext) === toHex(good))) throw new Error('a failure case is the valid mail');
  return cases.map(([name, plaintext]) => ({ name, plaintext: toHex(plaintext) }));
}

/** A well-formed, signed mail one byte over the maximum; stored as a recipe (`bodyPattern`) and its hash. */
function mailOversizedVector() {
  const mail = { ...baseMail, body: mailBodyPattern(bodyLengthFor(baseMail, MAX_MAIL_LENGTH + 1)) };
  const plaintext = signedRaw({}, mail);
  return {
    name: 'well formed and signed, but one byte over the maximum',
    mail: mailJson(mail, true),
    plaintextLength: plaintext.length,
    plaintextSha256: toHex(sha256(plaintext)),
  };
}

function mailEncodeFailureVectors() {
  const sender = (address: string) => ({ sender: { ...partyOf(mailSender), address } });
  const recipient = (address: string) => ({ recipient: { ...partyOf(mailRecipient), address } });
  const cases: [string, keyof OutgoingMail, Partial<OutgoingMail>][] = [
    ['15-byte messageId', 'messageId', { messageId: baseMail.messageId.subarray(0, 15) }],
    ['17-byte messageId', 'messageId', { messageId: concatBytes(baseMail.messageId, new Uint8Array(1)) }],
    ['date one second after 9999-12-31 23:59:59 UTC', 'date', { date: MAX_MAIL_DATE + 1 }],
    ['date 2^53', 'date', { date: 2 ** 53 }],
    ['negative date', 'date', { date: -1 }],
    ['date with decimals', 'date', { date: 1794873600.5 }],
    ['sender address with uppercase', 'sender', sender('Nube.verde.k7m2q9xa4b3c@nightmail.local')],
    ['sender address without @', 'sender', sender('nube.verde.k7m2q9xa4b3c')],
    ['sender address with two @', 'sender', sender('a@b@nightmail.local')],
    ['empty local part', 'sender', sender('@nightmail.local')],
    ['empty domain', 'sender', sender('juan@')],
    ['65-byte local part', 'sender', sender(`${'a'.repeat(65)}@nightmail.local`)],
    ['191-byte domain', 'sender', sender(`juan@${'b'.repeat(191)}`)],
    ['sender address with a space', 'sender', sender('juan perez@nightmail.local')],
    ['sender address with a non-ASCII character', 'sender', sender('ñu@nightmail.local')],
    ['sender address with a plus sign', 'sender', sender('juan+x@nightmail.local')],
    ['31-byte sender addrKey', 'sender', { sender: { ...partyOf(mailSender), addrKey: mailSender.addrKey.subarray(0, 31) } }],
    ['recipient address with uppercase', 'recipient', recipient('Juan@nightmail.local')],
    ['empty recipient address', 'recipient', recipient('')],
    ['33-byte recipient addrKey', 'recipient', { recipient: { ...partyOf(mailRecipient), addrKey: concatBytes(mailRecipient.addrKey, new Uint8Array(1)) } }],
    ['subject of 1025 bytes', 'subject', { subject: 'a'.repeat(MAX_SUBJECT_LENGTH + 1) }],
    ['subject of 1025 bytes (ñ × 512 + a)', 'subject', { subject: `${'ñ'.repeat(512)}a` }],
    ['subject with LF', 'subject', { subject: 'Hola\nBcc: x' }],
    ['subject with CR', 'subject', { subject: 'Hola\r' }],
    ['subject with a tab', 'subject', { subject: 'Ho\tla' }],
    ['subject with NUL', 'subject', { subject: 'Ho\0la' }],
    ['subject with DEL', 'subject', { subject: 'Hola\x7f' }],
    ['subject with a C1 control (U+0085, next line)', 'subject', { subject: 'Hola\u0085Bcc: x' }],
    ['subject with a C1 control (U+009F)', 'subject', { subject: 'Hola\u009f' }],
    ['subject with a line separator (U+2028)', 'subject', { subject: 'Hola Bcc: x' }],
    ['subject with a paragraph separator (U+2029)', 'subject', { subject: 'Hola ' }],
    ['subject with a right-to-left override (U+202E)', 'subject', { subject: 'factura ‮fdp.exe' }],
    ['subject with a left-to-right embedding (U+202A)', 'subject', { subject: '‪Hola' }],
    ['subject with a left-to-right isolate (U+2066)', 'subject', { subject: 'Hola ⁦abc' }],
    ['subject with a right-to-left mark (U+200F)', 'subject', { subject: 'Hola‏' }],
    ['subject with an Arabic letter mark (U+061C)', 'subject', { subject: 'Hola؜' }],
    ['subject with a zero width space (U+200B)', 'subject', { subject: 'Ho​la' }],
    ['subject with a word joiner (U+2060)', 'subject', { subject: 'Ho⁠la' }],
    ['subject with an invisible separator (U+2063)', 'subject', { subject: 'Ho⁣la' }],
    ['subject starting with a byte order mark', 'subject', { subject: '﻿Hola' }],
    ['body with NUL', 'body', { body: 'ho\0la' }],
    ['body with ESC', 'body', { body: 'hola \x1b[2Jadios' }],
    ['body with BEL', 'body', { body: 'hola\x07' }],
    ['body with a vertical tab', 'body', { body: 'ho\x0bla' }],
    ['body with a form feed', 'body', { body: 'ho\x0cla' }],
    ['body with DEL', 'body', { body: 'hola\x7f' }],
    ['body with a C1 control (U+0080)', 'body', { body: 'hola\u0080' }],
    ['body with a C1 control (U+009B, CSI)', 'body', { body: 'hola\u009b2J' }],
    ['body with a right-to-left embedding (U+202B)', 'body', { body: 'hola ‫abc' }],
    ['body with a pop directional formatting (U+202C)', 'body', { body: 'hola‬' }],
    ['body with a pop directional isolate (U+2069)', 'body', { body: 'hola⁩' }],
    ['body with a left-to-right mark (U+200E)', 'body', { body: 'hola‎' }],
    ['body with a zero width space (U+200B)', 'body', { body: 'ho​la' }],
    ['body with a byte order mark after the first character', 'body', { body: 'h﻿ola' }],
    ['body starting with two byte order marks', 'body', { body: '﻿﻿hola' }],
  ];
  const tooLarge = { ...baseMail, body: mailBodyPattern(bodyLengthFor(baseMail, MAX_MAIL_LENGTH + 1)) };
  return [
    ...cases.map(([name, field, change]) => ({ name, field, mail: mailJson({ ...baseMail, ...change }) })),
    { name: 'body one byte over the maximum mail length', field: 'body', mail: mailJson(tooLarge, true) },
  ];
}

export function computeMailVectors() {
  const parts = payloadParts(baseMail);
  const directoryEntry = (entry: { addrKey: Uint8Array; address: string }, authPublicKey: Uint8Array) =>
    ({ ...partyJson(entry), authPublicKey: toHex(authPublicKey) });
  return {
    note: 'NightMail end-to-end mail (nightmail:e2e v1). Generated by packages/core-ts (npm run vectors); the '
      + 'specification is in README.md §4. Lowercase hex without 0x. The Rust core must reproduce payload, '
      + 'signature and envelope of every `valid` entry, open and verify them, return senderVerified = false for '
      + '`unverified` and the stored senderVerified for `mixedOrderKey`, reject `openFailures` and '
      + '`openFailureOversized`, and refuse to build `encodeFailures`.',
    constants: {
      magic: MAIL_MAGIC,
      version: MAIL_VERSION,
      signatureDomain: MAIL_SIGNATURE_DOMAIN,
      messageIdLength: MESSAGE_ID_LENGTH,
      addrKeyLength: ADDR_KEY_LENGTH,
      signatureLength: SIGNATURE_LENGTH,
      maxSubjectLength: MAX_SUBJECT_LENGTH,
      maxMailLength: MAX_MAIL_LENGTH,
      fixedLength: MAIL_FIXED_LENGTH,
      maxDate: MAX_MAIL_DATE,
      // Code points refused in the subject and the body (README §4.2), as inclusive [first, last] ranges. Both
      // implementations are checked against this list for every code point.
      deceptiveCharacters: [
        [0x80, 0x9f], [0x61c, 0x61c], [0x200b, 0x200b], [0x200e, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f],
        [0xfeff, 0xfeff],
      ],
    },
    sender: { authSecretKey: toHex(mailSender.authSecretKey), authPublicKey: toHex(ed25519PublicKey(mailSender.authSecretKey)), ...partyJson(mailSender) },
    recipient: {
      encSecretKey: toHex(mailRecipient.encSecretKey), encPublicKey: toHex(x25519PublicKey(mailRecipient.encSecretKey)), ...partyJson(mailRecipient),
    },
    directory: [
      directoryEntry(mailSender, ed25519PublicKey(mailSender.authSecretKey)),
      directoryEntry(mailOther, ed25519PublicKey(mailOther.authSecretKey)),
      directoryEntry(mailLongSender, ed25519PublicKey(mailLongSender.authSecretKey)),
      directoryEntry(lowOrderSender, lowOrderSender.authPublicKey),
      directoryEntry(mixedOrderSender, mixedOrderSender.authPublicKey),
    ],
    encodingExample: Object.fromEntries(Object.entries(parts).map(([field, bytes]) => [field, toHex(bytes)])),
    valid: mailValidVectors(),
    unverified: mailUnverifiedVectors(),
    mixedOrderKey: mailMixedOrderVectors(),
    openFailures: mailOpenFailureVectors(),
    openFailureOversized: mailOversizedVector(),
    encodeFailures: mailEncodeFailureVectors(),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(fileURLToPath(VECTORS_DIR), { recursive: true });
  const files: [string, object][] = [
    [MAILBOX_VECTORS_FILE, computeMailboxVectors()],
    [REQUEST_AUTH_VECTORS_FILE, computeRequestAuthVectors()],
    [MAIL_VECTORS_FILE, computeMailVectors()],
  ];
  for (const [file, vectors] of files) {
    writeFileSync(file, `${JSON.stringify(vectors, null, 2)}\n`);
    console.log(`wrote ${file}`);
  }
}
