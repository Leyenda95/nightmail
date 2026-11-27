// The compiled NightMailRegistry contract (contracts/managed/registry, `npm run compile -w contracts`).
// Hashes that must match the chain are always computed with its pure circuits, never reimplemented.
import { fileURLToPath } from 'node:url';

export {
  Contract, Kind, Plan, ledger, pureCircuits,
  type AddressRecord as ContractAddressRecord, type Ledger, type Witnesses,
} from '@nightmail/contracts/managed/registry/contract/index.js';

/**
 * Compiled contract folder (`contract/`, `keys/`, `zkir/`) with a trailing slash. Needed to build and
 * prove calls, since the proving and verifier keys are read from there.
 */
export const REGISTRY_DIR = fileURLToPath(new URL('../', import.meta.resolve('@nightmail/contracts/managed/registry/contract/index.js')));
