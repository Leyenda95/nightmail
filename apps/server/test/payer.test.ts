// The payer with wallet and chain doubles: relay, issue (idempotent per id), advanceRound, DUST caps and
// lost fees. The doubles honour the sendPrepared contract (chain/midnight.ts).
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { ctx as ctxOf, leaf as leafOf, NO_EXPIRY, Plan, toHex } from '@nightmail/midnight';
import type { Outcome, Prepared, SentTx } from '../src/chain/midnight.ts';
import type { RelayProblem } from '../src/chain/relayable.ts';
import { IssueJournal } from '../src/payer/journal.ts';
import { InvalidTransactionError, Payer, type PayerLimits, type PayerPorts } from '../src/payer/payer.ts';
import { tempDir } from './temp-dir.ts';

const R = 'ab'.repeat(32);
const CTX = ctxOf(R);
const MIN = 60_000;
const TTL = 60 * MIN;
const id = (n: number) => n.toString(16).padStart(64, '0');
const leafHex = (idHex: string, plan: Plan) => toHex(leafOf(CTX, Buffer.from(idHex, 'hex'), plan, NO_EXPIRY));
const TX = new Uint8Array([1, 2, 3, 4]);
const tick = () => new Promise((resolve) => setImmediate(resolve));

type Step = string | (() => Promise<string> | string);

/** Fake wallet and chain. `script`: the outcome of each submission, in order (SucceedEntirely by default). */
function world(t: TestContext, o: {
  limits?: Partial<PayerLimits>; registry?: boolean; dir?: string; script?: Step[]; jobDeadlineMs?: number;
} = {}) {
  const dir = o.dir ?? tempDir(t);
  const w = {
    dir,
    clock: 1_000_000,
    /** How far the indexer lags behind the clock (ms): its last block time is `clock - indexerLag`. */
    indexerLag: 0,
    failRound: undefined as Error | undefined,
    infos: [] as string[],
    /** Times the payer reported a stuck job. */
    stuck: 0,
    tree: new Set<string>(),
    round: 7n,
    fee: 55n,
    estimate: 60n,
    script: [...(o.script ?? [])] as Step[],
    prepared: [] as { circuit: string; args: unknown[] }[],
    sends: [] as { tx: Prepared; txHash: string }[],
    warnings: [] as string[],
    wallet: { synced: true, dustCoins: 5, dustBalance: 1250n },
    failPrepare: undefined as Error | undefined,
    failEstimate: undefined as Error | undefined,
    /** What relayable.ts would say about a client transaction (null: payable). */
    problem: null as RelayProblem | null,
    screenError: undefined as Error | undefined,
    journalAtSend: undefined as unknown,
    journal: undefined as unknown as IssueJournal,
    payer: undefined as unknown as Payer,
  };
  const ports: PayerPorts = {
    status: () => w.wallet,
    screen: (tx) => {
      if (w.screenError) throw w.screenError;
      if (tx.length === 0) throw new InvalidTransactionError('not a transaction');
      return w.problem;
    },
    estimateFee: async (tx) => {
      if (w.failEstimate) throw w.failEstimate;
      if (tx.length === 0) throw new InvalidTransactionError('not a transaction');
      return w.estimate;
    },
    // Like sendPrepared: 'balance-error' never reaches the hook; if the hook fails, 'record-error' and nothing is sent.
    send: async (tx, beforeSubmit) => {
      const step = w.script.shift() ?? 'SucceedEntirely';
      const outcome = (status: string): Outcome => ({
        ok: status === 'SucceedEntirely', status, proveMs: 0, blockMs: 1, bytes: tx.bytes.length,
        ...(status === 'rejected' && { error: 'x ← RpcError: 1010: Invalid Transaction: Custom error: 104' }),
        ...(status === 'balance-error' && { error: 'Wallet.InsufficientFunds: secret detail' }),
      });
      if (step === 'balance-error') return outcome(step);
      const sent: SentTx = { txHash: id(0xf000 + w.sends.length), validUntil: new Date(w.clock + TTL), fee: w.fee };
      try {
        await beforeSubmit(sent);
      } catch {
        return outcome('record-error');
      }
      w.sends.push({ tx, txHash: sent.txHash });
      const call = (tx.result ?? {}) as { id?: string; leaf?: string; advance?: boolean };
      if (call.id) w.journalAtSend = w.journal.get(call.id);
      const status = typeof step === 'function' ? await step() : step;
      if (status === 'SucceedEntirely' && call.leaf) w.tree.add(call.leaf);
      if (status === 'SucceedEntirely' && call.advance) w.round += 1n;
      return outcome(status);
    },
    registry: o.registry === false ? null : {
      address: R,
      prepare: async (circuit, args) => {
        if (w.failPrepare) throw w.failPrepare;
        w.prepared.push({ circuit, args });
        const result = circuit === 'issueBono'
          ? { id: toHex(args[0] as Uint8Array), leaf: toHex(leafOf(CTX, args[0] as Uint8Array, args[1] as Plan, NO_EXPIRY)) }
          : { advance: true };
        return { bytes: new Uint8Array(8), proveMs: 2, kinds: ['dust'], result };
      },
      hasLeaves: async (leaves) => leaves.map((l) => w.tree.has(toHex(l))),
      round: async () => {
        if (w.failRound) throw w.failRound;
        return w.round;
      },
      indexedTime: async () => new Date(w.clock - w.indexerLag),
    },
  };
  w.journal = IssueJournal.open(dir);
  w.payer = new Payer({
    ports,
    journal: w.journal,
    limits: { relayDustPerHour: 1000n, issueDustPerHour: 1000n, maxQueue: 8, ...o.limits },
    now: () => w.clock,
    log: { info: (m) => { w.infos.push(m); }, warn: (m) => { w.warnings.push(m); } },
    ...(o.jobDeadlineMs !== undefined && { jobDeadlineMs: o.jobDeadlineMs }),
    onStuck: () => { w.stuck += 1; },
  });
  return w;
}

// --- relay --------------------------------------------------------------------------------------------

test('relay: pays, submits and returns the block status with the hash', async (t) => {
  const w = world(t);
  assert.deepEqual(await w.payer.relay(TX), { status: 'SucceedEntirely', txHash: id(0xf000) });
  assert.deepEqual(w.sends[0]!.tx, { bytes: TX, proveMs: 0, kinds: ['dust'], foreign: true }, 'balances only DUST and does not sign it');
  const health = w.payer.health();
  assert.deepEqual(health.lostFees, { count: 0, dust: 0n, byCause: {} });
  assert.equal(health.dustSpentLastHour.relay, 55n, 'records the actual fee, not the estimate');
  assert.match(w.infos.join('\n'), /relay: SucceedEntirely/);
  assert.doesNotMatch(w.infos.join('\n'), new RegExp(id(0xf000)), 'a successful relay does not leave its hash in the log');
});

test('issue and advanceRound (operator transactions) do leave their hash in the log line', async (t) => {
  const w = world(t);
  await w.payer.issue(id(1), 'free');
  await w.payer.advanceRound();
  assert.match(w.infos.join('\n'), new RegExp(`issue: SucceedEntirely, tx ${id(0xf000)}`));
  assert.match(w.infos.join('\n'), new RegExp(`advance: SucceedEntirely, tx ${id(0xf001)}`));
});

test('relay: FailFallible lands in a block, charges and counts as a lost fee with its cause', async (t) => {
  const w = world(t, { script: ['FailFallible', 'FailFallible', 'PartialSuccess'] });
  assert.deepEqual(await w.payer.relay(TX), { status: 'FailFallible', txHash: id(0xf000) });
  await w.payer.relay(TX);
  await w.payer.relay(TX);
  assert.deepEqual(w.payer.health().lostFees, {
    count: 3, dust: 165n,
    byCause: { 'relay:FailFallible': { count: 2, dust: 110n }, 'relay:PartialSuccess': { count: 1, dust: 55n } },
  });
  assert.equal(w.payer.health().dustSpentLastHour.relay, 165n);
  assert.match(w.warnings.join('\n'), new RegExp(`lost fee.*relay:FailFallible.*${id(0xf000)}`), 'stays in the log with the hash');
});

test('relay: a node rejection does not charge: returns its code and counts neither toward the cap nor as a loss', async (t) => {
  const w = world(t, { script: ['rejected'] });
  assert.deepEqual(await w.payer.relay(TX), { status: 'rejected', code: 104 });
  assert.equal(w.payer.health().dustSpentLastHour.relay, 0n);
  assert.equal(w.payer.health().lostFees.count, 0);
});

test('relay: a submission with an unknown outcome carries until when it can land, counts toward the cap but not as a loss', async (t) => {
  const w = world(t, { script: ['unknown'] });
  assert.deepEqual(await w.payer.relay(TX), { status: 'unknown', txHash: id(0xf000), validUntil: w.clock + TTL });
  assert.match(w.warnings.join('\n'), new RegExp(`relay: sent but the result is unknown \\(tx ${id(0xf000)}\\)`), 'the hash does go in the warning');
  assert.equal(w.payer.health().dustSpentLastHour.relay, 55n);
  assert.equal(w.payer.health().lostFees.count, 0);
});

test('relay: bytes that are not a transaction → invalid-tx, without submitting anything', async (t) => {
  const w = world(t);
  assert.deepEqual(await w.payer.relay(new Uint8Array(0)), { error: 'invalid-tx' });
  assert.equal(w.sends.length, 0);
});

test('relay: anything that moves value (unshielded offer, DUST, Zswap) or calls nothing → not-relayable with the reason, without submitting', async (t) => {
  const w = world(t);
  for (const problem of ['unshielded-offer', 'dust-actions', 'zswap-offer', 'no-call'] as const) {
    w.problem = problem;
    assert.deepEqual(await w.payer.relay(TX), { error: 'not-relayable', reason: problem });
  }
  assert.equal(w.sends.length, 0);
  assert.equal(w.payer.health().dustSpentLastHour.relay, 0n);
});

test('relay: if inspecting it fails for another reason → internal (without the message), without submitting', async (t) => {
  const w = world(t);
  w.screenError = new Error('wasm exploded: secret detail');
  assert.deepEqual(await w.payer.relay(TX), { error: 'internal' });
  assert.equal(w.sends.length, 0);
  assert.match(w.warnings.join('\n'), /relay: could not inspect the transaction/);
});

test('relay: hard hourly DUST cap: does not pay what would exceed the cap, and pays again once it leaves the window', async (t) => {
  const w = world(t, { limits: { relayDustPerHour: 120n } });
  assert.equal(((await w.payer.relay(TX)) as { status: string }).status, 'SucceedEntirely'); // spent 55
  w.clock += 10 * MIN;
  assert.equal(((await w.payer.relay(TX)) as { status: string }).status, 'SucceedEntirely'); // 110 (55 + estimated 60 = 115 <= 120)
  w.clock += 10 * MIN;
  assert.deepEqual(await w.payer.relay(TX), { error: 'dust-cap', retryAfterS: 40 * 60 }, '110 + 60 > 120');
  assert.equal(w.sends.length, 2, 'the third one is not submitted');
  assert.equal(w.payer.health().dustSpentLastHour.relay, 110n);
  w.clock += 40 * MIN; // the first spend leaves the window
  assert.equal(((await w.payer.relay(TX)) as { status: string }).status, 'SucceedEntirely');
});

test('relay: the relay cap does not consume the issue cap, nor the other way round, advanceRound has no cap', async (t) => {
  const w = world(t, { limits: { relayDustPerHour: 0n, issueDustPerHour: 60n } });
  assert.deepEqual(await w.payer.relay(TX), { error: 'fee-over-cap' });
  assert.equal(((await w.payer.issue(id(1), 'free')) as { status: string }).status, 'issued');
  assert.deepEqual(await w.payer.issue(id(2), 'free'), { error: 'dust-cap', retryAfterS: 3600 });
  assert.equal(((await w.payer.advanceRound()) as { status: string }).status, 'advanced');
  assert.deepEqual(w.payer.health().dustSpentLastHour, { relay: 0n, issue: 55n });
  assert.deepEqual(w.payer.health().dustCapPerHour, { relay: 0n, issue: 60n });
});

test('relay: an estimated fee that alone exceeds the hourly cap → fee-over-cap (will never fit), without submitting', async (t) => {
  const w = world(t, { limits: { relayDustPerHour: 59n, issueDustPerHour: 59n } });
  assert.deepEqual(await w.payer.relay(TX), { error: 'fee-over-cap' });
  assert.deepEqual(await w.payer.issue(id(1), 'free'), { error: 'fee-over-cap' });
  assert.equal(w.sends.length, 0);
  assert.match(w.warnings.join('\n'), /relay: the estimated fee \(60\) is over the hourly DUST cap \(59\)/);
});

test('relay: if the wallet cannot pay → dust-unavailable, it is transient for 30 min after a submission with an unknown outcome', async (t) => {
  const w = world(t, { script: ['balance-error', 'unknown', 'balance-error', 'balance-error'] });
  assert.deepEqual(await w.payer.relay(TX), { error: 'dust-unavailable', transient: false, retryAfterS: 60 });
  await w.payer.relay(TX); // unknown: the wallet holds DUST coins for up to 30 min
  w.clock += 29 * MIN;
  assert.deepEqual(await w.payer.relay(TX), { error: 'dust-unavailable', transient: true, retryAfterS: 60 });
  w.clock += 2 * MIN;
  assert.deepEqual(await w.payer.relay(TX), { error: 'dust-unavailable', transient: false, retryAfterS: 60 });
  assert.match(w.warnings.join('\n'), /secret detail/, 'the SDK detail goes to the log, not to the response');
});

test('relay: if fee estimation fails for a reason other than the bytes → dust-unavailable, without submitting', async (t) => {
  const w = world(t);
  w.failEstimate = new Error('Wallet.Sync');
  assert.deepEqual(await w.payer.relay(TX), { error: 'dust-unavailable', transient: false, retryAfterS: 60 });
  assert.equal(w.sends.length, 0);
});

test('single queue: operations do not overlap and the queue length shows in /health', async (t) => {
  let release!: (status: string) => void;
  const blocked = new Promise<string>((resolve) => { release = resolve; });
  const w = world(t, { script: [() => blocked] });
  const first = w.payer.relay(TX);
  const second = w.payer.issue(id(1), 'free');
  const third = w.payer.advanceRound();
  await tick();
  assert.equal(w.sends.length, 1, 'the second does not start until the first finishes');
  assert.equal(w.prepared.length, 0, 'it is not even proven');
  assert.equal(w.payer.health().queueLength, 3);
  release('SucceedEntirely');
  await Promise.all([first, second, third]);
  assert.deepEqual(w.prepared.map((p) => p.circuit), ['issueBono', 'advanceRound']);
  assert.equal(w.payer.health().queueLength, 0);
});

test('queue full → queue-full without enqueuing, an unexpected failure → internal and the queue continues', async (t) => {
  let release!: (status: string) => void;
  const blocked = new Promise<string>((resolve) => { release = resolve; });
  const w = world(t, { limits: { maxQueue: 2 }, script: [() => blocked, () => { throw new Error('socket hang up: secret'); }] });
  const first = w.payer.relay(TX);
  const second = w.payer.relay(TX);
  assert.deepEqual(await w.payer.relay(TX), { error: 'queue-full' });
  assert.deepEqual(await w.payer.issue(id(1), 'free'), { error: 'queue-full' });
  assert.deepEqual(await w.payer.advanceRound(), { error: 'queue-full' });
  release('SucceedEntirely');
  assert.equal(((await first) as { status: string }).status, 'SucceedEntirely');
  assert.deepEqual(await second, { error: 'internal' });
  assert.match(w.warnings.join('\n'), /socket hang up/);
  assert.equal(((await w.payer.relay(TX)) as { status: string }).status, 'SucceedEntirely');
});

// --- issue --------------------------------------------------------------------------------------------

test('issue: issues the leaf for the id with its plan, while submitting it stays recorded in the journal and is removed when done', async (t) => {
  const w = world(t);
  assert.deepEqual(await w.payer.issue(id(1), 'paid'), { status: 'issued', txHash: id(0xf000) });
  assert.deepEqual(w.prepared, [{ circuit: 'issueBono', args: [new Uint8Array(Buffer.from(id(1), 'hex')), Plan.paid] }]);
  assert.deepEqual(w.journalAtSend, { plan: 'paid', txHash: id(0xf000), validUntil: w.clock + TTL }, 'recorded BEFORE submitting');
  assert.equal(w.journal.size, 0);
  assert.equal(w.tree.has(leafHex(id(1), Plan.paid)), true);
  assert.equal(w.payer.health().dustSpentLastHour.issue, 55n);
});

test('issue: repeating an already issued id → already-issued, without proving or submitting again (also without a journal)', async (t) => {
  const w = world(t);
  await w.payer.issue(id(1), 'free');
  assert.deepEqual(await w.payer.issue(id(1), 'free'), { status: 'already-issued' });
  assert.equal(w.prepared.length, 1);
  assert.equal(w.sends.length, 1);
  // A leaf already in the tree that this process knows nothing about (another dataDir, lost journal).
  w.tree.add(leafHex(id(2), Plan.paid));
  assert.deepEqual(await w.payer.issue(id(2), 'paid'), { status: 'already-issued' });
  assert.equal(w.sends.length, 1);
});

test('issue: the same id with another plan → id-conflict (in the tree or in flight), without issuing', async (t) => {
  const w = world(t, { script: ['SucceedEntirely', 'unknown'] });
  await w.payer.issue(id(1), 'free');
  assert.deepEqual(await w.payer.issue(id(1), 'paid'), { error: 'id-conflict' });
  await w.payer.issue(id(2), 'paid'); // unknown: in flight
  assert.deepEqual(await w.payer.issue(id(2), 'free'), { error: 'id-conflict' });
  assert.equal(w.sends.length, 2);
});

test('issue: unknown outcome → pending, not reissued while the transaction can still land, if it lands, already-issued', async (t) => {
  const w = world(t, { script: ['unknown'] });
  const retryAfterS = (TTL + MIN) / 1000;
  assert.deepEqual(await w.payer.issue(id(1), 'free'), { status: 'pending', txHash: id(0xf000), retryAfterS });
  assert.equal(w.journal.size, 1, 'still recorded');
  w.clock += 30 * MIN;
  assert.deepEqual(await w.payer.issue(id(1), 'free'), { status: 'pending', txHash: id(0xf000), retryAfterS: retryAfterS - 30 * 60 });
  w.clock += 31 * MIN; // exactly at the limit (expiry + margin): not yet
  assert.deepEqual(await w.payer.issue(id(1), 'free'), { status: 'pending', txHash: id(0xf000), retryAfterS: 1 });
  assert.equal(w.sends.length, 1, 'not resubmitted');
  w.tree.add(leafHex(id(1), Plan.free)); // the transaction did land
  assert.deepEqual(await w.payer.issue(id(1), 'free'), { status: 'already-issued' });
  assert.equal(w.journal.size, 0);
  assert.equal(w.sends.length, 1);
});

test('issue: past the expiry (plus the margin) without a leaf, it is issued again', async (t) => {
  const w = world(t, { script: ['unknown'] });
  await w.payer.issue(id(1), 'free');
  w.clock += TTL + MIN + 1;
  assert.deepEqual(await w.payer.issue(id(1), 'free'), { status: 'issued', txHash: id(0xf001) });
  assert.equal(w.sends.length, 2);
  assert.equal(w.journal.size, 0);
});

test('issue: the expiry of an in-flight issuance is judged by the indexer time, not the local clock', async (t) => {
  const w = world(t, { script: ['unknown'] });
  await w.payer.issue(id(1), 'free');
  w.clock += TTL + MIN + 1000; // expired by the local clock (plus margin)...
  w.indexerLag = 90_000; // ...but the indexer has not got there yet: the leaf may still be indexed
  assert.deepEqual(await w.payer.issue(id(1), 'free'), { status: 'pending', txHash: id(0xf000), retryAfterS: 89 });
  assert.equal(w.sends.length, 1, 'not reissued');
  w.indexerLag = 0;
  assert.deepEqual(await w.payer.issue(id(1), 'free'), { status: 'issued', txHash: id(0xf001) });
});

test('issue: recording another issuance forgets only the ones expired according to the indexer', async (t) => {
  const w = world(t, { script: ['unknown'] });
  await w.payer.issue(id(1), 'free');
  w.clock += TTL + MIN + 1000;
  w.indexerLag = 90_000;
  assert.equal(((await w.payer.issue(id(2), 'free')) as { status: string }).status, 'issued');
  assert.equal(w.journal.get(id(1))?.txHash, id(0xf000), 'the one for id 1 can still land: still recorded');
});

test('issue: with the indexer more than 2 min behind nothing is issued (it is unknown whether the leaf exists): indexer-behind', async (t) => {
  const w = world(t);
  w.indexerLag = 120_001;
  assert.deepEqual(await w.payer.issue(id(1), 'free'), { error: 'indexer-behind', retryAfterS: 30 });
  assert.equal(w.prepared.length, 0);
  assert.match(w.warnings.join('\n'), /issue: the indexer is 121 s behind/);
  w.indexerLag = 120_000;
  assert.equal(((await w.payer.issue(id(1), 'free')) as { status: string }).status, 'issued');
});

test('issue: an in-flight issuance of the other plan that already expired without a leaf is not a conflict: it is forgotten and issued', async (t) => {
  const w = world(t, { script: ['unknown'] });
  await w.payer.issue(id(1), 'paid');
  w.clock += TTL + MIN + 1;
  assert.deepEqual(await w.payer.issue(id(1), 'free'), { status: 'issued', txHash: id(0xf001) });
  assert.equal(w.journal.size, 0);
});

test('issue: what is in flight survives a payer restart (journal on disk)', async (t) => {
  const w = world(t, { script: ['unknown'] });
  await w.payer.issue(id(1), 'free');
  const restarted = world(t, { dir: w.dir });
  restarted.clock = w.clock + MIN;
  const again = await restarted.payer.issue(id(1), 'free');
  assert.deepEqual(again, { status: 'pending', txHash: id(0xf000), retryAfterS: TTL / 1000 });
  assert.equal(restarted.sends.length, 0);
});

test('issue: FailFallible → failed (fee lost and counted), nothing is left half done and it can be retried', async (t) => {
  const w = world(t, { script: ['FailFallible'] });
  assert.deepEqual(await w.payer.issue(id(1), 'free'), { status: 'failed', reason: 'fee-lost', txHash: id(0xf000) });
  assert.deepEqual(w.payer.health().lostFees, { count: 1, dust: 55n, byCause: { 'issue:FailFallible': { count: 1, dust: 55n } } });
  assert.equal(w.journal.size, 0);
  assert.deepEqual(await w.payer.issue(id(1), 'free'), { status: 'issued', txHash: id(0xf001) });
});

test('issue: node rejection → failed at no cost, it can be retried right away', async (t) => {
  const w = world(t, { script: ['rejected'] });
  assert.deepEqual(await w.payer.issue(id(1), 'free'), { status: 'failed', reason: 'rejected' });
  assert.equal(w.journal.size, 0);
  assert.equal(w.payer.health().lostFees.count, 0);
  assert.equal(w.payer.health().dustSpentLastHour.issue, 0n);
  assert.equal(((await w.payer.issue(id(1), 'free')) as { status: string }).status, 'issued');
});

test('issue: if it cannot be recorded in the journal, it is not submitted (internal) and nothing is left in flight', async (t) => {
  const w = world(t);
  rmSync(w.dir, { recursive: true }); // the journal can no longer write
  assert.deepEqual(await w.payer.issue(id(1), 'free'), { error: 'internal' });
  assert.equal(w.sends.length, 0);
  assert.equal(w.journal.size, 0, 'not in memory either');
});

test('issue: if the call cannot be built or proven → failed not-prepared, without submitting', async (t) => {
  const w = world(t);
  w.failPrepare = new Error('Not the operator: secret');
  assert.deepEqual(await w.payer.issue(id(1), 'free'), { status: 'failed', reason: 'not-prepared' });
  assert.equal(w.sends.length, 0);
  assert.match(w.warnings.join('\n'), /Not the operator/);
});

test('issue and advanceRound without a deployed contract → no-contract, relay works the same', async (t) => {
  const w = world(t, { registry: false });
  assert.deepEqual(await w.payer.issue(id(1), 'free'), { error: 'no-contract' });
  assert.deepEqual(await w.payer.advanceRound(), { error: 'no-contract' });
  assert.equal(((await w.payer.relay(TX)) as { status: string }).status, 'SucceedEntirely');
  assert.equal(w.payer.health().contract, null);
});

// --- advanceRound -------------------------------------------------------------------------------------

test('advanceRound: advances and returns the new round', async (t) => {
  const w = world(t);
  assert.deepEqual(await w.payer.advanceRound(), { status: 'advanced', round: 8, txHash: id(0xf000) });
  assert.deepEqual(w.prepared, [{ circuit: 'advanceRound', args: [] }]);
});

test('advanceRound: anything that is not an advance is reported as is (rejection, unknown, lost fee, not prepared)', async (t) => {
  const w = world(t, { script: ['rejected', 'unknown', 'FailFallible'] });
  assert.deepEqual(await w.payer.advanceRound(), { status: 'failed', reason: 'rejected' });
  assert.deepEqual(await w.payer.advanceRound(), { status: 'unknown', txHash: id(0xf001), validUntil: w.clock + TTL });
  assert.deepEqual(await w.payer.advanceRound(), { status: 'failed', reason: 'fee-lost', txHash: id(0xf002) });
  assert.equal(w.payer.health().lostFees.byCause['advance:FailFallible']!.count, 1);
  w.failPrepare = new Error('proof server down');
  assert.deepEqual(await w.payer.advanceRound(), { status: 'failed', reason: 'not-prepared' });
});

test('advanceRound: if it advanced but the new round cannot be read → advanced with round null (never an error: it was paid)', async (t) => {
  const w = world(t);
  w.failRound = new Error('indexer down');
  assert.deepEqual(await w.payer.advanceRound(), { status: 'advanced', round: null, txHash: id(0xf000) });
  assert.match(w.warnings.join('\n'), /advance: advanced \(tx .*\) but the new round could not be read/);
});

// --- stop and stuck jobs ------------------------------------------------------------------------------

test('stop: waiting and incoming work → stopping without submitting, waits for the running work to finish', async (t) => {
  let release!: (status: string) => void;
  const w = world(t, { script: [() => new Promise<string>((resolve) => { release = resolve; })] });
  const first = w.payer.relay(TX);
  const second = w.payer.issue(id(1), 'free');
  await tick();
  let stopped = false;
  const stopping = w.payer.stop().then(() => { stopped = true; });
  assert.deepEqual(await w.payer.advanceRound(), { error: 'stopping' });
  assert.deepEqual(await w.payer.relay(TX), { error: 'stopping' });
  await assert.rejects(w.payer.exclusive(async () => 'register NIGHT'), /stopping/);
  await tick();
  assert.equal(stopped, false);
  release('SucceedEntirely');
  assert.deepEqual(await first, { status: 'SucceedEntirely', txHash: id(0xf000) });
  assert.deepEqual(await second, { error: 'stopping' });
  await stopping;
  assert.equal(w.sends.length, 1);
  assert.equal(w.prepared.length, 0);
});

test('a job past its deadline warns (onStuck) once and stays in the log', async (t) => {
  let release!: (status: string) => void;
  const w = world(t, { jobDeadlineMs: 5, script: [() => new Promise<string>((resolve) => { release = resolve; })] });
  const first = w.payer.relay(TX);
  for (let i = 0; i < 200 && w.stuck === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.match(w.warnings.join('\n'), /relay: still running after 0 s: stuck/);
  release('SucceedEntirely');
  await first;
  assert.equal(w.stuck, 1);
  await w.payer.relay(TX); // one that finishes in time does not warn
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(w.stuck, 1);
});

// --- health -------------------------------------------------------------------------------------------

test('health: ready only with a synced wallet and spendable DUST, exposes coins, balance, queue, caps and losses', (t) => {
  const w = world(t);
  assert.deepEqual(w.payer.health(), {
    ready: true, dustCoins: 5, dustBalance: 1250n, queueLength: 0,
    lostFees: { count: 0, dust: 0n, byCause: {} },
    dustSpentLastHour: { relay: 0n, issue: 0n },
    dustCapPerHour: { relay: 1000n, issue: 1000n },
    issuesInFlight: 0,
    contract: R,
  });
  w.wallet = { synced: false, dustCoins: 5, dustBalance: 1n };
  assert.equal(w.payer.health().ready, false);
  w.wallet = { synced: true, dustCoins: 0, dustBalance: 1n };
  assert.equal(w.payer.health().ready, false);
});
