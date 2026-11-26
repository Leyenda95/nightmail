// NightMailRegistry state from the Midnight indexer (GraphQL v4). No networking of its own: the caller
// injects `gql`, which performs the request (the sidecar via net.ts, the server via its fetch) and
// returns the JSON response body (readJsonCapped helps read it with a size cap).
//
// State is pinned to a block height: without one, the latest height is fetched first and then the
// state at it (in a single query, `block` and `contract` without an offset could come from different
// blocks). This way every page of a snapshot reads the same state.
import { fromHex, InvalidInput } from './input.ts';
import type { ContractState } from '@midnight-ntwrk/compact-runtime';
import { decodeRegistry, decodeState, NotRegistryState, type RegistrySnapshot } from './snapshot.ts';

export type GraphQL = (query: string, variables: Record<string, unknown>) => Promise<unknown>;

/** The indexer returned something unusable (bad shape, height or state, or too large). */
export class IndexerError extends Error {}
/** The indexer is unavailable (network, timeout, 5xx or GraphQL errors). Retryable. */
export class IndexerUnavailable extends Error {}

/**
 * Registry state and its block (timestamp in Unix milliseconds). `stateBytes` is the size of the
 * serialized state from the indexer, logged to monitor its growth.
 */
export type RegistryAt = {
  blockHeight: number;
  blockHash: string;
  blockTimestamp: number;
  stateBytes: number;
  snapshot: RegistrySnapshot;
};

const LATEST = '{ block { height } }';
const STATE_AT = `query ($address: HexEncoded!, $offset: BlockOffset) {
  block(offset: $offset) { height hash timestamp }
  contract(address: $address, offset: $offset) { state }
}`;

type Block = { height?: unknown; hash?: unknown; timestamp?: unknown; ledgerParameters?: unknown; contractZswapState?: unknown };
type Body = { data?: { block?: Block | null; contract?: { state?: unknown } | null } | null; errors?: unknown };

async function ask(gql: GraphQL, query: string, variables: Record<string, unknown>): Promise<NonNullable<Body['data']>> {
  const body = (await gql(query, variables)) as Body | null;
  if (body?.errors !== undefined) throw new IndexerUnavailable('indexer: GraphQL errors');
  if (!body?.data) throw new IndexerError('indexer: no data');
  return body.data;
}

const count = (v: unknown, what: string): number => {
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw new IndexerError(`indexer: bad ${what}`);
  return v as number;
};

/** Height of the latest block the indexer has processed. */
export async function latestHeight(gql: GraphQL): Promise<number> {
  const data = await ask(gql, LATEST, {});
  if (!data.block) throw new IndexerError('indexer: no block');
  return count(data.block.height, 'block height');
}

function blockOf(block: Block, at: number) {
  if (count(block.height, 'block height') !== at) throw new IndexerError('indexer: answered another block');
  if (typeof block.hash !== 'string' || !/^[0-9a-f]{64}$/.test(block.hash)) throw new IndexerError('indexer: bad block hash');
  return { blockHeight: at, blockHash: block.hash, blockTimestamp: count(block.timestamp, 'block timestamp') };
}

function snapshotOf(state: unknown): RegistrySnapshot {
  try {
    return decodeRegistry(state as string);
  } catch (e) {
    if (e instanceof NotRegistryState) throw e; // another contract: for the caller there is no registry
    throw new IndexerError('indexer: bad contract state');
  }
}

/**
 * Runs `query` for the contract at `address` at that height (or the latest block) and returns the
 * validated block plus the raw indexer answer. A requested height the indexer lacks is InvalidInput;
 * if this function chose it (the latest block), it is IndexerError.
 */
async function contractAt(gql: GraphQL, query: string, address: string, height?: number) {
  fromHex(address, 32, 'contractAddress');
  if (height !== undefined && (!Number.isSafeInteger(height) || height < 0)) throw new InvalidInput('blockHeight: invalid');
  const at = height ?? (await latestHeight(gql));
  const data = await ask(gql, query, { address, offset: { height: at } });
  if (!data.block) {
    throw height === undefined ? new IndexerError('indexer: lost its last block') : new InvalidInput('blockHeight: unknown block');
  }
  return { block: blockOf(data.block, at), raw: data.block, contract: data.contract ?? null };
}

/**
 * Registry state at `address` at that height (or the latest block). null if there is no contract
 * there, NotRegistryState if it is a different contract. Height errors: see contractAt.
 */
export async function fetchRegistry(gql: GraphQL, address: string, height?: number): Promise<RegistryAt | null> {
  const { block, contract } = await contractAt(gql, STATE_AT, address, height);
  if (!contract) return null;
  const snapshot = snapshotOf(contract.state);
  return { ...block, stateBytes: (contract.state as string).length / 2, snapshot };
}

/**
 * What a local circuit run needs, all from the same block: the contract state (already decoded, any
 * contract), the ledger parameters and the contract's Zswap state (hex, as the indexer serves them).
 * Same query as midnight-js `queryZSwapAndContractState`.
 */
export type CallStates = {
  blockHeight: number;
  blockHash: string;
  blockTimestamp: number;
  state: ContractState;
  ledgerParameters: string;
  zswapState: string;
};

const CALL_STATES_AT = `query ($address: HexEncoded!, $offset: BlockOffset) {
  block(offset: $offset) { height hash timestamp ledgerParameters contractZswapState(address: $address) }
  contract(address: $address, offset: $offset) { state }
}`;

const hexOf = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(v)) throw new IndexerError(`indexer: bad ${what}`);
  return v;
};

function contractStateOf(state: unknown): ContractState {
  try {
    return decodeState(state as string);
  } catch {
    throw new IndexerError('indexer: bad contract state');
  }
}

/** CallStates of the contract at `address` at the indexer's latest block; null if there is no contract there. */
export async function fetchCallStates(gql: GraphQL, address: string): Promise<CallStates | null> {
  const { block, raw, contract } = await contractAt(gql, CALL_STATES_AT, address);
  if (!contract) return null;
  return {
    ...block,
    state: contractStateOf(contract.state),
    ledgerParameters: hexOf(raw.ledgerParameters, 'ledger parameters'),
    zswapState: hexOf(raw.contractZswapState, 'zswap state'),
  };
}

/**
 * JSON response body, streamed without exceeding `maxBytes` so an indexer cannot exhaust memory.
 * Too large or invalid JSON: IndexerError.
 */
export async function readJsonCapped(res: Response, maxBytes: number): Promise<unknown> {
  const body = await readBodyCapped(res, maxBytes);
  if (body === undefined) throw new IndexerError('indexer: response too large');
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new IndexerError('indexer: invalid JSON');
  }
}

/**
 * Response body, streamed without exceeding `maxBytes`; undefined if larger (reading stops as soon as
 * the limit is crossed and the rest is discarded).
 */
export async function readBodyCapped(res: Response, maxBytes: number): Promise<Buffer | undefined> {
  if (Number(res.headers.get('content-length')) > maxBytes) {
    await res.body?.cancel().catch(() => {}); // do not keep the connection alive until GC
    return undefined;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (res.body !== null) {
    for await (const chunk of res.body) {
      size += chunk.byteLength;
      if (size > maxBytes) return undefined;
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks);
}
