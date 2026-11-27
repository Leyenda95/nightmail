// Wires the payer (payer.ts) to the operator wallet and the real chain. No logic of its own: decisions
// live in payer.ts (unit-tested) and chain/midnight.ts; this glue is exercised on devnet
// (test-devnet/payer.devnet.ts).
import { NO_EXPIRY, Plan } from '@nightmail/midnight';
import { Transaction } from '@midnightntwrk/ledger-v9';
import { guaranteedOnly, relayProblem } from '../chain/relayable.ts';
import { readRegistryAddress, type ServerConfig } from '../config.ts';
import { openChain, type Chain } from '../chain/midnight.ts';
import { hasBonoLeaf, registryWitnesses, type RegistryPrivateState } from '../chain/registry.ts';
import type { OperatorWallet } from '../wallet/operatorWallet.ts';
import { loadOrCreateSecret } from '../wallet/storage.ts';
import { InvalidTransactionError, type PayerLog, type PayerPorts, type RegistryPort } from './payer.ts';

/** The data dir doesn't match the chain (operator key, contract); restarting won't fix it. */
export class PayerConfigError extends Error {}

const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

/** A client transaction as the wallet adopts it ('Unbound', wallet-sdk-facade 5.0.1); InvalidTransactionError if it is not one. */
function unbound(tx: Uint8Array) {
  try {
    return Transaction.deserialize('signature', 'proof', 'pre-binding', tx);
  } catch {
    throw new InvalidTransactionError('not an unbound transaction of the current protocol version');
  }
}

/**
 * The registry deployed on this network (contracts.json), with the operator key (`operator-sk`) used to
 * prove issueBono. null if nothing is deployed yet: the payer then only relays.
 */
export async function openRegistry(
  config: Pick<ServerConfig, 'network' | 'dataDir'>, chain: Pick<Chain, 'contract' | 'indexedTime'>, log: PayerLog,
): Promise<RegistryPort | null> {
  let address: string;
  try {
    address = readRegistryAddress(config);
  } catch (e) {
    log.info(`issue is disabled: ${e instanceof Error ? e.message : 'no deployed registry'}`);
    return null;
  }
  // Never created here: the deployment creates the operator key and commits it to the contract.
  const opSk = new Uint8Array(loadOrCreateSecret(config.dataDir, 'operator-sk', () => {
    throw new PayerConfigError(`operator-sk is missing in ${config.dataDir} (the deployment creates it)`);
  }).value);
  const registry = await chain.contract('registry', registryWitnesses());
  if (!(await registry.exists(address))) throw new PayerConfigError(`contracts.json is stale: no registry at ${address} on ${config.network}`);
  if (!sameBytes(registry.module.pureCircuits.operatorKey(opSk), (await registry.ledgerState(address)).operatorPk)) {
    throw new PayerConfigError('operator-sk is not the operator key of the deployed registry');
  }
  // issueBono only reads operatorSecret; the other witnesses are never called.
  const privateState: RegistryPrivateState = {
    bono: { s: new Uint8Array(32), k: 0n, plan: Plan.free, validUntil: NO_EXPIRY }, j: 0n, opSk,
  };
  return {
    address,
    prepare: (circuit, args) => registry.prepare(address, circuit, privateState, args),
    hasLeaves: async (leaves) => {
      const { data } = await registry.state(address);
      return leaves.map((leaf) => hasBonoLeaf(data, leaf));
    },
    indexedTime: () => chain.indexedTime(),
  };
}

/** Payer ports over an already synced wallet. `close` stops following the wallet state. */
export async function openPayerPorts(config: ServerConfig, wallet: OperatorWallet, log: PayerLog): Promise<PayerPorts & { close(): void }> {
  const chain = await openChain(config, wallet);
  let last = await wallet.facade.waitForSyncedState();
  const following = wallet.facade.state().subscribe({ next: (state) => { last = state; }, error: () => {} });
  return {
    status: () => ({ synced: last.isSynced, dustCoins: last.dust.availableCoins.length, dustBalance: last.dust.balance(new Date()) }),
    screen: (tx) => relayProblem(unbound(tx)),
    guaranteedOnly: (tx) => guaranteedOnly(unbound(tx)),
    estimateFee: async (tx) => {
      let handle;
      try {
        handle = wallet.facade.adoptTransaction(tx, 'Unbound');
      } catch {
        throw new InvalidTransactionError('not an unbound transaction of the current protocol version');
      }
      return wallet.facade.estimateTransactionFee(handle);
    },
    send: (tx, beforeSubmit, onInBlock) => chain.send(tx, beforeSubmit, onInBlock),
    registry: await openRegistry(config, chain, log),
    close: () => following.unsubscribe(),
  };
}
