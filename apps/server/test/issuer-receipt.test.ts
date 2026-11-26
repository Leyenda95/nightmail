import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPublicKey, verify } from 'node:crypto';
import { createReceiptSigner, receiptMessage, SPKI_PREFIX, type ReceiptFields } from '../src/issuer/receipt.ts';

const ID = '01'.repeat(32);
const CONTRACT = 'c0'.repeat(32);
const DOMAIN = Buffer.from('nightmail/bono-receipt/v2\0');

const fields = (over: Partial<ReceiptFields> = {}): ReceiptFields => ({
  contract: CONTRACT, id: ID, plan: 'paid', period: 'monthly', insertBy: 0x0102030405060708n, ...over,
});

const keyOf = (publicKey: Buffer) => createPublicKey({ key: Buffer.concat([SPKI_PREFIX, publicKey]), format: 'der', type: 'spki' });

test('receiptMessage v2: domain, contract, id, plan byte, period byte and deadline as big-endian u64', () => {
  const message = receiptMessage(fields());
  const at = DOMAIN.length;
  assert.deepEqual(message.subarray(0, at), DOMAIN);
  assert.equal(message.length, at + 32 + 32 + 1 + 1 + 8);
  assert.equal(message.subarray(at, at + 32).toString('hex'), CONTRACT);
  assert.equal(message.subarray(at + 32, at + 64).toString('hex'), ID);
  assert.deepEqual([message[at + 64], message[at + 65]], [1, 1]);
  assert.equal(message.subarray(-8).toString('hex'), '0102030405060708');
  const free = receiptMessage(fields({ plan: 'free', period: 'none' }));
  assert.deepEqual([free[at + 64], free[at + 65]], [0, 0]);
  assert.equal(receiptMessage(fields({ period: 'annual' }))[at + 65], 2);
});

test('createReceiptSigner: signs bound to the contract, verifies and is not valid for another contract, period or deadline', () => {
  const signer = createReceiptSigner(Buffer.alloc(32, 7), CONTRACT);
  assert.equal(signer.contract, CONTRACT);
  const signature = signer.sign({ id: ID, plan: 'paid', period: 'annual', insertBy: 1_000n });
  assert.equal(signature.length, 64);
  const key = keyOf(signer.publicKey);
  const ok = fields({ period: 'annual', insertBy: 1_000n });
  assert.equal(verify(null, receiptMessage(ok), key, signature), true);
  assert.equal(verify(null, receiptMessage({ ...ok, contract: 'c1'.repeat(32) }), key, signature), false);
  assert.equal(verify(null, receiptMessage({ ...ok, period: 'monthly' }), key, signature), false);
  assert.equal(verify(null, receiptMessage({ ...ok, insertBy: 1_001n }), key, signature), false);
  assert.equal(verify(null, receiptMessage({ ...ok, plan: 'free' }), key, signature), false);
});

test('createReceiptSigner: deterministic (Ed25519) and the same seed gives the same public key', () => {
  const a = createReceiptSigner(Buffer.alloc(32, 7), CONTRACT);
  const b = createReceiptSigner(Buffer.alloc(32, 7), CONTRACT);
  const r = { id: ID, plan: 'free', period: 'none', insertBy: 5n } as const;
  assert.deepEqual(a.publicKey, b.publicKey);
  assert.deepEqual(a.sign(r), b.sign(r));
  assert.notDeepEqual(a.publicKey, createReceiptSigner(Buffer.alloc(32, 8), CONTRACT).publicKey);
});

test('createReceiptSigner: the seed must be 32 bytes and the contract 32 bytes in lowercase hex', () => {
  assert.throws(() => createReceiptSigner(Buffer.alloc(31), CONTRACT), RangeError);
  for (const contract of ['C0'.repeat(32), 'c0'.repeat(31), '', 'zz'.repeat(32)]) {
    assert.throws(() => createReceiptSigner(Buffer.alloc(32), contract), RangeError, contract);
  }
});

type Vector = { contract: string; id: string; plan: 'free' | 'paid'; period: 'none' | 'monthly' | 'annual'; insertBy: string; message: string; signature: string };

test('vector from packages/test-vectors/issuer/receipt-v2.json: same message, same key and same signature', () => {
  const file = new URL('../../../packages/test-vectors/issuer/receipt-v2.json', import.meta.url);
  const vectors = JSON.parse(readFileSync(file, 'utf8')) as { constants: { domain: string }; seed: string; publicKey: string; valid: Vector[] };
  assert.equal(`${vectors.constants.domain}\0`, DOMAIN.toString('utf8'));
  assert.ok(vectors.valid.length >= 3);
  for (const v of vectors.valid) {
    const signer = createReceiptSigner(Buffer.from(vectors.seed, 'hex'), v.contract);
    assert.equal(signer.publicKey.toString('hex'), vectors.publicKey);
    const r = { id: v.id, plan: v.plan, period: v.period, insertBy: BigInt(v.insertBy) };
    assert.equal(receiptMessage({ ...r, contract: v.contract }).toString('hex'), v.message);
    assert.equal(signer.sign(r).toString('hex'), v.signature);
  }
});
