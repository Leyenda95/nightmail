// Devnet check: does the indexer still return registry state at the height of a FailFallible transaction
// (in a block, fee paid, nothing applied)? An empty state would make the mail server's sync get stuck.
// Concurrent issueBono calls proved against the same tree state fail about 1 pair in 6; it tries up to
// ROUNDS rounds of AT_ONCE submissions and skips if none fails. Uses the deployed registry and operator
// wallet; leaves leaves in the devnet tree and may spend DUST.
// Run: cd apps/server && node --max-old-space-size=4096 --test --test-concurrency=1
//   --test-timeout=3600000 test-devnet/failed-tx.devnet.ts
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Transaction } from '@midnightntwrk/ledger-v9';
import { ctx as ctxOf, fetchRegistry, idK, NO_EXPIRY, Plan, type RegistryAt } from '@nightmail/midnight';
import { loadConfig, readRegistryAddress } from '../src/config.ts';
import { openChain, sendPrepared, type ChainContract, type Outcome } from '../src/chain/midnight.ts';
import { registryWitnesses, type RegistryPrivateState as PS } from '../src/chain/registry.ts';
import { contractActionSource, httpGraphQL } from '../src/registry/indexer.ts';
import type { ActionNotice } from '../src/registry/sync.ts';
import { ensureSpendableDust, openOperatorWallet, type OperatorWallet } from '../src/wallet/operatorWallet.ts';
import { WalletInUseError } from '../src/wallet/storage.ts';

const ROUNDS = 5;
const AT_ONCE = 3;
/** States of a transaction that landed in a block but did not apply everything (fee charged). */
const IN_BLOCK_FAILURES = new Set(['FailFallible', 'FailEntirely', 'PartialSuccess', 'Failure']);

const rand = () => new Uint8Array(randomBytes(32));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const config = loadConfig('undeployed');
const R = readRegistryAddress(config);
const opSk = new Uint8Array(Buffer.from(readFileSync(path.join(config.dataDir, 'operator-sk'), 'utf8').trim(), 'hex'));
const ctx = ctxOf(R);
const gql = httpGraphQL(config.indexer);
const lines: string[] = [];
const log = (line: string) => { lines.push(line); console.log(`[failed-tx.devnet] ${line}`); };

let wallet: OperatorWallet;
let registry: ChainContract;

async function openWalletWhenFree(): Promise<OperatorWallet> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await openOperatorWallet(config);
    } catch (error) {
      if (!(error instanceof WalletInUseError) || attempt >= 90) throw error;
      if (attempt === 0) log('the operator wallet is busy: waiting');
      await sleep(10_000);
    }
  }
}

/** Direct indexer query (to see what fetchRegistry does not ask for). */
async function ask(query: string, variables: Record<string, unknown>): Promise<any> {
  const body = (await gql(query, variables)) as { data?: any; errors?: unknown };
  assert.equal(body.errors, undefined, `GraphQL: ${JSON.stringify(body.errors)}`);
  return body.data;
}

type Sent = { label: string; outcome: Outcome; hash?: string; identifier?: string };

/** Like registry.send, but records the hash and identifier of the signed transaction before submitting it. */
async function sendTracked(label: string, p: Awaited<ReturnType<ChainContract['prepare']>>): Promise<Sent> {
  const sent: Sent = { label, outcome: undefined as unknown as Outcome };
  sent.outcome = await sendPrepared({ wallet, base: registry.providers }, p, undefined, (finalized: any) => {
    try {
      const tx = Transaction.deserialize('signature', 'proof', 'binding', finalized.serialize());
      sent.hash = String(tx.transactionHash());
      sent.identifier = String(tx.identifiers()[0]);
    } catch (e) {
      log(`${label}: could not read the hash (${String(e).slice(0, 120)})`);
    }
  });
  return sent;
}

const TX = `query ($hash: HexEncoded!) {
  transactions(offset: { hash: $hash }) {
    __typename hash block { height hash }
    ... on RegularTransaction { identifiers fee transactionResult { status segments { id success } } }
    contractActions { __typename address stateAt { height } }
  }
}`;
const TX_BY_ID = TX.replace('$hash: HexEncoded!', '$id: HexEncoded!').replace('{ hash: $hash }', '{ identifier: $id }');
const ACTION_OF_TX = `query ($address: HexEncoded!, $hash: HexEncoded!) {
  contractAction(address: $address, offset: { transactionOffset: { hash: $hash } }) {
    __typename state stateAt { height hash } transaction { hash }
  }
}`;
const CONTRACT_AT = `query ($address: HexEncoded!, $offset: BlockOffset) {
  contract(address: $address, offset: $offset) {
    stateAt { height hash }
    actions(limit: 12) { __typename stateAt { height } transaction { hash } ... on ContractCall { entryPoint } }
  }
}`;

/** The transaction in the indexer (waits a little: it may lag behind the block). */
async function indexedTx(s: Sent): Promise<any> {
  for (let i = 0; i < 60; i++) {
    let txs: any[] = s.hash ? (await ask(TX, { hash: s.hash })).transactions : [];
    if (!txs.length && s.identifier) txs = (await ask(TX_BY_ID, { id: s.identifier })).transactions;
    if (txs.length) return txs[0];
    await sleep(1000);
  }
  assert.fail(`${s.label}: the indexer does not have transaction ${s.hash} (${s.identifier})`);
}

/** What the `contractActions` subscription (the server's) delivers from `height`, for `ms`. */
async function noticesFrom(height: number, ms = 8000): Promise<ActionNotice[]> {
  const out: ActionNotice[] = [];
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), ms);
  try {
    for await (const n of contractActionSource(config.indexerWS, R)(height, stop.signal, () => {})) out.push(n);
  } catch (e) {
    if (!stop.signal.aborted) throw e;
  } finally {
    clearTimeout(timer);
  }
  return out;
}

const summary = (r: RegistryAt | null) =>
  r ? `block ${r.blockHeight}, ${r.snapshot.addresses.length} addresses, ${r.stateBytes} B` : 'null';

before(async () => {
  wallet = await openWalletWhenFree();
  await ensureSpendableDust(wallet);
  const chain = await openChain(config, wallet);
  registry = await chain.contract('registry', registryWitnesses(() => undefined)); // issueBono needs no paths
});

after(async () => {
  console.log(`\n[failed-tx.devnet] summary:\n${lines.join('\n')}`);
  if (wallet) await wallet.close();
});

test('M7: fetchRegistry at the height of a FailFallible issueBono (and at the head) returns a valid state', async (t) => {
  const started = performance.now();
  const initial = await fetchRegistry(gql, R);
  assert.ok(initial, 'a registry is deployed');
  log(`before: ${summary(initial)}`);
  const addresses = initial.snapshot.addresses.length;

  let failed: Sent | undefined;
  let round: Sent[] = [];
  for (let r = 1; r <= ROUNDS && !failed; r++) {
    // AT_ONCE new `bono`s (each with its own s), proved against the same state and submitted together.
    const prepared = [];
    for (let i = 0; i < AT_ONCE; i++) {
      const s = rand();
      const ps: PS = { bono: { s, k: 0n, plan: Plan.paid, validUntil: NO_EXPIRY }, j: 0n, opSk };
      prepared.push(await registry.prepare(R, 'issueBono', ps, [idK(ctx, s, 0n), Plan.paid]));
    }
    round = await Promise.all(prepared.map((p, i) => sendTracked(`round ${r} · ${i + 1}`, p)));
    for (const s of round) log(`${s.label}: ${s.outcome.status}${s.outcome.error ? ` (${s.outcome.error.slice(0, 160)})` : ''}`);
    failed = round.find((s) => IN_BLOCK_FAILURES.has(s.outcome.status));
  }

  if (!failed) {
    log(`no FailFallible after ${ROUNDS} rounds of ${AT_ONCE}: M7 cannot be checked in this run`);
    t.skip(`no FailFallible in ${ROUNDS} rounds of ${AT_ONCE} concurrent issueBono`);
    return;
  }

  // Where the failed one ended up, according to the indexer.
  const tx = await indexedTx(failed);
  const h: number = tx.block.height;
  log(`failed: ${failed.label}, tx ${tx.hash}, block ${h}, result ${JSON.stringify(tx.transactionResult)}, fee ${tx.fee}`);
  log(`  its contractActions in the transaction: ${JSON.stringify(tx.contractActions)}`);
  let succeededInBlock = 0; // this round's issueBono calls applied in the same block as the failed one
  for (const s of round.filter((x) => x !== failed && x.hash && !['rejected', 'balance-error', 'record-error'].includes(x.outcome.status))) {
    const other = await indexedTx(s).catch(() => null);
    if (!other) continue;
    log(`  ${s.label}: ${s.outcome.status}, block ${other.block.height}, result ${other.transactionResult?.status}`);
    if (s.outcome.ok && other.block.height === h) succeededInBlock++;
  }

  const action = (await ask(ACTION_OF_TX, { address: R, hash: tx.hash })).contractAction;
  log(`contractAction(failed transaction): ${action
    ? `${action.__typename}, stateAt ${action.stateAt.height}, tx ${action.transaction.hash}, state ${action.state === '' ? "''" : `${action.state.length / 2} B`}`
    : 'null'}`);
  const at = (await ask(CONTRACT_AT, { address: R, offset: { height: h } })).contract;
  log(`contract(offset ${h}).stateAt = ${at.stateAt.height}; recent actions: ${
    at.actions.map((a: any) => `${a.entryPoint ?? a.__typename}@${a.stateAt.height}${a.transaction.hash === tx.hash ? ' (THE FAILED ONE)' : ''}`).join(', ')}`);
  const notices = await noticesFrom(h);
  log(`contractActions subscription from ${h}: ${notices.map((n) => `${n.entryPoint}@${n.height}`).join(', ') || '(none)'}`);

  // The actual question: fetchRegistry at that height and without a height does not throw and returns the same registry.
  const atHeight = await fetchRegistry(gql, R, h);
  log(`fetchRegistry(R, ${h}): ${summary(atHeight)}`);
  const head = await fetchRegistry(gql, R);
  log(`fetchRegistry(R) (head): ${summary(head)}`);
  log(`test time: ${((performance.now() - started) / 1000).toFixed(0)} s`);

  assert.ok(atHeight && head);
  assert.equal(atHeight.blockHeight, h);
  assert.equal(atHeight.snapshot.addresses.length, addresses, 'issueBono adds no addresses');
  assert.equal(head.snapshot.addresses.length, addresses);
  assert.ok(atHeight.stateBytes > 0 && head.stateBytes > 0);
  assert.equal(at.actions.some((a: any) => a.transaction.hash === tx.hash), false, 'the failed action is not among the contract actions');
  assert.equal(notices.filter((n) => n.height === h && n.entryPoint === 'issueBono').length, succeededInBlock,
    'the subscription only delivers the actions that applied');
});
