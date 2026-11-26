//! Our own addresses (mailbox and alias).

use rusqlite::{Connection, Row, params};

use super::{Bytes32, LocalStore, Result, SlotKind, StoreError, first};

/// One of our addresses. `display` and `name` are personal data and hidden from `Debug`. The local "abandoned" mark
/// (`abandoned_at`) is not part of the type; it is queried separately ([`LocalStore::list_abandoned_addresses`]),
/// so restore never compares or clears it.
#[derive(Clone, PartialEq, Eq)]
pub struct Address {
    pub addr_key: Bytes32,
    pub kind: SlotKind,
    pub n: u32,
    pub j: u32,
    /// Full address as text.
    pub display: String,
    pub name: Option<String>,
    /// Unix seconds UTC.
    pub created_at: i64,
}

opaque_debug!(Address { kind, n, j, created_at });

const ADDRESS_COLUMNS: &str = "addr_key, kind, n, j, display, name, created_at";

fn map_address(row: &Row<'_>) -> rusqlite::Result<Address> {
    Ok(Address {
        addr_key: row.get(0)?,
        kind: row.get(1)?,
        n: row.get(2)?,
        j: row.get(3)?,
        display: row.get(4)?,
        name: row.get(5)?,
        created_at: row.get(6)?,
    })
}

/// Equal except for `created_at`. Ignores `abandoned_at` too (not part of `Address`): restoring an abandoned address
/// into the same database is not a `Conflict` and leaves it abandoned.
fn same_but_date(old: &Address, new: &Address) -> bool {
    Address {
        created_at: new.created_at,
        ..old.clone()
    } == *new
}

pub(super) fn get(conn: &Connection, addr_key: &Bytes32) -> Result<Option<Address>> {
    let sql = format!("SELECT {ADDRESS_COLUMNS} FROM addresses WHERE addr_key = ?1");
    first(conn, &sql, [addr_key], map_address)
}

/// `true` if new; `false` if already present and identical (except `created_at`); `Conflict` if present but
/// different, or if another `addr_key` already holds the same slot `(n, kind, j)`.
pub(super) fn insert(conn: &Connection, a: &Address) -> Result<bool> {
    let rows = conn.execute(
        "INSERT INTO addresses (addr_key, kind, n, j, display, name, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(addr_key) DO NOTHING",
        params![a.addr_key, a.kind, a.n, a.j, a.display, a.name, a.created_at],
    )?;
    if rows == 1 {
        return Ok(true);
    }
    match get(conn, &a.addr_key)? {
        Some(old) if same_but_date(&old, a) => Ok(false),
        _ => Err(StoreError::Conflict),
    }
}

impl LocalStore {
    pub fn insert_address(&self, a: &Address) -> Result<bool> {
        insert(&self.conn(), a)
    }

    pub fn get_address(&self, addr_key: &Bytes32) -> Result<Option<Address>> {
        get(&self.conn(), addr_key)
    }

    /// Names a restored mailbox that has none (`name` NULL). Already named: `Conflict`. Missing or abandoned:
    /// `NotFound` (the app no longer tracks it).
    pub fn set_address_name(&self, addr_key: &Bytes32, name: &str, display: &str) -> Result<()> {
        let sql = "UPDATE addresses SET name = ?2, display = ?3
                   WHERE addr_key = ?1 AND kind = 'mailbox' AND name IS NULL AND abandoned_at IS NULL";
        match self.run(sql, params![addr_key, name, display])? {
            1 => Ok(()),
            _ if self.get_address(addr_key)?.is_none() || self.is_address_abandoned(addr_key)? => {
                Err(StoreError::NotFound)
            }
            _ => Err(StoreError::Conflict),
        }
    }

    /// Whether it is abandoned. A missing address is not.
    pub fn is_address_abandoned(&self, addr_key: &Bytes32) -> Result<bool> {
        let sql = "SELECT 1 FROM addresses WHERE addr_key = ?1 AND abandoned_at IS NOT NULL";
        Ok(self.query_opt(sql, [addr_key], |_| Ok(()))?.is_some())
    }

    /// Active (non-abandoned) addresses, oldest first.
    pub fn list_addresses(&self) -> Result<Vec<Address>> {
        self.addresses_by_state(false)
    }

    /// Abandoned addresses, oldest first. They still take up their plan slot.
    pub fn list_abandoned_addresses(&self) -> Result<Vec<Address>> {
        self.addresses_by_state(true)
    }

    /// Irreversible local mark: the address is no longer listed and its messages are hidden (nothing is deleted).
    /// `true` if abandoned now, `false` if it already was (the first date is kept). Missing: `NotFound`.
    pub fn abandon_address(&self, addr_key: &Bytes32, now: i64) -> Result<bool> {
        let sql = "UPDATE addresses SET abandoned_at = ?2 WHERE addr_key = ?1 AND abandoned_at IS NULL";
        match self.run(sql, params![addr_key, now])? {
            1 => Ok(true),
            _ if self.get_address(addr_key)?.is_none() => Err(StoreError::NotFound),
            _ => Ok(false),
        }
    }

    /// Abandoned (`abandoned`) or active addresses.
    fn addresses_by_state(&self, abandoned: bool) -> Result<Vec<Address>> {
        let sql = format!(
            "SELECT {ADDRESS_COLUMNS} FROM addresses WHERE (abandoned_at IS NOT NULL) = ?1 ORDER BY created_at, n, j"
        );
        self.query_all(&sql, [abandoned], map_address)
    }
}
