// Journal of in-flight `bono` issues (`<dataDir>/payer-issues.json`, 0600, atomic writes).
//
// The contract's `bonos` tree is the only source of truth for what has been issued. What it can't tell is
// whether an issue transaction was sent with an unknown outcome (connection drop, crash): while it may
// still land in a block, reissuing would duplicate the leaf. That is all this stores: per id, the plan,
// the tx hash and until when it can land.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { writePrivateFile } from '../wallet/storage.ts';

const FILE = 'payer-issues.json';
const HEX32 = /^[0-9a-f]{64}$/;

export type IssuePlan = 'free' | 'paid';
export const ISSUE_PLANS: readonly IssuePlan[] = ['free', 'paid'];

/** An issue sent with unknown outcome. `validUntil`: Unix ms; after it, the tx can no longer land. */
export type InFlightIssue = { plan: IssuePlan; txHash: string; validUntil: number };

/**
 * The journal exists but can't be parsed. It is not ignored, since in-flight issues could be duplicated:
 * the operator inspects it and may delete it once the transactions have expired (30 min plus the margin).
 */
export class JournalUnreadableError extends Error {}

function isEntry(value: unknown): value is InFlightIssue {
  if (value === null || typeof value !== 'object') return false;
  const { plan, txHash, validUntil } = value as Record<string, unknown>;
  return ISSUE_PLANS.includes(plan as IssuePlan) && typeof txHash === 'string' && HEX32.test(txHash)
    && Number.isSafeInteger(validUntil) && (validUntil as number) >= 0;
}

function parse(text: string): Map<string, InFlightIssue> {
  const raw = JSON.parse(text) as { version?: unknown; inFlight?: unknown } | null;
  const inFlight = raw?.inFlight;
  if (raw?.version !== 1 || inFlight === null || typeof inFlight !== 'object' || Array.isArray(inFlight)) {
    throw new Error('unknown format');
  }
  const entries = Object.entries(inFlight);
  if (!entries.every(([id, entry]) => HEX32.test(id) && isEntry(entry))) throw new Error('invalid entry');
  return new Map(entries.map(([id, e]) => [id, { plan: e.plan, txHash: e.txHash, validUntil: e.validUntil }]));
}

export class IssueJournal {
  private readonly dir: string;
  private readonly inFlight: Map<string, InFlightIssue>;

  private constructor(dir: string, inFlight: Map<string, InFlightIssue>) {
    this.dir = dir;
    this.inFlight = inFlight;
  }

  /** Opens the journal in `dir` (empty if there is no file). Throws JournalUnreadableError if unparseable. */
  static open(dir: string): IssueJournal {
    const file = path.join(dir, FILE);
    if (!existsSync(file)) return new IssueJournal(dir, new Map());
    try {
      return new IssueJournal(dir, parse(readFileSync(file, 'utf8')));
    } catch {
      throw new JournalUnreadableError(`${file} is not a valid issue journal`);
    }
  }

  get size(): number {
    return this.inFlight.size;
  }

  get(id: string): InFlightIssue | undefined {
    const entry = this.inFlight.get(id);
    return entry && { ...entry };
  }

  /** Records (and persists) an issue about to be sent; also drops entries that expired before `expiredBefore`. */
  put(id: string, entry: InFlightIssue, expiredBefore: number): void {
    for (const [other, e] of this.inFlight) {
      if (e.validUntil < expiredBefore) this.inFlight.delete(other);
    }
    const previous = this.inFlight.get(id);
    this.inFlight.set(id, { ...entry });
    try {
      this.save();
    } catch (e) {
      // Unsaved means not recorded (the caller won't send the tx), so keep memory in line with disk.
      if (previous) this.inFlight.set(id, previous);
      else this.inFlight.delete(id);
      throw e;
    }
  }

  /** Forgets an issue whose outcome is now known. */
  delete(id: string): void {
    if (this.inFlight.delete(id)) this.save();
  }

  private save(): void {
    writePrivateFile(this.dir, FILE, JSON.stringify({ version: 1, inFlight: Object.fromEntries(this.inFlight) }));
  }
}
