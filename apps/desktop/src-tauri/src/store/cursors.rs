//! Loose settings, sync cursors, the `minLeafCount` ratchet and the operation journal. The database belongs to a
//! single (network, contract), so the ratchet and journal carry no such columns.

use rusqlite::{Connection, Row, params};
use serde::{Deserialize, Serialize};

use super::{BonoStatus, Bytes32, LocalStore, MAX_MIN_LEAF_COUNT, Result, StoreError, first};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChainCursor {
    pub min_leaf_count: u32,
    pub behind_streak: u32,
}

/// Operation with an unknown outcome, recorded before the call (bono purchase, Issuer request…). The `payload` is
/// personal and hidden from `Debug`.
#[derive(Clone, PartialEq, Eq)]
pub struct JournalEntry {
    pub id: String,
    pub kind: String,
    pub payload: Vec<u8>,
    /// Unix seconds UTC.
    pub started_at: i64,
}

opaque_debug!(JournalEntry { id, kind, started_at });

fn map_journal(row: &Row<'_>) -> rusqlite::Result<JournalEntry> {
    Ok(JournalEntry {
        id: row.get(0)?,
        kind: row.get(1)?,
        payload: row.get(2)?,
        started_at: row.get(3)?,
    })
}

/// Raises the ratchet (it only goes up) and returns the current value. Above 2^20: `OutOfRange`, nothing touched.
pub(super) fn raise(conn: &Connection, value: u32) -> Result<u32> {
    if value > MAX_MIN_LEAF_COUNT {
        return Err(StoreError::OutOfRange);
    }
    let sql = "UPDATE chain_cursor SET min_leaf_count = max(min_leaf_count, ?1) WHERE id = 1 RETURNING min_leaf_count";
    first(conn, sql, [value], |r| r.get(0))?.ok_or(StoreError::NotFound)
}

/// Closes a journal entry. `false` if it did not exist.
pub(super) fn remove_journal_row(conn: &Connection, id: &str) -> Result<bool> {
    Ok(conn.execute("DELETE FROM journal WHERE id = ?1", [id])? == 1)
}

impl LocalStore {
    /// Loose setting. `scope.*` keys belong to the store and cannot be changed.
    pub fn set_meta(&self, key: &str, value: &[u8]) -> Result<()> {
        if key.starts_with("scope.") {
            return Err(StoreError::OutOfRange);
        }
        self.exec(
            "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
    }

    pub fn get_meta(&self, key: &str) -> Result<Option<Vec<u8>>> {
        self.query_opt("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
    }

    /// Advances the sync cursor monotonically: if both values are numeric (server sequence numbers) and the new one
    /// is lower than the stored one, it is ignored; equal, higher or non-numeric values are stored. To go back on
    /// purpose use [`reset_sync_cursor`](Self::reset_sync_cursor).
    pub fn set_sync_cursor(&self, addr_key: &Bytes32, since: &str) -> Result<()> {
        const NUMERIC: &str = "(%s GLOB '[0-9]*' AND %s NOT GLOB '*[^0-9]*')";
        let numeric = |column: &str| NUMERIC.replace("%s", column);
        let sql = format!(
            "INSERT INTO sync_cursors (addr_key, since) VALUES (?1, ?2)
             ON CONFLICT(addr_key) DO UPDATE SET since = excluded.since
             WHERE NOT ({} AND {} AND CAST(excluded.since AS INTEGER) < CAST(since AS INTEGER))",
            numeric("since"),
            numeric("excluded.since")
        );
        self.exec(&sql, params![addr_key, since])
    }

    /// Resets the cursor to "0" (re-read the whole mailbox). Explicit because `set_sync_cursor` never goes back.
    pub fn reset_sync_cursor(&self, addr_key: &Bytes32) -> Result<()> {
        self.exec(
            "INSERT INTO sync_cursors (addr_key, since) VALUES (?1, '0')
             ON CONFLICT(addr_key) DO UPDATE SET since = '0'",
            [addr_key],
        )
    }

    /// Opaque server cursor (a sequence number, not a date).
    pub fn get_sync_cursor(&self, addr_key: &Bytes32) -> Result<Option<String>> {
        self.query_opt("SELECT since FROM sync_cursors WHERE addr_key = ?1", [addr_key], |r| {
            r.get(0)
        })
    }

    /// Raises the `minLeafCount` ratchet (it only goes up). Returns the current value.
    pub fn raise_min_leaf_count(&self, value: u32) -> Result<u32> {
        raise(&self.conn(), value)
    }

    /// Explicit ratchet reset: lowers it to the minimum justified by the included leaves (`max(position) + 1`, or 0
    /// if none) and zeroes the streak. Never happens on its own.
    pub fn reset_min_leaf_count(&self) -> Result<()> {
        self.exec(
            "UPDATE chain_cursor SET behind_streak = 0,
             min_leaf_count = COALESCE((SELECT max(position) + 1 FROM bonos WHERE status = ?1), 0)
             WHERE id = 1",
            [BonoStatus::Included],
        )
    }

    /// Counts one more time the sidecar was behind the ratchet; returns the streak.
    pub fn increment_behind_streak(&self) -> Result<u32> {
        let sql = "UPDATE chain_cursor SET behind_streak = behind_streak + 1 WHERE id = 1 RETURNING behind_streak";
        self.query_opt(sql, [], |r| r.get(0))?.ok_or(StoreError::NotFound)
    }

    pub fn reset_behind_streak(&self) -> Result<()> {
        self.exec("UPDATE chain_cursor SET behind_streak = 0 WHERE id = 1", [])
    }

    pub fn get_chain_cursor(&self) -> Result<ChainCursor> {
        let sql = "SELECT min_leaf_count, behind_streak FROM chain_cursor WHERE id = 1";
        let map = |r: &Row<'_>| {
            Ok(ChainCursor {
                min_leaf_count: r.get(0)?,
                behind_streak: r.get(1)?,
            })
        };
        self.query_opt(sql, [], map)?.ok_or(StoreError::NotFound)
    }

    /// Records (or re-records, same `id`) a pending operation.
    pub fn put_journal(&self, e: &JournalEntry) -> Result<()> {
        self.exec(
            "INSERT OR REPLACE INTO journal (id, kind, payload, started_at) VALUES (?1,?2,?3,?4)",
            params![e.id, e.kind, e.payload, e.started_at],
        )
    }

    /// Pending operations, oldest first.
    pub fn list_journal(&self) -> Result<Vec<JournalEntry>> {
        self.query_all(
            "SELECT id, kind, payload, started_at FROM journal ORDER BY started_at, id",
            [],
            map_journal,
        )
    }

    /// Closes an operation. `false` if it did not exist.
    pub fn remove_journal(&self, id: &str) -> Result<bool> {
        remove_journal_row(&self.conn(), id)
    }
}
