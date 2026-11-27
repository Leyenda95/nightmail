// The real payer process on devnet, driven only over its Unix socket as the server does: issue
// and relay. Needs the devnet running, contracts compiled with keys and the service
// payer stopped; leaves a new `bono` and alias on every run.
// Run only this one: cd apps/server && node --max-old-space-size=4096 --test --test-concurrency=1
//   --test-timeout=3600000 test-devnet/payer.devnet.ts
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { aliasAddrKey, ctx as ctxOf, idK, Kind, leaf as leafOf, NO_EXPIRY, Plan, slotNul, toHex } from '@nightmail/midnight';
import { loadConfig, readRegistryAddress } from '../src/config.ts';
import { openChain, type ChainContract } from '../src/chain/midnight.ts';
import { hasBonoLeaf, registryWitnesses, type Bono, type RegistryPrivateState as PS } from '../src/chain/registry.ts';
import { payerClient, payerSocketPath, type PayerReply } from '../src/payer/client.ts';
import { Transaction } from '@midnightntwrk/ledger-v9';
import { httpGraphQL } from '../src/registry/indexer.ts';
import { checkRelayable, intentTtlMs } from '../src/relayer/validate.ts';

const rand = () => new Uint8Array(randomBytes(32));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const config = loadConfig('undeployed');
const R = readRegistryAddress(config);
const ctx = ctxOf(R);
const socketPath = payerSocketPath(config.dataDir);
const client = payerClient(socketPath);
const positions = new Map<string, bigint>();
const timings: string[] = [];
const output: string[] = [];

let payer: ChildProcess | undefined;
let exited: Promise<number | null> | undefined;
let registry: ChainContract; // the client side: builds and proves, no wallet

/** The test user's `bono`: the operator only sees its id. */
const bono: Bono = { s: rand(), k: 0n, plan: Plan.free, validUntil: NO_EXPIRY };
const id = toHex(idK(ctx, bono.s, 0n));
const leaf = leafOf(ctx, idK(ctx, bono.s, 0n), Plan.free, NO_EXPIRY);
const alias = { encPk: rand(), authPk: rand() };
let aliasTx = '';
let brokenIds: string[] = [];
let startCoins = 0;

const view = () => registry.ledgerState(R);
const gql = httpGraphQL(config.indexer);

/** A transaction's identifiers according to the indexer (waits: it may lag behind the block). */
async function indexedIdentifiers(hash: string): Promise<string[]> {
  const query = 'query ($hash: HexEncoded!) { transactions(offset: { hash: $hash }) { ... on RegularTransaction { identifiers } } }';
  for (let i = 0; i < 30; i++, await sleep(1000)) {
    const body = (await gql(query, { hash })) as { data?: { transactions: { identifiers?: string[] }[] }; errors?: unknown };
    assert.equal(body.errors, undefined, `GraphQL: ${JSON.stringify(body.errors)}`);
    const ids = body.data?.transactions[0]?.identifiers;
    if (ids) return ids;
  }
  return assert.fail(`the indexer does not have transaction ${hash}`);
}

async function timed<T>(label: string, work: () => Promise<PayerReply<T>>): Promise<PayerReply<T>> {
  const t0 = performance.now();
  const reply = await work();
  timings.push(`${label.padEnd(34)} ${String(reply.status).padEnd(4)} ${JSON.stringify(reply.body).slice(0, 60).padEnd(60)} ${((performance.now() - t0) / 1000).toFixed(1).padStart(6)} s`);
  return reply;
}

function startPayer(): { child: ChildProcess; exit: Promise<number | null> } {
  const child = spawn(process.execPath, ['--max-old-space-size=4096', 'src/bin/operator-wallet.ts'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, NIGHTMAIL_NETWORK: 'undeployed' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout!, child.stderr!]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => { output.push(...chunk.split('\n').filter((line) => line && !line.includes('RPC-CORE'))); });
  }
  return { child, exit: new Promise((resolve) => child.once('exit', (code) => resolve(code))) };
}

/** Starts the payer and waits until it is ready to pay. Retries if the wallet is busy (another test). */
async function startPayerWhenFree(): Promise<void> {
  for (let attempt = 0; attempt < 90; attempt++) {
    const started = startPayer();
    payer = started.child;
    exited = started.exit;
    const outcome = await Promise.race([
      started.exit.then((code) => ({ code })),
      (async () => {
        for (;;) {
          const health = await client.health().catch(() => undefined);
          if (health?.status === 200 && (health.body as { ready: boolean }).ready) return { ready: true };
          await sleep(500);
        }
      })(),
    ]);
    if ('ready' in outcome) return;
    payer = undefined;
    const log = output.join('\n');
    assert.match(log, /already in use/, `the payer exited with code ${outcome.code}:\n${log}`);
    if (attempt === 0) console.log('[payer.devnet] the operator wallet is busy: waiting');
    output.length = 0;
    await sleep(10_000);
  }
  assert.fail('the operator wallet did not become free');
}

before(async () => {
  const t0 = performance.now();
  await startPayerWhenFree();
  timings.push(`${'startup until ready'.padEnd(34)} ${''.padEnd(65)} ${((performance.now() - t0) / 1000).toFixed(1).padStart(6)} s`);
  // "The client": midnight-js against the indexer and the proof server, with no wallet (never balances or submits).
  const noKey = { toHexString: () => '00'.repeat(32) };
  const noWallet = { facade: { waitForSyncedState: async () => ({ shielded: { coinPublicKey: noKey, encryptionPublicKey: noKey } }) } };
  const chain = await openChain(config, noWallet as never);
  registry = await chain.contract('registry', registryWitnesses((leafHex) => positions.get(leafHex)));
});

after(async () => {
  if (payer) {
    payer.kill('SIGTERM');
    const code = await Promise.race([exited!, sleep(30_000).then(() => 'timeout' as const)]);
    if (code !== 0) console.log(`[payer.devnet] the payer exited with ${code}`);
  }
  console.log(`\nTimings over the payer socket (devnet):\n${timings.join('\n')}`);
  console.log(`\nPayer output:\n${output.filter((line) => !line.startsWith('[wallet] syncing')).join('\n')}`);
});

test('/health: ready, with DUST coins and balance, no queue and the devnet contract', async () => {
  const { status, body } = await client.health();
  assert.equal(status, 200);
  const health = body as Record<string, any>;
  assert.equal(health.ready, true);
  assert.ok(health.dustCoins >= 1, `DUST coins: ${health.dustCoins}`);
  startCoins = health.dustCoins;
  assert.ok(BigInt(health.dustBalance) > 0n);
  assert.equal(health.queueLength, 0);
  assert.equal(health.contract, R);
  assert.deepEqual(Object.keys(health.lostFees).sort(), ['byCause', 'count', 'dust']);
});

test('issue: issues the leaf for the id, a repeat does not issue another (already-issued), another plan is a conflict', async () => {
  const before = (await view()).bonos.firstFree();
  positions.set(toHex(leaf), before); // only the operator inserts on this devnet: the leaf goes to the first free position
  assert.equal(hasBonoLeaf((await registry.state(R)).data, leaf), false);

  const issued = await timed('issue (new id, plan free)', () => client.issue(id, 'free'));
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  const result = issued.body as { status: string; txHash: string };
  assert.equal(result.status, 'issued', JSON.stringify(result));
  assert.match(result.txHash, /^[0-9a-f]{64}$/);
  assert.equal((await view()).bonos.firstFree(), before + 1n, 'one more leaf');
  assert.equal(hasBonoLeaf((await registry.state(R)).data, leaf), true, 'and it is the one for the id');

  const again = await timed('issue (same id)', () => client.issue(id, 'free'));
  assert.deepEqual([again.status, again.body], [200, { status: 'already-issued' }]);
  assert.equal((await view()).bonos.firstFree(), before + 1n, 'no second leaf');

  const otherPlan = await timed('issue (same id, plan paid)', () => client.issue(id, 'paid'));
  assert.deepEqual([otherPlan.status, otherPlan.body], [409, { error: 'id-conflict' }]);
  assert.equal((await view()).bonos.firstFree(), before + 1n);
});

test('relay: a client call goes entirely into the guaranteed part, with a broken PROOF the node rejects it with no fee', async () => {
  // The relayer does not verify the proof locally; the node does, for free, as long as the call has no
  // fallible transcript. Another slot (j = 1) so the rejection is not caused by a used slot.
  const ps: PS = { bono, j: 1n, opSk: new Uint8Array(32) };
  const args = [rand(), rand()];
  const prepared = await registry.prepare(R, 'createAlias', ps, args);
  // Does another proof of the same call give different identifiers? If it gave the same ones, a client retry
  // would hit `duplicate` while the relayer holds the first (2 min after a rejection).
  const reproved = await registry.prepare(R, 'createAlias', ps, args);
  const sameCallIds = [prepared, reproved].map((p) => Transaction.deserialize('signature', 'proof', 'pre-binding', p.bytes).identifiers().map(String));
  assert.notDeepEqual(sameCallIds[0], sameCallIds[1], 'proving the same call again gives other identifiers (measured: yes)');
  const tx: any = Transaction.deserialize('signature', 'proof', 'pre-binding', prepared.bytes);
  const call: any = [...tx.intents.values()][0].actions[0];
  assert.equal(call.fallibleTranscript, undefined, 'no fallible transcript');
  assert.notEqual(call.guaranteedTranscript, undefined);
  assert.equal(checkRelayable(tx, R, Date.now()), null, 'the public relayer accepts it (real bytes, ttl included)');
  assert.equal(checkRelayable(tx, 'cd'.repeat(32), Date.now()), 'wrong-contract');
  const ttlAhead = intentTtlMs(tx)! - Date.now();
  timings.push(`${'client intent ttl'.padEnd(34)} now + ${(ttlAhead / 60_000).toFixed(1)} min`);
  // One byte flipped in the middle of the proof: still a well-formed transaction at the byte level.
  const proof = Buffer.from(call.proof.serialize());
  const probe = proof.subarray(Math.floor(proof.length / 2), Math.floor(proof.length / 2) + 32);
  const at = Buffer.from(prepared.bytes).indexOf(probe);
  assert.ok(at >= 0, 'the proof is inside the transaction bytes');
  const broken = Buffer.from(prepared.bytes);
  broken[at + 16] ^= 0x01;
  const brokenTx: any = Transaction.deserialize('signature', 'proof', 'pre-binding', broken); // does not throw
  // The relayer deduplicates by identifiers: there must be some, and another proof of the same intent must
  // give the same ones (otherwise flipping a proof byte would bypass deduplication).
  brokenIds = brokenTx.identifiers().map(String);
  assert.ok(brokenIds.length > 0, 'the client transaction has identifiers');
  assert.deepEqual(brokenIds, tx.identifiers().map(String), 'changing the proof does not change the identifiers');

  const before = (await client.health()).body as any;
  const relayed = await timed('relay (broken proof)', () => client.relay(broken.toString('hex')));
  assert.equal(relayed.status, 200, JSON.stringify(relayed.body));
  assert.equal((relayed.body as { status: string }).status, 'rejected', JSON.stringify(relayed.body));
  const health = (await client.health()).body as any;
  assert.equal(health.dustSpentLastHour.relay, before.dustSpentLastHour.relay, 'the rejection spends no DUST');
  assert.equal(health.lostFees.count, before.lostFees.count, 'nor is it a lost fee');
  assert.equal((await view()).slotNullifiers.member(slotNul(ctx, bono.s, Kind.alias, 1n, 0n)), false, 'nor does it spend the slot');
});

test('relay: pays for a createAlias the client proved with the issued bono, the address ends up in the registry', async () => {
  const ps: PS = { bono, j: 0n, opSk: new Uint8Array(32) }; // the client does not have the operator's key
  const t0 = performance.now();
  const prepared = await registry.prepare(R, 'createAlias', ps, [alias.encPk, alias.authPk]);
  timings.push(`${'cliente: probar createAlias'.padEnd(34)} ${`${prepared.bytes.length} B`.padEnd(65)} ${((performance.now() - t0) / 1000).toFixed(1).padStart(6)} s`);
  aliasTx = Buffer.from(prepared.bytes).toString('hex');
  const clientIds: string[] = Transaction.deserialize('signature', 'proof', 'pre-binding', prepared.bytes).identifiers().map(String);
  assert.equal(clientIds.some((id) => brokenIds.includes(id)), false, 'another call (another slot) has other identifiers');

  const spentBefore = BigInt(((await client.health()).body as any).dustSpentLastHour.relay);
  const relayed = await timed('relay (createAlias)', () => client.relay(aliasTx));
  assert.equal(relayed.status, 200, JSON.stringify(relayed.body));
  const result = relayed.body as { status: string; txHash: string };
  assert.equal(result.status, 'SucceedEntirely', JSON.stringify(result));
  assert.match(result.txHash, /^[0-9a-f]{64}$/);
  // Do the client's identifiers survive in the transaction the payer balanced and submitted? Deduplication
  // relies on it. Records what the indexer sees; if they do not, deduplication only covers client submissions.
  const indexedIds = await indexedIdentifiers(result.txHash);
  const kept = clientIds.filter((id) => indexedIds.includes(id)).length;
  timings.push(`${'client ids in the final tx'.padEnd(34)} ${kept}/${clientIds.length} (the final one has ${indexedIds.length})`);
  assert.equal(kept, clientIds.length, `client ${JSON.stringify(clientIds)} · final ${JSON.stringify(indexedIds)}`);

  const nul = slotNul(ctx, bono.s, Kind.alias, 0n, 0n);
  const v = await view();
  assert.equal(v.slotNullifiers.member(nul), true, 'the slot is spent');
  assert.equal(v.addresses.member(aliasAddrKey(alias.encPk, alias.authPk, nul)), true, 'and the address registered');
  // The payer answers once the tx is in a block and accounts it when final (in the background): wait for that.
  let health: any;
  for (let i = 0; i < 60; i++, await sleep(1000)) {
    health = (await client.health()).body;
    if (health.queueLength === 0 && BigInt(health.dustSpentLastHour.relay) > spentBefore) break;
  }
  const paid = BigInt(health.dustSpentLastHour.relay) - spentBefore;
  timings.push(`${'relay fee (DUST)'.padEnd(34)} ${(Number(paid) / 1e15).toFixed(4)}`);
  assert.ok(paid > 0n, 'what was paid counts toward the hourly cap');
  assert.equal(health.earlyAnswersWrong, 0, 'the early answer matched the final result');
});

test('relay: the same transaction again → the node rejects it before the block (no fee), with its code', async () => {
  const before = (await client.health()).body as any;
  const again = await timed('relay (same slot, rejected)', () => client.relay(aliasTx));
  assert.equal(again.status, 200, JSON.stringify(again.body));
  const result = again.body as { status: string; code: number | null };
  assert.equal(result.status, 'rejected', JSON.stringify(result));
  assert.equal(typeof result.code, 'number', `node code: ${result.code}`);
  const health = (await client.health()).body as any;
  assert.equal(health.dustSpentLastHour.relay, before.dustSpentLastHour.relay, 'a rejection spends nothing');
  assert.equal(health.lostFees.count, before.lostFees.count, 'nor is it a lost fee');
});

test('relay: bytes that are not a transaction → 422 invalid-tx, the payer stays ready', async () => {
  const bad = await timed('relay (garbage)', () => client.relay('00ff00ff'));
  assert.deepEqual([bad.status, bad.body], [422, { error: 'invalid-tx' }]);
  const truncated = await timed('relay (truncated transaction)', () => client.relay(aliasTx.slice(0, -20)));
  assert.deepEqual([truncated.status, truncated.body], [422, { error: 'invalid-tx' }]);
  assert.equal(((await client.health()).body as any).queueLength, 0, 'does not take up the queue');
  // `ready` requires a spendable DUST coin: after several transactions in a row they may all be waiting for
  // change. It stays alive and becomes ready again as soon as the change arrives.
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++, await sleep(1000)) ready = ((await client.health()).body as any).ready;
  assert.equal(ready, true, 'is ready again');
});

test('at the end, the payer sees all its DUST coins again (rejections do not leave them locked)', async () => {
  // Repeating a relay (same intent as an earlier submission) makes the node reject it, and the facade does not
  // release the reserved coins on its own (they would stay locked 3 h); sendPrepared releases them (dust.revertTransaction).
  const coins: number[] = [];
  for (let i = 0; i < 12; i++, await sleep(5000)) {
    coins.push(((await client.health()).body as any).dustCoins);
    if (coins.at(-1)! >= startCoins) break;
  }
  timings.push(`${'DUST coins (start → every 5 s)'.padEnd(34)} ${startCoins} → ${coins.join(' ')}`);
  assert.ok(coins.at(-1)! >= startCoins, `coins: ${startCoins} at start, ${coins.at(-1)} at the end`);
});

test('on stop (SIGTERM) it exits with 0 and removes the socket', async () => {
  assert.ok(payer);
  payer.kill('SIGTERM');
  const code = await Promise.race([exited!, sleep(30_000).then(() => 'timeout' as const)]);
  payer = undefined;
  assert.equal(code, 0);
  assert.equal(existsSync(socketPath), false);
});
