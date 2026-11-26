// RegistrySync keeps the resolution index up to date with the contract, block by block in chain order.
// The action subscription only says which blocks matter (full state is tens of KiB and `advanceRound`
// fires every 30 s); the registry state at each such block is then fetched and passed to `addBlock`.
//
// Invariants (the first-registrant suffix rule in resolution.ts depends on them): never skip or merge a
// block; if one cannot be read, retry with backoff without advancing. Index and height are saved together
// after each block; resume starts at the saved height (indexer offsets are inclusive).
//
// It also tracks the round and whether reservations await an advance (for the RoundTicker). A reservation
// at round r waits while r >= round, and counts only if r is at most MAX_ROUNDS_AHEAD ahead.
import type { RegistryAt, RegistrySnapshot, ResolutionIndex } from '@nightmail/midnight';
import type { Logger } from '../log.ts';

/** A contract action: the block holding its resulting state and the circuit called (null: deploy or maintenance). */
export type ActionNotice = { height: number; hash: string; entryPoint: string | null };
/**
 * Contract actions from block `fromHeight` (inclusive) onwards, in order; never ends on its own.
 * `alive` is called whenever there is evidence the connection is still alive (each indexer pong).
 */
export type ActionSource = (fromHeight: number, signal: AbortSignal, alive: () => void) => AsyncIterable<ActionNotice>;
export type FetchRegistryAt = (height: number) => Promise<RegistryAt | null>;

/** Registry round, and whether any reservation is waiting for it to advance. */
export type RoundState = { round: bigint; waiting: boolean };

export type SyncStore = {
  /** Atomically saves the index, the processed height and the round read at the index's last block. */
  saveIndex(index: ResolutionIndex, cursor: number, round: RoundState): void;
  saveCursor(cursor: number): void;
};

/**
 * Circuits that touch neither addresses, nor the round, nor reservations: their blocks are not read. Any other
 * (`createAlias`, `revealMailbox`, `reserveMailbox`, `advanceRound` and any future circuit) forces a read of its
 * block's state. When in doubt, read: skipping a block with addresses would break the ordering.
 */
export const CIRCUITS_NOT_READ: ReadonlySet<string> = new Set(['issueBono', 'buyBono', 'setPrice']);

const needsState = (notice: ActionNotice) => notice.entryPoint !== null && !CIRCUITS_NOT_READ.has(notice.entryPoint);

/**
 * How many rounds ahead a waiting reservation may be. The app reserves with r = round + 1 and the contract rejects
 * r < round, so an honest reservation is 0 or 1 rounds ahead. The contract sets no upper bound: without this cap,
 * a single reservation with a huge r (up to 2^64 - 2) would keep the operator advancing forever.
 * A far-ahead reservation is ignored until the round reaches its window naturally.
 */
export const MAX_ROUNDS_AHEAD = 1n;

/** A state's round, and whether any unrevealed reservation waits for it (round <= r <= round + MAX_ROUNDS_AHEAD). */
export const roundOf = (snapshot: RegistrySnapshot): RoundState => ({
  round: snapshot.round,
  waiting: snapshot.pendingNames.some((p) => p.reservedRound >= snapshot.round && p.reservedRound - snapshot.round <= MAX_ROUNDS_AHEAD),
});

const isHeight = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;

/** Waits `ms`, or until the signal aborts. Never rejects. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

export type Backoff = { initialMs: number; maxMs: number };
const DEFAULT_BACKOFF: Backoff = { initialMs: 1000, maxMs: 30_000 };

/** With no sign of life for this long, the sync is no longer healthy. Provisional default. */
export const DEFAULT_STALE_AFTER_MS = 120_000;

export type RegistrySyncDeps = {
  index: ResolutionIndex;
  /** Height of the last processed block (-1: none). */
  cursor: number;
  /** Height of the last block read and added to the index (-1: none). */
  fetched: number;
  /** Round saved with the index (that of block `fetched`), if any. */
  round?: RoundState;
  store: SyncStore;
  source: ActionSource;
  fetchAt: FetchRegistryAt;
  log: Logger;
  backoff?: Backoff;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** See `healthy`. */
  staleAfterMs?: number;
  /** Current time in milliseconds. */
  now?: () => number;
};

export type SyncStatus = { cursor: number; fetched: number; addresses: number; healthy: boolean };

export class RegistrySync {
  private readonly deps: RegistrySyncDeps;
  private readonly now: () => number;
  private readonly staleAfterMs: number;
  private cursor: number;
  private fetched: number;
  /** Latest known round and the height of the state it came from (never goes backwards). */
  private round: { state: RoundState; height: number } | undefined;
  /** Last sign of life with the sync up to date (startup counts as one, since startup checks the head). */
  private lastGood: number;
  /**
   * A block could not be read or saved and there has been no progress since, so connection liveness signals
   * do not count. Only an advance clears it (a redelivery on resume is not one).
   */
  private stuck = false;

  constructor(deps: RegistrySyncDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.staleAfterMs = deps.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.cursor = deps.cursor;
    this.fetched = deps.fetched;
    this.round = deps.round && { state: deps.round, height: deps.fetched };
    this.lastGood = this.now();
  }

  get status(): SyncStatus {
    return { cursor: this.cursor, fetched: this.fetched, addresses: this.deps.index.size, healthy: this.healthy() };
  }

  /** Latest known round and whether reservations are waiting; undefined until some state has been read. */
  roundState(): RoundState | undefined {
    return this.round?.state;
  }

  /** Takes the round from the state at that height if it is newer than the known one. */
  private noteRound(height: number, state: RoundState): void {
    if (!this.round || height >= this.round.height) this.round = { state, height };
  }

  /**
   * Head state seen at startup (`waitForHead`): provides the round without waiting for the next block read
   * (e.g. with a database that predates saving it). Not persisted: what is saved goes with the index.
   */
  observeHead(at: RegistryAt): void {
    this.noteRound(at.blockHeight, roundOf(at.snapshot));
  }

  /**
   * Whether SMTP can trust that an unknown address does not exist. Only if within the last `staleAfterMs`
   * there was an advance, or a subscription pong with no block stuck. Otherwise the index may be behind and
   * the honest answer is `451` (retry) rather than `550` (no such user).
   */
  healthy(): boolean {
    return this.now() - this.lastGood <= this.staleAfterMs;
  }

  private readonly alive = (): void => {
    if (!this.stuck) this.lastGood = this.now();
  };

  /** Processes an action and records the result for `healthy`: a failure marks it stuck, an advance clears that. */
  private async step(notice: ActionNotice): Promise<boolean> {
    let advanced: boolean;
    try {
      advanced = await this.process(notice);
    } catch (error) {
      this.stuck = true;
      throw error;
    }
    if (advanced) {
      this.stuck = false;
      this.lastGood = this.now();
    }
    return advanced;
  }

  /** Follows the chain until the signal aborts. Retries if the subscription drops or anything fails. */
  async run(signal: AbortSignal): Promise<void> {
    const { initialMs, maxMs } = this.deps.backoff ?? DEFAULT_BACKOFF;
    const wait = this.deps.sleep ?? sleep;
    let delay = initialMs;
    while (!signal.aborted) {
      try {
        for await (const notice of this.deps.source(Math.max(this.cursor, 0), signal, this.alive)) {
          // Only an advance resets the backoff: on resume the indexer redelivers the last block, which
          // is not progress.
          if (await this.step(notice)) delay = initialMs;
        }
        this.deps.log.debug('registry sync: the subscription ended');
      } catch (error) {
        // Name and message only; errors on this path carry no user data.
        if (!signal.aborted) this.deps.log.warn(`registry sync: stopped at block ${this.cursor}, retrying in ${delay} ms (${describe(error)})`);
      }
      if (signal.aborted) break;
      await wait(delay, signal);
      delay = Math.min(delay * 2, maxMs);
    }
  }

  /**
   * Processes an action and returns whether it advanced (a redelivery does not). Throws if its block
   * cannot be read; the caller retries without advancing.
   */
  async process(notice: ActionNotice): Promise<boolean> {
    if (!isHeight(notice.height)) throw new Error('registry sync: action without a valid block height');
    if (needsState(notice) && notice.height > this.fetched) {
      await this.readBlock(notice);
      return true;
    }
    if (notice.height <= this.cursor) return false;
    this.deps.store.saveCursor(notice.height); // disk first: if this fails, do not advance
    this.cursor = notice.height;
    return true;
  }

  /**
   * Reads the block, adds it to the index and saves it; only then advances. If saving fails, `fetched` and
   * `cursor` stay put: the redelivered block is read again (`addBlock` ignores what it already has), and the
   * disk never holds a height ahead of an index missing that block's addresses.
   */
  private async readBlock(notice: ActionNotice): Promise<void> {
    const { index, store, fetchAt, log } = this.deps;
    const at = await fetchAt(notice.height);
    if (!at) throw new Error('registry sync: the indexer has no registry at that block');
    if (at.blockHash !== notice.hash) throw new Error('registry sync: the block changed between the action and its state');
    const before = index.size;
    index.addBlock(notice.height, at.snapshot.addresses); // already-seen entries are ignored, leaving this block's
    const cursor = Math.max(this.cursor, notice.height);
    const round = roundOf(at.snapshot);
    store.saveIndex(index, cursor, round);
    this.fetched = notice.height;
    this.cursor = cursor;
    this.noteRound(notice.height, round);
    const added = index.size - before;
    if (added > 0) log.info(`registry sync: block ${notice.height}, ${added} new address(es), ${index.size} in total (state of ${at.stateBytes} bytes)`);
    else log.debug(`registry sync: block ${notice.height}, round ${round.round}, reservations waiting: ${round.waiting ? 'yes' : 'no'} (state of ${at.stateBytes} bytes)`);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
}

export type HeadWait = {
  signal: AbortSignal;
  log: Logger;
  pollMs?: number;
  /** How often to log that it is still waiting (with `progress`). */
  reportEveryMs?: number;
  /** Sync progress for that log line (no user data). */
  progress?: () => string;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

/**
 * Waits until the index holds every address currently on chain (`fetchHead`: the registry state at the
 * latest block). The server does not open its ports before this, or it would answer `550` (permanent
 * rejection) for an address created while it was down. Throws if there is no registry at the configured
 * address. Logs periodically while waiting, so a stuck sync does not leave the process silently "starting".
 */
export async function waitForHead(index: ResolutionIndex, fetchHead: () => Promise<RegistryAt | null>, options: HeadWait): Promise<void> {
  const { signal, log, pollMs = 250, reportEveryMs = 30_000, progress } = options;
  const wait = options.sleep ?? sleep;
  const head = await fetchHead();
  if (!head) throw new Error('There is no registry contract at the configured address');
  const missing = () => head.snapshot.addresses.filter((a) => !index.get(a.addrKey)).length;
  log.info(`registry sync: chain head is block ${head.blockHeight} with ${head.snapshot.addresses.length} address(es), ${missing()} to sync`);
  const pollsPerReport = Math.max(1, Math.round(reportEveryMs / pollMs));
  for (let polls = 1; missing() > 0 && !signal.aborted; polls++) {
    await wait(pollMs, signal);
    if (polls % pollsPerReport === 0 && missing() > 0) {
      log.warn(`registry sync: still waiting for ${missing()} address(es) of block ${head.blockHeight}${progress ? ` (${progress()})` : ''}`);
    }
  }
}
