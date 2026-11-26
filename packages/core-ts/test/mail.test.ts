import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAIL_FIXED_LENGTH, MAX_MAIL_LENGTH, MailEncodingError, MailOpenError, SENDER_UNAVAILABLE, declaredSender,
  encodeMailPayload, isE2eMail, openMail, openMailEnvelope, sealMail, senderResolverFor, signMail,
} from '../src/mail.ts';
import type { MailParty, OutgoingMail, SenderResolver } from '../src/mail.ts';
import { ed25519PublicKey, generateSecretKey, x25519PublicKey } from '../src/keys.ts';
import { openMailbox, sealMailbox } from '../src/mailbox.ts';
import { X25519_LOW_ORDER } from './fixtures.ts';
import { fromHex } from '../src/bytes.ts';

const senderAuth = generateSecretKey();
const recipientEnc = generateSecretKey();
const sender: MailParty = { addrKey: generateSecretKey(), address: 'ana@nightmail.local' };
const me: MailParty = { addrKey: generateSecretKey(), address: 'juan@nightmail.local' };
const mail: OutgoingMail = {
  messageId: generateSecretKey().subarray(0, 16), date: 1794873600, sender, recipient: me,
  subject: 'Hola', body: 'Cuerpo del mensaje\r\n',
};

/** The chain as the resolver sees it: only the sender, by addrKey and text. */
const directory: SenderResolver = (addrKey, address) =>
  address === sender.address && Buffer.from(addrKey).equals(sender.addrKey) ? ed25519PublicKey(senderAuth) : null;

const FIELD = (field: string) => ({ name: 'MailEncodingError', field, message: `invalid mail field: ${field}` });
const INVALID = { name: 'MailOpenError', message: 'invalid mail' };

test('a sealed mail opens, with the sender verified and every field intact', () => {
  const envelope = sealMail(senderAuth, x25519PublicKey(recipientEnc), mail);
  const received = openMailEnvelope(recipientEnc, envelope, me, directory);
  assert.equal(received.senderVerified, true);
  assert.deepEqual(received, { ...mail, messageId: Uint8Array.from(mail.messageId), senderVerified: true });
});

test('each sealing uses a fresh ephemeral key and nonce; the signature is deterministic', () => {
  const a = sealMail(senderAuth, x25519PublicKey(recipientEnc), mail);
  const b = sealMail(senderAuth, x25519PublicKey(recipientEnc), mail);
  assert.notDeepEqual(a.subarray(2, 46), b.subarray(2, 46));
  assert.deepEqual(openMailbox(recipientEnc, a), openMailbox(recipientEnc, b));
  assert.deepEqual(openMailbox(recipientEnc, a), signMail(senderAuth, mail));
});

test('the envelope is the plain mailbox envelope: same header and bucket as any other mail', () => {
  const envelope = sealMail(senderAuth, x25519PublicKey(recipientEnc), mail);
  assert.deepEqual([...envelope.subarray(0, 2)], [1, 1]);
  assert.equal(envelope.length, 62 + 4096);
});

test('sealing to an unusable encryption key fails like the mailbox envelope', () => {
  for (const key of X25519_LOW_ORDER) {
    assert.throws(() => sealMail(senderAuth, fromHex(key), mail), { name: 'MailboxCryptoError', code: 'invalid-key' }, key);
  }
});

test('an e2e mail is told apart from a MIME message by its magic', () => {
  assert.equal(isE2eMail(signMail(senderAuth, mail)), true);
  assert.equal(isE2eMail(new TextEncoder().encode('From: a@b\r\n\r\nhola')), false);
  assert.equal(isE2eMail(new TextEncoder().encode('nightmail:e2')), false);
  assert.equal(isE2eMail(new Uint8Array(0)), false);
});

test('opening with another key or a broken envelope is the same error', () => {
  const envelope = sealMail(senderAuth, x25519PublicKey(recipientEnc), mail);
  assert.throws(() => openMailEnvelope(generateSecretKey(), envelope, me, directory), INVALID);
  assert.throws(() => openMailEnvelope(recipientEnc, envelope.subarray(1), me, directory), INVALID);
  // A plain MIME message in a valid envelope is not an e2e mail.
  const mime = sealMailbox(x25519PublicKey(recipientEnc), new TextEncoder().encode('From: a@b\r\n\r\nhola'));
  assert.throws(() => openMailEnvelope(recipientEnc, mime, me, directory), INVALID);
});

test('the resolver gets the claimed sender, and is not asked when the mail was signed for someone else', () => {
  const plaintext = signMail(senderAuth, mail);
  const calls: [string, string][] = [];
  const spy: SenderResolver = (addrKey, address) => {
    calls.push([Buffer.from(addrKey).toString('hex'), address]);
    return directory(addrKey, address);
  };
  assert.equal(openMail(plaintext, me, spy).senderVerified, true);
  assert.deepEqual(calls, [[Buffer.from(sender.addrKey).toString('hex'), sender.address]]);
  const other = { ...me, address: 'pepe@nightmail.local' };
  const received = openMail(plaintext, other, spy);
  assert.equal(received.senderVerified, false);
  assert.equal(received.sender.address, sender.address);
  assert.equal(calls.length, 1);
});

test('the declared sender is read without checking the signature', () => {
  const plaintext = signMail(senderAuth, mail);
  assert.deepEqual(declaredSender(plaintext), { addrKey: Uint8Array.from(sender.addrKey), address: sender.address });
  plaintext[plaintext.length - 1]! ^= 1;
  assert.equal(declaredSender(plaintext).address, sender.address);
  assert.equal(openMail(plaintext, me, directory).senderVerified, false);
  assert.throws(() => declaredSender(plaintext.subarray(1)), INVALID);
});

test('a resolver that cannot answer means "open it again later", not "not verified"', () => {
  const plaintext = signMail(senderAuth, mail);
  const unavailable: SenderResolver = () => SENDER_UNAVAILABLE;
  const retry = { name: 'MailOpenError', code: 'sender-unavailable', message: 'sender check unavailable' };
  assert.throws(() => openMail(plaintext, me, unavailable), retry);
  const envelope = sealMail(senderAuth, x25519PublicKey(recipientEnc), mail);
  assert.throws(() => openMailEnvelope(recipientEnc, envelope, me, unavailable), retry);
  // Not asked when the mail was signed for someone else; the format is checked first.
  assert.equal(openMail(plaintext, { ...me, address: 'pepe@nightmail.local' }, unavailable).senderVerified, false);
  assert.throws(() => openMail(plaintext.subarray(1), me, unavailable), { ...INVALID, code: 'invalid' });
});

test('senderResolverFor answers only for the declared sender', () => {
  const plaintext = signMail(senderAuth, mail);
  const declared = declaredSender(plaintext);
  const key = ed25519PublicKey(senderAuth);
  assert.equal(openMail(plaintext, me, senderResolverFor(declared, key)).senderVerified, true);
  assert.equal(openMail(plaintext, me, senderResolverFor(declared, null)).senderVerified, false);
  const other = { ...declared, address: 'otra@nightmail.local' };
  assert.equal(openMail(plaintext, me, senderResolverFor(other, key)).senderVerified, false);
  assert.equal(openMail(plaintext, me, senderResolverFor(other, SENDER_UNAVAILABLE)).senderVerified, false);
  assert.throws(() => openMail(plaintext, me, senderResolverFor(declared, SENDER_UNAVAILABLE)), { code: 'sender-unavailable' });
});

test('a resolver returning a malformed key or something else gives "not verified", never an exception', () => {
  const plaintext = signMail(senderAuth, mail);
  for (const key of [new Uint8Array(31), new Uint8Array(33), new Uint8Array(32), 'clave', undefined]) {
    const resolver = (() => key) as unknown as SenderResolver;
    assert.equal(openMail(plaintext, me, resolver).senderVerified, false, String(key));
  }
});

test('text with an unpaired surrogate is refused instead of being silently replaced', () => {
  assert.throws(() => encodeMailPayload({ ...mail, subject: 'a\ud800b' }), FIELD('subject'));
  assert.throws(() => encodeMailPayload({ ...mail, body: 'a\udc00' }), FIELD('body'));
  // A proper pair is fine.
  assert.doesNotThrow(() => encodeMailPayload({ ...mail, subject: '📅' }));
});

test('fields of the wrong type are refused by name', () => {
  const bad = (change: object) => ({ ...mail, ...change }) as unknown as OutgoingMail;
  assert.throws(() => encodeMailPayload(bad({ subject: 42 })), FIELD('subject'));
  assert.throws(() => encodeMailPayload(bad({ body: [104, 111] })), FIELD('body'));
  assert.throws(() => encodeMailPayload(bad({ date: '1794873600' })), FIELD('date'));
  assert.throws(() => encodeMailPayload(bad({ messageId: 'x'.repeat(16) })), FIELD('messageId'));
  assert.throws(() => encodeMailPayload(bad({ sender: undefined })), FIELD('sender'));
  assert.throws(() => encodeMailPayload(bad({ recipient: { addrKey: me.addrKey } })), FIELD('recipient'));
});

test('the size limit counts the whole encoded mail, and multi-byte text by its bytes', () => {
  const overhead = MAIL_FIXED_LENGTH + sender.address.length + me.address.length + 4;
  const fits = { ...mail, subject: 'Hola', body: 'a'.repeat(MAX_MAIL_LENGTH - overhead) };
  assert.equal(signMail(senderAuth, fits).length, MAX_MAIL_LENGTH);
  assert.throws(() => encodeMailPayload({ ...fits, body: `${fits.body}a` }), FIELD('body'));
  assert.throws(() => encodeMailPayload({ ...fits, body: `${fits.body.slice(1)}ñ` }), FIELD('body'));
});

test('errors carry fixed messages, never a value', () => {
  assert.equal(new MailOpenError().message, 'invalid mail');
  assert.equal(new MailOpenError('sender-unavailable').message, 'sender check unavailable');
  assert.equal(new MailEncodingError('body').message, 'invalid mail field: body');
});
