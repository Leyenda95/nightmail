// The real compiled NightMailRegistry in the Compact simulator (no ZK proofs, no network), for tests that
// need real contract state: one deployment plus issuances with issueBono.
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCircuitContext, createConstructorContext, sampleContractAddress } from '@midnight-ntwrk/compact-runtime';
import { ctx as ctxOf, NO_EXPIRY, Plan } from '@nightmail/midnight';
import { compiledDir } from '../src/chain/midnight.ts';
import { registryWitnesses } from '../src/chain/registry.ts';

export const rand = () => new Uint8Array(randomBytes(32));
const COIN_PK = '0'.repeat(64);

export async function deployRegistrySim() {
  const module = await import(pathToFileURL(path.join(compiledDir('registry'), 'contract', 'index.js')).href);
  const opSk = rand();
  const contract = new module.Contract(registryWitnesses());
  const address: string = sampleContractAddress();
  const ps = { bono: { s: rand(), k: 0n, plan: Plan.free, validUntil: NO_EXPIRY }, j: 0n, opSk };
  const init = await contract.initialState(createConstructorContext(ps, COIN_PK), module.pureCircuits.operatorKey(opSk), rand(), 100n);
  let state = init.currentContractState.data;
  return {
    module,
    address,
    opSk,
    ctx: ctxOf(address),
    /** Current contract state (on chain, `ContractState.data`). */
    state: () => state,
    /** The operator issues the leaf for that id with that plan. */
    async issue(id: Uint8Array, plan: Plan): Promise<void> {
      const cx = createCircuitContext({
        circuitId: 'issueBono', contractAddress: address, coinPublicKeyOrZswapState: COIN_PK, contractState: state, privateState: ps,
      } as any);
      state = (await contract.impureCircuits.issueBono(cx, id, plan)).context.callContext.currentQueryContext.state;
    },
  };
}
