import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NONCE_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, canonicalHost, encodeAuthHeaders, parseAuthHeaders,
} from '../src/transport.ts';
import { encodeRequest } from '../src/request-auth.ts';
import { fromHex, toHex } from '../src/bytes.ts';

const nonce = fromHex('000102030405060708090a0b0c0d0e0f');
const signature = fromHex('ab'.repeat(64));
const good = {
  'nightmail-timestamp': '1794873600',
  'nightmail-nonce': '000102030405060708090a0b0c0d0e0f',
  'nightmail-signature': 'ab'.repeat(64),
};

test('header names, in lowercase as node:http delivers them', () => {
  assert.equal(TIMESTAMP_HEADER, 'nightmail-timestamp');
  assert.equal(NONCE_HEADER, 'nightmail-nonce');
  assert.equal(SIGNATURE_HEADER, 'nightmail-signature');
});

test('encodeAuthHeaders: decimal timestamp and lowercase hex', () => {
  assert.deepEqual(encodeAuthHeaders({ timestamp: 1794873600, nonce, signature }), good);
  assert.equal(encodeAuthHeaders({ timestamp: 0, nonce, signature })[TIMESTAMP_HEADER], '0');
  assert.equal(encodeAuthHeaders({ timestamp: Number.MAX_SAFE_INTEGER, nonce, signature })[TIMESTAMP_HEADER], '9007199254740991');
});

test('parseAuthHeaders: round trip, ignoring other headers', () => {
  const parsed = parseAuthHeaders({ ...good, host: 'x', 'content-type': 'text/plain' });
  assert.ok(parsed);
  assert.equal(parsed.timestamp, 1794873600);
  assert.equal(toHex(parsed.nonce), toHex(nonce));
  assert.equal(toHex(parsed.signature), toHex(signature));
  assert.equal(parseAuthHeaders({ ...good, 'nightmail-timestamp': '0' })!.timestamp, 0);
  assert.equal(parseAuthHeaders({ ...good, 'nightmail-timestamp': '9007199254740991' })!.timestamp, Number.MAX_SAFE_INTEGER);
});

test('parseAuthHeaders rejects anything not in exactly the right format', () => {
  const bad: [string, string | string[] | undefined][] = [
    // timestamp: strict decimal
    [TIMESTAMP_HEADER, undefined], [TIMESTAMP_HEADER, ''], [TIMESTAMP_HEADER, '01'], [TIMESTAMP_HEADER, '00'],
    [TIMESTAMP_HEADER, '+1'], [TIMESTAMP_HEADER, '-1'], [TIMESTAMP_HEADER, '1.0'], [TIMESTAMP_HEADER, '1e3'],
    [TIMESTAMP_HEADER, ' 1'], [TIMESTAMP_HEADER, '1 '], [TIMESTAMP_HEADER, '0x10'], [TIMESTAMP_HEADER, '1794873600, 1794873600'],
    [TIMESTAMP_HEADER, '9007199254740992'], [TIMESTAMP_HEADER, '9999999999999999'], [TIMESTAMP_HEADER, '10000000000000000'],
    [TIMESTAMP_HEADER, ['1794873600', '1794873600']], [TIMESTAMP_HEADER, '١٢٣'],
    // nonce: 32 lowercase hex digits
    [NONCE_HEADER, undefined], [NONCE_HEADER, ''], [NONCE_HEADER, '000102030405060708090A0B0C0D0E0F'],
    [NONCE_HEADER, '000102030405060708090a0b0c0d0e'], [NONCE_HEADER, '000102030405060708090a0b0c0d0e0f00'],
    [NONCE_HEADER, '0x0102030405060708090a0b0c0d0e0f'], [NONCE_HEADER, ' 00102030405060708090a0b0c0d0e0f'],
    [NONCE_HEADER, '000102030405060708090a0b0c0d0e0g'], [NONCE_HEADER, [good[NONCE_HEADER]]],
    // signature: 128 lowercase hex digits
    [SIGNATURE_HEADER, undefined], [SIGNATURE_HEADER, 'ab'.repeat(63)], [SIGNATURE_HEADER, 'ab'.repeat(65)],
    [SIGNATURE_HEADER, 'AB'.repeat(64)], [SIGNATURE_HEADER, `${'ab'.repeat(63)}a`], [SIGNATURE_HEADER, `${'ab'.repeat(64)}\n`],
  ];
  for (const [name, value] of bad) {
    assert.equal(parseAuthHeaders({ ...good, [name]: value }), null, `${name}: ${JSON.stringify(value)}`);
  }
  assert.equal(parseAuthHeaders({}), null);
});

test('canonicalHost: authority of the base URL, with the port only if it is not the scheme default', () => {
  const cases: [string, string][] = [
    ['http://nightmail.local:2526', 'nightmail.local:2526'],
    ['http://nightmail.local:2526/', 'nightmail.local:2526'],
    ['http://NightMail.Local:80/', 'nightmail.local'],
    ['https://nightmail.local:443', 'nightmail.local'],
    ['https://nightmail.local:80', 'nightmail.local:80'],
    ['http://nightmail.local:443/v1', 'nightmail.local:443'],
    ['http://127.0.0.1:8080', '127.0.0.1:8080'],
    ['https://[::1]:8443/', '[::1]:8443'],
    ['http://[::1]', '[::1]'],
    ['https://usuario:clave@nightmail.local/x?y=1#z', 'nightmail.local'],
  ];
  for (const [baseUrl, host] of cases) {
    assert.equal(canonicalHost(baseUrl), host, baseUrl);
    // The result is always a signable `host`.
    assert.doesNotThrow(() => encodeRequest({
      host: canonicalHost(baseUrl), version: 1, method: 'GET', path: '/', addrKey: new Uint8Array(32), timestamp: 0, nonce,
    }));
  }
});

test('canonicalHost rejects an authority that could not be signed', () => {
  for (const bad of ['http://mail_server:8080', 'http://mail_server', `http://${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.example:8080`]) {
    assert.throws(() => canonicalHost(bad), { name: 'RequestEncodingError', field: 'host' }, bad);
  }
});

test('canonicalHost rejects anything that is not an http(s) URL', () => {
  for (const bad of ['', 'nightmail.local', 'nightmail.local:2526', '/v1', 'ftp://nightmail.local', 'file:///etc/passwd', 'http://', 'ws://nightmail.local']) {
    assert.throws(() => canonicalHost(bad), { name: 'RequestEncodingError', field: 'host' }, bad);
  }
});
