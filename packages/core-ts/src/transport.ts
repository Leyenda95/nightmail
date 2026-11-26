// How a request signature travels over HTTP, and how the signed `host` is derived.
//
//   NightMail-Timestamp: 1794873600          Unix seconds, strict decimal (no sign, leading zeros or spaces)
//   NightMail-Nonce: <32 hex digits>         16 bytes, lowercase hex
//   NightMail-Signature: <128 hex digits>    64 bytes, lowercase hex
//
// The rest of the signed message is not sent in headers: `host` comes from the server config,
// `version` and `addrKey` from the route (`/v1/box/<addrKey>/…`), `method` and `path` from the request.
import { fromHex, toHex } from './bytes.ts';
import { REQUEST_NONCE_LENGTH, RequestEncodingError, SIGNATURE_LENGTH, isSignableHost } from './request-auth.ts';

/** Lowercase names, as `node:http` delivers them (HTTP header names are case-insensitive). */
export const TIMESTAMP_HEADER = 'nightmail-timestamp';
export const NONCE_HEADER = 'nightmail-nonce';
export const SIGNATURE_HEADER = 'nightmail-signature';

export type RequestCredentials = { timestamp: number; nonce: Uint8Array; signature: Uint8Array };

/** `node:http` headers. A repeated header arrives as an array or comma-joined, and is rejected. */
export type IncomingHeaders = Record<string, string | string[] | undefined>;

const DECIMAL = /^(?:0|[1-9][0-9]{0,15})$/;
const lowercaseHex = (byteLength: number) => new RegExp(`^[0-9a-f]{${2 * byteLength}}$`);
const NONCE_HEX = lowercaseHex(REQUEST_NONCE_LENGTH);
const SIGNATURE_HEX = lowercaseHex(SIGNATURE_LENGTH);

/** Headers the client adds to a signed request. */
export function encodeAuthHeaders(credentials: RequestCredentials): Record<string, string> {
  return {
    [TIMESTAMP_HEADER]: String(credentials.timestamp),
    [NONCE_HEADER]: toHex(credentials.nonce),
    [SIGNATURE_HEADER]: toHex(credentials.signature),
  };
}

function header(headers: IncomingHeaders, name: string, format: RegExp): string | null {
  const value = headers[name];
  return typeof value === 'string' && format.test(value) ? value : null;
}

/** Reads the three headers. `null` if any is missing, repeated or not exactly in format. */
export function parseAuthHeaders(headers: IncomingHeaders): RequestCredentials | null {
  const timestamp = header(headers, TIMESTAMP_HEADER, DECIMAL);
  const nonce = header(headers, NONCE_HEADER, NONCE_HEX);
  const signature = header(headers, SIGNATURE_HEADER, SIGNATURE_HEX);
  if (timestamp === null || nonce === null || signature === null) return null;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds)) return null;
  return { timestamp: seconds, nonce: fromHex(nonce), signature: fromHex(signature) };
}

const HTTP_SCHEMES = new Set(['http:', 'https:']);

/**
 * The signed `host`: the authority of the server base URL, lowercase, with the port only if it is
 * not the scheme default (`http://NightMail.local:80/` → `nightmail.local`,
 * `http://127.0.0.1:8080` → `127.0.0.1:8080`, `https://[::1]:8443` → `[::1]:8443`). Matches
 * `host_str()` plus `port()` of Rust's `url` crate. Server and client each compute it from their own
 * config; it is never taken from the `Host` header. Throws `RequestEncodingError` if the URL is not
 * http(s) or its authority cannot be signed (e.g. a name containing `_`).
 */
export function canonicalHost(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new RequestEncodingError('host');
  }
  if (!HTTP_SCHEMES.has(url.protocol) || !isSignableHost(url.host)) throw new RequestEncodingError('host');
  return url.host;
}
