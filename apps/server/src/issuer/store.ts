// Issuer `bono` requests in a dedicated SQLite file (`issuer.sqlite`); db.ts takes an exclusive file lock, so
// it can't be shared with the mail-server database. No IPs or network data: only the id (which the operator
// can't link to any address), plan, receipt and state. Issued requests are purged after a few days
// (purgeIssued): the contract tree already proves they exist.
import type { Database } from '../storage/db.ts';
import type { IssuePlan } from './payer-client.ts';

export type RequestState = 'pending' | 'issued' | 'failed';
export type Period = 'monthly' | 'annual';

export type BonoRequest = {
  id: string;
  plan: IssuePlan;
  /** Paid plan only; in the MVP it doesn't affect issuance (leaves never expire). */
  period: Period | null;
  state: RequestState;
  /** Receipt insert-by deadline (Unix seconds). */
  insertBy: number;
  signature: Buffer;
  /** Unix ms of the first request, rounded to the hour so the exact time is never stored. */
  createdAt: number;
};

const SCHEMA = `CREATE TABLE IF NOT EXISTS bono_requests (
  id TEXT PRIMARY KEY CHECK (length(id) = 64),
  plan TEXT NOT NULL CHECK (plan IN ('free', 'paid')),
  period TEXT CHECK (period IS NULL OR period IN ('monthly', 'annual')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'issued', 'failed')),
  insert_by INTEGER NOT NULL,
  signature BLOB NOT NULL,
  created_at INTEGER NOT NULL
) STRICT`;

type Row = Record<string, unknown>;

const toRequest = (row: Row): BonoRequest => ({
  id: row['id'] as string,
  plan: row['plan'] as IssuePlan,
  period: row['period'] as Period | null,
  state: row['state'] as RequestState,
  insertBy: row['insert_by'] as number,
  signature: Buffer.from(row['signature'] as Uint8Array),
  createdAt: row['created_at'] as number,
});

export class IssuerStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
    db.exec(SCHEMA);
  }

  get(id: string): BonoRequest | undefined {
    const row = this.db.prepare('SELECT * FROM bono_requests WHERE id = ?').get(id);
    return row && toRequest(row);
  }

  create(r: BonoRequest): void {
    this.db
      .prepare('INSERT INTO bono_requests (id, plan, period, state, insert_by, signature, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(r.id, r.plan, r.period, r.state, r.insertBy, r.signature, r.createdAt);
  }

  setState(id: string, state: RequestState): void {
    this.db.prepare('UPDATE bono_requests SET state = ? WHERE id = ?').run(state, id);
  }

  /** Puts a failed request back to pending with a new receipt. */
  requeue(id: string, insertBy: number, signature: Buffer): void {
    this.db
      .prepare("UPDATE bono_requests SET state = 'pending', insert_by = ?, signature = ? WHERE id = ?")
      .run(insertBy, signature, id);
  }

  /** Pending requests in arrival order (by hour, then by id within the hour). */
  pending(): BonoRequest[] {
    return this.db.prepare("SELECT * FROM bono_requests WHERE state = 'pending' ORDER BY created_at, id").all().map(toRequest);
  }

  countPending(): number {
    return this.count("SELECT count(*) AS n FROM bono_requests WHERE state = 'pending'");
  }

  /** Pending requests past their receipt deadline (`nowS`: Unix seconds), i.e. broken promises. */
  countOverdue(nowS: number): number {
    return this.count("SELECT count(*) AS n FROM bono_requests WHERE state = 'pending' AND insert_by < ?", nowS);
  }

  /** Deletes issued requests created before `beforeMs`; returns how many. */
  purgeIssued(beforeMs: number): number {
    return Number(this.db.prepare("DELETE FROM bono_requests WHERE state = 'issued' AND created_at < ?").run(beforeMs).changes);
  }

  private count(sql: string, ...params: number[]): number {
    return Number(this.db.prepare(sql).get(...params)!['n']);
  }
}
