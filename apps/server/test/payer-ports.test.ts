// The registry as the payer sees it (payer/ports.ts): startup checks (contracts.json, operator-sk, the
// contract exists and the key is its operator) and what it delegates to the contract. The contract is the
// real compiled one in the simulator; only the chain connection is fake.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { idK, leaf as leafOf, NO_EXPIRY, Plan } from '@nightmail/midnight';
import type { ServerConfig } from '../src/config.ts';
import { openRegistry, PayerConfigError } from '../src/payer/ports.ts';
import { deployRegistrySim, rand } from './registry-sim.ts';
import { tempDir } from './temp-dir.ts';

const PREPARED = { bytes: new Uint8Array(3), proveMs: 1, kinds: ['dust' as const] };

async function setup(t: TestContext, o: { contracts?: boolean; opSk?: Uint8Array | null; onChain?: boolean } = {}) {
  const sim = await deployRegistrySim();
  const dataDir = path.join(tempDir(t), 'undeployed');
  mkdirSync(dataDir, { mode: 0o700 });
  if (o.contracts !== false) {
    writeFileSync(path.join(dataDir, 'contracts.json'), JSON.stringify({ network: 'undeployed', registry: { address: sim.address } }));
  }
  const opSk = o.opSk === undefined ? sim.opSk : o.opSk;
  if (opSk) writeFileSync(path.join(dataDir, 'operator-sk'), Buffer.from(opSk).toString('hex'), { mode: 0o600 });
  const calls: unknown[][] = [];
  const messages: string[] = [];
  const chain = {
    indexedTime: async () => new Date(1_234_000),
    contract: async (name: string) => {
      calls.push(['contract', name]);
      return {
        module: sim.module,
        exists: async (address: string) => o.onChain !== false && address === sim.address,
        ledgerState: async () => sim.module.ledger(sim.state()),
        state: async () => ({ data: sim.state() }),
        prepare: async (...args: unknown[]) => { calls.push(['prepare', ...args]); return PREPARED; },
      };
    },
  };
  const config = { network: 'undeployed', dataDir } as ServerConfig;
  const open = () => openRegistry(config, chain as never, { info: (m) => { messages.push(m); }, warn: () => {} });
  return { sim, dataDir, calls, messages, open };
}

test('without deployed contracts there is no registry: it says so and the payer will only relay', async (t) => {
  const s = await setup(t, { contracts: false });
  assert.equal(await s.open(), null);
  assert.match(s.messages.join('\n'), /issue and advance-round are disabled/);
  assert.deepEqual(s.calls, [], 'does not even load the contract');
});

test('without operator-sk it does not start (and does not create a new key, which would not be the contract key)', async (t) => {
  const s = await setup(t, { opSk: null });
  await assert.rejects(s.open(), (e: unknown) => e instanceof PayerConfigError && /operator-sk is missing/.test(e.message));
  assert.equal(existsSync(path.join(s.dataDir, 'operator-sk')), false);
});

test('if the recorded contract is not on chain (devnet restarted) it does not start', async (t) => {
  const s = await setup(t, { onChain: false });
  await assert.rejects(s.open(), (e: unknown) => e instanceof PayerConfigError && /stale/.test(e.message));
});

test('if operator-sk is not the contract operator key it does not start', async (t) => {
  const s = await setup(t, { opSk: rand() });
  await assert.rejects(s.open(), (e: unknown) => e instanceof PayerConfigError && /not the operator key/.test(e.message));
});

test('with everything in order: proves calls with the operator key, checks the leaves in the real state and reads the round', async (t) => {
  const s = await setup(t);
  const registry = await s.open();
  assert.ok(registry);
  assert.equal(registry.address, s.sim.address);
  assert.deepEqual(s.calls, [['contract', 'registry']]);

  const id = idK(s.sim.ctx, rand(), 0n);
  assert.equal(await registry.prepare('issueBono', [id, Plan.paid]), PREPARED);
  const [, address, circuit, privateState, args] = s.calls[1] as [string, string, string, { opSk: Uint8Array }, unknown[]];
  assert.deepEqual([address, circuit, args], [s.sim.address, 'issueBono', [id, Plan.paid]]);
  assert.deepEqual(privateState.opSk, s.sim.opSk);

  const leaves = [leafOf(s.sim.ctx, id, Plan.paid, NO_EXPIRY), leafOf(s.sim.ctx, id, Plan.free, NO_EXPIRY)];
  assert.deepEqual(await registry.hasLeaves(leaves), [false, false]);
  await s.sim.issue(id, Plan.paid);
  assert.deepEqual(await registry.hasLeaves(leaves), [true, false], 'reads the current state, not a stored one');
  assert.equal(await registry.round(), 0n);
  assert.deepEqual(await registry.indexedTime(), new Date(1_234_000), 'the indexer time of the connection');
});
