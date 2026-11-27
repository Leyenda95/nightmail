// Public relayer: checks only a transaction's structure (the node checks proof and execution for free),
// queues it under a ticket the client polls, and forwards it to the local payer as soon as a slot is free
// (at most `maxInFlight` at once). There is no added delay: mailbox creation waits on chain time, and every
// second here would add to it.
//
// Abuse: attempts are counted before deserializing, the expensive step. Node rejections cost the sender
// nothing, so each one refunds the global quota but counts as a client fault, with its own global cap.
// Faults are charged provisionally on accept, or a burst would get in before the first rejection.
// Validating proofs here is required before opening the service to the public.
//
// Privacy: IPs, tickets and included transaction hashes are never logged; client keys live in memory only.
import { createHash, randomBytes } from 'node:crypto';
import { RateLimiter } from '../limits.ts';
import { errorKind, type Logger, silentLogger } from '../log.ts';
import { checkRelayable, intentTtlMs, type RelayRefusal } from './validate.ts';

export type RelayerLimits = {
  /** Accepted submissions per client per hour. */
  perIpPerHour: number;
  /** Accepted submissions per hour in total (a node rejection refunds it). */
  globalPerHour: number;
  /** Submissions that reach deserialization per client per hour, valid or not. */
  attemptsPerIpPerHour: number;
  /**
   * Rejections (node, or payer 422) per client per hour, then blocked for the rest of the hour. In-flight
   * submissions count as provisional faults, so this also caps concurrent submissions per key (behind a shared
   * IP or an untrusted proxy, the next one waits 60 s).
   */
  faultsPerIpPerHour: number;
  /** Rejections (node, or payer 422) per hour in total; on reaching it, `busy` for everyone for the rest of the hour. */
  rejectedPerHour: number;
};

export type RelayerDeps = {
  payer: { relay(txHex: string): Promise<{ status: number; body: unknown }> };
  /** Address (hex) of our registry. */
  registry: string;
  /** Deserializes a transaction; throws if the bytes are not one. */
  parse(bytes: Uint8Array): object;
  /** Missing ones default to DEFAULT_RELAYER_LIMITS. */
  limits?: Partial<RelayerLimits>;
  maxInFlight?: number;
  now?: () => number;
  log?: Logger;
  /** Called each time a forward ends `included` (registry/settling.ts: the index may not hold its address yet). */
  onIncluded?: () => void;
};

export type SubmitResult =
  | { ticket: string }
  | { error: 'bad-request' | 'invalid-tx' | 'duplicate' }
  | { error: 'not-relayable'; reason: RelayRefusal }
  | { error: 'rate-limited' | 'busy'; retryAfterS: number };

/** How a forward ended (what the client sees in `status`). */
export type RelayOutcome =
  | { outcome: 'included'; txHash: string }
  | { outcome: 'rejected'; code: number | null }
  | { outcome: 'unknown'; txHash?: string; validUntil?: number }
  | { outcome: 'failed'; status: string; txHash: string }
  | { outcome: 'refused'; error: string }
  | { outcome: 'busy'; retryAfterS: number }
  /** Too little time left to land in a block when it left the queue: not sent (the client must prove again). */
  | { outcome: 'expired' };

export type TicketStatus = { state: 'queued' } | ({ state: 'done' } & RelayOutcome);

/** Provisional values: production limits are not decided yet. */
export const DEFAULT_RELAYER_LIMITS: RelayerLimits = {
  perIpPerHour: 20, globalPerHour: 300, attemptsPerIpPerHour: 60, faultsPerIpPerHour: 3, rejectedPerHour: 100,
};
/** Real calls are ~6 KiB; the payer accepts up to 256 KiB of JSON. */
export const MAX_TX_BYTES = 32 * 1024;

const HOUR_MS = 3_600_000;
const HOUR_S = 3600;
const BUSY_RETRY_S = 60;
const UNKNOWN_GRACE_MS = 60_000;
/** Max lifetime of a sent transaction with no clear answer (the validity the payer sets). */
const SENT_VALIDITY_MS = 30 * 60_000;
/** A rejection may be state-dependent: the same bytes may be valid shortly after. */
const REJECTED_HOLD_MS = 2 * 60_000;
const CLOSE_TIMEOUT_MS = 60_000;
/**
 * With less than this left until its ttl when leaving the queue, it is not sent: the payer still has its own
 * queue (up to maxInFlight forwards in series at ~20 s each) and must balance and submit.
 */
const SEND_MARGIN_MS = 3 * 60_000;
/** How often expired rate-limiter windows (client keys) are swept. */
const SWEEP_EVERY_MS = 60_000;
const HEX_RE = /^(?:[0-9a-f]{2})*$/;
/** Connection errors that guarantee the payer received nothing. */
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOENT']);

type Refused = Exclude<SubmitResult, { ticket: string }>;
const rateLimited = (retryAfterS: number): Refused => ({ error: 'rate-limited', retryAfterS });
const RATE_LIMITED = rateLimited(HOUR_S);
const BUSY: Refused = { error: 'busy', retryAfterS: BUSY_RETRY_S };
const seconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000));

/**
 * How an outcome is charged: never sent costs no quota; a rejection (node or payer) refunds the global quota
 * and is a client fault; anything sent is charged.
 */
type Charge = 'not-sent' | 'fault' | 'sent';
const CHARGE: Record<RelayOutcome['outcome'], Charge> = {
  busy: 'not-sent', expired: 'not-sent', rejected: 'fault', refused: 'fault', included: 'sent', failed: 'sent', unknown: 'sent',
};
const INVALID_TX: Refused = { error: 'invalid-tx' };

type Entry = { state: 'queued' } | { state: 'done'; result: RelayOutcome; expires: number };
/**
 * Held bytes: `until` is null while queued or in flight; once answered, until when the same ticket is returned
 * without forwarding again. `ids`: the transaction identifiers (the same intent with other bytes is a duplicate).
 */
type Hold = { ticket: string; until: number | null; ids: string[] };
type Job = { ticket: string; hash: string; txHex: string; key: string; acceptedAt: number; ttl: number; ids: string[] };
type Reply = { status: number; body: unknown };
type Inspected = { ids: string[]; ttl: number };

const field = (body: unknown, key: string): unknown => (typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[key] : undefined);
const text = (body: unknown, key: string) => (typeof field(body, key) === 'string' ? (field(body, key) as string) : undefined);
const number = (body: unknown, key: string) => (typeof field(body, key) === 'number' ? (field(body, key) as number) : undefined);
const retryAfter = (body: unknown) => number(body, 'retryAfterS') ?? BUSY_RETRY_S;
const notSent = (error: unknown) => NOT_SENT_CODES.has(String((error as { code?: unknown } | null)?.code));
const freeTx = (tx: object) => (tx as { free?: () => void }).free?.();
/** Lowercase, even-length, non-empty hex of at most MAX_TX_BYTES. */
const wellFormedHex = (txHex: string) => txHex !== '' && txHex.length <= MAX_TX_BYTES * 2 && HEX_RE.test(txHex);

/** Maps a payer 200 reply to an outcome; undefined if it doesn't have the expected shape. */
function sentOutcome(body: unknown): RelayOutcome | undefined {
  const status = text(body, 'status');
  const txHash = text(body, 'txHash');
  if (status === 'rejected') return { outcome: 'rejected', code: number(body, 'code') ?? null };
  if (status === undefined || txHash === undefined) return undefined;
  if (status === 'SucceedEntirely') return { outcome: 'included', txHash };
  const validUntil = number(body, 'validUntil');
  if (status === 'unknown') return { outcome: 'unknown', txHash, ...(validUntil !== undefined && { validUntil }) };
  return { outcome: 'failed', status, txHash };
}

/** Maps a payer reply to a ticket outcome; undefined if unrecognized (becomes `unknown`, with a warning). */
function mapReply({ status, body }: Reply): RelayOutcome | undefined {
  if (status === 200) return sentOutcome(body);
  if (status === 422) return { outcome: 'refused', error: text(body, 'error') ?? 'unknown' };
  if (status === 429 || status === 503) return { outcome: 'busy', retryAfterS: retryAfter(body) };
  return undefined;
}

export class Relayer {
  private readonly deps: RelayerDeps;
  private readonly maxInFlight: number;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly perIp: RateLimiter;
  private readonly global: RateLimiter;
  private readonly attempts: RateLimiter;
  /** Faults per client: confirmed ones plus, provisionally, its submissions still in flight. */
  private readonly faults: RateLimiter;
  private readonly rejected: RateLimiter;
  /** In-flight submissions per client (their faults are provisional). */
  private readonly pending = new Map<string, number>();
  private readonly tickets = new Map<string, Entry>();
  private readonly holds = new Map<string, Hold>();
  /** Transaction identifier -> hash of the held bytes that carry it. */
  private readonly heldIds = new Map<string, string>();
  private readonly queue: Job[] = [];
  private readonly running = new Set<Promise<void>>();
  private closing = false;
  private sweptAt = Number.NEGATIVE_INFINITY;

  constructor(deps: RelayerDeps) {
    this.deps = deps;
    const limits = { ...DEFAULT_RELAYER_LIMITS, ...deps.limits };
    this.maxInFlight = deps.maxInFlight ?? 8;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? silentLogger;
    const perHour = (limit: number) => new RateLimiter({ limit, windowMs: HOUR_MS });
    this.perIp = perHour(limits.perIpPerHour);
    this.global = perHour(limits.globalPerHour);
    this.attempts = perHour(limits.attemptsPerIpPerHour);
    this.faults = perHour(limits.faultsPerIpPerHour);
    this.rejected = perHour(limits.rejectedPerHour);
  }

  /**
   * Deserializes and checks the transaction, always freeing it. Returns its identifiers and ttl, or the error.
   * Top-level fields are read once: every read of a WASM object creates a copy that only the GC frees.
   */
  private inspect(bytes: Uint8Array, time: number): Inspected | Refused {
    let tx: Record<string, unknown> & { identifiers(): unknown[] };
    try {
      tx = this.deps.parse(bytes) as typeof tx;
    } catch {
      return INVALID_TX;
    }
    try {
      const view = { intents: tx['intents'], guaranteedOffer: tx['guaranteedOffer'], fallibleOffer: tx['fallibleOffer'], rewards: tx['rewards'] } as Parameters<typeof checkRelayable>[0];
      const reason = checkRelayable(view, this.deps.registry, time);
      if (reason) return { error: 'not-relayable', reason };
      const ids = tx.identifiers().map(String);
      return ids.length > 0 ? { ids, ttl: intentTtlMs(view)! } : INVALID_TX;
    } catch {
      return INVALID_TX;
    } finally {
      freeTx(tx);
    }
  }

  /** The ticket for these exact bytes if they are still held and the ticket exists. */
  private existing(hash: string): string | undefined {
    const ticket = this.holds.get(hash)?.ticket;
    return ticket !== undefined && this.tickets.has(ticket) ? ticket : undefined;
  }

  /** The service accepts nothing right now (closing, queue full, or hourly rejection cap); checked before deserializing. */
  private unavailable(time: number): Refused | undefined {
    if (this.closing || this.queue.length >= this.maxInFlight * 4) return BUSY;
    return this.rejected.allows('all', time) ? undefined : { error: 'busy', retryAfterS: seconds(this.rejected.resetIn('all', time)) };
  }

  /**
   * A client with too many faults or attempts this hour (the attempt is counted if it passes). If its faults
   * include in-flight submissions, it is told to retry soon: they may turn out not to be faults.
   */
  private blocked(key: string, time: number): Refused | undefined {
    if (!this.faults.allows(key, time)) return this.pending.has(key) ? rateLimited(BUSY_RETRY_S) : rateLimited(seconds(this.faults.resetIn(key, time)));
    return this.attempts.hit(key, time) ? undefined : rateLimited(seconds(this.attempts.resetIn(key, time)));
  }

  /** Quota refusal (without consuming quota), or undefined. */
  private overQuota(key: string, time: number): Refused | undefined {
    return this.global.allows('all', time) && this.perIp.allows(key, time) ? undefined : RATE_LIMITED;
  }

  submit(txHex: string, clientKey: string): SubmitResult {
    const time = this.now();
    this.purge(time);
    if (!wellFormedHex(txHex)) return { error: 'bad-request' };
    const bytes = Buffer.from(txHex, 'hex');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const known = this.existing(hash);
    if (known !== undefined) return { ticket: known };
    const inspected = this.unavailable(time) ?? this.blocked(clientKey, time) ?? this.inspect(bytes, time);
    if ('error' in inspected) return inspected;
    if (inspected.ids.some((id) => this.heldIds.has(id))) return { error: 'duplicate' };
    const refused = this.overQuota(clientKey, time);
    if (refused) return refused;
    return this.accept({ ticket: randomBytes(16).toString('hex'), hash, txHex, key: clientKey, acceptedAt: time, ...inspected });
  }

  private accept(job: Job): SubmitResult {
    this.global.hit('all', job.acceptedAt);
    this.perIp.hit(job.key, job.acceptedAt);
    this.faults.hit(job.key, job.acceptedAt); // provisional until the outcome is known
    this.pending.set(job.key, (this.pending.get(job.key) ?? 0) + 1);
    this.tickets.set(job.ticket, { state: 'queued' });
    this.hold(job.hash, { ticket: job.ticket, until: null, ids: job.ids });
    this.queue.push(job);
    this.pump();
    return { ticket: job.ticket };
  }

  status(ticket: string): TicketStatus | undefined {
    this.purge(this.now());
    const entry = this.tickets.get(ticket);
    if (!entry) return undefined;
    return entry.state === 'queued' ? { state: 'queued' } : { state: 'done', ...entry.result };
  }

  private hold(hash: string, hold: Hold): void {
    this.holds.set(hash, hold);
    for (const id of hold.ids) this.heldIds.set(id, hash);
  }

  private release(hash: string): void {
    for (const id of this.holds.get(hash)?.ids ?? []) if (this.heldIds.get(id) === hash) this.heldIds.delete(id);
    this.holds.delete(hash);
  }

  /**
   * Drops tickets finished over an hour ago and bytes no longer held; once a minute, also the expired
   * rate-limiter windows (client keys).
   */
  private purge(time: number): void {
    for (const [ticket, entry] of this.tickets) if (entry.state === 'done' && entry.expires <= time) this.tickets.delete(ticket);
    for (const [hash, hold] of this.holds) if (hold.until !== null && hold.until <= time) this.release(hash);
    if (time - this.sweptAt < SWEEP_EVERY_MS) return;
    this.sweptAt = time;
    for (const limiter of [this.perIp, this.global, this.attempts, this.faults, this.rejected]) limiter.sweep(time);
  }

  private pump(): void {
    while (!this.closing && this.running.size < this.maxInFlight && this.queue.length > 0) {
      const job = this.queue.shift()!;
      const done = this.run(job).finally(() => {
        this.running.delete(done);
        this.pump();
      });
      this.running.add(done);
    }
  }

  private async run(job: Job): Promise<void> {
    // A job that waited too long for a free slot is not sent: it could no longer land.
    const late = this.now() > job.ttl - SEND_MARGIN_MS;
    this.finish(job, late ? { outcome: 'expired' } : await this.forward(job.txHex));
  }

  private async forward(txHex: string): Promise<RelayOutcome> {
    let reply: Reply;
    try {
      reply = await this.deps.payer.relay(txHex);
    } catch (error) {
      this.log.warn(`relayer: payer unreachable (${errorKind(error)})`);
      // Only a failed connect guarantees it wasn't sent; a mid-request drop or timeout may have left it in the mempool.
      return notSent(error) ? { outcome: 'busy', retryAfterS: BUSY_RETRY_S } : { outcome: 'unknown' };
    }
    const outcome = mapReply(reply);
    if (!outcome) {
      this.log.warn(`relayer: unexpected payer reply (HTTP ${reply.status})`);
      return { outcome: 'unknown' };
    }
    this.warnIfOdd(outcome);
    return outcome;
  }

  /** `unknown` and `failed` are logged with their hash so the operator can follow them up. */
  private warnIfOdd(outcome: RelayOutcome): void {
    if (outcome.outcome === 'unknown' && outcome.txHash !== undefined) this.log.warn(`relayer: sent with unknown outcome (tx ${outcome.txHash})`);
    if (outcome.outcome === 'failed') this.log.warn(`relayer: failed in block, ${outcome.status} (tx ${outcome.txHash})`);
  }

  /**
   * Until when bytes with this outcome return the same ticket without being forwarded again, or null if they may
   * be retried now. Resending answered bytes is pointless (the node would reject them) and could lock operator
   * DUST for 3 h (see `releaseDust` in chain/midnight.ts). Never beyond the ticket's lifetime.
   */
  private holdUntil(result: RelayOutcome, job: Job, time: number, expires: number): number | null {
    switch (result.outcome) {
      case 'busy': case 'expired': return null;
      case 'rejected': return time + REJECTED_HOLD_MS;
      case 'unknown': return Math.min(expires, (result.validUntil ?? Math.max(job.ttl, time + SENT_VALIDITY_MS)) + UNKNOWN_GRACE_MS);
      default: return expires;
    }
  }

  /** Settles client and global counters according to the outcome (CHARGE). */
  private settle(job: Job, result: RelayOutcome, time: number): void {
    const left = (this.pending.get(job.key) ?? 1) - 1;
    if (left > 0) this.pending.set(job.key, left);
    else this.pending.delete(job.key);
    const charge = CHARGE[result.outcome];
    if (charge === 'fault') {
      this.global.refund('all', job.acceptedAt);
      this.rejected.hit('all', time);
      // Confirm the provisional fault in the current window (if the accept-time window has ended it would count for nothing).
      this.faults.refund(job.key, job.acceptedAt);
      this.faults.hit(job.key, time);
      return;
    }
    this.faults.refund(job.key, job.acceptedAt);
    if (charge === 'sent') return;
    this.global.refund('all', job.acceptedAt);
    this.perIp.refund(job.key, job.acceptedAt);
  }

  private finish(job: Job, result: RelayOutcome): void {
    // Before the client can read the ticket: from then on it may use (and share) the new address.
    if (result.outcome === 'included') this.deps.onIncluded?.();
    const time = this.now();
    const expires = time + HOUR_MS;
    this.tickets.set(job.ticket, { state: 'done', result, expires });
    this.settle(job, result, time);
    const until = this.holdUntil(result, job, time, expires);
    if (until === null) this.release(job.hash);
    else this.hold(job.hash, { ticket: job.ticket, until, ids: job.ids });
  }

  /** Stops accepting and waits for in-flight forwards (60 s at most). Queued ones are dropped unsent. */
  async close(): Promise<void> {
    this.closing = true;
    this.queue.length = 0;
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
      timer.unref();
    });
    await Promise.race([Promise.allSettled([...this.running]), limit]);
    clearTimeout(timer);
  }
}
