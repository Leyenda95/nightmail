// Mailbox API: the app downloads the mail of one address with requests signed by that address's
// Ed25519 key. No username or password, and nothing that links two addresses.
//
//   GET /v1/time                                  server time (Unix seconds). Unsigned.
//   GET /v1/box/<addrKey>/messages[?since=<n>]    ids, size buckets and dates after cursor `since`
//   GET /v1/box/<addrKey>/messages/<id>           the encrypted envelope, as is
//   POST /v1/box/<addrKey>/deliver                stores an envelope sealed by the sender. Unsigned and anonymous:
//                                                 body `application/octet-stream` with Content-Length, exactly
//                                                 one envelope (see deliver.ts). 200 `{"status":"delivered"}`;
//                                                 400 bad_request, 404 not_found, 413 too_large,
//                                                 429 rate_limited | busy, 503 unavailable, 507 mailbox_full.
//
// Auth (spec in packages/test-vectors/crypto/README.md): time window, then signature, then nonce. The
// signature covers the configured host (never the Host header), the method and the raw `req.url`, so the
// path's addrKey is signed; any path not matching a form above exactly is a 404. Every rejection is an
// identical 401 with `Date` for clock adjustment; the reason only reaches the debug log. Error bodies are fixed
// and no route sends CORS headers. A signed request for an address the index does not know yet waits a little for
// it before that 401 (`newAddressWaitMs`): it may have just been created and not be final on chain yet.
//
// Every response closes the connection, since one connection serving two addresses would link them.
// Large envelopes use a few send slots (429 when full) and all responses have a deadline, so a stalled
// reader cannot pin memory. `since` is a per-mailbox cursor, not a date (stored dates are rounded).
//
// Per-IP limits key IPv6 by its /64. Behind a reverse proxy (NIGHTMAIL_API_TRUSTED_PROXY=1) the client IP is
// the last X-Forwarded-For entry (see client-ip.ts); without one that header is ignored. Through Tor or an
// onion service every client arrives from the same few addresses, so per-IP limits protect nothing useful
// there: what holds is the per-box and global limits (slots, connections, quotas).
//
// Known risk, to be solved with the anonymous sender stamp (a zero-knowledge proof of holding a plan, limited
// per sender and day without telling who): anyone can use up the per-box limits or
// the quota of one given box with junk, so that legitimate senders get 429 or 507 until its owner deletes mail
// or the window passes. Delivery is anonymous, so there is no sender to block. The per-box byte limit only slows
// it down (at least 7.5 hours to fill an empty 300 MiB box); it does not prevent it.
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { authenticateRequest, MAILBOX_API_VERSION, type NonceStore, parseAuthHeaders } from '@nightmail/core-ts';
import { clientAddress, ipKey } from '../issuer/client-ip.ts';
import { RateLimiter, type RateLimit, Slots } from '../limits.ts';
import { errorKind, type Logger } from '../log.ts';
import type { MailboxStore } from '../mailbox/store.ts';
import type { AddressDirectory, DirectoryEntry } from '../registry/directory.ts';
import { type DeliverLimits, Deliveries, deliverLimitsOf } from './deliver.ts';
import { BUSY, INTERNAL_ERROR, json, NOT_FOUND, rateLimited, type Reply, send } from './reply.ts';

/** API limits. The defaults are provisional. */
export type ApiLimits = {
  /** Requests per IP (all of them, before authentication: bounds signature verification work). */
  perIp: RateLimit;
  /** Authenticated requests per address: only the key holder can use them up. */
  perAddress: RateLimit;
  /** Messages per listing page. */
  pageSize: number;
  /** From this envelope size on, a download holds a slot while it is sent. */
  largeDownloadBytes: number;
  /** Concurrent large downloads. */
  largeDownloadSlots: number;
  /** Deadline to send a whole response; past it the connection is cut. */
  responseTimeoutMs: number;
  /** Open connections to the API server; past it new ones are dropped at once (`server.maxConnections`). */
  maxConnections: number;
  /**
   * How long a signed request for an address the index does not know yet waits for it before the 401. The payer
   * answers a mailbox creation once its transaction is in a block, while the index only learns it from the
   * finalized chain (~15 s later): without this wait the app's first requests for a new address are refused.
   * Unknown addresses are public anyway (the registry is on chain), so waiting reveals nothing. 0: no wait.
   */
  newAddressWaitMs: number;
  /** Requests waiting for a new address at once; past it an unknown address gets its 401 at once. */
  newAddressWaiters: number;
  /** Of those, how many one IP may hold (IPv6 by its /64), so one client cannot take every place. */
  newAddressWaitersPerIp: number;
  /** How often a waiting request looks the address up again. */
  newAddressPollMs: number;
};

export const DEFAULT_API_LIMITS: ApiLimits = {
  perIp: { limit: 600, windowMs: 60_000 },
  perAddress: { limit: 120, windowMs: 60_000 },
  pageSize: 500,
  largeDownloadBytes: 1024 * 1024,
  largeDownloadSlots: 4,
  responseTimeoutMs: 120_000,
  // Well above the delivery slots (64 + 8) and downloads, still a small amount of sockets and memory.
  maxConnections: 512,
  // Finality (~13 s on the devnet) plus the indexer and the registry sync, with room to spare.
  newAddressWaitMs: 25_000,
  newAddressWaiters: 32,
  // The app syncs addresses one at a time; 2 leaves room for a retry still open. Behind Tor, see the top of the file.
  newAddressWaitersPerIp: 2,
  newAddressPollMs: 250,
};

export type ApiDeps = {
  /** Signed host: `canonicalHost(configured base URL)`. */
  host: string;
  directory: Pick<AddressDirectory, 'box'>;
  store: Pick<MailboxStore, 'list' | 'get' | 'envelopeSize' | 'deliver' | 'hasRoomFor'>;
  nonceStore: NonceStore;
  log: Logger;
  limits?: Partial<ApiLimits>;
  /** Limits of the anonymous delivery route. */
  deliverLimits?: Partial<DeliverLimits>;
  /** Current time in milliseconds. */
  now?: () => number;
  /** Whether the address index is up to date (`RegistrySync.healthy`; always true by default). */
  directoryHealthy?: () => boolean;
  /** The client IP for the per-IP limits: the socket's by default, `clientAddress(true)` behind a trusted proxy. */
  clientAddress?: (req: IncomingMessage) => string;
};

export type Route =
  | { kind: 'time' }
  | { kind: 'list'; addrKey: string; since: number }
  | { kind: 'message'; addrKey: string; id: string }
  | { kind: 'deliver'; addrKey: string };

const TIME_PATH = '/v1/time';
const LIST_PATH = /^\/v1\/box\/([0-9a-f]{64})\/messages(?:\?since=(0|[1-9][0-9]{0,14}))?$/;
const MESSAGE_PATH = /^\/v1\/box\/([0-9a-f]{64})\/messages\/([0-9a-f]{32})$/;
const DELIVER_PATH = /^\/v1\/box\/([0-9a-f]{64})\/deliver$/;

/** Route of a request from its raw target; undefined unless it is exactly one of the four. */
export function parseRoute(url: string | undefined): Route | undefined {
  if (url === undefined) return undefined;
  if (url === TIME_PATH) return { kind: 'time' };
  const list = LIST_PATH.exec(url);
  if (list) return { kind: 'list', addrKey: list[1]!, since: Number(list[2] ?? 0) };
  const message = MESSAGE_PATH.exec(url);
  if (message) return { kind: 'message', addrKey: message[1]!, id: message[2]! };
  const deliver = DELIVER_PATH.exec(url);
  return deliver ? { kind: 'deliver', addrKey: deliver[1]! } : undefined;
}

// Errors: fixed body, no details.
const UNAUTHORIZED = json(401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'NightMail-Signature' });
const methodNotAllowed = (allow: string) => json(405, { error: 'method_not_allowed' }, { Allow: allow });
const GET_ONLY = methodNotAllowed('GET');
const POST_ONLY = methodNotAllowed('POST');

type BoxRoute = Extract<Route, { kind: 'list' | 'message' }>;
type Credentials = NonNullable<ReturnType<typeof parseAuthHeaders>>;

class MailboxApi {
  private readonly deps: ApiDeps;
  private readonly limits: ApiLimits;
  private readonly now: () => number;
  private readonly perIp: RateLimiter;
  private readonly perAddress: RateLimiter;
  private readonly downloads: Slots;
  private readonly newAddressWaiters: Slots;
  /** Waiting requests per IP key (absent: none). */
  private readonly waitingByIp = new Map<string, number>();
  private readonly deliveries: Deliveries;
  private readonly clientAddress: (req: IncomingMessage) => string;

  constructor(deps: ApiDeps) {
    this.deps = deps;
    this.limits = { ...DEFAULT_API_LIMITS, ...deps.limits };
    this.now = deps.now ?? Date.now;
    this.perIp = new RateLimiter(this.limits.perIp);
    this.perAddress = new RateLimiter(this.limits.perAddress);
    this.downloads = new Slots(this.limits.largeDownloadSlots);
    this.newAddressWaiters = new Slots(this.limits.newAddressWaiters);
    this.clientAddress = deps.clientAddress ?? clientAddress(false);
    this.deliveries = new Deliveries({
      directory: deps.directory, store: deps.store, log: deps.log, now: this.now, clientAddress: this.clientAddress,
      ...(deps.deliverLimits && { limits: deps.deliverLimits }),
      ...(deps.directoryHealthy && { directoryHealthy: deps.directoryHealthy }),
    });
  }

  /** Whether the request comes from the key holder of `box`: authentic, fresh and not replayed. */
  private authenticate(req: IncomingMessage, box: DirectoryEntry, credentials: Credentials, seconds: number): boolean {
    const { host, nonceStore, log } = this.deps;
    const request = {
      host, version: MAILBOX_API_VERSION, method: req.method!, path: req.url!, addrKey: box.addrKey,
      timestamp: credentials.timestamp, nonce: credentials.nonce,
    };
    const result = authenticateRequest(request, credentials.signature, { authPublicKey: box.authPk, now: seconds, nonceStore });
    if (!result.ok) log.debug(`api: unauthorized (${result.reason})`);
    return result.ok;
  }

  /**
   * The box for an address the index does not know yet, once it learns it (see `newAddressWaitMs`); undefined if it
   * does not within the wait, or too many requests are already waiting. The address only ever comes from the index,
   * which only holds what the finalized chain has: nothing is trusted earlier.
   */
  private async newAddress(addrKeyHex: string, ip: string): Promise<DirectoryEntry | undefined> {
    const { newAddressWaitMs, newAddressPollMs, newAddressWaitersPerIp } = this.limits;
    if (newAddressWaitMs <= 0) return undefined;
    const waiting = this.waitingByIp.get(ip) ?? 0;
    if (waiting >= newAddressWaitersPerIp || !this.newAddressWaiters.tryAcquire()) return undefined;
    this.waitingByIp.set(ip, waiting + 1);
    try {
      const deadline = Date.now() + newAddressWaitMs;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(newAddressPollMs, Math.max(0, deadline - Date.now()))).unref());
        const box = this.deps.directory.box(addrKeyHex);
        if (box) return box;
      }
      return undefined;
    } finally {
      this.newAddressWaiters.release();
      const left = (this.waitingByIp.get(ip) ?? 1) - 1;
      if (left > 0) this.waitingByIp.set(ip, left);
      else this.waitingByIp.delete(ip);
    }
  }

  /** A message's envelope; if large, it holds a slot released once sending finishes. */
  private message(box: DirectoryEntry, id: string): Reply {
    const { store } = this.deps;
    const size = store.envelopeSize(box.addrKey, id);
    if (size === undefined) return NOT_FOUND;
    if (size <= this.limits.largeDownloadBytes) return this.envelope(box, id);
    if (!this.downloads.tryAcquire()) return BUSY;
    try {
      return { ...this.envelope(box, id), release: () => this.downloads.release() };
    } catch (error) {
      this.downloads.release();
      throw error;
    }
  }

  private envelope(box: DirectoryEntry, id: string): Reply {
    const envelope = this.deps.store.get(box.addrKey, id);
    return envelope ? { status: 200, type: 'application/octet-stream', body: envelope } : NOT_FOUND;
  }

  private serve(box: DirectoryEntry, route: BoxRoute): Reply {
    if (route.kind === 'message') return this.message(box, route.id);
    return json(200, this.deps.store.list(box.addrKey, route.since, this.limits.pageSize));
  }

  /**
   * A mailbox route: authenticate, count against that address's limit, then serve. An address the index does not
   * know yet may be one just created: the request waits for it (`newAddress`) before its 401.
   */
  private box(req: IncomingMessage, route: BoxRoute, time: number): Reply | Promise<Reply> {
    const credentials = parseAuthHeaders(req.headers);
    if (!credentials) {
      this.deps.log.debug('api: unauthorized (bad-headers)');
      return UNAUTHORIZED;
    }
    const known = this.deps.directory.box(route.addrKey);
    if (known) return this.authorized(req, route, time, credentials, known);
    return this.newAddress(route.addrKey, ipKey(this.clientAddress(req))).then((box) => {
      if (box) return this.authorized(req, route, time, credentials, box);
      this.deps.log.debug('api: unauthorized (unknown-address)');
      return UNAUTHORIZED;
    });
  }

  /** Authenticates against `box` with the time the request arrived, then counts it and serves it. */
  private authorized(req: IncomingMessage, route: BoxRoute, time: number, credentials: Credentials, box: DirectoryEntry): Reply {
    if (!this.authenticate(req, box, credentials, Math.floor(time / 1000))) return UNAUTHORIZED;
    if (!this.perAddress.hit(route.addrKey, time)) return rateLimited(this.limits.perAddress);
    return this.serve(box, route);
  }

  /** A reply now (the body is not read), or a promise of one from the delivery route (null: connection lost). */
  private route(req: IncomingMessage): Reply | Promise<Reply | null> {
    const time = this.now();
    if (!this.perIp.hit(ipKey(this.clientAddress(req)), time)) return rateLimited(this.limits.perIp);
    const route = parseRoute(req.url);
    if (!route) return NOT_FOUND;
    if (route.kind === 'deliver') return req.method === 'POST' ? this.deliveries.deliver(req, route.addrKey, time) : POST_ONLY;
    if (req.method !== 'GET') return GET_ONLY;
    return route.kind === 'time' ? json(200, { time: Math.floor(time / 1000) }) : this.box(req, route, time);
  }

  private internalError(error: unknown): Reply {
    this.deps.log.warn(`api: internal error (${errorKind(error)})`);
    return INTERNAL_ERROR;
  }

  handle(req: IncomingMessage, res: ServerResponse): void {
    // A pipelined request on the same connection arrives without a socket: the previous one closes the
    // connection (`Connection: close`) so this response could never be sent. It is not processed at all,
    // so it costs no signature check, nonce or slot.
    if (res.socket === null) return;
    let outcome: Reply | Promise<Reply | null>;
    try {
      outcome = this.route(req);
    } catch (error) {
      outcome = this.internalError(error);
    }
    if (!(outcome instanceof Promise)) {
      req.resume(); // the body, if any, is not needed: discarded while the connection closes
      send(res, outcome, this.limits.responseTimeoutMs);
      return;
    }
    void outcome.catch((error: unknown) => this.internalError(error)).then((reply) => {
      if (reply === null || res.destroyed || !res.socket || res.socket.destroyed) res.destroy();
      else send(res, reply, this.limits.responseTimeoutMs);
    });
  }
}

export function createMailboxApi(deps: ApiDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const api = new MailboxApi(deps);
  return (req, res) => api.handle(req, res);
}

/** API HTTP server; the caller runs `listen(port, '127.0.0.1')`. */
export function createApiServer(deps: ApiDeps): http.Server {
  // The request deadline only matters for a delivery body (the other routes answer as soon as the headers are
  // in, which `headersTimeout` bounds). The route cuts a body at `bodyTimeoutMs` at the latest; this is the backstop.
  const requestTimeout = deliverLimitsOf(deps.deliverLimits).bodyTimeoutMs + 5000;
  const { maxConnections } = { ...DEFAULT_API_LIMITS, ...deps.limits };
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1) throw new RangeError('maxConnections: expected a positive integer');
  const server = http.createServer(
    // connectionsCheckingInterval: without it, header and request timeouts are only checked every 30 s.
    { maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout, keepAliveTimeout: 5000, connectionsCheckingInterval: 1000 },
    createMailboxApi(deps),
  );
  server.maxConnections = maxConnections;
  return server;
}
