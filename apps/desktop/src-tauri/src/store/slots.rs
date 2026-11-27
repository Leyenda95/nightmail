//! Touched slots of a bono. Free slots have no row.

use rusqlite::{Connection, Row, params};
use serde::{Deserialize, Serialize};

use super::{Address, Bytes32, LocalStore, Result, SlotKind, SlotStatus, StoreError, addresses, cursors, first};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SlotKey {
    pub n: u32,
    pub kind: SlotKind,
    pub j: u32,
}

/// A touched slot. `pending_name` (mailbox name until it is registered) is personal and hidden from `Debug`.
#[derive(Clone, PartialEq, Eq)]
pub struct Slot {
    pub key: SlotKey,
    pub slot_nul: Bytes32,
    pub status: SlotStatus,
    pub addr_key: Option<Bytes32>,
    pub pending_name: Option<String>,
    /// Proofs counted for the slot (`reserve_attempts` column).
    pub attempts: u32,
    /// Unix seconds UTC.
    pub updated_at: i64,
}

opaque_debug!(Slot {
    key,
    status,
    attempts,
    updated_at
});

impl Slot {
    /// Whether [`LocalStore::abandon_reserving_slot`] would release it with that `not_after`. Same rule as its SQL
    /// (which is authoritative): `reserving` with no attempts, or with the last one before `not_after`.
    pub fn abandonable(&self, not_after: i64) -> bool {
        self.status == SlotStatus::Reserving && (self.attempts == 0 || self.updated_at < not_after)
    }
}

/// Data accompanying a transition; `None` leaves the value as it was.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct SlotPatch {
    pub addr_key: Option<Bytes32>,
    pub pending_name: Option<String>,
}

opaque_debug!(SlotPatch {});

const SLOT_COLUMNS: &str = "n, kind, j, slot_nul, status, addr_key, pending_name, reserve_attempts, updated_at";

fn map_slot(row: &Row<'_>) -> rusqlite::Result<Slot> {
    Ok(Slot {
        key: SlotKey {
            n: row.get(0)?,
            kind: row.get(1)?,
            j: row.get(2)?,
        },
        slot_nul: row.get(3)?,
        status: row.get(4)?,
        addr_key: row.get(5)?,
        pending_name: row.get(6)?,
        attempts: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

const WHERE_KEY: &str = "WHERE n = ?1 AND kind = ?2 AND j = ?3";

fn get(conn: &Connection, key: SlotKey) -> Result<Option<Slot>> {
    let sql = format!("SELECT {SLOT_COLUMNS} FROM slots {WHERE_KEY}");
    first(conn, &sql, params![key.n, key.kind, key.j], map_slot)
}

/// Required data per state. A mailbox in `reserving` already carries its name (a crash right after sending the
/// registration would otherwise lose it).
fn check_state(kind: SlotKind, status: SlotStatus, data: &SlotPatch) -> Result<()> {
    use SlotStatus::*;
    let missing = match status {
        Reserving => kind == SlotKind::Mailbox && data.pending_name.is_none(),
        Used => data.addr_key.is_none(),
        Burned => false,
    };
    if missing { Err(StoreError::MissingData) } else { Ok(()) }
}

/// New data does not contradict stored data: no patch, nothing stored yet (filling a gap), or equal.
fn agrees<T: PartialEq>(patch: &Option<T>, current: &Option<T>) -> bool {
    patch.is_none() || current.is_none() || patch == current
}

/// A patch never overwrites an already set value with a different one (in this transition or any other).
fn patch_agrees(cur: &Slot, patch: &SlotPatch) -> bool {
    agrees(&patch.addr_key, &cur.addr_key) && agrees(&patch.pending_name, &cur.pending_name)
}

fn merged(cur: &Slot, patch: &SlotPatch) -> SlotPatch {
    SlotPatch {
        addr_key: patch.addr_key.or(cur.addr_key),
        pending_name: patch.pending_name.clone().or_else(|| cur.pending_name.clone()),
    }
}

/// Changes the state. `reconcile` uses the `Recovery` rules (see [`SlotStatus::reconcile_ok`]); otherwise the normal
/// flow rules ([`SlotStatus::can_become`]). From a final state: `Conflict`. With the same state only missing data is
/// filled in; data differing from what is stored is `Conflict`.
fn transition(
    conn: &Connection,
    key: SlotKey,
    to: SlotStatus,
    patch: &SlotPatch,
    now: i64,
    reconcile: bool,
) -> Result<()> {
    let cur = get(conn, key)?.ok_or(StoreError::NotFound)?;
    if cur.status != to && !step_allowed(&cur, to, reconcile) {
        return Err(if cur.status.is_final() {
            StoreError::Conflict
        } else {
            StoreError::InvalidTransition
        });
    }
    if !patch_agrees(&cur, patch) {
        return Err(StoreError::Conflict);
    }
    let mut data = merged(&cur, patch);
    check_state(key.kind, to, &data)?;
    if to.is_final() {
        data.pending_name = None; // no longer needed: do not keep a name around
    }
    write_state(conn, key, to, &data, now)
}

fn step_allowed(cur: &Slot, to: SlotStatus, reconcile: bool) -> bool {
    if reconcile { cur.status.reconcile_ok(to) } else { cur.status.can_become(to) }
}

fn write_state(conn: &Connection, key: SlotKey, to: SlotStatus, data: &SlotPatch, now: i64) -> Result<()> {
    let sql = format!("UPDATE slots SET status = ?4, addr_key = ?5, pending_name = ?6, updated_at = ?7 {WHERE_KEY}");
    conn.execute(&sql, params![key.n, key.kind, key.j, to, data.addr_key, data.pending_name, now])?;
    Ok(())
}

fn bump(conn: &Connection, key: SlotKey, now: i64) -> Result<u32> {
    let sql = format!(
        "UPDATE slots SET reserve_attempts = reserve_attempts + 1, updated_at = ?4 {WHERE_KEY} RETURNING reserve_attempts"
    );
    first(conn, &sql, params![key.n, key.kind, key.j, now], |r| r.get(0))?.ok_or(StoreError::NotFound)
}

impl LocalStore {
    /// Records a touched slot (first time). A slot or `slot_nul` already recorded: `Conflict`. The initial state is
    /// free (Recovery may find slots already used or burned) but it must carry the data that state requires.
    pub fn insert_slot(&self, slot: &Slot) -> Result<()> {
        insert(&self.conn(), slot)
    }

    pub fn get_slot(&self, key: SlotKey) -> Result<Option<Slot>> {
        get(&self.conn(), key)
    }

    /// Every slot of a bono, ordered by kind and number.
    pub fn list_slots(&self, n: u32) -> Result<Vec<Slot>> {
        let sql = format!("SELECT {SLOT_COLUMNS} FROM slots WHERE n = ?1 ORDER BY kind, j");
        self.query_all(&sql, [n], map_slot)
    }

    /// Slots in a given state (e.g. the `reserving` ones to resume at startup).
    pub fn slots_by_status(&self, status: SlotStatus) -> Result<Vec<Slot>> {
        let sql = format!("SELECT {SLOT_COLUMNS} FROM slots WHERE status = ?1 ORDER BY n, kind, j");
        self.query_all(&sql, [status], map_slot)
    }


    /// Normal flow transition. Repeating it with the same data is harmless; with other data, `Conflict`; invalid,
    /// `InvalidTransition` (`Conflict` if the slot is already final); missing data, `MissingData`.
    pub fn transition_slot(&self, key: SlotKey, to: SlotStatus, patch: &SlotPatch, now: i64) -> Result<()> {
        self.write(|tx| transition(tx, key, to, patch, now, false))
    }

    /// `Recovery` transition: what the chain says wins (reserving → used, burned → used…).
    pub fn reconcile_slot(&self, key: SlotKey, to: SlotStatus, patch: &SlotPatch, now: i64) -> Result<()> {
        self.write(|tx| transition(tx, key, to, patch, now, true))
    }

    /// Atomic completion: the slot becomes `used` with the address's `addr_key`, the address is inserted and, if
    /// given, the journal entry is closed. All or nothing.
    pub fn complete_slot(&self, key: SlotKey, address: &Address, journal_id: Option<&str>, now: i64) -> Result<()> {
        if (address.kind, address.n, address.j) != (key.kind, key.n, key.j) {
            return Err(StoreError::Conflict);
        }
        self.write(|tx| {
            let patch = SlotPatch {
                addr_key: Some(address.addr_key),
                ..SlotPatch::default()
            };
            transition(tx, key, SlotStatus::Used, &patch, now, false)?;
            addresses::insert(tx, address)?;
            journal_id.map_or(Ok(()), |id| cursors::remove_journal_row(tx, id).map(drop))
        })
    }

    /// Adds an attempt and returns the total. The counter never resets on its own, so the proof cap cannot be dodged
    /// by releasing the slot. The one exception is [`free_name_taken_slot`](Self::free_name_taken_slot): it deletes the
    /// row and with it the counter, and only a new user action (another name) starts proving again. The store only
    /// counts; the policy (what to do when exhausted) belongs to the orchestrator.
    pub fn bump_slot_attempts(&self, key: SlotKey, now: i64) -> Result<u32> {
        bump(&self.conn(), key, now)
    }

    /// The user resumes a slot paused by the proof cap. Zeroes the counter of a non-final slot; the only way to reset
    /// it, and only on user request.
    pub fn reset_slot_attempts(&self, key: SlotKey, now: i64) -> Result<()> {
        let sql = format!(
            "UPDATE slots SET reserve_attempts = 0, updated_at = ?4 {WHERE_KEY} AND status = 'reserving'"
        );
        self.write(|tx| match tx.execute(&sql, params![key.n, key.kind, key.j, now])? {
            1 => Ok(()),
            _ if get(tx, key)?.is_none() => Err(StoreError::NotFound),
            _ => Err(StoreError::InvalidTransition),
        })
    }

    /// User action: releases a `reserving` slot in one operation. With no attempts, always; with attempts, only if
    /// its last change (`updated_at`, the last proof) is before `not_after`. `true` if released.
    pub fn abandon_reserving_slot(&self, key: SlotKey, not_after: i64) -> Result<bool> {
        let sql = format!(
            "DELETE FROM slots {WHERE_KEY} AND status = 'reserving' \
             AND (reserve_attempts = 0 OR updated_at < ?4)"
        );
        self.write(|tx| Ok(tx.execute(&sql, params![key.n, key.kind, key.j, not_after])? == 1))
    }

    /// Frees a `reserving` mailbox whose name belongs to another address, even with attempts: none of its proofs can
    /// land (the contract rejects a taken name), so its slot was never spent and can register another name. Nothing
    /// to free (already gone or no longer `reserving`): `Ok`. Deleting the row also drops its attempt counter.
    pub fn free_name_taken_slot(&self, key: SlotKey) -> Result<()> {
        let sql = format!("DELETE FROM slots {WHERE_KEY} AND kind = 'mailbox' AND status = 'reserving'");
        self.write(|tx| tx.execute(&sql, params![key.n, key.kind, key.j]).map(drop).map_err(Into::into))
    }

    /// Frees a slot whose reservation failed without being consumed: only while still `reserving` and never
    /// attempted (releasing a slot with counted attempts would dodge the proof cap). Missing: `NotFound`; not
    /// releasable: `InvalidTransition`.
    pub fn release_slot(&self, key: SlotKey) -> Result<()> {
        let sql =
            format!("DELETE FROM slots {WHERE_KEY} AND status = ?4 AND reserve_attempts = 0");
        self.write(
            |tx| match tx.execute(&sql, params![key.n, key.kind, key.j, SlotStatus::Reserving])? {
                1 => Ok(()),
                _ if get(tx, key)?.is_none() => Err(StoreError::NotFound),
                _ => Err(StoreError::InvalidTransition),
            },
        )
    }

    /// For `Recovery`: the chain says `slot` is used and its address is `address`. Atomic upsert: if the slot is not
    /// recorded it is created as `used`; if it is, it is reconciled to `used` (reserved/burned → used) with the
    /// `addr_key`; the address is inserted (idempotent). `slot_nul` must match the stored one. Any contradiction:
    /// `Conflict` and nothing changes.
    pub fn reconcile_address(&self, slot: &Slot, address: &Address, now: i64) -> Result<()> {
        let key = slot.key;
        if (address.kind, address.n, address.j) != (key.kind, key.n, key.j) {
            return Err(StoreError::Conflict);
        }
        self.write(|tx| {
            match get(tx, key)? {
                Some(old) if old.slot_nul != slot.slot_nul => return Err(StoreError::Conflict),
                Some(_) => {
                    let patch = SlotPatch {
                        addr_key: Some(address.addr_key),
                        ..SlotPatch::default()
                    };
                    transition(tx, key, SlotStatus::Used, &patch, now, true)?;
                }
                None => insert(tx, &used_slot(slot, address, now))?,
            }
            addresses::insert(tx, address).map(drop)
        })
    }
}

fn used_slot(slot: &Slot, address: &Address, now: i64) -> Slot {
    Slot {
        status: SlotStatus::Used,
        addr_key: Some(address.addr_key),
        pending_name: None,
        updated_at: now,
        ..slot.clone()
    }
}

fn insert(conn: &Connection, slot: &Slot) -> Result<()> {
    let data = SlotPatch { addr_key: slot.addr_key, pending_name: slot.pending_name.clone() };
    check_state(slot.key.kind, slot.status, &data)?;
    let k = slot.key;
    let sql = format!("INSERT INTO slots ({SLOT_COLUMNS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)");
    conn.execute(
        &sql,
        params![
            k.n,
            k.kind,
            k.j,
            slot.slot_nul,
            slot.status,
            slot.addr_key,
            slot.pending_name,
            slot.attempts,
            slot.updated_at
        ],
    )?;
    Ok(())
}
