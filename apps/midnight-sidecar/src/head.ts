// `chain.head`: the time of the node's latest block, read from the node itself (not from the indexer, which follows
// finalized blocks and lags ~15-20 s behind). The core uses it to wait for the indexer to catch up before
// another proof for a slot, and only within bounds of the indexer's block time (it does not trust the node either).
//
// - One JSON-RPC call over HTTP to the node (`endpoints.node`, in its http(s) form) through net.ts:
//   `state_getStorage(Timestamp.Now)`, a fixed storage key. The request carries nothing about this device or its
//   addresses.
// - `Timestamp.Now` is the block's Unix time in ms, a SCALE `u64` (8 bytes, little endian) in hex.
import { readBodyCapped } from '@nightmail/midnight';
import { AppError, codes } from './codes.ts';
import { net } from './net.ts';
import type { Handler, HandlerContext } from './rpc.ts';
import type { ChainHead } from './protocol/ChainHead.ts';
import type { InitializeParams } from './protocol/InitializeParams.ts';

/** Storage key of `pallet_timestamp::Now`: twox128("Timestamp") ++ twox128("Now"). */
export const TIMESTAMP_NOW_KEY = '0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb';
const HEAD_TIMEOUT_MS = 5_000;
/** The answer is a few dozen bytes: anything much larger is not a node's. */
const MAX_HEAD_RESPONSE_BYTES = 4096;

/** The node's HTTP JSON-RPC URL from its endpoint (ws → http, wss → https; the same port serves both). */
export function nodeHttpUrl(node: string): string {
  const url = new URL(node);
  if (url.protocol === 'ws:') url.protocol = 'http:';
  else if (url.protocol === 'wss:') url.protocol = 'https:';
  return url.toString();
}

const unavailable = () => new AppError(codes.UPSTREAM_UNAVAILABLE, 'Node unavailable');
const bad = () => new AppError(codes.APP_INTERNAL, 'Internal error');

/** `Timestamp.Now` from its SCALE hex (`0x` + 16 hex digits, u64 little endian) to Unix ms. */
export function decodeTimestamp(value: unknown): number {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{16}$/.test(value)) throw bad();
  const ms = Buffer.from(value.slice(2), 'hex').readBigUInt64LE(0);
  if (ms === 0n || ms > BigInt(Number.MAX_SAFE_INTEGER)) throw bad();
  return Number(ms);
}

async function head(init: InitializeParams, context: HandlerContext): Promise<ChainHead> {
  let res: Response;
  try {
    res = await net.fetch(nodeHttpUrl(init.endpoints.node), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'state_getStorage', params: [TIMESTAMP_NOW_KEY] }),
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(HEAD_TIMEOUT_MS)]),
    });
  } catch {
    // A cancellation is answered as CANCELLED by rpc.ts (it checks the signal).
    throw unavailable();
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw unavailable();
  }
  let bytes: Buffer | undefined;
  try {
    // Streamed with a cap: a larger answer is not read in full.
    bytes = await readBodyCapped(res, MAX_HEAD_RESPONSE_BYTES);
  } catch {
    throw unavailable();
  }
  if (bytes === undefined) throw bad();
  let body: unknown;
  try {
    body = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw bad();
  }
  if (typeof body !== 'object' || body === null || !('result' in body)) throw unavailable();
  return { timestamp: decodeTimestamp((body as { result: unknown }).result) };
}

export function headHandlers(initialized: () => InitializeParams): Record<string, Handler> {
  return { 'chain.head': async (_params, context) => head(initialized(), context) };
}
