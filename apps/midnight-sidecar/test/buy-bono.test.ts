// wallet.buyBono: the idempotency logic (journal + wait) with fake dependencies. The real purchase (proof,
// payment and submit) is covered by test-devnet/buy-bono.devnet.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError, codes } from '../src/codes.ts';
import {
  type Deps, EXPIRY_MARGIN_MS, MAX_PURCHASES, MAX_READ_FAILURES, orderOf, POLL_MS, purchase, type Seen,
} from '../src/buyBono.ts';
import { SubmitPending } from '../src/wallet.ts';
import { BARRIER_ID, type Purchase } from '../src/walletFiles.ts';
import { ADDRESS, appError } from './helpers.ts';

const ID = '11'.repeat(32);
const order = () => orderOf({ contractAddress: ADDRESS, id: ID, amount: '100' });
const NOW = 1_800_000_000_000;
const TTL = NOW + 20 * 60_000;

type Opts = { submit?: () => Promise<string>; journal?: Purchase[]; ttl?: number; reads?: (() => Promise<Partial<Seen>>)[] };

/** Fake chain: each read takes the next state from `seen` (the last one repeats). */
function fake(seen: Partial<Seen>[], opts: Opts = {}) {
  let journal: Purchase[] = opts.journal ?? [];
  const log: string[] = [];
  const notes: { stage: string; data?: Record<string, unknown> }[] = [];
  const controller = new AbortController();
  let reads = 0;
  let paid = 0;
  const deps: Deps = {
    read: async () => {
      const i = reads++;
      const custom = opts.reads?.[i];
      const s = custom ? await custom() : seen[Math.min(i, seen.length - 1)];
      return { blockHeight: 10 + reads, blockTimestamp: NOW, included: false, ...s };
    },
    pay: async () => {
      log.push('pay');
      return { tag: `tx${++paid}` } as never;
    },
    inspect: (f) => ({ txHash: (f as unknown as { tag: string }).tag, ttl: opts.ttl ?? TTL }),
    giveBack: async (f) => { log.push(`giveBack ${(f as unknown as { tag: string }).tag}`); },
    submit: async () => {
      log.push(`submit with journal=${journal.length}`);
      return opts.submit ? opts.submit() : 'txid';
    },
    journal: { read: () => journal, write: (p) => { journal = p; } },
    exclusive: async (run) => { log.push('lock'); return run(); },
    wait: async (ms) => { log.push(`wait ${ms}`); },
    signal: controller.signal,
    notify: (stage, data) => notes.push({ stage, data }),
  };
  return { deps, log, notes, controller, journal: () => journal, setJournal: (p: Purchase[]) => { journal = p; } };
}
const entry = (over: Partial<Purchase> = {}): Purchase => ({ id: ID, contractAddress: ADDRESS, txHash: 'old', ttl: TTL, ...over });

test('orderOf validates contract, id and amount and computes the expected leaf', () => {
  const o = order();
  assert.equal(o.amount, 100n);
  assert.match(o.leaf, /^[0-9a-f]{64}$/);
  for (const bad of [null, { contractAddress: ADDRESS, id: 'zz', amount: '1' }, { contractAddress: ADDRESS, id: ID, amount: '0' }]) {
    assert.throws(() => orderOf(bad));
  }
});

test('if the leaf is already there, it pays nothing (alreadyIncluded)', async () => {
  const f = fake([{ included: true }]);
  assert.deepEqual(await purchase(order(), f.deps), { blockHeight: 11, alreadyIncluded: true });
  assert.deepEqual(f.log, ['lock']);
});

test('purchase: inside the queue it records BEFORE sending, waits OUTSIDE the queue, and the entry stays until it expires', async () => {
  const f = fake([{}, {}, { included: true }]);
  assert.deepEqual(await purchase(order(), f.deps), { blockHeight: 13, alreadyIncluded: false });
  assert.deepEqual(f.log, ['lock', 'pay', 'submit with journal=1', `wait ${POLL_MS}`, 'lock', `wait ${POLL_MS}`, 'lock']);
  assert.deepEqual(f.journal().map((p) => p.txHash), ['tx1']);
  assert.deepEqual(f.notes, [{ stage: 'waiting-inclusion', data: { expiresAt: TTL } }]);
});

test('with a purchase of the same id in flight (TTL not expired) it waits and does not pay again', async () => {
  const f = fake([{}, {}, { included: true }], { journal: [entry()] });
  assert.deepEqual(await purchase(order(), f.deps), { blockHeight: 13, alreadyIncluded: true });
  assert.equal(f.log.includes('pay'), false);
  assert.deepEqual(f.journal(), [entry()]);
});

test('a call that reads a STALE state after another saw the leaf does not buy again (the entry stays)', async () => {
  // A sees the leaf (and deletes nothing); B had read before it was indexed: no leaf, but the entry is still alive.
  const a = fake([{ included: true }], { journal: [entry()] });
  await purchase(order(), a.deps);
  const b = fake([{}, { included: true }], { journal: a.journal() });
  assert.deepEqual(await purchase(order(), b.deps), { blockHeight: 12, alreadyIncluded: true });
  assert.equal(b.log.includes('pay'), false);
});

test(`within the expiry margin (${EXPIRY_MARGIN_MS / 1000} s after the TTL) it may still get in: waits`, async () => {
  const f = fake([{}, { included: true }], { journal: [entry({ ttl: NOW - EXPIRY_MARGIN_MS })] });
  assert.deepEqual(await purchase(order(), f.deps), { blockHeight: 12, alreadyIncluded: true });
  assert.equal(f.log.includes('pay'), false);
});

test('an in-flight purchase of ANOTHER id or contract does not count and is kept', async () => {
  const others = [entry({ id: '22'.repeat(32), txHash: 'a' }), entry({ contractAddress: 'be'.repeat(32), txHash: 'b' })];
  const f = fake([{}, { included: true }], { journal: others });
  await purchase(order(), f.deps);
  assert.ok(f.log.includes('pay'));
  assert.deepEqual(f.journal().slice(0, 2), others);
});

test('expired without being included (block after TTL + margin): it is forgotten and bought again', async () => {
  const f = fake([{}, { included: true }], { journal: [entry({ ttl: NOW - EXPIRY_MARGIN_MS - 1 })] });
  assert.deepEqual(await purchase(order(), f.deps), { blockHeight: 12, alreadyIncluded: false });
  assert.deepEqual(f.log.filter((l) => l === 'pay'), ['pay']);
  assert.deepEqual(f.journal().map((p) => p.txHash), ['tx1'], 'the expired one was deleted, the new one remains');
});

test('the barrier of a lost journal blocks any id until it expires (and is not deleted on seeing another leaf)', async () => {
  const barrier = entry({ id: BARRIER_ID, contractAddress: BARRIER_ID, txHash: '' });
  const f = fake([{}, {}, { included: true }], { journal: [barrier] });
  assert.deepEqual(await purchase(order(), f.deps), { blockHeight: 13, alreadyIncluded: true });
  assert.equal(f.log.includes('pay'), false);
  assert.deepEqual(f.journal(), [barrier]);
});

test('the expired barrier is removed and the purchase goes ahead', async () => {
  const barrier = entry({ id: BARRIER_ID, contractAddress: BARRIER_ID, txHash: '', ttl: NOW - EXPIRY_MARGIN_MS - 1 });
  const f = fake([{}, { included: true }], { journal: [barrier] });
  await purchase(order(), f.deps);
  assert.ok(f.log.includes('pay'));
  assert.deepEqual(f.journal().map((p) => p.id), [ID], 'the expired barrier was removed'); 
});

test(`at most ${MAX_PURCHASES} purchases per call: if they expire without being included, TX_REJECTED`, async () => {
  const f = fake([{}], { ttl: NOW - EXPIRY_MARGIN_MS - 1 }); // every purchase "expires" immediately
  const e = await appError(purchase(order(), f.deps));
  assert.equal(e.code, codes.TX_REJECTED);
  assert.equal(f.log.filter((l) => l === 'pay').length, MAX_PURCHASES);
});

test('the node rejects it on submit: it is deleted from the journal and TX_REJECTED comes out', async () => {
  const f = fake([{}], { submit: async () => { throw new AppError(codes.TX_REJECTED, 'Transaction rejected'); } });
  assert.equal((await appError(purchase(order(), f.deps))).code, codes.TX_REJECTED);
  assert.deepEqual(f.journal(), []);
});

test('an uncertain failure on submit leaves the purchase in the journal (the retry will wait)', async () => {
  const f = fake([{}], { submit: async () => { throw new Error('connection closed'); } });
  await assert.rejects(purchase(order(), f.deps), /connection closed/);
  assert.deepEqual(f.journal().map((p) => [p.id, p.txHash, p.ttl]), [[ID, 'tx1', TTL]]);
});

test('a submit with no answer at its cap (SubmitPending) is not an error: it waits for the leaf', async () => {
  const f = fake([{}, { included: true }], { submit: async () => { throw new SubmitPending(); } });
  assert.deepEqual(await purchase(order(), f.deps), { blockHeight: 12, alreadyIncluded: false });
  assert.deepEqual(f.journal().map((p) => p.txHash), ['tx1']);
});

test('cancelling after paying and before recording returns the coins and sends nothing', async () => {
  const f = fake([{}]);
  const pay = f.deps.pay;
  f.deps.pay = async (o) => { const tx = await pay(o); f.controller.abort(); return tx; };
  assert.equal((await appError(purchase(order(), f.deps))).code, codes.CANCELLED);
  assert.deepEqual(f.log, ['lock', 'pay', 'giveBack tx1']);
  assert.deepEqual(f.journal(), []);
});

test('if it cannot be recorded in the journal, it returns the coins and does not send', async () => {
  const f = fake([{}]);
  const write = f.deps.journal.write;
  f.deps.journal.write = () => { throw new Error('disk full'); };
  await assert.rejects(purchase(order(), f.deps), /disk full/);
  assert.deepEqual(f.log, ['lock', 'pay', 'giveBack tx1']);
  void write;
});

test('cancelling while waiting leaves the journal intact', async () => {
  const f = fake([{}]);
  f.deps.wait = async () => { throw new AppError(codes.CANCELLED, 'Cancelled'); };
  assert.equal((await appError(purchase(order(), f.deps))).code, codes.CANCELLED);
  assert.equal(f.journal().length, 1);
});

test('while waiting it tolerates transient read failures (with growing backoff)', async () => {
  const down = async () => { throw new AppError(codes.UPSTREAM_UNAVAILABLE, 'Indexer unavailable'); };
  const f = fake([{}], { reads: [async () => ({}), down, down, async () => ({ included: true })] });
  assert.deepEqual(await purchase(order(), f.deps), { blockHeight: 14, alreadyIncluded: false });
  assert.deepEqual(f.log.filter((l) => l.startsWith('wait')), [`wait ${POLL_MS}`, `wait ${POLL_MS}`, `wait ${2 * POLL_MS}`]);
});

test('reports the wait only once even over several rounds', async () => {
  const f = fake([{}, {}, {}, {}, { included: true }]);
  await purchase(order(), f.deps);
  assert.deepEqual(f.notes, [{ stage: 'waiting-inclusion', data: { expiresAt: TTL } }]);
});

test('if the node rejects it, only ITS entry is deleted (those of other ids or contracts remain)', async () => {
  const others = [entry({ id: '22'.repeat(32), txHash: 'tx1' }), entry({ contractAddress: 'be'.repeat(32), txHash: 'tx1' })];
  const f = fake([{}], { journal: others, submit: async () => { throw new AppError(codes.TX_REJECTED, 'Transaction rejected'); } });
  assert.equal((await appError(purchase(order(), f.deps))).code, codes.TX_REJECTED);
  assert.deepEqual(f.journal(), others);
});

test(`…but not ${MAX_READ_FAILURES} in a row, nor before starting to wait`, async () => {
  const down = async () => { throw new AppError(codes.UPSTREAM_UNAVAILABLE, 'Indexer unavailable'); };
  const first = fake([{}], { reads: [down] });
  assert.equal((await appError(purchase(order(), first.deps))).code, codes.UPSTREAM_UNAVAILABLE);
  const many = fake([{}], { reads: [async () => ({}), ...Array(MAX_READ_FAILURES).fill(down)] });
  assert.equal((await appError(purchase(order(), many.deps))).code, codes.UPSTREAM_UNAVAILABLE);
  const other = fake([{}], { reads: [async () => ({}), async () => { throw new Error('boom'); }] });
  await assert.rejects(purchase(order(), other.deps), /boom/);
});
