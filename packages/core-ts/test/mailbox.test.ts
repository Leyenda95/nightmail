import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createPrivateKey, createPublicKey, diffieHellman, hkdfSync } from 'node:crypto';
import {
  ENVELOPE_HEADER_LENGTH, ENVELOPE_SUITE, ENVELOPE_VERSION, MAILBOX_DOMAIN, MAX_ENVELOPE_LENGTH, MailboxCryptoError,
  bucketOfEnvelope, deriveMailboxKey, envelopeLengthFor, isUsableMailboxPublicKey, openMailbox, requireContributory,
  sealMailbox, sealMailboxDeterministic, sealPadded,
} from '../src/mailbox.ts';
import { MAX_BUCKET, MAX_PLAINTEXT_LENGTH } from '../src/padding.ts';
import { x25519PublicKey } from '../src/keys.ts';
import { concatBytes, fromHex, toHex } from '../src/bytes.ts';
import { X25519_LOW_ORDER, X25519_NON_CANONICAL, sealWithHeader, x25519 } from './fixtures.ts';

const recipientSk = fromHex('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb');
const recipientPk = x25519PublicKey(recipientSk);
const ephemeralSecretKey = fromHex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
const nonce = fromHex('a0a1a2a3a4a5a6a7a8a9aaab');
const randomness = { ephemeralSecretKey, nonce };
const text = (s: string) => new TextEncoder().encode(s);

/** Small envelope (padding size not in the table) for failure cases; the reader does not require a bucket. */
const smallEnvelope = () => sealPadded(recipientPk, fromHex('00000004686f6c610000000000000000'), randomness);

const INVALID = { name: 'MailboxCryptoError', code: 'invalid-envelope', message: 'invalid envelope' };

/** Reference implementation using only `node:crypto`, independent of the code under test. */
function referenceSeal(recipient: Uint8Array, plaintext: Uint8Array, ephSk: Uint8Array, iv: Uint8Array): string {
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), ephSk]);
  const spki = Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), recipient]);
  const privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const ephPk = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  const shared = diffieHellman({ privateKey, publicKey: createPublicKey({ key: spki, format: 'der', type: 'spki' }) });
  const info = Buffer.concat([Buffer.from('nightmail:mailbox:v1', 'ascii'), ephPk, recipient]);
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), info, 32));
  let bucket = 4096;
  while (bucket < plaintext.length + 4) bucket *= 2;
  const padded = Buffer.alloc(bucket);
  padded.writeUInt32BE(plaintext.length, 0);
  padded.set(plaintext, 4);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from([0x01, 0x01]));
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final()]);
  return Buffer.concat([Buffer.from([0x01, 0x01]), ephPk, iv, cipher.getAuthTag(), ciphertext]).toString('hex');
}

test('envelope constants', () => {
  assert.equal(MAILBOX_DOMAIN, 'nightmail:mailbox:v1');
  assert.equal(ENVELOPE_VERSION, 1);
  assert.equal(ENVELOPE_SUITE, 1);
  assert.equal(ENVELOPE_HEADER_LENGTH, 62);
  assert.equal(MAX_ENVELOPE_LENGTH, 62 + 33554432);
});

test('deterministic sealing matches the reference implementation', () => {
  for (const plaintext of [text(''), text('Hola, NightMail'), new Uint8Array(4092).fill(7), new Uint8Array(4093).fill(9)]) {
    assert.equal(
      toHex(sealMailboxDeterministic(recipientPk, plaintext, randomness)),
      referenceSeal(recipientPk, plaintext, ephemeralSecretKey, nonce),
      `length ${plaintext.length}`,
    );
  }
});

test('envelope format: version, suite, ephemeral key, nonce, tag and bucket-sized ciphertext', () => {
  const envelope = sealMailboxDeterministic(recipientPk, text('hola'), randomness);
  assert.ok(!Buffer.isBuffer(envelope));
  assert.equal(envelope.length, 62 + 4096);
  assert.equal(envelope[0], 0x01);
  assert.equal(envelope[1], 0x01);
  assert.equal(toHex(envelope.subarray(2, 34)), toHex(x25519PublicKey(ephemeralSecretKey)));
  assert.equal(toHex(envelope.subarray(34, 46)), toHex(nonce));
});

test('deriveMailboxKey: HKDF-SHA256 with empty salt and info = domain ‖ ephemeral key ‖ recipient key', () => {
  const shared = fromHex('4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742');
  const ephPk = x25519PublicKey(ephemeralSecretKey);
  const info = concatBytes(text('nightmail:mailbox:v1'), ephPk, recipientPk);
  const expected = toHex(new Uint8Array(hkdfSync('sha256', shared, new Uint8Array(0), info, 32)));
  assert.equal(toHex(deriveMailboxKey(shared, ephPk, recipientPk)), expected);
  // Both the key order and each key matter.
  assert.notEqual(toHex(deriveMailboxKey(shared, recipientPk, ephPk)), expected);
  assert.notEqual(toHex(deriveMailboxKey(shared, ephPk, ephPk)), expected);
  assert.equal(deriveMailboxKey(shared, ephPk, recipientPk).length, 32);
});

test('seal and open: round trip at several sizes', () => {
  for (const length of [0, 1, 15, 4091, 4092, 4093, 8188, 8189, 100_000]) {
    const plaintext = new Uint8Array(length).map((_, i) => (i * 31 + 5) % 256);
    const envelope = sealMailbox(recipientPk, plaintext);
    assert.equal(envelope.length, envelopeLengthFor(length), `length ${length}`);
    assert.equal(toHex(openMailbox(recipientSk, envelope)), toHex(plaintext), `length ${length}`);
  }
});

test('open returns its own Uint8Array, not a view of the decrypted padding', () => {
  const opened = openMailbox(recipientSk, sealMailbox(recipientPk, text('hola')));
  assert.ok(!Buffer.isBuffer(opened));
  assert.equal(opened.byteOffset, 0);
  assert.equal(opened.buffer.byteLength, 4);
});

test('sealMailbox uses a new ephemeral key and nonce on every call', () => {
  const a = sealMailbox(recipientPk, text('hola')), b = sealMailbox(recipientPk, text('hola'));
  assert.notEqual(toHex(a.subarray(2, 34)), toHex(b.subarray(2, 34)), 'ephemeral key');
  assert.notEqual(toHex(a.subarray(34, 46)), toHex(b.subarray(34, 46)), 'nonce');
  assert.notEqual(toHex(a.subarray(62, 94)), toHex(b.subarray(62, 94)), 'ciphertext');
  assert.equal(a.length, b.length);
});

test('the envelope reveals neither the message nor its exact length', () => {
  const short = sealMailboxDeterministic(recipientPk, text('a'), randomness);
  const long = sealMailboxDeterministic(recipientPk, new Uint8Array(4000).fill(0x61), randomness);
  assert.equal(short.length, long.length);
  assert.ok(!toHex(long).includes('61616161'));
});

test('sealing does not modify the input message or keys', () => {
  const plaintext = text('no me toques'), pk = Uint8Array.from(recipientPk), eph = Uint8Array.from(ephemeralSecretKey);
  sealMailboxDeterministic(pk, plaintext, { ephemeralSecretKey: eph, nonce });
  assert.equal(new TextDecoder().decode(plaintext), 'no me toques');
  assert.equal(toHex(pk), toHex(recipientPk));
  assert.equal(toHex(eph), toHex(ephemeralSecretKey));
});

test('bucketed sizes: envelopeLengthFor and bucketOfEnvelope', () => {
  assert.equal(envelopeLengthFor(0), 62 + 4096);
  assert.equal(envelopeLengthFor(4092), 62 + 4096);
  assert.equal(envelopeLengthFor(4093), 62 + 8192);
  assert.equal(envelopeLengthFor(MAX_PLAINTEXT_LENGTH), 62 + 33554432);
  assert.throws(() => envelopeLengthFor(MAX_PLAINTEXT_LENGTH + 1), RangeError);
  assert.equal(bucketOfEnvelope(sealMailbox(recipientPk, text('hola')).length), 4096);
  assert.equal(bucketOfEnvelope(62 + 8192), 8192);
  assert.equal(bucketOfEnvelope(62 + 33554432), 33554432);
  for (const bad of [0, 61, 62, 62 + 4095, 62 + 4097, 4096, 62 + 2 * 33554432, 1.5, Number.NaN]) {
    assert.throws(() => bucketOfEnvelope(bad), RangeError, String(bad));
  }
});

test('open accepts padding outside the table and with non-zero bytes (the reader ignores them)', () => {
  assert.equal(new TextDecoder().decode(openMailbox(recipientSk, smallEnvelope())), 'hola');
  const dirty = sealPadded(recipientPk, fromHex('00000002686fffff'), randomness);
  assert.equal(new TextDecoder().decode(openMailbox(recipientSk, dirty)), 'ho');
});

test('sealPadded wipes the padding it receives (a copy of the plaintext), also on failure', () => {
  const padded = fromHex('00000004686f6c61');
  sealPadded(recipientPk, padded, randomness);
  assert.equal(toHex(padded), '0000000000000000');
  const again = fromHex('00000004686f6c61');
  assert.throws(() => sealPadded(fromHex(X25519_LOW_ORDER[0]!), again, randomness));
  assert.equal(toHex(again), '0000000000000000');
});

test('open fails with the same error on any change to the envelope', () => {
  const good = smallEnvelope();
  const flip = (offset: number) => { const e = Uint8Array.from(good); e[offset]! ^= 0x01; return e; };
  const set = (offset: number, value: number) => { const e = Uint8Array.from(good); e[offset] = value; return e; };
  const cases: Record<string, Uint8Array> = {
    'unknown version': set(0, 0x02),
    'version zero': set(0, 0x00),
    'unknown suite': set(1, 0x02),
    'suite zero': set(1, 0x00),
    'ephemeral key altered (first byte)': flip(2),
    'ephemeral key altered (last byte)': flip(33),
    'ephemeral key with bit 255 flipped': set(33, good[33]! ^ 0x80),
    'nonce altered (first byte)': flip(34),
    'nonce altered (last byte)': flip(45),
    'tag altered (first byte)': flip(46),
    'tag altered (last byte)': flip(61),
    'ciphertext altered (first byte)': flip(62),
    'ciphertext altered (last byte)': flip(good.length - 1),
    'extra byte at the end': concatBytes(good, new Uint8Array(1)),
    'last byte missing': good.subarray(0, good.length - 1),
    'header only': good.subarray(0, 62),
    'incomplete header': good.subarray(0, 61),
    'empty': new Uint8Array(0),
  };
  for (const [name, envelope] of Object.entries(cases)) {
    assert.throws(() => openMailbox(recipientSk, envelope), INVALID, name);
  }
});

test('open rejects an unknown version or suite even if the tag is valid for that header', () => {
  const padded = () => fromHex('00000004686f6c610000000000000000');
  // The test envelope builder is faithful: with the correct header it produces the same envelope as the code.
  assert.equal(toHex(sealWithHeader(Uint8Array.of(1, 1), recipientPk, padded(), randomness)), toHex(smallEnvelope()));
  for (const header of [[2, 1], [0, 1], [1, 2], [1, 0], [2, 2], [0, 0]]) {
    const envelope = sealWithHeader(Uint8Array.from(header), recipientPk, padded(), randomness);
    assert.throws(() => openMailbox(recipientSk, envelope), INVALID, `header ${header}`);
  }
});

test('open fails with another recipient key', () => {
  const other = fromHex('0101010101010101010101010101010101010101010101010101010101010101');
  assert.throws(() => openMailbox(other, smallEnvelope()), INVALID);
});

test('opening with a secret key of the wrong length is a usage error (invalid-key), not an envelope error', () => {
  const invalidKey = { name: 'MailboxCryptoError', code: 'invalid-key', message: 'invalid key' };
  assert.throws(() => openMailbox(recipientSk.subarray(0, 31), smallEnvelope()), invalidKey);
  assert.throws(() => openMailbox(new Uint8Array(0), smallEnvelope()), invalidKey);
  assert.throws(() => openMailbox(new Uint8Array(33), new Uint8Array(0)), invalidKey);
});

test('an ephemeral key with bit 255 flipped gives the same shared secret, but the envelope does not open', () => {
  const good = smallEnvelope();
  const flipped = Uint8Array.from(good);
  flipped[33]! ^= 0x80;
  assert.equal(toHex(x25519(recipientSk, flipped.subarray(2, 34))), toHex(x25519(recipientSk, good.subarray(2, 34))));
  assert.throws(() => openMailbox(recipientSk, flipped), INVALID);
});

test('open rejects an envelope larger than the maximum even if valid, and accepts the maximum', () => {
  const oversized = sealPadded(recipientPk, new Uint8Array(MAX_BUCKET + 1), randomness);
  assert.equal(oversized.length, MAX_ENVELOPE_LENGTH + 1);
  assert.throws(() => openMailbox(recipientSk, oversized), INVALID);
  const largest = sealPadded(recipientPk, new Uint8Array(MAX_BUCKET), randomness);
  assert.equal(largest.length, MAX_ENVELOPE_LENGTH);
  assert.equal(openMailbox(recipientSk, largest).length, 0);
});

test('isUsableMailboxPublicKey: 32 bytes, canonical and not low order', () => {
  assert.equal(isUsableMailboxPublicKey(recipientPk), true);
  for (let i = 0; i < 20; i++) assert.equal(isUsableMailboxPublicKey(x25519PublicKey(fromHex(`${(i + 16).toString(16)}`.repeat(32)))), true);
  for (const point of X25519_LOW_ORDER) assert.equal(isUsableMailboxPublicKey(fromHex(point)), false, point);
  for (const key of X25519_NON_CANONICAL) assert.equal(isUsableMailboxPublicKey(fromHex(key)), false, key);
  for (const length of [0, 31, 33]) assert.equal(isUsableMailboxPublicKey(new Uint8Array(length).fill(9)), false, `length ${length}`);
  const notBytes = [toHex(recipientPk), [...recipientPk], null, undefined];
  for (const value of notBytes) assert.equal(isUsableMailboxPublicKey(value as never), false);
});

test('seal rejects a non-canonical recipient key: its owner could not open the envelope', () => {
  const invalidKey = { name: 'MailboxCryptoError', code: 'invalid-key', message: 'invalid key' };
  for (const key of X25519_NON_CANONICAL) {
    // The X25519 exchange itself works (not low order); only the explicit check stops it.
    assert.notEqual(toHex(x25519(ephemeralSecretKey, fromHex(key))), '00'.repeat(32), key);
    assert.throws(() => sealMailbox(fromHex(key), text('hola')), invalidKey, key);
  }
  // The same key with bit 255 set: without the rejection it would seal with an `info` different from the recipient's.
  const withHighBit = Uint8Array.from(recipientPk);
  withHighBit[31]! |= 0x80;
  assert.throws(() => sealMailboxDeterministic(withHighBit, text('hola'), randomness), invalidKey);
});

test('seal requires a Uint8Array as message and as key', () => {
  const notBytes = ['hola', [104, 111, 108, 97], { length: 4 }, 4];
  for (const value of notBytes) {
    assert.throws(() => sealMailbox(recipientPk, value as never), { name: 'TypeError', message: 'the message must be a Uint8Array' });
  }
  assert.throws(() => sealMailbox(recipientPk, null as never), TypeError);
  for (const key of [toHex(recipientPk), [...recipientPk]]) {
    assert.throws(() => sealMailbox(key as never, text('hola')), { name: 'MailboxCryptoError', code: 'invalid-key' });
  }
  // A Buffer is a Uint8Array.
  assert.equal(new TextDecoder().decode(openMailbox(recipientSk, sealMailbox(recipientPk, Buffer.from('hola')))), 'hola');
});

test('open rejects a low-order ephemeral key', () => {
  const good = smallEnvelope();
  for (const point of X25519_LOW_ORDER) {
    const envelope = concatBytes(good.subarray(0, 2), fromHex(point), good.subarray(34));
    assert.throws(() => openMailbox(recipientSk, envelope), INVALID, point);
  }
});

test('open rejects malformed padding even if the tag is valid', () => {
  const cases = {
    'declared length exceeds the content': '00000005686f6c61',
    'huge length': 'ffffffff686f6c61',
    'padding shorter than the prefix': '000000',
    'empty padding': '',
  };
  for (const [name, padded] of Object.entries(cases)) {
    assert.throws(() => openMailbox(recipientSk, sealPadded(recipientPk, fromHex(padded), randomness)), INVALID, name);
  }
});

test('the open error carries no cause or details of the step that failed', () => {
  for (const envelope of [new Uint8Array(0), smallEnvelope().subarray(0, 70)]) {
    try {
      openMailbox(recipientSk, envelope);
      assert.fail('should have failed');
    } catch (e) {
      assert.ok(e instanceof MailboxCryptoError);
      assert.equal(e.cause, undefined);
      assert.deepEqual(Object.keys(e).sort(), ['code', 'name']);
      assert.equal(e.message, 'invalid envelope');
    }
  }
});

test('seal rejects a low-order recipient key or one of the wrong length', () => {
  const invalidKey = { name: 'MailboxCryptoError', code: 'invalid-key', message: 'invalid key' };
  for (const point of X25519_LOW_ORDER) {
    assert.throws(() => sealMailbox(fromHex(point), text('hola')), invalidKey, point);
  }
  for (const length of [0, 31, 33]) {
    assert.throws(() => sealMailbox(new Uint8Array(length).fill(9), text('hola')), invalidKey, `length ${length}`);
  }
  assert.throws(() => sealMailboxDeterministic(recipientPk, text('x'), { ephemeralSecretKey: new Uint8Array(31), nonce }), invalidKey);
});

test('seal requires a 12-byte nonce', () => {
  for (const length of [0, 11, 13, 16]) {
    assert.throws(
      () => sealMailboxDeterministic(recipientPk, text('x'), { ephemeralSecretKey, nonce: new Uint8Array(length) }),
      RangeError, `nonce of ${length}`,
    );
  }
});

test('seal rejects a message larger than the maximum and accepts the maximum', () => {
  const tooLarge = { name: 'MailboxCryptoError', code: 'too-large', message: 'message too large' };
  assert.throws(() => sealMailbox(recipientPk, new Uint8Array(MAX_PLAINTEXT_LENGTH + 1)), tooLarge);
  const max = new Uint8Array(MAX_PLAINTEXT_LENGTH);
  max[MAX_PLAINTEXT_LENGTH - 1] = 0x42;
  const envelope = sealMailbox(recipientPk, max);
  assert.equal(envelope.length, 62 + 33554432);
  const opened = openMailbox(recipientSk, envelope);
  assert.equal(opened.length, MAX_PLAINTEXT_LENGTH);
  assert.equal(opened[MAX_PLAINTEXT_LENGTH - 1], 0x42);
});

test('requireContributory rejects an all-zero shared secret', () => {
  assert.throws(() => requireContributory(new Uint8Array(32)), { name: 'MailboxCryptoError', code: 'invalid-key' });
  const shared = new Uint8Array(32);
  shared[31] = 1;
  assert.equal(requireContributory(shared), shared);
});
