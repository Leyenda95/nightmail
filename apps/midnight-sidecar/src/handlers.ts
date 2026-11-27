// JSON-RPC methods of the sidecar. Parameter and result types come from
// apps/desktop/src-tauri/src/protocol.rs (single source, exported with ts-rs).
//
// `initialize` must run before any other method: it fixes the protocol version,
// the network and the endpoints, which only the core decides.
import pkg from '../package.json' with { type: 'json' };
import { AppError, codes } from './codes.ts';
import { contractHandlers } from './contract.ts';
import { headHandlers } from './head.ts';
import { net, validateEndpoints } from './net.ts';
import { proveHandlers } from './prove.ts';
import { walletHandlers } from './walletHandlers.ts';
import type { Handler } from './rpc.ts';
import type { InitializeParams } from './protocol/InitializeParams.ts';
import type { InitializeResult } from './protocol/InitializeResult.ts';
import type { PingResult } from './protocol/PingResult.ts';

export const PROTOCOL_VERSION = '2.0';
export const SIDECAR_VERSION: string = pkg.version;

const major = (v: string) => v.split('.')[0];

export type SidecarState = {
  initialized: InitializeParams | null;
  /** Closes the embedded wallet if open (persisting its state). Set by createHandlers. */
  closeWallet?: () => Promise<void>;
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseInitialize(params: unknown): InitializeParams {
  const bad = () => new AppError(codes.INVALID_PARAMS, 'Invalid params');
  if (!isObject(params) || !isObject(params.endpoints)) throw bad();
  const e = params.endpoints;
  const strings = [params.protocolVersion, e.proofServer, e.indexer, e.indexerWs, e.node];
  if (!strings.every((s) => typeof s === 'string')) throw bad();
  if (params.network !== 'undeployed' && params.network !== 'preprod') throw bad();
  if (typeof params.debug !== 'boolean') throw bad();
  return params as unknown as InitializeParams;
}

async function reachable(check: () => Promise<boolean>): Promise<boolean> {
  try {
    return await check();
  } catch {
    return false;
  }
}

export function createHandlers(state: SidecarState): Record<string, Handler> {
  const initialized = () => {
    if (!state.initialized) throw new AppError(codes.NOT_INITIALIZED, 'Not initialized');
    return state.initialized;
  };
  const endpoints = () => initialized().endpoints;
  /** Debug log (stderr, only with `debug`). Never receives secrets. */
  const log = (message: string) => {
    if (state.initialized?.debug) console.error(`[sidecar] ${message}`);
  };

  const wallet = walletHandlers(initialized);
  state.closeWallet = wallet.close;

  const handlers: Record<string, Handler> = {
    initialize: async (params): Promise<InitializeResult> => {
      const init = parseInitialize(params);
      if (major(init.protocolVersion) !== major(PROTOCOL_VERSION)) {
        throw new AppError(codes.PROTOCOL_MISMATCH, 'Protocol version mismatch');
      }
      state.initialized = { ...init, endpoints: validateEndpoints(init.endpoints) };
      return { protocolVersion: PROTOCOL_VERSION, sidecarVersion: SIDECAR_VERSION, methods: Object.keys(handlers) };
    },

    ping: async (_params, { signal }): Promise<PingResult> => {
      const ep = endpoints();
      const timeout = () => AbortSignal.any([signal, AbortSignal.timeout(3000)]);
      const [proofServer, indexer] = await Promise.all([
        reachable(async () => (await net.fetch(`${ep.proofServer}/version`, { signal: timeout() })).ok),
        reachable(async () => {
          const res = await net.fetch(ep.indexer, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: '{ block { height } }' }),
            signal: timeout(),
          });
          if (!res.ok) return false;
          // GraphQL answers 200 even on errors, so require a block in the response.
          const body = (await res.json()) as { data?: { block?: unknown } };
          return body?.data?.block != null;
        }),
      ]);
      return { pong: true, sidecarVersion: SIDECAR_VERSION, node: process.version, proofServer, indexer };
    },

    ...contractHandlers(() => endpoints().indexer, { log }),
    ...proveHandlers(initialized, { log }),
    ...headHandlers(initialized),
    ...wallet.handlers,
  };
  return handlers;
}
