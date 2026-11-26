// Mailbox request signing (Ed25519, RFC 8032) with the address's key. Signed message:
//   "nightmail:mailbox-api:v1" (24 ASCII bytes)
//   ‖ u16be(len(host)) ‖ host      lowercase ASCII, with the port if any
//   ‖ u8(version)                  API version (1)
//   ‖ u16be(len(method)) ‖ method  uppercase ASCII
//   ‖ u16be(len(path)) ‖ path      as sent in the request, including the query string
//   ‖ addrKey (32)
//   ‖ u64be(timestamp)             Unix seconds
//   ‖ nonce (16)
// Time window and replay nonces are checked in authenticate.ts.
import { sign, verify } from 'node:crypto';
import { concatBytes, uintBE } from './bytes.ts';
import { isUsableAuthPublicKey, privateKeyObject, publicKeyObject } from './keys.ts';

export const REQUEST_AUTH_DOMAIN = 'nightmail:mailbox-api:v1';
export const MAILBOX_API_VERSION = 1;
export const ADDR_KEY_LENGTH = 32;
export const REQUEST_NONCE_LENGTH = 16;
export const SIGNATURE_LENGTH = 64;
export const MAX_CLOCK_SKEW_SECONDS = 60;

export type MailboxRequest = {
  /**
   * Authority of the server's configured base URL (`canonicalHost` in transport.ts): lowercase,
   * with `:port` only if it is not the scheme default. Never the request's `Host` header.
   */
  host: string;
  version: number;
  method: string;
  /** Request target exactly as sent (`req.url`), with its query string and without normalization. */
  path: string;
  addrKey: Uint8Array;
  /** Unix seconds. */
  timestamp: number;
  nonce: Uint8Array;
};

export type RequestField = keyof MailboxRequest;

/** The message names the field, never its value. */
export class RequestEncodingError extends Error {
  readonly field: RequestField;

  constructor(field: RequestField) {
    super(`invalid field: ${field}`);
    this.name = 'RequestEncodingError';
    this.field = field;
  }
}

const DOMAIN_BYTES = new TextEncoder().encode(REQUEST_AUTH_DOMAIN);

// ASCII only, so length in characters equals length in bytes. The path allows only what a URL
// carries unambiguously (unreserved chars, `/`, `%` and the query's `?=&`), so the request target
// can be signed exactly as received, without normalizing it.
const HOST = /^[a-z0-9.:[\]-]{1,255}$/;
const METHOD = /^[A-Z]{1,16}$/;
const PATH = /^\/[A-Za-z0-9/._~%?=&-]{0,2047}$/;
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

/**
 * Does the path (before `?`) contain a `.` or `..` segment, also when written with `%2e`? A proxy
 * or the server itself could resolve it and end up serving a different path than the signed one.
 */
function hasDotSegment(path: string): boolean {
  return path.split('?', 1)[0]!.split('/').some((segment) => DOT_SEGMENT.test(segment));
}

/** Is `host` valid as a field of the signed message? */
export const isSignableHost = (host: string) => HOST.test(host);

const TEXT_FIELDS = {
  host: isSignableHost,
  method: (method: string) => METHOD.test(method),
  path: (path: string) => PATH.test(path) && !hasDotSegment(path),
} as const;

function textField(request: MailboxRequest, field: keyof typeof TEXT_FIELDS): Uint8Array {
  const value = request[field];
  // A regex would coerce a non-string to text (e.g. a number coming from JSON).
  if (typeof value !== 'string' || !TEXT_FIELDS[field](value)) throw new RequestEncodingError(field);
  const bytes = new TextEncoder().encode(value);
  return concatBytes(uintBE(bytes.length, 2), bytes);
}

function fixedField(request: MailboxRequest, field: 'addrKey' | 'nonce', length: number): Uint8Array {
  const value = request[field];
  if (!(value instanceof Uint8Array) || value.length !== length) throw new RequestEncodingError(field);
  return value;
}

function uintField(request: MailboxRequest, field: 'version' | 'timestamp', byteLength: number): Uint8Array {
  try {
    return uintBE(request[field], byteLength);
  } catch {
    throw new RequestEncodingError(field);
  }
}

/** Bytes to sign. Throws `RequestEncodingError` if a field is not in canonical form. */
export function encodeRequest(request: MailboxRequest): Uint8Array {
  return concatBytes(
    DOMAIN_BYTES,
    textField(request, 'host'),
    uintField(request, 'version', 1),
    textField(request, 'method'),
    textField(request, 'path'),
    fixedField(request, 'addrKey', ADDR_KEY_LENGTH),
    uintField(request, 'timestamp', 8),
    fixedField(request, 'nonce', REQUEST_NONCE_LENGTH),
  );
}

/** Pure (deterministic) Ed25519 signature with the 32-byte seed. */
export function ed25519Sign(secretKey: Uint8Array, message: Uint8Array): Uint8Array {
  return Uint8Array.from(sign(null, message, privateKeyObject('ed25519', secretKey)));
}

/** Signs a request. For tests and scripts; the app signs in the Rust core. */
export function signRequest(authSecretKey: Uint8Array, request: MailboxRequest): Uint8Array {
  return ed25519Sign(authSecretKey, encodeRequest(request));
}

/**
 * Is `signature` a valid signature of `request` by the address key? Never throws: a malformed key,
 * signature or field yields `false`. Also rejects keys `isUsableAuthPublicKey` refuses, since with
 * a low-order key anyone could forge valid signatures.
 */
export function verifyRequest(authPublicKey: Uint8Array, request: MailboxRequest, signature: Uint8Array): boolean {
  try {
    if (!isUsableAuthPublicKey(authPublicKey)) return false;
    return verify(null, encodeRequest(request), publicKeyObject('ed25519', authPublicKey), signature);
  } catch {
    return false;
  }
}

const isSecond = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** Is `timestamp` within `toleranceSeconds` of `now` (both Unix seconds, bounds inclusive)? */
export function isWithinTimeWindow(timestamp: number, now: number, toleranceSeconds = MAX_CLOCK_SKEW_SECONDS): boolean {
  return [timestamp, now, toleranceSeconds].every(isSecond) && Math.abs(now - timestamp) <= toleranceSeconds;
}

/**
 * Last second a request with this `timestamp` is still inside the window. The server must remember
 * its nonce until then: forgetting it earlier (say, 60 s after receipt) would let a request signed
 * with a clock running ahead be replayed.
 */
export function nonceRetentionDeadline(timestamp: number, toleranceSeconds = MAX_CLOCK_SKEW_SECONDS): number {
  return timestamp + toleranceSeconds;
}
