// NightMailRegistry tests on the local devnet (npm run test:devnet -w apps/server).
// What the simulator cannot check: real ZK proofs, timings, and what happens on chain when a transaction
// fails there (races): it must not burn slots or charge without issuing.
// Deploys fresh contracts on every run (keys in memory; contracts.json is untouched).
// Needs the devnet running, the contracts compiled with keys and the payer stopped.
// The tests share contract and tree, so they run serially (--test-concurrency=1); do not enable
// concurrency.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../src/config.ts';
import { ensureSpendableDust, openOperatorWallet, type OperatorWallet } from '../src/wallet/operatorWallet.ts';
import { isNodeRejection, newSigningKey, openChain, type Chain, type ChainContract, type Outcome } from '../src/chain/midnight.ts';
import { registryWitnesses, type Bono, type RegistryPrivateState as PS } from '../src/chain/registry.ts';

const rand = () => new Uint8Array(randomBytes(32));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const PRICE = 100n;
const NO_EXPIRY = 2n ** 32n - 1n;
const timings: string[] = [];

let wallet: OperatorWallet;
let chain: Chain;
let token: ChainContract;
let registry: ChainContract;
let T: string; // token address
let R: string; // registry address
let color: Uint8Array;
let ctx: Uint8Array;
let pc: any;
let Plan: any;
let Kind: any;
const opSk = rand();
const positions = new Map<string, bigint>();

const witnesses = registryWitnesses((leafHex) => positions.get(leafHex));

const ps = (bono: Bono, j = 0n): PS => ({ bono, j, opSk });
const blank = () => ps({ s: rand(), k: 0n, plan: Plan.free, validUntil: NO_EXPIRY });
const view = () => registry.ledgerState(R);
const slotNul = (b: Bono, kind: number, j: bigint) => pc.slotNullifier(ctx, b.s, kind, j, 0n);
/** Mailbox name zero-padded to 64 bytes (the contract's input). */
function nameOf(text: string): Uint8Array {
  const name = new Uint8Array(64);
  name.set(new TextEncoder().encode(text));
  return name;
}
function record(label: string, o: Outcome) {
  timings.push(`${label.padEnd(30)} ${o.status.padEnd(16)} proof ${(o.proveMs / 1000).toFixed(1).padStart(5)} s  ${String(o.bytes).padStart(6)} B`);
  return o;
}

/**
 * The loser of a race is rejected by the node before inclusion in a block: it pays no fee and leaves no
 * partial effect (all the contract's checks come before any write).
 */
function assertRejected(o: Outcome) {
  assert.equal(o.ok, false);
  assert.equal(o.status, 'rejected', `expected a rejection before the block, not ${o.status}: ${o.error ?? ''}`);
  assert.ok(isNodeRejection(o.error ?? ''), `the rejection must come from the node (1010): ${o.error}`);
}

async function expectLeaf(b: Bono) {
  const leaf = pc.bonoLeaf(ctx, pc.bonoId(ctx, b.s, b.k), b.plan, b.validUntil);
  positions.set(hex(leaf), (await view()).bonos.firstFree());
}

async function issue(plan: number): Promise<Bono> {
  const b: Bono = { s: rand(), k: 0n, plan, validUntil: NO_EXPIRY };
  await expectLeaf(b);
  const o = record(`issueBono (${plan === Plan.paid ? 'pago' : 'gratis'})`, await registry.call(R, 'issueBono', blank(), [pc.bonoId(ctx, b.s, 0n), plan]));
  assert.ok(o.ok, o.error);
  return b;
}

async function mintAndWait(amount: bigint): Promise<void> {
  const o = record('token.mint', await token.call(T, 'mint', {}, [amount, rand()]));
  assert.ok(o.ok, o.error);
  for (let i = 0; i < 60; i++) {
    const st: any = await wallet.facade.waitForSyncedState();
    if ((st.shielded.balances[hex(color)] ?? 0n) >= amount) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  assert.fail('the wallet does not see the minted token');
}

before(async () => {
  const config = loadConfig('undeployed');
  wallet = await openOperatorWallet(config);
  await ensureSpendableDust(wallet);
  chain = await openChain(config, wallet);
  token = await chain.contract('token');
  registry = await chain.contract('registry', witnesses);
  ({ pureCircuits: pc, Plan, Kind } = registry.module);
  const t = await token.deploy(newSigningKey(), []);
  assert.ok(t.outcome.ok, t.outcome.error);
  T = t.address;
  color = token.module.pureCircuits.colorOf({ bytes: Buffer.from(T, 'hex') });
  const r = await registry.deploy(newSigningKey(), [pc.operatorKey(opSk), color, PRICE]);
  assert.ok(r.outcome.ok, r.outcome.error);
  R = r.address;
  ctx = pc.ctxOf({ bytes: Buffer.from(R, 'hex') });
});

after(async () => {
  console.log(`\nTimings on the devnet (compiler 0.36.1, local proof server):\n${timings.join('\n')}`);
  if (wallet) await wallet.close();
});

test('full flow with real proofs: issue, buy, alias and registerMailbox', async () => {
  const free = await issue(Plan.free);
  await mintAndWait(PRICE);
  const paid: Bono = { s: rand(), k: 0n, plan: Plan.paid, validUntil: NO_EXPIRY };
  await expectLeaf(paid);
  const buy = record('buyBono', await registry.call(R, 'buyBono', blank(),
    [{ nonce: rand(), color, value: PRICE }, pc.bonoId(ctx, paid.s, 0n)], ['shielded', 'dust']));
  assert.ok(buy.ok, buy.error);
  assert.ok(record('createAlias (free)', await registry.call(R, 'createAlias', ps(free, 0n), [rand(), rand()])).ok);
  assert.ok(record('createAlias (paid, j=19)', await registry.call(R, 'createAlias', ps(paid, 19n), [rand(), rand()])).ok);
  const name = nameOf('juan.perez');
  const m = { encPk: rand(), authPk: rand(), nameCipher: new Uint8Array(randomBytes(104)), nul: slotNul(free, Kind.mailbox, 0n) };
  assert.ok(record('registerMailbox', await registry.call(R, 'registerMailbox', ps(free, 0n),
    [name, m.encPk, m.authPk, m.nameCipher])).ok);
  const v = await view();
  const rec = v.addresses.lookup(pc.addressKey(name));
  assert.equal(hex(rec.encPk), hex(m.encPk));
  assert.equal(hex(rec.authPk), hex(m.authPk));
  assert.equal(rec.kind, Kind.mailbox);
  assert.equal(hex(rec.slotNul), hex(m.nul));
  assert.equal(v.slotNullifiers.size(), 3n);
  assert.equal(v.bonos.firstFree(), 2n);
});

test('two transactions for the same slot (the second arrives later): one wins and the other leaves nothing half done', async () => {
  const b = await issue(Plan.free);
  const nul = slotNul(b, Kind.alias, 1n);
  const keys = [0, 1].map(() => ({ encPk: rand(), authPk: rand() }));
  const before = (await view()).addresses.size();
  const prepared = [];
  for (const k of keys) prepared.push(await registry.prepare(R, 'createAlias', ps(b, 1n), [k.encPk, k.authPk]));
  const first = record('createAlias (wins)', await registry.send(prepared[0]!));
  const second = record('createAlias (same slot)', await registry.send(prepared[1]!));
  assert.ok(first.ok, first.error);
  assertRejected(second);
  const v = await view();
  assert.equal(v.slotNullifiers.member(nul), true);
  assert.equal(v.addresses.size(), before + 1n, 'only one new address');
  assert.equal(v.addresses.member(pc.aliasKey(keys[0]!.encPk, keys[0]!.authPk, nul)), true);
  assert.equal(v.addresses.member(pc.aliasKey(keys[1]!.encPk, keys[1]!.authPk, nul)), false);
});

test('the same coin in two purchases: only one bono is issued', async () => {
  await mintAndWait(2n * PRICE);
  const coin = { nonce: rand(), color, value: PRICE };
  const b1: Bono = { s: rand(), k: 0n, plan: Plan.paid, validUntil: NO_EXPIRY };
  const b2: Bono = { s: rand(), k: 0n, plan: Plan.paid, validUntil: NO_EXPIRY };
  const leavesBefore = (await view()).bonos.firstFree();
  const p1 = await registry.prepare(R, 'buyBono', blank(), [coin, pc.bonoId(ctx, b1.s, 0n)], ['shielded', 'dust']);
  const p2 = await registry.prepare(R, 'buyBono', blank(), [coin, pc.bonoId(ctx, b2.s, 0n)], ['shielded', 'dust']);
  const first = record('buyBono (coin)', await registry.send(p1));
  const second = record('buyBono (same coin)', await registry.send(p2));
  assert.ok(first.ok, first.error);
  assertRejected(second);
  assert.equal((await view()).bonos.firstFree(), leavesBefore + 1n);
});

test('two registrations of the same name (in series): one wins, the other is rejected by the node and keeps its slot', async () => {
  const b = await issue(Plan.paid);
  const name = nameOf(`ana.${Date.now()}`);
  const users = [3n, 4n].map((j) => ({ encPk: rand(), authPk: rand(), nameCipher: new Uint8Array(randomBytes(104)), nul: slotNul(b, Kind.mailbox, j), j }));
  const prepared = [];
  for (const u of users) prepared.push(await registry.prepare(R, 'registerMailbox', ps(b, u.j), [name, u.encPk, u.authPk, u.nameCipher]));
  const before = (await view()).addresses.size();
  const first = record('registerMailbox (wins)', await registry.send(prepared[0]!));
  const second = record('registerMailbox (same name)', await registry.send(prepared[1]!));
  assert.ok(first.ok, first.error);
  assertRejected(second);
  const v = await view();
  assert.equal(v.addresses.size(), before + 1n);
  assert.equal(hex(v.addresses.lookup(pc.addressKey(name)).encPk), hex(users[0]!.encPk));
  assert.equal(v.slotNullifiers.member(users[1]!.nul), false, 'the losing slot is not spent');
  const other = nameOf(`ana2.${Date.now()}`);
  assert.ok(record('registerMailbox (loser, another name)', await registry.call(R, 'registerMailbox', ps(b, users[1]!.j),
    [other, users[1]!.encPk, users[1]!.authPk, users[1]!.nameCipher])).ok, 'the losing slot registers another name');
});
