// The payer: the only thing that spends the operator's DUST. Three operations, all through one serial queue:
//   relay         pays for a transaction a client proved (balances DUST only)
//   issue         issues a `bono` leaf (issueBono), idempotent per id
//   advanceRound  advances the registry round
// No network or SDK here: wallet and chain come in through `PayerPorts` (ports.ts wires the real ones,
// tests use doubles). Results never carry SDK messages, only fixed codes; details go to the operator log.
import { ctx as ctxOf, fromHex, leaf as leafOf, NO_EXPIRY, Plan } from '@nightmail/midnight';
import { EXPIRY_MARGIN_MS } from '../chain/deploy.ts';
import { nodeRejectionCode, type Outcome, type Prepared, type SentTx } from '../chain/midnight.ts';
import type { RelayProblem } from '../chain/relayable.ts';
import { HourlyCap, LostFees, type LostFeesSnapshot } from './accounting.ts';
import type { InFlightIssue, IssueJournal, IssuePlan } from './journal.ts';
import { QueueFullError, QueueStoppedError, SerialQueue } from './queue.ts';

/** The bytes are not a proved, unbalanced transaction of the current protocol version. */
export class InvalidTransactionError extends Error {}

export type RegistryPort = {
  /** NightMailRegistry contract address (hex). */
  address: string;
  /** Builds and proves an operator call. Throws if the circuit fails locally or cannot be proved. */
  prepare(circuit: 'issueBono' | 'advanceRound', args: unknown[]): Promise<Prepared>;
  /** For each leaf, whether it is already in the `bonos` tree (all checked against the same state). */
  hasLeaves(leaves: Uint8Array[]): Promise<boolean[]>;
  round(): Promise<bigint>;
  /** Time of the last block the indexer has processed (the state `hasLeaves` and `round` read from). */
  indexedTime(): Promise<Date>;
};

export type PayerPorts = {
  /** Latest known wallet state, without waiting. */
  status(): { synced: boolean; dustCoins: number; dustBalance: bigint };
  /**
   * Why a client transaction won't be paid for (relayable.ts), or null. Throws InvalidTransactionError
   * if the bytes are not an unbalanced transaction of the current version.
   */
  screen(tx: Uint8Array): RelayProblem | null;
  /** Estimated DUST fee to pay for the transaction. Throws InvalidTransactionError on invalid bytes. */
  estimateFee(tx: Uint8Array): Promise<bigint>;
  /** Balances DUST only, signs, submits and waits for the block (sendPrepared). Calls back right before submitting. */
  send(tx: Prepared, beforeSubmit: (sent: SentTx) => void | Promise<void>): Promise<Outcome>;
  /** null if no contracts are deployed on this network yet (only relay works). */
  registry: RegistryPort | null;
};

export type PayerLimits = {
  /** Hard hourly DUST caps (base units), one for relay and one for issue. */
  relayDustPerHour: bigint;
  issueDustPerHour: bigint;
  /** Running plus waiting operations the queue accepts. */
  maxQueue: number;
};

export type PayerLog = { info(message: string): void; warn(message: string): void };

/**
 * Why an operation was not served. `fee-over-cap`: the estimated fee alone exceeds the hourly cap (it
 * will never be paid under that cap). `indexer-behind`: the indexer lags too far to tell whether the leaf
 * is in the tree. `stopping`: the process is shutting down.
 */
export type PayerError =
  | { error: 'invalid-tx' | 'no-contract' | 'id-conflict' | 'queue-full' | 'fee-over-cap' | 'stopping' | 'internal' }
  | { error: 'not-relayable'; reason: RelayProblem }
  | { error: 'dust-cap' | 'indexer-behind'; retryAfterS: number }
  | { error: 'dust-unavailable'; transient: boolean; retryAfterS: number };

/** `status`: the block status (SucceedEntirely, FailFallible...), or 'unknown' if sent with no known outcome. */
export type RelayResult = { status: string; txHash: string } | Unknown | Rejected;
/** Sent with no known outcome: it may still land in a block until `validUntil` (Unix ms). */
type Unknown = { status: 'unknown'; txHash: string; validUntil: number };
/** The node rejected it before any block: no fee, no effects. `code`: the node's "Custom error" code, if given. */
type Rejected = { status: 'rejected'; code: number | null };
type Failed = { status: 'failed'; reason: 'not-prepared' | 'rejected' } | { status: 'failed'; reason: 'fee-lost'; txHash: string };
export type IssueResult =
  | { status: 'issued'; txHash: string }
  | { status: 'already-issued' }
  | { status: 'pending'; txHash: string; retryAfterS: number }
  | Failed;
/** `round`: the new round, or null if it advanced but could not be read (it was paid, so not a retryable error). */
export type AdvanceResult = { status: 'advanced'; round: number | null; txHash: string } | Unknown | Failed;

export type Health = {
  ready: boolean;
  dustCoins: number;
  dustBalance: bigint;
  queueLength: number;
  lostFees: LostFeesSnapshot;
  dustSpentLastHour: { relay: bigint; issue: bigint };
  dustCapPerHour: { relay: bigint; issue: bigint };
  issuesInFlight: number;
  contract: string | null;
};

type Kind = 'relay' | 'issue' | 'advance';
/** Outcome of a transaction the wallet got as far as signing. */
type Paid = { status: string; sent: SentTx };

/** A send with unknown outcome may keep DUST coins reserved until it expires (30 min). */
const UNKNOWN_HOLD_MS = 30 * 60_000;
const RETRY_AFTER_S = 60;
/**
 * If the indexer's last block is older than this, don't issue: its view of the tree is stale (blocks,
 * empty ones included, are produced every few seconds).
 */
const MAX_INDEXER_LAG_MS = 120_000;
const INDEXER_RETRY_AFTER_S = 30;
/**
 * Deadline for a queue job. A normal one takes ~20 s. sendPrepared has its own timeouts (10 min to submit,
 * 10 to the block), but proving, estimating or reading the tree do not, and a hung job would block the queue forever.
 */
const JOB_DEADLINE_MS = 30 * 60_000;
const PLAN_OF: Record<IssuePlan, Plan> = { free: Plan.free, paid: Plan.paid };
const OTHER_PLAN: Record<IssuePlan, IssuePlan> = { free: 'paid', paid: 'free' };

/** Maps something that never reached a block to an operator-operation failure. */
const failedOf = (unpaid: Rejected | Failed | PayerError): Failed | PayerError =>
  ('code' in unpaid ? { status: 'failed', reason: 'rejected' } : unpaid);
/** Sent with no known outcome; the caller treats it as live until `validUntil`. */
const unknownOf = (sent: SentTx): Unknown => ({ status: 'unknown', txHash: sent.txHash, validUntil: sent.validUntil.getTime() });
const sentResult = ({ status, sent }: Paid): RelayResult => (status === 'unknown' ? unknownOf(sent) : { status, txHash: sent.txHash });
const seconds = (ms: number) => Math.ceil(ms / 1000);

export class Payer {
  private readonly ports: PayerPorts;
  private readonly journal: IssueJournal;
  private readonly limits: PayerLimits;
  private readonly now: () => number;
  private readonly log: PayerLog;
  private readonly queue: SerialQueue;
  private readonly caps: { relay: HourlyCap; issue: HourlyCap };
  private readonly lostFees = new LostFees();
  private readonly jobDeadlineMs: number;
  private readonly onStuck: () => void;
  private lastUnknownAt = Number.NEGATIVE_INFINITY;

  /**
   * `onStuck`: a queue job exceeded `jobDeadlineMs` (it can't be cancelled, it may be mid-submit). The
   * process should exit so systemd restarts it; the journal covers in-flight issues.
   */
  constructor(deps: {
    ports: PayerPorts; journal: IssueJournal; limits: PayerLimits; log: PayerLog; now?: () => number;
    jobDeadlineMs?: number; onStuck?: () => void;
  }) {
    this.ports = deps.ports;
    this.journal = deps.journal;
    this.limits = deps.limits;
    this.log = deps.log;
    this.now = deps.now ?? Date.now;
    this.jobDeadlineMs = deps.jobDeadlineMs ?? JOB_DEADLINE_MS;
    this.onStuck = deps.onStuck ?? (() => {});
    this.queue = new SerialQueue(deps.limits.maxQueue);
    this.caps = { relay: new HourlyCap(deps.limits.relayDustPerHour), issue: new HourlyCap(deps.limits.issueDustPerHour) };
  }

  health(): Health {
    const wallet = this.ports.status();
    const now = this.now();
    return {
      ready: wallet.synced && wallet.dustCoins > 0,
      dustCoins: wallet.dustCoins,
      dustBalance: wallet.dustBalance,
      queueLength: this.queue.length,
      lostFees: this.lostFees.snapshot(),
      dustSpentLastHour: { relay: this.caps.relay.spent(now), issue: this.caps.issue.spent(now) },
      dustCapPerHour: { relay: this.limits.relayDustPerHour, issue: this.limits.issueDustPerHour },
      issuesInFlight: this.journal.size,
      contract: this.ports.registry?.address ?? null,
    };
  }

  /** Runs another wallet-spending job (NIGHT registration) through the same queue. */
  exclusive<T>(job: () => Promise<T>): Promise<T> {
    return this.queue.run(job);
  }

  /**
   * Stops on shutdown: queued and new operations get `stopping` without spending. Resolves when the
   * running operation finishes, so the wallet is closed after it and not in the middle.
   */
  stop(): Promise<void> {
    return this.queue.stop();
  }

  /**
   * Pays for and submits a client-proved, unbalanced transaction. Only contract calls that move no value
   * are accepted (relayable.ts); the wallet balances it without signing the client's part.
   */
  relay(tx: Uint8Array): Promise<RelayResult | PayerError> {
    const refused = this.unrelayable(tx);
    if (refused) return Promise.resolve(refused);
    return this.enqueue('relay', async () => {
      const paid = await this.pay('relay', { bytes: tx, proveMs: 0, kinds: ['dust'], foreign: true });
      return 'sent' in paid ? sentResult(paid) : paid;
    });
  }

  private unrelayable(tx: Uint8Array): PayerError | undefined {
    try {
      const reason = this.ports.screen(tx);
      return reason ? { error: 'not-relayable', reason } : undefined;
    } catch (e) {
      if (e instanceof InvalidTransactionError) return { error: 'invalid-tx' };
      this.log.warn(`relay: could not inspect the transaction: ${describe(e)}`);
      return { error: 'internal' };
    }
  }

  /** Issues the `bono` leaf for `id` (32-byte hex) with that plan. Idempotent per id. */
  issue(id: string, plan: IssuePlan): Promise<IssueResult | PayerError> {
    const registry = this.ports.registry;
    if (!registry) return Promise.resolve({ error: 'no-contract' });
    return this.enqueue('issue', () => this.issueNow(registry, id, plan));
  }

  advanceRound(): Promise<AdvanceResult | PayerError> {
    const registry = this.ports.registry;
    if (!registry) return Promise.resolve({ error: 'no-contract' });
    return this.enqueue('advance', async () => {
      const paid = await this.payCall('advance', registry, 'advanceRound', []);
      if (!('sent' in paid)) return failedOf(paid);
      const { status, sent: { txHash } } = paid;
      if (status === 'unknown') return unknownOf(paid.sent);
      if (status !== 'SucceedEntirely') return { status: 'failed', reason: 'fee-lost', txHash };
      return { status: 'advanced', round: await this.roundAfter(registry, txHash), txHash };
    });
  }

  /** Round after advancing, or null if unreadable. It advanced and was paid, so this must not be an error (it would be retried). */
  private async roundAfter(registry: RegistryPort, txHash: string): Promise<number | null> {
    try {
      return Number(await registry.round());
    } catch (e) {
      this.log.warn(`advance: advanced (tx ${txHash}) but the new round could not be read: ${describe(e)}`);
      return null;
    }
  }

  private async issueNow(registry: RegistryPort, id: string, plan: IssuePlan): Promise<IssueResult | PayerError> {
    const idBytes = fromHex(id, 32, 'id');
    const indexed = await this.indexedTime(registry);
    if (typeof indexed !== 'number') return indexed;
    const known = await this.knownIssue(registry, { id, idBytes, plan, indexed });
    if (known) return known;
    const paid = await this.payCall('issue', registry, 'issueBono', [idBytes, PLAN_OF[plan]], (sent) => {
      this.journal.put(id, { plan, txHash: sent.txHash, validUntil: sent.validUntil.getTime() }, indexed - EXPIRY_MARGIN_MS);
    });
    if ('sent' in paid && paid.status === 'unknown') return this.pending(paid.sent.txHash, paid.sent.validUntil.getTime(), this.now());
    this.journal.delete(id); // known outcome (in a block, not sent, or rejected before a block): no longer in flight
    if (!('sent' in paid)) return failedOf(paid);
    const { status, sent: { txHash } } = paid;
    return status === 'SucceedEntirely' ? { status: 'issued', txHash } : { status: 'failed', reason: 'fee-lost', txHash };
  }

  /**
   * Time (ms) of the indexer's last block. This, not the local clock, decides whether an in-flight issue
   * can no longer land. If it lags too far, `indexer-behind`: its tree is stale.
   */
  private async indexedTime(registry: RegistryPort): Promise<number | PayerError> {
    const indexed = (await registry.indexedTime()).getTime();
    const lagMs = this.now() - indexed;
    if (lagMs <= MAX_INDEXER_LAG_MS) return indexed;
    this.log.warn(`issue: the indexer is ${seconds(lagMs)} s behind, not issuing`);
    return { error: 'indexer-behind', retryAfterS: INDEXER_RETRY_AFTER_S };
  }

  /**
   * What is already known about the id without sending anything: issued (leaf in the tree), conflicting
   * with the other plan, or with an earlier issue that may still land. undefined means issue now.
   * `indexed` is read before the tree: if an in-flight issue had already expired by then, the indexer had
   * processed every block that could include it, so the tree's answer is final.
   */
  private async knownIssue(
    registry: RegistryPort, { id, idBytes, plan, indexed }: { id: string; idBytes: Uint8Array; plan: IssuePlan; indexed: number },
  ): Promise<IssueResult | PayerError | undefined> {
    const leaf = (p: IssuePlan) => leafOf(ctxOf(registry.address), idBytes, PLAN_OF[p], NO_EXPIRY);
    // Check for the leaf before issuing or retrying: a blind retry would duplicate it.
    const [issued, issuedWithOtherPlan] = await registry.hasLeaves([leaf(plan), leaf(OTHER_PLAN[plan])]);
    if (issued) {
      this.journal.delete(id);
      return { status: 'already-issued' };
    }
    if (issuedWithOtherPlan) return { error: 'id-conflict' };
    // An earlier issue with unknown outcome may still land in a block: don't send another.
    const flying = this.stillFlying(id, indexed);
    if (!flying) return undefined;
    return flying.plan === plan ? this.pending(flying.txHash, flying.validUntil, indexed) : { error: 'id-conflict' };
  }

  /** The in-flight issue for the id if, per the indexer, it can still land; an expired one is forgotten. */
  private stillFlying(id: string, indexed: number): InFlightIssue | undefined {
    const flying = this.journal.get(id);
    if (!flying || indexed <= flying.validUntil + EXPIRY_MARGIN_MS) return flying;
    this.journal.delete(id);
    return undefined;
  }

  /** Sent with unknown outcome: whether to reissue is only known after it expires (plus the margin). */
  private pending(txHash: string, validUntil: number, at: number): IssueResult {
    return { status: 'pending', txHash, retryAfterS: Math.max(1, seconds(validUntil + EXPIRY_MARGIN_MS - at)) };
  }

  private async payCall(
    kind: Kind, registry: RegistryPort, circuit: 'issueBono' | 'advanceRound', args: unknown[],
    beforeSubmit: (sent: SentTx) => void = () => {},
  ): Promise<Paid | Rejected | Failed | PayerError> {
    let prepared: Prepared;
    try {
      prepared = await registry.prepare(circuit, args);
    } catch (e) {
      this.log.warn(`${kind}: could not build or prove ${circuit}: ${describe(e)}`);
      return { status: 'failed', reason: 'not-prepared' };
    }
    return this.pay(kind, prepared, beforeSubmit);
  }

  /**
   * Pays for a proved transaction: hourly cap check (estimated fee), then balance, sign, submit and wait,
   * then accounting (actual fee). Returns the block status (or 'unknown'), the node's rejection code, or
   * why it was not sent.
   */
  private async pay(kind: Kind, tx: Prepared, beforeSubmit: (sent: SentTx) => void = () => {}): Promise<Paid | Rejected | PayerError> {
    const cap = kind === 'advance' ? undefined : this.caps[kind];
    const refused = await this.refusal(kind, cap, tx.bytes);
    if (refused) return refused;
    let sent: SentTx | undefined;
    const outcome = await this.ports.send(tx, (s) => {
      beforeSubmit(s);
      sent = s;
    });
    if (outcome.status === 'balance-error') return this.dustUnavailable(kind, outcome.error);
    if (!sent) {
      // 'record-error': the signed transaction could not be recorded or read, so sendPrepared did not submit it.
      this.log.warn(`${kind}: not sent (${outcome.status}): ${outcome.error ?? ''}`);
      return { error: 'internal' };
    }
    // Relay hashes stay out of the normal line, which would otherwise trace every client transaction
    // (see log.ts); they only appear in lost-fee and unknown-outcome warnings. Issue and advance are operator txs.
    const hash = kind === 'relay' ? '' : `, tx ${sent.txHash}`;
    this.log.info(`${kind}: ${outcome.status}${hash}, ${Math.round(outcome.blockMs)} ms from submit to result`);
    if (outcome.status === 'rejected') return { status: 'rejected', code: nodeRejectionCode(outcome.error ?? '') };
    this.account(kind, cap, outcome, sent);
    return { status: outcome.status, sent };
  }

  /** Why the transaction won't be paid (invalid, wallet can't pay, or hourly cap); undefined if it will. */
  private async refusal(kind: Kind, cap: HourlyCap | undefined, tx: Uint8Array): Promise<PayerError | undefined> {
    let estimate: bigint;
    try {
      estimate = await this.ports.estimateFee(tx);
    } catch (e) {
      return e instanceof InvalidTransactionError ? { error: 'invalid-tx' } : this.dustUnavailable(kind, describe(e));
    }
    return cap && this.overCap(kind, cap, estimate);
  }

  /**
   * Hourly cap: `dust-cap` if it will fit once earlier spends leave the window (retryAfterS >= 1, since it
   * fits an empty window there must be some spend); `fee-over-cap` if it doesn't fit even an empty window.
   */
  private overCap(kind: Kind, cap: HourlyCap, estimate: bigint): PayerError | undefined {
    if (cap.allows(estimate, this.now())) return undefined;
    if (!cap.fits(estimate)) {
      this.log.warn(`${kind}: the estimated fee (${estimate}) is over the hourly DUST cap (${cap.cap}), never paying it`);
      return { error: 'fee-over-cap' };
    }
    this.log.warn(`${kind}: hourly DUST cap reached, not paying`);
    return { error: 'dust-cap', retryAfterS: seconds(cap.retryAfterMs(this.now())) };
  }

  /** A sent transaction counts toward the cap; if it landed in a block without applying, the fee is lost. */
  private account(kind: Kind, cap: HourlyCap | undefined, outcome: Outcome, sent: SentTx): void {
    cap?.record(sent.fee, this.now());
    if (outcome.status === 'unknown') {
      this.lastUnknownAt = this.now();
      this.log.warn(`${kind}: sent but the result is unknown (tx ${sent.txHash}): ${outcome.error ?? ''}`);
    } else if (!outcome.ok) {
      const cause = `${kind}:${outcome.status}`;
      this.lostFees.add(cause, sent.fee);
      this.log.warn(`lost fee: ${cause}, ${sent.fee} DUST units, tx ${sent.txHash} (the node log has the reason)`);
    }
  }

  private dustUnavailable(kind: Kind, detail: string | undefined): PayerError {
    const transient = this.now() - this.lastUnknownAt < UNKNOWN_HOLD_MS;
    this.log.warn(`${kind}: the wallet could not pay${transient ? ' (DUST may be reserved by a send of unknown result)' : ''}: ${detail ?? ''}`);
    return { error: 'dust-unavailable', transient, retryAfterS: RETRY_AFTER_S };
  }

  /** Runs through the serial queue. Failures never leak their message: 'internal' to the caller, details to the log. */
  private enqueue<T extends object>(kind: Kind, job: () => Promise<T | PayerError>): Promise<T | PayerError> {
    return this.queue.run(() => this.withDeadline(kind, job)).catch((e: unknown): PayerError => {
      if (e instanceof QueueFullError) return { error: 'queue-full' };
      if (e instanceof QueueStoppedError) return { error: 'stopping' };
      this.log.warn(`unexpected failure: ${describe(e)}`);
      return { error: 'internal' };
    });
  }

  /** Past the deadline, warns once (onStuck) without aborting the job: it may be mid-submit. */
  private async withDeadline<T>(kind: Kind, job: () => Promise<T>): Promise<T> {
    const timer = setTimeout(() => {
      this.log.warn(`${kind}: still running after ${Math.round(this.jobDeadlineMs / 1000)} s: stuck, the queue is blocked`);
      this.onStuck();
    }, this.jobDeadlineMs);
    timer.unref();
    try {
      return await job();
    } finally {
      clearTimeout(timer);
    }
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message.slice(0, 300)}` : 'unknown error';
}
