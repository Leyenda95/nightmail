// Devnet check for the payer's early relay answer (NIGHTMAIL_PAYER_EARLY_RELAY_ANSWER, payer.ts): is a
// guaranteed-only client call that the node reports "in a block" always applied? The doubt: the node client
// reports InBlock from the pool status, and the indexer can list transactions that are in a block as failed.
//
// How: two createAlias calls for the SAME slot (same bono, same j, different keys), proved against the same state,
// so each passes the pool check on its own but only one can apply (the second slot nullifier insert fails in the
// guaranteed part). Both are balanced and submitted at once by the operator wallet, as the payer would (DUST only,
// not signed), watching for InBlock. The claim holds if the loser is NEVER reported in a block: it must end as a
// pool rejection or a drop. Whatever the indexer says about the loser is recorded.
// Opens the operator wallet itself (stop the payer first; it waits while the wallet is busy). Issues one free bono and
// spends ROUNDS of its slots on every run, and some DUST.
// Run: cd apps/server && node --max-old-space-size=4096 --test --test-concurrency=1
//   --test-timeout=3600000 test-devnet/inblock.devnet.ts
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Transaction } from '@midnightntwrk/ledger-v9';
import { ctx as ctxOf, idK, Kind, leaf as leafOf, NO_EXPIRY, Plan, slotNul, toHex } from '@nightmail/midnight';
import { loadConfig, readRegistryAddress } from '../src/config.ts';
import { nodeRejectionCode, openChain, sendPrepared, type ChainContract, type Outcome, type Prepared } from '../src/chain/midnight.ts';
import { guaranteedOnly } from '../src/chain/relayable.ts';
import { hasBonoLeaf, registryWitnesses, type Bono, type RegistryPrivateState as PS } from '../src/chain/registry.ts';
import { httpGraphQL } from '../src/registry/indexer.ts';
import { ensureSpendableDust, openOperatorWallet, type OperatorWallet } from '../src/wallet/operatorWallet.ts';
import { WalletInUseError } from '../src/wallet/storage.ts';

/**
 * Pairs to try (one slot each). The pair may land in one block or in two: both cases test the claim. At most 2: a
 * free bono has 2 alias slots (NightMailRegistry.compact, checkSlot), so a third round could never apply.
 */
const ROUNDS = 2;

const rand = () => new Uint8Array(randomBytes(32));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const config = loadConfig('undeployed');
const R = readRegistryAddress(config);
const opSk = new Uint8Array(Buffer.from(readFileSync(path.join(config.dataDir, 'operator-sk'), 'utf8').trim(), 'hex'));
const ctx = ctxOf(R);
const gql = httpGraphQL(config.indexer);
const positions = new Map<string, bigint>();
const lines: string[] = [];
const log = (line: string) => { lines.push(line); console.log(`[inblock.devnet] ${line}`); };

let wallet: OperatorWallet;
let registry: ChainContract;
const bono: Bono = { s: rand(), k: 0n, plan: Plan.free, validUntil: NO_EXPIRY };

async function openWalletWhenFree(): Promise<OperatorWallet> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await openOperatorWallet(config);
    } catch (error) {
      if (!(error instanceof WalletInUseError) || attempt >= 90) throw error;
      if (attempt === 0) log('the operator wallet is busy (stop the payer): waiting');
      await sleep(10_000);
    }
  }
}

type Sent = { label: string; outcome: Outcome; inBlock: number | null; hash?: string; identifier?: string };

/** Pays and submits like the payer does for a relay (foreign: DUST only, no signature), noting any InBlock report. */
async function relayLike(label: string, p: Prepared, t0: number): Promise<Sent> {
  const sent: Sent = { label, outcome: undefined as unknown as Outcome, inBlock: null };
  sent.outcome = await sendPrepared({ wallet, base: registry.providers }, { ...p, foreign: true }, undefined, (finalized: any) => {
    const tx = Transaction.deserialize('signature', 'proof', 'binding', finalized.serialize());
    sent.hash = String(tx.transactionHash());
    sent.identifier = String(tx.identifiers()[0]);
  }, () => { sent.inBlock = performance.now() - t0; });
  return sent;
}

const TX = `query ($hash: HexEncoded!) {
  transactions(offset: { hash: $hash }) {
    hash block { height } ... on RegularTransaction { transactionResult { status segments { id success } } }
  }
}`;
const TX_BY_ID = TX.replace('$hash: HexEncoded!', '$id: HexEncoded!').replace('{ hash: $hash }', '{ identifier: $id }');

/** What the indexer says about a transaction (by hash, then identifier), waiting up to `ms`; null if nothing. */
async function indexed(s: Sent, ms: number): Promise<unknown> {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(1000)) {
    for (const [query, variables] of [[TX, { hash: s.hash }], [TX_BY_ID, { id: s.identifier }]] as const) {
      if (!Object.values(variables)[0]) continue;
      const body = (await gql(query, variables)) as { data?: { transactions: unknown[] }; errors?: unknown };
      assert.equal(body.errors, undefined, `GraphQL: ${JSON.stringify(body.errors)}`);
      if (body.data?.transactions.length) return body.data.transactions[0];
    }
  }
  return null;
}

before(async () => {
  wallet = await openWalletWhenFree();
  assert.ok(wallet.inclusion, 'the operator wallet reports inclusions');
  await ensureSpendableDust(wallet);
  const chain = await openChain(config, wallet);
  registry = await chain.contract('registry', registryWitnesses((leafHex) => positions.get(leafHex)));
  // The bono both calls spend: issued by the operator, at the first free position (only the operator inserts).
  const first = (await registry.ledgerState(R)).bonos.firstFree();
  const leaf = leafOf(ctx, idK(ctx, bono.s, 0n), Plan.free, NO_EXPIRY);
  positions.set(toHex(leaf), first);
  const ps: PS = { bono, j: 0n, opSk };
  const issued = await registry.send(await registry.prepare(R, 'issueBono', ps, [idK(ctx, bono.s, 0n), Plan.free]));
  assert.equal(issued.status, 'SucceedEntirely', `issueBono: ${issued.status} ${issued.error ?? ''}`);
  assert.equal(hasBonoLeaf((await registry.state(R)).data, leaf), true);
});

after(async () => {
  console.log(`\n[inblock.devnet] summary:\n${lines.join('\n')}`);
  if (wallet) await wallet.close();
});

test('two conflicting guaranteed-only calls: the loser is never reported in a block (or the early answer is unsafe)', async () => {
  const wins: Sent[] = [];
  for (let j = 0n; j < BigInt(ROUNDS); j++) {
    const ps: PS = { bono, j, opSk: new Uint8Array(32) };
    // Same slot, different keys: both valid against the current state, only one can apply.
    const prepared = [await registry.prepare(R, 'createAlias', ps, [rand(), rand()]), await registry.prepare(R, 'createAlias', ps, [rand(), rand()])];
    for (const p of prepared) {
      assert.equal(guaranteedOnly(Transaction.deserialize('signature', 'proof', 'pre-binding', p.bytes)), true, 'guaranteed only, as relayed');
    }
    const t0 = performance.now();
    const pair = await Promise.all(prepared.map((p, i) => relayLike(`slot ${j} · ${i === 0 ? 'A' : 'B'}`, p, t0)));
    const nullified = (await registry.ledgerState(R)).slotNullifiers.member(slotNul(ctx, bono.s, Kind.alias, j, 0n));
    for (const s of pair) {
      const seen = s.outcome.status === 'SucceedEntirely' ? null : await indexed(s, 20_000);
      log(`${s.label}: final ${s.outcome.status}, `
        + `InBlock ${s.inBlock === null ? 'never' : `at ${Math.round(s.inBlock)} ms`}, indexer ${seen === null ? '-' : JSON.stringify(seen)}`);
      // In full, so a rejection can be told apart (pool code, wallet text) without rerunning.
      if (s.outcome.error) log(`${s.label}: node code ${nodeRejectionCode(s.outcome.error) ?? '-'}, error: ${s.outcome.error}`);
    }
    assert.equal(nullified, true, 'the slot was spent once');
    const winners = pair.filter((s) => s.outcome.status === 'SucceedEntirely');
    assert.equal(winners.length, 1, `exactly one applies: ${pair.map((s) => s.outcome.status).join(', ')}`);
    wins.push(...winners);
    const loser = pair.find((s) => s !== winners[0])!;
    // The claim. If this fails, keep NIGHTMAIL_PAYER_EARLY_RELAY_ANSWER off.
    assert.equal(loser.inBlock, null,
      `DISPROVEN: the loser was reported in a block and ended ${loser.outcome.status}: an early answer would have said SucceedEntirely`);
    assert.ok(['rejected', 'unknown'].includes(loser.outcome.status), `the loser never reached a block: ${loser.outcome.status}`);
  }
  for (const s of wins) assert.notEqual(s.inBlock, null, `${s.label}: the winner was reported in a block before its final result`);
});
