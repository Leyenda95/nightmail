// Payer DUST accounting: a hard hourly spending cap and a lost-fee metric. In memory and timer-free:
// callers pass the current time (ms). Amounts are DUST in base units (10^-15), as the wallet reports them.

const HOUR_MS = 60 * 60_000;

/**
 * Spending cap over a sliding window (one hour). Only the serial queue uses it, so checking and
 * recording within one job is atomic.
 */
export class HourlyCap {
  readonly cap: bigint;
  private readonly windowMs: number;
  private spends: { at: number; amount: bigint }[] = [];

  constructor(cap: bigint, windowMs = HOUR_MS) {
    if (cap < 0n) throw new RangeError('cap: expected a non-negative amount');
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new RangeError('cap: expected a positive window');
    this.cap = cap;
    this.windowMs = windowMs;
  }

  private prune(now: number): void {
    this.spends = this.spends.filter((s) => now - s.at < this.windowMs);
  }

  spent(now: number): bigint {
    this.prune(now);
    return this.spends.reduce((sum, s) => sum + s.amount, 0n);
  }

  /** Whether `amount` more fits under the cap right now. Records nothing. */
  allows(amount: bigint, now: number): boolean {
    return this.spent(now) + amount <= this.cap;
  }

  /** Whether `amount` fits with an empty window. If not, waiting won't help: the cap must be raised. */
  fits(amount: bigint): boolean {
    return amount <= this.cap;
  }

  record(amount: bigint, now: number): void {
    this.spends.push({ at: now, amount });
  }

  /** Milliseconds until the oldest spend leaves the window (0 if there is none). */
  retryAfterMs(now: number): number {
    this.prune(now);
    const oldest = this.spends[0];
    return oldest ? oldest.at + this.windowMs - now : 0;
  }
}

export type LostFeesSnapshot = { count: number; dust: bigint; byCause: Record<string, { count: number; dust: bigint }> };

/**
 * Fees paid for transactions that landed in a block without applying anything (FailFallible...). The
 * cause is `<operation>:<block status>`; the exact reason is in the node log (look it up by hash).
 */
export class LostFees {
  private readonly byCause = new Map<string, { count: number; dust: bigint }>();

  add(cause: string, dust: bigint): void {
    const entry = this.byCause.get(cause) ?? { count: 0, dust: 0n };
    this.byCause.set(cause, { count: entry.count + 1, dust: entry.dust + dust });
  }

  snapshot(): LostFeesSnapshot {
    const entries = [...this.byCause].map(([cause, e]) => [cause, { ...e }] as const);
    return {
      count: entries.reduce((n, [, e]) => n + e.count, 0),
      dust: entries.reduce((sum, [, e]) => sum + e.dust, 0n),
      byCause: Object.fromEntries(entries),
    };
  }
}
