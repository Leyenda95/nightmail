// `contract.proveCall`: builds and proves a call to NightMailRegistry (reserveMailbox, revealMailbox or
// createAlias) and returns the proven, unbalanced transaction, which the core sends to the relayer.
//
// - No wallet: the call is built with `createUnprovenCallTxFromInitialStates` from the state read from the
//   indexer through net.ts. The coin and encryption keys midnight-js asks for are zeros: these circuits neither
//   create nor spend coins, so they do not appear in the transaction (checked with a marked key), and being the
//   same for everyone they reveal nothing about the prover.
// - The Merkle path is neither stored nor received. Each call reads the latest block's state, and the leaf to
//   position index, the path and the local execution all come from that same state.
// - Freshness: no proving against a state older than MAX_STATE_AGE_MS, nor with a block more than
//   MAX_CLOCK_BEHIND_MS ahead of the local clock, nor with fewer bono leaves than the core has already seen
//   (`minLeafCount`): STALE_STATE with the reason.
// - With a usable state, the on-chain verifier key of the circuit must be the app's (otherwise CONTRACT_MISMATCH).
// - Retries (gas margin): if the node rejects the transaction on cost, or is slow, the core asks for another
//   proveCall (fresh path and proof). Nothing is retried here.
// - Witnesses live only during the call: they are neither stored nor logged. What we own is wiped at the end (the
//   decoded parameter bytes, and the preimage and payload sent to the proof server, see prover.ts). Copies we do
//   not control remain until the GC collects them: the parameter strings (owned by the JavaScript engine), the
//   SDK's (private transcript outputs, the tx), wasm memory and fetch's internal buffer.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { createUnprovenCallTxFromInitialStates } from '@midnight-ntwrk/midnight-js-contracts';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import {
  SerializedContractState, SerializedLedgerParameters, SerializedZswapChainState,
} from '@midnight-ntwrk/midnight-js-types';
import { Transaction } from '@midnightntwrk/ledger-v9';
import {
  bonoPositions, type CallStates, Contract, ctx, fromHex, idK, leaf, nameBytes, type Plan, REGISTRY_DIR, toHex, uint,
  type Witnesses,
} from '@nightmail/midnight';
import { AppError, codes } from './codes.ts';
import {
  b32, type ContractHandlerOptions, contractAddress, indexerGql, invalid, isObject, latestStates, MAX_INDEXER_RESPONSE_BYTES,
  minLeafCountOf, oneOf, type Params, PLANS, publicErrors, requireLeaves, staleState, text,
} from './contract.ts';
import { proveTransaction } from './prover.ts';
import type { Handler, HandlerContext } from './rpc.ts';
import type { CallProblem } from './protocol/CallProblem.ts';
import type { ContractProveCallResult } from './protocol/ContractProveCallResult.ts';
import type { InitializeParams } from './protocol/InitializeParams.ts';

/**
 * Maximum age (block time against the local clock) of the state a proof is built against. The indexer
 * follows finalized blocks: about 20 s behind the head on the devnet.
 */
export const MAX_STATE_AGE_MS = 120_000;
/**
 * How far ahead of the local clock the block may be. More means a lagging machine clock (or a lying indexer),
 * and the block time is what fixes the TTL: STALE_STATE `future`.
 */
export const MAX_CLOCK_BEHIND_MS = 60_000;
/**
 * Transaction expiry: the time of the block that was read plus 30 min, rounded DOWN to TTL_QUANTUM_MS.
 * - It does not come from the local clock: midnight-js computes it as "now + ttlSeconds", which would publish the
 *   prover's clock (a constant offset would let transactions be linked) and how long execution took.
 * - Rounded, so it does not reveal the exact block that was read (every transaction in the same 10-min slot
 *   carries the same value), which would defeat the relayer's random delay. Rounded down to land between 20 and
 *   30 min: the relayer accepts no more than 35 min ahead (TTL_MAX_AHEAD_MS in apps/server/src/relayer/validate.ts).
 * It is set on the intent before proving (the ttl is writable until the transaction is bound).
 */
export const CALL_TTL_MS = 30 * 60_000;
export const TTL_QUANTUM_MS = 10 * 60_000;
export const callTtl = (blockTimestamp: number): Date =>
  new Date(Math.floor((blockTimestamp + CALL_TTL_MS) / TTL_QUANTUM_MS) * TTL_QUANTUM_MS);

/** Coin and encryption key of a wallet-less call (see above). */
export const NO_WALLET_KEY = '0'.repeat(64);

// --- Parameters ---------------------------------------------------------------------------------

/** Witnesses of the membership proof: leaf `k` of bono `s` and the slot `j` being spent. */
type Bono = { s: Uint8Array; k: bigint; plan: Plan; validUntil: bigint; j: bigint };
/**
 * A validated call: the arguments in circuit order, the bono if it spends a slot and the core's
 * `minLeafCount` (0 if absent).
 */
type Call = { args: unknown[]; bono?: Bono; minLeafCount: number };

/**
 * Byte decoders that record everything they decode in `seen`, so it can be wiped at the end even if a later
 * parameter is invalid (the already decoded bono secret must not stay in memory).
 */
function decoders(seen: Uint8Array[]) {
  const keep = (bytes: Uint8Array) => (seen.push(bytes), bytes);
  return {
    b32: (v: unknown, what: string) => keep(b32(v, what)),
    hex: (v: unknown, length: number, what: string) => keep(fromHex(v, length, what)),
    name: (v: unknown) => keep(nameBytes(text(v, 'name'))),
  };
}
type Decoders = ReturnType<typeof decoders>;

function bonoOf(witnesses: unknown, d: Decoders): Bono {
  if (!isObject(witnesses)) throw invalid();
  return {
    s: d.b32(witnesses.s, 's'),
    k: uint(witnesses.k, 32, 'k'),
    plan: oneOf(PLANS, witnesses.plan, 'plan'),
    validUntil: uint(witnesses.validUntil, 32, 'validUntil'),
    j: uint(witnesses.j, 8, 'j'),
  };
}

/**
 * reserveMailbox round: Uint<64> in decimal, without the maximum (the contract computes `r + 1`, and with the
 * maximum the sum overflows and the reservation could never be revealed).
 */
function roundOf(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,19})$/.test(value)) throw invalid();
  return uint(BigInt(value) + 1n, 64, 'round') - 1n;
}

/** The circuits proven without a wallet, with their arguments in contract order. */
const CIRCUITS: Record<string, (args: Params, witnesses: unknown, d: Decoders) => Omit<Call, 'minLeafCount'>> = {
  reserveMailbox: (a, w, d) => ({ args: [d.b32(a.commit, 'commit'), roundOf(a.round)], bono: bonoOf(w, d) }),
  revealMailbox: (a, _w, d) => ({
    args: [d.name(a.name), d.b32(a.encPk, 'encPk'), d.b32(a.authPk, 'authPk'), d.b32(a.salt, 'salt'),
      d.b32(a.slotNul, 'slotNul'), d.hex(a.nameCipher, 104, 'nameCipher')],
  }),
  createAlias: (a, w, d) => ({ args: [d.b32(a.encPk, 'encPk'), d.b32(a.authPk, 'authPk')], bono: bonoOf(w, d) }),
};

/** The validated call; the bytes it decodes end up in `seen` (even if it throws midway). */
function parseCall(params: unknown, seen: Uint8Array[]): { address: string; circuit: string; call: Call } {
  if (!isObject(params) || typeof params.circuit !== 'string' || !Object.hasOwn(CIRCUITS, params.circuit)) throw invalid();
  if (!isObject(params.args)) throw invalid();
  const address = contractAddress(params);
  const minLeafCount = minLeafCountOf(params);
  return { address, circuit: params.circuit, call: { ...CIRCUITS[params.circuit](params.args, params.witnesses, decoders(seen)), minLeafCount } };
}

/** Wipes the bytes of the arguments and witnesses (public ones too: no need to tell them apart). */
function wipe(seen: Uint8Array[]): void {
  for (const bytes of seen) bytes.fill(0);
}

// --- The contract ------------------------------------------------------------------------------------

/** Private state of a call: the bono and the position of its leaf in the tree of the state read. */
type PrivateState = { bono: Bono; position: bigint } | undefined;

// Only called by a circuit that spends a slot, in which case there is a bono (see `build`).
const bono = (p: PrivateState): Bono => p!.bono;
export const witnesses: Witnesses<PrivateState> = {
  bonoSecret: ({ privateState: p }) => [p, bono(p).s],
  bonoLeafIndex: ({ privateState: p }) => [p, bono(p).k],
  bonoPlan: ({ privateState: p }) => [p, bono(p).plan],
  bonoValidUntil: ({ privateState: p }) => [p, bono(p).validUntil],
  slotIndex: ({ privateState: p }) => [p, bono(p).j],
  // The path is computed against the tree of the state the circuit runs on: it never comes from outside.
  bonoPath: ({ privateState: p, ledger }, leafOfBono) => [p, ledger.bonos.pathForLeaf(p!.position, leafOfBono)],
  operatorSecret: () => {
    throw new Error('operatorSecret: the sidecar never acts as the operator');
  },
};

const zk = new NodeZkConfigProvider<string>(REGISTRY_DIR);
const compiled = CompiledContract.make<Contract<PrivateState>>('registry', Contract).pipe(
  CompiledContract.withWitnesses(witnesses as never),
  CompiledContract.withCompiledFileAssets(REGISTRY_DIR),
);
/** The compiled registry (built once): wallet.buyBono uses it too, without witnesses. */
export const registryContract = { compiled: compiled as unknown, zk };

/** A call to build: compiled contract, circuit, arguments and keys (coin and encryption, in hex). */
export type CallSpec = {
  contract: { compiled: unknown; zk: NodeZkConfigProvider<string> };
  address: string;
  circuit: string;
  args: unknown[];
  coinPublicKey: string;
  encryptionPublicKey: string;
  privateState?: unknown;
};

/**
 * Runs the circuit locally against that state (no wallet or providers: the state read from the indexer) and returns
 * the unproven transaction with the TTL already set on its intents. A failing contract assert is CALL_REJECTED.
 */
export async function unprovenCall(network: string, spec: CallSpec, states: CallStates, ttl: Date) {
  const options = {
    compiledContract: spec.contract.compiled,
    contractAddress: spec.address,
    circuitId: spec.circuit,
    args: spec.args,
    coinPublicKey: spec.coinPublicKey,
    initialContractState: SerializedContractState.fromBytes('v9', states.state.serialize()),
    initialZswapChainState: SerializedZswapChainState.fromBytes('v9', bytes(states.zswapState)),
    ledgerParameters: SerializedLedgerParameters.fromBytes('v9', bytes(states.ledgerParameters)),
    // Whatever ttl midnight-js computes does not matter: withTtl overwrites it.
    config: { networkId: network, ttlSeconds: CALL_TTL_MS / 1000 },
    initialPrivateState: spec.privateState,
  };
  let built;
  try {
    built = await createUnprovenCallTxFromInitialStates(spec.contract.zk, options as never, spec.encryptionPublicKey);
  } catch (e) {
    throw rejectionOf(e) ?? e;
  }
  return withTtl(built.private.unprovenTx.deserialize({ v9: Transaction }), ttl);
}

/** Reason for each NightMailRegistry assert that can fail in these circuits. */
const PROBLEMS: Record<string, CallProblem> = {
  'Not a bono': 'not-a-bono',
  'No slots left': 'no-slots-left',
  'Slot already used': 'slot-already-used',
  'Stale round': 'stale-round',
  'Not reserved': 'not-reserved',
  'Wrong reveal': 'wrong-reveal',
  'Too early': 'too-early',
  'Address taken': 'address-taken',
  // buyBono (wallet.buyBono)
  'Wrong token': 'wrong-token',
  'Wrong amount': 'wrong-amount',
  'Old price expired': 'old-price-expired',
};

const rejected = (reason: CallProblem) => new AppError(codes.CALL_REJECTED, 'Call rejected', { reason });

/** CALL_REJECTED if the error is a contract assert that failed while running the circuit locally. */
export function rejectionOf(error: unknown): AppError | undefined {
  const failedAssert = error instanceof Error ? /^failed assert: (.*)$/.exec(error.message) : null;
  if (!failedAssert) return undefined;
  return rejected(Object.hasOwn(PROBLEMS, failedAssert[1]) ? PROBLEMS[failedAssert[1]] : 'other');
}

/** Position of the bono's leaf in the tree (leaf to position index); if absent, it is not a bono (yet). */
function positionOf(b: Bono, address: string, positions: Map<string, number>): bigint {
  const c = ctx(address);
  const position = positions.get(toHex(leaf(c, idK(c, b.s, b.k), b.plan, b.validUntil)));
  if (position === undefined) throw rejected('not-a-bono');
  return BigInt(position);
}

export const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));

/**
 * The app's verifier keys (those of the compiled contract), per circuit. Copied out of the Buffer pool
 * (a 2 KB readFileSync gives a view of a shared block, which would be retained forever).
 */
const localKeys = new Map<string, Buffer>();
const localVerifierKey = (circuit: string): Buffer => {
  if (!localKeys.has(circuit)) {
    // Buffer over the copy's own ArrayBuffer: Buffer.from(Uint8Array) would copy into the pool again.
    localKeys.set(circuit, Buffer.from(new Uint8Array(readFileSync(path.join(REGISTRY_DIR, 'keys', `${circuit}.verifier`))).buffer));
  }
  return localKeys.get(circuit)!;
};

/**
 * The verifier key of the circuit in the deployed contract must be the app's, otherwise the proof would be
 * useless (the node would reject it). The app and the contract differ, in either direction (operator
 * maintenance, app released before the contract...).
 */
export function requireSameCircuit(states: CallStates, circuit: string): void {
  const onChain = states.state.operation(circuit)?.verifierKey;
  if (onChain === undefined || !localVerifierKey(circuit).equals(onChain)) {
    throw new AppError(codes.CONTRACT_MISMATCH, 'Contract version mismatch');
  }
}

/** Runs the circuit locally against that state and returns the unproven transaction. */
async function build(network: string, address: string, circuit: string, call: Call, states: CallStates) {
  // The index is always read: if the state is not a NightMailRegistry's, it fails here (CONTRACT_NOT_FOUND).
  const { positions, leafCount } = bonoPositions(states.state);
  // Check for a lagging state first: its verifier key says nothing then (a replica from before a
  // maintenance would give CONTRACT_MISMATCH, which is terminal, instead of the retryable behind).
  requireLeaves(leafCount, call.minLeafCount, states.blockTimestamp);
  requireSameCircuit(states, circuit);
  const privateState: PrivateState = call.bono && { bono: call.bono, position: positionOf(call.bono, address, positions) };
  const spec: CallSpec = {
    contract: registryContract, address, circuit, args: call.args, coinPublicKey: NO_WALLET_KEY, encryptionPublicKey: NO_WALLET_KEY,
    privateState,
  };
  return unprovenCall(network, spec, states, callTtl(states.blockTimestamp));
}

/** Sets the ttl of each intent. `intents` returns a (wasm) copy: modify it and assign it back. */
export function withTtl<T extends { intents: Map<number, { ttl: Date }> | undefined }>(tx: T, ttl: Date): T {
  const intents = tx.intents!;
  for (const [segment, intent] of intents) {
    intent.ttl = ttl;
    intents.set(segment, intent);
  }
  tx.intents = intents;
  return tx;
}

// --- contract.proveCall -----------------------------------------------------------------------------

/** Tells the core which stage is starting; if it already cancelled, we stop here. */
export function stage(context: HandlerContext, name: string): void {
  context.signal.throwIfAborted();
  context.notify('progress', { requestId: context.requestId, stage: name, percent: null });
}

type Options = Required<ContractHandlerOptions>;

/** The state must be recent, and its block cannot be ahead of the local clock. */
export function requireFresh(blockTimestamp: number): void {
  const ageMs = Date.now() - blockTimestamp;
  if (ageMs > MAX_STATE_AGE_MS) throw staleState('old', ageMs);
  if (ageMs < -MAX_CLOCK_BEHIND_MS) throw staleState('future', ageMs);
}

async function proveCall(init: InitializeParams, params: unknown, context: HandlerContext, options: Options): Promise<ContractProveCallResult> {
  const seen: Uint8Array[] = [];
  try {
    const { address, circuit, call } = parseCall(params, seen);
    stage(context, 'reading-state');
    const states = await latestStates(indexerGql(init.endpoints.indexer, context.signal, options.maxIndexerResponseBytes), address);
    requireFresh(states.blockTimestamp);
    stage(context, 'building');
    const unproven = await build(init.network, address, circuit, call, states);
    stage(context, 'proving');
    const log = (message: string) => options.log(`contract.proveCall: ${message}`);
    const tx = await proveTransaction(unproven, zk, { origin: init.endpoints.proofServer, signal: context.signal, log });
    return { tx: toHex(tx), blockHeight: states.blockHeight };
  } finally {
    wipe(seen);
  }
}

export function proveHandlers(
  initialized: () => InitializeParams,
  { maxIndexerResponseBytes = MAX_INDEXER_RESPONSE_BYTES, log = () => {} }: ContractHandlerOptions = {},
): Record<string, Handler> {
  return {
    'contract.proveCall': async (params, context) =>
      publicErrors(async () => proveCall(initialized(), params, context, { maxIndexerResponseBytes, log })),
  };
}
