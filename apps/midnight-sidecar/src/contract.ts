// `contract.*` methods of the sidecar over NightMailRegistry. The logic (hashes via the compiled contract's pure
// circuits, mailbox names, state reading) lives in @nightmail/midnight, shared with the server; this file only
// validates parameters, maps to the protocol and talks to the indexer through net.ts.
import {
  addrKey, aliasAddrKey, aliasAddress, bonoPositions, type CallStates, commit, ctx, fetchCallStates, fetchRegistry, fromHex,
  type GraphQL, idK, IndexerError, IndexerUnavailable, InvalidInput, Kind, leaf, mailboxName, NameRejected,
  NotRegistryState, page, Plan, readJsonCapped, type RegistryAt, slotNul, toHex, uint,
} from '@nightmail/midnight';
import { AppError, codes } from './codes.ts';
import { net } from './net.ts';
import type { Handler } from './rpc.ts';
import type { ContractFindBonosResult } from './protocol/ContractFindBonosResult.ts';
import type { ContractHashesResult } from './protocol/ContractHashesResult.ts';
import type { ContractSnapshot } from './protocol/ContractSnapshot.ts';
import type { SnapshotCursor } from './protocol/SnapshotCursor.ts';
import type { StaleProblem } from './protocol/StaleProblem.ts';
import type { StaleStateData } from './protocol/StaleStateData.ts';

export const MAX_HASH_OPS = 1024;
export const MAX_FIND_LEAVES = 1024;
export const DEFAULT_SNAPSHOT_LIMIT = 1000;
export const MAX_SNAPSHOT_LIMIT = 10_000;
/** Cap on an indexer response (the whole contract state travels in it). */
export const MAX_INDEXER_RESPONSE_BYTES = 128 * 1024 * 1024;
const INDEXER_TIMEOUT_MS = 30_000;


export type Params = Record<string, unknown>;

export const isObject = (v: unknown): v is Params => typeof v === 'object' && v !== null && !Array.isArray(v);
export const invalid = () => new AppError(codes.INVALID_PARAMS, 'Invalid params');

export const b32 = (v: unknown, what: string) => fromHex(v, 32, what);
export const text = (v: unknown, what: string): string => {
  if (typeof v !== 'string') throw new InvalidInput(`${what}: expected a string`);
  return v;
};
export const PLANS: Record<string, Plan> = { free: Plan.free, paid: Plan.paid };
const KINDS: Record<string, Kind> = { mailbox: Kind.mailbox, alias: Kind.alias };
export function oneOf<T>(table: Record<string, T>, v: unknown, what: string): T {
  if (typeof v !== 'string' || !Object.hasOwn(table, v)) throw new InvalidInput(`${what}: unknown value`);
  return table[v];
}

/** Each `contract.hashes` operation (HashOp) with its ctx already computed. */
const HASH_OPS: Record<string, (o: Params, c: Uint8Array) => string> = {
  idK: (o, c) => toHex(idK(c, b32(o.s, 's'), uint(o.k, 32, 'k'))),
  leaf: (o, c) => toHex(leaf(c, b32(o.id, 'id'), oneOf(PLANS, o.plan, 'plan'), uint(o.validUntil, 32, 'validUntil'))),
  slotNul: (o, c) => toHex(slotNul(c, b32(o.s, 's'), oneOf(KINDS, o.kind, 'kind'), uint(o.j, 8, 'j'), uint(o.gen, 32, 'gen'))),
  // Both apply the mailbox name rules (normalisation, alias form, reserved names).
  normalizeName: (o) => mailboxName(text(o.name, 'name')),
  addrKey: (o) => toHex(addrKey(text(o.name, 'name'))),
  aliasAddrKey: (o) => toHex(aliasAddrKey(b32(o.encPk, 'encPk'), b32(o.authPk, 'authPk'), b32(o.slotNul, 'slotNul'))),
  commit: (o) => toHex(commit(b32(o.addrKey, 'addrKey'), b32(o.encPk, 'encPk'), b32(o.authPk, 'authPk'),
    b32(o.salt, 'salt'), b32(o.slotNul, 'slotNul'))),
  aliasAddress: (o) => aliasAddress(b32(o.addrKey, 'addrKey')),
};

function runHashOp(op: unknown, c: Uint8Array): string {
  if (!isObject(op) || typeof op.op !== 'string' || !Object.hasOwn(HASH_OPS, op.op)) throw invalid();
  return HASH_OPS[op.op](op, c);
}

/** @nightmail/midnight errors to public codes with a fixed message. Anything else is an internal error. */
function publicError(e: unknown): unknown {
  if (e instanceof NameRejected) return new AppError(codes.NAME_REJECTED, 'Name rejected', { reason: e.problem });
  if (e instanceof NotRegistryState) return new AppError(codes.CONTRACT_NOT_FOUND, 'Contract not found');
  if (e instanceof InvalidInput) return invalid();
  if (e instanceof IndexerUnavailable) return new AppError(codes.UPSTREAM_UNAVAILABLE, 'Indexer unavailable');
  return e;
}

export async function publicErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    throw publicError(e);
  }
}

function hashes(params: unknown): ContractHashesResult {
  if (!isObject(params) || !Array.isArray(params.ops)) throw invalid();
  if (params.ops.length === 0 || params.ops.length > MAX_HASH_OPS) throw invalid();
  const c = ctx(text(params.contractAddress, 'contractAddress'));
  return { ctx: toHex(c), results: params.ops.map((op) => runHashOp(op, c)) };
}

// --- contract.snapshot ----------------------------------------------------------------------------

type Offsets = Pick<SnapshotCursor, 'slotNullifiers' | 'addresses' | 'pendingNames'>;
const FIRST_PAGE: Offsets = { slotNullifiers: 0, addresses: 0, pendingNames: 0 };

const isCount = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const isOffset = (v: unknown) => v === null || isCount(v);

/** Height and offsets of the requested page. No cursor: the first page, at the latest block. */
function parseCursor(v: unknown): { height: number | undefined; at: Offsets } {
  if (v === undefined || v === null) return { height: undefined, at: FIRST_PAGE };
  if (!isObject(v) || !isCount(v.blockHeight)) throw invalid();
  if (![v.slotNullifiers, v.addresses, v.pendingNames].every(isOffset)) throw invalid();
  return { height: v.blockHeight as number, at: v as Offsets };
}

function parseLimit(v: unknown): number {
  if (v === undefined || v === null) return DEFAULT_SNAPSHOT_LIMIT;
  if (!Number.isSafeInteger(v) || (v as number) < 1 || (v as number) > MAX_SNAPSHOT_LIMIT) throw invalid();
  return v as number;
}

const KIND_NAMES = { [Kind.mailbox]: 'mailbox', [Kind.alias]: 'alias' } as const;

/** A slice of a collection; a collection that is already complete (offset null) yields nothing more. */
const slice = <T>(items: readonly T[], offset: number | null, limit: number) =>
  offset === null ? { items: [], next: null } : page(items, offset, limit);

/** Protocol page built from the state read with @nightmail/midnight. */
export function snapshotPage(state: RegistryAt, at: Offsets, limit: number): ContractSnapshot {
  const { blockHeight, snapshot: s } = state;
  const nuls = slice(s.slotNullifiers, at.slotNullifiers, limit);
  const addresses = slice(s.addresses, at.addresses, limit);
  const pending = slice(s.pendingNames, at.pendingNames, limit);
  const more = nuls.next !== null || addresses.next !== null || pending.next !== null;
  return {
    blockHeight,
    blockHash: state.blockHash,
    blockTimestamp: state.blockTimestamp,
    round: s.round.toString(),
    price: s.price.toString(),
    oldPrices: s.oldPrices.map((p) => ({ price: p.price.toString(), until: p.until.toString() })),
    bonos: { leafCount: Number(s.bonos.leafCount), root: s.bonos.root.toString() },
    totals: { slotNullifiers: s.slotNullifiers.length, addresses: s.addresses.length, pendingNames: s.pendingNames.length },
    slotNullifiers: nuls.items,
    addresses: addresses.items.map((a) => ({ ...a, kind: KIND_NAMES[a.kind] })),
    pendingNames: pending.items.map((p) => ({ ...p, reservedRound: p.reservedRound.toString() })),
    next: more ? { blockHeight, slotNullifiers: nuls.next, addresses: addresses.next, pendingNames: pending.next } : null,
  };
}

/**
 * GraphQL against the indexer, only through net.ts. Network errors, timeouts, 429 and 5xx map to IndexerUnavailable;
 * any other response that cannot be understood (4xx, oversized, invalid JSON) maps to IndexerError. If the core
 * cancels the request, the error is rethrown as is and rpc.ts replies `Cancelled`.
 */
export function indexerGql(url: string, signal: AbortSignal, maxBytes: number): GraphQL {
  return async (query, variables) => {
    try {
      const res = await net.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(INDEXER_TIMEOUT_MS)]),
      });
      if (res.status >= 500 || res.status === 429) throw new IndexerUnavailable(`indexer: HTTP ${res.status}`);
      if (!res.ok) throw new IndexerError(`indexer: HTTP ${res.status}`);
      return await readJsonCapped(res, maxBytes);
    } catch (e) {
      if (signal.aborted || e instanceof IndexerError || e instanceof IndexerUnavailable) throw e;
      throw new IndexerUnavailable('indexer: unreachable');
    }
  };
}

export type ContractHandlerOptions = {
  maxIndexerResponseBytes?: number;
  /** Debug log (stderr, debug builds only): never receives secrets. */
  log?: (message: string) => void;
};

type Snapshotted = { url: string; address: string; state: RegistryAt };

/**
 * `contract.snapshot`. Later pages read the state of the first one (same height, indexer and contract), which
 * is kept here. If it is gone (another traversal in between, the sidecar restarted), the core starts over.
 */
function snapshotHandler(indexerUrl: () => string, maxBytes: number, log: (message: string) => void): Handler {
  let last: Snapshotted | undefined;
  return async (params, { signal }) => publicErrors(async () => {
    const url = indexerUrl();
    if (!isObject(params)) throw invalid();
    const address = contractAddress(params);
    const { height, at } = parseCursor(params.cursor);
    const limit = parseLimit(params.limit);
    if (height !== undefined) {
      if (last?.url !== url || last.address !== address || last.state.blockHeight !== height) {
        throw new AppError(codes.SNAPSHOT_EXPIRED, 'Snapshot expired');
      }
      return snapshotPage(last.state, at, limit);
    }
    const state = await fetchRegistry(indexerGql(url, signal, maxBytes), address);
    if (!state) throw new AppError(codes.CONTRACT_NOT_FOUND, 'Contract not found');
    log(`contract.snapshot: state of ${state.stateBytes} bytes at block ${state.blockHeight}`);
    last = { url, address, state };
    return snapshotPage(state, at, limit);
  });
}

/** Contract address from the parameters (32-byte hex), unchanged. */
export function contractAddress(params: Params): string {
  const address = text(params.contractAddress, 'contractAddress');
  fromHex(address, 32, 'contractAddress');
  return address;
}

/** The contract at the indexer's latest block, to search it or run a circuit; CONTRACT_NOT_FOUND if there is none. */
export async function latestStates(gql: GraphQL, address: string): Promise<CallStates> {
  const states = await fetchCallStates(gql, address);
  if (!states) throw new AppError(codes.CONTRACT_NOT_FOUND, 'Contract not found');
  return states;
}

// --- contract.findBonos ---------------------------------------------------------------------------

/**
 * `contract.findBonos`. The leaf to position index is rebuilt on every call from the latest block's state
 * (never stored: a position is only valid together with that state's root). The requested leaves never leave
 * the sidecar: the whole state is downloaded and searched locally.
 */
async function findBonos(params: unknown, gql: GraphQL): Promise<ContractFindBonosResult> {
  if (!isObject(params) || !Array.isArray(params.leaves)) throw invalid();
  if (params.leaves.length === 0 || params.leaves.length > MAX_FIND_LEAVES) throw invalid();
  const leaves = params.leaves.map((l) => toHex(b32(l, 'leaf')));
  const minLeafCount = minLeafCountOf(params);
  const states = await latestStates(gql, contractAddress(params));
  const { positions, leafCount } = bonoPositions(states.state);
  requireLeaves(leafCount, minLeafCount, states.blockTimestamp);
  return { blockHeight: states.blockHeight, leafCount, positions: leaves.map((l) => positions.get(l) ?? null) };
}

// --- Unusable state (STALE_STATE) ---------------------------------------------------------------

/**
 * STALE_STATE with the reason and the block's age (local clock minus block time, in ms); with `behind`,
 * also the leaves of the tree that was read.
 */
export function staleState(reason: StaleProblem, ageMs: number, leafCount?: number): AppError {
  const data: StaleStateData = leafCount === undefined ? { reason, ageMs } : { reason, ageMs, leafCount };
  return new AppError(codes.STALE_STATE, 'Stale chain state', data);
}

/** Optional `minLeafCount` (Uint32): the largest `leafCount` the core has seen; 0 if absent. */
export function minLeafCountOf(params: Params): number {
  const value = params.minLeafCount;
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0xffff_ffff) throw invalid();
  return value as number;
}

/**
 * The bonos tree only grows. With fewer leaves than the core has already seen, the indexer is lagging or
 * trimming leaves (to hide a bono from retries): STALE_STATE behind.
 */
export function requireLeaves(leafCount: number, minLeafCount: number, blockTimestamp: number): void {
  if (leafCount < minLeafCount) throw staleState('behind', Date.now() - blockTimestamp, leafCount);
}

export function contractHandlers(
  indexerUrl: () => string,
  { maxIndexerResponseBytes = MAX_INDEXER_RESPONSE_BYTES, log = () => {} }: ContractHandlerOptions = {},
): Record<string, Handler> {
  return {
    'contract.hashes': async (params) => publicErrors(async () => {
      indexerUrl(); // requires initialize, like every method
      return hashes(params);
    }),
    'contract.snapshot': snapshotHandler(indexerUrl, maxIndexerResponseBytes, log),
    'contract.findBonos': async (params, { signal }) =>
      publicErrors(async () => findBonos(params, indexerGql(indexerUrl(), signal, maxIndexerResponseBytes))),
  };
}
