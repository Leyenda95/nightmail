// contract.proveCall with a fake chain behind net.ts: the indexer serves the state of a simulator contract
// and the proof server replies with recorded proofs (see helpers.ts). What is checked is the resulting
// transaction: its public transcript is applied to the state and the effect is inspected. Proof validity
// for the node is covered by the devnet test (test-devnet/prove.devnet.ts).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ContractState, CostModel, QueryContext } from '@midnight-ntwrk/compact-runtime';
import { Transaction } from '@midnightntwrk/ledger-v9';
import { aliasAddrKey, decodeState, Kind, ledger, Plan } from '@nightmail/midnight';
import { createHandlers } from '../src/handlers.ts';
import { setFetchForTests } from '../src/net.ts';
import { AppError, codes } from '../src/codes.ts';
import {
  CALL_TTL_MS, callTtl, MAX_CLOCK_BEHIND_MS, MAX_STATE_AGE_MS, proveHandlers, rejectionOf, TTL_QUANTUM_MS,
} from '../src/prove.ts';
import { MAX_PROVER_RESPONSE_BYTES } from '../src/prover.ts';
import { staleState } from '../src/contract.ts';
import { TTL_MAX_AHEAD_MS, TTL_MIN_AHEAD_MS } from '../../server/src/relayer/validate.ts';
import { contractStateOf, deploy, hex } from '../../../packages/midnight/test/helpers.ts';
import {
  appError, ctx, deployedState, failure, fakeChain, type FakeChain, INDEXER, json, type Notification, PROOF_SERVER, type Provable,
  ready, replayProver,
} from './helpers.ts';

afterEach(() => setFetchForTests((...args) => fetch(...args)));

type Sim = any;
type Bono = { s: Uint8Array; k: bigint; plan: Plan; validUntil: bigint };

const witnessesOf = (b: Bono, j: number) =>
  ({ s: hex(b.s), k: Number(b.k), plan: b.plan === Plan.paid ? 'paid' : 'free', validUntil: Number(b.validUntil), j });
const aliasCall = (c: Sim, b: Bono, j: number, keys = { encPk: 'e1'.repeat(32), authPk: 'a7'.repeat(32) }) =>
  ({ contractAddress: c.address, circuit: 'createAlias', args: keys, witnesses: witnessesOf(b, j) });
/** The local clock in Unix seconds. */
const nowSec = () => BigInt(Math.floor(Date.now() / 1000));
const registerCall = (c: Sim, m: any, name: string) => ({
  contractAddress: c.address, circuit: 'registerMailbox',
  args: { name, encPk: hex(m.encPk), authPk: hex(m.authPk), nameCipher: hex(m.nameCipher) },
  witnesses: witnessesOf(m.bono, Number(m.j)),
});

/** The simulator contract's state as the indexer would serve it. */
const stateOf = async (c: Sim) => deployedState(contractStateOf(c));

/** Serves that state with a proof server that replies with what was recorded for the circuit, and calls proveCall. */
async function prove(c: Sim, call: { circuit: string } & Record<string, unknown>, chain: Partial<FakeChain> = {}, sent: Notification[] = [], signal?: AbortSignal) {
  const state = chain.state === undefined ? await stateOf(c) : chain.state;
  const requests = fakeChain({ prover: replayProver(call.circuit as Provable), ...chain, state });
  const result = (await ready())['contract.proveCall'](call, ctx(signal, sent)) as Promise<{ tx: string; blockHeight: number }>;
  return { state, requests, result };
}

/**
 * The transaction's only call and the ledger resulting from applying its transcript to the state, at the current
 * block time.
 */
function applied(c: Sim, stateHex: string, txHex: string) {
  const tx: any = Transaction.deserialize('signature', 'proof', 'pre-binding', Buffer.from(txHex, 'hex'));
  assert.deepEqual([tx.guaranteedOffer, tx.fallibleOffer], [undefined, undefined], 'no Zswap offers: nothing from any wallet');
  const intents: any[] = [...tx.intents.values()];
  assert.equal(intents.length, 1, 'un solo intent');
  assert.equal(intents[0].actions.length, 1, 'a single call');
  assert.equal(intents[0].dustActions, undefined, 'no DUST: the relayer adds it');
  const call = intents[0].actions[0];
  assert.equal(call.fallibleTranscript, undefined, 'all effects go in the guaranteed part');
  // Applied now, as the node would.
  const q = new QueryContext(decodeState(stateHex).data, c.address);
  q.block = { ...q.block, secondsSinceEpoch: nowSec() };
  const context = q.runTranscript(call.guaranteedTranscript, CostModel.initialCostModel());
  return { intent: intents[0], call, after: ledger(context.state) };
}

const proverRequests = <T extends { url: string }>(requests: T[]) => requests.filter((r) => r.url.startsWith(PROOF_SERVER));

// --- The resulting transaction ----------------------------------------------------------------------

test('createAlias: the proved transaction spends the bono slot and registers the alias with its keys', async () => {
  const c = await deploy();
  await c.issue(Plan.paid);
  const bono: Bono = await c.issue(Plan.free);
  await c.issue(Plan.free);
  const sent: Notification[] = [];
  const { state, requests, result } = await prove(c, aliasCall(c, bono, 1), { tip: 4321 }, sent);
  const { tx, blockHeight } = await result;
  assert.equal(blockHeight, 4321);
  assert.match(tx, /^(?:[0-9a-f]{2})+$/);

  const { call, after } = applied(c, state!, tx);
  assert.deepEqual([call.address, call.entryPoint], [c.address, 'createAlias']);
  const nul = c.slotNul(bono, Kind.alias, 1n);
  assert.equal(after.slotNullifiers.member(nul), true, 'spends the (alias, 1) slot of the bono');
  const record = after.addresses.lookup(aliasAddrKey(new Uint8Array(32).fill(0xe1), new Uint8Array(32).fill(0xa7), nul));
  assert.deepEqual([hex(record.encPk), hex(record.authPk), record.kind, hex(record.slotNul)], ['e1'.repeat(32), 'a7'.repeat(32), Kind.alias, hex(nul)]);
  assert.equal(after.addresses.size(), 1n);

  // Network: the indexer (height and state pinned to it) and the local proof server, which cannot redirect.
  assert.deepEqual(requests.map((r) => r.url), [INDEXER, INDEXER, `${PROOF_SERVER}/check`, `${PROOF_SERVER}/prove`]);
  for (const r of proverRequests(requests)) {
    assert.deepEqual([r.init.method, r.init.redirect], ['POST', 'error'], r.url);
    assert.ok(r.init.signal instanceof AbortSignal, 'cancelable');
  }
  // The bono secret only travels to the local proof server: neither to the indexer nor in the transaction.
  assert.ok(requests.slice(0, 2).every((r) => !String(r.init.body).includes(hex(bono.s))));
  assert.ok(!tx.includes(hex(bono.s)));
  assert.deepEqual(sent, ['reading-state', 'building', 'proving'].map((stage) => ({ method: 'progress', params: { requestId: 7, stage, percent: null } })));
});

test('the path is computed against the root of the state read: the transaction publishes it and the contract knows it', async () => {
  const c = await deploy();
  const bono: Bono = await c.issue(Plan.free);
  const first = await prove(c, aliasCall(c, bono, 0));
  const rootOf = (tx: string, state: string) => JSON.stringify(applied(c, state, tx).call.guaranteedTranscript.program, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  const before = rootOf((await first.result).tx, first.state!);
  await c.issue(Plan.paid); // another leaf: the root changes, and so does the path of the same leaf
  const second = await prove(c, aliasCall(c, bono, 0));
  const after = rootOf((await second.result).tx, second.state!);
  assert.notEqual(before, after, 'each proof uses the current root, not a stored one');
  const again = await prove(c, aliasCall(c, bono, 0), { state: second.state });
  assert.equal(rootOf((await again.result).tx, second.state!), after, 'with the same state, the same transcript');
});

test('the TTL is the time of the block read + 30 min, rounded down to 10 min: neither the local clock nor the exact block', async (t) => {
  const c = await deploy();
  const bono: Bono = await c.issue(Plan.free);
  const slot = Math.ceil(Date.now() / TTL_QUANTUM_MS) * TTL_QUANTUM_MS + CALL_TTL_MS;
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  // Different blocks within the same 10-min slot give exactly the same ttl, with the local clock
  // anywhere in the freshness window (midnight-js adds Date.now() to the ttl: it is overwritten here).
  for (const [blockAt, localClock, expected] of [
    [slot - CALL_TTL_MS, 0, slot], // the exact edge of the slot
    [slot - CALL_TTL_MS + 1, 90_000, slot],
    [slot - CALL_TTL_MS + TTL_QUANTUM_MS - 1, -30_000, slot],
    [slot - CALL_TTL_MS - 1, 5_000, slot - TTL_QUANTUM_MS],
  ]) {
    t.mock.timers.setTime(blockAt + localClock);
    const { state, result } = await prove(c, aliasCall(c, bono, 0), { timestamp: blockAt });
    const ttl: Date = applied(c, state!, (await result).tx).intent.ttl;
    assert.equal(ttl.getTime(), expected, `block ${blockAt - slot} ms into the slot, local clock ${localClock}`);
  }
  assert.equal(callTtl(slot - CALL_TTL_MS + 30_000).getTime(), slot);
  assert.deepEqual([CALL_TTL_MS, TTL_QUANTUM_MS], [30 * 60_000, 10 * 60_000]);
});

test('the TTL always fits what the relayer accepts, with any state that passes the freshness check', () => {
  const slot = Date.UTC(2026, 10, 19, 8, 0, 0); // a slot boundary
  // Worst case from below: state at the age limit, read just before a slot boundary.
  for (const intoSlot of [0, 1, TTL_QUANTUM_MS / 2, TTL_QUANTUM_MS - 1]) {
    const now = slot + intoSlot;
    for (let age = -MAX_CLOCK_BEHIND_MS; age <= MAX_STATE_AGE_MS; age += 1_000) {
      const ahead = callTtl(now - age).getTime() - now;
      assert.ok(ahead >= TTL_MIN_AHEAD_MS && ahead <= TTL_MAX_AHEAD_MS, `ttl ${ahead} ms ahead (now +${intoSlot} ms into the slot, block ${age} ms old)`);
    }
  }
});

test('registerMailbox: spends the mailbox slot and registers the mailbox with the normalized name in one step', async () => {
  const c = await deploy();
  const bono: Bono = await c.issue(Plan.paid);
  const m = c.mailbox('juan.perez', bono, 3n);
  const { state, requests, result } = await prove(c, registerCall(c, m, 'Juan.Perez'));
  const tx = (await result).tx;
  const { call, after } = applied(c, state!, tx);
  assert.equal(call.entryPoint, 'registerMailbox');
  assert.equal(after.slotNullifiers.member(m.slotNul), true, 'spends the (mailbox, 3) slot of the bono');
  const record = after.addresses.lookup(m.addrKey);
  assert.deepEqual([hex(record.encPk), hex(record.authPk), record.kind, hex(record.nameCipher), hex(record.slotNul)],
    [hex(m.encPk), hex(m.authPk), Kind.mailbox, hex(m.nameCipher), hex(m.slotNul)]);
  assert.equal(after.addresses.size(), 1n);
  assert.ok(!tx.includes(hex(bono.s)) && !tx.includes(Buffer.from('juan.perez').toString('hex')), 'neither the bono secret nor the plain name');
  assert.equal(proverRequests(requests).length, 2);
});

test('the result has the shape of the RPC vector shared with Rust, and its example calls are accepted', async () => {
  const v = json('rpc/contract-prove-call.json');
  const c = await deploy();
  const bono: Bono = await c.issue(Plan.free);
  const result = await (await prove(c, aliasCall(c, bono, 0))).result;
  assert.deepEqual(Object.keys(result).sort(), Object.keys(v.result).sort());
  assert.deepEqual([typeof result.tx, typeof result.blockHeight], [typeof v.result.tx, typeof v.result.blockHeight]);
  // The vector's calls are well formed: they get as far as reading the chain (where there is no such contract).
  fakeChain({ state: null });
  const h = await ready();
  for (const call of v.calls) {
    assert.equal((await appError(h['contract.proveCall'](call, ctx()))).code, codes.CONTRACT_NOT_FOUND, call.circuit);
  }
});

// --- The circuit fails locally ----------------------------------------------------------------------

/** proveCall must reject the call with that reason, without reaching the proof server. */
async function rejected(c: Sim, call: { circuit: string }, reason: string) {
  const { requests, result } = await prove(c, call);
  assert.deepEqual(await appError(result), { code: codes.CALL_REJECTED, message: 'Call rejected', data: { reason } });
  assert.equal(proverRequests(requests).length, 0, 'nothing is proved');
}

test('membership proof that fails locally: CALL_REJECTED with the reason', async () => {
  const c = await deploy();
  const free: Bono = await c.issue(Plan.free);
  const paid: Bono = await c.issue(Plan.paid);
  await c.alias(free, 0n);
  const stranger: Bono = { ...free, s: new Uint8Array(32).fill(9) };
  await rejected(c, aliasCall(c, stranger, 0), 'not-a-bono');
  await rejected(c, aliasCall(c, { ...free, plan: Plan.paid }, 5), 'not-a-bono'); // the plan is part of the leaf: it cannot be faked
  await rejected(c, aliasCall(c, free, 2), 'no-slots-left'); // free: 2 aliases
  await rejected(c, aliasCall(c, paid, 20), 'no-slots-left'); // paid: 20 aliases
  await rejected(c, aliasCall(c, free, 0), 'slot-already-used');
  await (await prove(c, aliasCall(c, paid, 19))).result; // the last slot of the paid plan is fine
});

/** Runs the function recording the 32-byte Uint8Arrays that get filled with a single argument (what wipe does). */
async function filled(run: () => Promise<unknown>): Promise<Uint8Array[]> {
  const original = Uint8Array.prototype.fill;
  const seen: Uint8Array[] = [];
  Uint8Array.prototype.fill = function (this: Uint8Array, ...args: [number]) {
    if (args.length === 1 && this.constructor === Uint8Array && this.length === 32) seen.push(this);
    return original.apply(this, args);
  } as typeof original;
  try {
    await run();
  } finally {
    Uint8Array.prototype.fill = original;
  }
  return seen;
}

test('when the call ends, the bytes of the arguments and of the bono secret are zeroed (success and failure)', async () => {
  const c = await deploy();
  const free: Bono = await c.issue(Plan.free);
  const ok = await filled(async () => (await prove(c, aliasCall(c, free, 0))).result);
  assert.equal(ok.length, 3, 'encPk, authPk and the bono secret');
  assert.ok(ok.every((bytes) => bytes.every((b) => b === 0)), 'all zeroed, not merely changed');
  const stranger: Bono = { ...free, s: new Uint8Array(32).fill(9) };
  const failed = await filled(async () => rejected(c, aliasCall(c, stranger, 0), 'not-a-bono'));
  assert.equal(failed.length, 3);
  assert.ok(failed.every((bytes) => bytes.every((b) => b === 0)), 'also if the call is rejected');
});

test('params that fail halfway: what was already decoded (the bono secret included) is also zeroed', async () => {
  const c = await deploy();
  const free: Bono = await c.issue(Plan.free);
  fakeChain({ state: await stateOf(c) });
  const h = await ready();
  const call = aliasCall(c, free, 0);
  // createAlias decodes encPk, authPk and s before reaching the invalid k.
  const seen = await filled(async () => appError(h['contract.proveCall']({ ...call, witnesses: { ...call.witnesses, k: -1 } }, ctx())));
  assert.equal(seen.length, 3, 'encPk, authPk and the bono secret');
  assert.ok(seen.every((bytes) => bytes.every((b) => b === 0)));
});

test('what is sent to the proof server (with the witnesses) is zeroed at the end', async () => {
  const c = await deploy();
  const bono: Bono = await c.issue(Plan.free);
  const bodies: Uint8Array[] = [];
  const prover: FakeChain['prover'] = (path, init) => {
    bodies.push(init.body as Uint8Array);
    return replayProver('createAlias')(path, init);
  };
  // The preimage of /check and /prove too (it does not reach the proof server as is: seen through `fill`).
  const original = Uint8Array.prototype.fill;
  const wiped: Uint8Array[] = [];
  Uint8Array.prototype.fill = function (this: Uint8Array, ...args: [number]) {
    if (this.length > 512) wiped.push(this); // preimages (~870 B) and payloads; not the 64 B hash fills
    return original.apply(this, args);
  } as typeof original;
  try {
    await (await prove(c, aliasCall(c, bono, 0), { prover })).result;
  } finally {
    Uint8Array.prototype.fill = original;
  }
  assert.equal(bodies.length, 2, '/check y /prove');
  assert.ok(bodies.every((body) => body.length > 0 && body.every((b) => b === 0)), 'the sent bodies, zeroed');
  const preimages = wiped.filter((w) => !bodies.includes(w));
  assert.equal(preimages.length, 2, 'the preimage of /check and that of /prove');
  assert.ok(preimages.every((p) => p.every((b) => b === 0)), 'the preimages, zeroed');
});

test('a proof server response larger than MAX_PROVER_RESPONSE_BYTES is not read in full: internal error', async () => {
  const c = await deploy();
  const bono: Bono = await c.issue(Plan.free);
  let pulled = 0;
  const huge = () => new Response(new ReadableStream({
    pull(controller) {
      pulled += 65_536;
      controller.enqueue(new Uint8Array(65_536));
    },
  }));
  for (const prover of [huge, () => new Response(new Uint8Array(MAX_PROVER_RESPONSE_BYTES + 1))]) {
    const err = await failure((await prove(c, aliasCall(c, bono, 0), { prover })).result);
    assert.ok(err instanceof Error && !(err instanceof AppError) && /too large/.test(err.message), String(err));
  }
  assert.ok(pulled <= MAX_PROVER_RESPONSE_BYTES + 2 * 65_536, `stopped reading (${pulled} bytes)`);
});

test('the error matches the RPC vector shared with Rust, and each contract assert its reason', async () => {
  const v = json('rpc/call-rejected.json');
  const c = await deploy();
  const { result } = await prove(c, aliasCall(c, await c.issue(Plan.free), 2));
  assert.deepEqual(await appError(result), v.error);
  for (const [message, reason] of Object.entries(v.asserts)) {
    assert.deepEqual(rejectionOf(new Error(`failed assert: ${message}`))?.data, { reason }, message);
  }
  assert.deepEqual(new Set([...Object.values(v.asserts), 'other']), new Set(v.reasons));
  assert.deepEqual(rejectionOf(new Error('failed assert: Path is for another bono'))?.data, { reason: 'other' }, 'an assert without its own reason');
  const reserved = rejectionOf(new Error('failed assert: Name reserved'));
  assert.deepEqual([reserved?.code, reserved?.message, reserved?.data], [codes.NAME_REJECTED, 'Name rejected', { reason: 'reserved' }],
    'an on-chain reserved name is NAME_REJECTED reserved, like the app list');
  for (const other of [new Error('index out of bounds'), new Error('assert'), 'failed assert: No slots left', null, undefined]) {
    assert.equal(rejectionOf(other), undefined, 'whatever is not a contract assert is an internal error');
  }
});

test('registerMailbox with a name already registered: address-taken, and the slot stays unspent', async () => {
  const c = await deploy();
  const bono: Bono = await c.issue(Plan.paid);
  await c.register(c.mailbox('ana', bono, 0n));
  const second = c.mailbox('ana', bono, 1n);
  await rejected(c, registerCall(c, second, 'Ana'), 'address-taken');
  assert.equal(c.view().slotNullifiers.member(second.slotNul), false);
  // The same slot registers another name.
  await (await prove(c, registerCall(c, c.mailbox('ana.b', bono, 1n), 'ana.b'))).result;
});

// --- The chain --------------------------------------------------------------------------------------

const stale = (reason: string, ageMs: number, leafCount?: number) =>
  ({ code: codes.STALE_STATE, message: 'Stale chain state', data: leafCount === undefined ? { reason, ageMs } : { reason, ageMs, leafCount } });

test('STALE_STATE matches the RPC vector shared with Rust (old and behind with their leaves)', () => {
  const v = json('rpc/stale-state.json');
  const old = staleState('old', 125_000);
  assert.deepEqual({ code: old.code, message: old.message, data: old.data }, v.error);
  assert.deepEqual(staleState('behind', 4000, 41).data, v.behind);
  assert.deepEqual(v.reasons, ['old', 'future', 'behind']);
});

test('a state that is too old cannot be used to prove: STALE_STATE old with its age, without touching the proof server', async () => {
  const c = await deploy();
  const bono: Bono = await c.issue(Plan.free);
  const old = await prove(c, aliasCall(c, bono, 0), { timestamp: Date.now() - MAX_STATE_AGE_MS - 5000 });
  const err = await appError(old.result);
  assert.deepEqual([err.code, (err.data as { reason: string }).reason], [codes.STALE_STATE, 'old']);
  assert.ok((err.data as { ageMs: number }).ageMs >= MAX_STATE_AGE_MS + 5000);
  assert.equal(proverRequests(old.requests).length, 0);
  await (await prove(c, aliasCall(c, bono, 0), { timestamp: Date.now() - MAX_STATE_AGE_MS + 30_000 })).result;
  assert.deepEqual([MAX_STATE_AGE_MS, MAX_CLOCK_BEHIND_MS], [120_000, 60_000]);
});

test('the freshness limits are exact: up to MAX_STATE_AGE_MS old and MAX_CLOCK_BEHIND_MS ahead', async (t) => {
  const c = await deploy();
  const bono: Bono = await c.issue(Plan.free);
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  for (const timestamp of [now - MAX_STATE_AGE_MS, now + MAX_CLOCK_BEHIND_MS]) {
    assert.equal(typeof (await (await prove(c, aliasCall(c, bono, 0), { timestamp })).result).tx, 'string');
  }
  const over = await prove(c, aliasCall(c, bono, 0), { timestamp: now - MAX_STATE_AGE_MS - 1 });
  assert.deepEqual(await appError(over.result), stale('old', MAX_STATE_AGE_MS + 1));
  // A block "from the future": the machine clock is behind (or the indexer lies). No proving.
  const ahead = await prove(c, aliasCall(c, bono, 0), { timestamp: now + MAX_CLOCK_BEHIND_MS + 1 });
  assert.deepEqual(await appError(ahead.result), stale('future', -MAX_CLOCK_BEHIND_MS - 1));
  assert.equal(proverRequests(ahead.requests).length, 0);
});

test('minLeafCount: if the tree has fewer leaves than already seen, STALE_STATE behind without proving anything', async (t) => {
  const c = await deploy();
  const bono: Bono = await c.issue(Plan.free);
  await c.issue(Plan.paid); // two leaves
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  const behind = await prove(c, { ...aliasCall(c, bono, 0), minLeafCount: 3 }, { timestamp: now - 1000 });
  assert.deepEqual(await appError(behind.result), stale('behind', 1000, 2));
  assert.equal(proverRequests(behind.requests).length, 0);
  for (const minLeafCount of [2, 0]) await (await prove(c, { ...aliasCall(c, bono, 0), minLeafCount })).result;
  for (const bad of [-1, 1.5, '2', null, 2 ** 32]) {
    const { result } = await prove(c, { ...aliasCall(c, bono, 0), minLeafCount: bad });
    assert.equal((await appError(result)).code, codes.INVALID_PARAMS, String(bad));
  }
});

test('the on-chain circuit verifier key is not the app one (or is missing): CONTRACT_MISMATCH, without proving anything', async () => {
  const c = await deploy();
  const bono: Bono = await c.issue(Plan.free);
  const state = contractStateOf(c);
  deployedState(state); // the real keys of every circuit
  // Another valid key (that of another circuit): as if the operator had changed createAlias.
  state.setOperation('createAlias', state.operation('registerMailbox')!);
  const changed = hex(state.serialize());
  const { requests, result } = await prove(c, aliasCall(c, bono, 0), { state: changed });
  assert.deepEqual(await appError(result), { code: codes.CONTRACT_MISMATCH, message: 'Contract version mismatch' });
  assert.equal(proverRequests(requests).length, 0);
  // With a lagging state its verifier key says nothing: behind first (retryable), not the mismatch.
  const late = await prove(c, { ...aliasCall(c, bono, 0), minLeafCount: 99 }, { state: changed });
  assert.equal((await appError(late.result)).code, codes.STALE_STATE);
  // A contract without that circuit is no good either.
  const bare = await prove(c, aliasCall(c, bono, 0), { state: hex(contractStateOf(c).serialize()) });
  assert.deepEqual(await appError(bare.result), { code: codes.CONTRACT_MISMATCH, message: 'Contract version mismatch' });
  // The other circuits still pass: the check is per circuit.
  const m = c.mailbox('ana', bono, 0n);
  await (await prove(c, registerCall(c, m, 'ana'), { state: changed })).result;
});

test('no contract at that address, or another contract: CONTRACT_NOT_FOUND', async () => {
  const c = await deploy();
  const bono: Bono = await c.issue(Plan.free);
  for (const state of [null, hex(new ContractState().serialize())]) {
    const { result } = await prove(c, aliasCall(c, bono, 0), { state });
    assert.deepEqual(await appError(result), { code: codes.CONTRACT_NOT_FOUND, message: 'Contract not found' });
  }
});

test('indexer down: UPSTREAM_UNAVAILABLE', async () => {
  const c = await deploy();
  setFetchForTests(async () => new Response('boom', { status: 503 }));
  assert.deepEqual(await appError((await ready())['contract.proveCall'](aliasCall(c, await c.issue(Plan.free), 0), ctx())),
    { code: codes.UPSTREAM_UNAVAILABLE, message: 'Indexer unavailable' });
});

// --- The proof server -------------------------------------------------------------------------------

test('proof server down (network, 429, 5xx): PROVER_UNAVAILABLE', async () => {
  const c = await deploy();
  const bono: Bono = await c.issue(Plan.free);
  const down: FakeChain['prover'][] = [
    undefined, // no connection
    () => new Response('busy', { status: 503 }),
    () => new Response('boom', { status: 500 }),
    () => new Response('slow down', { status: 429 }),
    (path, init) => (path === '/check' ? replayProver('createAlias')(path, init) : new Response('busy', { status: 502 })),
  ];
  for (const prover of down) {
    const { result } = await prove(c, aliasCall(c, bono, 0), { prover });
    assert.deepEqual(await appError(result), { code: codes.PROVER_UNAVAILABLE, message: 'Proof server unavailable' });
  }
});

test('in debug mode it logs why the proof server does not answer, and nothing from the call', async () => {
  const c = await deploy();
  const bono: Bono = await c.issue(Plan.free);
  const state = await stateOf(c);
  const refused = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6300'), { code: 'ECONNREFUSED' }) });
  const cases: [FakeChain['prover'], string][] = [
    [() => new Response('busy', { status: 503 }), 'HTTP 503'],
    [() => { throw refused; }, 'TypeError ECONNREFUSED'],
    [() => { throw new DOMException('The operation timed out', 'TimeoutError'); }, 'TimeoutError'],
    [() => { throw 'boom'; }, 'unknown'], // eslint-disable-line no-throw-literal
  ];
  for (const [prover, why] of cases) {
    fakeChain({ state, prover });
    const lines: string[] = [];
    const h = proveHandlers(() => json('rpc/initialize.json'), { log: (m) => lines.push(m) });
    assert.equal((await appError(h['contract.proveCall'](aliasCall(c, bono, 0), ctx()))).code, codes.PROVER_UNAVAILABLE);
    assert.deepEqual(lines, [`contract.proveCall: proof server unavailable: ${why}`]);
  }
  // Without a log (the normal case outside debugging) it does not fail.
  fakeChain({ state });
  assert.equal((await appError(proveHandlers(() => json('rpc/initialize.json'))['contract.proveCall'](aliasCall(c, bono, 0), ctx()))).code, codes.PROVER_UNAVAILABLE);
});

test('the proveCall debug log only writes to stderr with debug', async () => {
  const c = await deploy();
  const call = aliasCall(c, await c.issue(Plan.free), 0);
  const state = await stateOf(c);
  const written: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { written.push(args.join(' ')); };
  try {
    for (const debug of [false, true]) {
      fakeChain({ state });
      const h = createHandlers({ initialized: null });
      await h.initialize({ ...json('rpc/initialize.json'), debug }, ctx());
      await failure(h['contract.proveCall'](call, ctx()));
    }
  } finally {
    console.error = original;
  }
  assert.deepEqual(written, ['[sidecar] contract.proveCall: proof server unavailable: TypeError']);
});

test('proof server response that is not understood: internal error, without the secret in the message', async () => {
  const c = await deploy();
  const bono: Bono = await c.issue(Plan.free);
  const odd: FakeChain['prover'][] = [
    () => new Response('bad request', { status: 400 }),
    () => new Response('not found', { status: 404 }),
    () => new Response(new Uint8Array(64).fill(7)),
    (path, init) => (path === '/check' ? replayProver('createAlias')(path, init) : new Response(new Uint8Array(64).fill(7))),
  ];
  for (const prover of odd) {
    const err = await failure((await prove(c, aliasCall(c, bono, 0), { prover })).result);
    assert.ok(err instanceof Error && !(err instanceof AppError), String(err));
    assert.ok(!`${err.message} ${err.stack}`.includes(hex(bono.s)));
  }
});

test('if the core cancels while proving, the request to the proof server is aborted and the error comes out as is', async () => {
  const c = await deploy();
  const bono: Bono = await c.issue(Plan.free);
  const controller = new AbortController();
  let proverSignal: AbortSignal | undefined;
  const prover: FakeChain['prover'] = (_path, init) => new Promise((_resolve, reject) => {
    proverSignal = init.signal!;
    init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    setImmediate(() => controller.abort());
  });
  const err = await failure((await prove(c, aliasCall(c, bono, 0), { prover }, [], controller.signal)).result);
  assert.ok(!(err instanceof AppError) && err.name === 'AbortError', String(err));
  assert.equal(proverSignal?.aborted, true);
});

test('cancelled before starting to prove: it does not reach the proof server', async () => {
  const c = await deploy();
  const bono: Bono = await c.issue(Plan.free);
  const controller = new AbortController();
  const sent: Notification[] = [];
  const state = await stateOf(c);
  const requests = fakeChain({ state, prover: replayProver('createAlias') });
  const notify = ctx(controller.signal, sent);
  const stop = { ...notify, notify: (method: string, params: any) => { notify.notify(method, params); if (params.stage === 'building') controller.abort(); } };
  const err = await failure((await ready())['contract.proveCall'](aliasCall(c, bono, 0), stop));
  assert.ok(!(err instanceof AppError) && err.name === 'AbortError', String(err));
  assert.equal(proverRequests(requests).length, 0);
});

// --- Parameters -------------------------------------------------------------------------------------

test('malformed params → INVALID_PARAMS (fixed message), without initialize → NOT_INITIALIZED', async () => {
  const c = await deploy();
  const bono: Bono = await c.issue(Plan.paid);
  const m = c.mailbox('ana', bono, 0n);
  const alias = aliasCall(c, bono, 0);
  const register = registerCall(c, m, 'ana');
  const w = alias.witnesses;
  const bad: unknown[] = [
    null, [], {}, 'createAlias', { ...alias, contractAddress: 'AD'.repeat(32) }, { ...alias, contractAddress: undefined },
    { ...alias, circuit: 'buyBono' }, { ...alias, circuit: 'issueBono' }, { ...alias, circuit: 'toString' }, { ...alias, circuit: 7 },
    { ...alias, circuit: undefined }, { ...alias, args: null }, { ...alias, args: [] }, { ...alias, args: { encPk: 'e1'.repeat(32) } },
    { ...alias, args: { ...alias.args, authPk: 'A7'.repeat(32) } }, { ...alias, args: { ...alias.args, encPk: 'e1' } },
    { ...alias, witnesses: undefined }, { ...alias, witnesses: null }, { ...alias, witnesses: [] },
    { ...alias, witnesses: { ...w, s: 'zz'.repeat(32) } }, { ...alias, witnesses: { ...w, s: undefined } },
    { ...alias, witnesses: { ...w, k: -1 } }, { ...alias, witnesses: { ...w, k: 2 ** 32 } }, { ...alias, witnesses: { ...w, k: '0' } },
    { ...alias, witnesses: { ...w, plan: 'gold' } }, { ...alias, witnesses: { ...w, plan: 1 } },
    { ...alias, witnesses: { ...w, validUntil: 2 ** 32 } }, { ...alias, witnesses: { ...w, validUntil: undefined } },
    { ...alias, witnesses: { ...w, j: 256 } }, { ...alias, witnesses: { ...w, j: 1.5 } }, { ...alias, witnesses: { ...w, j: '1' } },
    { ...register, witnesses: undefined }, { ...register, args: { ...register.args, name: 7 } },
    { ...register, args: { ...register.args, nameCipher: 'c1'.repeat(103) } }, { ...register, args: { ...register.args, nameCipher: 'c1'.repeat(105) } },
    { ...register, args: { ...register.args, encPk: null } }, { ...register, args: { ...register.args, authPk: 5 } },
    { ...register, args: { ...register.args, encPk: 'e1' } }, { ...register, args: { ...register.args, nameCipher: undefined } },
  ];
  const requests = fakeChain({ state: await stateOf(c) });
  const h = await ready();
  for (const p of bad) {
    assert.deepEqual(await appError(h['contract.proveCall'](p, ctx())), { code: codes.INVALID_PARAMS, message: 'Invalid params' }, JSON.stringify(p)?.slice(0, 120));
  }
  assert.equal(requests.length, 0, 'malformed input does not reach the network');
  assert.equal((await appError(createHandlers({ initialized: null })['contract.proveCall'](alias, ctx()))).code, codes.NOT_INITIALIZED);
});

test('registerMailbox with a name that is not valid as a mailbox: NAME_REJECTED with the reason', async () => {
  const c = await deploy();
  const m = c.mailbox('ana', await c.issue(Plan.free), 0n);
  for (const [name, reason] of [['josé', 'invalid'], ['ana.abcdefghijkl', 'alias-form'], ['Postmaster', 'reserved']]) {
    const { result } = await prove(c, registerCall(c, m, name));
    assert.deepEqual(await appError(result), { code: codes.NAME_REJECTED, message: 'Name rejected', data: { reason } }, name);
  }
});

test('the proof server used is the origin validated in initialize', async () => {
  const c = await deploy();
  const bono: Bono = await c.issue(Plan.free);
  const state = await stateOf(c);
  const requests = fakeChain({ state, prover: replayProver('createAlias') });
  const h = createHandlers({ initialized: null });
  const init = json('rpc/initialize.json');
  await h.initialize({ ...init, endpoints: { ...init.endpoints, proofServer: 'http://127.1:6300/' } }, ctx());
  await h['contract.proveCall'](aliasCall(c, bono, 0), ctx());
  assert.deepEqual(proverRequests(requests).map((r) => r.url), ['http://127.0.0.1:6300/check', 'http://127.0.0.1:6300/prove']);
});
