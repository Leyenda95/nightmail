// Right after the relayer reports a client transaction included, that transaction may have created an address the
// index does not hold yet: the index follows the finalized chain (~15 s behind a block), and with the payer's early
// answer (payer.ts) the app already shows the address as created. Telling where the chain head is would cost a node
// query per unknown recipient, so for a short window after each inclusion an unknown recipient is "cannot check now"
// (SMTP 451, delivery 503) instead of "does not exist" (550, 404). Outside the window nothing changes.
// The window only exists while the early answer is on (settlingWindow): with it off, the app only shows an address
// once final, and unknown recipients get 550/404 exactly as before.

/** Long enough for finality, the indexer and the registry sync, with room to spare. */
export const DEFAULT_SETTLING_MS = 60_000;

export class RecentInclusions {
  private readonly windowMs: number;
  private readonly now: () => number;
  private last = Number.NEGATIVE_INFINITY;

  constructor(windowMs = DEFAULT_SETTLING_MS, now: () => number = Date.now) {
    this.windowMs = windowMs;
    this.now = now;
  }

  /** A relayed transaction was just included. */
  note(): void {
    this.last = this.now();
  }

  /** Whether an inclusion happened within the window, so the index may still miss an address. */
  settling(): boolean {
    return this.now() - this.last < this.windowMs;
  }
}

/** The settling window, only when the payer's early relay answer is on (payer/config.ts); otherwise none. */
export function settlingWindow(earlyRelayAnswer: boolean): RecentInclusions | undefined {
  return earlyRelayAnswer ? new RecentInclusions() : undefined;
}
