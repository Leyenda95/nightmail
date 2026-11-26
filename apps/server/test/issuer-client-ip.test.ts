import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { clientAddress, clientKey, ipKey, isLoopback } from '../src/issuer/client-ip.ts';

const req = (remoteAddress: string | undefined, xff?: string | string[]) =>
  ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress } }) as unknown as IncomingMessage;

test('ipKey: IPv4 as is, IPv4-mapped IPv6 as IPv4', () => {
  assert.equal(ipKey('203.0.113.7'), '203.0.113.7');
  assert.equal(ipKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(ipKey('::FFFF:203.0.113.7'), '203.0.113.7');
});

test('ipKey: IPv6 by its /64 (a client whole network counts as one), in canonical form', () => {
  const key = '2001:db8:1:2::/64';
  assert.equal(ipKey('2001:db8:1:2::1'), key);
  assert.equal(ipKey('2001:0DB8:0001:0002:ffff:ffff:ffff:ffff'), key);
  assert.equal(ipKey('2001:db8:1:2:3:4:5.6.7.8'), key);
  assert.equal(ipKey('2001:db8:1::'), '2001:db8:1:0::/64');
  assert.equal(ipKey('::1'), '0:0:0:0::/64');
  assert.equal(ipKey('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.notEqual(ipKey('2001:db8:1:3::1'), key);
});

test('ipKey: anything that is not an IP is left as is (does not break the limit)', () => {
  assert.equal(ipKey(''), '');
  assert.equal(ipKey('no-es-ip'), 'no-es-ip');
});

test('clientKey without a trusted proxy: the socket IP, ignoring X-Forwarded-For', () => {
  const key = clientKey(false);
  assert.equal(key(req('198.51.100.1', '203.0.113.9')), '198.51.100.1');
  assert.equal(key(req(undefined)), '');
});

test('clientKey with a trusted proxy: the LAST X-Forwarded-For entry (the one the proxy added)', () => {
  const key = clientKey(true);
  assert.equal(key(req('127.0.0.1', '6.6.6.6, 203.0.113.9')), '203.0.113.9');
  assert.equal(key(req('127.0.0.1', '6.6.6.6,2001:db8:1:2::9 ')), '2001:db8:1:2::/64');
  assert.equal(key(req('127.0.0.1', ['6.6.6.6', '203.0.113.10'])), '203.0.113.10');
});

test('clientKey with a trusted proxy: without the header or with an entry that is not an IP, the socket one', () => {
  const key = clientKey(true);
  assert.equal(key(req('127.0.0.1')), '127.0.0.1');
  assert.equal(key(req('127.0.0.1', '203.0.113.9, basura')), '127.0.0.1');
  assert.equal(key(req('127.0.0.1', '')), '127.0.0.1');
});

test('ipKey with a shorter IPv6 prefix: the bits past it are cleared, IPv4 is unaffected', () => {
  assert.equal(ipKey('2001:db8:1:2ff::1', 56), '2001:db8:1:200::/56');
  assert.equal(ipKey('2001:db8:1:200::1', 56), '2001:db8:1:200::/56');
  assert.notEqual(ipKey('2001:db8:1:300::1', 56), '2001:db8:1:200::/56');
  assert.equal(ipKey('2001:db8:abcd:1234::1', 48), '2001:db8:abcd::/48');
  assert.equal(ipKey('2001:db8:1:2::1', 64), ipKey('2001:db8:1:2::1'), '64 by default');
  assert.equal(ipKey('203.0.113.7', 56), '203.0.113.7');
  for (const bits of [0, 65, 1.5]) assert.throws(() => ipKey('::1', bits), RangeError, String(bits));
});

test('clientAddress: the same choice as clientKey, before keying (an IPv6 is given whole)', () => {
  assert.equal(clientAddress(false)(req('2001:db8:1:2::9', '203.0.113.9')), '2001:db8:1:2::9');
  assert.equal(clientAddress(true)(req('127.0.0.1', '6.6.6.6, 2001:db8:1:2::9')), '2001:db8:1:2::9');
  assert.equal(clientAddress(true)(req('127.0.0.1', 'basura')), '127.0.0.1');
  assert.equal(clientAddress(true)(req(undefined)), '');
});

test('isLoopback', () => {
  for (const host of ['127.0.0.1', '127.1.2.3', '::1', 'localhost']) assert.equal(isLoopback(host), true, host);
  for (const host of ['0.0.0.0', '::', '192.168.1.2', '2001:db8::1']) assert.equal(isLoopback(host), false, host);
});

test('ipKey: what follows "::" counts (the groups on the right are placed after the zeros of the gap)', () => {
  assert.equal(ipKey('1::2:3:4:5:6:7'), '1:0:2:3::/64');
  assert.equal(ipKey('1:2::3:4:5:6'), '1:2:0:0::/64');
  assert.equal(ipKey('1:2:3::4:5'), '1:2:3:0::/64');
  assert.equal(ipKey('::2:3:4:5:6:7:8'), '0:2:3:4::/64');
});
