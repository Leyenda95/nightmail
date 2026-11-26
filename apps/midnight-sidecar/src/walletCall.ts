// A contract call paid for by the embedded wallet (the TestToken faucet and `buyBono`): read the latest block's state,
// build the call (unprovenCall, the same one as contract.proveCall), prove it on the local proof server, then balance
// (pay), sign and finalize. It does not submit: the caller decides what to record first (buyBono.ts keeps a purchase journal).
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { type CallStates, uint } from '@nightmail/midnight';
import { indexerGql, invalid, latestStates, MAX_INDEXER_RESPONSE_BYTES } from './contract.ts';
import { callTtl, NO_WALLET_KEY, requireFresh, stage, unprovenCall } from './prove.ts';
import { proveTransaction } from './prover.ts';
import type { HandlerContext } from './rpc.ts';
import type { InitializeParams } from './protocol/InitializeParams.ts';
import { type OpenWallet, payFor, syncedState } from './wallet.ts';

/** Amount in base units (Uint<64> in decimal, > 0). */
export function amountOf(value: unknown): bigint {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value)) throw invalid();
  return uint(BigInt(value), 64, 'amount');
}

/** A compiled contract (folder with `contract/`, `keys/` and `zkir/`) ready to call. */
export type Compiled = { compiled: unknown; zk: NodeZkConfigProvider<string> };

export function compiledAt(name: string, dir: string, module: { Contract: new (witnesses: never) => unknown }, witnesses = {}): Compiled {
  return {
    compiled: CompiledContract.make<never>(name, module.Contract as never).pipe(
      CompiledContract.withWitnesses(witnesses as never),
      CompiledContract.withCompiledFileAssets(dir),
    ),
    zk: new NodeZkConfigProvider<string>(dir),
  };
}

export type WalletCall = {
  address: string;
  contract: Compiled;
  circuit: string;
  /** The circuit arguments, or how to derive them from the state read. */
  args: unknown[] | ((states: CallStates) => unknown[]);
  privateState?: unknown;
  kinds: ('dust' | 'shielded')[];
  /**
   * Build with the wallet's keys? Only needed when the circuit creates a coin for the caller (the faucet:
   * `ownPublicKey()`). Otherwise (buyBono: the only output is the contract's) they are zeroed, as in contract.proveCall.
   */
  walletKeys?: boolean;
  /** Checks on the state read before building (e.g. the circuit's verifier key). */
  check?: (states: CallStates) => void;
};

/** What to submit, the state it was built against and until when it can enter a block. */
export type Paid = { finalized: Awaited<ReturnType<typeof payFor>>; states: CallStates; ttl: Date };

async function keysOf(wallet: OpenWallet, useWallet: boolean) {
  const s = await syncedState(wallet);
  if (!useWallet) return { coinPublicKey: NO_WALLET_KEY, encryptionPublicKey: NO_WALLET_KEY };
  return { coinPublicKey: s.shielded.coinPublicKey.toHexString(), encryptionPublicKey: s.shielded.encryptionPublicKey.toHexString() };
}

export async function buildAndPay(wallet: OpenWallet, init: InitializeParams, context: HandlerContext, call: WalletCall): Promise<Paid> {
  const keys = await keysOf(wallet, call.walletKeys ?? true); // also requires the wallet to be synced
  stage(context, 'reading-state');
  const states = await latestStates(indexerGql(init.endpoints.indexer, context.signal, MAX_INDEXER_RESPONSE_BYTES), call.address);
  requireFresh(states.blockTimestamp);
  call.check?.(states);
  stage(context, 'building');
  const ttl = callTtl(states.blockTimestamp);
  const args = typeof call.args === 'function' ? call.args(states) : call.args;
  const unproven = await unprovenCall(init.network, {
    contract: call.contract, address: call.address, circuit: call.circuit, args, privateState: call.privateState, ...keys,
  }, states, ttl);
  stage(context, 'proving');
  const proven = await proveTransaction(unproven, call.contract.zk, { origin: init.endpoints.proofServer, signal: context.signal, log: () => {} });
  stage(context, 'paying');
  return { finalized: await payFor(wallet, proven, call.kinds, ttl), states, ttl };
}
