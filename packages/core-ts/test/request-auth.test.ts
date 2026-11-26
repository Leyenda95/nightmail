import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verify as rawVerify } from 'node:crypto';
import {
  ADDR_KEY_LENGTH, MAILBOX_API_VERSION, MAX_CLOCK_SKEW_SECONDS, REQUEST_AUTH_DOMAIN, REQUEST_NONCE_LENGTH,
  SIGNATURE_LENGTH, ed25519Sign, encodeRequest, isWithinTimeWindow, nonceRetentionDeadline, signRequest, verifyRequest,
} from '../src/request-auth.ts';
import type { MailboxRequest } from '../src/request-auth.ts';
import { ed25519PublicKey, publicKeyObject } from '../src/keys.ts';
import { fromHex, toHex } from '../src/bytes.ts';
import { ED25519_LOW_ORDER, TRIVIAL_SIGNATURE } from './fixtures.ts';

const authSk = fromHex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
const authPk = ed25519PublicKey(authSk);
const addrKey = fromHex('621068aeef170d87aab62215f32c563c6ef3d198cf39b86a0fb109c4d2046c54');
const base: MailboxRequest = {
  host: 'nightmail.local',
  version: 1,
  method: 'GET',
  path: `/v1/box/${toHex(addrKey)}/messages?since=0`,
  addrKey,
  timestamp: 1794873600,
  nonce: fromHex('000102030405060708090a0b0c0d0e0f'),
};
const hexOf = (s: string) => Buffer.from(s, 'utf8').toString('hex');

test('request signing constants', () => {
  assert.equal(REQUEST_AUTH_DOMAIN, 'nightmail:mailbox-api:v1');
  assert.equal(MAILBOX_API_VERSION, 1);
  assert.equal(ADDR_KEY_LENGTH, 32);
  assert.equal(REQUEST_NONCE_LENGTH, 16);
  assert.equal(SIGNATURE_LENGTH, 64);
  assert.equal(MAX_CLOCK_SKEW_SECONDS, 60);
});

test('encodeRequest: domain ‖ host ‖ version ‖ method ‖ path ‖ addrKey ‖ timestamp ‖ nonce', () => {
  const expected = [
    hexOf('nightmail:mailbox-api:v1'),
    '000f', hexOf('nightmail.local'),
    '01',
    '0003', hexOf('GET'),
    '0059', hexOf(base.path),
    toHex(addrKey),
    '000000006afb9900',
    '000102030405060708090a0b0c0d0e0f',
  ].join('');
  const encoded = encodeRequest(base);
  assert.equal(toHex(encoded), expected);
  assert.equal(base.path.length, 0x59);
  assert.equal(encoded.length, 24 + 2 + 15 + 1 + 2 + 3 + 2 + 89 + 32 + 8 + 16);
  assert.ok(!Buffer.isBuffer(encoded));
});

test('encodeRequest is unambiguous: moving a character between fields changes the encoding', () => {
  const a = encodeRequest({ ...base, host: 'ab', path: '/c' });
  const b = encodeRequest({ ...base, host: 'a', path: '/bc' });
  assert.notEqual(toHex(a), toHex(b));
  const c = encodeRequest({ ...base, host: 'a.b', method: 'GETX' });
  const d = encodeRequest({ ...base, host: 'a.bg', method: 'ETX' });
  assert.notEqual(toHex(c), toHex(d));
});

test('encodeRequest accepts the limits of each field', () => {
  const ok: Partial<MailboxRequest>[] = [
    { host: '127.0.0.1:8443' }, { host: '[::1]:8080' }, { host: 'a' }, { host: 'a'.repeat(255) }, { host: 'xn--maana-pta.example' },
    { version: 0 }, { version: 255 },
    { method: 'A' }, { method: 'A'.repeat(16) },
    { path: '/' }, { path: `/${'a'.repeat(2047)}` }, { path: '/aZ09/._~-?b=c&d=%20' },
    // Dots that do not form a `.` or `..` segment, and anything after `?`, are allowed.
    { path: '/.well-known/x' }, { path: '/a/...' }, { path: '/a/..b' }, { path: '/a/b..' }, { path: '/a/.%2e.' },
    { path: '/a.b/c' }, { path: '/a?next=/../x' }, { path: '/a?..' }, { path: '/a?x=.' }, { path: '/a/%2f..' },
    { timestamp: 0 }, { timestamp: Number.MAX_SAFE_INTEGER },
  ];
  for (const change of ok) assert.doesNotThrow(() => encodeRequest({ ...base, ...change }), JSON.stringify(change).slice(0, 60));
  assert.equal(toHex(encodeRequest({ ...base, path: `/${'a'.repeat(2047)}` }).subarray(47, 49)), '0800');
});

test('encodeRequest rejects non-canonical fields, with an error that names the field but not its value', () => {
  const bad: [string, Partial<MailboxRequest>][] = [
    ['host', { host: '' }], ['host', { host: 'NightMail.local' }], ['host', { host: 'a'.repeat(256) }],
    ['host', { host: 'nightmail.local/x' }], ['host', { host: 'correo ñ' }], ['host', { host: 'a b' }],
    ['host', { host: 'a\nb' }], ['host', { host: 'nightmail.local\n' }], ['host', { host: 'user@host' }],
    ['version', { version: 256 }], ['version', { version: -1 }], ['version', { version: 1.5 }],
    ['method', { method: '' }], ['method', { method: 'get' }], ['method', { method: 'GET ' }],
    ['method', { method: 'A'.repeat(17) }], ['method', { method: 'GE-T' }], ['method', { method: 'GET\n' }],
    ['path', { path: '' }], ['path', { path: 'v1/box' }], ['path', { path: '/a b' }], ['path', { path: '/ñ' }],
    ['path', { path: '/a\n' }], ['path', { path: '/a\u007f' }], ['path', { path: `/${'a'.repeat(2048)}` }], ['path', { path: 'x/' }],
    ['path', { path: '/..' }], ['path', { path: '/.' }], ['path', { path: '/a/../b' }], ['path', { path: '/a/./b' }],
    ['path', { path: '/a/..' }], ['path', { path: '/a/.' }], ['path', { path: '/../a' }], ['path', { path: '/./a' }],
    ['path', { path: '/a/%2e%2e/b' }], ['path', { path: '/a/%2E%2E/b' }], ['path', { path: '/a/.%2e/b' }], ['path', { path: '/a/%2e./b' }],
    ['path', { path: '/a/%2e/b' }], ['path', { path: '/a/%2E' }], ['path', { path: '/a/..?x=1' }], ['path', { path: '/a/.?x=1' }],
    ['path', { path: '/%2e%2e?a/b' }],
    ...[...'!#$\'()*+,:;@[]^`{|}"<>\\'].map((c): [string, Partial<MailboxRequest>] => ['path', { path: `/a${c}b` }]),
    ['addrKey', { addrKey: new Uint8Array(31) }], ['addrKey', { addrKey: new Uint8Array(33) }],
    ['timestamp', { timestamp: -1 }], ['timestamp', { timestamp: 1.5 }], ['timestamp', { timestamp: 2 ** 53 }],
    ['nonce', { nonce: new Uint8Array(15) }], ['nonce', { nonce: new Uint8Array(17) }], ['nonce', { nonce: new Uint8Array(0) }],
  ];
  for (const [field, change] of bad) {
    assert.throws(
      () => encodeRequest({ ...base, ...change }),
      { name: 'RequestEncodingError', field, message: `invalid field: ${field}` },
      `${field}: ${JSON.stringify(change).slice(0, 60)}`,
    );
  }
});

test('signRequest is pure Ed25519 over the canonical encoding (deterministic, 64 bytes)', () => {
  const signature = signRequest(authSk, base);
  assert.equal(signature.length, 64);
  assert.ok(!Buffer.isBuffer(signature));
  assert.equal(toHex(signRequest(authSk, base)), toHex(signature));
  assert.ok(rawVerify(null, encodeRequest(base), publicKeyObject('ed25519', authPk), signature));
});

test('the Ed25519 signature reproduces RFC 8032 §7.1 (test 2)', () => {
  const seed = fromHex('4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb');
  assert.equal(
    toHex(ed25519Sign(seed, fromHex('72'))),
    '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00',
  );
});

test('verifyRequest accepts the correct signature', () => {
  assert.equal(verifyRequest(authPk, base, signRequest(authSk, base)), true);
  const other = { ...base, method: 'DELETE', path: '/v1/box/x/messages/42', timestamp: 0 };
  assert.equal(verifyRequest(authPk, other, signRequest(authSk, other)), true);
});

test('verifyRequest rejects if any signed field changes', () => {
  const signature = signRequest(authSk, base);
  const changes: Partial<MailboxRequest>[] = [
    { host: 'nightmail.locam' }, { host: 'otro.local' }, { version: 2 }, { method: 'POST' },
    { path: `${base.path}0` }, { path: '/v1/box' },
    { addrKey: fromHex('621068aeef170d87aab62215f32c563c6ef3d198cf39b86a0fb109c4d2046c55') },
    { timestamp: base.timestamp + 1 }, { timestamp: base.timestamp - 1 },
    { nonce: fromHex('000102030405060708090a0b0c0d0e10') },
  ];
  for (const change of changes) {
    assert.equal(verifyRequest(authPk, { ...base, ...change }, signature), false, JSON.stringify(change).slice(0, 60));
  }
});

test('verifyRequest rejects altered signatures, signatures from another key or of the wrong length', () => {
  const signature = signRequest(authSk, base);
  for (const offset of [0, 31, 32, 63]) {
    const altered = Uint8Array.from(signature);
    altered[offset]! ^= 0x01;
    assert.equal(verifyRequest(authPk, base, altered), false, `byte ${offset}`);
  }
  const otherSk = fromHex('4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb');
  assert.equal(verifyRequest(authPk, base, signRequest(otherSk, base)), false);
  assert.equal(verifyRequest(ed25519PublicKey(otherSk), base, signature), false);
  for (const length of [0, 63, 65, 128]) {
    assert.equal(verifyRequest(authPk, base, new Uint8Array(length)), false, `signature of ${length}`);
  }
  assert.equal(verifyRequest(authPk, base, signature.subarray(0, 63)), false);
  assert.equal(verifyRequest(authPk, base, Uint8Array.from([...signature, 0])), false);
});

test('verifyRequest rejects a non-canonical S (S + L)', () => {
  const signature = signRequest(authSk, base);
  const L = 2n ** 252n + 27742317777372353535851937790883648493n;
  let s = 0n;
  for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(signature[i]!);
  let malleable = s + L;
  const altered = Uint8Array.from(signature);
  for (let i = 32; i < 64; i++) { altered[i] = Number(malleable & 0xffn); malleable >>= 8n; }
  assert.notEqual(toHex(altered), toHex(signature));
  assert.equal(verifyRequest(authPk, base, altered), false);
});

test('verifyRequest returns false, without throwing, on malformed inputs', () => {
  const signature = signRequest(authSk, base);
  assert.equal(verifyRequest(authPk.subarray(0, 31), base, signature), false);
  assert.equal(verifyRequest(new Uint8Array(0), base, signature), false);
  assert.equal(verifyRequest(authPk, { ...base, host: 'MAYUS' }, signature), false);
  assert.equal(verifyRequest(authPk, { ...base, nonce: new Uint8Array(3) }, signature), false);
  assert.equal(verifyRequest(fromHex('02'.padEnd(64, '0')), base, signature), false);
  // Values of the wrong type (e.g. from unvalidated JSON).
  const untyped = (change: Record<string, unknown>) => ({ ...base, ...change }) as MailboxRequest;
  assert.throws(() => encodeRequest(untyped({ host: 127 })), { name: 'RequestEncodingError', field: 'host' });
  assert.throws(() => encodeRequest(untyped({ method: 7 })), { name: 'RequestEncodingError', field: 'method' });
  assert.throws(() => encodeRequest(untyped({ version: '1' })), { name: 'RequestEncodingError', field: 'version' });
  assert.throws(() => encodeRequest(untyped({ timestamp: '1794873600' })), { name: 'RequestEncodingError', field: 'timestamp' });
  assert.throws(() => encodeRequest(untyped({ nonce: '0'.repeat(16) })), { name: 'RequestEncodingError', field: 'nonce' });
  assert.throws(() => encodeRequest(untyped({ addrKey: Array(32).fill(0) })), { name: 'RequestEncodingError', field: 'addrKey' });
  assert.equal(verifyRequest(authPk, untyped({ host: 127 }), signature), false);
});

test('verifyRequest rejects a key with a non-canonical y', () => {
  const signature = signRequest(authSk, base);
  assert.equal(verifyRequest(fromHex(`f0${'ff'.repeat(30)}7f`), base, signature), false);
  assert.equal(verifyRequest(fromHex(`f0${'ff'.repeat(31)}`), base, signature), false);
});

test('verifyRequest rejects low-order keys even though OpenSSL accepts the trivial signature', () => {
  let demonstrated = 0;
  for (const hex of ED25519_LOW_ORDER) {
    const lowKey = fromHex(hex);
    for (let t = 0; t < 200; t++) {
      const request = { ...base, timestamp: t };
      assert.equal(verifyRequest(lowKey, request, TRIVIAL_SIGNATURE), false, hex);
      if (rawVerify(null, encodeRequest(request), publicKeyObject('ed25519', lowKey), TRIVIAL_SIGNATURE)) demonstrated++;
    }
  }
  assert.ok(demonstrated >= ED25519_LOW_ORDER.length, 'without the list, these forged signatures would be accepted');
});

test('isWithinTimeWindow: ±60 s tolerance, bounds included', () => {
  const now = 1794873600;
  for (const delta of [0, 1, -1, 59, -59, 60, -60]) assert.equal(isWithinTimeWindow(now + delta, now), true, String(delta));
  for (const delta of [61, -61, 3600, -3600]) assert.equal(isWithinTimeWindow(now + delta, now), false, String(delta));
  assert.equal(isWithinTimeWindow(now + 5, now, 5), true);
  assert.equal(isWithinTimeWindow(now - 5, now, 5), true);
  assert.equal(isWithinTimeWindow(now + 6, now, 5), false);
  assert.equal(isWithinTimeWindow(now, now, 0), true);
  assert.equal(isWithinTimeWindow(now + 1, now, 0), false);
});

test('isWithinTimeWindow rejects values that are not safe integers, or a negative tolerance', () => {
  const now = 1794873600;
  assert.equal(isWithinTimeWindow(Number.NaN, now), false);
  assert.equal(isWithinTimeWindow(now, Number.NaN), false);
  assert.equal(isWithinTimeWindow(now + 0.5, now), false);
  assert.equal(isWithinTimeWindow(now, now + 0.5), false);
  assert.equal(isWithinTimeWindow(now, now, Number.NaN), false);
  assert.equal(isWithinTimeWindow(now, now, 0.5), false);
  assert.equal(isWithinTimeWindow(now, now, -1), false);
  assert.equal(isWithinTimeWindow(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY), false);
  assert.equal(isWithinTimeWindow(-1, 0), false, 'a negative timestamp cannot be signed');
});

test('nonceRetentionDeadline: the nonce is remembered while the request is still inside the window', () => {
  const t = 1794873600;
  assert.equal(nonceRetentionDeadline(t), t + 60);
  assert.equal(nonceRetentionDeadline(t, 5), t + 5);
  // Consistent with the window: valid up to the deadline (inclusive), not after.
  assert.equal(isWithinTimeWindow(t, nonceRetentionDeadline(t)), true);
  assert.equal(isWithinTimeWindow(t, nonceRetentionDeadline(t) + 1), false);
});
