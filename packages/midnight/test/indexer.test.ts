// Reading state through the indexer with a fake GraphQL (the real one is injected by the caller).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContractState } from '@midnight-ntwrk/compact-runtime';
import {
  fetchCallStates, fetchRegistry, type GraphQL, IndexerError, IndexerUnavailable, InvalidInput, latestHeight, NotRegistryState,
  readJsonCapped,
} from '../src/index.ts';
import { hex, registryState } from './helpers.ts';

const ADDRESS = 'ad'.repeat(32);
const hashAt = (h: number) => h.toString(16).padStart(64, '0');
const timeAt = (h: number) => 1_800_000_000_000 + h * 6000;

/** Fake indexer: latest block `tip`; the contract exists from height `since` with that state. */
function fakeIndexer(tip: number, since: number, stateHex: unknown) {
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  const gql: GraphQL = async (query, variables) => {
    calls.push({ query, variables });
    if (!('offset' in variables)) return { data: { block: { height: tip } } };
    const h = (variables.offset as { height: number }).height;
    if (h > tip) return { data: { block: null, contract: null } };
    const block = { height: h, hash: hashAt(h), timestamp: timeAt(h) };
    return { data: { block, contract: h >= since ? { state: stateHex } : null } };
  };
  return { gql, calls };
}

test('without height: pins the latest block and reads the state at it, with the block hash and time', async () => {
  const { stateHex, expected } = await registryState();
  const { gql, calls } = fakeIndexer(120, 10, stateHex);
  const r = await fetchRegistry(gql, ADDRESS);
  assert.deepEqual(r, { blockHeight: 120, blockHash: hashAt(120), blockTimestamp: timeAt(120), stateBytes: stateHex.length / 2, snapshot: expected });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].variables, { address: ADDRESS, offset: { height: 120 } });
  assert.match(calls[1].query, /block\(offset: \$offset\) \{ height hash timestamp \}/);
  assert.match(calls[1].query, /contract\(address: \$address, offset: \$offset\) \{ state \}/);
});

test('with height: reads the state at that height, without asking for the latest block', async () => {
  const { stateHex, expected } = await registryState();
  const { gql, calls } = fakeIndexer(120, 10, stateHex);
  assert.deepEqual(await fetchRegistry(gql, ADDRESS, 50),
    { blockHeight: 50, blockHash: hashAt(50), blockTimestamp: timeAt(50), stateBytes: stateHex.length / 2, snapshot: expected });
  assert.deepEqual(await fetchRegistry(gql, ADDRESS, 0), null, 'does not exist before the deployment');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].variables.offset, { height: 50 });
});

test('invalid inputs: address and requested height', async () => {
  const { gql } = fakeIndexer(120, 10, '00');
  await assert.rejects(fetchRegistry(gql, 'AD'.repeat(32)), InvalidInput);
  await assert.rejects(fetchRegistry(gql, ADDRESS, -1), InvalidInput);
  await assert.rejects(fetchRegistry(gql, ADDRESS, 1.5), InvalidInput);
  await assert.rejects(fetchRegistry(gql, ADDRESS, 121), InvalidInput, 'a requested block that does not exist yet');
});

test('the latest block chosen by fetchRegistry is no longer in the indexer: IndexerError, not InvalidInput', async () => {
  const lost: GraphQL = async (_q, v) => ('offset' in v ? { data: { block: null, contract: null } } : { data: { block: { height: 9 } } });
  const err = await fetchRegistry(lost, ADDRESS).catch((e) => e);
  assert.ok(err instanceof IndexerError && !(err instanceof InvalidInput));
});

test('the state is from another contract: NotRegistryState (for the caller there is no registry)', async () => {
  await assert.rejects(fetchRegistry(fakeIndexer(5, 0, hex(new ContractState().serialize())).gql, ADDRESS), NotRegistryState);
});

test('GraphQL errors: IndexerUnavailable (can be retried)', async () => {
  for (const body of [{ errors: [{ message: 'x' }], data: null }, { errors: [], data: { block: { height: 1 } } }]) {
    await assert.rejects(latestHeight(async () => body), IndexerUnavailable, JSON.stringify(body));
  }
});

test('responses that are not understood: IndexerError', async () => {
  for (const body of [{}, null, { data: null }, { data: { block: null } }]) {
    await assert.rejects(latestHeight(async () => body), IndexerError, JSON.stringify(body));
  }
  for (const height of ['1', -1, 1.5, null]) {
    await assert.rejects(latestHeight(async () => ({ data: { block: { height } } })), IndexerError, String(height));
  }
  assert.equal(await latestHeight(async () => ({ data: { block: { height: 0 } } })), 0);
  const block = (b: object): GraphQL => async () => ({ data: { block: { height: 8, hash: hashAt(8), timestamp: 1, ...b }, contract: null } });
  await assert.rejects(fetchRegistry(block({ height: 7 }), ADDRESS, 8), IndexerError, 'another block');
  for (const hash of ['AB'.repeat(32), 'ab', 42, undefined]) {
    await assert.rejects(fetchRegistry(block({ hash }), ADDRESS, 8), IndexerError, String(hash));
  }
  for (const timestamp of [-1, '1', 1.5, undefined]) {
    await assert.rejects(fetchRegistry(block({ timestamp }), ADDRESS, 8), IndexerError, String(timestamp));
  }
  assert.equal(await fetchRegistry(block({ timestamp: 0 }), ADDRESS, 8), null);
  for (const state of ['zz', '00', 42, '']) {
    const err = await fetchRegistry(fakeIndexer(5, 0, state).gql, ADDRESS).catch((e) => e);
    assert.ok(err instanceof IndexerError, String(state));
  }
});

test('readJsonCapped: reads the JSON as a stream without exceeding the cap', async () => {
  const body = JSON.stringify({ data: { block: { height: 1 } } });
  assert.deepEqual(await readJsonCapped(new Response(body), body.length), JSON.parse(body));
  await assert.rejects(readJsonCapped(new Response(body), body.length - 1), IndexerError, 'larger than the cap');
  const declared = new Response('{}', { headers: { 'content-length': '1000' } });
  await assert.rejects(readJsonCapped(declared, 999), IndexerError, 'content-length above the cap');
  const exact = new Response('{}', { headers: { 'content-length': '2' } });
  assert.deepEqual(await readJsonCapped(exact, 2), {}, 'exactly at the cap is fine');
  await assert.rejects(readJsonCapped(new Response(null), 10), IndexerError, 'no body: not JSON');
  let pulled = 0;
  const endless = new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(1024)); } });
  await assert.rejects(readJsonCapped(new Response(endless), 10_000), IndexerError, 'endless: it is cut off');
  assert.ok(pulled < 20, 'stops reading once past the cap');
  await assert.rejects(readJsonCapped(new Response('{nope'), 100), IndexerError, 'invalid JSON');
  assert.equal(await readJsonCapped(new Response('null'), 4), null);
});

// --- fetchCallStates: what a local circuit run needs -----------------------------------------------

/** Fake indexer that also serves the ledger parameters and the contract's Zswap state. */
const BLANK_STATE = hex(new ContractState().serialize());
function callIndexer(tip: number, extra: Record<string, unknown> = { ledgerParameters: 'aa01', contractZswapState: 'bb02' }, state: unknown = BLANK_STATE) {
  const { gql, calls } = fakeIndexer(tip, 0, state);
  const withExtra: GraphQL = async (query, variables) => {
    const body = (await gql(query, variables)) as { data: { block: object | null } };
    if ('offset' in variables && body.data.block) Object.assign(body.data.block, extra);
    return body;
  };
  return { gql: withExtra, calls };
}

test('fetchCallStates: state, ledger parameters and Zswap state of the same block (the latest)', async () => {
  const { stateHex } = await registryState();
  const { gql, calls } = callIndexer(77, undefined, stateHex);
  const { state, ...rest } = (await fetchCallStates(gql, ADDRESS))!;
  assert.deepEqual(rest, { blockHeight: 77, blockHash: hashAt(77), blockTimestamp: timeAt(77), ledgerParameters: 'aa01', zswapState: 'bb02' });
  assert.equal(hex(state.serialize()), stateHex, 'the contract state, already read');
  assert.equal(calls.length, 2, 'first the height, then everything in one query pinned to it');
  assert.deepEqual(calls[1].variables, { address: ADDRESS, offset: { height: 77 } });
  assert.match(calls[1].query, /block\(offset: \$offset\) \{ height hash timestamp ledgerParameters contractZswapState\(address: \$address\) \}/);
  assert.match(calls[1].query, /contract\(address: \$address, offset: \$offset\) \{ state \}/);
});

test('fetchCallStates: no contract at that address, null: malformed address, InvalidInput', async () => {
  const none: GraphQL = async (_q, v) =>
    ({ data: 'offset' in v ? { block: { height: 5, hash: hashAt(5), timestamp: 1, ledgerParameters: 'aa', contractZswapState: null }, contract: null } : { block: { height: 5 } } });
  assert.equal(await fetchCallStates(none, ADDRESS), null);
  await assert.rejects(fetchCallStates(none, 'AD'.repeat(32)), InvalidInput);
});

test('fetchCallStates: what is not hex (or is missing) is IndexerError: a GraphQL error, IndexerUnavailable', async () => {
  const good = { ledgerParameters: 'aa01', contractZswapState: 'bb02' };
  for (const bad of [{ ...good, ledgerParameters: 'zz' }, { ...good, ledgerParameters: '' }, { ...good, ledgerParameters: undefined },
    { ...good, contractZswapState: 'ABCD' }, { ...good, contractZswapState: 7 }, { ...good, contractZswapState: null }]) {
    await assert.rejects(fetchCallStates(callIndexer(9, bad).gql, ADDRESS), IndexerError, JSON.stringify(bad));
  }
  for (const state of ['zz', 'a', '', 42, '00']) {
    await assert.rejects(fetchCallStates(callIndexer(9, good, state).gql, ADDRESS), IndexerError, String(state));
  }
  const lost: GraphQL = async (_q, v) => ('offset' in v ? { data: { block: null, contract: null } } : { data: { block: { height: 9 } } });
  await assert.rejects(fetchCallStates(lost, ADDRESS), (e) => e instanceof IndexerError && !(e instanceof InvalidInput));
  await assert.rejects(fetchCallStates(async () => ({ errors: [{ message: 'x' }] }), ADDRESS), IndexerUnavailable);
});
