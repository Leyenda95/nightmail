// contract.findBonos and contract.proveCall on the local devnet, with the real sidecar as a process (JSON-RPC
// over stdio, as the core launches it) and real ZK proofs (npm run test:devnet -w apps/midnight-sidecar).
//
// The test plays the core (asks for hashes, finds its bono, asks for the proof) and the relayer: the
// transaction the sidecar returns, proven and unbalanced, is paid and sent by the operator wallet
// (`adoptTransaction(bytes, 'Unbound')` + DUST), and must end in `SucceedEntirely`.
//
// It needs the devnet running, the contracts compiled with keys and deployed
// (.data/operator/undeployed/contracts.json) and the operator wallet free: if another process (the payer)
// holds it, it waits and retries, never touching its lock. It uses the deployed registry: each run
// issues a new bono (random secret) and a mailbox with a new name.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../server/src/config.ts';
import { openChain, type ChainContract, type Outcome } from '../../server/src/chain/midnight.ts';
import { registryWitnesses } from '../../server/src/chain/registry.ts';
import { ensureSpendableDust, openOperatorWallet, type OperatorWallet } from '../../server/src/wallet/operatorWallet.ts';
import { WalletInUseError } from '../../server/src/wallet/storage.ts';
import { CALL_REJECTED, eventually, proveCall as proveCallOf, rpcError, seconds, Sidecar, STALE_STATE } from './sidecar-process.ts';

const rand = (n = 32) => randomBytes(n).toString('hex');
const NO_EXPIRY = 2 ** 32 - 1;
const timings: string[] = [];

// --- The operator wallet: issues the bono and plays the relayer -------------------------------------

/** Opens the operator wallet; if another process holds it, waits (up to 20 min) without touching its lock. */
async function openWalletWhenFree(config: ReturnType<typeof loadConfig>): Promise<OperatorWallet> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await openOperatorWallet(config);
    } catch (e) {
      if (!(e instanceof WalletInUseError) || attempt >= 120) throw e;
      if (attempt % 6 === 0) console.log(`operator wallet is in use (${(e as Error).message}): waiting…`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

let sidecar: Sidecar;
let wallet: OperatorWallet;
let registry: ChainContract;
let R: string; // address of the registry deployed on the devnet
let opSk: Uint8Array;
let Plan: any;

function record(label: string, o: Outcome): Outcome {
  timings.push(`${label.padEnd(34)} ${o.status.padEnd(16)} prueba ${seconds(o.proveMs)}  bloque ${seconds(o.blockMs)}  ${String(o.bytes).padStart(6)} B`);
  return o;
}

/** Operator call (issueBono, advanceRound) with its own proof. */
async function operator(circuit: string, args: unknown[]): Promise<void> {
  const blank = { bono: { s: randomBytes(32), k: 0n, plan: Plan.free, validUntil: BigInt(NO_EXPIRY) }, j: 0n, opSk };
  const o = record(`operador: ${circuit}`, await registry.call(R, circuit, blank, args));
  assert.ok(o.ok, `${circuit}: ${o.status} ${o.error ?? ''}`);
}

/** What the relayer does with the client's transaction: pay only DUST, sign, send and wait for the block. */
async function relay(label: string, tx: string, proveMs: number): Promise<Outcome> {
  return record(label, await registry.send({ bytes: new Uint8Array(Buffer.from(tx, 'hex')), proveMs, kinds: ['dust'] }));
}

const hashes = async (ops: object[]): Promise<string[]> => (await sidecar.call('contract.hashes', { contractAddress: R, ops })).results;

/** proveCall over stdio against the deployed registry; if it fails retryably, asks for another (noted). */
const proveCall = (call: object) => proveCallOf(sidecar, { contractAddress: R, ...call },
  (ms, code) => timings.push(`${`proveCall: error ${code}`.padEnd(34)} asking for another (${seconds(ms)})`));

// This run's bono: its secret does not leave this process except towards the sidecar.
const s = rand();
const witnesses = (j: number) => ({ s, k: 0, plan: 'free', validUntil: NO_EXPIRY, j });
let leaf: string;

before(async () => {
  const config = loadConfig('undeployed');
  R = JSON.parse(readFileSync(path.join(config.dataDir, 'contracts.json'), 'utf8')).registry.address;
  opSk = new Uint8Array(Buffer.from(readFileSync(path.join(config.dataDir, 'operator-sk'), 'utf8').trim(), 'hex'));
  const started = await Sidecar.start();
  sidecar = started.sidecar;
  assert.ok(started.methods.includes('contract.proveCall') && started.methods.includes('contract.findBonos'));
  wallet = await openWalletWhenFree(config);
  await ensureSpendableDust(wallet);
  registry = await (await openChain(config, wallet)).contract('registry', registryWitnesses());
  ({ Plan } = registry.module);
});

after(async () => {
  console.log(`\nTimings on the devnet (sidecar over stdio, local proof server):\n${timings.join('\n')}`);
  if (wallet) await wallet.close();
  if (sidecar) assert.equal(await sidecar.close(), 0, 'the sidecar exits cleanly when its input is closed');
});

test('findBonos: the leaf of a freshly issued bono shows up in the index with its position', async () => {
  const [id] = await hashes([{ op: 'idK', s, k: 0 }]);
  [leaf] = await hashes([{ op: 'leaf', id, plan: 'free', validUntil: NO_EXPIRY }]);
  const find = () => sidecar.call('contract.findBonos', { contractAddress: R, leaves: [leaf, rand()] });
  const beforeIssue = await find();
  assert.deepEqual(beforeIssue.positions, [null, null], 'not there before issuing it');

  await operator('issueBono', [Buffer.from(id, 'hex'), Plan.free]);
  const t0 = performance.now();
  const found = await eventually('the bono leaf', find, (r) => r.positions[0] !== null);
  timings.push(`${'findBonos (until the leaf shows up)'.padEnd(34)} position ${found.positions[0]} of ${found.leafCount}  ${seconds(performance.now() - t0)}`);
  // Other processes may be issuing on the devnet at the same time: the position is at least the first free one from before.
  assert.ok(found.positions[0] >= beforeIssue.leafCount && found.positions[0] < found.leafCount, JSON.stringify(found));
  assert.equal(found.positions[1], null, 'an arbitrary leaf is not there');
  assert.ok(found.blockHeight > beforeIssue.blockHeight);

  // minLeafCount: with the leaves already seen it answers; with one more, the state is "behind".
  assert.equal((await sidecar.call('contract.findBonos', { contractAddress: R, leaves: [leaf], minLeafCount: found.leafCount })).positions[0], found.positions[0]);
  const behind = await rpcError(sidecar.call('contract.findBonos', { contractAddress: R, leaves: [leaf], minLeafCount: found.leafCount + 1 }));
  assert.equal(behind.code, STALE_STATE);
  assert.deepEqual([(behind.data as any).reason, (behind.data as any).leafCount], ['behind', found.leafCount]);
});

test('proveCall of createAlias: the unbalanced transaction, paid by the operator, ends SucceedEntirely', async () => {
  const keys = { encPk: rand(), authPk: rand() };
  const proved = await proveCall({ circuit: 'createAlias', args: keys, witnesses: witnesses(0) });
  assert.deepEqual(proved.stages, ['reading-state', 'building', 'proving']);
  assert.ok(!proved.tx.includes(s), 'the bono secret is not in the transaction');
  const sent = await relay('createAlias (proveCall + relay)', proved.tx, proved.proveMs);
  assert.equal(sent.status, 'SucceedEntirely', sent.error);

  const [nul] = await hashes([{ op: 'slotNul', s, kind: 'alias', j: 0, gen: 0 }]);
  const [addrKey] = await hashes([{ op: 'aliasAddrKey', ...keys, slotNul: nul }]);
  const ledger = await registry.ledgerState(R);
  const record = ledger.addresses.lookup(Buffer.from(addrKey, 'hex'));
  assert.deepEqual([Buffer.from(record.encPk).toString('hex'), Buffer.from(record.authPk).toString('hex')], [keys.encPk, keys.authPk]);
  assert.equal(ledger.slotNullifiers.member(Buffer.from(nul, 'hex')), true);

  // With the slot already spent on chain, another proof for it is rejected locally (nothing is proven).
  const again = await eventually('the spent slot',
    () => rpcError(sidecar.call('contract.proveCall', { contractAddress: R, circuit: 'createAlias', args: keys, witnesses: witnesses(0) })),
    (e) => e.code === CALL_REJECTED);
  assert.deepEqual(again, { code: CALL_REJECTED, message: 'Call rejected', data: { reason: 'slot-already-used' } });
});

test('proveCall is cancelled with $/cancel while proving', async () => {
  const { id, result } = sidecar.request('contract.proveCall',
    { contractAddress: R, circuit: 'createAlias', args: { encPk: rand(), authPk: rand() }, witnesses: witnesses(1) });
  sidecar.onNotification = (n) => {
    if (n.params.requestId === id && n.params.stage === 'proving') sidecar.cancel(id);
  };
  const t0 = performance.now();
  assert.deepEqual(await rpcError(result), { code: -32004, message: 'Cancelled' });
  sidecar.onNotification = () => {};
  timings.push(`${'proveCall cancelada'.padEnd(34)} respuesta en ${seconds(performance.now() - t0)}`);
  // The sidecar keeps serving after cancelling.
  assert.equal((await sidecar.call('ping', null)).pong, true);
});

test('two-step mailbox with proveCall: reserveMailbox, two rounds and revealMailbox', async () => {
  const name = `p2.${Date.now().toString(36)}`;
  const m = { encPk: rand(), authPk: rand(), salt: rand(), nameCipher: rand(104) };
  const [nul, addrKey] = await hashes([{ op: 'slotNul', s, kind: 'mailbox', j: 0, gen: 0 }, { op: 'addrKey', name }]);
  const [commit] = await hashes([{ op: 'commit', addrKey, encPk: m.encPk, authPk: m.authPk, salt: m.salt, slotNul: nul }]);
  const round = BigInt((await sidecar.call('contract.snapshot', { contractAddress: R, limit: 1 })).round);

  const reserve = await proveCall({ circuit: 'reserveMailbox', args: { commit, round: (round + 1n).toString() }, witnesses: witnesses(0) });
  assert.equal((await relay('reserveMailbox (proveCall + relay)', reserve.tx, reserve.proveMs)).status, 'SucceedEntirely');

  const reveal = { circuit: 'revealMailbox', args: { name, encPk: m.encPk, authPk: m.authPk, salt: m.salt, slotNul: nul, nameCipher: m.nameCipher } };
  // Once the indexer sees the reservation: revealing in its own round (or the proposal's) is too early.
  // (Another process may be advancing rounds on the devnet: only checked if the round has not passed yet.)
  const reserved = await eventually('the reservation', () => sidecar.call('contract.snapshot', { contractAddress: R }),
    (snap) => snap.pendingNames.some((p: { slotNul: string }) => p.slotNul === nul));
  if (BigInt(reserved.round) <= round + 1n) {
    const early = await rpcError(sidecar.call('contract.proveCall', { contractAddress: R, ...reveal }));
    assert.deepEqual(early, { code: CALL_REJECTED, message: 'Call rejected', data: { reason: 'too-early' } });
  }

  for (let i = 0; i < 2; i++) await operator('advanceRound', []);
  await eventually('the two rounds', () => sidecar.call('contract.snapshot', { contractAddress: R, limit: 1 }), (snap) => BigInt(snap.round) > round + 1n);
  const revealed = await proveCall(reveal);
  assert.equal((await relay('revealMailbox (proveCall + relay)', revealed.tx, revealed.proveMs)).status, 'SucceedEntirely');

  const ledger = await registry.ledgerState(R);
  const record = ledger.addresses.lookup(Buffer.from(addrKey, 'hex'));
  assert.equal(Buffer.from(record.slotNul).toString('hex'), nul);
  assert.equal(ledger.pendingNames.member(Buffer.from(nul, 'hex')), false, 'the reservation is deleted on reveal');
});
