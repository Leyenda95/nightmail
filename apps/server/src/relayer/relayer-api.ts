// Public relayer API, on its own port, separate from the Mailbox and Issuer APIs:
//
//   POST /v1/relay         {tx}       -> 202 {ticket}   (tx: the proved, unbalanced transaction, lowercase hex)
//   POST /v1/relay/status  {ticket}   -> 200 {state: 'queued'} | {state: 'done', outcome, ...} | 404 {error: 'not-found'}
//     outcome: included | rejected | unknown | failed | refused | busy | expired (never sent; prove again)
//
// Asynchronous because the payer queue can take minutes and proxies cut at ~60 s. The ticket never goes in the
// URL. 409 means the same intent is already in progress with other bytes. IPs are never stored or logged.
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { clientKey } from '../issuer/client-ip.ts';
import { fail, json, readJsonObject, type Reply, respond } from '../issuer/http.ts';
import { RateLimiter, type RateLimit } from '../limits.ts';
import type { Logger } from '../log.ts';
import { MAX_TX_BYTES, type Relayer, type SubmitResult } from './relayer.ts';

export type RelayerApiLimits = {
  /** All requests per client, status polls included. */
  perIpAll: RateLimit;
  maxConnections: number;
  /** Hex of a MAX_TX_BYTES transaction (twice the length) plus the JSON around it. */
  maxBodyBytes: number;
  responseTimeoutMs: number;
};

export const DEFAULT_RELAYER_API_LIMITS: RelayerApiLimits = {
  perIpAll: { limit: 600, windowMs: 60_000 },
  maxConnections: 256,
  maxBodyBytes: MAX_TX_BYTES * 2 + 1024,
  responseTimeoutMs: 30_000,
};

export type RelayerApiDeps = {
  relayer: Pick<Relayer, 'submit' | 'status'>;
  log: Logger;
  limits?: Partial<RelayerApiLimits>;
  now?: () => number;
  /** Per-client rate-limit key; defaults to the socket IP (IPv6 grouped by /64). */
  clientKey?: (req: IncomingMessage) => string;
};

type RouteKind = 'submit' | 'status';

const ROUTES = new Map<string, RouteKind>([['/v1/relay', 'submit'], ['/v1/relay/status', 'status']]);
const TICKET_RE = /^[0-9a-f]{32}$/;

const NOT_FOUND = fail(404, 'not_found');
const TICKET_NOT_FOUND = fail(404, 'not-found');
const BAD_REQUEST = fail(400, 'bad_request');
const METHOD_NOT_ALLOWED = fail(405, 'method_not_allowed', { Allow: 'POST' });

const retryReply = (status: number, error: string, retryAfterS: number) =>
  json(status, { error, retryAfterS }, { 'Retry-After': String(retryAfterS) });

/** The body has exactly this one field, and it is a string. */
const onlyString = (body: Record<string, unknown>, key: string): string | undefined =>
  Object.keys(body).length === 1 && typeof body[key] === 'string' ? (body[key] as string) : undefined;

function submitReply(result: SubmitResult): Reply {
  if ('ticket' in result) return json(202, result);
  switch (result.error) {
    case 'bad-request': return BAD_REQUEST;
    case 'invalid-tx': return fail(422, 'invalid-tx');
    case 'duplicate': return fail(409, 'duplicate');
    case 'not-relayable': return json(422, result);
    case 'rate-limited': return retryReply(429, 'rate-limited', result.retryAfterS);
    case 'busy': return retryReply(503, 'busy', result.retryAfterS);
  }
}

class RelayerApi {
  private readonly deps: RelayerApiDeps;
  private readonly limits: RelayerApiLimits;
  private readonly now: () => number;
  private readonly clientKey: (req: IncomingMessage) => string;
  private readonly perIpAll: RateLimiter;

  constructor(deps: RelayerApiDeps) {
    this.deps = deps;
    this.limits = { ...DEFAULT_RELAYER_API_LIMITS, ...deps.limits };
    this.now = deps.now ?? Date.now;
    this.clientKey = deps.clientKey ?? clientKey(false);
    this.perIpAll = new RateLimiter(this.limits.perIpAll);
  }

  private submit(body: Record<string, unknown>, key: string): Reply {
    const tx = onlyString(body, 'tx');
    return tx === undefined ? BAD_REQUEST : submitReply(this.deps.relayer.submit(tx, key));
  }

  private status(body: Record<string, unknown>): Reply {
    const ticket = onlyString(body, 'ticket');
    if (ticket === undefined || !TICKET_RE.test(ticket)) return BAD_REQUEST;
    const status = this.deps.relayer.status(ticket);
    return status ? json(200, status) : TICKET_NOT_FOUND;
  }

  private async dispatch(req: IncomingMessage, kind: RouteKind, key: string): Promise<Reply> {
    const body = await readJsonObject(req, this.limits.maxBodyBytes);
    if (!body.ok) return body.reply;
    return kind === 'status' ? this.status(body.value) : this.submit(body.value, key);
  }

  private async route(req: IncomingMessage): Promise<Reply> {
    const key = this.clientKey(req);
    if (!this.perIpAll.hit(key, this.now())) return retryReply(429, 'rate-limited', Math.ceil(this.limits.perIpAll.windowMs / 1000));
    const kind = ROUTES.get(req.url ?? '');
    if (!kind) return NOT_FOUND;
    return req.method === 'POST' ? this.dispatch(req, kind, key) : METHOD_NOT_ALLOWED;
  }

  handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return respond(res, async () => this.route(req), { label: 'relayer-api', log: this.deps.log, timeoutMs: this.limits.responseTimeoutMs });
  }
}

export function createRelayerApi(deps: RelayerApiDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const api = new RelayerApi(deps);
  return (req, res) => api.handle(req, res);
}

/** Relayer HTTP server; the caller does `listen(port, '127.0.0.1')`. */
export function createRelayerServer(deps: RelayerApiDeps): http.Server {
  const server = http.createServer(
    { maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 30_000, keepAliveTimeout: 5000, connectionsCheckingInterval: 1000 },
    createRelayerApi(deps),
  );
  server.maxConnections = deps.limits?.maxConnections ?? DEFAULT_RELAYER_API_LIMITS.maxConnections;
  return server;
}
