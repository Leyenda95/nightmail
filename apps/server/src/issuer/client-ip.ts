// Client key for per-IP rate limits (memory only; never written to disk or logs).
//
// Behind a trusted proxy (NIGHTMAIL_ISSUER_TRUSTED_PROXY=1, NIGHTMAIL_RELAYER_TRUSTED_PROXY=1 or
// NIGHTMAIL_API_TRUSTED_PROXY=1) the real IP is the last X-Forwarded-For entry, the one the proxy itself
// appends (earlier ones are client-controlled). Without a trusted proxy the header is ignored. IPv6 is keyed
// by its /64, since a client usually controls the whole network.
import type { IncomingMessage } from 'node:http';
import { isIP, isIPv6 } from 'node:net';

const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** The eight 16-bit groups of an IPv6 address (zone stripped), with a trailing IPv4 counted as two groups. */
function hextets(address: string): string[] {
  const plain = address.replace(/%.*$/, '').replace(/\d+\.\d+\.\d+\.\d+$/, '0:0');
  const [head = '', tail] = plain.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const zeros: string[] = Array(8 - left.length - right.length).fill('0');
  return [...left, ...zeros, ...right];
}

/** Key for an address: IPv4 as-is (including IPv4-mapped IPv6), IPv6 by its prefix (/64 unless given, 1 to 64 bits). */
export function ipKey(address: string, v6PrefixBits = 64): string {
  if (!Number.isInteger(v6PrefixBits) || v6PrefixBits < 1 || v6PrefixBits > 64) throw new RangeError('ipKey: prefix of 1 to 64 bits');
  const mapped = MAPPED_V4.exec(address);
  if (mapped) return mapped[1]!;
  if (!isIPv6(address)) return address;
  const prefix = hextets(address).slice(0, Math.ceil(v6PrefixBits / 16)).map((h, i) => {
    const bits = Math.min(16, v6PrefixBits - 16 * i);
    return (parseInt(h, 16) & (0xffff << (16 - bits)) & 0xffff).toString(16);
  });
  return `${prefix.join(':')}::/${v6PrefixBits}`;
}

/** The last X-Forwarded-For entry if it is an IP, else undefined. */
function forwardedFor(req: IncomingMessage): string | undefined {
  const header = req.headers['x-forwarded-for'];
  const value = Array.isArray(header) ? header.join(',') : header;
  const last = value?.split(',').pop()?.trim() ?? '';
  return isIP(last) === 0 ? undefined : last;
}

/** The client's IP as given: the socket's, or behind a trusted proxy the last X-Forwarded-For entry if it is an IP. */
export function clientAddress(trustProxy: boolean): (req: IncomingMessage) => string {
  return (req) => (trustProxy ? forwardedFor(req) : undefined) ?? req.socket.remoteAddress ?? '';
}

export function clientKey(trustProxy: boolean): (req: IncomingMessage) => string {
  const address = clientAddress(trustProxy);
  return (req) => ipKey(address(req));
}

/** Whether the host is local-only (which almost certainly means a proxy sits in front). */
export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}
