// Indexer (GraphQL v4) client: HTTP queries for `fetchRegistry` and the `contractActions` WebSocket
// subscription. `contractActions` replays from `offset` (inclusive) then goes live; without an offset it
// skips the past. `state` is not requested there (tens of KiB, growing with the addresses).
// URLs may carry a secret (Blockfrost project_id), so errors raised here never include them.
import { createClient } from 'graphql-ws';
import WebSocket from 'ws';
import { type GraphQL, IndexerError, IndexerUnavailable, readJsonCapped } from '@nightmail/midnight';
import type { ActionNotice, ActionSource } from './sync.ts';

/** Cap on an indexer response body (the registry state comes hex-encoded). */
export const MAX_INDEXER_RESPONSE_BYTES = 128 * 1024 * 1024;

export type HttpGraphQLOptions = {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  /** Aborting it cancels in-flight requests (server shutdown does not wait for the timeout). */
  signal?: AbortSignal;
};

/** `gql` for `fetchRegistry`: POST with a timeout, no redirects and a size cap. */
export function httpGraphQL(url: string, options: HttpGraphQLOptions = {}): GraphQL {
  const { fetchFn = fetch, timeoutMs = 30_000, maxBytes = MAX_INDEXER_RESPONSE_BYTES, signal } = options;
  return async (query, variables) => {
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      const response = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        redirect: 'error',
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
      if (!response.ok) throw new IndexerUnavailable(`indexer: HTTP ${response.status}`);
      return await readJsonCapped(response, maxBytes);
    } catch (error) {
      if (error instanceof IndexerError || error instanceof IndexerUnavailable) throw error;
      throw new IndexerUnavailable('indexer: request failed'); // drop the original error: it may contain the URL
    }
  };
}

const ACTIONS = `subscription ($address: HexEncoded!, $offset: BlockOffset) {
  contractActions(address: $address, offset: $offset) {
    __typename
    stateAt { height hash }
    ... on ContractCall { entryPoint }
  }
}`;

const BLOCK_HASH = /^[0-9a-f]{64}$/;

type RawAction = { __typename?: unknown; stateAt?: { height?: unknown; hash?: unknown } | null; entryPoint?: unknown };
type RawResult = { data?: { contractActions?: RawAction | null } | null; errors?: unknown } | null;

const bad = () => new IndexerError('indexer: bad contract action');

/** The block the action's state belongs to. */
function blockOf(stateAt: RawAction['stateAt']): { height: number; hash: string } {
  const { height, hash } = stateAt ?? ({} as NonNullable<RawAction['stateAt']>);
  if (!Number.isSafeInteger(height) || (height as number) < 0) throw bad();
  if (typeof hash !== 'string' || !BLOCK_HASH.test(hash)) throw bad();
  return { height: height as number, hash };
}

/** The called circuit; null if the action is not a call (deploy or maintenance). */
function entryPointOf(action: RawAction): string | null {
  if (action.__typename !== 'ContractCall') return null;
  if (typeof action.entryPoint !== 'string') throw bad();
  return action.entryPoint;
}

/** Validates one action as received from the subscription. */
export function toNotice(result: unknown): ActionNotice {
  const body = result as RawResult;
  if (body?.errors !== undefined) throw new IndexerUnavailable('indexer: GraphQL errors');
  const action = body?.data?.contractActions;
  if (!action) throw bad();
  return { ...blockOf(action.stateAt), entryPoint: entryPointOf(action) };
}

export type ActionSourceOptions = {
  /** Ping interval (a half-open socket never reports that the peer is gone). */
  keepAliveMs?: number;
  /** How long to wait for the pong before treating the connection as lost. */
  pongTimeoutMs?: number;
};

/**
 * Actions of contract `address` via the indexer subscription at `url`. Each call opens a fresh
 * connection and closes it when done. It never retries on its own; RegistrySync does, from the
 * height it needs.
 */
export function contractActionSource(url: string, address: string, options: ActionSourceOptions = {}): ActionSource {
  const { keepAliveMs = 10_000, pongTimeoutMs = 5_000 } = options;
  return async function* (fromHeight, signal, alive) {
    let socket: { close(code: number, reason: string): void } | undefined;
    let pongDeadline: NodeJS.Timeout | undefined;
    const client = createClient({
      url,
      webSocketImpl: WebSocket,
      retryAttempts: 0,
      keepAlive: keepAliveMs,
      on: {
        // Connecting does not count as a sign of life (an indexer that accepts the connection and fails
        // the subscription every time would look healthy). Each pong does.
        connected: (connected) => { socket = connected as typeof socket; },
        ping: (received) => {
          if (!received) pongDeadline = setTimeout(() => socket?.close(4408, 'pong timeout'), pongTimeoutMs);
        },
        pong: (received) => {
          if (!received) return;
          clearTimeout(pongDeadline);
          alive();
        },
        closed: () => clearTimeout(pongDeadline),
      },
    });
    const results = client.iterate({ query: ACTIONS, variables: { address, offset: { height: fromHeight } } });
    const stop = () => { void client.dispose(); };
    signal.addEventListener('abort', stop);
    try {
      for await (const result of results) yield toNotice(result);
    } catch (error) {
      if (error instanceof IndexerError || error instanceof IndexerUnavailable) throw error;
      throw new IndexerUnavailable('indexer: subscription failed'); // drop the original error: it may contain the URL
    } finally {
      signal.removeEventListener('abort', stop);
      clearTimeout(pongDeadline);
      await client.dispose();
    }
  };
}
