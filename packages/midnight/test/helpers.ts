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

/** The simulator's current state as a ContractState (what the indexer's state bytes decode to). */
export const contractStateOf = (c: Sim): ContractState => c.contractState();

/**
 * Serialized state (hex, as the indexer serves it) with something in every collection: a `bono`, two
 * aliases, a mailbox and a previous price.
 */
export async function registryState() {
  const c = await deploy({ price: 5n });
  const bono = await c.issue(Plan.free);
  await c.alias(bono, 0n);
  await c.alias(bono, 1n);
  await c.register(c.mailbox('ana', bono, 0n));
  await c.setPrice(8n);
  const cs = contractStateOf(c);
  return { stateHex: hex(cs.serialize()), expected: readRegistry(c.view()) };
}
