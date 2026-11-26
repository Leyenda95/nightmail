//! Received end-to-end mail (`nightmail:e2e`, `mail::inbox`): storing it with its sender check, deduplicating it,
//! and keeping aside the mail whose sender cannot be looked up yet (migration v4).
//!
//! Deduplication, per address of ours, by the sender's `addrKey` and the mail's `messageId`:
//! - only a **verified** mail stops another copy: a later copy of it, verified or not, is dropped, so the server
//!   cannot show the same mail twice and a deleted one (the `deleted` mark keeps the row) does not come back;
//! - an **unverified** mail stops nothing: anyone can write one claiming any sender and id. When the verified mail
//!   arrives, the unverified copies with that sender and id are removed (a real `DELETE`; `secure_delete` overwrites
//!   them) and it takes their place, whatever was done with them (read, deleted…). Unverified copies are all kept
//!   until then.
//!
//! An envelope that ends up as no message (dropped, or replaced) is remembered in `e2e_dropped`, and one waiting in
//! `e2e_pending` counts as known too ([`LocalStore::known_server_ids`]), so sync never downloads either again. If
//! messages are ever really purged, the verified ones must leave a tombstone, or a new delivery would bring them back.

use rusqlite::{OptionalExtension, Transaction, params};
use zeroize::Zeroizing;

use super::{Bytes32, LocalStore, NewMessage, Result, StoreError};
use crate::mail::e2e::{MAX_DATE, MAX_MAIL_LENGTH, MESSAGE_ID_LENGTH};

/// What identifies a received e2e mail, besides its MIME.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct E2eMeta {
    pub sender_addr_key: Bytes32,
    pub sender_message_id: [u8; MESSAGE_ID_LENGTH],
    /// As the sender wrote it (Unix seconds, unverified): never shown as the arrival time.
    pub sender_date: u64,
    pub sender_verified: bool,
}

opaque_debug!(E2eMeta { sender_verified });

/// What [`LocalStore::insert_e2e_message`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum E2eInsert {
    /// Stored with this id, after removing `replaced` unverified copies.
    Stored { id: i64, replaced: usize },
    /// A verified copy is already stored: dropped.
    Duplicate,
    /// This envelope was already stored or dropped: nothing changed.
    Known,
}

/// A mail waiting for its sender to be looked up. Its plaintext is wiped from memory when dropped.
pub struct PendingE2e {
    pub addr_key: Bytes32,
    pub server_id: String,
    /// Unix seconds UTC, from the server's list.
    pub received_at: i64,
    pub size_bucket: u32,
    pub plaintext: Zeroizing<Vec<u8>>,
}

opaque_debug!(PendingE2e { received_at, size_bucket });

/// A pending mail due for another try: its id and how many tries it already had.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DueE2e {
    pub server_id: String,
    pub attempts: u32,
}

fn exists(tx: &Transaction<'_>, sql: &str, args: impl rusqlite::Params) -> Result<bool> {
    Ok(tx.query_row(sql, args, |_| Ok(())).optional()?.is_some())
}

fn drop_envelope(tx: &Transaction<'_>, addr_key: &Bytes32, server_id: &str) -> Result<()> {
    tx.execute(
        "INSERT INTO e2e_dropped (addr_key, server_id) VALUES (?1, ?2) ON CONFLICT DO NOTHING",
        params![addr_key, server_id],
    )?;
    Ok(())
}

impl LocalStore {
    /// Stores a received e2e mail (`m.raw` is its synthesised MIME) following the deduplication rules of this module,
    /// in one transaction that also forgets its pending copy and its failed attempts. The address must exist.
    pub fn insert_e2e_message(&self, m: &NewMessage, e2e: &E2eMeta) -> Result<E2eInsert> {
        let sender_date = i64::try_from(e2e.sender_date).ok().filter(|&d| d <= MAX_DATE as i64);
        let sender_date = sender_date.ok_or(StoreError::OutOfRange)?;
        let key = (m.addr_key, e2e.sender_addr_key, e2e.sender_message_id);
        self.write(|tx| {
            let id = (&m.addr_key, &m.server_id);
            tx.execute("DELETE FROM e2e_pending WHERE addr_key = ?1 AND server_id = ?2", params![id.0, id.1])?;
            tx.execute("DELETE FROM skipped_messages WHERE addr_key = ?1 AND server_id = ?2", params![id.0, id.1])?;
            let known = "SELECT 1 FROM messages WHERE addr_key = ?1 AND server_id = ?2
                         UNION ALL SELECT 1 FROM e2e_dropped WHERE addr_key = ?1 AND server_id = ?2";
            if exists(tx, known, params![id.0, id.1])? {
                return Ok(E2eInsert::Known);
            }
            let verified = "SELECT 1 FROM messages WHERE addr_key = ?1 AND sender_addr_key = ?2
                            AND sender_message_id = ?3 AND sender_verified = 1";
            if exists(tx, verified, params![key.0, key.1, key.2])? {
                drop_envelope(tx, &m.addr_key, &m.server_id)?;
                return Ok(E2eInsert::Duplicate);
            }
            let mut replaced = 0;
            if e2e.sender_verified {
                let copies: Vec<(i64, String)> = {
                    let mut select = tx.prepare(
                        "SELECT id, server_id FROM messages WHERE addr_key = ?1 AND sender_addr_key = ?2
                         AND sender_message_id = ?3 AND e2e = 1 AND sender_verified = 0",
                    )?;
                    let rows = select.query_map(params![key.0, key.1, key.2], |r| Ok((r.get(0)?, r.get(1)?)))?;
                    rows.collect::<rusqlite::Result<_>>()?
                };
                for (copy, server_id) in &copies {
                    drop_envelope(tx, &m.addr_key, server_id)?;
                    tx.execute("DELETE FROM messages WHERE id = ?1", [copy])?;
                }
                replaced = copies.len();
            }
            tx.execute(
                "INSERT INTO messages (addr_key, server_id, received_at, size_bucket, raw, from_addr, subject, sent_at,
                   preview, e2e, sender_verified, sender_addr_key, sender_message_id, sender_date)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10, ?11, ?12, ?13)",
                params![
                    m.addr_key,
                    m.server_id,
                    m.received_at,
                    m.size_bucket,
                    m.raw,
                    m.parsed.from_addr,
                    m.parsed.subject,
                    m.parsed.sent_at,
                    m.parsed.preview,
                    e2e.sender_verified,
                    e2e.sender_addr_key,
                    e2e.sender_message_id,
                    sender_date
                ],
            )?;
            Ok(E2eInsert::Stored { id: tx.last_insert_rowid(), replaced })
        })
    }

    /// Keeps a mail aside until its sender can be looked up, with its first try counted and the next one due at
    /// `next_at` (Unix seconds). Already pending: nothing changes. The address must exist.
    pub fn add_e2e_pending(&self, p: &PendingE2e, next_at: i64) -> Result<()> {
        if p.plaintext.len() > MAX_MAIL_LENGTH {
            return Err(StoreError::OutOfRange);
        }
        self.write(|tx| {
            tx.execute(
                "INSERT INTO e2e_pending (addr_key, server_id, received_at, size_bucket, plaintext, attempts, next_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6) ON CONFLICT(addr_key, server_id) DO NOTHING",
                params![p.addr_key, p.server_id, p.received_at, p.size_bucket, &p.plaintext[..], next_at],
            )?;
            // It is no longer a failed download.
            tx.execute(
                "DELETE FROM skipped_messages WHERE addr_key = ?1 AND server_id = ?2",
                params![p.addr_key, p.server_id],
            )?;
            Ok(())
        })
    }

    /// The pending mail of `addr_key` due at `now` with fewer than `max_attempts` tries, oldest first.
    pub fn due_e2e_pending(&self, addr_key: &Bytes32, now: i64, max_attempts: u32) -> Result<Vec<DueE2e>> {
        let sql = "SELECT server_id, attempts FROM e2e_pending WHERE addr_key = ?1 AND next_at <= ?2 AND attempts < ?3
                   ORDER BY received_at, server_id";
        self.query_all(sql, params![addr_key, now, max_attempts], |r| {
            Ok(DueE2e { server_id: r.get(0)?, attempts: r.get(1)? })
        })
    }

    /// One pending mail, with its plaintext.
    pub fn get_e2e_pending(&self, addr_key: &Bytes32, server_id: &str) -> Result<Option<PendingE2e>> {
        let sql = "SELECT received_at, size_bucket, plaintext FROM e2e_pending WHERE addr_key = ?1 AND server_id = ?2";
        let row = self.conn().query_row(sql, params![addr_key, server_id], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, u32>(1)?, Zeroizing::new(r.get::<_, Vec<u8>>(2)?)))
        });
        Ok(row.optional()?.map(|(received_at, size_bucket, plaintext)| PendingE2e {
            addr_key: *addr_key,
            server_id: server_id.to_owned(),
            received_at,
            size_bucket,
            plaintext,
        }))
    }

    /// Records another failed try of a pending mail: `attempts` in total, the next one due at `next_at`.
    pub fn retry_e2e_pending(&self, addr_key: &Bytes32, server_id: &str, attempts: u32, next_at: i64) -> Result<()> {
        self.run_found(
            "UPDATE e2e_pending SET attempts = ?3, next_at = ?4 WHERE addr_key = ?1 AND server_id = ?2",
            params![addr_key, server_id, attempts, next_at],
        )
    }

    /// Gives the pending mail of `addr_key` its tries back, due now: once per app session, so mail that ran out of
    /// tries in an earlier one is looked at again.
    pub fn rearm_e2e_pending(&self, addr_key: &Bytes32) -> Result<()> {
        self.exec("UPDATE e2e_pending SET attempts = 0, next_at = 0 WHERE addr_key = ?1", [addr_key])
    }

    /// Takes a pending mail out without storing it (its plaintext is no mail after all): it is remembered as dropped
    /// so it is not downloaded again.
    pub fn drop_e2e_pending(&self, addr_key: &Bytes32, server_id: &str) -> Result<()> {
        self.write(|tx| {
            tx.execute("DELETE FROM e2e_pending WHERE addr_key = ?1 AND server_id = ?2", params![addr_key, server_id])?;
            drop_envelope(tx, addr_key, server_id)
        })
    }
}

#[cfg(test)]
mod tests;
