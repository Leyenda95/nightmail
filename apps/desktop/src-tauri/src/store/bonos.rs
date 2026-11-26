//! Requested bono leaves (one row per `(n, k)`).

use rusqlite::{Connection, Row, params};
use serde::{Deserialize, Serialize};

use super::{BonoStatus, Bytes32, LocalStore, MAX_MIN_LEAF_COUNT, Plan, Result, StoreError, cursors, first};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BonoLeaf {
    pub n: u32,
    pub k: u32,
    pub plan: Plan,
    pub id: Bytes32,
    pub status: BonoStatus,
    /// Leaf position in the tree (< 2^20); only once included.
    pub position: Option<u32>,
    pub requested_at: i64,
    /// Instant (Unix seconds) from which the bono can be used, if known.
    pub usable_at: Option<i64>,
}

opaque_debug!(BonoLeaf {
    n,
    k,
    plan,
    status,
    position,
    requested_at,
    usable_at
});

const BONO_COLUMNS: &str = "n, k, plan, id, status, position, requested_at, usable_at";

fn map_bono(row: &Row<'_>) -> rusqlite::Result<BonoLeaf> {
    Ok(BonoLeaf {
        n: row.get(0)?,
        k: row.get(1)?,
        plan: row.get(2)?,
        id: row.get(3)?,
        status: row.get(4)?,
        position: row.get(5)?,
        requested_at: row.get(6)?,
        usable_at: row.get(7)?,
    })
}

fn check_position(position: Option<u32>) -> Result<()> {
    match position {
        Some(p) if p >= MAX_MIN_LEAF_COUNT => Err(StoreError::OutOfRange),
        _ => Ok(()),
    }
}

pub(super) fn get(conn: &Connection, n: u32, k: u32) -> Result<Option<BonoLeaf>> {
    let sql = format!("SELECT {BONO_COLUMNS} FROM bonos WHERE n = ?1 AND k = ?2");
    first(conn, &sql, params![n, k], map_bono)
}

/// Inserts the requested leaf. `true` if new; `false` if already present with the same plan and `id`; `Conflict` if
/// present with another plan or `id`. Only enters as `requested`: an included leaf is recorded with
/// [`LocalStore::mark_bono_included_and_raise`], so the ratchet always rises with it.
fn insert(conn: &Connection, b: &BonoLeaf) -> Result<bool> {
    if b.status != BonoStatus::Requested || b.position.is_some() {
        return Err(StoreError::InvalidTransition);
    }
    let rows = conn.execute(
        "INSERT INTO bonos (n, k, plan, id, status, position, requested_at, usable_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
         ON CONFLICT(n, k) DO NOTHING",
        params![
            b.n,
            b.k,
            b.plan,
            b.id,
            b.status,
            b.position,
            b.requested_at,
            b.usable_at
        ],
    )?;
    if rows == 1 {
        return Ok(true);
    }
    match get(conn, b.n, b.k)? {
        Some(old) if old.plan == b.plan && old.id == b.id => Ok(false),
        _ => Err(StoreError::Conflict),
    }
}

/// `requested → included` with its position. Repeating with the same position is harmless; another is `Conflict`.
pub(super) fn mark_included(conn: &Connection, n: u32, k: u32, position: u32) -> Result<()> {
    check_position(Some(position))?;
    let rows = conn.execute(
        "UPDATE bonos SET status = ?4, position = ?3 WHERE n = ?1 AND k = ?2 AND status = ?5",
        params![n, k, position, BonoStatus::Included, BonoStatus::Requested],
    )?;
    if rows == 1 {
        return Ok(());
    }
    match get(conn, n, k)? {
        None => Err(StoreError::NotFound),
        Some(b) if b.position == Some(position) => Ok(()),
        Some(_) => Err(StoreError::Conflict),
    }
}

impl LocalStore {
    /// Records a requested leaf (see [`insert`]).
    pub fn insert_bono(&self, bono: &BonoLeaf) -> Result<bool> {
        insert(&self.conn(), bono)
    }

    /// Atomic: marks the leaf included, raises the `minLeafCount` ratchet to `position + 1` and, if given, closes the
    /// journal entry. All or nothing.
    pub fn mark_bono_included_and_raise(&self, n: u32, k: u32, position: u32, journal_id: Option<&str>) -> Result<()> {
        self.write(|tx| {
            mark_included(tx, n, k, position)?;
            cursors::raise(tx, position + 1)?;
            if let Some(id) = journal_id {
                cursors::remove_journal_row(tx, id)?;
            }
            Ok(())
        })
    }

    /// Drops a requested leaf that was never issued (to change plan or give up). Only while still `requested`: an
    /// included one is `InvalidTransition`; missing, `NotFound`.
    pub fn forget_requested_bono(&self, n: u32, k: u32) -> Result<()> {
        self.write(|tx| {
            let sql = "DELETE FROM bonos WHERE n = ?1 AND k = ?2 AND status = ?3";
            match tx.execute(sql, params![n, k, BonoStatus::Requested])? {
                1 => Ok(()),
                _ if get(tx, n, k)?.is_none() => Err(StoreError::NotFound),
                _ => Err(StoreError::InvalidTransition),
            }
        })
    }

    /// Claims leaf (n, k) for a payment method before any external call, in one transaction: if `claim_key` already
    /// holds another (non-empty) method, nothing changes and it returns `false`; otherwise it records the requested
    /// leaf (idempotent, see [`insert`]) and the method, and returns `true`.
    pub fn claim_bono_leaf(&self, bono: &BonoLeaf, claim_key: &str, method: &[u8]) -> Result<bool> {
        self.write(|tx| {
            let current: Option<Vec<u8>> = first(tx, "SELECT value FROM meta WHERE key = ?1", [claim_key], |r| r.get(0))?;
            if current.is_some_and(|c| !c.is_empty() && c != method) {
                return Ok(false);
            }
            insert(tx, bono)?;
            tx.execute(
                "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![claim_key, method],
            )?;
            Ok(true)
        })
    }

    /// Like [`forget_requested_bono`](Self::forget_requested_bono), and in the same transaction clears those `meta`
    /// keys (receipt and claimed method).
    pub fn forget_bono_request(&self, n: u32, k: u32, meta_keys: &[&str]) -> Result<()> {
        self.write(|tx| {
            let sql = "DELETE FROM bonos WHERE n = ?1 AND k = ?2 AND status = ?3";
            match tx.execute(sql, params![n, k, BonoStatus::Requested])? {
                1 => {}
                _ if get(tx, n, k)?.is_none() => return Err(StoreError::NotFound),
                _ => return Err(StoreError::InvalidTransition),
            }
            for key in meta_keys {
                tx.execute("UPDATE meta SET value = x'' WHERE key = ?1", [key])?;
            }
            Ok(())
        })
    }

    /// Like [`mark_bono_included_and_raise`](Self::mark_bono_included_and_raise), and in the same transaction sets
    /// `usable_at` if not set yet (an existing `usable_at` is never moved earlier or later).
    pub fn include_bono(&self, n: u32, k: u32, position: u32, usable_at: i64, journal_id: Option<&str>) -> Result<()> {
        self.write(|tx| {
            mark_included(tx, n, k, position)?;
            cursors::raise(tx, position + 1)?;
            tx.execute(
                "UPDATE bonos SET usable_at = COALESCE(usable_at, ?3) WHERE n = ?1 AND k = ?2",
                params![n, k, usable_at],
            )?;
            if let Some(id) = journal_id {
                cursors::remove_journal_row(tx, id)?;
            }
            Ok(())
        })
    }

    /// Sets the instant from which bono (n, k) can be used.
    pub fn set_bono_usable_at(&self, n: u32, k: u32, usable_at: i64) -> Result<()> {
        self.run_found(
            "UPDATE bonos SET usable_at = ?3 WHERE n = ?1 AND k = ?2",
            params![n, k, usable_at],
        )
    }

    pub fn get_bono(&self, n: u32, k: u32) -> Result<Option<BonoLeaf>> {
        get(&self.conn(), n, k)
    }

    /// Every leaf, ordered by `(n, k)`.
    pub fn list_bonos(&self) -> Result<Vec<BonoLeaf>> {
        let sql = format!("SELECT {BONO_COLUMNS} FROM bonos ORDER BY n, k");
        self.query_all(&sql, [], map_bono)
    }
}
