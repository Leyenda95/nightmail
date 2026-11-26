// Chain connection pieces that do not need the devnet (the rest lives in test-devnet/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  causes, compiledDir, dustFeeOf, indexedTime, inFlightOf, isNodeRejection, memoryPrivateStateProvider, nodeRejectionCode,
  refusedByNode, sendPrepared, withArgs,
} from '../src/chain/midnight.ts';
import { registryWitnesses } from '../src/chain/registry.ts';

/** Fake wallet and indexer: each step can be made to fail. */
function fakeCtx(o: { balance?: Error; submit?: Error | 'hang'; watch?: Error | 'hang'; status?: string } = {}) {
  const facade = {
    adoptTransaction: () => ({}),
    balanceUnboundTransaction: async () => { if (o.balance) throw o.balance; return {}; },
    signRecipe: async () => ({}),
    finalizeRecipe: async () => ({ serialize: () => new Uint8Array(1) }),
    submitTransaction: async () => {
      if (o.submit === 'hang') return new Promise(() => {});
      if (o.submit) throw o.submit;
      return 'tx-id';
    },
  };
  const watchForTxData = async () => {
    if (o.watch === 'hang') return new Promise(() => {});
    if (o.watch) throw o.watch;
    return { status: o.status ?? 'SucceedEntirely' };
  };
  return { wallet: { facade, keystore: { signDataAsync: async () => '' } } as any, base: { publicDataProvider: { watchForTxData } } };
}
const P = { bytes: new Uint8Array(10), proveMs: 1, kinds: ['dust' as const], result: 'r' };
const rpc1010 = new Error('submitTx rejected', { cause: new Error('Transaction submission error', { cause: new Error('1010: Invalid Transaction: Custom error: 104') }) });
/** An error with `_tag`, like the Effect errors (Data.TaggedError) the wallet throws. */
const tagged = (tag: string, message: string, cause?: unknown) => Object.assign(new Error(message, { cause }), { _tag: tag });
/** How a pool rejection (1010) arrives: wallet SubmissionError <- node SubmissionError <- RpcError with a code. */
const poolRefusal = tagged('SubmissionError', 'Transaction submission error', tagged('SubmissionError', 'Transaction submission error',
  Object.assign(new Error('1010: Invalid Transaction: Custom error: 104'), { code: 1010 })));

test('sendPrepared tells apart: included, rejected by the node, local failure and unknown result', async () => {
  const ctx = fakeCtx();
  let ttl: Date | undefined;
  const balance = ctx.wallet.facade.balanceUnboundTransaction;
  ctx.wallet.facade.balanceUnboundTransaction = async (h: unknown, opts: { ttl: Date }) => { ttl = opts.ttl; return balance(); };
  const t0 = performance.now();
  const ok = await sendPrepared(ctx, P);
  const elapsed = performance.now() - t0;
  assert.deepEqual([ok.ok, ok.status, ok.result, ok.bytes], [true, 'SucceedEntirely', 'r', 10]);
  assert.ok(ok.blockMs >= 0 && ok.blockMs <= elapsed, `blockMs ${ok.blockMs} (call: ${elapsed} ms)`);
  const ttlMin = (ttl!.getTime() - Date.now()) / 60_000;
  assert.ok(ttlMin > 29 && ttlMin <= 30, `the wallet balances it with 30 min of validity (${ttlMin})`);
  const fallible = await sendPrepared(fakeCtx({ status: 'FailFallible' }), P);
  assert.deepEqual([fallible.ok, fallible.status], [false, 'FailFallible'], 'included but failed: its real status');
  assert.equal((await sendPrepared(fakeCtx({ submit: poolRefusal }), P)).status, 'rejected');
  const hung = await sendPrepared(fakeCtx({ submit: 'hang' }), P, 10);
  assert.equal(hung.status, 'unknown', 'the wallet does not answer on submit: it may have gone out');
  assert.match(hung.error!, /submitTransaction: no answer/);
  const noDust = await sendPrepared(fakeCtx({ balance: new Error('Not enough DUST') }), P);
  assert.deepEqual([noDust.status, noDust.blockMs], ['balance-error', 0]);
  assert.equal((await sendPrepared(fakeCtx({ submit: new Error('WebSocket closed') }), P)).status, 'unknown');
  assert.equal((await sendPrepared(fakeCtx({ watch: new Error('indexer down') }), P)).status, 'unknown');
  const slow = await sendPrepared(fakeCtx({ watch: 'hang' }), P, 10);
  assert.equal(slow.status, 'unknown');
  assert.match(slow.error!, /no answer in 0\.01 s/);
});

test('sendPrepared notifies before submitting with the signed transaction, if the notification fails it does not submit', async () => {
  const events: string[] = [];
  const ctx = fakeCtx();
  const submit = ctx.wallet.facade.submitTransaction;
  ctx.wallet.facade.submitTransaction = async () => { events.push('submit'); return submit(); };
  const ok = await sendPrepared(ctx, P, undefined, async (finalized: any) => {
    assert.equal(finalized.serialize().length, 1, 'receives the finalized transaction');
    events.push('before');
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(events, ['before', 'submit']);
  events.length = 0;
  const reverted: unknown[] = [];
  ctx.wallet.facade.revertTransaction = async (tx: unknown) => { reverted.push(tx); };
  const failed = await sendPrepared(ctx, P, undefined, () => { throw new Error('disk full'); });
  assert.deepEqual([failed.ok, failed.status, failed.error], [false, 'record-error', 'disk full']);
  assert.deepEqual(events, [], 'not submitted');
  assert.equal((reverted[0] as any)?.serialize().length, 1, 'returns to the wallet the DUST the transaction reserved');
  // If releasing also fails, say so (the reservation expires on its own with the transaction).
  ctx.wallet.facade.revertTransaction = async () => { throw new Error('revert failed'); };
  const both = await sendPrepared(ctx, P, undefined, () => { throw new Error('disk full'); });
  assert.deepEqual([both.status, both.error], ['record-error', 'disk full; revert: revert failed']);
});

test('sendPrepared: if signing fails, returns to the wallet what balancing reserved (facade.revert of the recipe)', async () => {
  const ctx = fakeCtx();
  const recipe = { type: 'UNBOUND_TRANSACTION' };
  const reverted: unknown[] = [];
  ctx.wallet.facade.balanceUnboundTransaction = async () => recipe;
  ctx.wallet.facade.signRecipe = async () => { throw new Error('keystore locked'); };
  ctx.wallet.facade.revert = async (r: unknown) => { reverted.push(r); };
  const failed = await sendPrepared(ctx, P);
  assert.deepEqual([failed.status, failed.error], ['balance-error', 'keystore locked']);
  assert.deepEqual(reverted, [recipe]);
  // If releasing also fails, the signing error wins (the reservation expires on its own).
  ctx.wallet.facade.revert = async () => { throw new Error('revert failed'); };
  assert.equal((await sendPrepared(ctx, P)).error, 'keystore locked');
  // A balancing failure reserves nothing: there is no recipe to release.
  const calls: unknown[] = [];
  const noDust = fakeCtx({ balance: new Error('Not enough DUST') });
  noDust.wallet.facade.revert = async (r: unknown) => { calls.push(r); };
  assert.equal((await sendPrepared(noDust, P)).status, 'balance-error');
  assert.deepEqual(calls, []);
});

test('sendPrepared: rejected by the node → returns the reserved DUST (dust.revertTransaction), not if the outcome is uncertain', async () => {
  // Seen on devnet and in the facade 5.0.1 source: when the transaction shares an identifier with an earlier
  // submission (a repeated relay), the facade does not release what it reserved on rejection and the DUST stays locked 3 h.
  const ctx = fakeCtx({ submit: poolRefusal });
  const finalized = { serialize: () => new Uint8Array(1) };
  ctx.wallet.facade.finalizeRecipe = async () => finalized;
  const released: unknown[] = [];
  ctx.wallet.facade.dust = { revertTransaction: async (tx: unknown) => { released.push(tx); } };
  ctx.wallet.facade.revertTransaction = async () => { throw new Error('no: it would mark the previous submission record as Reverted'); };
  assert.equal((await sendPrepared(ctx, P)).status, 'rejected');
  assert.deepEqual(released, [finalized], 'only the DUST, with the submitted transaction');

  const unsureReleased: unknown[] = [];
  const unsure = fakeCtx({ submit: new Error('WebSocket closed') });
  unsure.wallet.facade.dust = { revertTransaction: async (tx: unknown) => { unsureReleased.push(tx); } };
  assert.equal((await sendPrepared(unsure, P)).status, 'unknown');
  assert.deepEqual(unsureReleased, [], 'it may be in a block: returning it would offer spent DUST');

  ctx.wallet.facade.dust = { revertTransaction: async () => { throw new Error('dust wallet busy'); } };
  const failed = await sendPrepared(ctx, P);
  assert.equal(failed.status, 'rejected', 'still a rejection');
  assert.match(failed.error!, /Custom error: 104.*dust revert: dust wallet busy/s, 'with the node code and the revert failure');
});

test('sendPrepared: a foreign transaction (relay) is balanced and finalized WITHOUT signing, own ones are signed', async () => {
  const ctx = fakeCtx();
  const recipe = { type: 'UNBOUND_TRANSACTION' };
  const signed = { type: 'UNBOUND_TRANSACTION', signed: true };
  const finalizedFrom: unknown[] = [];
  let signs = 0;
  ctx.wallet.facade.balanceUnboundTransaction = async () => recipe;
  ctx.wallet.facade.signRecipe = async () => { signs++; return signed; };
  const finalize = ctx.wallet.facade.finalizeRecipe;
  ctx.wallet.facade.finalizeRecipe = async (r: unknown) => { finalizedFrom.push(r); return finalize(); };
  assert.equal((await sendPrepared(ctx, { ...P, foreign: true })).status, 'SucceedEntirely');
  assert.deepEqual([signs, finalizedFrom], [0, [recipe]], 'the operator key does not touch what the client brings');
  finalizedFrom.length = 0;
  assert.equal((await sendPrepared(ctx, P)).status, 'SucceedEntirely');
  assert.deepEqual([signs, finalizedFrom], [1, [signed]]);
});

test('dustFeeOf: the DUST fee is the sum spent by the DUST coins of its intents', () => {
  const spend = (vFee: bigint) => ({ vFee });
  const tx = {
    intents: new Map<number, { dustActions?: { spends: { vFee: bigint }[] } }>([
      [1, {}], // the client call: pays nothing
      [2, { dustActions: { spends: [spend(300n), spend(80n)] } }],
      [3, { dustActions: { spends: [] } }],
      [4, { dustActions: { spends: [spend(8n)] } }],
    ]),
  };
  assert.equal(dustFeeOf(tx), 388n);
  assert.equal(dustFeeOf({ intents: new Map() }), 0n);
  assert.equal(dustFeeOf({}), 0n);
});

test('inFlightOf: transaction hash and the latest expiry of its intents', () => {
  const tx = {
    transactionHash: () => 'ab12',
    intents: new Map([[1, { ttl: new Date(2000) }], [2, { ttl: new Date(5000) }], [3, { ttl: new Date(3000) }]]),
  };
  assert.deepEqual(inFlightOf(tx), { txHash: 'ab12', validUntil: new Date(5000) });
  assert.throws(() => inFlightOf({ transactionHash: () => 'x', intents: new Map() }), /no intents/);
  assert.throws(() => inFlightOf({ transactionHash: () => 'x', intents: undefined }), /no intents/);
});

test('indexedTime: time of the latest indexer block (GraphQL), and a clear error if it is missing', async () => {
  let request: any;
  const reply = (status: number, body: unknown) => (async (url: string, init: any) => {
    request = { url, ...init };
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  const t = await indexedTime('http://indexer/graphql', reply(200, { data: { block: { height: 9, timestamp: 1794932136001 } } }));
  assert.deepEqual(t, new Date(1794932136001));
  assert.equal(request.url, 'http://indexer/graphql');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['content-type'], 'application/json');
  assert.match(JSON.parse(request.body).query, /block\s*\{\s*timestamp\s*\}/);
  assert.ok(request.signal instanceof AbortSignal, 'with a timeout');
  await assert.rejects(indexedTime('u', reply(503, {})), /indexer answered 503/);
  await assert.rejects(indexedTime('u', reply(200, { data: { block: null } })), /time of its last block/);
  await assert.rejects(indexedTime('u', reply(200, { errors: [{ message: 'x' }] })), /time of its last block/);
  await assert.rejects(indexedTime('u', reply(200, null)), /time of its last block/);
});

test('refusedByNode: only the pool rejection on receipt (wallet structure and code 1010)', () => {
  assert.equal(refusedByNode(poolRefusal), true);
  // The wallet could not release the reservation: the submission error comes first in the AggregateError.
  assert.equal(refusedByNode(new AggregateError([poolRefusal, new Error('revert failed')], 'releasing failed too')), true);
  // Text alone is not enough: e.g. a WebSocket close with code 1010, or an error without the wallet's structure.
  assert.equal(refusedByNode(new Error('WebSocket closed: 1010')), false);
  assert.equal(refusedByNode(rpc1010), false);
  // 'NotIncluded' alone is not either: invalid or usurped after entering the pool (it may have been broadcast).
  for (const tag of ['TransactionInvalidError', 'TransactionUsurpedError', 'ConnectionError']) {
    assert.equal(refusedByNode(tagged('SubmissionError', 'Transaction submission error', tagged(tag, 'Transaction is invalid and was rejected by the node'))), false, tag);
  }
  // A pool code that proves nothing (1012: seen recently, maybe already in a block).
  assert.equal(refusedByNode(tagged('SubmissionError', 'x', tagged('SubmissionError', 'x', Object.assign(new Error('1012: 1010 Invalid Transaction'), { code: 1012 })))), false);
});

test('causes collects the node error even when Effect hides it (FiberFailure without an accessible `cause`)', () => {
  // This is how it arrives from the wallet: the RpcError only shows up when inspecting the error.
  class FiberFailureLike extends Error {
    [Symbol.for('nodejs.util.inspect.custom')]() {
      return '(FiberFailure) SubmissionError: Transaction submission error {\n  [cause]: RpcError: 1010: Invalid Transaction: Custom error: 104\n    at checkError (...)\n}';
    }
  }
  const e = new FiberFailureLike('Transaction submission error');
  assert.equal(causes(e), 'Transaction submission error ← RpcError: 1010: Invalid Transaction: Custom error: 104');
  assert.equal(isNodeRejection(causes(e)), true);
});

test('isNodeRejection recognizes the node rejection (1010) and nothing else', () => {
  assert.equal(isNodeRejection(causes(rpc1010)), true);
  assert.equal(isNodeRejection('RpcError: 1010: Invalid Transaction: Custom error: 135'), true);
  assert.equal(isNodeRejection('FinalityTimeout'), false);
  assert.equal(isNodeRejection('error 10100'), false);
});

test('nodeRejectionCode: the number of the node "Custom error", or null if there is none', () => {
  assert.equal(nodeRejectionCode(causes(rpc1010)), 104);
  assert.equal(nodeRejectionCode('RpcError: 1010: Invalid Transaction: Custom error: 135'), 135);
  assert.equal(nodeRejectionCode('RpcError: 1010: Invalid Transaction: Transaction is outdated'), null);
  assert.equal(nodeRejectionCode('Custom error: 1234567'), null, 'a number that cannot be a code is not returned');
  assert.equal(nodeRejectionCode(''), null);
});

test('the registry witnesses require the leaf position (they do not fall back to another)', () => {
  const w = registryWitnesses((h) => (h === 'ab' ? 3n : undefined));
  const ctx = { privateState: {}, ledger: { bonos: { pathForLeaf: (pos: bigint) => ({ pos }) } } };
  assert.deepEqual(w.bonoPath(ctx, new Uint8Array([0xab]))[1], { pos: 3n });
  assert.throws(() => w.bonoPath(ctx, new Uint8Array([0xcd])), /unknown position/);
});

test('withArgs: only passes the arguments if there are any', () => {
  assert.deepEqual(withArgs([]), {});
  assert.deepEqual(withArgs([1, 'a']), { args: [1, 'a'] });
});

test('private states: separated per contract, and can be read, replaced and deleted', async () => {
  const { provider } = memoryPrivateStateProvider();
  const a = provider.forContract('aa');
  const b = provider.forContract('bb');
  await a.set('x', { n: 1 });
  assert.deepEqual(await a.get('x'), { n: 1 });
  assert.equal(await b.get('x'), null, 'another contract does not see it');
  assert.deepEqual(await provider.forContract('aa').get('x'), { n: 1 }, 'the same contract sees it again');
  await a.set('x', { n: 2 });
  assert.deepEqual(await a.get('x'), { n: 2 });
  await a.remove('x');
  assert.equal(await a.get('x'), null);
  await a.set('y', 1);
  await a.clear();
  assert.equal(await a.get('y'), null);
  await b.set('z', 1);
  await provider.clearAll();
  assert.equal(await provider.forContract('bb').get('z'), null);
});

test('maintenance keys: per address, visible to the deployment', async () => {
  const { provider, signingKeys } = memoryPrivateStateProvider();
  const key = { tag: 'schnorr' as const, value: 'ab'.repeat(32) };
  assert.equal(await provider.getSigningKey('c1'), null);
  await provider.setSigningKey('c1', key);
  assert.deepEqual(await provider.getSigningKey('c1'), key);
  assert.equal(signingKeys.get('c1'), key);
  await provider.removeSigningKey('c1');
  assert.equal(await provider.getSigningKey('c1'), null);
  await provider.setSigningKey('c2', key);
  await provider.clearSigningKeys();
  assert.equal(signingKeys.size, 0);
});

test('causes joins the error chain (at most 6) and accepts values that are not Error', () => {
  const inner = new Error('node: 1010 Custom error 135');
  const outer = new Error('submitTx rejected', { cause: new Error('SubmissionError', { cause: inner }) });
  assert.equal(causes(outer), 'submitTx rejected ← SubmissionError ← node: 1010 Custom error 135');
  assert.equal(causes('text'), 'text');
  let deep: any = new Error('0');
  for (let i = 1; i < 10; i++) deep = new Error(String(i), { cause: deep });
  assert.equal(causes(deep).split(' ← ').length, 6);
});

test('compiledDir requires the contract compiled with keys', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nm-compiled-'));
  assert.throws(() => compiledDir('registry', root), /npm run compile -w contracts/);
  mkdirSync(path.join(root, 'contracts', 'managed', 'registry', 'keys'), { recursive: true });
  assert.equal(compiledDir('registry', root), path.join(root, 'contracts', 'managed', 'registry'));
});
