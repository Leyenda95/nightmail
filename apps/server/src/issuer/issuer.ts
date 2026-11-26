// The Issuer stores authorized `bono` requests with a signed receipt and issues them through the payer,
// serially, after a random delay. Idempotent by id: the payer checks the tree first, so retries never
// create a second leaf.
// Retries: `pending` waits without blocking others; `unavailable` pauses the whole queue (each attempt
// costs the payer a proof); free failures retry up to 5 times, `fee-lost` once, then the request stays
// `failed` until a new POST requeues it.
import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { errorKind, type Logger } from '../log.ts';
import type { IssuePlan, PayerClient } from './payer-client.ts';
import type { ReceiptSigner } from './receipt.ts';
import type { BonoRequest, IssuerStore, Period } from './store.ts';

/** Receipt validity: the payer's worst case (~61 min) plus margin. A default, can be changed. */
export const RECEIPT_VALIDITY_S = 3900;
const MAX_RANDOM_DELAY_MS = 30_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 15 * 60_000;
const RETRY_AFTER_MAX_MS = 35 * 60_000;
const CLOSE_TIMEOUT_MS = 60_000;
const HOUR_MS = 3_600_000;
/** The only statuses that count as issued (an allowlist, so a new payer status never does). */
const ISSUED: ReadonlySet<string> = new Set(['issued', 'already-issued']);
/** Own retries of a `failed` outcome by reason (none for other reasons). */
const FAILED_RETRIES =new Map<string, number>([['rejected', 5], ['not-prepared', 5], ['fee-lost', 1]]);

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export type IssuerDeps = {
  store: Pick<IssuerStore, 'get' | 'create' | 'setState' | 'requeue' | 'pending' | 'countPending'>;
  payer: PayerClient;
  signer: Pick<ReceiptSigner, 'sign'>;
  log: Logger;
  /** Time in milliseconds. */
  now?: () => number;
  /** Random delay before each request's first issue attempt. */
  delayMs?: () => number;
  /** Abortable sleep; does not throw when aborted. */
  sleep?: Sleep;
  /** How long `close()` waits for the issue in progress. */
  closeTimeoutMs?: number;
};

export type SubmitResult = { ok: true; request: BonoRequest } | { ok: false; error: 'id_conflict' };

const defaultSleep: Sleep = (ms, signal) => delay(ms, undefined, { signal }).catch(() => undefined);
const backoff = (attempt: number) => Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
const retryAfterMs = (retryAfterS: number | undefined, attempt: number) =>
  retryAfterS === undefined ? backoff(attempt) : Math.min(retryAfterS * 1000, RETRY_AFTER_MAX_MS);

/** Insert-by deadline: now + validity, rounded up to the minute so the exact time is not recorded. */
export const insertByOf = (nowMs: number) => Math.ceil((nowMs / 1000 + RECEIPT_VALIDITY_S) / 60) * 60;

export class Issuer {
  private readonly deps: Required<IssuerDeps>;
  private readonly queue: string[] = [];
  /** Per-id retry counts (in memory): `pending`/exception retries and `failed` retries. */
  private readonly attempts = new Map<string, number>();
  private readonly failures = new Map<string, number>();
  private readonly waiting = new Set<Promise<void>>();
  private readonly abort = new AbortController();
  /** Consecutive queue pauses (payer unavailable). */
  private pauses = 0;
  private busy = false;
  private running: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(deps: IssuerDeps) {
    this.deps = {
      now: Date.now, delayMs: () => randomInt(0, MAX_RANDOM_DELAY_MS), sleep: defaultSleep, closeTimeoutMs: CLOSE_TIMEOUT_MS, ...deps,
    };
  }

  lookup(id: string): BonoRequest | undefined {
    return this.deps.store.get(id);
  }

  /** Pending requests (queued or waiting to retry). */
  pendingCount(): number {
    return this.deps.store.countPending();
  }

  /**
   * Records the request (or returns the existing one for that id). A failed one is requeued with a new receipt.
   * The caller has already checked CAPTCHA/payment, limits and the pending backlog.
   */
  submit(id: string, plan: IssuePlan, period: Period | null): SubmitResult {
    const { store } = this.deps;
    const existing = store.get(id);
    if (!existing) return this.create(id, plan, period);
    if (existing.plan !== plan) return { ok: false, error: 'id_conflict' };
    if (existing.state === 'failed') this.requeue(existing);
    return { ok: true, request: store.get(id)! };
  }

  /** On startup: resumes requests left pending on disk. */
  resume(): void {
    for (const { id } of this.deps.store.pending()) this.schedule(id, this.deps.delayMs());
  }

  /** Waits until nothing is queued or waiting (for tests and shutdown). */
  async idle(): Promise<void> {
    while (this.busy || this.waiting.size > 0) await Promise.all([this.running, ...this.waiting]);
  }

  /**
   * Stops: aborts waits and lets the issue in progress finish for at most `closeTimeoutMs` (the payer may
   * take up to 30 min). Pending requests remain on disk.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.abort.abort();
    const timeout = new AbortController();
    const timedOut = delay(this.deps.closeTimeoutMs, true, { signal: timeout.signal, ref: false }).catch(() => false);
    const late = await Promise.race([this.idle().then(() => false), timedOut]);
    timeout.abort();
    if (late) this.deps.log.warn('issuer: an issue is still in flight after the close timeout; closing anyway (it stays pending on disk)');
  }

  private receipt(id: string, plan: IssuePlan, period: Period | null): { insertBy: number; signature: Buffer } {
    const insertBy = insertByOf(this.deps.now());
    return { insertBy, signature: this.deps.signer.sign({ id, plan, period: period ?? 'none', insertBy: BigInt(insertBy) }) };
  }

  private create(id: string, plan: IssuePlan, period: Period | null): SubmitResult {
    const createdAt = Math.floor(this.deps.now() / HOUR_MS) * HOUR_MS;
    const request: BonoRequest = { id, plan, period, state: 'pending', createdAt, ...this.receipt(id, plan, period) };
    this.deps.store.create(request);
    this.schedule(id, this.deps.delayMs());
    return { ok: true, request };
  }

  private requeue({ id, plan, period }: BonoRequest): void {
    const { insertBy, signature } = this.receipt(id, plan, period);
    this.deps.store.requeue(id, insertBy, signature);
    this.schedule(id, this.deps.delayMs());
  }

  /** Waits `ms` (without blocking the queue), then enqueues the id. */
  private schedule(id: string, ms: number): void {
    if (this.closed) return;
    const wait = this.deps.sleep(ms, this.abort.signal).then(() => {
      if (!this.closed) this.enqueue(id);
    });
    this.waiting.add(wait);
    void wait.finally(() => this.waiting.delete(wait));
  }

  private enqueue(id: string): void {
    this.queue.push(id);
    if (this.busy) return;
    this.busy = true;
    this.running = this.work();
  }

  private async work(): Promise<void> {
    try {
      for (let id = this.queue.shift(); id !== undefined && !this.closed; id = this.queue.shift()) {
        const pauseMs = await this.process(id);
        if (pauseMs === undefined) continue;
        this.queue.unshift(id); // the same id stays first after the pause
        await this.deps.sleep(pauseMs, this.abort.signal);
      }
    } finally {
      this.busy = false;
    }
  }

  /** One attempt; returns how long to pause the queue, or undefined. An exception retries the id later. */
  private async process(id: string): Promise<number | undefined> {
    try {
      return await this.attempt(id);
    } catch (error) {
      this.deps.log.warn(`issuer: could not process a request, will retry it (${errorKind(error)})`);
      this.retryLater(id, undefined);
      return undefined;
    }
  }

  private async attempt(id: string): Promise<number | undefined> {
    const request = this.deps.store.get(id);
    if (request?.state !== 'pending') return undefined;
    const outcome = await this.deps.payer.issue(id, request.plan);
    if (outcome.status === 'unavailable') return this.pause(outcome.reason, outcome.retryAfterS);
    this.pauses = 0;
    if (outcome.status === 'pending') this.retryLater(id, outcome.retryAfterS);
    else if (outcome.status === 'failed') this.failed(id, outcome.reason);
    else if (ISSUED.has(outcome.status)) this.issued(id);
    else this.retryLater(id, undefined); // an unknown status is never treated as issued
    return undefined;
  }

  private pause(reason: string, retryAfterS: number | undefined): number {
    const ms = retryAfterMs(retryAfterS, this.pauses);
    this.pauses += 1;
    this.deps.log.warn(`issuer: the payer is not available (${reason}), pausing the queue for ${Math.ceil(ms / 1000)} s`);
    return ms;
  }

  private issued(id: string): void {
    this.deps.store.setState(id, 'issued');
    this.forget(id);
    this.deps.log.info('issuer: bono issued');
  }

  private failed(id: string, reason: string): void {
    const tries = this.failures.get(id) ?? 0;
    if (tries < (FAILED_RETRIES.get(reason) ?? 0)) {
      this.failures.set(id, tries + 1);
      this.deps.log.warn(`issuer: bono issue failed (${reason}), retrying with the same receipt`);
      this.schedule(id, backoff(tries));
      return;
    }
    this.deps.store.setState(id, 'failed');
    this.forget(id);
    this.deps.log.warn(`issuer: bono issue failed (${reason})`);
  }

  private forget(id: string): void {
    this.attempts.delete(id);
    this.failures.delete(id);
  }

  private retryLater(id: string, retryAfterS: number | undefined): void {
    const attempt = this.attempts.get(id) ?? 0;
    this.attempts.set(id, attempt + 1);
    this.schedule(id, retryAfterMs(retryAfterS, attempt));
  }
}
