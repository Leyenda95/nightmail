// Mail server limits: per-key rate (IP or address) and slots for expensive work.
// In memory and timer-free: the caller passes the current time in milliseconds.

export type RateLimit = { limit: number; windowMs: number; maxKeys?: number };

const DEFAULT_MAX_KEYS = 10_000;

/**
 * At most `limit` events per key in each `windowMs` window (fixed window, starting at the first event).
 * The number of remembered keys is bounded: when full, expired windows are dropped first, then the oldest.
 */
export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor({ limit, windowMs, maxKeys = DEFAULT_MAX_KEYS }: RateLimit) {
    if (![limit, windowMs, maxKeys].every((n) => Number.isSafeInteger(n) && n > 0)) {
      throw new RangeError('rate limit: expected positive integers');
    }
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
  }

  get size(): number {
    return this.windows.size;
  }

  private count(key: string, now: number): number {
    const window = this.windows.get(key);
    return window && now - window.start < this.windowMs ? window.count : 0;
  }

  /** Whether the key still has room for an event of that `cost` (1 by default). Does not count anything. */
  allows(key: string, now: number, cost = 1): boolean {
    return this.count(key, now) + cost <= this.limit;
  }

  /**
   * Counts an event of that `cost` (1 by default; e.g. bytes for a byte budget) if there is room and returns
   * whether there was. Rejected events are not counted.
   */
  hit(key: string, now: number, cost = 1): boolean {
    if (!Number.isSafeInteger(cost) || cost < 1) throw new RangeError('rate limit: expected a positive integer cost');
    const count = this.count(key, now);
    if (count + cost > this.limit) return false;
    if (count === 0) this.open(key, now, cost);
    else this.windows.get(key)!.count = count + cost;
    return true;
  }

  /**
   * Undoes an event of that `cost` (1 by default) counted at `at` if it belongs to the key's current window (events
   * from a closed window are left alone). Never goes below 0.
   */
  refund(key: string, at: number, cost = 1): void {
    const window = this.windows.get(key);
    if (window && at >= window.start && at - window.start < this.windowMs) window.count = Math.max(0, window.count - cost);
  }

  /** Milliseconds until the key's current window ends (0 if it has none). */
  resetIn(key: string, now: number): number {
    const window = this.windows.get(key);
    return window ? Math.max(0, window.start + this.windowMs - now) : 0;
  }

  /** Drops expired windows so keys (e.g. IPs) are not retained longer than needed. */
  sweep(now: number): void {
    for (const [key, window] of this.windows) if (now - window.start >= this.windowMs) this.windows.delete(key);
  }

  private open(key: string, now: number, count: number): void {
    this.windows.delete(key); // a reopened window moves to the end of the insertion order
    if (this.windows.size >= this.maxKeys) this.makeRoom(now);
    this.windows.set(key, { start: now, count });
  }

  private makeRoom(now: number): void {
    this.sweep(now);
    if (this.windows.size >= this.maxKeys) this.windows.delete(this.windows.keys().next().value!);
  }
}

/** Slots for concurrent expensive work. No queue: when none is free, the caller rejects. */
export class Slots {
  private free: number;

  constructor(total: number) {
    if (!Number.isSafeInteger(total) || total < 1) throw new RangeError('slots: expected a positive integer');
    this.free = total;
  }

  get available(): number {
    return this.free;
  }

  tryAcquire(): boolean {
    if (this.free === 0) return false;
    this.free -= 1;
    return true;
  }

  release(): void {
    this.free += 1;
  }
}
