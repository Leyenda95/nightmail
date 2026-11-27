//! LocalStore: local, encrypted SQLite database (SQLCipher).
//!
//! Holds received and sent messages, addresses, bonos, slots, cursors and the journal of operations with an unknown
//! outcome.
//! **One file per (network, contract)**: the scope is written to `meta` on creation and checked by `open`.
//!
//! The API is synchronous while the core is async (tokio); from async code use [`LocalStore::with`]
//! (`spawn_blocking` on an `Arc<LocalStore>`). A single connection behind a `Mutex`: SQLite serialises writes and
//! there is only one user, so a pool (`r2d2`) would add nothing.
//!
//! Units: instants are Unix seconds UTC (`i64`); `position` < 2^20.
//!
//! Errors carry fixed messages, never library details or user data. `Debug` on types holding personal data hides
//! those fields.
//!
//! Known limit: `sqlite3_key` avoids putting the key in statement text, but SQLCipher keeps its own key-derived
//! copy in memory while the database is open.

#[macro_use]
mod macros;
mod addresses;
mod bonos;
mod cursors;
mod inbox;
mod messages;
mod schema;
mod sent;
mod slots;
mod types;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::{Connection, OpenFlags, OptionalExtension, Row, Transaction, TransactionBehavior};
use zeroize::Zeroizing;

// Some re-exports are only used by tests.
#[allow(unused_imports)]
pub use addresses::*;
#[allow(unused_imports)]
pub use bonos::*;
#[allow(unused_imports)]
pub use cursors::*;
#[allow(unused_imports)]
pub use inbox::*;
#[allow(unused_imports)]
pub use messages::*;
#[allow(unused_imports)]
pub use sent::*;
#[allow(unused_imports)]
pub use slots::*;
#[allow(unused_imports)]
pub use types::*;

/// Cap for the `minLeafCount` ratchet: 2^20 leaves.
pub const MAX_MIN_LEAF_COUNT: u32 = 1 << 20;

const SCOPE_NETWORK_KEY: &str = "scope.network";
const SCOPE_CONTRACT_KEY: &str = "scope.contract";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreError {
    WrongKey,
    CipherUnavailable,
    Io,
    Db,
    SchemaTooNew,
    InvalidTransition,
    OutOfRange,
    NotFound,
    /// The data contradicts what is stored (different duplicate, final state, repeated key).
    Conflict,
    /// A field required by that state is missing.
    MissingData,
    /// The file belongs to another network or contract.
    ScopeMismatch,
    /// The database or its directory has insecure permissions (looser than 0600/0700).
    InsecurePermissions,
    /// Empty network or contract, or invalid characters.
    InvalidScope,
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::WrongKey => "wrong database key",
            Self::CipherUnavailable => "SQLCipher is not active: refusing to open the database unencrypted",
            Self::Io => "local store file system error",
            Self::Db => "local database error",
            Self::SchemaTooNew => "the database is from a newer version than this app",
            Self::InvalidTransition => "invalid state transition",
            Self::OutOfRange => "value out of range",
            Self::NotFound => "record not found",
            Self::Conflict => "the data contradicts what is already stored",
            Self::MissingData => "a required field is missing",
            Self::ScopeMismatch => "the database belongs to another network or contract",
            Self::InsecurePermissions => "the database or its folder has insecure permissions: fix them (0600 for the file, 0700 for the folder)",
            Self::InvalidScope => "invalid network or contract",
        })
    }
}

impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        use rusqlite::ffi::{SQLITE_CONSTRAINT_PRIMARYKEY, SQLITE_CONSTRAINT_UNIQUE};
        match e.sqlite_error().map(|s| s.extended_code) {
            Some(SQLITE_CONSTRAINT_UNIQUE | SQLITE_CONSTRAINT_PRIMARYKEY) => StoreError::Conflict,
            _ => StoreError::Db,
        }
    }
}

impl From<std::io::Error> for StoreError {
    fn from(e: std::io::Error) -> Self {
        if crate::fsutil::is_insecure(&e) {
            StoreError::InsecurePermissions
        } else {
            StoreError::Io
        }
    }
}

pub type Result<T> = std::result::Result<T, StoreError>;
type MapRow<T> = fn(&Row<'_>) -> rusqlite::Result<T>;

/// Scope of a database: network and contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreScope {
    pub network: String,
    pub contract: String,
}

impl StoreScope {
    /// Normalised scope: lowercase network (`[a-z0-9-]`) and lowercase hex contract (no `0x`). Empty or other
    /// characters: `InvalidScope`. (The network should become an enum once the list is fixed.)
    pub fn new(network: &str, contract: &str) -> Result<Self> {
        Self {
            network: network.into(),
            contract: contract.into(),
        }
        .normalized()
    }

    fn normalized(&self) -> Result<Self> {
        let network = self.network.trim().to_ascii_lowercase();
        let lower = self.contract.trim().to_ascii_lowercase();
        let contract = lower.strip_prefix("0x").unwrap_or(&lower).to_string();
        let network_ok = !network.is_empty()
            && network
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        let contract_ok = !contract.is_empty() && contract.bytes().all(|b| b.is_ascii_hexdigit());
        if network_ok && contract_ok {
            Ok(Self { network, contract })
        } else {
            Err(StoreError::InvalidScope)
        }
    }
}

pub struct LocalStore {
    conn: Mutex<Connection>,
}

impl LocalStore {
    /// Opens (or creates) the encrypted database with the raw 32-byte key, applies pending migrations and checks the
    /// scope (network, contract): a file from another scope gives `ScopeMismatch`. A wrong key only returns
    /// `WrongKey`; nothing is deleted or moved aside (the caller decides that).
    pub fn open(path: &Path, key: &[u8; 32], scope: &StoreScope) -> Result<Self> {
        Self::open_with_migrations(path, key, scope, schema::MIGRATIONS)
    }

    /// [`open`](Self::open) with the given migration list, so tests can create a database stuck at an older version
    /// through the real code path.
    fn open_with_migrations(path: &Path, key: &[u8; 32], scope: &StoreScope, migrations: &[&str]) -> Result<Self> {
        let scope = scope.normalized()?;
        let path = prepare_files(path)?;
        let conn = Connection::open_with_flags(&path, OPEN_FLAGS)?;
        apply_key(&conn, key)?;
        conn.execute_batch("PRAGMA cipher_log_level = NONE; PRAGMA cipher_compatibility = 4;")?;
        ensure_cipher(&conn)?;
        verify_key(&conn)?;
        configure(&conn)?;
        bind_scope(&conn, &scope)?; // before migrating: a database from another scope is left untouched
        schema::migrate_with(&conn, migrations)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    /// Orderly close: checkpoints the WAL into the main file and releases the connection.
    pub fn close(self) -> Result<()> {
        let conn = self.conn.into_inner().unwrap_or_else(|e| e.into_inner());
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        conn.close().map_err(|_| StoreError::Db)
    }

    /// Runs `f` on a blocking thread (`spawn_blocking`): how async code uses the store.
    pub async fn with<T, F>(self: &Arc<Self>, f: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&LocalStore) -> Result<T> + Send + 'static,
    {
        let store = Arc::clone(self);
        tokio::task::spawn_blocking(move || f(&store))
            .await
            .map_err(|_| StoreError::Db)?
    }

    /// Applied schema version (`PRAGMA user_version`).
    pub fn schema_version(&self) -> Result<u32> {
        schema::version(&self.conn())
    }

    /// Scope the database was created with.
    pub fn scope(&self) -> Result<StoreScope> {
        let read = |key| {
            self.get_meta(key)?
                .and_then(|v| String::from_utf8(v).ok())
                .ok_or(StoreError::NotFound)
        };
        Ok(StoreScope {
            network: read(SCOPE_NETWORK_KEY)?,
            contract: read(SCOPE_CONTRACT_KEY)?,
        })
    }

    // ---- internal helpers (private to this module and its submodules) ----

    /// Exclusive connection. A poisoned `Mutex` is recovered: SQLite already rolled back the half-done transaction.
    fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Write transaction (`BEGIN IMMEDIATE`): all or nothing.
    fn write<T>(&self, f: impl FnOnce(&Transaction<'_>) -> Result<T>) -> Result<T> {
        let mut conn = self.conn();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let value = f(&tx)?;
        tx.commit()?;
        Ok(value)
    }

    /// Single write; returns the affected rows.
    fn run(&self, sql: &str, params: impl rusqlite::Params) -> Result<usize> {
        Ok(self.conn().execute(sql, params)?)
    }

    /// Like [`run`](Self::run), for statements whose result does not matter.
    fn exec(&self, sql: &str, params: impl rusqlite::Params) -> Result<()> {
        self.run(sql, params).map(drop)
    }

    /// Like [`run`](Self::run), but zero affected rows is `NotFound`.
    fn run_found(&self, sql: &str, params: impl rusqlite::Params) -> Result<()> {
        match self.run(sql, params)? {
            0 => Err(StoreError::NotFound),
            _ => Ok(()),
        }
    }

    /// Every row of a query, already mapped.
    fn query_all<T>(&self, sql: &str, params: impl rusqlite::Params, map: MapRow<T>) -> Result<Vec<T>> {
        all(&self.conn(), sql, params, map)
    }

    /// The first row of a query, if any.
    fn query_opt<T>(&self, sql: &str, params: impl rusqlite::Params, map: MapRow<T>) -> Result<Option<T>> {
        first(&self.conn(), sql, params, map)
    }
}

/// Like `query_all`, on an already held connection or transaction.
fn all<T>(conn: &Connection, sql: &str, params: impl rusqlite::Params, map: MapRow<T>) -> Result<Vec<T>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params, map)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Like `query_opt`, on an already held connection or transaction.
fn first<T>(conn: &Connection, sql: &str, params: impl rusqlite::Params, map: MapRow<T>) -> Result<Option<T>> {
    Ok(conn.query_row(sql, params, map).optional()?)
}

/// The file's directory, if the path has an explicit one (`only.db` does not).
fn parent_dir(path: &Path) -> Option<&Path> {
    path.parent().filter(|d| !d.as_os_str().is_empty())
}

/// No URI interpretation of the path, and no following symlinks in the last component.
const OPEN_FLAGS: OpenFlags = OpenFlags::SQLITE_OPEN_READ_WRITE
    .union(OpenFlags::SQLITE_OPEN_CREATE)
    .union(OpenFlags::SQLITE_OPEN_NO_MUTEX)
    .union(OpenFlags::SQLITE_OPEN_NOFOLLOW);

/// 0700 directory and 0600 file (see `fsutil`). Returns the path with the directory canonicalised, so SQLite opens
/// exactly the file that was validated.
fn prepare_files(path: &Path) -> Result<PathBuf> {
    let dir = match parent_dir(path) {
        Some(dir) => {
            crate::fsutil::ensure_private_dir(dir)?;
            dir
        }
        None => Path::new("."),
    };
    let file_name = path.file_name().ok_or(StoreError::Io)?;
    let full = dir.canonicalize()?.join(file_name);
    crate::fsutil::ensure_private_file(&full)?;
    Ok(full)
}

/// Raw key via `sqlite3_key` in the `x'<hex>'` form, as the first operation on the connection. The text lives in a
/// `Zeroizing<Vec<u8>>` and never goes through SQL statement text.
fn apply_key(conn: &Connection, key: &[u8; 32]) -> Result<()> {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut text = Zeroizing::new(Vec::with_capacity(67));
    text.extend_from_slice(b"x'");
    for byte in key {
        text.push(HEX[usize::from(byte >> 4)]);
        text.push(HEX[usize::from(byte & 0x0f)]);
    }
    text.push(b'\'');
    let len = i32::try_from(text.len()).map_err(|_| StoreError::OutOfRange)?;
    // SAFETY: `conn.handle()` is valid while `conn` lives; `text` lives until the end of the function and `len` is
    // its exact length. `sqlite3_key` copies what it needs and does not keep the pointer.
    let rc = unsafe { rusqlite::ffi::sqlite3_key(conn.handle(), text.as_ptr().cast(), len) };
    if rc == rusqlite::ffi::SQLITE_OK {
        Ok(())
    } else {
        Err(StoreError::Db)
    }
}

/// Fails if SQLCipher is not compiled in or the key did not take effect: never continue in plaintext. Requires
/// non-empty `cipher_version` and `cipher_provider` and `cipher_status` = "1" (returned as TEXT).
fn ensure_cipher(conn: &Connection) -> Result<()> {
    let ask = |pragma: &str| conn.query_row(pragma, [], |r| r.get::<_, String>(0)).ok();
    let (version, provider, status) = (
        ask("PRAGMA cipher_version"),
        ask("PRAGMA cipher_provider"),
        ask("PRAGMA cipher_status"),
    );
    check_cipher(version.as_deref(), provider.as_deref(), status.as_deref())
}

fn check_cipher(version: Option<&str>, provider: Option<&str>, status: Option<&str>) -> Result<()> {
    match (version, provider, status) {
        (Some(v), Some(p), Some("1")) if !v.is_empty() && !p.is_empty() => Ok(()),
        _ => Err(StoreError::CipherUnavailable),
    }
}

/// Reading the catalogue fails with a wrong key (or a file that is not a database). Only that specific error
/// (`NOTADB`) is `WrongKey`; anything else is a database failure.
fn verify_key(conn: &Connection) -> Result<()> {
    match conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0)) {
        Ok(_) => Ok(()),
        Err(e) if schema::is_not_a_database(&e) => Err(StoreError::WrongKey),
        Err(_) => Err(StoreError::Db),
    }
}

/// `foreign_keys`, `secure_delete`, `synchronous=FULL` and WAL (the result is read back: not in WAL is an error).
fn configure(conn: &Connection) -> Result<()> {
    conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA synchronous=FULL;")?;
    let mode: String = conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))?;
    if mode.eq_ignore_ascii_case("wal") {
        Ok(())
    } else {
        Err(StoreError::Db)
    }
}

/// Writes the scope on creation; on an existing database it must match. All in one transaction and before migrating
/// (hence it creates `meta` if missing; migration v1 also declares it with `IF NOT EXISTS`).
fn bind_scope(conn: &Connection, scope: &StoreScope) -> Result<()> {
    conn.execute_batch("BEGIN IMMEDIATE;")?;
    match bind_scope_in_transaction(conn, scope) {
        Ok(()) => Ok(conn.execute_batch("COMMIT;")?),
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK;");
            Err(e)
        }
    }
}

fn bind_scope_in_transaction(conn: &Connection, scope: &StoreScope) -> Result<()> {
    conn.execute_batch(schema::META_DDL)?;
    let sql = "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO NOTHING";
    conn.execute(sql, rusqlite::params![SCOPE_NETWORK_KEY, scope.network.as_bytes()])?;
    conn.execute(sql, rusqlite::params![SCOPE_CONTRACT_KEY, scope.contract.as_bytes()])?;
    let stored = |key: &str| -> Result<Vec<u8>> {
        Ok(conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))?)
    };
    let same = stored(SCOPE_NETWORK_KEY)? == scope.network.as_bytes()
        && stored(SCOPE_CONTRACT_KEY)? == scope.contract.as_bytes();
    if same { Ok(()) } else { Err(StoreError::ScopeMismatch) }
}

#[cfg(test)]
mod tests;
