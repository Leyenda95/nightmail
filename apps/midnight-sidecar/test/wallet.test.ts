import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as ledger from '@midnightntwrk/ledger-v9';
import type { FacadeState, WalletFacade } from '@midnightntwrk/wallet-sdk';
import { AppError, codes } from '../src/codes.ts';
import {
  SubmitPending, abortable, balanceOf, configuration, currentState, deriveKeystore, findInError, insufficientFunds, missingAsset,
  payFor, refusedByNode, registerDust, restorer, serialQueue, submit, syncedState, syncPercent, txRejected, waitForSync,
  walletUnavailable, wipeSeeds, withPersistence, withTimeout,
  type OpenWallet,
} from '../src/wallet.ts';
import { WalletFiles } from '../src/walletFiles.ts';
import { amountOf } from '../src/walletHandlers.ts';
import { createHandlers } from '../src/handlers.ts';
import { appError, ctx, json, type Notification } from './helpers.ts';

const NIGHT = ledger.unshieldedToken().raw;
const progress = (applied: bigint, highest: bigint) => ({ appliedIndex: applied, highestRelevantWalletIndex: highest });

// --- syncPercent ---------------------------------------------------------------------------------

test('syncPercent gives null if any highest index is 0', () => {
  assert.equal(syncPercent({ shielded: { progress: progress(0n, 0n) }, dust: { progress: progress(5n, 10n) } }), null);
  assert.equal(syncPercent({ shielded: { progress: progress(5n, 10n) }, dust: { progress: progress(0n, 0n) } }), null);
});

test('syncPercent gives the percentage of the most lagging part and does not exceed 100', () => {
  assert.equal(syncPercent({ shielded: { progress: progress(50n, 100n) }, dust: { progress: progress(10n, 100n) } }), 10);
  assert.equal(syncPercent({ shielded: { progress: progress(1n, 3n) }, dust: { progress: progress(3n, 3n) } }), 33);
  assert.equal(syncPercent({ shielded: { progress: progress(200n, 100n) }, dust: { progress: progress(300n, 100n) } }), 100);
});

// --- balanceOf -----------------------------------------------------------------------------------

test('balanceOf gives NIGHT, unregistered NIGHT, DUST, DUST coins and non-empty shielded tokens in decimal', () => {
  let dustAt: Date | undefined;
  const now = new Date('2026-01-01T00:00:00Z');
  const utxo = (type: string, value: bigint, registered: boolean) =>
    ({ utxo: { type, value }, meta: { registeredForDustGeneration: registered } });
  const state = {
    isSynced: true,
    unshielded: {
      balances: { [NIGHT]: 123456789012345678901n, other: 5n },
      // Only unregistered NIGHT counts: neither the registered one nor other tokens.
      availableCoins: [utxo(NIGHT, 7n, false), utxo(NIGHT, 100n, true), utxo('other', 9n, false), utxo(NIGHT, 18446744073709551616n, false)],
    },
    shielded: { balances: { aa: 10n, bb: 0n, cc: 18446744073709551615n } },
    dust: { balance: (d: Date) => { dustAt = d; return 42n; }, availableCoins: [{}, {}, {}] },
  } as unknown as FacadeState;
  assert.deepEqual(balanceOf(state, now), {
    synced: true, night: '123456789012345678901', unregisteredNight: '18446744073709551623', dust: '42', dustCoins: 3,
    tokens: [{ color: 'aa', amount: '10' }, { color: 'cc', amount: '18446744073709551615' }],
  });
  assert.equal(dustAt, now);
});

test('balanceOf without NIGHT or tokens gives zeros', () => {
  const state = {
    isSynced: false, unshielded: { balances: {}, availableCoins: [] }, shielded: { balances: {} },
    dust: { balance: () => 0n, availableCoins: [] },
  } as unknown as FacadeState;
  assert.deepEqual(balanceOf(state), { synced: false, night: '0', unregisteredNight: '0', dust: '0', dustCoins: 0, tokens: [] });
});

// --- errors --------------------------------------------------------------------------------------

test('missingAsset recognizes the SDK tag inside the error', () => {
  assert.equal(missingAsset({ _tag: 'Wallet.InsufficientDustForFee' }), 'dust');
  assert.equal(missingAsset(new Error('x', { cause: { _tag: 'Wallet.InsufficientDustForFee' } })), 'dust');
  assert.equal(missingAsset({ _tag: 'Wallet.InsufficientFunds', tokenType: 'ab'.repeat(32) }), 'token');
  assert.equal(missingAsset({ _tag: 'Wallet.InsufficientFunds', tokenType: 'dust' }), 'dust');
  // What the DUST wallet throws without enough DUST (seen on the devnet).
  assert.equal(missingAsset({ _tag: 'Wallet.InsufficientFunds', message: 'Insufficient Funds: could not balance dust' }), 'dust');
  // Structural: also inside a cause or under a symbol key (where Effect keeps the cause).
  assert.equal(missingAsset(new Error('x', { cause: { _tag: 'Wallet.InsufficientFunds', tokenType: 'dust' } })), 'dust');
  assert.equal(missingAsset({ [Symbol('cause')]: { _tag: 'Wallet.InsufficientFunds', tokenType: 'ab'.repeat(32) } }), 'token');
  assert.equal(missingAsset({ [Symbol('cause')]: { _tag: 'Wallet.InsufficientDustForFee' } }), 'dust');
});

test('missingAsset gives null for other errors and for text without the tag', () => {
  assert.equal(missingAsset(new Error('boom')), null);
  assert.equal(missingAsset(new Error('Wallet.InsufficientFunds')), null);
  assert.equal(missingAsset(new Error('Wallet.InsufficientFunds: could not balance dust')), null);
  assert.equal(missingAsset(null), null);
  assert.equal(missingAsset('texto'), null);
});

test('findInError finds the object, respects the depth limit and does not get lost in cycles', () => {
  const target = { hit: true };
  const isHit = (o: Record<PropertyKey, unknown>) => o.hit === true;
  assert.equal(findInError({ a: { b: target } }, isHit), target);
  assert.equal(findInError(target, isHit), target);
  assert.equal(findInError('texto', isHit), undefined);
  assert.equal(findInError(null, isHit), undefined);
  // depth: with depth 8 it reaches 8 levels of nesting, not 9
  const nest = (n: number) => { let o: object = target; for (let i = 0; i < n; i++) o = { next: o }; return o; };
  assert.equal(findInError(nest(8), isHit), target);
  assert.equal(findInError(nest(9), isHit), undefined);
  assert.equal(findInError(nest(3), isHit, 2), undefined);
  assert.equal(findInError(nest(2), isHit, 2), target);
  // cycles
  const a: Record<string, unknown> = {};
  const b: Record<string, unknown> = { a };
  a.b = b;
  assert.equal(findInError(a, isHit), undefined);
  a.c = target;
  assert.equal(findInError(a, isHit), target);
  // does not look inside message or stack
  assert.equal(findInError({ message: target, stack: target }, isHit), undefined);
});

test('refusedByNode is false for any Error and for text with 1010 without a numeric code', () => {
  assert.equal(refusedByNode(new Error('boom')), false);
  assert.equal(refusedByNode({ message: 'Transaction Pool: 1010: Invalid Transaction', cause: 'code: 1010' }), false);
  assert.equal(refusedByNode(new Error('rpc error :1010: bad')), false);
});

// Shape read by classifySubmissionFailure (wallet-sdk-capabilities/submission): a SubmissionError whose cause is
// the node's SubmissionError carrying the numeric JSON-RPC code.
const submissionError = (cause: unknown) => ({ _tag: 'SubmissionError', cause });
const poolRefusal = (code: number) => submissionError({ _tag: 'SubmissionError', cause: { code } });

test('refusedByNode: the pool rejected it with 1010 (bare or inside an AggregateError)', () => {
  assert.equal(refusedByNode(poolRefusal(1010)), true);
  assert.equal(refusedByNode(new AggregateError([poolRefusal(1010), new Error('otro')])), true);
});

test('refusedByNode: NotIncluded without 1010, or 1010 without NotIncluded, is not a node rejection', () => {
  assert.equal(refusedByNode(poolRefusal(1011)), false, 'NotIncluded with another code');
  // Dropped leaves inclusion open (Undetermined) even if it carries 1010 inside.
  assert.equal(refusedByNode(submissionError({ _tag: 'TransactionDroppedError', cause: { code: 1010 } })), false);
  assert.equal(refusedByNode(new AggregateError([new Error('primero'), poolRefusal(1010)])), false, 'only the first one counts');
});

// --- abortable / withTimeout ---------------------------------------------------------------------

test('abortable gives the value of the promise, or its rejection', async () => {
  const signal = new AbortController().signal;
  assert.equal(await abortable(Promise.resolve(3), signal), 3);
  const boom = new Error('boom');
  await assert.rejects(abortable(Promise.reject(boom), signal), (e) => e === boom);
});

test('abortable: aborting gives CANCELLED and a later rejection of the promise is ignored', async () => {
  const abort = new AbortController();
  let fail!: (e: Error) => void;
  const p = abortable(new Promise<number>((_, reject) => { fail = reject; }), abort.signal);
  abort.abort();
  assert.equal((await appError(p)).code, codes.CANCELLED);
  fail(new Error('tarde'));
  await tick();
});

test('abortable with the signal already aborted gives CANCELLED', async () => {
  const abort = new AbortController();
  abort.abort();
  assert.equal((await appError(abortable(new Promise(() => {}), abort.signal))).code, codes.CANCELLED);
});

test('withTimeout gives the value, or the given error if it does not finish in time', async () => {
  assert.equal(await withTimeout(Promise.resolve('ok'), 1000, () => new Error('tarde')), 'ok');
  const late = new Error('tarde');
  await assert.rejects(withTimeout(new Promise(() => {}), 20, () => late), (e) => e === late);
  await assert.rejects(withTimeout(Promise.reject(new Error('boom')), 1000, () => new Error('tarde')), /boom/);
});

// --- wipeSeeds -----------------------------------------------------------------------------------

test('wipeSeeds zeroes every Uint8Array of the object and leaves the rest', () => {
  const seeds = { a: new Uint8Array([1, 2, 3]), b: Uint8Array.from([4, 5]), name: 'x', n: 5 };
  wipeSeeds(seeds);
  assert.deepEqual([...seeds.a], [0, 0, 0]);
  assert.deepEqual([...seeds.b], [0, 0]);
  assert.equal(seeds.name, 'x');
  assert.equal(seeds.n, 5);
});

test('the public wallet errors carry their code and data', () => {
  const u = walletUnavailable('not-synced');
  assert.ok(u instanceof AppError);
  assert.equal(u.code, codes.WALLET_UNAVAILABLE);
  assert.deepEqual(u.data, { reason: 'not-synced' });
  const f = insufficientFunds('dust');
  assert.equal(f.code, codes.INSUFFICIENT_FUNDS);
  assert.deepEqual(f.data, { asset: 'dust' });
  const t = txRejected();
  assert.equal(t.code, codes.TX_REJECTED);
  assert.equal(t.data, undefined);
});

// --- currentState / waitForSync ------------------------------------------------------------------

/** Fake wallet: `state()` emits the given values, one per tick, on subscription. */
function fakeFacade(states: unknown[]) {
  const tracker = { unsubscribed: 0 };
  const facade = {
    state: () => ({
      subscribe: (next: (s: unknown) => void) => {
        let stopped = false;
        (async () => {
          for (const s of states) {
            await new Promise((r) => setImmediate(r));
            if (stopped) return;
            next(s);
          }
        })();
        return { unsubscribe: () => { stopped = true; tracker.unsubscribed++; } };
      },
    }),
  };
  return { facade: facade as unknown as WalletFacade, tracker };
}

const tick = () => new Promise((r) => setImmediate(r));
const unsynced = (a: bigint, h: bigint) =>
  ({ isSynced: false, shielded: { progress: progress(a, h) }, dust: { progress: progress(a, h) } });

test('currentState gives the first value and cancels the subscription', async () => {
  const { facade, tracker } = fakeFacade([{ n: 1 }, { n: 2 }]);
  assert.deepEqual(await currentState(facade), { n: 1 });
  await tick();
  assert.equal(tracker.unsubscribed, 1);
});

test('currentState without a value in time gives APP_INTERNAL', async () => {
  const { facade } = fakeFacade([]);
  const e = await appError(currentState(facade, 20));
  assert.equal(e.code, codes.APP_INTERNAL);
});

test('waitForSync reports progress only when it changes and returns the synced state', async () => {
  const synced = { isSynced: true };
  const { facade, tracker } = fakeFacade([unsynced(0n, 0n), unsynced(0n, 0n), unsynced(10n, 100n), unsynced(10n, 100n), unsynced(50n, 100n), synced]);
  const sent: Notification[] = [];
  const state = await waitForSync(facade, ctx(undefined, sent));
  assert.equal(state as unknown, synced);
  assert.deepEqual(sent.map((n) => n.params), [
    { requestId: 7, stage: 'syncing', percent: null },
    { requestId: 7, stage: 'syncing', percent: 10 },
    { requestId: 7, stage: 'syncing', percent: 50 },
  ]);
  assert.ok(sent.every((n) => n.method === 'progress'));
  await tick();
  assert.equal(tracker.unsubscribed, 1);
});

test('waitForSync cancelled gives CANCELLED and unsubscribes', async () => {
  const { facade, tracker } = fakeFacade([unsynced(1n, 10n), unsynced(2n, 10n), unsynced(3n, 10n)]);
  const abort = new AbortController();
  const p = waitForSync(facade, ctx(abort.signal));
  setTimeout(() => abort.abort(), 0);
  assert.equal((await appError(p)).code, codes.CANCELLED);
  await tick();
  assert.equal(tracker.unsubscribed, 1);
});

test('waitForSync with the signal already cancelled gives CANCELLED', async () => {
  const { facade } = fakeFacade([{ isSynced: true }]);
  const abort = new AbortController();
  abort.abort();
  assert.equal((await appError(waitForSync(facade, ctx(abort.signal)))).code, codes.CANCELLED);
});

// --- amountOf ------------------------------------------------------------------------------------

test('amountOf accepts decimals from 1 to 2^64-1', () => {
  assert.equal(amountOf('1'), 1n);
  assert.equal(amountOf('18446744073709551615'), 18446744073709551615n);
});

test('amountOf rejects 0, negatives, leading zeros, non-strings and more than 2^64-1', () => {
  for (const bad of ['0', '-1', '01', '1.5', '', ' 1', '1e3', '18446744073709551616', '99999999999999999999', 1, 1n, null, undefined, {}]) {
    assert.throws(() => amountOf(bad), (e: unknown) => e instanceof Error, `should reject ${String(bad)}`);
  }
});

// --- wallet.* with no wallet open ----------------------------------------------------------------

async function ready() {
  const h = createHandlers({ initialized: null });
  await h.initialize(json('rpc/initialize.json'), ctx());
  return h;
}

const GOOD_OPEN = { seed: '00'.repeat(32), stateKey: '11'.repeat(32), stateDir: '/tmp/nm-never-created' };
const FAUCET = { tokenAddress: 'ab'.repeat(32), amount: '1' };

test('wallet.balance, sync, registerDust and faucet without an open wallet give WALLET_UNAVAILABLE not-open', async () => {
  const h = await ready();
  for (const [method, params] of [['wallet.balance', null], ['wallet.sync', null], ['wallet.registerDust', null],
    ['wallet.faucet', FAUCET]] as const) {
    const e = await appError(h[method](params, ctx()));
    assert.equal(e.code, codes.WALLET_UNAVAILABLE, method);
    assert.deepEqual(e.data, { reason: 'not-open' }, method);
  }
});

test('wallet.close without an open wallet gives {}', async () => {
  const h = await ready();
  assert.deepEqual(await h['wallet.close'](null, ctx()), {});
});

test('the wallet.* methods before initialize give NOT_INITIALIZED', async () => {
  const h = createHandlers({ initialized: null });
  for (const [method, params] of [['wallet.open', GOOD_OPEN], ['wallet.close', null], ['wallet.sync', null], ['wallet.balance', null],
    ['wallet.registerDust', null]] as const) {
    assert.equal((await appError(h[method](params, ctx()))).code, codes.NOT_INITIALIZED, method);
  }
});

test('wallet.open rejects invalid params', async () => {
  const h = await ready();
  const bad: unknown[] = [
    null, 'x', [], {},
    { ...GOOD_OPEN, seed: undefined },
    { ...GOOD_OPEN, seed: '00'.repeat(31) },
    { ...GOOD_OPEN, seed: 'zz'.repeat(32) },
    { ...GOOD_OPEN, stateKey: undefined },
    { ...GOOD_OPEN, stateKey: '11'.repeat(16) },
    { ...GOOD_OPEN, stateKey: 'xy'.repeat(32) },
    { ...GOOD_OPEN, stateDir: 'relativa/dir' },
    { ...GOOD_OPEN, stateDir: undefined },
    { ...GOOD_OPEN, stateDir: 5 },
  ];
  for (const params of bad) {
    assert.equal((await appError(h['wallet.open'](params, ctx()))).code, codes.INVALID_PARAMS, JSON.stringify(params));
  }
});

// --- restorer ------------------------------------------------------------------------------------

function tmpFiles() {
  const dir = mkdtempSync(path.join(tmpdir(), 'nm-wallet-test-'));
  return { dir, files: new WalletFiles(dir, new Uint8Array(32).fill(7)), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const SAVED = { address: 'addr', shielded: 's', unshielded: 'u', dust: 'd' };

test('restorer without a stored state starts from scratch', async () => {
  let discards = 0;
  const restoreOr = restorer({ discardWallet: () => { discards++; } } as unknown as WalletFiles, null);
  assert.equal(await restoreOr(() => 'restored', () => 'fresh'), 'fresh');
  assert.equal(discards, 0);
});

test('restorer with a stored state restores', () => {
  const restoreOr = restorer({} as WalletFiles, SAVED);
  assert.equal(restoreOr((s) => s.shielded, () => 'fresh'), 's');
});

test('restorer: if restoring fails it sets the state aside once and that part and the following ones start from scratch', async () => {
  let discards = 0;
  const restoreOr = restorer({ discardWallet: () => { discards++; } } as unknown as WalletFiles, SAVED);
  assert.equal(await restoreOr(() => { throw new Error('mal'); }, () => 'fresh1'), 'fresh1');
  assert.equal(discards, 1);
  let restored = 0;
  assert.equal(await restoreOr(() => { restored++; return 'r'; }, async () => 'fresh2'), 'fresh2');
  assert.equal(restored, 0);
  assert.equal(discards, 1);
});

test('restorer with a real WalletFiles marks discarded', () => {
  const t = tmpFiles();
  try {
    t.files.writeWallet(SAVED);
    const saved = t.files.readWallet('addr');
    const restoreOr = restorer(t.files, saved);
    restoreOr(() => { throw new Error('mal'); }, () => 1);
    assert.equal(t.files.discarded, true);
    assert.equal(t.files.readWallet('addr'), null);
  } finally {
    t.cleanup();
  }
});

// --- serialQueue ---------------------------------------------------------------------------------

test('serialQueue does not overlap two operations', async () => {
  const run = serialQueue();
  const log: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const a = run(async () => { log.push('a-start'); await gate; log.push('a-end'); return 1; });
  const b = run(async () => { log.push('b-start'); return 2; });
  await tick();
  assert.deepEqual(log, ['a-start']);
  release();
  assert.deepEqual([await a, await b], [1, 2]);
  assert.deepEqual(log, ['a-start', 'a-end', 'b-start']);
});

test('serialQueue: a rejected operation does not block the next one', async () => {
  const run = serialQueue();
  const a = run(async () => { throw new Error('boom'); });
  const b = run(async () => 'ok');
  await assert.rejects(a, /boom/);
  assert.equal(await b, 'ok');
});

// --- withPersistence -----------------------------------------------------------------------------

function persistent() {
  const t = tmpFiles();
  const tracker = { stopped: 0, released: 0, serialized: 0 };
  const part = (v: string) => ({ serializeState: async () => { tracker.serialized++; return v; } });
  const facade = { shielded: part('S'), unshielded: part('U'), dust: part('D'), stop: async () => { tracker.stopped++; } };
  const wallet = withPersistence({
    facade: facade as unknown as WalletFacade, keystore: {} as never, files: t.files, unshieldedAddress: 'addr', shieldedAddress: 'sh',
    restored: false,
  }, () => { tracker.released++; });
  return { wallet, tracker, ...t };
}

test('withPersistence: save writes the state of the three wallets', async () => {
  const p = persistent();
  try {
    await p.wallet.save();
    assert.deepEqual(p.files.readWallet('addr'), { address: 'addr', shielded: 'S', unshielded: 'U', dust: 'D' });
    assert.equal(typeof p.wallet.exclusive, 'function');
    assert.equal(await p.wallet.exclusive(async () => 5), 5);
  } finally {
    await p.wallet.close();
    p.cleanup();
  }
});

test('withPersistence: close saves, stops the SDK, deletes the key and releases only once', async () => {
  const p = persistent();
  try {
    await p.wallet.close();
    assert.equal(p.tracker.serialized, 3);
    assert.equal(p.tracker.stopped, 1);
    assert.equal(p.tracker.released, 1);
    const again = new WalletFiles(p.dir, new Uint8Array(32).fill(7));
    assert.deepEqual(again.readWallet('addr'), { address: 'addr', shielded: 'S', unshielded: 'U', dust: 'D' });
    await p.wallet.close();
    assert.equal(p.tracker.stopped, 1);
    assert.equal(p.tracker.released, 1);
    assert.equal(p.tracker.serialized, 3);
  } finally {
    p.cleanup();
  }
});

test('withPersistence: close aborts signal and after closing the files throw not-open', async () => {
  const p = persistent();
  try {
    assert.equal(p.wallet.signal.aborted, false);
    await p.wallet.close();
    assert.equal(p.wallet.signal.aborted, true);
    assert.throws(() => p.files.readWallet('addr'), (e: unknown) =>
      e instanceof AppError && e.code === codes.WALLET_UNAVAILABLE && (e.data as { reason: string }).reason === 'not-open');
  } finally {
    p.cleanup();
  }
});

test('withPersistence: close waits for what is in the queue to finish before the final save', async () => {
  const p = persistent();
  try {
    const log: string[] = [];
    let serializedAtEnd = -1;
    const op = p.wallet.exclusive(async () => {
      await new Promise<void>((resolve) => p.wallet.signal.addEventListener('abort', () => resolve(), { once: true }));
      await tick();
      serializedAtEnd = p.tracker.serialized;
      log.push('op-end');
    });
    await tick(); // the operation is already running
    const closing = p.wallet.close().then(() => log.push('closed'));
    await Promise.all([op, closing]);
    assert.deepEqual(log, ['op-end', 'closed']);
    assert.equal(serializedAtEnd, 0); // the final save came afterwards
    assert.equal(p.tracker.serialized, 3);
    assert.equal(p.tracker.stopped, 1);
  } finally {
    p.cleanup();
  }
});

test('withPersistence: save after close gives WALLET_UNAVAILABLE not-open', async () => {
  const p = persistent();
  try {
    await p.wallet.close();
    const e = await appError(p.wallet.save());
    assert.equal(e.code, codes.WALLET_UNAVAILABLE);
    assert.deepEqual(e.data, { reason: 'not-open' });
  } finally {
    p.cleanup();
  }
});

test('withPersistence: close releases even if saving or stopping fail', async () => {
  const t = tmpFiles();
  let released = 0;
  const failing = { serializeState: async () => { throw new Error('serialize'); } };
  const facade = { shielded: failing, unshielded: failing, dust: failing, stop: async () => { throw new Error('stop'); } };
  const wallet = withPersistence({
    facade: facade as unknown as WalletFacade, keystore: {} as never, files: t.files, unshieldedAddress: 'addr', shieldedAddress: 'sh',
    restored: false,
  }, () => { released++; });
  try {
    await assert.rejects(wallet.close(), /serialize/);
    assert.equal(released, 1);
  } finally {
    t.cleanup();
  }
});

// --- payFor --------------------------------------------------------------------------------------

function payFacade(over: Record<string, unknown> = {}) {
  const calls: { balance?: unknown[]; reverted?: unknown[]; adopted?: unknown[]; signed?: unknown[] } = {};
  const facade = {
    adoptTransaction: (...a: unknown[]) => { calls.adopted = a; return 'handle'; },
    balanceUnboundTransaction: async (...a: unknown[]) => { calls.balance = a; return 'recipe'; },
    signRecipe: async (...a: unknown[]) => { calls.signed = a; return 'signed'; },
    revert: async (...a: unknown[]) => { calls.reverted = a; },
    finalizeRecipe: async (r: unknown) => ({ finalized: r }),
    ...over,
  };
  const signDataAsync = async () => 'sig';
  return { wallet: { facade, keystore: { signDataAsync } } as unknown as OpenWallet, calls, signDataAsync };
}

test('payFor balances with ttl and types, signs and returns the finalized result', async () => {
  const { wallet, calls, signDataAsync } = payFacade();
  const ttl = new Date('2026-01-01T00:00:00Z');
  const tx = new Uint8Array([1, 2]);
  const out = await payFor(wallet, tx, ['dust', 'shielded'], ttl);
  assert.deepEqual(out, { finalized: 'signed' });
  assert.deepEqual(calls.adopted, [tx, 'Unbound']);
  assert.deepEqual(calls.balance, ['handle', { ttl, tokenKindsToBalance: ['dust', 'shielded'] }]);
  assert.deepEqual(calls.signed, ['recipe', signDataAsync]);
  assert.equal(calls.reverted, undefined);
});

test('payFor translates the SDK insufficient funds error to INSUFFICIENT_FUNDS', async () => {
  for (const [tag, asset] of [['Wallet.InsufficientDustForFee', 'dust'], ['Wallet.InsufficientFunds', 'token']] as const) {
    const { wallet } = payFacade({ balanceUnboundTransaction: async () => { throw { _tag: tag, tokenType: 'ab'.repeat(32) }; } });
    const e = await appError(payFor(wallet, new Uint8Array(), [], new Date()));
    assert.equal(e.code, codes.INSUFFICIENT_FUNDS, tag);
    assert.deepEqual(e.data, { asset }, tag);
  }
});

test('payFor propagates any other balancing error as is', async () => {
  const boom = new Error('boom');
  const { wallet } = payFacade({ balanceUnboundTransaction: async () => { throw boom; } });
  await assert.rejects(payFor(wallet, new Uint8Array(), [], new Date()), (e) => e === boom);
});

test('payFor: if signing fails it returns the coins (revert) and propagates the error', async () => {
  const boom = new Error('firma');
  const { wallet, calls } = payFacade({ signRecipe: async () => { throw boom; } });
  await assert.rejects(payFor(wallet, new Uint8Array(), [], new Date()), (e) => e === boom);
  assert.deepEqual(calls.reverted, ['recipe', 'not signed']);
});

test('payFor: if revert also fails, it still gives the signing error', async () => {
  const boom = new Error('firma');
  const { wallet } = payFacade({ signRecipe: async () => { throw boom; }, revert: async () => { throw new Error('revert'); } });
  await assert.rejects(payFor(wallet, new Uint8Array(), [], new Date()), (e) => e === boom);
});

// --- submit --------------------------------------------------------------------------------------

function submitWallet(over: { submitTransaction?: () => Promise<string>; save?: () => Promise<void> } = {}) {
  const tracker = { saves: 0 };
  const wallet = {
    signal: new AbortController().signal,
    facade: { submitTransaction: over.submitTransaction ?? (async () => 'tx-1') },
    save: async () => { tracker.saves++; await over.save?.(); },
  } as unknown as OpenWallet;
  return { wallet, tracker };
}
const FINALIZED = {} as never;

async function quietly<T>(fn: () => Promise<T>): Promise<{ result: T; errors: unknown[][] }> {
  const original = console.error;
  const errors: unknown[][] = [];
  console.error = (...a: unknown[]) => { errors.push(a); };
  try {
    return { result: await fn(), errors };
  } finally {
    console.error = original;
  }
}

test('submit gives the id and saves the state', async () => {
  const { wallet, tracker } = submitWallet();
  assert.equal(await submit(wallet, FINALIZED), 'tx-1');
  assert.equal(tracker.saves, 1);
});

test('submit propagates a generic error and saves anyway', async () => {
  const boom = new Error('red');
  const { wallet, tracker } = submitWallet({ submitTransaction: async () => { throw boom; } });
  await assert.rejects(submit(wallet, FINALIZED), (e) => e === boom);
  assert.equal(tracker.saves, 1);
});

test('submit: if saving fails, the id is not lost', async () => {
  const { wallet } = submitWallet({ save: async () => { throw new Error('disco'); } });
  const { result, errors } = await quietly(() => submit(wallet, FINALIZED));
  assert.equal(result, 'tx-1');
  assert.equal(errors.length, 1);
});

test('submit that does not finish in time gives SubmitPending and saves anyway', async () => {
  const { wallet, tracker } = submitWallet({ submitTransaction: () => new Promise(() => {}) });
  await assert.rejects(submit(wallet, FINALIZED, wallet.signal, 20), (e) => e instanceof SubmitPending);
  assert.equal(tracker.saves, 1);
});

test('submit cancelled gives CANCELLED and saves anyway', async () => {
  const abort = new AbortController();
  const { wallet, tracker } = submitWallet({ submitTransaction: () => new Promise(() => {}) });
  const p = submit(wallet, FINALIZED, abort.signal, 10_000);
  setTimeout(() => abort.abort(), 0);
  assert.equal((await appError(p)).code, codes.CANCELLED);
  assert.equal(tracker.saves, 1);
});

test('submit uses wallet.signal by default', async () => {
  const abort = new AbortController();
  const { wallet } = submitWallet({ submitTransaction: () => new Promise(() => {}) });
  (wallet as unknown as { signal: AbortSignal }).signal = abort.signal;
  const p = submit(wallet, FINALIZED);
  abort.abort();
  assert.equal((await appError(p)).code, codes.CANCELLED);
});

test('submit: the late rejection of the abandoned promise is not an unhandled rejection', async () => {
  let fail!: (e: Error) => void;
  const { wallet } = submitWallet({ submitTransaction: () => new Promise((_, reject) => { fail = reject; }) });
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => { unhandled.push(e); };
  process.on('unhandledRejection', onUnhandled);
  try {
    await assert.rejects(submit(wallet, FINALIZED, wallet.signal, 10), (e) => e instanceof SubmitPending);
    fail(new Error('tarde'));
    await tick();
    await tick();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

// --- deriveKeystore ------------------------------------------------------------------------------

test('deriveKeystore gives a network address, deterministic and different per seed', () => {
  const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const a = deriveKeystore(seed, 'undeployed');
  assert.ok(a.address.startsWith('mn_addr_undeployed1'), a.address);
  assert.equal(deriveKeystore(seed, 'undeployed').address, a.address);
  const other = deriveKeystore(Uint8Array.from({ length: 32 }, (_, i) => 200 - i), 'undeployed');
  assert.notEqual(other.address, a.address);
});

// --- configuration -------------------------------------------------------------------------------

test('configuration translates the endpoints of initialize', () => {
  const init = json('rpc/initialize.json');
  const c = configuration(init);
  assert.equal(c.networkId, init.network);
  assert.equal(c.relayURL.href, new URL(init.endpoints.node).href);
  assert.equal(c.provingServerUrl.href, new URL(init.endpoints.proofServer).href);
  assert.deepEqual(c.indexerClientConnection, { indexerHttpUrl: init.endpoints.indexer, indexerWsUrl: init.endpoints.indexerWs });
  assert.deepEqual(c.costParameters, { feeBlocksMargin: 5 });
  assert.ok(c.txHistoryStorage);
});

// --- syncedState ---------------------------------------------------------------------------------

test('syncedState with a lagging wallet gives WALLET_UNAVAILABLE not-synced', async () => {
  const { facade } = fakeFacade([{ isSynced: false }]);
  const e = await appError(syncedState({ facade } as OpenWallet));
  assert.equal(e.code, codes.WALLET_UNAVAILABLE);
  assert.deepEqual(e.data, { reason: 'not-synced' });
});

test('syncedState with a synced wallet gives the state', async () => {
  const state = { isSynced: true };
  const { facade } = fakeFacade([state]);
  assert.equal((await syncedState({ facade } as OpenWallet)) as unknown, state);
});

// --- registerDust --------------------------------------------------------------------------------

const coin = (type: string, registered: boolean, id: string) => ({ id, utxo: { type }, meta: { registeredForDustGeneration: registered } });

function dustWallet(coins: unknown[]) {
  const calls: Record<string, unknown[]> = {};
  const { facade: base } = fakeFacade([{ isSynced: true, unshielded: { availableCoins: coins } }]);
  const facade = Object.assign(base, {
    estimateRegistration: async (...a: unknown[]) => { calls.estimate = a; return { fee: 99n }; },
    waitForGeneratedDust: async (...a: unknown[]) => { calls.wait = a; },
    registerNightUtxosForDustGeneration: async (...a: unknown[]) => { calls.register = a; return 'recipe'; },
    finalizeRecipe: async (r: unknown) => { calls.finalize = [r]; return 'final'; },
    submitTransaction: async (f: unknown) => { calls.submit = [f]; return 'tx'; },
  });
  const wallet = {
    facade, signal: new AbortController().signal, exclusive: <T>(f: () => Promise<T>) => f(), save: async () => { calls.save = []; },
    keystore: { getPublicKey: () => 'pk', signData: (p: unknown) => `signed:${String(p)}` },
  } as unknown as OpenWallet;
  return { wallet, calls };
}

test('registerDust without pending NIGHT gives false and estimates nothing', async () => {
  const { wallet, calls } = dustWallet([coin(NIGHT, true, 'a'), coin('other', false, 'b')]);
  const sent: Notification[] = [];
  assert.equal(await registerDust(wallet, ctx(undefined, sent)), false);
  assert.equal(calls.estimate, undefined);
  assert.deepEqual(sent, []);
});

test('registerDust registers only the pending NIGHT, waits for the DUST and reports progress', async () => {
  const pending = coin(NIGHT, false, 'p');
  const { wallet, calls } = dustWallet([coin(NIGHT, true, 'a'), pending, coin('other', false, 'b')]);
  const sent: Notification[] = [];
  assert.equal(await registerDust(wallet, ctx(undefined, sent)), true);
  assert.deepEqual(calls.estimate, [[pending]]);
  assert.deepEqual(calls.wait, [[pending], 99n, { timeoutMs: 30 * 60_000 }]);
  const [utxos, pk, sign] = calls.register as [unknown[], string, (p: unknown) => Promise<string>];
  assert.deepEqual([utxos, pk], [[pending], 'pk']);
  assert.equal(await sign('x'), 'signed:x');
  assert.deepEqual(calls.finalize, ['recipe']);
  assert.deepEqual(calls.submit, ['final']);
  assert.deepEqual(sent.map((n) => n.params), [
    { requestId: 7, stage: 'waiting-dust', percent: null },
    { requestId: 7, stage: 'submitting', percent: null },
  ]);
});

test('registerDust cancelled after waiting for the DUST does not send', async () => {
  const { wallet, calls } = dustWallet([coin(NIGHT, false, 'p')]);
  const abort = new AbortController();
  (wallet.facade as unknown as Record<string, unknown>).waitForGeneratedDust = async () => { abort.abort(); };
  await assert.rejects(registerDust(wallet, ctx(abort.signal)));
  assert.equal(calls.submit, undefined);
});

test('registerDust cancelled during the wait (which never ends) gives CANCELLED without sending', async () => {
  const { wallet, calls } = dustWallet([coin(NIGHT, false, 'p')]);
  const abort = new AbortController();
  (wallet.facade as unknown as Record<string, unknown>).waitForGeneratedDust = () => new Promise(() => {});
  const p = registerDust(wallet, ctx(abort.signal));
  setTimeout(() => abort.abort(), 0);
  assert.equal((await appError(p)).code, codes.CANCELLED);
  assert.equal(calls.submit, undefined);
});

test('registerDust with the wallet closing (wallet.signal) gives CANCELLED without sending', async () => {
  const { wallet, calls } = dustWallet([coin(NIGHT, false, 'p')]);
  const closing = new AbortController();
  (wallet as unknown as { signal: AbortSignal }).signal = closing.signal;
  (wallet.facade as unknown as Record<string, unknown>).waitForGeneratedDust = () => new Promise(() => {});
  const p = registerDust(wallet, ctx());
  setTimeout(() => closing.abort(), 0);
  assert.equal((await appError(p)).code, codes.CANCELLED);
  assert.equal(calls.submit, undefined);
});

test('registerDust: if another call registered them while waiting, gives false without sending', async () => {
  const pending = coin(NIGHT, false, 'p');
  const { wallet, calls } = dustWallet([pending]);
  (wallet.facade as unknown as Record<string, unknown>).waitForGeneratedDust = async () => { pending.meta.registeredForDustGeneration = true; };
  const sent: Notification[] = [];
  assert.equal(await registerDust(wallet, ctx(undefined, sent)), false);
  assert.equal(calls.register, undefined);
  assert.equal(calls.submit, undefined);
  assert.deepEqual(sent.map((n) => (n.params as { stage: string }).stage), ['waiting-dust']);
});
