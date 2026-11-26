// Test helpers: real NightMailRegistry states built with the contract test simulator
// (contracts/test/sim.ts; requires `npm run compile:sim -w contracts`).
// It is imported through a non-literal path so tsc does not check that file with this package's
// config (it belongs to another package with its own).
import { ContractState } from '@midnight-ntwrk/compact-runtime';
import { Plan, readRegistry } from '../src/index.ts';

const SIM: string = '../../../contracts/test/sim.ts';
const sim = await import(SIM);

/** Contract deployed in the simulator (see contracts/test/sim.ts). */
export type Sim = any;
export const deploy: (opts?: { price?: bigint }) => Promise<Sim> = sim.deploy;
export const hex: (b: Uint8Array) => string = sim.hex;

/**
 * Advances the round and returns the resulting ContractState (the harness only exposes the ledger;
 * the full state comes from the circuit context).
 */
export async function advanceRoundState(c: Sim): Promise<ContractState> {
  const r = await c.runFull('advanceRound', { opSk: c.opSk });
  const cs = new ContractState();
  cs.data = r.context.callContext.currentQueryContext.state;
  return cs;
}

/**
 * Serialized state (hex, as the indexer serves it) with something in every collection: a `bono`, two
 * aliases, a mailbox reservation, a previous price and a round.
 */
export async function registryState() {
  const c = await deploy({ price: 5n });
  const bono = await c.issue(Plan.free);
  await c.alias(bono, 0n);
  await c.alias(bono, 1n);
  await c.reserve(c.mailbox('ana', bono, 0n));
  await c.setPrice(8n);
  const cs = await advanceRoundState(c);
  return { stateHex: hex(cs.serialize()), expected: readRegistry(c.view()) };
}
