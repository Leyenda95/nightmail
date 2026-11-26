//! Touched slots of a bono. Free slots have no row.

use rusqlite::types::Type;
use rusqlite::{Connection, Row, params};
use serde::{Deserialize, Serialize};

use super::{Address, Bytes32, LocalStore, Result, SlotKind, SlotStatus, StoreError, addresses, cursors, first};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SlotKey {
    pub n: u32,
    pub kind: SlotKind,
    pub j: u32,
}

/// A touched slot. `pending_name` (mailbox name between reservation and reveal) is personal and hidden from `Debug`.
#[derive(Clone, PartialEq, Eq)]
pub struct Slot {
    pub key: SlotKey,
    pub slot_nul: Bytes32,
    pub status: SlotStatus,
    pub addr_key: Option<Bytes32>,
    pub round: Option<u64>,
    pub pending_name: Option<String>,
    pub reserve_attempts: u32,
    pub reveal_attempts: u32,
    /// Unix seconds UTC.
    pub updated_at: i64,
}

opaque_debug!(Slot {
    key,
    status,
    reserve_attempts,
    reveal_attempts,
    updated_at
});

impl Slot {
    /// Whether [`LocalStore::abandon_reserving_slot`] would release it with that `not_after`. Same rule as its SQL
    /// (which is authoritative): `reserving` with no attempts, or with the last one before `not_after`.
    pub fn abandonable(&self, not_after: i64) -> bool {
        self.status == SlotStatus::Reserving
            && ((self.reserve_attempts == 0 && self.reveal_attempts == 0) || self.updated_at < not_after)
    }
}

/// Data accompanying a transition; `None` leaves the value as it was.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct SlotPatch {
    pub addr_key: Option<Bytes32>,
    pub round: Option<u64>,
    pub pending_name: Option<String>,
}

opaque_debug!(SlotPatch { round });

/// Which attempt counter goes up. They never reset, so the proof cap cannot be dodged by releasing the slot. The
/// store only counts; the policy (what to do when exhausted) belongs to the orchestrator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttemptKind {
    Reserve,
    Reveal,
}

const SLOT_COLUMNS: &str = "n, kind, j, slot_nul, status, addr_key, round, pending_name, reserve_attempts, \
                            reveal_attempts, updated_at";

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
        round: round_from_db(row.get(6)?)?,
        pending_name: row.get(7)?,
        reserve_attempts: row.get(8)?,
        reveal_attempts: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn round_from_db(value: Option<i64>) -> rusqlite::Result<Option<u64>> {
    let convert =
        |v| u64::try_from(v).map_err(|e| rusqlite::Error::FromSqlConversionFailure(6, Type::Integer, Box::new(e)));
    value.map(convert).transpose()
}

fn round_to_db(value: Option<u64>) -> Result<Option<i64>> {
    value
        .map(|v| i64::try_from(v).map_err(|_| StoreError::OutOfRange))
        .transpose()
}

const WHERE_KEY: &str = "WHERE n = ?1 AND kind = ?2 AND j = ?3";

fn get(conn: &Connection, key: SlotKey) -> Result<Option<Slot>> {
    let sql = format!("SELECT {SLOT_COLUMNS} FROM slots {WHERE_KEY}");
    first(conn, &sql, params![key.n, key.kind, key.j], map_slot)
}

/// Required data per state. An alias never goes through `reserved`/`revealing`. A mailbox in `reserving` already
/// carries its name (a crash right after sending the reservation would otherwise lose it). `reserved` only requires
/// the round: a reservation recovered from the chain has no name and the app will ask for it; `revealing` requires
/// round and name.
fn check_state(kind: SlotKind, status: SlotStatus, data: &SlotPatch) -> Result<()> {
    use SlotStatus::*;
    if kind == SlotKind::Alias && matches!(status, Reserved | Revealing) {
        return Err(StoreError::InvalidTransition);
    }
    let missing = match status {
        Reserving => kind == SlotKind::Mailbox && data.pending_name.is_none(),
        Reserved => data.round.is_none(),
        Revealing => data.round.is_none() || data.pending_name.is_none(),
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
    agrees(&patch.addr_key, &cur.addr_key)
        && agrees(&patch.round, &cur.round)
        && agrees(&patch.pending_name, &cur.pending_name)
}

fn merged(cur: &Slot, patch: &SlotPatch) -> SlotPatch {
    SlotPatch {
        addr_key: patch.addr_key.or(cur.addr_key),
        round: patch.round.or(cur.round),
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
    if cur.status != to && !step_allowed(&cur, key.kind, to, reconcile) {
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

fn step_allowed(cur: &Slot, kind: SlotKind, to: SlotStatus, reconcile: bool) -> bool {
    if reconcile {
        cur.status.reconcile_ok(to)
    } else {
        cur.status.can_become(kind, to)
    }
}

fn write_state(conn: &Connection, key: SlotKey, to: SlotStatus, data: &SlotPatch, now: i64) -> Result<()> {
    let sql = format!(
        "UPDATE slots SET status = ?4, addr_key = ?5, round = ?6, pending_name = ?7, updated_at = ?8 {WHERE_KEY}"
    );
    let round = round_to_db(data.round)?;
    conn.execute(
        &sql,
        params![key.n, key.kind, key.j, to, data.addr_key, round, data.pending_name, now],
    )?;
    Ok(())
}

fn bump(conn: &Connection, key: SlotKey, kind: AttemptKind, now: i64) -> Result<u32> {
    let column = match kind {
        AttemptKind::Reserve => "reserve_attempts",
        AttemptKind::Reveal => "reveal_attempts",
    };
    let sql = format!("UPDATE slots SET {column} = {column} + 1, updated_at = ?4 {WHERE_KEY} RETURNING {column}");
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

    /// Unfinished slots (`reserving`, `reserved` and `revealing`) in a single read, so a slot changing state between
    /// two queries cannot appear twice or go missing.
    pub fn open_slots(&self) -> Result<Vec<Slot>> {
        let sql = format!("SELECT {SLOT_COLUMNS} FROM slots WHERE status IN (?1, ?2, ?3) ORDER BY n, kind, j");
        self.query_all(&sql, [SlotStatus::Reserving, SlotStatus::Reserved, SlotStatus::Revealing], map_slot)
    }

    /// Normal flow transition. Repeating it with the same data is harmless; with other data, `Conflict`; invalid,
    /// `InvalidTransition` (`Conflict` if the slot is already final); missing data, `MissingData`.
    pub fn transition_slot(&self, key: SlotKey, to: SlotStatus, patch: &SlotPatch, now: i64) -> Result<()> {
        self.write(|tx| transition(tx, key, to, patch, now, false))
    }

    /// `Recovery` transition: what the chain says wins (reserved → used, burned → used…).
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

    /// Adds an attempt and returns the total. Counters never reset on their own.
    pub fn bump_slot_attempts(&self, key: SlotKey, kind: AttemptKind, now: i64) -> Result<u32> {
        bump(&self.conn(), key, kind, now)
    }

    /// The user resumes a slot paused by the proof cap. Zeroes both counters of a non-final slot; the only way to
    /// reset them, and only on user request.
    pub fn reset_slot_attempts(&self, key: SlotKey, now: i64) -> Result<()> {
        let sql = format!(
            "UPDATE slots SET reserve_attempts = 0, reveal_attempts = 0, updated_at = ?4 {WHERE_KEY} \
             AND status IN ('reserving', 'reserved', 'revealing')"
        );
        self.write(|tx| match tx.execute(&sql, params![key.n, key.kind, key.j, now])? {
            1 => Ok(()),
            _ if get(tx, key)?.is_none() => Err(StoreError::NotFound),
            _ => Err(StoreError::InvalidTransition),
        })
    }

    /// `Recovery`/orchestrator saw our reservation on chain: the slot becomes `reserved` with its round (rules of
    /// [`reconcile_slot`](Self::reconcile_slot)) and, if `keep_name` is `false` (the stored name does not match the
    /// commitment), the name is dropped. All in one transaction.
    pub fn reconcile_reserved(&self, key: SlotKey, round: u64, keep_name: bool, now: i64) -> Result<()> {
        self.write(|tx| {
            let patch = SlotPatch { round: Some(round), ..SlotPatch::default() };
            transition(tx, key, SlotStatus::Reserved, &patch, now, true)?;
            if !keep_name {
                tx.execute(&format!("UPDATE slots SET pending_name = NULL {WHERE_KEY}"), params![key.n, key.kind, key.j])?;
            }
            Ok(())
        })
    }

    /// User action: releases a `reserving` slot in one operation. With no attempts, always; with attempts, only if
    /// its last change (`updated_at`, the last proof) is before `not_after`. `true` if released.
    pub fn abandon_reserving_slot(&self, key: SlotKey, not_after: i64) -> Result<bool> {
        let sql = format!(
            "DELETE FROM slots {WHERE_KEY} AND status = 'reserving' \
             AND ((reserve_attempts = 0 AND reveal_attempts = 0) OR updated_at < ?4)"
        );
        self.write(|tx| Ok(tx.execute(&sql, params![key.n, key.kind, key.j, not_after])? == 1))
    }

    /// Drops the name of a `reserved` mailbox (the stored one does not match the on-chain commitment); the app will
    /// ask again. In any other state: `InvalidTransition`.
    pub fn clear_slot_name(&self, key: SlotKey, now: i64) -> Result<()> {
        let sql = format!("UPDATE slots SET pending_name = NULL, updated_at = ?4 {WHERE_KEY} AND status = 'reserved'");
        self.write(|tx| match tx.execute(&sql, params![key.n, key.kind, key.j, now])? {
            1 => Ok(()),
            _ if get(tx, key)?.is_none() => Err(StoreError::NotFound),
            _ => Err(StoreError::InvalidTransition),
        })
    }

    /// Frees a slot whose reservation failed without being consumed: only while still `reserving` and never
    /// attempted (releasing a slot with counted attempts would dodge the proof cap). Missing: `NotFound`; not
    /// releasable: `InvalidTransition`.
    pub fn release_slot(&self, key: SlotKey) -> Result<()> {
        let sql =
            format!("DELETE FROM slots {WHERE_KEY} AND status = ?4 AND reserve_attempts = 0 AND reveal_attempts = 0");
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
        round: slot.round,
        pending_name: None,
        updated_at: now,
        ..slot.clone()
    }
}

fn insert(conn: &Connection, slot: &Slot) -> Result<()> {
    let data = SlotPatch {
        addr_key: slot.addr_key,
        round: slot.round,
        pending_name: slot.pending_name.clone(),
    };
    check_state(slot.key.kind, slot.status, &data)?;
    let k = slot.key;
    let sql = format!("INSERT INTO slots ({SLOT_COLUMNS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)");
    let round = round_to_db(slot.round)?;
    conn.execute(
        &sql,
        params![
            k.n,
            k.kind,
            k.j,
            slot.slot_nul,
            slot.status,
            slot.addr_key,
            round,
            slot.pending_name,
            slot.reserve_attempts,
            slot.reveal_attempts,
            slot.updated_at
        ],
    )?;
    Ok(())
}
