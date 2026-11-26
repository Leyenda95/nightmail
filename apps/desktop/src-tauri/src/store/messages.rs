//! Downloaded messages. `raw` is the decrypted MIME (the whole database is encrypted). The types here carry
//! personal data: their `Debug` hides it and they are not `Serialize` (the UI gets its own DTO from the command
//! layer).
//!
//! "Delete" is a mark (`deleted`), not a real deletion; purging is not implemented.

use std::collections::HashSet;

use rusqlite::{Row, params};

use super::{Bytes32, LocalStore, Result, SkipReason, StoreError, first};

/// Fields filled in by the MIME parser (another module). All optional.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct ParsedFields {
    pub from_addr: Option<String>,
    pub subject: Option<String>,
    /// Unix seconds UTC.
    pub sent_at: Option<i64>,
    pub preview: Option<String>,
}

opaque_debug!(ParsedFields {});

#[derive(Clone, PartialEq, Eq)]
pub struct NewMessage {
    pub addr_key: Bytes32,
    pub server_id: String,
    /// Unix seconds UTC.
    pub received_at: i64,
    pub size_bucket: u32,
    pub raw: Vec<u8>,
    pub parsed: ParsedFields,
}

opaque_debug!(NewMessage {
    size_bucket,
    received_at
});

#[derive(Clone, PartialEq, Eq)]
pub struct MessageSummary {
    pub id: i64,
    pub addr_key: Bytes32,
    pub server_id: String,
    pub received_at: i64,
    pub size_bucket: u32,
    pub parsed: ParsedFields,
    pub is_read: bool,
    pub starred: bool,
    pub archived: bool,
    pub deleted: bool,
    /// End-to-end mail from another NightMail address (`mail::inbox`); `raw` is the MIME synthesised on arrival.
    pub e2e: bool,
    /// Only with `e2e`: signed by the key the registry has for the sender address, and for this address.
    pub sender_verified: bool,
}

opaque_debug!(MessageSummary {
    id,
    received_at,
    is_read,
    starred,
    archived,
    deleted,
    e2e,
    sender_verified
});

#[derive(Clone, PartialEq, Eq)]
pub struct Message {
    pub summary: MessageSummary,
    pub raw: Vec<u8>,
}

opaque_debug!(Message { summary });

/// Flag changes; `None` leaves a flag as it was.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MessageFlags {
    pub is_read: Option<bool>,
    pub starred: Option<bool>,
    pub archived: Option<bool>,
    pub deleted: Option<bool>,
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub struct MessageFilter {
    pub addr_key: Option<Bytes32>,
    pub include_deleted: bool,
    /// `Some(true)` archived only, `Some(false)` non-archived only, `None` both.
    pub archived: Option<bool>,
    pub limit: Option<u32>,
    pub offset: u32,
}

opaque_debug!(MessageFilter {
    include_deleted,
    archived,
    limit,
    offset
});

/// Ids per query chunk (SQLite variable limit).
const ID_CHUNK: usize = 500;

/// The message does not belong to an abandoned address. Those messages are hidden (not deleted) from the app: never
/// listed, opened or re-flagged. Sync still sees them ([`LocalStore::known_server_ids`]) so it does not download
/// them again.
const VISIBLE: &str = visible!();

/// Changes only the given flags (`NULL` keeps the current one). `?1` is the id. Hidden messages are left untouched
/// ([`VISIBLE`]).
const SET_FLAGS: &str = concat!(
    "UPDATE messages SET is_read = COALESCE(?2, is_read), starred = COALESCE(?3, starred),
     archived = COALESCE(?4, archived), deleted = COALESCE(?5, deleted) WHERE id = ?1 AND ",
    visible!()
);

const SUMMARY_COLUMNS: &str = "id, addr_key, server_id, received_at, size_bucket, from_addr, subject, sent_at, \
                               preview, is_read, starred, archived, deleted, e2e, sender_verified";

fn map_summary(row: &Row<'_>) -> rusqlite::Result<MessageSummary> {
    Ok(MessageSummary {
        id: row.get(0)?,
        addr_key: row.get(1)?,
        server_id: row.get(2)?,
        received_at: row.get(3)?,
        size_bucket: row.get(4)?,
        parsed: ParsedFields {
            from_addr: row.get(5)?,
            subject: row.get(6)?,
            sent_at: row.get(7)?,
            preview: row.get(8)?,
        },
        is_read: row.get(9)?,
        starred: row.get(10)?,
        archived: row.get(11)?,
        deleted: row.get(12)?,
        e2e: row.get(13)?,
        sender_verified: row.get(14)?,
    })
}

fn map_message(row: &Row<'_>) -> rusqlite::Result<Message> {
    Ok(Message {
        summary: map_summary(row)?,
        raw: row.get(15)?,
    })
}

impl LocalStore {
    /// Inserts a message. Idempotent on `(addr_key, server_id)`: returns the new id, or `None` if already present.
    /// The address must exist (foreign key).
    pub fn insert_message(&self, m: &NewMessage) -> Result<Option<i64>> {
        let conn = self.conn();
        let rows = conn.execute(
            "INSERT INTO messages (addr_key, server_id, received_at, size_bucket, raw, from_addr, subject, sent_at, preview)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(addr_key, server_id) DO NOTHING",
            params![
                m.addr_key,
                m.server_id,
                m.received_at,
                m.size_bucket,
                m.raw,
                m.parsed.from_addr,
                m.parsed.subject,
                m.parsed.sent_at,
                m.parsed.preview
            ],
        )?;
        Ok((rows == 1).then(|| conn.last_insert_rowid()))
    }

    /// Summaries without `raw`, newest first (`received_at`, then `id`), paginated. Messages of abandoned addresses
    /// never appear, even when filtering by that address: they are hidden, not deleted.
    pub fn list_messages(&self, filter: &MessageFilter) -> Result<Vec<MessageSummary>> {
        let sql = format!(
            "SELECT {SUMMARY_COLUMNS} FROM messages
             WHERE (?1 IS NULL OR addr_key = ?1) AND (?2 OR deleted = 0) AND (?3 IS NULL OR archived = ?3)
               AND {VISIBLE}
             ORDER BY received_at DESC, id DESC LIMIT ?4 OFFSET ?5"
        );
        let limit = filter.limit.map_or(-1, i64::from);
        let args = params![
            filter.addr_key,
            filter.include_deleted,
            filter.archived,
            limit,
            filter.offset
        ];
        self.query_all(&sql, args, map_summary)
    }

    /// A full message with its MIME. One belonging to an abandoned address does not exist ([`VISIBLE`]).
    pub fn get_message(&self, id: i64) -> Result<Option<Message>> {
        let sql = format!("SELECT {SUMMARY_COLUMNS}, raw FROM messages WHERE id = ?1 AND {VISIBLE}");
        self.query_opt(&sql, [id], map_message)
    }

    /// Changes the given flags. Missing message or one of an abandoned address: `NotFound`.
    pub fn set_flags(&self, id: i64, f: &MessageFlags) -> Result<()> {
        self.run_found(SET_FLAGS, params![id, f.is_read, f.starred, f.archived, f.deleted])
    }

    /// Applies the same flags to several messages in one transaction, all or none. If any is missing (or belongs to
    /// an abandoned address), `NotFound` and nothing changes. Repeated ids are fine.
    pub fn set_flags_many(&self, ids: &[i64], f: &MessageFlags) -> Result<()> {
        self.write(|tx| {
            let mut update = tx.prepare_cached(SET_FLAGS)?;
            for id in ids {
                if update.execute(params![id, f.is_read, f.starred, f.archived, f.deleted])? == 0 {
                    return Err(StoreError::NotFound);
                }
            }
            Ok(())
        })
    }

    /// Fills in the parsed fields of a stored message.
    pub fn set_parsed(&self, id: i64, p: &ParsedFields) -> Result<()> {
        self.run_found(
            "UPDATE messages SET from_addr = ?2, subject = ?3, sent_at = ?4, preview = ?5 WHERE id = ?1",
            params![id, p.from_addr, p.subject, p.sent_at, p.preview],
        )
    }

    /// Of `ids`, those already stored for that address (uses the UNIQUE index `(addr_key, server_id)`). Includes
    /// hidden ones of an abandoned address so they are not downloaded again, and end-to-end mail kept aside: waiting
    /// for its sender to be looked up, or dropped as a duplicate (`store::inbox`).
    pub fn known_server_ids(&self, addr_key: &Bytes32, ids: &[String]) -> Result<HashSet<String>> {
        let mut known = HashSet::new();
        for chunk in ids.chunks(ID_CHUNK) {
            // Numbered, so the three lookups share the same parameters.
            let marks: Vec<String> = (2..chunk.len() + 2).map(|n| format!("?{n}")).collect();
            let marks = marks.join(",");
            let sql = format!(
                "SELECT server_id FROM messages WHERE addr_key = ?1 AND server_id IN ({marks})
                 UNION SELECT server_id FROM e2e_pending WHERE addr_key = ?1 AND server_id IN ({marks})
                 UNION SELECT server_id FROM e2e_dropped WHERE addr_key = ?1 AND server_id IN ({marks})"
            );
            let mut args: Vec<&dyn rusqlite::ToSql> = vec![addr_key];
            args.extend(chunk.iter().map(|id| id as &dyn rusqlite::ToSql));
            known.extend(self.query_all(&sql, args.as_slice(), |r| r.get::<_, String>(0))?);
        }
        Ok(known)
    }

    /// Counts a failed attempt on a server message and returns the total (never resets on its own). The address must
    /// exist.
    pub fn bump_message_attempt(&self, addr_key: &Bytes32, server_id: &str, now: i64) -> Result<u32> {
        let sql = "INSERT INTO skipped_messages (addr_key, server_id, attempts, last_at) VALUES (?1, ?2, 1, ?3)
                   ON CONFLICT(addr_key, server_id) DO UPDATE SET attempts = attempts + 1, last_at = ?3
                   RETURNING attempts";
        let attempts = first(&self.conn(), sql, params![addr_key, server_id, now], |r| r.get(0))?;
        Ok(attempts.unwrap_or(0))
    }

    /// Marks the message as skipped (it is not requested again). Keeps the attempt count.
    pub fn mark_skipped(&self, addr_key: &Bytes32, server_id: &str, reason: SkipReason, now: i64) -> Result<()> {
        self.exec(
            "INSERT INTO skipped_messages (addr_key, server_id, reason, last_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(addr_key, server_id) DO UPDATE SET reason = excluded.reason, last_at = excluded.last_at",
            params![addr_key, server_id, reason, now],
        )
    }

    /// Why the message is skipped, if it is.
    pub fn skip_reason(&self, addr_key: &Bytes32, server_id: &str) -> Result<Option<SkipReason>> {
        let sql = "SELECT reason FROM skipped_messages WHERE addr_key = ?1 AND server_id = ?2";
        Ok(self
            .query_opt(sql, params![addr_key, server_id], |r| r.get(0))?
            .flatten())
    }

    pub fn is_skipped(&self, addr_key: &Bytes32, server_id: &str) -> Result<bool> {
        Ok(self.skip_reason(addr_key, server_id)?.is_some())
    }

    /// Forgets the message (attempts and reason), e.g. to retry it by hand. `false` if it was not recorded.
    pub fn forget_skipped(&self, addr_key: &Bytes32, server_id: &str) -> Result<bool> {
        let sql = "DELETE FROM skipped_messages WHERE addr_key = ?1 AND server_id = ?2";
        Ok(self.run(sql, params![addr_key, server_id])? == 1)
    }
}
