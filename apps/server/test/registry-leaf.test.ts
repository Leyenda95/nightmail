// Is a `bono` leaf already in the `bonos` tree? Uses the real compiled contract in the simulator (no ZK
// proofs); leaves are inserted by issueBono with insertHash, as on chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idK, leaf as leafOf, NO_EXPIRY, Plan } from '@nightmail/midnight';
import { hasBonoLeaf } from '../src/chain/registry.ts';
import { deployRegistrySim, rand } from './registry-sim.ts';

test('hasBonoLeaf: finds the issued leaves (by id and plan) and not the ones that are not', async () => {
  const c = await deployRegistrySim();
  const [a, b, absent] = [rand(), rand(), rand()].map((s) => idK(c.ctx, s, 0n));
  const leaf = (id: Uint8Array, plan: Plan) => leafOf(c.ctx, id, plan, NO_EXPIRY);
  assert.equal(hasBonoLeaf(c.state(), leaf(a!, Plan.free)), false, 'empty tree');
  await c.issue(a!, Plan.free);
  await c.issue(b!, Plan.paid);
  assert.equal(c.module.ledger(c.state()).bonos.firstFree(), 2n);
  assert.equal(hasBonoLeaf(c.state(), leaf(a!, Plan.free)), true);
  assert.equal(hasBonoLeaf(c.state(), leaf(b!, Plan.paid)), true);
  assert.equal(hasBonoLeaf(c.state(), leaf(a!, Plan.paid)), false, 'the same id with another plan is another leaf');
  assert.equal(hasBonoLeaf(c.state(), leaf(absent!, Plan.free)), false);
  // Also accepts the StateValue (what the ChargedState wraps).
  assert.equal(hasBonoLeaf((c.state() as any).state, leaf(b!, Plan.paid)), true);
});

test('hasBonoLeaf: the leaf must be 32 bytes', async () => {
  const c = await deployRegistrySim();
  assert.throws(() => hasBonoLeaf(c.state(), new Uint8Array(31)), /32 bytes/);
  assert.throws(() => hasBonoLeaf(c.state(), 'ab'.repeat(32) as never), /32 bytes/);
});
