// Leaf → position index of the `bonos` tree, read from the serialized state (the contract inserts with
// insertHash, which cannot look up by value). States are built with the contract simulator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContractState } from '@midnight-ntwrk/compact-runtime';
import { bonoPositions, decodeState, InvalidInput, NotRegistryState, Plan } from '../src/index.ts';
import { contractStateOf, deploy, hex } from './helpers.ts';

/** The state as it comes from the indexer (hex), decoded again. */
const viaIndexer = async (c: any) => decodeState(hex(contractStateOf(c).serialize()));

test('tree without leaves: empty index', async () => {
  assert.deepEqual(bonoPositions(await viaIndexer(await deploy())), { positions: new Map(), leafCount: 0 });
});

test('each issued leaf (free or paid, by the operator or purchased) is at its insertion position', async () => {
  const c = await deploy();
  const bonos = [await c.issue(Plan.free), await c.issue(Plan.paid), await c.buy(), await c.issue(Plan.free)];
  await c.alias(bonos[0], 0n); // other activity does not change the index
  const { positions, leafCount } = bonoPositions(await viaIndexer(c));
  assert.deepEqual(positions, new Map(bonos.map((b, i) => [hex(c.leafOf(b)), i])));
  assert.equal(BigInt(leafCount), c.view().bonos.firstFree());
});

test('the index position gives a path the contract accepts', async () => {
  const c = await deploy();
  await c.issue(Plan.paid);
  const bono = await c.issue(Plan.free);
  const state = await viaIndexer(c);
  const position = bonoPositions(state).positions.get(hex(c.leafOf(bono)))!;
  const path = c.view().bonos.pathForLeaf(BigInt(position), c.leafOf(bono));
  await c.createAlias(c.aliasFor(bono, 0n), { path });
  assert.equal(c.view().slotNullifiers.size(), 1n);
});

test('a repeated leaf (two purchases of the same id: the contract does not prevent it) breaks the index for nobody', async () => {
  // A value-keyed index would collapse the duplicate pair and break lookups for every client.
  const c = await deploy();
  const first = await c.issue(Plan.free);
  const bought = await c.buy(undefined, new Uint8Array(32).fill(7), 0n);
  await c.buy(undefined, bought.s, 0n); // the same leaf again (e.g. a retried wallet.buyBono)
  const after = await c.issue(Plan.paid);
  const state = await viaIndexer(c);
  const { positions, leafCount } = bonoPositions(state);
  assert.equal(BigInt(leafCount), c.view().bonos.firstFree(), 'leafCount counts the occupied positions, repeated ones included');
  assert.equal(leafCount, 4);
  assert.deepEqual([first, bought, after].map((b) => positions.get(hex(c.leafOf(b)))), [0, 1, 3], 'the repeated one, at its first position');
  const path = c.view().bonos.pathForLeaf(1n, c.leafOf(bought));
  await c.createAlias(c.aliasFor(bought, 0n), { path });
  assert.equal(c.view().slotNullifiers.size(), 1n, 'the path of that position is valid');
});

test('the state of another contract is not a registry: NotRegistryState', () => {
  assert.throws(() => bonoPositions(new ContractState()), NotRegistryState);
});

test('decodeState: the state in hex as the indexer serves it: anything else is InvalidInput', async () => {
  const c = await deploy();
  const cs = contractStateOf(c);
  assert.deepEqual(decodeState(hex(cs.serialize())).serialize(), cs.serialize());
  for (const bad of ['', 'zz', 'ABCD', '0', '00', 42, null]) {
    assert.throws(() => decodeState(bad as string), (e) => e instanceof InvalidInput && !(e instanceof NotRegistryState), String(bad));
  }
});
