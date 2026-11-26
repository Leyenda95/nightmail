use std::path::PathBuf;

use tempfile::TempDir;
use zeroize::Zeroizing;

use super::*;
use crate::store::{
    Address, MessageFilter, MessageFlags, NewSentMessage, ParsedFields, SkipReason, SlotKind, StoreScope, schema,
};

const KEY: [u8; 32] = [7; 32];

fn scope() -> StoreScope {
    StoreScope { network: "devnet".into(), contract: "c1".into() }
}

fn db_path(dir: &TempDir) -> PathBuf {
    dir.path().join("sub").join("nightmail.db")
}

fn address(b: u8) -> Address {
    Address {
        addr_key: [b; 32],
        kind: SlotKind::Alias,
        n: 0,
        j: u32::from(b),
        display: format!("a{b}@nightmail.local"),
        name: None,
        created_at: 100 + i64::from(b),
    }
}

/// A store with our addresses 1 and 2.
fn fresh() -> (TempDir, LocalStore) {
    let dir = TempDir::new().unwrap();
    let store = LocalStore::open(&db_path(&dir), &KEY, &scope()).unwrap();
    store.insert_address(&address(1)).unwrap();
    store.insert_address(&address(2)).unwrap();
    (dir, store)
}

/// A received message (to our address `addr`) as sync would store it.
fn message(addr: u8, server_id: &str, subject: &str) -> NewMessage {
    NewMessage {
        addr_key: [addr; 32],
        server_id: server_id.into(),
        received_at: 7200,
        size_bucket: 4096,
        raw: format!("Subject: {subject}\r\n\r\ncuerpo").into_bytes(),
        parsed: ParsedFields { subject: Some(subject.into()), ..ParsedFields::default() },
    }
}

/// Mail `id` from sender `sender`.
fn meta(sender: u8, id: u8, verified: bool) -> E2eMeta {
    E2eMeta { sender_addr_key: [sender; 32], sender_message_id: [id; 16], sender_date: 99, sender_verified: verified }
}

fn listed(store: &LocalStore) -> Vec<(String, bool, bool)> {
    let filter = MessageFilter { include_deleted: true, ..MessageFilter::default() };
    let mut all: Vec<_> = store
        .list_messages(&filter)
        .unwrap()
        .into_iter()
        .map(|m| (m.parsed.subject.unwrap_or_default(), m.e2e, m.sender_verified))
        .collect();
    all.sort();
    all
}

fn known(store: &LocalStore, addr: u8, ids: &[&str]) -> Vec<String> {
    let ids: Vec<String> = ids.iter().map(|id| (*id).to_owned()).collect();
    let mut known: Vec<_> = store.known_server_ids(&[addr; 32], &ids).unwrap().into_iter().collect();
    known.sort();
    known
}

fn stored_id(inserted: E2eInsert) -> i64 {
    match inserted {
        E2eInsert::Stored { id, .. } => id,
        other => panic!("not stored: {other:?}"),
    }
}

#[test]
fn a_verified_mail_is_stored_once_and_later_copies_are_dropped() {
    let (_dir, s) = fresh();
    let id = stored_id(s.insert_e2e_message(&message(1, "s1", "real"), &meta(5, 1, true)).unwrap());
    // The server delivers it again, or a copy that does not verify.
    assert_eq!(s.insert_e2e_message(&message(1, "s2", "again"), &meta(5, 1, true)).unwrap(), E2eInsert::Duplicate);
    assert_eq!(s.insert_e2e_message(&message(1, "s3", "fake"), &meta(5, 1, false)).unwrap(), E2eInsert::Duplicate);
    assert_eq!(listed(&s), [("real".into(), true, true)]);
    // Neither is downloaded again.
    assert_eq!(known(&s, 1, &["s1", "s2", "s3", "s4"]), ["s1", "s2", "s3"]);
    // The same envelope a second time changes nothing.
    assert_eq!(s.insert_e2e_message(&message(1, "s1", "real"), &meta(5, 1, true)).unwrap(), E2eInsert::Known);
    assert_eq!(s.insert_e2e_message(&message(1, "s2", "again"), &meta(5, 1, true)).unwrap(), E2eInsert::Known);
    assert_eq!(s.get_message(id).unwrap().unwrap().summary.server_id, "s1");
}

#[test]
fn unverified_copies_never_block_the_verified_mail_which_replaces_them() {
    let (_dir, s) = fresh();
    // Two unverified copies claiming sender 5 and id 1 (anyone can write them): both kept.
    let first = stored_id(s.insert_e2e_message(&message(1, "u1", "fake 1"), &meta(5, 1, false)).unwrap());
    stored_id(s.insert_e2e_message(&message(1, "u2", "fake 2"), &meta(5, 1, false)).unwrap());
    // Unrelated mail: another id, another sender, plain SMTP mail.
    stored_id(s.insert_e2e_message(&message(1, "o1", "other id"), &meta(5, 2, false)).unwrap());
    stored_id(s.insert_e2e_message(&message(1, "o2", "other sender"), &meta(6, 1, false)).unwrap());
    s.insert_message(&message(1, "smtp", "smtp")).unwrap();
    // Whatever was done with a copy (here: deleted) does not stop the verified mail.
    s.set_flags(first, &MessageFlags { deleted: Some(true), is_read: Some(true), ..MessageFlags::default() }).unwrap();
    let inserted = s.insert_e2e_message(&message(1, "v1", "real"), &meta(5, 1, true)).unwrap();
    assert!(matches!(inserted, E2eInsert::Stored { replaced: 2, .. }), "{inserted:?}");
    assert_eq!(
        listed(&s),
        [
            ("other id".into(), true, false),
            ("other sender".into(), true, false),
            ("real".into(), true, true),
            ("smtp".into(), false, false)
        ]
    );
    let real = s.get_message(stored_id(inserted)).unwrap().unwrap().summary;
    assert!(!real.deleted && !real.is_read, "it arrives as new mail");
    // The replaced copies are gone for good and not downloaded again.
    assert!(s.get_message(first).unwrap().is_none());
    assert_eq!(known(&s, 1, &["u1", "u2", "v1", "x"]), ["u1", "u2", "v1"]);
}

#[test]
fn a_deleted_mail_does_not_come_back() {
    let (_dir, s) = fresh();
    let id = stored_id(s.insert_e2e_message(&message(1, "s1", "real"), &meta(5, 1, true)).unwrap());
    s.set_flags(id, &MessageFlags { deleted: Some(true), ..MessageFlags::default() }).unwrap();
    assert_eq!(s.insert_e2e_message(&message(1, "s2", "real"), &meta(5, 1, true)).unwrap(), E2eInsert::Duplicate);
    assert!(s.list_messages(&MessageFilter::default()).unwrap().is_empty());
    assert!(s.get_message(id).unwrap().unwrap().summary.deleted);
}

#[test]
fn each_of_our_addresses_keeps_its_own_copy() {
    let (_dir, s) = fresh();
    stored_id(s.insert_e2e_message(&message(1, "s1", "to one"), &meta(5, 1, true)).unwrap());
    stored_id(s.insert_e2e_message(&message(2, "s1", "to two"), &meta(5, 1, true)).unwrap());
    assert_eq!(listed(&s).len(), 2);
}

#[test]
fn storing_forgets_the_pending_copy_and_failed_attempts() {
    let (_dir, s) = fresh();
    s.bump_message_attempt(&[1; 32], "s1", 5).unwrap();
    s.add_e2e_pending(&pending(1, "s1"), 0).unwrap();
    stored_id(s.insert_e2e_message(&message(1, "s1", "real"), &meta(5, 1, true)).unwrap());
    assert!(s.get_e2e_pending(&[1; 32], "s1").unwrap().is_none());
    assert_eq!(s.skip_reason(&[1; 32], "s1").unwrap(), None);
    assert!(s.due_e2e_pending(&[1; 32], i64::MAX, 10).unwrap().is_empty());
}

#[test]
fn the_sender_date_is_kept_apart_and_bounded() {
    let (_dir, s) = fresh();
    let mut late = meta(5, 1, true);
    late.sender_date = crate::mail::e2e::MAX_DATE + 1;
    assert_eq!(s.insert_e2e_message(&message(1, "s1", "x"), &late), Err(StoreError::OutOfRange));
    late.sender_date = crate::mail::e2e::MAX_DATE;
    let id = stored_id(s.insert_e2e_message(&message(1, "s1", "x"), &late).unwrap());
    let row: (i64, Vec<u8>, Vec<u8>) = s
        .conn()
        .query_row("SELECT sender_date, sender_addr_key, sender_message_id FROM messages WHERE id = ?1", [id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .unwrap();
    assert_eq!(row, (crate::mail::e2e::MAX_DATE as i64, vec![5; 32], vec![1; 16]));
    assert_eq!(s.get_message(id).unwrap().unwrap().summary.received_at, 7200);
}

fn pending(addr: u8, server_id: &str) -> PendingE2e {
    PendingE2e {
        addr_key: [addr; 32],
        server_id: server_id.into(),
        received_at: 3600,
        size_bucket: 4096,
        plaintext: Zeroizing::new(b"nightmail:e2e...".to_vec()),
    }
}

#[test]
fn pending_mail_waits_its_turn_and_counts_as_known() {
    let (_dir, s) = fresh();
    s.mark_skipped(&[1; 32], "p1", SkipReason::Failed, 1).unwrap();
    s.add_e2e_pending(&pending(1, "p1"), 100).unwrap();
    s.add_e2e_pending(&pending(1, "p2"), 200).unwrap();
    // Adding it again changes nothing (first try, its due time).
    s.add_e2e_pending(&pending(1, "p1"), 999).unwrap();
    assert_eq!(s.skip_reason(&[1; 32], "p1").unwrap(), None, "no longer a failed download");
    let due = |now, max| s.due_e2e_pending(&[1; 32], now, max).unwrap();
    assert!(due(99, 10).is_empty());
    assert_eq!(due(100, 10), [DueE2e { server_id: "p1".into(), attempts: 1 }]);
    assert_eq!(due(200, 10).len(), 2);
    assert!(s.due_e2e_pending(&[2; 32], 200, 10).unwrap().is_empty(), "per address");
    assert_eq!(known(&s, 1, &["p1", "p2", "p3"]), ["p1", "p2"]);
    let kept = s.get_e2e_pending(&[1; 32], "p1").unwrap().unwrap();
    assert_eq!((kept.received_at, kept.size_bucket, &kept.plaintext[..]), (3600, 4096, &b"nightmail:e2e..."[..]));
    // Out of tries: not due any more, until the next session gives them back.
    s.retry_e2e_pending(&[1; 32], "p1", 3, 150).unwrap();
    assert_eq!(due(200, 3), [DueE2e { server_id: "p2".into(), attempts: 1 }]);
    s.rearm_e2e_pending(&[1; 32]).unwrap();
    assert_eq!(due(0, 3).len(), 2);
    assert_eq!(s.retry_e2e_pending(&[1; 32], "nope", 1, 1), Err(StoreError::NotFound));
    // Dropped: gone, and still known so it is not downloaded again.
    s.drop_e2e_pending(&[1; 32], "p2").unwrap();
    assert!(s.get_e2e_pending(&[1; 32], "p2").unwrap().is_none());
    assert_eq!(known(&s, 1, &["p1", "p2"]), ["p1", "p2"]);
}

#[test]
fn the_schema_refuses_inconsistent_e2e_rows() {
    let (_dir, s) = fresh();
    let insert = |extra_columns: &str, extra_values: &str| {
        let sql = format!(
            "INSERT INTO messages (addr_key, server_id, received_at, size_bucket, raw{extra_columns})
             VALUES (x'{}', 'x', 1, 1, x''{extra_values})",
            "01".repeat(32)
        );
        s.conn().execute(&sql, []).map(drop).map_err(StoreError::from)
    };
    let sender = format!("x'{}', x'{}', 5", "05".repeat(32), "01".repeat(16));
    // Verified without being e2e; e2e without its sender; sender fields on a plain message; a bad length.
    assert_eq!(insert(", sender_verified", ", 1"), Err(StoreError::Db));
    assert_eq!(insert(", e2e", ", 1"), Err(StoreError::Db));
    let fields = ", sender_addr_key, sender_message_id, sender_date";
    assert_eq!(insert(fields, &format!(", {sender}")), Err(StoreError::Db));
    let columns = ", e2e, sender_verified, sender_addr_key, sender_message_id, sender_date";
    assert_eq!(insert(columns, ", 1, 1, x'05', x'01', 5"), Err(StoreError::Db));
    assert_eq!(insert(columns, &format!(", 1, 1, {sender}")), Ok(()));
    // A second verified row for the same mail breaks the unique index.
    let second = format!(
        "INSERT INTO messages (addr_key, server_id, received_at, size_bucket, raw{columns})
         VALUES (x'{}', 'y', 1, 1, x'', 1, 1, {sender})",
        "01".repeat(32)
    );
    assert_eq!(s.conn().execute(&second, []).map(drop).map_err(StoreError::from), Err(StoreError::Conflict));
}

/// Through the real `open` path but without migration v4: a v3 database with real data of every kind.
fn v3_database_with_data(dir: &TempDir) -> i64 {
    let s = LocalStore::open_with_migrations(&db_path(dir), &KEY, &scope(), &schema::MIGRATIONS[..3]).unwrap();
    assert_eq!(s.schema_version().unwrap(), 3);
    for b in [1, 2, 3] {
        s.insert_address(&address(b)).unwrap();
    }
    s.abandon_address(&[3; 32], 7).unwrap();
    let read = s.insert_message(&message(1, "m1", "leído")).unwrap().unwrap();
    s.set_flags(read, &MessageFlags { is_read: Some(true), starred: Some(true), ..MessageFlags::default() }).unwrap();
    s.insert_message(&message(2, "m2", "otro")).unwrap();
    s.insert_message(&message(3, "m3", "oculto")).unwrap();
    s.mark_skipped(&[1; 32], "bad", SkipReason::Undecryptable, 9).unwrap();
    s.set_sync_cursor(&[1; 32], "4").unwrap();
    let sent = NewSentMessage {
        message_id: [9; 16],
        addr_key: [1; 32],
        from_addr: "a1@nightmail.local".into(),
        to_addr: "destino@nightmail.local".into(),
        subject: "enviado".into(),
        body: Zeroizing::new("cuerpo enviado".into()),
        sent_at: 50,
    };
    s.insert_sent(&sent).unwrap();
    assert!(s.conn().prepare("SELECT e2e FROM messages").is_err(), "v3 has no e2e column");
    s.close().unwrap();
    read
}

#[test]
fn an_encrypted_v3_database_migrates_to_v4_keeping_its_data() {
    let dir = TempDir::new().unwrap();
    let read = v3_database_with_data(&dir);
    let s = LocalStore::open(&db_path(&dir), &KEY, &scope()).unwrap();
    assert_eq!(s.schema_version().unwrap(), 4);
    assert_eq!(s.list_addresses().unwrap(), vec![address(1), address(2)]);
    assert_eq!(s.list_abandoned_addresses().unwrap(), vec![address(3)]);
    // Old mail is plain (not e2e, not verified) and keeps its flags; the abandoned address's stays hidden.
    assert_eq!(listed(&s), [("leído".into(), false, false), ("otro".into(), false, false)]);
    let old = s.get_message(read).unwrap().unwrap();
    assert!(old.summary.is_read && old.summary.starred && !old.summary.e2e && !old.summary.sender_verified);
    assert_eq!(old.raw, message(1, "m1", "leído").raw);
    assert_eq!(s.skip_reason(&[1; 32], "bad").unwrap(), Some(SkipReason::Undecryptable));
    assert_eq!(s.get_sync_cursor(&[1; 32]).unwrap().as_deref(), Some("4"));
    assert_eq!(s.count_sent(None).unwrap(), 1);
    assert_eq!(known(&s, 3, &["m3"]), ["m3"], "hidden mail is still known to sync");
    // The new columns and tables work on the migrated file.
    stored_id(s.insert_e2e_message(&message(1, "v1", "nuevo"), &meta(5, 1, true)).unwrap());
    s.add_e2e_pending(&pending(2, "p1"), 0).unwrap();
    s.close().unwrap();
    let again = LocalStore::open(&db_path(&dir), &KEY, &scope()).unwrap();
    assert_eq!(again.schema_version().unwrap(), 4);
    assert_eq!(listed(&again).len(), 3);
    assert!(again.get_e2e_pending(&[2; 32], "p1").unwrap().is_some());
}

#[test]
fn a_failed_v4_migration_leaves_the_v3_database_untouched() {
    let dir = TempDir::new().unwrap();
    v3_database_with_data(&dir);
    let broken = [
        schema::MIGRATIONS[0],
        schema::MIGRATIONS[1],
        schema::MIGRATIONS[2],
        "ALTER TABLE messages ADD COLUMN e2e INTEGER NOT NULL DEFAULT 0; ESTO NO ES SQL;",
    ];
    let err = LocalStore::open_with_migrations(&db_path(&dir), &KEY, &scope(), &broken).err();
    assert_eq!(err, Some(StoreError::Db));
    let s = LocalStore::open_with_migrations(&db_path(&dir), &KEY, &scope(), &schema::MIGRATIONS[..3]).unwrap();
    assert_eq!(s.schema_version().unwrap(), 3);
    assert!(s.conn().prepare("SELECT e2e FROM messages").is_err(), "the half migration must not remain");
    s.close().unwrap();
    let s = LocalStore::open(&db_path(&dir), &KEY, &scope()).unwrap();
    assert_eq!(s.schema_version().unwrap(), 4);
    assert_eq!(listed(&s).len(), 2);
}
