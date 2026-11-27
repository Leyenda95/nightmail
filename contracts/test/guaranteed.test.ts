// Which part of the transaction (guaranteed or fallible) each circuit runs in.
// midnight-js splits a call's transcript with the ledger's `partitionTranscripts`, which only cuts at
// `ckpt` operations (kernel.checkpoint()). This contract has none, so the split is all-or-nothing:
// the whole transcript goes to the guaranteed part if it fits its discard budget, otherwise all of it
// goes to the fallible part. Effects are never left half-applied (charging without issuing the leaf,
// spending a slot without creating the address).
// - Guaranteed part: a failure is a node rejection before the block, with no fee.
// - Fallible part: a failing transaction lands in a block and pays a fee (with no effects).
// Every circuit except issueBono, which does not fit today (second test), must be fully guaranteed.
// The split is computed the way compact-js does it, with the ledger's initial parameters (what
// midnight-js uses when it does not get them from the chain) and a tree with some leaves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as ledger from '@midnightntwrk/ledger-v9';
import { deploy, pc, Plan, PRICE, rand } from './sim.ts';

const CIRCUITS = ['issueBono', 'buyBono', 'setPrice', 'createAlias', 'registerMailbox'];
/** Circuits whose transcript went through `partition` (and its `ckpt` check). */
const partitioned = new Set<string>();

/** Ledger QueryContext built from the one the runtime leaves in the call trace. */
function ledgerContext(runtimeContext: any): any {
  const q: any = new ledger.QueryContext(
    new ledger.ChargedState(ledger.StateValue.decode(runtimeContext.state.state.encode())), runtimeContext.address);
  q.block = runtimeContext.block;
  q.effects = runtimeContext.effects;
  return q;
}

/** What midnight-js builds for an executed call: [guaranteed, fallible]. */
function partition(executed: any) {
  const call = executed.context.callProofDataTrace.at(-1);
  // The all-or-nothing invariant: without `ckpt` there is nowhere to cut the transcript.
  assert.ok(!call.publicTranscript.includes('ckpt'), `${call.circuitId}: its transcript has a ckpt`);
  partitioned.add(call.circuitId);
  const initial = [...call.finalQueryContext.comIndices]
    .reduce((q: any, [commitment, index]: [string, bigint]) => q.insertCommitment(commitment, index), ledgerContext(call.initialQueryContext));
  const [guaranteed, fallible] = ledger.partitionTranscripts(
    [new ledger.PreTranscript(initial, [...call.publicTranscript])], ledger.LedgerParameters.initialParameters())[0]!;
  return { guaranteed, fallible, ops: call.publicTranscript.length };
}

function assertAllGuaranteed(label: string, executed: any) {
  const p = partition(executed);
  assert.equal(p.fallible, undefined, `${label}: has a fallible part`);
  assert.equal(p.guaranteed?.program.length, p.ops, `${label}: the guaranteed part is not the whole transcript`);
}

test('no fallible part: both branches of buyBono, setPrice and the other circuits (except issueBono)', async () => {
  const c = await deploy();
  const buy = (value: bigint) =>
    c.runFull('buyBono', {}, { nonce: rand(), color: c.paymentColor, value }, pc.bonoId(c.ctx, rand(), 0n));
  for (let i = 0; i < 40; i++) await c.issue(Plan.free); // a populated tree, not an empty contract
  const bono = await c.issue(Plan.paid);

  assertAllGuaranteed('buyBono at the current price', await buy(PRICE));
  assertAllGuaranteed('setPrice', await c.runFull('setPrice', { opSk: c.opSk }, 50n, c.time() + pc.oldPriceGrace()));
  assertAllGuaranteed('buyBono at the old price', await buy(PRICE)); // the long branch: map lookup and block time
  assertAllGuaranteed('buyBono at the new price', await buy(50n));
  assertAllGuaranteed('setPrice (second change)', await c.runFull('setPrice', { opSk: c.opSk }, 70n, c.time() + pc.oldPriceGraceMax()));
  assertAllGuaranteed('buyBono with two old prices', await buy(50n));

  assertAllGuaranteed('createAlias', await c.runFull('createAlias', { bono, j: 0n }, rand(), rand()));
  const m = c.mailbox('ana', bono, 0n);
  assertAllGuaranteed('registerMailbox', await c.runFull('registerMailbox', { bono, j: 0n }, m.name, m.encPk, m.authPk, m.nameCipher));
});

test('issueBono goes ENTIRELY to the fallible part: all or nothing', async () => {
  // With the initial parameters its transcript (~11 ms) does not fit the discard budget of such a
  // small transaction (15 ms minus its validation); buyBono fits because its transaction is larger and
  // the budget grows with size. Without kernel.checkpoint() the split is all-or-nothing, so no
  // half-applied effects, but an issueBono failing on chain lands in a block and pays a fee (only the
  // operator sends it, through its single queue). If this test fails, revisit the fee margin.
  const c = await deploy();
  for (const leaves of [0, 40]) {
    for (let i = 0; i < leaves; i++) await c.issue(Plan.free);
    const p = partition(await c.runFull('issueBono', { opSk: c.opSk }, pc.bonoId(c.ctx, rand(), 0n), Plan.free));
    assert.equal(p.guaranteed, undefined, 'issueBono now fits in the guaranteed part: update this test');
    assert.equal(p.fallible?.program.length, p.ops, 'the fallible part is the whole transcript');
  }
});

test('no circuit has a ckpt: the partition of any transcript is all or nothing', () => {
  // The transcripts run by the two previous tests already checked this, one per circuit.
  assert.deepEqual([...partitioned].sort(), [...CIRCUITS].sort(), 'the transcript of some circuit is not checked');
  // Nor is there a ckpt in a branch those tests did not run: the compiled contract emits none.
  const compiled = readFileSync(new URL('../managed/registry-sim/contract/index.js', import.meta.url), 'utf8');
  assert.ok(!compiled.includes('ckpt'), 'the compiled contract emits a ckpt (kernel.checkpoint())');
  assert.ok(compiled.includes('popeq'), 'the compiled contract no longer uses the expected operation names');
});
