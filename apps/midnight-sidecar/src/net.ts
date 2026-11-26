// The sidecar's only network gateway, so all traffic can go out through the
// core. It makes direct requests today; a Tor proxy from the core would be
// injected here without touching the rest of the code.
//
// No other module may use the global `fetch` or `WebSocket` directly.
import { AppError, codes } from './codes.ts';
import type { Endpoints } from './protocol/Endpoints.ts';

// IPs only, not 'localhost' (it depends on the hosts file or DNS). `URL` normalises
// 127.1 or 0x7f.0.0.1 to 127.0.0.1 and brackets IPv6.
const LOOPBACK = new Set(['127.0.0.1', '[::1]']);

let fetchImpl: typeof fetch = (...args) => fetch(...args);

/** Tests only. */
export function setFetchForTests(impl: typeof fetch): void {
  fetchImpl = impl;
}

function checkUrl(name: string, value: string, protocols: string[]): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(codes.INVALID_CONFIG, `Invalid endpoint: ${name}`);
  }
  if (!protocols.includes(url.protocol)) throw new AppError(codes.INVALID_CONFIG, `Invalid endpoint protocol: ${name}`);
  return url;
}

/**
 * Does the environment route Node's `fetch` through a proxy? With NODE_USE_ENV_PROXY=1 (or --use-env-proxy)
 * Node honours HTTP_PROXY/HTTPS_PROXY, which would send witnesses bound for the local proof server to the proxy.
 * The core's supervisor strips those variables; this covers a hand-launched sidecar. The option can come from
 * the command line (process.execArgv) or from NODE_OPTIONS, which is absent from execArgv and which Node
 * accepts quoted, with `_` for `-` and with `=value`.
 */
function envProxyEnabled(): boolean {
  const flag = process.env.NODE_USE_ENV_PROXY;
  const options = (process.env.NODE_OPTIONS ?? '').split(/\s+/);
  return (flag !== undefined && flag !== '' && flag !== '0') || [...process.execArgv, ...options].some(isEnvProxyOption);
}

const isEnvProxyOption = (arg: string) => arg.replace(/^["']|["']$/g, '').split('=')[0].replaceAll('_', '-') === '--use-env-proxy';

/** Does the URL carry more than its origin (credentials, path, query or fragment)? */
const beyondOrigin = (url: URL) => [url.username, url.password, url.search, url.hash].some((part) => part !== '') || url.pathname !== '/';

/**
 * Validates the endpoints sent by the core in `initialize` and returns them normalised. The proof server
 * is reduced to its origin (`URL.origin`), the only part that reaches the prover client.
 */
export function validateEndpoints(endpoints: Endpoints): Endpoints {
  if (envProxyEnabled()) throw new AppError(codes.INVALID_CONFIG, 'Proxy environment not allowed');
  const prover = checkUrl('proofServer', endpoints.proofServer, ['http:', 'https:']);
  checkUrl('indexer', endpoints.indexer, ['http:', 'https:']);
  checkUrl('indexerWs', endpoints.indexerWs, ['ws:', 'wss:']);
  checkUrl('node', endpoints.node, ['ws:', 'wss:', 'http:', 'https:']);
  // The proof server receives the witnesses (the bono secret), so it must be local.
  // A remote one stays disallowed until the app verifies a TEE attestation, which
  // will come with its own configuration.
  if (!LOOPBACK.has(prover.hostname)) {
    throw new AppError(codes.INVALID_CONFIG, 'Remote proof server not allowed');
  }
  // A local service has no credentials, path or query: reject them rather than pass them to the prover.
  if (beyondOrigin(prover)) throw new AppError(codes.INVALID_CONFIG, 'Invalid endpoint: proofServer');
  return { ...endpoints, proofServer: prover.origin };
}

export const net = {
  fetch(url: string, init?: RequestInit): Promise<Response> {
    return fetchImpl(url, init);
  },
  webSocket(url: string): WebSocket {
    return new WebSocket(url);
  },
};
