// RoundTicker: advances the registry round every ~30 s, only while reservations wait. Each advance takes
// ~19 s of the payer's serial queue and ~0.4 DUST, so ticking blindly would cost ~47 DUST/h.
// Against double advances: stale reads (round <= last advanced) are ignored; an advance with unknown
// outcome blocks until the round changes or its validUntil (+1 min, else 31 min) passes; an hourly cap
// covers a persistently wrong read; the timer is chained so advances never overlap.
import { errorKind, type Logger } from '../log.ts';
import { RateLimiter } from '../limits.ts';
import type { RoundState } from '../registry/sync.ts';
import type { AdvanceOutcome, PayerClient } from './payer-client.ts';

export type { RoundState };

export const DEFAULT_ROUND_INTERVAL_MS = 30_000;
export const DEFAULT_MAX_ADVANCES_PER_HOUR = 60;
const VALID_UNTIL_MARGIN_MS = 60_000;
const UNKNOWN_WAIT_MS = 31 * 60_000;

export type RoundTickerDeps = {
  payer: Pick<PayerClient, 'advanceRound'>;
  readRoundState: () => Promise<RoundState>;
  log: Logger;
  intervalMs?: number;
  maxAdvancesPerHour?: number;
  /** Time in milliseconds. */
  now?: () => number;
};

/** Round at which the last advance was requested, and until when reads not past it are ignored. */
type Hold = { round: bigint; until: number };

class RoundTicker {
  private readonly deps: Required<RoundTickerDeps>;
  private readonly advances: RateLimiter;
  private hold: Hold | undefined;
  private capped = false;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(deps: RoundTickerDeps) {
    this.deps = { intervalMs: DEFAULT_ROUND_INTERVAL_MS, maxAdvancesPerHour: DEFAULT_MAX_ADVANCES_PER_HOUR, now: Date.now, ...deps };
    this.advances = new RateLimiter({ limit: this.deps.maxAdvancesPerHour, windowMs: 3_600_000, maxKeys: 1 });
  }

  schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick().finally(() => this.schedule()), this.deps.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private async tick(): Promise<void> {
    try {
      const state = await this.deps.readRoundState();
      if (this.stopped || !state.waiting || this.held(state.round) || !this.allowed()) return;
      this.record(state.round, await this.deps.payer.advanceRound());
    } catch (error) {
      this.deps.log.warn(`round-ticker: tick failed (${errorKind(error)})`);
    }
  }

  /** Whether the read is at or before the last advance's round while that advance may still be landing. */
  private held(round: bigint): boolean {
    if (this.hold && round <= this.hold.round && this.deps.now() < this.hold.until) return true;
    this.hold = undefined;
    return false;
  }

  private allowed(): boolean {
    if (this.advances.hit('all', this.deps.now())) {
      this.capped = false;
      return true;
    }
    if (!this.capped) this.deps.log.warn(`round-ticker: reached ${this.deps.maxAdvancesPerHour} advances per hour, waiting`);
    this.capped = true;
    return false;
  }

  private record(round: bigint, outcome: AdvanceOutcome): void {
    const { log } = this.deps;
    if (outcome.status === 'advanced') {
      this.hold = { round, until: Infinity };
      log.info(`round-ticker: round advanced${outcome.round === null ? '' : ` to ${outcome.round}`}`);
    } else if (outcome.status === 'unknown') {
      const until = outcome.validUntil === undefined ? this.deps.now() + UNKNOWN_WAIT_MS : outcome.validUntil + VALID_UNTIL_MARGIN_MS;
      this.hold = { round, until };
      log.warn('round-ticker: advance result unknown (it may have been paid), waiting until the round changes or it expires');
    } else {
      log.warn('round-ticker: advance failed, waiting for the next tick');
    }
  }
}

export function startRoundTicker(deps: RoundTickerDeps): { stop(): void } {
  const ticker = new RoundTicker(deps);
  ticker.schedule();
  return { stop: () => ticker.stop() };
}
