//! Migrations keyed on `PRAGMA user_version`. To add one, append `MIGRATION_Vn` to `MIGRATIONS`; published
//! migrations are never edited.
//!
//! Cascade warning: the connection runs with `foreign_keys=ON`. If a future migration rebuilds a parent table
//! (`DROP TABLE` + `RENAME`), the `DROP` cascades into the children (`messages`, `sync_cursors`). To rebuild a
//! parent table, disable `foreign_keys` before `BEGIN` (it cannot be changed inside a transaction).
//!
//! Units: every instant is Unix seconds UTC (`i64`).

use rusqlite::{Connection, ErrorCode};

use super::{Result, StoreError};

// `open` creates `meta` before migrating (to bind the scope) and v1 declares it the same way with `IF NOT EXISTS`.
macro_rules! meta_ddl {
    () => {
        "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value BLOB NOT NULL) STRICT;"
    };
}

pub(super) const META_DDL: &str = meta_ddl!();

/// Schema notes:
/// - `bonos` has PK `(n, k)`: a bono can have two leaves (free k=0 and paid k=1) with the same `n`.
/// - One file per (network, contract), so `chain_cursor` (single row) and `journal` carry neither.
/// - STRICT tables (SQLite ≥ 3.37) and CHECK constraints tying slot state to slot data.
/// - `slots` keeps `pending_name` (mailbox name between reservation and reveal) and two attempt counters.
/// - `ON DELETE CASCADE` on messages and sync cursors.
const MIGRATION_V1: &str = concat!(
    meta_ddl!(),
    "
CREATE TABLE bonos (
  n INTEGER NOT NULL,
  k INTEGER NOT NULL,
  plan TEXT NOT NULL CHECK(plan IN ('free','paid')),
  id BLOB NOT NULL CHECK(length(id) = 32),
  status TEXT NOT NULL CHECK(status IN ('requested','included')),
  position INTEGER CHECK(position IS NULL OR (position >= 0 AND position < 1048576)),
  requested_at INTEGER NOT NULL,
  usable_at INTEGER,
  PRIMARY KEY(n, k),
  CHECK((status = 'included') = (position IS NOT NULL))
) STRICT;
CREATE TABLE slots (
  n INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('mailbox','alias')),
  j INTEGER NOT NULL,
  slot_nul BLOB NOT NULL UNIQUE CHECK(length(slot_nul) = 32),
  status TEXT NOT NULL CHECK(status IN ('reserving','reserved','revealing','used','burned')),
  addr_key BLOB CHECK(addr_key IS NULL OR length(addr_key) = 32),
  round INTEGER CHECK(round IS NULL OR round >= 0),
  pending_name TEXT,
  reserve_attempts INTEGER NOT NULL DEFAULT 0,
  reveal_attempts INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(n, kind, j),
  CHECK(status != 'used' OR addr_key IS NOT NULL),
  CHECK(status NOT IN ('reserved','revealing') OR round IS NOT NULL),
  CHECK(status != 'revealing' OR pending_name IS NOT NULL),
  CHECK(kind = 'mailbox' OR status NOT IN ('reserved','revealing')),
  CHECK(NOT (kind = 'mailbox' AND status = 'reserving' AND pending_name IS NULL)),
  CHECK(status NOT IN ('used','burned') OR pending_name IS NULL)
) STRICT;
CREATE TABLE addresses (
  addr_key BLOB PRIMARY KEY CHECK(length(addr_key) = 32),
  kind TEXT NOT NULL CHECK(kind IN ('mailbox','alias')),
  n INTEGER NOT NULL,
  j INTEGER NOT NULL,
  display TEXT NOT NULL,
  name TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(n, kind, j)
) STRICT;
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  addr_key BLOB NOT NULL REFERENCES addresses(addr_key) ON DELETE CASCADE,
  server_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  size_bucket INTEGER NOT NULL,
  raw BLOB NOT NULL,
  from_addr TEXT,
  subject TEXT,
  sent_at INTEGER,
  preview TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  starred INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  UNIQUE(addr_key, server_id)
) STRICT;
CREATE INDEX messages_by_date ON messages(received_at DESC, id DESC);
CREATE TABLE sync_cursors (
  addr_key BLOB PRIMARY KEY REFERENCES addresses(addr_key) ON DELETE CASCADE,
  since TEXT NOT NULL
) STRICT;
CREATE TABLE skipped_messages (
  addr_key BLOB NOT NULL CHECK(length(addr_key) = 32) REFERENCES addresses(addr_key) ON DELETE CASCADE,
  server_id TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  reason TEXT CHECK(reason IS NULL OR reason IN ('undecryptable','too-large','not-found','unparseable','failed')),
  last_at INTEGER NOT NULL,
  PRIMARY KEY(addr_key, server_id)
) STRICT;
CREATE TABLE chain_cursor (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  min_leaf_count INTEGER NOT NULL DEFAULT 0 CHECK(min_leaf_count >= 0 AND min_leaf_count <= 1048576),
  behind_streak INTEGER NOT NULL DEFAULT 0
) STRICT;
INSERT INTO chain_cursor (id) VALUES (1);
CREATE TABLE journal (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload BLOB NOT NULL,
  started_at INTEGER NOT NULL
) STRICT;
"
);

/// v2, additive (no table rebuild, see the cascade warning): local "abandoned address" mark, in Unix seconds UTC
/// (`NULL` = active). The row is kept so its messages are not cascade-deleted.
const MIGRATION_V2: &str = "ALTER TABLE addresses ADD COLUMN abandoned_at INTEGER;";

/// v3, additive: messages sent from this device. They live only here (not on the server or the chain), so restoring
/// with the 24 words on another device does not bring them back.
/// - `addr_key` is our sending address (cascade like `messages`; hidden, not deleted, when it is abandoned).
/// - `message_id` (16 bytes) makes the insert idempotent.
/// - `sent_at` is the client's clock at send time (unverified), in the e2e date range `0..2^53`.
/// - Byte limits mirror the e2e mail format (`mail/e2e.rs`): addresses up to 255, subject up to 1024, body up to
///   25 MiB. The store checks them first; the `CHECK`s are a backstop.
/// - `failure` is set exactly when `status = 'failed'`.
const MIGRATION_V3: &str = "
CREATE TABLE sent_messages (
  id INTEGER PRIMARY KEY,
  message_id BLOB NOT NULL UNIQUE CHECK(length(message_id) = 16),
  addr_key BLOB NOT NULL CHECK(length(addr_key) = 32) REFERENCES addresses(addr_key) ON DELETE CASCADE,
  from_addr TEXT NOT NULL CHECK(length(CAST(from_addr AS BLOB)) BETWEEN 1 AND 255),
  to_addr TEXT NOT NULL CHECK(length(CAST(to_addr AS BLOB)) BETWEEN 1 AND 255),
  subject TEXT NOT NULL CHECK(length(CAST(subject AS BLOB)) <= 1024),
  body TEXT NOT NULL CHECK(length(CAST(body AS BLOB)) <= 26214400),
  sent_at INTEGER NOT NULL CHECK(sent_at >= 0 AND sent_at <= 9007199254740991),
  status TEXT NOT NULL CHECK(status IN ('queued','sent','failed')),
  failure TEXT CHECK(failure IS NULL OR failure IN
    ('no-recipient','recipient-key','mailbox-full','rate-limited','too-large','network','chain-unavailable','failed')),
  CHECK((status = 'failed') = (failure IS NOT NULL))
) STRICT;
CREATE INDEX sent_messages_by_date ON sent_messages(sent_at DESC, id DESC);
CREATE INDEX sent_messages_by_sender ON sent_messages(addr_key, sent_at DESC, id DESC);
";

/// v4, additive: received end-to-end mail (`nightmail:e2e`, see `mail::inbox`). It goes in `messages` like SMTP mail,
/// as a MIME synthesised on arrival, plus what that MIME cannot say:
/// - `e2e` marks it; `sender_verified` says its signature, sender and recipient checked out (never set without `e2e`).
/// - `sender_addr_key` and `sender_message_id` identify it for deduplication; `sender_date` keeps the date the sender
///   wrote (unverified, up to 9999-12-31), since the MIME `Date` is the server's arrival time. These three are set
///   exactly when `e2e = 1`.
/// - At most one verified mail per (our address, sender `addrKey`, messageId): `messages_e2e_verified`.
/// - `e2e_dropped`: envelopes downloaded and not kept as a message (a duplicate, or an unverified copy the verified one
///   replaced), so sync does not download them again.
/// - `e2e_pending`: mail whose sender could not be looked up yet (the registry did not answer), with its plaintext,
///   to try again later; `next_at` in Unix seconds.
const MIGRATION_V4: &str = "
ALTER TABLE messages ADD COLUMN e2e INTEGER NOT NULL DEFAULT 0 CHECK(e2e IN (0, 1));
ALTER TABLE messages ADD COLUMN sender_verified INTEGER NOT NULL DEFAULT 0 CHECK(sender_verified IN (0, 1));
ALTER TABLE messages ADD COLUMN sender_addr_key BLOB CHECK(sender_addr_key IS NULL OR length(sender_addr_key) = 32);
ALTER TABLE messages ADD COLUMN sender_message_id BLOB
  CHECK(sender_message_id IS NULL OR length(sender_message_id) = 16);
ALTER TABLE messages ADD COLUMN sender_date INTEGER CHECK(
  (sender_date IS NULL OR (sender_date >= 0 AND sender_date <= 253402300799))
  AND (e2e = 1) = (sender_addr_key IS NOT NULL AND sender_message_id IS NOT NULL AND sender_date IS NOT NULL)
  AND (sender_verified = 0 OR e2e = 1));
CREATE UNIQUE INDEX messages_e2e_verified ON messages(addr_key, sender_addr_key, sender_message_id)
  WHERE sender_verified = 1;
CREATE INDEX messages_e2e ON messages(addr_key, sender_addr_key, sender_message_id) WHERE e2e = 1;
CREATE TABLE e2e_dropped (
  addr_key BLOB NOT NULL CHECK(length(addr_key) = 32) REFERENCES addresses(addr_key) ON DELETE CASCADE,
  server_id TEXT NOT NULL,
  PRIMARY KEY(addr_key, server_id)
) STRICT;
CREATE TABLE e2e_pending (
  addr_key BLOB NOT NULL CHECK(length(addr_key) = 32) REFERENCES addresses(addr_key) ON DELETE CASCADE,
  server_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  size_bucket INTEGER NOT NULL,
  plaintext BLOB NOT NULL CHECK(length(plaintext) <= 26214400),
  attempts INTEGER NOT NULL CHECK(attempts >= 0),
  next_at INTEGER NOT NULL,
  PRIMARY KEY(addr_key, server_id)
) STRICT;
";

pub(super) const MIGRATIONS: &[&str] = &[MIGRATION_V1, MIGRATION_V2, MIGRATION_V3, MIGRATION_V4];

pub(super) fn version(conn: &Connection) -> Result<u32> {
    Ok(conn.query_row("PRAGMA user_version", [], |r| r.get(0))?)
}

/// Applies the migrations newer than the current version, each in its own transaction. The list is injectable so
/// v2 and failures can be tested.
pub(super) fn migrate_with(conn: &Connection, migrations: &[&str]) -> Result<()> {
    let current = version(conn)? as usize;
    if current > migrations.len() {
        return Err(StoreError::SchemaTooNew);
    }
    for (index, sql) in migrations.iter().enumerate().skip(current) {
        apply(conn, sql, index + 1)?;
    }
    Ok(())
}

/// One migration: `BEGIN IMMEDIATE` (write lock from the start), re-read `user_version` inside the transaction
/// (another process may have migrated meanwhile, in which case it is not repeated), run the SQL and bump the
/// version. SQL that ends the transaction itself (`COMMIT`) is an error.
pub(super) fn apply(conn: &Connection, sql: &str, new_version: usize) -> Result<()> {
    conn.execute_batch("BEGIN IMMEDIATE;")?;
    match apply_in_transaction(conn, sql, new_version) {
        Ok(()) => Ok(conn.execute_batch("COMMIT;")?),
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK;");
            Err(e)
        }
    }
}

fn apply_in_transaction(conn: &Connection, sql: &str, new_version: usize) -> Result<()> {
    if version(conn)? as usize >= new_version {
        return Ok(());
    }
    // The newline and `;` stop a trailing SQL comment from swallowing what follows.
    conn.execute_batch(&format!(
        "{sql}
;"
    ))?;
    if conn.is_autocommit() {
        return Err(StoreError::Db);
    }
    conn.execute_batch(&format!("PRAGMA user_version = {new_version};"))?;
    Ok(())
}

/// Whether the error is "file is not a database (or the key does not open it)".
pub(super) fn is_not_a_database(e: &rusqlite::Error) -> bool {
    e.sqlite_error_code() == Some(ErrorCode::NotADatabase)
}
