// Mail server SQLite database (mailboxes and registry state).
//
// Uses `node:sqlite`, the SQLite built into Node, so there are no native dependencies to compile. Node 24
// still flags it as experimental (one stderr warning on load), but the API used here (DatabaseSync,
// prepared statements, BLOBs as Uint8Array) works and is covered by tests, including 32 MiB envelopes.
// It is synchronous, so each operation is atomic within the process.
//
// One process per database (`locking_mode = EXCLUSIVE`, taken on open): a second server on the same
// file could overwrite the registry index with an older one.
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Database = DatabaseSync;

export const MEMORY = ':memory:';

/** The file is already open in another process (or another connection of this one). */
export class DatabaseInUse extends Error {}

/** Maximum WAL size after each checkpoint (anything beyond is truncated). */
const JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

/** SQLITE_BUSY (5) or a variant (`errcode` is the extended code): another connection holds the lock. */
const isBusy = (error: unknown) => {
  const errcode = (error as { errcode?: unknown } | null)?.errcode;
  return typeof errcode === 'number' && (errcode & 0xff) === 5;
};

/**
 * Opens (or creates) the database. On disk: directory 0700, file 0600 from creation, WAL journal with
 * `synchronous = FULL` and an exclusive lock. Throws DatabaseInUse if someone else has it open.
 */
export function openDatabase(file: string): Database {
  if (file === MEMORY) return new DatabaseSync(MEMORY);
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700); // also if it already existed
  closeSync(openSync(file, 'a', 0o600)); // never exists, even briefly, with umask permissions
  chmodSync(file, 0o600);
  const db = new DatabaseSync(file);
  try {
    // FULL: mail accepted with 250 must survive a power cut. The trailing empty transaction takes the
    // exclusive lock now rather than on the first write.
    db.exec(`PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
      PRAGMA journal_size_limit = ${JOURNAL_SIZE_LIMIT_BYTES}; BEGIN IMMEDIATE; COMMIT;`);
  } catch (error) {
    db.close();
    if (isBusy(error)) throw new DatabaseInUse('The mail database is already open in another mail-server process');
    throw error;
  }
  return db;
}

/** Runs `work` in a write transaction: all or nothing. */
export function inTransaction<T>(db: Database, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Rewrites the file in key order and empties the WAL. Envelope pages are allocated in arrival order, so
 * the file leaks the global arrival order across mailboxes (whoever obtains it could see which mailboxes
 * received the same message); afterwards only mail that arrives later is ordered that way.
 * Synchronous and blocking: slow on large databases.
 */
export function compact(db: Database): void {
  db.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
}
