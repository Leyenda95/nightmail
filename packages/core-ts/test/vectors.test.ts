// The envelope and signature formats must not change without deliberately regenerating the
// vectors (they are shared by the server and the app's Rust core).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  MAILBOX_VECTORS_FILE, MAIL_VECTORS_FILE, REQUEST_AUTH_VECTORS_FILE, computeMailVectors, computeMailboxVectors,
  computeRequestAuthVectors, mailBodyPattern, patternBytes,
} from '../scripts/vectors.ts';
import {
  bucketFor, bucketOfEnvelope, canonicalHost, encodeRequest, envelopeLengthFor, fromHex, isUsableMailboxPublicKey,
  isWithinTimeWindow, openMailbox, parseAuthHeaders, sealMailbox, toHex, verifyRequest, x25519PublicKey,
} from '../src/index.ts';
import type { MailboxRequest } from '../src/index.ts';
import {
  MAX_MAIL_LENGTH, MailEncodingError, MailOpenError, declaredSender, encodeMailPayload, isE2eMail, openMail,
  openMailEnvelope, signMail,
} from '../src/mail.ts';
import type { MailParty, OutgoingMail, ReceivedMail, SenderResolver } from '../src/mail.ts';
import { sealMailDeterministic } from '../src/testing.ts';
import { ed25519Sign } from '../src/request-auth.ts';
import { concatBytes, uintBE } from '../src/bytes.ts';

type MailboxVectors = ReturnType<typeof computeMailboxVectors>;
type RequestAuthVectors = ReturnType<typeof computeRequestAuthVectors>;
type RequestJson = RequestAuthVectors['valid'][number]['request'];
type MailVectors = ReturnType<typeof computeMailVectors>;

const mailbox: MailboxVectors = JSON.parse(readFileSync(MAILBOX_VECTORS_FILE, 'utf8'));
const requestAuth: RequestAuthVectors = JSON.parse(readFileSync(REQUEST_AUTH_VECTORS_FILE, 'utf8'));
const mail: MailVectors = JSON.parse(readFileSync(MAIL_VECTORS_FILE, 'utf8'));

const toRequest = (json: RequestJson): MailboxRequest => ({ ...json, addrKey: fromHex(json.addrKey), nonce: fromHex(json.nonce) });
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('the current code reproduces the stored mailbox vectors exactly', () => {
  assert.deepEqual(computeMailboxVectors(), mailbox);
});

test('the current code reproduces the stored signing vectors exactly', () => {
  assert.deepEqual(computeRequestAuthVectors(), requestAuth);
});

test('the current code reproduces the stored e2e mail vectors exactly', () => {
  assert.deepEqual(computeMailVectors(), mail);
});

test('the vectors use lowercase hex without 0x', () => {
  const hexFields = /^(.*Keys?|nonce|sharedSecret|key|info|plaintext|envelope|.*Sha256|message|signature|payload|messageId)$/;
  let checked = 0;
  const walk = (value: unknown, field: string) => {
    if (Array.isArray(value)) value.forEach((item) => walk(item, field));
    else if (value !== null && typeof value === 'object') Object.entries(value).forEach(([k, v]) => walk(v, k));
    else if (typeof value === 'string' && hexFields.test(field)) {
      assert.match(value, /^(?:[0-9a-f]{2})*$/, field);
      checked++;
    }
  };
  walk(mailbox, '');
  walk(requestAuth, '');
  walk(mail, '');
  assert.ok(checked > 500, `only ${checked} fields were checked`);
});

test('mailbox: the bucket table and the stored edges', () => {
  assert.equal(mailbox.constants.buckets.length, 14);
  assert.equal(mailbox.padding.length, 2 + 14 * 3 - 1);
  for (const { plaintextLength, bucket, envelopeLength } of mailbox.padding) {
    assert.equal(bucketFor(plaintextLength), bucket, String(plaintextLength));
    assert.equal(envelopeLengthFor(plaintextLength), envelopeLength);
    assert.equal(bucketOfEnvelope(envelopeLength), bucket);
  }
  assert.throws(() => bucketFor(mailbox.sealFailures.plaintextLengthTooLarge), RangeError);
});

test('mailbox: there is a sealing at both edges of every bucket, plus the empty one', () => {
  const lengths = new Set(mailbox.seal.map((v) => v.plaintextLength));
  assert.ok(lengths.has(0));
  for (const bucket of mailbox.constants.buckets) {
    assert.ok(lengths.has(bucket - 4), `the largest that fits in ${bucket}`);
    if (bucket > 4096) assert.ok(lengths.has(bucket / 2 - 3), `the smallest of ${bucket}`);
  }
  assert.equal(new Set(mailbox.seal.map((v) => v.envelopeSha256)).size, mailbox.seal.length);
  assert.equal(new Set(mailbox.seal.map((v) => v.ephemeralSecretKey)).size, mailbox.seal.length);
});

test('mailbox: the stored envelopes open with the public API and give the message', () => {
  const recipientSecretKey = fromHex(mailbox.recipient.secretKey);
  assert.equal(toHex(x25519PublicKey(recipientSecretKey)), mailbox.recipient.publicKey);
  const inline = mailbox.seal.filter((v) => v.envelope !== undefined);
  assert.equal(inline.length, 3);
  for (const vector of inline) {
    const envelope = fromHex(vector.envelope!);
    assert.equal(sha256(envelope), vector.envelopeSha256, vector.name);
    assert.equal(envelope.length, vector.envelopeLength, vector.name);
    assert.equal(toHex(openMailbox(recipientSecretKey, envelope)), vector.plaintext, vector.name);
  }
  for (const vector of mailbox.open) {
    assert.equal(toHex(openMailbox(fromHex(vector.recipientSecretKey), fromHex(vector.envelope))), vector.plaintext, vector.name);
  }
});

test('mailbox: the envelopes that must fail do fail, all with the same error', () => {
  assert.ok(mailbox.openFailures.length >= 20);
  for (const { name, recipientSecretKey, envelope } of mailbox.openFailures) {
    assert.throws(
      () => openMailbox(fromHex(recipientSecretKey), fromHex(envelope)),
      { name: 'MailboxCryptoError', code: 'invalid-envelope', message: 'invalid envelope' }, name,
    );
  }
  const unusable = [...mailbox.sealFailures.lowOrderRecipientPublicKeys, ...mailbox.sealFailures.nonCanonicalRecipientPublicKeys];
  assert.equal(unusable.length, 9 + 5);
  for (const key of unusable) {
    assert.throws(() => sealMailbox(fromHex(key), new Uint8Array(1)), { code: 'invalid-key' }, key);
    assert.equal(isUsableMailboxPublicKey(fromHex(key)), false, key);
  }
  assert.equal(mailbox.openFailureOversized.envelopeLength, mailbox.constants.maxEnvelopeLength + 1);
});

test('the pattern of the large messages: byte i is i mod 251', () => {
  assert.equal(patternBytes(0).length, 0);
  const pattern = patternBytes(600);
  assert.equal(pattern.length, 600);
  assert.ok(pattern.every((byte, i) => byte === i % 251));
});

test('signing: the valid ones verify and their message is the canonical encoding', () => {
  const authPublicKey = fromHex(requestAuth.auth.publicKey);
  assert.ok(requestAuth.valid.length >= 5);
  for (const { name, request, message, signature, headers } of requestAuth.valid) {
    assert.equal(toHex(encodeRequest(toRequest(request))), message, name);
    assert.equal(verifyRequest(authPublicKey, toRequest(request), fromHex(signature)), true, name);
    // The headers alone are enough to recover timestamp, nonce and signature.
    const credentials = parseAuthHeaders(headers);
    assert.ok(credentials, name);
    assert.equal(credentials.timestamp, request.timestamp, name);
    assert.equal(toHex(credentials.nonce), request.nonce, name);
    assert.equal(toHex(credentials.signature), signature, name);
  }
  assert.ok(requestAuth.valid.some((v) => v.request.path.length === 2048), 'there is a vector with the longest path');
  const first = requestAuth.valid[0]!;
  assert.equal(Object.values(requestAuth.encodingExample).join(''), first.message, 'the broken-down example is the first vector');
});

test('signing: the invalid ones are rejected and non-canonical requests are not encoded', () => {
  assert.ok(requestAuth.invalid.length >= 25);
  for (const { name, authPublicKey, request, signature } of requestAuth.invalid) {
    assert.equal(verifyRequest(fromHex(authPublicKey), toRequest(request), fromHex(signature)), false, name);
  }
  for (const { name, field, request } of requestAuth.rejectedRequests) {
    assert.throws(() => encodeRequest(toRequest(request)), { name: 'RequestEncodingError', field }, name);
  }
});

test('signing: rejected headers and host from the base URL', () => {
  const good = requestAuth.valid[0]!.headers;
  assert.ok(parseAuthHeaders(good));
  assert.ok(requestAuth.rejectedHeaders.length >= 10);
  for (const { name, header, value } of requestAuth.rejectedHeaders) {
    assert.equal(parseAuthHeaders({ ...good, [header]: value }), null, name);
  }
  for (const { baseUrl, host } of requestAuth.hosts) assert.equal(canonicalHost(baseUrl), host, baseUrl);
  assert.ok(requestAuth.rejectedBaseUrls.length >= 3);
  for (const baseUrl of requestAuth.rejectedBaseUrls) {
    assert.throws(() => canonicalHost(baseUrl), { name: 'RequestEncodingError', field: 'host' }, baseUrl);
  }
});

test('signing: the stored time window', () => {
  for (const { timestamp, now, toleranceSeconds, accepted } of requestAuth.timeWindow) {
    assert.equal(isWithinTimeWindow(timestamp, now, toleranceSeconds), accepted, `${timestamp - now} ± ${toleranceSeconds}`);
  }
});

// ---------- End-to-end mail (README §4), through the public API ----------

type PartyJson = { addrKey: string; address: string };
type MailJson = { messageId: string; date: number; sender: PartyJson; recipient: PartyJson; subject: string }
  & ({ body: string } | { bodyPattern: string; bodyLength: number });

const toParty = (json: PartyJson): MailParty => ({ addrKey: fromHex(json.addrKey), address: json.address });
const toMail = (json: MailJson): OutgoingMail => ({
  messageId: fromHex(json.messageId), date: json.date, sender: toParty(json.sender), recipient: toParty(json.recipient),
  subject: json.subject, body: 'body' in json ? json.body : mailBodyPattern(json.bodyLength),
});

/** The directory as the chain gives it: a key only for a registered addrKey with its own address text. */
const directory: SenderResolver = (addrKey, address) => {
  const entry = mail.directory.find((e) => e.addrKey === toHex(addrKey) && e.address === address);
  return entry ? fromHex(entry.authPublicKey) : null;
};

const expectedReceived = (json: MailJson, senderVerified: boolean): ReceivedMail => {
  const { messageId, date, sender, recipient, subject, body } = toMail(json);
  return { messageId, date, sender, recipient, subject, body, senderVerified };
};

const isOpenError = (e: unknown) => e instanceof MailOpenError && e.code === 'invalid' && e.message === 'invalid mail';

test('e2e mail: the stored example is the first valid payload, field by field', () => {
  assert.equal(Object.values(mail.encodingExample).join(''), mail.valid[0]!.payload);
  assert.equal(mail.constants.fixedLength, 174);
  assert.ok(mail.valid.some((v) => v.payloadLength + 64 === MAX_MAIL_LENGTH), 'there is a vector of the largest mail');
});

test('e2e mail: every valid vector is reproduced and opens with the sender verified', () => {
  const encSecretKey = fromHex(mail.recipient.encSecretKey);
  const encPublicKey = x25519PublicKey(encSecretKey);
  const authSecretKey = fromHex(mail.sender.authSecretKey);
  assert.equal(toHex(encPublicKey), mail.recipient.encPublicKey);
  for (const v of mail.valid) {
    const outgoing = toMail(v.mail);
    const payload = encodeMailPayload(outgoing);
    assert.equal(payload.length, v.payloadLength, v.name);
    assert.equal(sha256(payload), v.payloadSha256, v.name);
    if (v.payload !== undefined) assert.equal(toHex(payload), v.payload, v.name);
    const entry = mail.directory.find((e) => e.addrKey === v.mail.sender.addrKey);
    assert.equal(entry?.authPublicKey, mail.sender.authPublicKey, `${v.name}: signed with the sender key`);
    assert.deepEqual(signMail(authSecretKey, outgoing), concatBytes(payload, fromHex(v.signature)), v.name);
    const randomness = { ephemeralSecretKey: fromHex(v.ephemeralSecretKey), nonce: fromHex(v.nonce) };
    const envelope = sealMailDeterministic(authSecretKey, encPublicKey, outgoing, randomness);
    if (v.envelope !== undefined) assert.equal(toHex(envelope), v.envelope, v.name);
    assert.equal(envelope.length, v.envelopeLength, v.name);
    assert.equal(sha256(envelope), v.envelopeSha256, v.name);
    const received = openMailEnvelope(encSecretKey, envelope, outgoing.recipient, directory);
    assert.deepEqual(received, expectedReceived(v.mail, true), v.name);
  }
});

test('e2e mail: the unverified vectors open, with senderVerified = false and the claimed sender', () => {
  const me = toParty(mail.recipient);
  assert.ok(mail.unverified.length >= 15);
  for (const v of mail.unverified) {
    const plaintext = fromHex(v.plaintext);
    assert.equal(isE2eMail(plaintext), true, v.name);
    assert.deepEqual(openMail(plaintext, me, directory), expectedReceived(v.mail, false), v.name);
    assert.deepEqual(declaredSender(plaintext), toParty(v.mail.sender), v.name);
  }
  assert.ok(mail.unverified.some((v) => !v.mail.sender.address.endsWith('@nightmail.local')), 'a sender in another domain');
});

test('e2e mail: a key with a small-order component gets the stored verdict (no cofactor)', () => {
  const me = toParty(mail.recipient);
  assert.deepEqual(mail.mixedOrderKey.map((v) => v.senderVerified), [true, false]);
  for (const v of mail.mixedOrderKey) {
    assert.deepEqual(openMail(fromHex(v.plaintext), me, directory), expectedReceived(v.mail, v.senderVerified), v.name);
  }
});

test('e2e mail: the open failures and the oversized mail are rejected with the same error', () => {
  const me = toParty(mail.recipient);
  assert.ok(mail.openFailures.length >= 25);
  for (const v of mail.openFailures) {
    assert.throws(() => openMail(fromHex(v.plaintext), me, directory), isOpenError, v.name);
    assert.throws(() => declaredSender(fromHex(v.plaintext)), isOpenError, v.name);
  }
  // The largest mail that can be encoded plus one body byte, signed like any other.
  const o = mail.openFailureOversized;
  const outgoing = toMail(o.mail);
  const fits = encodeMailPayload({ ...outgoing, body: outgoing.body.slice(0, -1) });
  const bodyStart = fits.length - (outgoing.body.length - 1);
  const payload = concatBytes(
    fits.subarray(0, bodyStart - 4), uintBE(outgoing.body.length, 4), fits.subarray(bodyStart),
    new TextEncoder().encode(outgoing.body.slice(-1)),
  );
  const domain = new TextEncoder().encode(mail.constants.signatureDomain);
  const plaintext = concatBytes(payload, ed25519Sign(fromHex(mail.sender.authSecretKey), concatBytes(domain, payload)));
  assert.equal(plaintext.length, o.plaintextLength);
  assert.equal(sha256(plaintext), o.plaintextSha256);
  assert.throws(() => openMail(plaintext, me, directory), isOpenError);
});

test('e2e mail: the encode failures are refused, naming the field, and repairing that field fixes them', () => {
  const valid = toMail(mail.valid[0]!.mail);
  assert.ok(mail.encodeFailures.length >= 25);
  for (const v of mail.encodeFailures) {
    const field = v.field as keyof OutgoingMail;
    const broken = toMail(v.mail);
    assert.throws(() => encodeMailPayload(broken), (e) => e instanceof MailEncodingError && e.field === field, v.name);
    assert.doesNotThrow(() => encodeMailPayload({ ...broken, [field]: valid[field] }), v.name);
  }
});

test('e2e mail: subject and body accept a code point exactly as the stored rules say', () => {
  const base = toMail(mail.valid[0]!.mail);
  const deceptive = (cp: number) => mail.constants.deceptiveCharacters.some(([first, last]) => cp >= first! && cp <= last!);
  const encodes = (change: Partial<OutgoingMail>) => {
    try {
      encodeMailPayload({ ...base, ...change });
      return true;
    } catch {
      return false;
    }
  };
  // Every BMP code point (the listed ones all are), and one in every 256 above it.
  for (let cp = 0; cp <= 0x10ffff; cp += cp < 0x10000 ? 1 : 0x100) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCodePoint(cp);
    const subjectOk = cp >= 0x20 && cp !== 0x7f && cp !== 0x2028 && cp !== 0x2029 && !deceptive(cp);
    const bodyOk = (cp >= 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d) && cp !== 0x7f && !deceptive(cp);
    assert.equal(encodes({ subject: `a${ch}` }), subjectOk, `subject U+${cp.toString(16)}`);
    assert.equal(encodes({ body: `a${ch}` }), bodyOk, `body U+${cp.toString(16)}`);
  }
  // A byte order mark only as the first character of the body.
  assert.equal(encodes({ body: '﻿a' }), true);
  assert.equal(encodes({ subject: '﻿a' }), false);
});
