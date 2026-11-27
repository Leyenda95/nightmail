// Client for the payer's local API (payer/api.ts), used by the server's relayer and Issuer.
// Returns the HTTP status and JSON body as-is. Only throws when the payer can't be reached (missing
// socket, dropped connection, timeout).
import http from 'node:http';
import path from 'node:path';
import type { ApiError } from './api.ts';
import type { IssuePlan } from './journal.ts';
import type { Health, IssueResult, PayerError, RelayResult } from './payer.ts';

/** A type as it travels in JSON: DUST amounts (bigint) are decimal strings. */
export type Wire<T> = T extends bigint ? string : T extends object ? { [K in keyof T]: Wire<T[K]> } : T;
export type PayerReply<T> = { status: number; body: Wire<T> | PayerError | ApiError };

/**
 * Default request timeout: an operation waits its turn in the queue, then up to 10 min to submit and
 * another 10 for the block.
 */
export const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

/** Payer socket path for an operator data dir (`ServerConfig.dataDir`). */
export const payerSocketPath = (dataDir: string) => path.join(dataDir, 'payer.sock');

export function payerClient(socketPath: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const call = <T>(method: 'GET' | 'POST', url: string, body?: object): Promise<PayerReply<T>> =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
      const headers = payload && { 'Content-Type': 'application/json', 'Content-Length': payload.length };
      const req = http.request({ socketPath, method, path: url, ...(headers && { headers }) }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) req.destroy(new Error('payer: response too large'));
          else chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          } catch {
            reject(new Error('payer: invalid response'));
          }
        });
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error('payer: no answer in time')));
      req.on('error', reject);
      req.end(payload);
    });
  return {
    health: () => call<Health | { ready: false }>('GET', '/health'),
    /** `txHex`: the serialized proved, unbalanced transaction, lowercase hex. */
    relay: (txHex: string) => call<RelayResult>('POST', '/relay', { tx: txHex }),
    issue: (idHex: string, plan: IssuePlan) => call<IssueResult>('POST', '/issue', { id: idHex, plan }),
  };
}

export type PayerClient = ReturnType<typeof payerClient>;
