// Issuer API, separate from the Mailbox API (own port and lifecycle):
//
//   POST /v1/bono/free    {id, captchaToken}              free plan after CAPTCHA (simulated in the MVP)
//   POST /v1/bono/fiat    {id, cardToken}                 simulated paid plan (Night Plus, no period). Clients from
//                                                         before still send period = monthly | annual: accepted, ignored
//   POST /v1/bono/status  {id}                            receipt and state of a request
//
// The id never goes in the URL, where proxy logs would pair it with the IP.
// Order: validate -> known id (same receipt, skips CAPTCHA and limits; other plan: 409) -> too many pending
// (503, so no receipt is signed that the payer cannot honor in time) -> CAPTCHA/card -> rate limits -> create.
// A failed request is not "known": a new POST goes through CAPTCHA and limits again.
// Per-client limits live in memory only, never stored or logged. Errors have a fixed body.
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { RateLimiter, type RateLimit } from '../limits.ts';
import type { Logger } from '../log.ts';
import { clientKey } from './client-ip.ts';
import { fail, json, readJsonObject, type Reply, respond } from './http.ts';
import type { Issuer } from './issuer.ts';
import type { IssuePlan } from './payer-client.ts';
import type { ReceiptSigner } from './receipt.ts';
import type { BonoRequest } from './store.ts';

const DAY_MS = 86_400_000;

/** Limits. The defaults are provisional. */
export type IssuerLimits = {
  /** All requests per client. */
  perIpAll: RateLimit;
  /** Free-plan sign-ups per client. */
  freePerIp: RateLimit;
  /** Paid-plan sign-ups per client (separate counter, since the demo token is public). */
  paidPerIp: RateLimit;
  /** Sign-ups (free and paid) from everyone: bounds DUST spending even if clients rotate IPs. */
  global: RateLimit;
  /** With this many pending (queued + retrying), new sign-ups get 503 busy. */
  maxPending: number;
  /** retryAfterS for that 503. */
  busyRetryAfterS: number;
  maxConnections: number;
  maxBodyBytes: number;
  responseTimeoutMs: number;
};

export const DEFAULT_ISSUER_LIMITS: IssuerLimits = {
  perIpAll: { limit: 600, windowMs: 60_000 },
  freePerIp: { limit: 3, windowMs: DAY_MS },
  paidPerIp: { limit: 3, windowMs: DAY_MS },
  global: { limit: 100, windowMs: 3_600_000 },
  maxPending: 100,
  busyRetryAfterS: 300,
  maxConnections: 256,
  maxBodyBytes: 4096,
  responseTimeoutMs: 30_000,
};

export type IssuerApiDeps = {
  issuer: Pick<Issuer, 'submit' | 'lookup' | 'pendingCount'>;
  /** Ed25519 public key and contract of the receipts. */
  signer: Pick<ReceiptSigner, 'publicKey' | 'contract'>;
  /** CAPTCHA and card checks (simulated in the MVP). */
  checks: { captcha(token: string): boolean; card(token: string): boolean };
  log: Logger;
  limits?: Partial<IssuerLimits>;
  now?: () => number;
  /** Per-client rate-limit key; defaults to the socket IP (IPv6 grouped by /64). */
  clientKey?: (req: IncomingMessage) => string;
};

type RouteKind = 'free' | 'fiat' | 'status';
type Signup = { plan: IssuePlan; id: string; token: string };

const ID_RE = /^[0-9a-f]{64}$/;
/** The `period` that clients from before Night Plus still send on `fiat` (validated, then ignored). */
const LEGACY_PERIODS: readonly string[] = ['monthly', 'annual'];
const ROUTES = new Map<string, RouteKind>([['/v1/bono/free', 'free'], ['/v1/bono/fiat', 'fiat'], ['/v1/bono/status', 'status']]);

export const parseRoute = (url: string | undefined): RouteKind | undefined => ROUTES.get(url ?? '');

const NOT_FOUND = fail(404, 'not_found');
const BAD_REQUEST = fail(400, 'bad_request');
const CONFLICT = fail(409, 'id_conflict');
const METHOD_NOT_ALLOWED = fail(405, 'method_not_allowed', { Allow: 'POST' });
const rateLimited = (limit: RateLimit) => fail(429, 'rate_limited', { 'Retry-After': String(Math.ceil(limit.windowMs / 1000)) });

const hasExactly = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((k) => typeof value[k] === 'string');

/** Sign-up fields, or undefined if any field is extra, missing or invalid. */
function parseSignup(kind: 'free' | 'fiat', body: Record<string, unknown>): Signup | undefined {
  const free = kind === 'free';
  const legacy = !free && 'period' in body;
  const keys = free ? ['id', 'captchaToken'] : legacy ? ['id', 'cardToken', 'period'] : ['id', 'cardToken'];
  if (!hasExactly(body, keys)) return undefined;
  const id = body['id'] as string;
  if (!ID_RE.test(id) || (legacy && !LEGACY_PERIODS.includes(body['period'] as string))) return undefined;
  return { plan: free ? 'free' : 'paid', id, token: body[free ? 'captchaToken' : 'cardToken'] as string };
}

class IssuerApi {
  private readonly deps: IssuerApiDeps;
  private readonly limits: IssuerLimits;
  private readonly now: () => number;
  private readonly clientKey: (req: IncomingMessage) => string;
  private readonly perIpAll: RateLimiter;
  private readonly perIp: Record<IssuePlan, { limiter: RateLimiter; limit: RateLimit }>;
  private readonly global: RateLimiter;

  constructor(deps: IssuerApiDeps) {
    this.deps = deps;
    this.limits = { ...DEFAULT_ISSUER_LIMITS, ...deps.limits };
    this.now = deps.now ?? Date.now;
    this.clientKey = deps.clientKey ?? clientKey(false);
    this.perIpAll = new RateLimiter(this.limits.perIpAll);
    const perPlan = (limit: RateLimit) => ({ limiter: new RateLimiter(limit), limit });
    this.perIp = { free: perPlan(this.limits.freePerIp), paid: perPlan(this.limits.paidPerIp) };
    this.global = new RateLimiter({ ...this.limits.global, maxKeys: 1 });
  }

  private receipt(request: BonoRequest): Reply {
    const { publicKey, contract } = this.deps.signer;
    return json(200, {
      id: request.id, plan: request.plan, state: request.state,
      receipt: {
        contract, period: request.period ?? 'none', insertBy: request.insertBy,
        signature: request.signature.toString('hex'), publicKey: publicKey.toString('hex'),
      },
    });
  }

  /** What is known about the id: its receipt, 409 for the other plan, or undefined (unknown or failed: continue sign-up). */
  private known(signup: Signup): Reply | undefined {
    const existing = this.deps.issuer.lookup(signup.id);
    if (!existing) return undefined;
    if (existing.plan !== signup.plan) return CONFLICT;
    return existing.state === 'failed' ? undefined : this.receipt(existing);
  }

  /** 503 when so many requests are pending that the payer couldn't meet a new receipt's deadline. */
  private busy(): Reply | undefined {
    if (this.deps.issuer.pendingCount() < this.limits.maxPending) return undefined;
    const retryAfterS = this.limits.busyRetryAfterS;
    return json(503, { error: 'busy', retryAfterS }, { 'Retry-After': String(retryAfterS) });
  }

  private unpaid(signup: Signup): Reply | undefined {
    const { checks } = this.deps;
    if (signup.plan === 'free') return checks.captcha(signup.token) ? undefined : fail(403, 'captcha_failed');
    return checks.card(signup.token) ? undefined : fail(402, 'payment_failed');
  }

  /** Charges the sign-up against the global and per-client plan limits. A refusal consumes no quota. */
  private admit(plan: IssuePlan, key: string, time: number): Reply | undefined {
    const perIp = this.perIp[plan];
    if (!this.global.allows('all', time)) return rateLimited(this.limits.global);
    if (!perIp.limiter.allows(key, time)) return rateLimited(perIp.limit);
    this.global.hit('all', time);
    perIp.limiter.hit(key, time);
    return undefined;
  }

  private signup(kind: 'free' | 'fiat', body: Record<string, unknown>, key: string, time: number): Reply {
    const signup = parseSignup(kind, body);
    if (!signup) return BAD_REQUEST;
    const reply = this.known(signup) ?? this.busy() ?? this.unpaid(signup) ?? this.admit(signup.plan, key, time);
    if (reply) return reply;
    const result = this.deps.issuer.submit(signup.id, signup.plan, null);
    return result.ok ? this.receipt(result.request) : CONFLICT;
  }

  private status(body: Record<string, unknown>): Reply {
    if (!hasExactly(body, ['id']) || !ID_RE.test(body['id'] as string)) return BAD_REQUEST;
    const request = this.deps.issuer.lookup(body['id'] as string);
    return request ? this.receipt(request) : NOT_FOUND;
  }

  private route(req: IncomingMessage): Promise<Reply> | Reply {
    const time = this.now();
    const key = this.clientKey(req);
    if (!this.perIpAll.hit(key, time)) return rateLimited(this.limits.perIpAll);
    const kind = parseRoute(req.url);
    if (!kind) return NOT_FOUND;
    return req.method === 'POST' ? this.dispatch(req, kind, key, time) : METHOD_NOT_ALLOWED;
  }

  private async dispatch(req: IncomingMessage, kind: RouteKind, key: string, time: number): Promise<Reply> {
    const body = await readJsonObject(req, this.limits.maxBodyBytes);
    if (!body.ok) return body.reply;
    return kind === 'status' ? this.status(body.value) : this.signup(kind, body.value, key, time);
  }

  handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return respond(res, async () => this.route(req), { label: 'issuer-api', log: this.deps.log, timeoutMs: this.limits.responseTimeoutMs });
  }
}

export function createIssuerApi(deps: IssuerApiDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const api = new IssuerApi(deps);
  return (req, res) => api.handle(req, res);
}

/** Issuer HTTP server; the caller does `listen(port, '127.0.0.1')`. */
export function createIssuerServer(deps: IssuerApiDeps): http.Server {
  const server = http.createServer(
    { maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 10_000, keepAliveTimeout: 5000, connectionsCheckingInterval: 1000 },
    createIssuerApi(deps),
  );
  server.maxConnections = deps.limits?.maxConnections ?? DEFAULT_ISSUER_LIMITS.maxConnections;
  return server;
}
