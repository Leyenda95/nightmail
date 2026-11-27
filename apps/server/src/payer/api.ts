// Local API of the payer (a separate process, sole holder of the operator wallet): HTTP over a Unix socket
// `<dataDir>/payer.sock` (0600, inside a 0700 dir). Only the operator's server uses it, on the same
// machine and as the same user. Routes:
//
//   GET  /health                               readiness, DUST coins and balance, queue, lost fees
//   POST /relay          { tx: hex }           pays for and submits a client-proved transaction
//   POST /issue          { id: hex32, plan }   issues a `bono` leaf (idempotent per id)
//
// JSON only, size-capped, with exactly each route's fields. Errors are fixed codes (`{ error }`): SDK or
// exception messages never leave the process (only the error type is logged).
import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { errorKind } from '../log.ts';
import { ensurePrivateDir } from '../wallet/storage.ts';
import { ISSUE_PLANS, type IssuePlan } from './journal.ts';
import type { Payer, PayerError, PayerLog } from './payer.ts';

export type PayerOps = Pick<Payer, 'health' | 'relay' | 'issue'>;

export type ApiError = {
  error: 'bad-request' | 'not-found' | 'method-not-allowed' | 'payload-too-large' | 'unsupported-media-type' | 'not-ready' | 'internal';
};

/** The socket path is taken by something that can't be removed (a live payer, or not a socket). */
export class PayerSocketError extends Error {}

/**
 * Request body cap. A proved NightMailRegistry transaction is 6-10 KiB (twice that in hex); 256 KiB
 * leaves ample headroom while bounding memory.
 */
export const MAX_BODY_BYTES = 256 * 1024;
const PROBE_TIMEOUT_MS = 2000;

const HEX = /^(?:[0-9a-f]{2})+$/;
const HEX32 = /^[0-9a-f]{64}$/;

type Reply = { status: number; body: unknown; headers?: Record<string, string> };

const fail = (status: number, error: ApiError['error'], headers?: Record<string, string>): Reply =>
  ({ status, body: { error }, ...(headers && { headers }) });
const BAD_REQUEST = fail(400, 'bad-request');

const STATUS_OF: Record<PayerError['error'], number> = {
  'invalid-tx': 422,
  'not-relayable': 422,
  'fee-over-cap': 422,
  'id-conflict': 409,
  'dust-cap': 429,
  'no-contract': 503,
  'queue-full': 503,
  'dust-unavailable': 503,
  'indexer-behind': 503,
  stopping: 503,
  internal: 500,
};

/** Maps a payer result to a reply: errors get their HTTP status and, when present, Retry-After. */
function replyOf(result: object): Reply {
  if (!('error' in result)) return { status: 200, body: result };
  const error = result as PayerError;
  const headers = 'retryAfterS' in error ? { 'Retry-After': String(error.retryAfterS) } : undefined;
  return { status: STATUS_OF[error.error], body: error, ...(headers && { headers }) };
}

class PayloadTooLarge extends Error {}

/** Reads the whole body, enforcing the cap whether or not Content-Length declares it. */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) throw new PayloadTooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new PayloadTooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** The body as a JSON object with exactly these keys, all strings; otherwise undefined. */
function fields<K extends string>(body: Buffer, keys: readonly K[]): Record<K, string> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const given = Object.keys(value);
  const exact = given.length === keys.length && keys.every((k) => typeof (value as Record<string, unknown>)[k] === 'string');
  return exact ? (value as Record<K, string>) : undefined;
}

type Handler = (payer: PayerOps, body: Buffer) => Promise<Reply>;

const ROUTES: Record<string, Handler> = {
  '/relay': async (payer, body) => {
    const input = fields(body, ['tx']);
    if (!input || !HEX.test(input.tx)) return BAD_REQUEST;
    return replyOf(await payer.relay(new Uint8Array(Buffer.from(input.tx, 'hex'))));
  },
  '/issue': async (payer, body) => {
    const input = fields(body, ['id', 'plan']);
    if (!input || !HEX32.test(input.id) || !ISSUE_PLANS.includes(input.plan as IssuePlan)) return BAD_REQUEST;
    return replyOf(await payer.issue(input.id, input.plan as IssuePlan));
  },
};

async function post(req: IncomingMessage, handler: Handler, payer: PayerOps | undefined): Promise<Reply> {
  if (req.method !== 'POST') return fail(405, 'method-not-allowed', { Allow: 'POST' });
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) return fail(415, 'unsupported-media-type');
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch (e) {
    if (e instanceof PayloadTooLarge) return fail(413, 'payload-too-large', { Connection: 'close' });
    throw e;
  }
  return payer ? handler(payer, body) : fail(503, 'not-ready');
}

async function route(req: IncomingMessage, payer: PayerOps | undefined): Promise<Reply> {
  if (req.url === '/health') {
    if (req.method !== 'GET') return fail(405, 'method-not-allowed', { Allow: 'GET' });
    return { status: 200, body: payer ? payer.health() : { ready: false } };
  }
  const handler = Object.hasOwn(ROUTES, req.url ?? '') ? ROUTES[req.url!] : undefined;
  return handler ? post(req, handler, payer) : fail(404, 'not-found');
}

/** JSON with DUST amounts (bigint) as decimal strings. */
const toJson = (value: unknown) => JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));

function send(res: ServerResponse, reply: Reply): void {
  const body = Buffer.from(toJson(reply.body), 'utf8');
  res.writeHead(reply.status, {
    'Content-Type': 'application/json',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...reply.headers,
  });
  res.end(body);
}

/** Whether something is listening on the socket. Throws if that can't be determined. */
function isListening(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const probe = net.connect(socketPath);
    const done = (answer: () => void) => {
      probe.destroy();
      answer();
    };
    probe.setTimeout(PROBE_TIMEOUT_MS, () => done(() => reject(new PayerSocketError(`${socketPath} does not answer`))));
    probe.once('connect', () => done(() => resolve(true)));
    probe.once('error', (e: NodeJS.ErrnoException) => done(() => {
      if (e.code === 'ECONNREFUSED' || e.code === 'ENOENT') resolve(false);
      else reject(new PayerSocketError(`${socketPath} cannot be probed (${e.code ?? 'unknown'})`));
    }));
  });
}

/**
 * Frees the socket path. A stale socket from a previous process (nobody listening) is removed; a live
 * socket or anything else at that path is left alone and reported as an error. The dir must be private
 * (0700), so nobody else can have put anything there.
 */
async function claimSocketPath(socketPath: string): Promise<void> {
  ensurePrivateDir(path.dirname(socketPath));
  let existing;
  try {
    existing = lstatSync(socketPath); // don't follow symlinks
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  if (!existing.isSocket()) throw new PayerSocketError(`${socketPath} exists and is not a socket`);
  if (await isListening(socketPath)) throw new PayerSocketError(`another process is listening on ${socketPath}`);
  unlinkSync(socketPath);
}

/** Listens on a socket created with mode 0600 (the umask only changes around the synchronous `bind`). */
function listenPrivately(server: http.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => {
      server.off('error', reject);
      chmodSync(socketPath, 0o600); // in case the platform ignored the umask for sockets
      resolve();
    });
    const umask = process.umask(0o177);
    try {
      server.listen(socketPath);
    } finally {
      process.umask(umask);
    }
  });
}

export type PayerApi = { close(): Promise<void> };

/**
 * Starts the API. `payer()` returns undefined while the wallet is still syncing (hours the first time):
 * /health answers `{ ready: false }` and the other routes 503 `not-ready`.
 * The caller must already hold the data dir's single-instance lock (wallet/storage.ts).
 */
export async function startPayerApi(opts: { socketPath: string; payer: () => PayerOps | undefined; log: PayerLog }): Promise<PayerApi> {
  await claimSocketPath(opts.socketPath);
  const server = http.createServer((req, res) => {
    route(req, opts.payer())
      .catch((e: unknown): Reply => {
        opts.log.warn(`api: ${req.method} failed: ${errorKind(e)}`);
        return fail(500, 'internal');
      })
      .then((reply) => send(res, reply))
      .catch(() => res.destroy()); // the client is gone, nobody to answer
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000; // only for receiving the request; the response waits on the chain as long as needed
  server.maxConnections = 64;
  await listenPrivately(server, opts.socketPath);
  let closing: Promise<void> | undefined;
  return {
    close: () => (closing ??= new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    })),
  };
}
