// Price grace window on the local devnet (npm run test:devnet -w apps/server).
// What the simulator cannot check: that the time that counts is the block's (the node's), not the prover's
// clock, and what the node does with in-flight purchases when the price changes (rejects them before the
// block, with no fee; retried with the same amount, they land).
// Deploys a fresh token and registry on every run, keys in memory: no deployment data directory, and
// .data/operator/undeployed/contracts.json is untouched. Needs the devnet running, the contracts compiled
// with keys and the payer stopped.
// The tests share contract and price, so they run serially (--test-concurrency=1).
// The last one waits for a real window to end (~17 min): only with NIGHTMAIL_GRACE_WAIT=1.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../src/config.ts';
import { ensureSpendableDust, openOperatorWallet, type OperatorWallet } from '../src/wallet/operatorWallet.ts';
import { isNodeRejection, newSigningKey, openChain, type Chain, type ChainContract, type Outcome } from '../src/chain/midnight.ts';
import { registryWitnesses, type RegistryPrivateState as PS } from '../src/chain/registry.ts';

const rand = () => new Uint8Array(randomBytes(32));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => BigInt(Math.floor(Date.now() / 1000));
const PRICE = 100n;
const NO_EXPIRY = 2n ** 32n - 1n;
const MINTED = 1000n;
const WAIT_FOR_WINDOW = process.env['NIGHTMAIL_GRACE_WAIT'] === '1';
const timings: string[] = [];

let wallet: OperatorWallet;
let chain: Chain;
let token: ChainContract;
let registry: ChainContract;
let R: string; // registry address
let color: Uint8Array;
let ctx: Uint8Array;
let pc: any;
let Plan: any;
let mid: bigint; // what the operator adds to its clock: the midpoint of the window's two bounds
let until100 = 0n; // end of the price-100 window (set by the first change)
let until50 = 0n; // end of the price-50 window (set by the second)
const opSk = rand();

const blank = (): PS => ({ bono: { s: rand(), k: 0n, plan: Plan.free, validUntil: NO_EXPIRY }, j: 0n, opSk });
const view = () => registry.ledgerState(R);
const buyArgs = (value: bigint) => [{ nonce: rand(), color, value }, pc.bonoId(ctx, rand(), 0n)];

function record(label: string, o: Outcome) {
  timings.push(`${label.padEnd(44)} ${o.status.padEnd(16)} proof ${(o.proveMs / 1000).toFixed(1).padStart(5)} s  ${String(o.bytes).padStart(6)} B`);
  return o;
}
const buy = async (label: string, value: bigint) =>
  record(label, await registry.call(R, 'buyBono', blank(), buyArgs(value), ['shielded', 'dust']));
const provedBuy = (value: bigint) => registry.prepare(R, 'buyBono', blank(), buyArgs(value), ['shielded', 'dust']);
const setPrice = async (label: string, price: bigint, until: bigint) =>
  record(label, await registry.call(R, 'setPrice', blank(), [price, until]));

/** The node rejects it before including it in a block: no fee, no effects. */
function assertRejected(o: Outcome) {
  assert.equal(o.ok, false);
  assert.equal(o.status, 'rejected', `expected a rejection before the block, not ${o.status}: ${o.error ?? ''}`);
  assert.ok(isNodeRejection(o.error ?? ''), `the rejection must come from the node (1010): ${o.error}`);
}
/** Fails when run locally (neither proved nor submitted), with that contract message. */
function assertLocalReject(o: Outcome, message: RegExp) {
  assert.equal(o.status, 'local-reject', `${o.status}: ${o.error ?? ''}`);
  assert.match(o.error ?? '', message);
}
/** Runs `f` with the local clock shifted: what a device with the wrong time would see. */
async function withClockOffset<T>(seconds: number, f: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => real() + seconds * 1000;
  try {
    return await f();
  } finally {
    Date.now = real;
  }
}

before(async () => {
  const config = loadConfig('undeployed');
  wallet = await openOperatorWallet(config);
  await ensureSpendableDust(wallet);
  chain = await openChain(config, wallet);
  token = await chain.contract('token');
  registry = await chain.contract('registry', registryWitnesses());
  ({ pureCircuits: pc, Plan } = registry.module);
  mid = (pc.oldPriceGrace() + pc.oldPriceGraceMax()) / 2n;
  const t = await token.deploy(newSigningKey(), []);
  assert.ok(t.outcome.ok, t.outcome.error);
  color = token.module.pureCircuits.colorOf({ bytes: Buffer.from(t.address, 'hex') });
  const r = await registry.deploy(newSigningKey(), [pc.operatorKey(opSk), color, PRICE]);
  assert.ok(r.outcome.ok, r.outcome.error);
  R = r.address;
  ctx = pc.ctxOf({ bytes: Buffer.from(R, 'hex') });
  const mint = record('token.mint', await token.call(t.address, 'mint', {}, [MINTED, rand()]));
  assert.ok(mint.ok, mint.error);
  for (let i = 0; ; i++) {
    const st: any = await wallet.facade.waitForSyncedState();
    if ((st.shielded.balances[hex(color)] ?? 0n) >= MINTED) break;
    assert.ok(i < 60, 'the wallet does not see the minted token');
    await sleep(2000);
  }
});

after(async () => {
  console.log(`\nGrace window on the devnet:\n${timings.join('\n')}`);
  if (wallet) await wallet.close();
});

test('setPrice: the node bounds the window with the BLOCK time, not with the prover clock', async () => {
  assertLocalReject(await setPrice('setPrice with a short window', 50n, nowSec() + 600n), /Grace too short/);
  assertLocalReject(await setPrice('setPrice with a long window', 50n, nowSec() + 2000n), /Grace too long/);
  assertLocalReject(await setPrice('setPrice at the same price', PRICE, nowSec() + mid), /Price unchanged/);
  // An operator whose clock is 400 s behind (or who lies) proves locally a window that lasts only ~650 s for
  // the chain; with the clock ahead, one of ~1450 s. The node accepts neither.
  for (const offset of [-400, 400]) {
    const lying = await withClockOffset(offset, () => registry.prepare(R, 'setPrice', blank(), [50n, nowSec() + mid]));
    assertRejected(record(`setPrice with the local clock at ${offset} s`, await registry.send(lying)));
  }
  const v = await view();
  assert.equal(v.price, PRICE);
  assert.equal(v.oldPrices.size(), 0n);
});

test('price change: the purchase proven before is rejected at no cost, retried with the same amount it lands', async () => {
  const inFlight = await provedBuy(PRICE); // proved with price = 100
  until100 = nowSec() + mid;
  const change = await setPrice('setPrice 100 -> 50', 50n, until100);
  assert.ok(change.ok, change.error);
  let v = await view();
  assert.equal(v.price, 50n);
  assert.equal(v.oldPrices.lookup(PRICE), until100);
  const block = BigInt(Math.floor((await chain.indexedTime()).getTime() / 1000));
  assert.ok(until100 - block >= pc.oldPriceGrace() && until100 - block <= pc.oldPriceGraceMax(), `window of ${until100 - block} s`);
  const leaves = v.bonos.firstFree();
  assertRejected(record('buyBono(100) proven before the change', await registry.send(inFlight)));
  const retried = await buy('buyBono(100) retried', PRICE);
  assert.ok(retried.ok, retried.error);
  const current = await buy('buyBono(50) at the new price', 50n);
  assert.ok(current.ok, current.error);
  assertLocalReject(await buy('buyBono(77): never a price', 77n), /Wrong amount/);
  v = await view();
  assert.equal(v.bonos.firstFree(), leaves + 2n, 'only the retried one and the new-price one land');
});

test('a second change also invalidates the in-flight purchase at the old price, the two previous ones remain valid', async () => {
  const inFlight = await provedBuy(PRICE); // at the previous price, inside its window
  until50 = nowSec() + mid;
  const change = await setPrice('setPrice 50 -> 70', 70n, until50);
  assert.ok(change.ok, change.error);
  assertRejected(record('buyBono(100) in flight during the second change', await registry.send(inFlight)));
  for (const value of [PRICE, 50n, 70n]) {
    const o = await buy(`buyBono(${value}) with two changes`, value);
    assert.ok(o.ok, o.error);
  }
});

test('when the window ends, the old price no longer lands (not even with a lagging local clock), the others do', { skip: !WAIT_FOR_WINDOW && 'waits ~17 min: NIGHTMAIL_GRACE_WAIT=1' }, async () => {
  const late = await provedBuy(PRICE); // proved inside the window
  await sleep(Math.max(0, Number(until100 - nowSec()) + 20) * 1000);
  const leaves = (await view()).bonos.firstFree();
  assertRejected(record('buyBono(100) probada a tiempo, enviada tarde', await registry.send(late)));
  assertLocalReject(await buy('buyBono(100) with the window over', PRICE), /Old price expired/);
  // A device with a lagging clock proves it locally, but the node uses the block time.
  const slow = await withClockOffset(-1300, () => provedBuy(PRICE));
  assertRejected(record('buyBono(100) late, with a lagging clock', await registry.send(slow)));
  // The price-50 window ends shortly after (the second change was a minute later): it only checks whether
  // there is enough margin for the purchase to land in a block before it ends.
  const fiftyStillOpen = nowSec() + 45n < until50;
  if (fiftyStillOpen) {
    const other = await buy('buyBono(50): its window is still open', 50n);
    assert.ok(other.ok, other.error);
  }
  const current = await buy('buyBono(70) current', 70n);
  assert.ok(current.ok, current.error);
  assert.equal((await view()).bonos.firstFree(), leaves + (fiftyStillOpen ? 2n : 1n));
});
