// contract.findBonos: leaf to position index of the bonos tree, with a fake indexer behind net.ts
// serving the state of a simulator contract.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ContractState } from '@midnight-ntwrk/compact-runtime';
import { createHandlers } from '../src/handlers.ts';
import { setFetchForTests } from '../src/net.ts';
import { AppError, codes } from '../src/codes.ts';
import { MAX_FIND_LEAVES } from '../src/contract.ts';
import { Plan } from '@nightmail/midnight';
import { advanceRoundState, deploy, hex } from '../../../packages/midnight/test/helpers.ts';
import { ADDRESS, appError, ctx, failure, fakeChain, INDEXER, json, ready } from './helpers.ts';

afterEach(() => setFetchForTests((...args) => fetch(...args)));

/** Simulator contract with three issued bonos and its state as the indexer serves it. */
async function threeBonos() {
  const c = await deploy();
  const bonos = [await c.issue(Plan.free), await c.issue(Plan.paid), await c.issue(Plan.free)];
  const leaves: string[] = bonos.map((b) => hex(c.leafOf(b)));
  return { leaves, stateHex: hex((await advanceRoundState(c)).serialize()) };
}

const find = async (params: unknown, h?: Awaited<ReturnType<typeof ready>>) => (h ?? (await ready()))['contract.findBonos'](params, ctx());

test('contract.findBonos: the position of each requested leaf (null if absent), the block and how many leaves there are', async () => {
  const { leaves, stateHex } = await threeBonos();
  const requests = fakeChain({ state: stateHex, tip: 321 });
  const unknown = 'ee'.repeat(32);
  assert.deepEqual(await find({ contractAddress: ADDRESS, leaves: [leaves[2], unknown, leaves[0], leaves[2]] }),
    { blockHeight: 321, leafCount: 3, positions: [2, null, 0, 2] });
  // The state is read from the indexer pinned to the latest block; the leaves never leave the sidecar.
  assert.deepEqual(requests.map((r) => r.url), [INDEXER, INDEXER]);
  assert.deepEqual(JSON.parse(String(requests[1].init.body)).variables, { address: ADDRESS, offset: { height: 321 } });
  assert.ok(requests.every((r) => !String(r.init.body).includes(leaves[0])));
});

test('contract.findBonos: a repeated leaf (two purchases of the same id) does not starve the rest, and positions are counted', async () => {
  // Regression: this used to give CONTRACT_NOT_FOUND for every leaf from the first repeated one on.
  const c = await deploy();
  const other = await c.issue(Plan.free);
  const bought = await c.buy(undefined, new Uint8Array(32).fill(7), 0n);
  await c.buy(undefined, bought.s, 0n);
  fakeChain({ state: hex((await advanceRoundState(c)).serialize()) });
  assert.deepEqual(await find({ contractAddress: ADDRESS, leaves: [hex(c.leafOf(bought)), hex(c.leafOf(other))] }),
    { blockHeight: 100, leafCount: 3, positions: [1, 0] });
});

test('contract.findBonos with minLeafCount: with fewer leaves than already seen, STALE_STATE behind, with the same, it answers', async () => {
  const { leaves, stateHex } = await threeBonos();
  fakeChain({ state: stateHex });
  const h = await ready();
  const err = await appError(find({ contractAddress: ADDRESS, leaves, minLeafCount: 4 }, h));
  assert.deepEqual([err.code, err.message, (err.data as { reason: string; leafCount: number }).reason, (err.data as { leafCount: number }).leafCount],
    [codes.STALE_STATE, 'Stale chain state', 'behind', 3]);
  assert.equal(typeof (err.data as { ageMs: unknown }).ageMs, 'number');
  assert.equal(((await find({ contractAddress: ADDRESS, leaves, minLeafCount: 3 }, h)) as { leafCount: number }).leafCount, 3);
  assert.equal(((await find({ contractAddress: ADDRESS, leaves, minLeafCount: 0 }, h)) as { leafCount: number }).leafCount, 3);
  for (const bad of [-1, 1.5, '3', null, 2 ** 32]) {
    assert.equal((await appError(find({ contractAddress: ADDRESS, leaves, minLeafCount: bad }, h))).code, codes.INVALID_PARAMS, String(bad));
  }
});

test('contract.findBonos: tree without leaves', async () => {
  fakeChain({ state: hex((await advanceRoundState(await deploy())).serialize()) });
  assert.deepEqual(await find({ contractAddress: ADDRESS, leaves: ['ee'.repeat(32)] }), { blockHeight: 100, leafCount: 0, positions: [null] });
});

test('contract.findBonos with the shape of the RPC vector shared with Rust', async () => {
  const { leaves, stateHex } = await threeBonos();
  fakeChain({ state: stateHex });
  const v = json('rpc/contract-find-bonos.json');
  assert.deepEqual(await find({ ...v.params, leaves: [leaves[0], v.params.leaves[1]] }), v.result);
});

test('contract.findBonos: malformed params → INVALID_PARAMS, without initialize → NOT_INITIALIZED', async () => {
  const { leaves, stateHex } = await threeBonos();
  fakeChain({ state: stateHex });
  const h = await ready();
  const good = { contractAddress: ADDRESS, leaves: [leaves[0]] };
  const bad = [
    null, [], {}, { contractAddress: ADDRESS }, { leaves: good.leaves }, { ...good, contractAddress: 'AD'.repeat(32) },
    { ...good, contractAddress: 'ad' }, { ...good, leaves: [] }, { ...good, leaves: leaves[0] }, { ...good, leaves: [leaves[0].toUpperCase()] },
    { ...good, leaves: [leaves[0].slice(2)] }, { ...good, leaves: [leaves[0], 7] }, { ...good, leaves: [null] },
    { ...good, leaves: new Array(MAX_FIND_LEAVES + 1).fill(leaves[0]) },
  ];
  for (const p of bad) {
    assert.deepEqual(await appError(find(p, h)), { code: codes.INVALID_PARAMS, message: 'Invalid params' }, JSON.stringify(p)?.slice(0, 80));
  }
  const max = (await find({ ...good, leaves: new Array(MAX_FIND_LEAVES).fill(leaves[1]) }, h)) as { positions: number[] };
  assert.deepEqual([max.positions.length, max.positions[MAX_FIND_LEAVES - 1]], [MAX_FIND_LEAVES, 1]);
  assert.equal((await appError(createHandlers({ initialized: null })['contract.findBonos'](good, ctx()))).code, codes.NOT_INITIALIZED);
});

test('contract.findBonos: no contract, or the state of another contract → CONTRACT_NOT_FOUND', async () => {
  for (const state of [null, hex(new ContractState().serialize())]) {
    fakeChain({ state });
    assert.deepEqual(await appError(find({ contractAddress: ADDRESS, leaves: ['ee'.repeat(32)] })),
      { code: codes.CONTRACT_NOT_FOUND, message: 'Contract not found' });
  }
});

test('contract.findBonos: indexer down → UPSTREAM_UNAVAILABLE, response not understood → internal error', async () => {
  setFetchForTests(async () => new Response('boom', { status: 502 }));
  assert.deepEqual(await appError(find({ contractAddress: ADDRESS, leaves: ['ee'.repeat(32)] })),
    { code: codes.UPSTREAM_UNAVAILABLE, message: 'Indexer unavailable' });
  fakeChain({ state: 'zz' });
  const err = await failure(find({ contractAddress: ADDRESS, leaves: ['ee'.repeat(32)] }));
  assert.ok(err instanceof Error && !(err instanceof AppError), String(err));
});

test('contract.findBonos: if the core cancels, the error comes out as is (rpc.ts answers Cancelled)', async () => {
  const controller = new AbortController();
  setFetchForTests(async () => {
    controller.abort();
    throw new DOMException('aborted', 'AbortError');
  });
  const err = await failure((await ready())['contract.findBonos']({ contractAddress: ADDRESS, leaves: ['ee'.repeat(32)] }, ctx(controller.signal)));
  assert.ok(!(err instanceof AppError) && err.name === 'AbortError');
});
