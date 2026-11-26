//! Messages sent from this device («Enviados»). They are stored only here, inside the encrypted database like the
//! received ones: never on the server or the chain, so a restore with the 24 words does not bring them back.
//!
//! The types carry personal data: their `Debug` hides it and they are not `Serialize` (the UI gets its own DTO from
//! the command layer). The body is returned in a `Zeroizing` buffer, wiped on drop.
//!
//! Like received mail, messages of an abandoned address are hidden (not deleted): never listed, counted, opened,
//! changed or deleted. Deleting one is a real `DELETE` (`secure_delete` overwrites the freed pages).

use rusqlite::{Row, params};
use zeroize::Zeroizing;

use super::{Bytes32, LocalStore, Result, SendFailure, SentStatus, StoreError};

/// Bytes of a Message-ID.
pub const SENT_MESSAGE_ID_LENGTH: usize = 16;
/// Longest sender or recipient address, in bytes (mirrors the e2e mail format, one length byte).
pub const MAX_SENT_ADDRESS_LENGTH: usize = 255;
/// Longest subject, in bytes (mirrors `mail/e2e.rs`).
pub const MAX_SENT_SUBJECT_LENGTH: usize = 1024;
/// Longest body, in bytes: the 25 MiB a whole mail may take.
pub const MAX_SENT_BODY_LENGTH: usize = 25 * 1024 * 1024;
/// Latest `sent_at` (the e2e date range, which the TypeScript side can represent).
pub const MAX_SENT_AT: i64 = (1 << 53) - 1;

/// Delivery state of a sent message. `Queued` is saved but not yet confirmed by the server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SentState {
    Queued,
    Sent,
    Failed(SendFailure),
}

impl SentState {
    fn status(self) -> SentStatus {
        match self {
            Self::Queued => SentStatus::Queued,
            Self::Sent => SentStatus::Sent,
            Self::Failed(_) => SentStatus::Failed,
        }
    }

    fn failure(self) -> Option<SendFailure> {
        match self {
            Self::Failed(reason) => Some(reason),
            _ => None,
        }
    }

    /// `queued → sent | failed`, `failed → queued` (retry) and `failed → failed` (another reason). Staying in the same
    /// state is harmless. `sent` has no way out.
    pub fn can_become(self, to: SentState) -> bool {
        use SentState::*;
        self == to || matches!((self, to), (Queued, Sent | Failed(_)) | (Failed(_), Queued | Failed(_)))
    }
}

/// A message to save, before delivery (it starts `Queued`).
#[derive(Clone, PartialEq, Eq)]
pub struct NewSentMessage {
    pub message_id: [u8; SENT_MESSAGE_ID_LENGTH],
    /// Our sending address; it must exist and not be abandoned.
    pub addr_key: Bytes32,
    /// Sender address as text, as written in the mail.
    pub from_addr: String,
    /// Recipient address as text.
    pub to_addr: String,
    pub subject: String,
    pub body: Zeroizing<String>,
    /// Unix seconds UTC: the date written in the mail, the sending address's server time when it was first sent
    /// (never the local clock, README §4.3). A retry sends the same date again.
    pub sent_at: i64,
}

opaque_debug!(NewSentMessage { sent_at });

/// Result of [`LocalStore::insert_sent`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SentInsert {
    New(i64),
    /// The same message (same Message-ID and content) was already stored.
    Existing(i64),
}

impl SentInsert {
    pub fn id(self) -> i64 {
        match self {
            Self::New(id) | Self::Existing(id) => id,
        }
    }
}

/// A sent message without its body.
#[derive(Clone, PartialEq, Eq)]
pub struct SentSummary {
    pub id: i64,
    pub message_id: [u8; SENT_MESSAGE_ID_LENGTH],
    pub addr_key: Bytes32,
    pub from_addr: String,
    pub to_addr: String,
    pub subject: String,
    pub sent_at: i64,
    pub state: SentState,
}

opaque_debug!(SentSummary { id, sent_at, state });

#[derive(Clone, PartialEq, Eq)]
pub struct SentMessage {
    pub summary: SentSummary,
    pub body: Zeroizing<String>,
}

opaque_debug!(SentMessage { summary });

#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub struct SentFilter {
    /// Only the messages sent from this address.
    pub addr_key: Option<Bytes32>,
    pub limit: Option<u32>,
    pub offset: u32,
}

opaque_debug!(SentFilter { limit, offset });

const VISIBLE: &str = visible!();

const SUMMARY_COLUMNS: &str = "id, message_id, addr_key, from_addr, to_addr, subject, sent_at, status, failure";

fn map_summary(row: &Row<'_>) -> rusqlite::Result<SentSummary> {
    let state = match (row.get::<_, SentStatus>(7)?, row.get::<_, Option<SendFailure>>(8)?) {
        (SentStatus::Queued, None) => SentState::Queued,
        (SentStatus::Sent, None) => SentState::Sent,
        (SentStatus::Failed, Some(reason)) => SentState::Failed(reason),
        _ => return Err(rusqlite::Error::InvalidColumnType(8, "failure".into(), rusqlite::types::Type::Text)),
    };
    Ok(SentSummary {
        id: row.get(0)?,
        message_id: row.get(1)?,
        addr_key: row.get(2)?,
        from_addr: row.get(3)?,
        to_addr: row.get(4)?,
        subject: row.get(5)?,
        sent_at: row.get(6)?,
        state,
    })
}

fn map_message(row: &Row<'_>) -> rusqlite::Result<SentMessage> {
    Ok(SentMessage {
        summary: map_summary(row)?,
        // The `String` moves into the buffer without another copy.
        body: Zeroizing::new(row.get(9)?),
    })
}

/// Limits of the e2e mail format; outside them, `OutOfRange` and nothing is written.
fn check_limits(m: &NewSentMessage) -> Result<()> {
    let address_ok = |a: &str| (1..=MAX_SENT_ADDRESS_LENGTH).contains(&a.len());
    let ok = address_ok(&m.from_addr)
        && address_ok(&m.to_addr)
        && m.subject.len() <= MAX_SENT_SUBJECT_LENGTH
        && m.body.len() <= MAX_SENT_BODY_LENGTH
        && (0..=MAX_SENT_AT).contains(&m.sent_at);
    if ok { Ok(()) } else { Err(StoreError::OutOfRange) }
}

impl LocalStore {
    /// Saves a message as `Queued`. Idempotent on the Message-ID: the same message again returns `Existing` with its
    /// id (whatever its state now); the same Message-ID with other content is `Conflict`. Limits: `OutOfRange`. The
    /// sending address must exist and not be abandoned: `NotFound` otherwise.
    pub fn insert_sent(&self, m: &NewSentMessage) -> Result<SentInsert> {
        check_limits(m)?;
        self.write(|tx| {
            let sender = "SELECT 1 FROM addresses WHERE addr_key = ?1 AND abandoned_at IS NULL";
            if super::first(tx, sender, [m.addr_key], |r| r.get::<_, i64>(0))?.is_none() {
                return Err(StoreError::NotFound);
            }
            let rows = tx.execute(
                "INSERT INTO sent_messages (message_id, addr_key, from_addr, to_addr, subject, body, sent_at, status)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,'queued') ON CONFLICT(message_id) DO NOTHING",
                params![m.message_id, m.addr_key, m.from_addr, m.to_addr, m.subject, m.body.as_str(), m.sent_at],
            )?;
            if rows == 1 {
                return Ok(SentInsert::New(tx.last_insert_rowid()));
            }
            // Compared in SQL, so the stored body is never copied out.
            let same = "SELECT id FROM sent_messages WHERE message_id = ?1 AND addr_key = ?2 AND from_addr = ?3
                        AND to_addr = ?4 AND subject = ?5 AND body = ?6 AND sent_at = ?7";
            let args =
                params![m.message_id, m.addr_key, m.from_addr, m.to_addr, m.subject, m.body.as_str(), m.sent_at];
            match super::first(tx, same, args, |r| r.get(0))? {
                Some(id) => Ok(SentInsert::Existing(id)),
                None => Err(StoreError::Conflict),
            }
        })
    }

    /// Summaries without the body, newest first (`sent_at`, then `id`), paginated, optionally only those sent from one
    /// address. Those of abandoned addresses never appear.
    pub fn list_sent(&self, filter: &SentFilter) -> Result<Vec<SentSummary>> {
        let sql = format!(
            "SELECT {SUMMARY_COLUMNS} FROM sent_messages WHERE (?1 IS NULL OR addr_key = ?1) AND {VISIBLE}
             ORDER BY sent_at DESC, id DESC LIMIT ?2 OFFSET ?3"
        );
        let limit = filter.limit.map_or(-1, i64::from);
        self.query_all(&sql, params![filter.addr_key, limit, filter.offset], map_summary)
    }

    /// How many are listed with that filter (ignoring `limit` and `offset`).
    pub fn count_sent(&self, addr_key: Option<&Bytes32>) -> Result<u64> {
        let sql = format!("SELECT count(*) FROM sent_messages WHERE (?1 IS NULL OR addr_key = ?1) AND {VISIBLE}");
        let count: Option<i64> = self.query_opt(&sql, [addr_key], |r| r.get(0))?;
        u64::try_from(count.unwrap_or(0)).map_err(|_| StoreError::Db)
    }

    /// A full message with its body. One of an abandoned address does not exist.
    pub fn get_sent(&self, id: i64) -> Result<Option<SentMessage>> {
        let sql = format!("SELECT {SUMMARY_COLUMNS}, body FROM sent_messages WHERE id = ?1 AND {VISIBLE}");
        self.query_opt(&sql, [id], map_message)
    }

    /// The id of the message with that Message-ID, if it is visible.
    pub fn find_sent(&self, message_id: &[u8; SENT_MESSAGE_ID_LENGTH]) -> Result<Option<i64>> {
        let sql = format!("SELECT id FROM sent_messages WHERE message_id = ?1 AND {VISIBLE}");
        self.query_opt(&sql, [message_id], |r| r.get(0))
    }

    /// Changes the delivery state ([`SentState::can_become`]); otherwise `InvalidTransition` and nothing changes.
    /// Missing or hidden: `NotFound`.
    pub fn set_sent_state(&self, id: i64, to: SentState) -> Result<()> {
        self.write(|tx| {
            let sql = format!("SELECT {SUMMARY_COLUMNS} FROM sent_messages WHERE id = ?1 AND {VISIBLE}");
            let current = super::first(tx, &sql, [id], map_summary)?.ok_or(StoreError::NotFound)?;
            if !current.state.can_become(to) {
                return Err(StoreError::InvalidTransition);
            }
            tx.execute(
                "UPDATE sent_messages SET status = ?2, failure = ?3 WHERE id = ?1",
                params![id, to.status(), to.failure()],
            )?;
            Ok(())
        })
    }

    /// Deletes the message from this device for good. Missing or hidden: `NotFound`.
    pub fn delete_sent(&self, id: i64) -> Result<()> {
        self.run_found(&format!("DELETE FROM sent_messages WHERE id = ?1 AND {VISIBLE}"), [id])
    }
}
