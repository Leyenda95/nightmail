// End-to-end mail between NightMail addresses (`nightmail:e2e`, version 1). Spec and vectors in
// packages/test-vectors/crypto/README.md §4:
//
//   payload   = "nightmail:e2e" (13) ‖ version (1) = 0x01 ‖ messageId (16) ‖ u64be(date)
//               ‖ sender addrKey (32) ‖ u8(len) ‖ sender address
//               ‖ recipient addrKey (32) ‖ u8(len) ‖ recipient address
//               ‖ u16be(len) ‖ subject ‖ u32be(len) ‖ body
//   signature = Ed25519(sender auth key, "nightmail:mail-sig:v1" ‖ payload)
//   mail      = payload ‖ signature (64), sealed whole in the mailbox envelope to the recipient's encPk
//
// Anyone can encrypt to a public encPk (the server included), so only the signature inside the
// envelope says who wrote the mail. It covers the recipient too: a mail signed for one address does
// not verify when someone re-seals it to another.
//
// Receiving, with the sender looked up in the registry (asynchronous) between decrypting and verifying:
//
//   const plaintext = openMailbox(encSecretKey, envelope);   // not isE2eMail: a MIME message
//   const declared = declaredSender(plaintext);              // as written, not checked
//   const answer = await lookUpSender(declared);             // Uint8Array | null | SENDER_UNAVAILABLE
//   const mail = openMail(plaintext, me, senderResolverFor(declared, answer));
//   // MailOpenError with code 'sender-unavailable': keep the envelope and open it again later.
import { randomBytes, verify } from 'node:crypto';
import { concatBytes, uintBE, withWiped } from './bytes.ts';
import { KEY_LENGTH, isLowOrderEd25519PublicKey, isUsableAuthPublicKey, publicKeyObject } from './keys.ts';
import { NONCE_LENGTH, openMailbox, sealMailboxDeterministic } from './mailbox.ts';
import type { SealRandomness } from './mailbox.ts';
import { ADDR_KEY_LENGTH, SIGNATURE_LENGTH, ed25519Sign } from './request-auth.ts';

export const MAIL_MAGIC = 'nightmail:e2e';
export const MAIL_VERSION = 0x01;
/** Signing domain, distinct from the request one (`nightmail:mailbox-api:v1`) although the key is the same. */
export const MAIL_SIGNATURE_DOMAIN = 'nightmail:mail-sig:v1';
export const MESSAGE_ID_LENGTH = 16;
export const MAX_SUBJECT_LENGTH = 1024;
/** Largest encoded mail (payload and signature), the same 25 MiB the SMTP ingress accepts. */
export const MAX_MAIL_LENGTH = 25 * 1024 * 1024;
/** Payload and signature without the four variable fields. */
export const MAIL_FIXED_LENGTH = 13 + 1 + MESSAGE_ID_LENGTH + 8 + 2 * (ADDR_KEY_LENGTH + 1) + 2 + 4 + SIGNATURE_LENGTH;
/** Latest date (9999-12-31 23:59:59 UTC): any later one cannot be shown as a normal calendar date. */
export const MAX_MAIL_DATE = 253402300799;

const MAGIC_BYTES = new TextEncoder().encode(MAIL_MAGIC);
const DOMAIN_BYTES = new TextEncoder().encode(MAIL_SIGNATURE_DOMAIN);
// Lowercase ASCII as `normalizeName` produces it, so comparing two addresses is comparing bytes.
const ADDRESS = /^[a-z0-9._-]{1,64}@[a-z0-9.-]{1,190}$/;
// With the `u` flag, `\p{Cs}` only matches unpaired surrogates, which TextEncoder would silently turn into U+FFFD.
const LONE_SURROGATE = /\p{Cs}/u;
// `ignoreBOM` keeps a leading U+FEFF: the decoded text must be exactly the signed bytes.
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** An address as written in the mail: its addrKey and its text (`name@domain`). */
export type MailParty = { addrKey: Uint8Array; address: string };

export type OutgoingMail = {
  /** 16 random bytes; the recipient drops a second mail with the same sender and id. */
  messageId: Uint8Array;
  /**
   * Unix seconds, 0 to `MAX_MAIL_DATE`. Never the raw local clock: the server time of the sending
   * address (README §4.3), since a clock offset shared by all of a user's addresses would link them.
   */
  date: number;
  sender: MailParty;
  recipient: MailParty;
  subject: string;
  body: string;
};

export type MailField = 'messageId' | 'date' | 'sender' | 'recipient' | 'subject' | 'body';

/** A mail that cannot be built. The message names the field, never its value. */
export class MailEncodingError extends Error {
  readonly field: MailField;

  constructor(field: MailField) {
    super(`invalid mail field: ${field}`);
    this.name = 'MailEncodingError';
    this.field = field;
  }
}

/**
 * Why a mail cannot be opened now: `invalid` (the envelope does not open or does not hold a valid e2e
 * mail; it never says which check failed) or `sender-unavailable` (the resolver could not answer: open
 * it again later, it is not marked unverified). A bad signature is not an error (see `openMail`).
 */
export type MailOpenErrorCode = 'invalid' | 'sender-unavailable';

export class MailOpenError extends Error {
  readonly code: MailOpenErrorCode;

  constructor(code: MailOpenErrorCode = 'invalid') {
    super(code === 'invalid' ? 'invalid mail' : 'sender check unavailable');
    this.name = 'MailOpenError';
    this.code = code;
  }
}

export type ReceivedMail = {
  messageId: Uint8Array;
  /**
   * Set by the sender and checked by nobody, even when the sender is verified: show and sort mail by
   * the time it arrived, never by this.
   */
  date: number;
  /** As written in the mail. Only `senderVerified` says whether it is true. */
  sender: MailParty;
  /** The signature is valid, by the sender's on-chain key, and the mail was signed for this address. */
  senderVerified: boolean;
  recipient: MailParty;
  subject: string;
  body: string;
};

/** A resolver's answer when it cannot tell right now (the registry cannot be read, or not recently enough). */
export const SENDER_UNAVAILABLE = 'sender-unavailable';

/**
 * What a sender resolver answers: the sender's on-chain auth key, `null` ("not that sender") or
 * `SENDER_UNAVAILABLE` ("cannot tell now": `openMail` throws `MailOpenError` 'sender-unavailable').
 */
export type SenderLookup = Uint8Array | null | typeof SENDER_UNAVAILABLE;

/**
 * Gets the declared sender's addrKey and address text. It must return a key only if that text
 * resolves, with the same resolution used to send (domain exactly the configured one, an
 * alias-shaped local part only as an alias and by its full text, any other as the mailbox
 * `H(name)`, reserved names never), to that same addrKey, both compared byte for byte with the ones
 * found. A check of the local part alone would accept `name@other.domain`. The signature proves who
 * holds the key, not that the address text belongs to it.
 */
export type SenderResolver = (addrKey: Uint8Array, address: string) => SenderLookup;

export const isMailAddress = (address: unknown): address is string => typeof address === 'string' && ADDRESS.test(address);

const isText = (value: unknown): value is string => typeof value === 'string' && !LONE_SURROGATE.test(value);
/**
 * Characters that change how a text looks without being seen (README §4.2): C1 controls; the
 * bidirectional marks, embeddings, overrides and isolates, which can show `fdp.exe` as `exe.pdf`; and
 * the invisible spaces, joiners and operators that hide text or make two different texts look the
 * same. ZWNJ and ZWJ (U+200C, U+200D) are allowed: Persian, Indic scripts and emoji sequences need
 * them, and they neither reorder nor hide text. All are in the BMP, so UTF-16 code units suffice.
 */
const isDeceptive = (unit: number) =>
  (unit >= 0x80 && unit <= 0x9f) || unit === 0x61c || unit === 0x200b || unit === 0x200e || unit === 0x200f
  || (unit >= 0x202a && unit <= 0x202e) || (unit >= 0x2060 && unit <= 0x206f) || unit === 0xfeff;
/**
 * A single line: no C0 controls (line breaks included), DEL, line or paragraph separators (U+2028,
 * U+2029) nor `isDeceptive` characters.
 */
function isSubject(subject: string): boolean {
  for (let i = 0; i < subject.length; i++) {
    const unit = subject.charCodeAt(i);
    if (unit < 0x20 || unit === 0x7f || unit === 0x2028 || unit === 0x2029 || isDeceptive(unit)) return false;
  }
  return true;
}
/**
 * Tab, line feed and carriage return are the only controls; no DEL nor `isDeceptive` characters,
 * except a byte order mark (U+FEFF) as the very first character, kept as is.
 */
function isBody(body: string): boolean {
  for (let i = body.charCodeAt(0) === 0xfeff ? 1 : 0; i < body.length; i++) {
    const unit = body.charCodeAt(i);
    const control = unit < 0x20 && unit !== 0x09 && unit !== 0x0a && unit !== 0x0d;
    if (control || unit === 0x7f || isDeceptive(unit)) return false;
  }
  return true;
}
const isDate = (date: unknown): date is number =>
  typeof date === 'number' && Number.isSafeInteger(date) && date >= 0 && date <= MAX_MAIL_DATE;

function party(mail: OutgoingMail, field: 'sender' | 'recipient'): Uint8Array {
  const { addrKey, address } = mail[field] ?? {};
  if (!(addrKey instanceof Uint8Array) || addrKey.length !== ADDR_KEY_LENGTH || !isMailAddress(address)) {
    throw new MailEncodingError(field);
  }
  return concatBytes(addrKey, uintBE(address.length, 1), new TextEncoder().encode(address));
}

/** Bytes that get signed after the domain. Throws `MailEncodingError` if a field breaks the rules. */
export function encodeMailPayload(mail: OutgoingMail): Uint8Array {
  const { messageId, date, subject, body } = mail;
  if (!(messageId instanceof Uint8Array) || messageId.length !== MESSAGE_ID_LENGTH) throw new MailEncodingError('messageId');
  if (!isDate(date)) throw new MailEncodingError('date');
  const sender = party(mail, 'sender');
  const recipient = party(mail, 'recipient');
  if (!isText(subject) || !isSubject(subject)) throw new MailEncodingError('subject');
  const subjectBytes = new TextEncoder().encode(subject);
  if (subjectBytes.length > MAX_SUBJECT_LENGTH) throw new MailEncodingError('subject');
  if (!isText(body) || !isBody(body)) throw new MailEncodingError('body');
  const bodyBytes = new TextEncoder().encode(body);
  const variable = sender.length + recipient.length - 2 * (ADDR_KEY_LENGTH + 1) + subjectBytes.length + bodyBytes.length;
  // The body is the only field with no limit of its own.
  if (MAIL_FIXED_LENGTH + variable > MAX_MAIL_LENGTH) throw new MailEncodingError('body');
  return concatBytes(
    MAGIC_BYTES, Uint8Array.of(MAIL_VERSION), messageId, uintBE(date, 8), sender, recipient,
    uintBE(subjectBytes.length, 2), subjectBytes, uintBE(bodyBytes.length, 4), bodyBytes,
  );
}

/** `payload ‖ signature`: the plaintext that goes inside the envelope. */
export function signMail(authSecretKey: Uint8Array, mail: OutgoingMail): Uint8Array {
  const payload = encodeMailPayload(mail);
  return concatBytes(payload, ed25519Sign(authSecretKey, concatBytes(DOMAIN_BYTES, payload)));
}

/** Deterministic variant of `sealMail` for test vectors. Not the default API. */
export function sealMailDeterministic(
  authSecretKey: Uint8Array, recipientEncPublicKey: Uint8Array, mail: OutgoingMail, randomness: SealRandomness,
): Uint8Array {
  const signed = signMail(authSecretKey, mail);
  return withWiped(signed, () => sealMailboxDeterministic(recipientEncPublicKey, signed, randomness));
}

/**
 * Signs the mail with the sender address's auth key and seals it to the recipient's encPk. Throws
 * `MailEncodingError` for a field that breaks the rules and `MailboxCryptoError` (`invalid-key`)
 * for an encPk that cannot receive mail.
 */
export function sealMail(authSecretKey: Uint8Array, recipientEncPublicKey: Uint8Array, mail: OutgoingMail): Uint8Array {
  const randomness = { ephemeralSecretKey: randomBytes(KEY_LENGTH), nonce: randomBytes(NONCE_LENGTH) };
  return withWiped(
    randomness.ephemeralSecretKey, () => sealMailDeterministic(authSecretKey, recipientEncPublicKey, mail, randomness),
  );
}

/** Does this decrypted envelope hold an end-to-end mail (of any version) rather than a MIME message? */
export function isE2eMail(plaintext: Uint8Array): boolean {
  return plaintext.length >= MAGIC_BYTES.length && MAGIC_BYTES.every((byte, i) => plaintext[i] === byte);
}

class Reader {
  private offset = 0;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  take(length: number): Uint8Array {
    if (length > this.bytes.length - this.offset) throw new MailOpenError();
    this.offset += length;
    return this.bytes.subarray(this.offset - length, this.offset);
  }

  uint(byteLength: number): number {
    return this.take(byteLength).reduce((value, byte) => value * 256 + byte, 0);
  }

  party(): MailParty {
    const addrKey = Uint8Array.from(this.take(ADDR_KEY_LENGTH));
    const address = UTF8.decode(this.take(this.uint(1)));
    if (!isMailAddress(address)) throw new MailOpenError();
    return { addrKey, address };
  }

  get done(): boolean {
    return this.offset === this.bytes.length;
  }

  get position(): number {
    return this.offset;
  }
}

type DecodedMail = Omit<ReceivedMail, 'senderVerified'> & { payload: Uint8Array; signature: Uint8Array };

function decodeMail(plaintext: Uint8Array): DecodedMail {
  if (plaintext.length > MAX_MAIL_LENGTH || !isE2eMail(plaintext)) throw new MailOpenError();
  const reader = new Reader(plaintext);
  reader.take(MAGIC_BYTES.length);
  if (reader.uint(1) !== MAIL_VERSION) throw new MailOpenError();
  const messageId = Uint8Array.from(reader.take(MESSAGE_ID_LENGTH));
  // Read as two halves: 2^64 − 1 does not fit in a JavaScript number.
  const dateHigh = reader.uint(4), dateLow = reader.uint(4);
  const date = dateHigh * 2 ** 32 + dateLow;
  if (dateHigh >= 2 ** 21 || !isDate(date)) throw new MailOpenError();
  const sender = reader.party();
  const recipient = reader.party();
  const subjectLength = reader.uint(2);
  if (subjectLength > MAX_SUBJECT_LENGTH) throw new MailOpenError();
  const subject = UTF8.decode(reader.take(subjectLength));
  const body = UTF8.decode(reader.take(reader.uint(4)));
  if (!isSubject(subject) || !isBody(body)) throw new MailOpenError();
  const payload = plaintext.subarray(0, reader.position);
  const signature = reader.take(SIGNATURE_LENGTH);
  if (!reader.done) throw new MailOpenError();
  return { messageId, date, sender, recipient, subject, body, payload, signature };
}

/**
 * Ed25519 with the same verdicts as `ed25519-dalek`'s `verify_strict` (the Rust core): besides
 * OpenSSL's checks (canonical S, R compared byte for byte), it rejects unusable keys and a low-order
 * R. The key holder can build a signature with R = identity that OpenSSL accepts. Neither side uses
 * the cofactor, so they also agree on a key with a small-order component (`mixedOrderKey` vectors).
 */
function verifyMailSignature(authPublicKey: Uint8Array, payload: Uint8Array, signature: Uint8Array): boolean {
  try {
    if (!isUsableAuthPublicKey(authPublicKey) || signature.length !== SIGNATURE_LENGTH) return false;
    if (isLowOrderEd25519PublicKey(signature.subarray(0, KEY_LENGTH))) return false;
    return verify(null, concatBytes(DOMAIN_BYTES, payload), publicKeyObject('ed25519', authPublicKey), signature);
  } catch {
    return false;
  }
}

const sameParty = (a: MailParty, b: MailParty) =>
  a.address === b.address && a.addrKey.length === b.addrKey.length && a.addrKey.every((byte, i) => byte === b.addrKey[i]);

function decodeOrThrow(plaintext: Uint8Array): DecodedMail {
  try {
    return decodeMail(plaintext);
  } catch {
    throw new MailOpenError();
  }
}

/**
 * The sender as the decrypted mail declares it (addrKey and address text), without checking anything
 * but the format: what to look up in the registry before `openMail`, never something to show as the
 * sender. A plaintext `openMail` would refuse as `invalid` throws the same `MailOpenError` here.
 */
export function declaredSender(plaintext: Uint8Array): MailParty {
  return decodeOrThrow(plaintext).sender;
}

/**
 * `SenderResolver` from an answer already obtained (asynchronously) for the sender that the mail
 * declares (`declaredSender`): it gives that answer only when asked about exactly that sender.
 */
export function senderResolverFor(declared: MailParty, answer: SenderLookup): SenderResolver {
  return (addrKey, address) => (sameParty(declared, { addrKey, address }) ? answer : null);
}

/**
 * Decodes the plaintext of an envelope (`isE2eMail`) and checks the sender. `me` is the address that
 * received it; the resolver is not asked when the mail was signed for someone else. A mail that does
 * not decode (unknown version, truncated, a field out of its limits) throws `MailOpenError`
 * (`invalid`); one that decodes but whose signature, sender or recipient do not check out is
 * returned with `senderVerified: false`. If the resolver answers `SENDER_UNAVAILABLE`, it throws
 * `MailOpenError` (`sender-unavailable`): open it again later.
 */
export function openMail(plaintext: Uint8Array, me: MailParty, resolveSender: SenderResolver): ReceivedMail {
  const { payload, signature, ...mail } = decodeOrThrow(plaintext);
  let senderVerified = false;
  if (sameParty(mail.recipient, me)) {
    const answer = resolveSender(mail.sender.addrKey, mail.sender.address);
    if (answer === SENDER_UNAVAILABLE) throw new MailOpenError('sender-unavailable');
    senderVerified = answer instanceof Uint8Array && verifyMailSignature(answer, payload, signature);
  }
  return { ...mail, senderVerified };
}

/**
 * `openMailbox` followed by `openMail`, for a resolver that can answer right away. Any envelope
 * failure throws `MailOpenError` (`invalid`) too. With an asynchronous registry lookup, open the
 * envelope first and use `declaredSender` (see the top of this file).
 */
export function openMailEnvelope(
  recipientEncSecretKey: Uint8Array, envelope: Uint8Array, me: MailParty, resolveSender: SenderResolver,
): ReceivedMail {
  let plaintext: Uint8Array;
  try {
    plaintext = openMailbox(recipientEncSecretKey, envelope);
  } catch {
    throw new MailOpenError();
  }
  return withWiped(plaintext, () => openMail(plaintext, me, resolveSender));
}
