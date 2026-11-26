// MailboxStore: sealed envelopes per addrKey; no user table, nothing links two mailboxes.
// Per message: a random `id` (a counter would leak volume and order), a per-mailbox `seq` cursor (no
// rowid, so no global arrival order), `received_at` set by the server, not the sender, and rounded down to the
// minute (owner decision 2026-11-26: the exact minute is shown; the hour rounding is dropped), and `size` for the
// quota (only its bucket is exposed).
import { randomBytes } from 'node:crypto';
import { bucketOfEnvelope } from '@nightmail/core-ts';
import { type Database, inTransaction } from '../storage/db.ts';

/** Per-mailbox quota, in envelope bytes. Provisional default. */
export const DEFAULT_MAILBOX_QUOTA_BYTES = 300 * 1024 * 1024;
/** Granularity of the stored receipt time: the minute, which is what the interface shows. Decided by the owner on
 *  2026-11-26; the earlier hour rounding is dropped. */
export const RECEIVED_AT_GRANULARITY_SECONDS = 60;

const ADDR_KEY_BYTES = 32;
const ID_BYTES = 16;
const ID_HEX = /^[0-9a-f]{32}$/;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS message (
  addr_key BLOB NOT NULL CHECK (length(addr_key) = ${ADDR_KEY_BYTES}),
  seq INTEGER NOT NULL,
  id BLOB NOT NULL UNIQUE CHECK (length(id) = ${ID_BYTES}),
  received_at INTEGER NOT NULL,
  size INTEGER NOT NULL,
  envelope BLOB NOT NULL,
  PRIMARY KEY (addr_key, seq)
) WITHOUT ROWID, STRICT;`;

/** The envelope does not fit in the mailbox quota. */
export class QuotaExceeded extends Error {}

export type Delivery = { addrKey: Uint8Array; envelope: Uint8Array };
/** What a listing shows of a message: id, size bucket and rounded date (Unix seconds). */
export type MessageSummary = { id: string; size: number; receivedAt: number };
export type MessagePage = { messages: MessageSummary[]; /** Cursor for the next request. */ next: number };

export type MailboxStoreOptions = { quotaBytes?: number; randomId?: () => Uint8Array };

function requireAddrKey(addrKey: Uint8Array): Uint8Array {
  if (!(addrKey instanceof Uint8Array) || addrKey.length !== ADDR_KEY_BYTES) throw new RangeError('addrKey: expected 32 bytes');
  return addrKey;
}

const isCount = (value: number) => Number.isSafeInteger(value) && value >= 0;

type Usage = { used: number; last: number };
type Row = { seq: number; id: Uint8Array; received_at: number; size: number };

export class MailboxStore {
  private readonly db: Database;
  private readonly quotaBytes: number;
  private readonly randomId: () => Uint8Array;

  constructor(db: Database, options: MailboxStoreOptions = {}) {
    this.db = db;
    this.quotaBytes = options.quotaBytes ?? DEFAULT_MAILBOX_QUOTA_BYTES;
    this.randomId = options.randomId ?? (() => randomBytes(ID_BYTES));
    db.exec(SCHEMA);
  }

  private usage(addrKey: Uint8Array): Usage {
    const row = this.db
      .prepare('SELECT coalesce(sum(size), 0) AS used, coalesce(max(seq), 0) AS last FROM message WHERE addr_key = ?')
      .get(requireAddrKey(addrKey)) as Usage;
    return { used: row.used, last: row.last };
  }

  /** Envelope bytes used by the mailbox. */
  usedBytes(addrKey: Uint8Array): number {
    return this.usage(addrKey).used;
  }

  /** Whether an envelope of that length fits in the mailbox. */
  hasRoomFor(addrKey: Uint8Array, envelopeLength: number): boolean {
    return this.usedBytes(addrKey) + envelopeLength <= this.quotaBytes;
  }

  /**
   * Stores one envelope per mailbox, all or none. Deliveries are consumed one at a time so the caller
   * can seal lazily instead of holding every envelope in memory at once.
   * Throws QuotaExceeded if any does not fit.
   */
  deliver(deliveries: Iterable<Delivery>, nowSeconds: number): void {
    const receivedAt = nowSeconds - (nowSeconds % RECEIVED_AT_GRANULARITY_SECONDS);
    inTransaction(this.db, () => {
      for (const delivery of deliveries) this.insert(delivery, receivedAt);
    });
  }

  private insert({ addrKey, envelope }: Delivery, receivedAt: number): void {
    bucketOfEnvelope(envelope.length); // only `sealMailbox` envelopes are stored (throws on other sizes)
    const { used, last } = this.usage(addrKey);
    if (used + envelope.length > this.quotaBytes) throw new QuotaExceeded('mailbox quota exceeded');
    this.db
      .prepare('INSERT INTO message (addr_key, seq, id, received_at, size, envelope) VALUES (?, ?, ?, ?, ?, ?)')
      .run(addrKey, last + 1, this.randomId(), receivedAt, envelope.length, envelope);
  }

  /** Mailbox messages after cursor `since` (0: all), in arrival order, up to `limit`. */
  list(addrKey: Uint8Array, since: number, limit: number): MessagePage {
    if (!isCount(since) || !isCount(limit) || limit === 0) throw new RangeError('list: invalid cursor or limit');
    const rows = this.db
      .prepare('SELECT seq, id, received_at, size FROM message WHERE addr_key = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(requireAddrKey(addrKey), since, limit) as Row[];
    const messages = rows.map((row) => ({
      id: Buffer.from(row.id).toString('hex'), size: bucketOfEnvelope(row.size), receivedAt: row.received_at,
    }));
    return { messages, next: rows.at(-1)?.seq ?? since };
  }

  /** Envelope length of a message in this mailbox (hex id), without reading it; or undefined. */
  envelopeSize(addrKey: Uint8Array, id: string): number | undefined {
    if (!ID_HEX.test(id)) return undefined;
    const row = this.db
      .prepare('SELECT size FROM message WHERE id = ? AND addr_key = ?')
      .get(Buffer.from(id, 'hex'), requireAddrKey(addrKey)) as { size: number } | undefined;
    return row?.size;
  }

  /** Encrypted envelope of a message in this mailbox (hex id), or undefined. */
  get(addrKey: Uint8Array, id: string): Uint8Array | undefined {
    if (!ID_HEX.test(id)) return undefined;
    const row = this.db
      .prepare('SELECT envelope FROM message WHERE id = ? AND addr_key = ?')
      .get(Buffer.from(id, 'hex'), requireAddrKey(addrKey)) as { envelope: Uint8Array } | undefined;
    return row?.envelope;
  }
}
