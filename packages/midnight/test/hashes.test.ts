// The package hashes reproduce the contract vectors exactly
// (packages/test-vectors/contract/registry.json), shared by the app, the server and the sidecar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  addrKey, aliasAddrKey, ctx, idK, InvalidInput, Kind, leaf, nameBytes, NAME_BYTES, NO_EXPIRY, normalizeName,
  Plan, slotNul, toHex,
} from '../src/index.ts';

const v = JSON.parse(readFileSync(new URL('../../test-vectors/contract/registry.json', import.meta.url), 'utf8'));
const b = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));
const i = v.inputs;
const c = ctx(i.contractAddress);

test('ctx is the contract address', () => {
  assert.equal(toHex(c), v.ctx);
});

test('idK, leaf and slotNul reproduce the vectors', () => {
  const id = idK(c, b(i.s), BigInt(i.k));
  assert.equal(toHex(id), v.bonoId);
  assert.equal(toHex(leaf(c, id, Plan.free, NO_EXPIRY)), v.bonoLeafFree);
  assert.equal(toHex(leaf(c, id, Plan.paid, NO_EXPIRY)), v.bonoLeafPaid);
  assert.equal(toHex(slotNul(c, b(i.s), Kind.mailbox, BigInt(i.mailboxSlot), 0n)), v.slotNullifierMailbox3);
  assert.equal(toHex(slotNul(c, b(i.s), Kind.alias, BigInt(i.mailboxSlot), 0n)), v.slotNullifierAlias3);
  assert.equal(toHex(slotNul(c, b(i.s), Kind.mailbox, BigInt(i.mailboxSlot), 1n)), v.slotNullifierMailbox3Gen1);
  assert.equal(NO_EXPIRY.toString(), v.noExpiry);
});

test('addrKey and aliasAddrKey reproduce the vectors', () => {
  const key = addrKey('juan.perez');
  assert.equal(toHex(key), v.addressKey);
  const aliasNul = slotNul(c, b(i.s), Kind.alias, 3n, 0n);
  assert.equal(toHex(aliasAddrKey(b(i.encPk), b(i.authPk), aliasNul)), v.aliasKey);
});

test('addrKey normalizes before hashing: upper and lower case are the same mailbox', () => {
  assert.equal(toHex(addrKey('Juan.Perez')), v.addressKey);
  assert.equal(toHex(addrKey('JUAN.PEREZ')), v.addressKey);
});

test('normalizeName and nameBytes: ASCII lowercase, zero-padded to 64 bytes', () => {
  assert.equal(normalizeName('Juan.Perez'), 'juan.perez');
  const n = nameBytes('Juan.Perez');
  assert.equal(n.length, NAME_BYTES);
  assert.equal(Buffer.from(n.subarray(0, 10)).toString(), 'juan.perez');
  assert.ok(n.subarray(10).every((x) => x === 0));
  assert.equal(nameBytes('a'.repeat(64)).at(-1), 'a'.charCodeAt(0), 'a 64-byte name fits');
  for (const ok of ['a', 'a-b', 'a_b', 'a.b', '0', 'x9']) assert.doesNotThrow(() => normalizeName(ok), ok);
});

test('normalizeName rejects what is not a valid name (without silently fixing it)', () => {
  const bad = [
    '', 'a'.repeat(65), 'juan perez', 'juan..perez', '.juan', 'juan.', '-juan', 'juan-', 'juan+news',
    'josé', 'juan@x', 'ñ', 'Kelvin', // Kelvin sign: toLowerCase would turn it into an ASCII k
    'a\u0000', 'juan\n',
    'a.-b', 'a--b', 'a__b', 'a_.b', 'a-_b', // two consecutive separators of any kind
  ];
  for (const name of bad) assert.throws(() => normalizeName(name), InvalidInput, JSON.stringify(name));
  assert.throws(() => normalizeName(42 as unknown as string), InvalidInput);
});

test('hash inputs are validated: contract lengths and ranges', () => {
  const s = b(i.s);
  assert.throws(() => ctx('AD'.repeat(32)), InvalidInput, 'uppercase hex');
  assert.throws(() => ctx('ad'.repeat(31)), InvalidInput, '31 bytes');
  assert.throws(() => idK(c, s.subarray(1), 0n), InvalidInput, '31-byte s');
  assert.throws(() => idK(c, s, 2n ** 32n), InvalidInput, 'k does not fit in Uint<32>');
  assert.throws(() => idK(c, s, -1n), InvalidInput);
  assert.throws(() => slotNul(c, s, Kind.alias, 256n, 0n), InvalidInput, 'j does not fit in Uint<8>');
  assert.throws(() => slotNul(c, s, 2 as Kind, 0n, 0n), InvalidInput, 'kind desconocido');
  assert.throws(() => leaf(c, s, 2 as Plan, 0n), InvalidInput, 'plan desconocido');
  assert.throws(() => leaf(c, s, Plan.free, 2n ** 32n), InvalidInput, 'validUntil does not fit in Uint<32>');
  assert.throws(() => aliasAddrKey(s, s, new Uint8Array(33)), InvalidInput);
  assert.doesNotThrow(() => idK(c, s, 2n ** 32n - 1n));
  assert.doesNotThrow(() => slotNul(c, s, Kind.alias, 255n, 2n ** 32n - 1n));
});
