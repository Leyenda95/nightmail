use super::*;
use rusqlite::params;
use std::path::PathBuf;
use std::sync::Arc;
use tempfile::TempDir;

const KEY: [u8; 32] = [7; 32];
/// Latest schema version.
const CURRENT: u32 = schema::MIGRATIONS.len() as u32;

fn scope() -> StoreScope {
    StoreScope {
        network: "devnet".into(),
        contract: "c1".into(),
    }
}

fn db_path(dir: &TempDir) -> PathBuf {
    dir.path().join("sub").join("nightmail.db")
}

fn open_in(dir: &TempDir) -> LocalStore {
    LocalStore::open(&db_path(dir), &KEY, &scope()).unwrap()
}

fn fresh() -> (TempDir, LocalStore) {
    let dir = TempDir::new().unwrap();
    let store = open_in(&dir);
    (dir, store)
}

fn open_err(dir: &TempDir, key: &[u8; 32], scope: &StoreScope) -> Option<StoreError> {
    LocalStore::open(&db_path(dir), key, scope).err()
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

fn message(addr: u8, server_id: &str, received_at: i64) -> NewMessage {
    NewMessage {
        addr_key: [addr; 32],
        server_id: server_id.into(),
        received_at,
        size_bucket: 4096,
        raw: b"Subject: hola\r\n\r\ncuerpo".to_vec(),
        parsed: ParsedFields::default(),
    }
}

fn key() -> SlotKey {
    SlotKey {
        n: 1,
        kind: SlotKind::Mailbox,
        j: 2,
    }
}

fn alias_key() -> SlotKey {
    SlotKey {
        n: 1,
        kind: SlotKind::Alias,
        j: 3,
    }
}

fn data(name: Option<&str>, addr: Option<u8>) -> SlotPatch {
    SlotPatch {
        addr_key: addr.map(|b| [b; 32]),
        pending_name: name.map(String::from),
    }
}

fn slot_at(key: SlotKey, status: SlotStatus, d: SlotPatch) -> Slot {
    Slot {
        key,
        slot_nul: [key.j as u8 + 100; 32],
        status,
        addr_key: d.addr_key,
        pending_name: d.pending_name,
        attempts: 0,
        updated_at: 1,
    }
}

/// A mailbox in `reserving` already carries its name.
fn reserving_data() -> SlotPatch {
    data(Some("juan"), None)
}

/// A mailbox in the given state, with the data that state requires.
fn mailbox_in(s: &LocalStore, status: SlotStatus) {
    let d = match status {
        SlotStatus::Used => data(None, Some(5)),
        SlotStatus::Reserving => reserving_data(),
        SlotStatus::Burned => SlotPatch::default(),
    };
    s.insert_slot(&slot_at(key(), status, d)).unwrap();
}

fn go(s: &LocalStore, to: SlotStatus, patch: &SlotPatch) -> Result<()> {
    s.transition_slot(key(), to, patch, 10)
}

fn mailbox_address(b: u8) -> Address {
    Address {
        kind: SlotKind::Mailbox,
        n: 1,
        j: 2,
        ..address(b)
    }
}

fn entry(id: &str, started_at: i64) -> JournalEntry {
    JournalEntry {
        id: id.into(),
        kind: "buy-bono".into(),
        payload: vec![1, 2, 3],
        started_at,
    }
}

fn leaf(n: u32, k: u32, plan: Plan) -> BonoLeaf {
    BonoLeaf {
        n,
        k,
        plan,
        id: [n as u8; 32],
        status: BonoStatus::Requested,
        position: None,
        requested_at: 5,
        usable_at: None,
    }
}

// ---------- opening, encryption and scope ----------

#[test]
fn file_is_really_encrypted() {
    let (dir, store) = fresh();
    store.set_meta("secreto", b"TEXTO-MUY-RECONOCIBLE").unwrap();
    store.insert_address(&address(1)).unwrap();
    store.close().unwrap();
    let bytes = std::fs::read(db_path(&dir)).unwrap();
    assert!(!bytes.starts_with(b"SQLite format 3"));
    assert!(!bytes.windows(21).any(|w| w == b"TEXTO-MUY-RECONOCIBLE"));
    assert!(!bytes.windows(14).any(|w| w == b"a1@nightmail.l"));
}

#[test]
fn wal_file_is_encrypted_and_private_while_open() {
    let (dir, store) = fresh();
    store.set_meta("secreto", b"TEXTO-MUY-RECONOCIBLE").unwrap();
    let wal = dir.path().join("sub").join("nightmail.db-wal");
    let bytes = std::fs::read(&wal).unwrap();
    assert!(!bytes.is_empty(), "with the database open the WAL must have content");
    assert!(!bytes.windows(21).any(|w| w == b"TEXTO-MUY-RECONOCIBLE"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&wal).unwrap().permissions().mode() & 0o777, 0o600);
    }
    drop(store);
}

#[test]
fn wrong_key_is_rejected_and_nothing_is_deleted() {
    let (dir, store) = fresh();
    store.set_meta("a", b"b").unwrap();
    store.close().unwrap();
    let before = std::fs::read(db_path(&dir)).unwrap();
    assert_eq!(open_err(&dir, &[8; 32], &scope()), Some(StoreError::WrongKey));
    assert_eq!(std::fs::read(db_path(&dir)).unwrap(), before);
    assert!(open_in(&dir).get_meta("a").unwrap().is_some());
}

#[test]
fn plain_sqlite_file_is_wrong_key() {
    let dir = TempDir::new().unwrap();
    std::fs::create_dir_all(dir.path().join("sub")).unwrap();
    let plain = rusqlite::Connection::open(db_path(&dir)).unwrap();
    plain
        .execute_batch("CREATE TABLE t(x); INSERT INTO t VALUES (1);")
        .unwrap();
    drop(plain);
    #[cfg(unix)]
    std::fs::set_permissions(db_path(&dir), std::os::unix::fs::PermissionsExt::from_mode(0o600)).unwrap();
    assert_eq!(open_err(&dir, &KEY, &scope()), Some(StoreError::WrongKey));
}

#[test]
fn garbage_file_is_wrong_key() {
    let dir = TempDir::new().unwrap();
    std::fs::create_dir_all(dir.path().join("sub")).unwrap();
    std::fs::write(db_path(&dir), vec![0xAB; 8192]).unwrap();
    #[cfg(unix)]
    std::fs::set_permissions(db_path(&dir), std::os::unix::fs::PermissionsExt::from_mode(0o600)).unwrap();
    assert_eq!(open_err(&dir, &KEY, &scope()), Some(StoreError::WrongKey));
}

#[test]
fn scope_is_stored_and_checked() {
    let (dir, store) = fresh();
    assert_eq!(store.scope().unwrap(), scope());
    store.close().unwrap();
    let other_net = StoreScope {
        network: "preprod".into(),
        ..scope()
    };
    let other_contract = StoreScope {
        contract: "c2".into(),
        ..scope()
    };
    assert_eq!(open_err(&dir, &KEY, &other_net), Some(StoreError::ScopeMismatch));
    assert_eq!(open_err(&dir, &KEY, &other_contract), Some(StoreError::ScopeMismatch));
    assert_eq!(open_in(&dir).scope().unwrap(), scope());
}

#[test]
fn scope_keys_are_reserved() {
    let (_d, s) = fresh();
    assert_eq!(s.set_meta("scope.network", b"x"), Err(StoreError::OutOfRange));
}

#[test]
fn reopen_with_same_key_keeps_data_and_migration_is_idempotent() {
    let (dir, store) = fresh();
    assert_eq!(store.schema_version().unwrap(), CURRENT);
    store.set_meta("red", b"devnet").unwrap();
    store.close().unwrap();
    let again = open_in(&dir);
    assert_eq!(again.schema_version().unwrap(), CURRENT);
    assert_eq!(again.get_meta("red").unwrap(), Some(b"devnet".to_vec()));
}

#[test]
fn newer_schema_is_refused() {
    let (dir, store) = fresh();
    store.conn().execute_batch("PRAGMA user_version = 99;").unwrap();
    store.close().unwrap();
    assert_eq!(open_err(&dir, &KEY, &scope()), Some(StoreError::SchemaTooNew));
}

#[test]
fn pragmas_are_applied() {
    let (_dir, store) = fresh();
    let conn = store.conn();
    let int = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap();
    let mode: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
    assert_eq!(
        (int("PRAGMA foreign_keys"), int("PRAGMA secure_delete"), mode.as_str()),
        (1, 1, "wal")
    );
    assert_eq!(int("PRAGMA synchronous"), 2); // FULL
}

#[cfg(unix)]
#[test]
fn permissions_are_private_and_preexisting_open_folder_is_fixed() {
    use std::os::unix::fs::PermissionsExt;
    let dir = TempDir::new().unwrap();
    let folder = dir.path().join("sub");
    std::fs::create_dir(&folder).unwrap();
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o755)).unwrap();
    let _store = open_in(&dir);
    let mode = |p: PathBuf| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(folder.clone()), 0o700);
    assert_eq!(mode(db_path(&dir)), 0o600);
}

#[cfg(unix)]
#[test]
fn open_database_file_is_refused() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, store) = fresh();
    store.close().unwrap();
    std::fs::set_permissions(db_path(&dir), std::fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(open_err(&dir, &KEY, &scope()), Some(StoreError::InsecurePermissions));
}

#[test]
fn parent_dir_is_none_for_bare_filename() {
    assert_eq!(parent_dir(Path::new("solo.db")), None);
    assert_eq!(parent_dir(Path::new("a/solo.db")), Some(Path::new("a")));
}

#[test]
fn open_fails_cleanly_when_parent_is_a_file() {
    let dir = TempDir::new().unwrap();
    let blocker = dir.path().join("fichero");
    std::fs::write(&blocker, b"x").unwrap();
    let err = LocalStore::open(&blocker.join("db"), &KEY, &scope()).err();
    assert_eq!(err, Some(StoreError::Io));
}

#[test]
fn cipher_check_rejects_missing_or_inactive_cipher() {
    assert_eq!(check_cipher(Some("4.5.6"), Some("openssl"), Some("1")), Ok(()));
    let bad = [
        (None, Some("o"), Some("1")),
        (Some(""), Some("o"), Some("1")),
        (Some("4"), Some(""), Some("1")),
        (Some("4"), None, Some("1")),
        (Some("4"), Some("o"), Some("0")),
        (Some("4"), Some("o"), None),
    ];
    for (version, provider, status) in bad {
        assert_eq!(
            check_cipher(version, provider, status),
            Err(StoreError::CipherUnavailable)
        );
    }
}

#[test]
fn connection_without_a_key_is_not_accepted_as_encrypted() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    assert_eq!(ensure_cipher(&conn), Err(StoreError::CipherUnavailable));
}

#[test]
fn error_messages_are_fixed_and_constraints_map_to_conflict() {
    assert_eq!(StoreError::WrongKey.to_string(), "wrong database key");
    assert_eq!(StoreError::from(rusqlite::Error::QueryReturnedNoRows), StoreError::Db);
    let (_d, s) = fresh();
    s.insert_slot(&slot_at(key(), SlotStatus::Reserving, reserving_data()))
        .unwrap();
    let again = s.insert_slot(&slot_at(key(), SlotStatus::Reserving, reserving_data()));
    assert_eq!(again, Err(StoreError::Conflict));
}

#[test]
fn store_is_send_sync_and_usable_from_two_threads() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<LocalStore>();
    let (_d, s) = fresh();
    let s = Arc::new(s);
    s.insert_address(&address(1)).unwrap();
    let handles: Vec<_> = (0..2u8)
        .map(|t| {
            let s = Arc::clone(&s);
            std::thread::spawn(move || {
                for i in 0..20 {
                    s.insert_message(&message(1, &format!("{t}-{i}"), i64::from(i)))
                        .unwrap();
                }
            })
        })
        .collect();
    handles.into_iter().for_each(|h| h.join().unwrap());
    assert_eq!(s.list_messages(&MessageFilter::default()).unwrap().len(), 40);
}

#[tokio::test]
async fn with_runs_on_a_blocking_thread() {
    let (_d, s) = fresh();
    let s = Arc::new(s);
    let version = s.with(|store| store.schema_version()).await.unwrap();
    assert_eq!(version, CURRENT);
}

#[test]
fn close_checkpoints_the_wal() {
    let (dir, store) = fresh();
    store.set_meta("a", b"b").unwrap();
    store.close().unwrap();
    let wal = dir.path().join("sub").join("nightmail.db-wal");
    assert!(!wal.exists() || std::fs::metadata(&wal).unwrap().len() == 0);
    assert_eq!(open_in(&dir).get_meta("a").unwrap(), Some(b"b".to_vec()));
}

#[test]
fn debug_output_hides_personal_data() {
    let mut a = address(1);
    a.name = Some("NOMBRE-PRIVADO".into());
    let slot = slot_at(key(), SlotStatus::Reserving, data(Some("NOMBRE-PRIVADO"), None));
    let mut m = message(1, "s", 1);
    m.parsed.subject = Some("ASUNTO-PRIVADO".into());
    let shown = format!(
        "{:?} {:?} {:?} {:?} {:?} {:?}",
        a,
        slot,
        m,
        data(Some("NOMBRE-PRIVADO"), None),
        JournalEntry {
            payload: b"PAYLOAD-PRIVADO".to_vec(),
            ..entry("j", 1)
        },
        Message {
            summary: MessageSummary {
                parsed: m.parsed.clone(),
                ..summary_of(&m)
            },
            raw: m.raw.clone()
        },
    );
    for secret in [
        "nightmail.local",
        "NOMBRE-PRIVADO",
        "ASUNTO-PRIVADO",
        "PAYLOAD",
        "cuerpo",
        "Subject",
    ] {
        assert!(!shown.contains(secret), "Debug leaks {secret}: {shown}");
    }
}

fn summary_of(m: &NewMessage) -> MessageSummary {
    MessageSummary {
        id: 1,
        addr_key: m.addr_key,
        server_id: m.server_id.clone(),
        received_at: m.received_at,
        size_bucket: m.size_bucket,
        parsed: m.parsed.clone(),
        is_read: false,
        starred: false,
        archived: false,
        deleted: false,
        e2e: false,
        sender_verified: false,
    }
}

// ---------- migrations ----------

#[test]
fn migrations_v1_to_v2_keep_data_and_failures_roll_back() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    let v1 = "CREATE TABLE a(x);";
    schema::migrate_with(&conn, &[v1]).unwrap();
    conn.execute("INSERT INTO a VALUES (42)", []).unwrap();
    // A failing v2 is rolled back entirely and the database stays at v1.
    let broken = "CREATE TABLE b(y); ESTO NO ES SQL;";
    assert_eq!(schema::migrate_with(&conn, &[v1, broken]), Err(StoreError::Db));
    assert_eq!(schema::version(&conn).unwrap(), 1);
    assert!(
        conn.prepare("SELECT y FROM b").is_err(),
        "the failed migration's table must not remain"
    );
    // A correct v2: v1 is untouched and the data survives.
    schema::migrate_with(&conn, &[v1, "CREATE TABLE b(y);"]).unwrap();
    assert_eq!(schema::version(&conn).unwrap(), 2);
    assert_eq!(
        conn.query_row("SELECT x FROM a", [], |r| r.get::<_, i64>(0)).unwrap(),
        42
    );
    // Reapplying is harmless.
    schema::migrate_with(&conn, &[v1, "CREATE TABLE b(y);"]).unwrap();
}

#[test]
fn schema_check_lists_match_the_rust_enums() {
    let (_d, s) = fresh();
    let conn = s.conn();
    for (i, p) in Plan::ALL.iter().enumerate() {
        let sql = "INSERT INTO bonos (n,k,plan,id,status,requested_at) VALUES (?1,0,?2,zeroblob(32),'requested',1)";
        conn.execute(sql, params![i as i64, p]).unwrap();
    }
    for (i, st) in BonoStatus::ALL.iter().enumerate() {
        let pos = (*st == BonoStatus::Included).then_some(1);
        let sql =
            "INSERT INTO bonos (n,k,plan,id,status,position,requested_at) VALUES (?1,1,'free',zeroblob(32),?2,?3,1)";
        conn.execute(sql, params![10 + i as i64, st, pos]).unwrap();
    }
    for (i, kind) in SlotKind::ALL.iter().enumerate() {
        let sql = "INSERT INTO addresses (addr_key, kind, n, j, display, name, created_at)
                   VALUES (randomblob(32), ?2, 0, ?1, 'x', NULL, 1)";
        conn.execute(sql, params![i as i64, kind]).unwrap();
    }
    for (i, st) in SlotStatus::ALL.iter().enumerate() {
        let sql = "INSERT INTO slots (n,kind,j,slot_nul,status,addr_key,round,pending_name,updated_at)
                   VALUES (9,'mailbox',?1,randomblob(32),?2,
                           CASE WHEN ?2 = 'used' THEN randomblob(32) END,
                           CASE WHEN ?2 IN ('reserved','revealing') THEN 1 END,
                           CASE WHEN ?2 IN ('reserving','revealing') THEN 'n' END, 1)";
        conn.execute(sql, params![i as i64, st]).unwrap();
    }
}

#[test]
fn schema_checks_reject_bad_rows() {
    let (_d, s) = fresh();
    let conn = s.conn();
    let bad = [
        "INSERT INTO bonos VALUES (1,0,'raro',zeroblob(32),'requested',NULL,1,NULL)",
        "INSERT INTO bonos VALUES (1,0,'free',x'0102','requested',NULL,1,NULL)",
        "INSERT INTO bonos VALUES (1,0,'free',zeroblob(32),'included',NULL,1,NULL)",
        "INSERT INTO bonos VALUES (1,0,'free',zeroblob(32),'requested',5,1,NULL)",
        "INSERT INTO bonos VALUES (1,0,'free',zeroblob(32),'included',1048576,1,NULL)",
        "INSERT INTO addresses (addr_key, kind, n, j, display, name, created_at) VALUES (x'0102','alias',0,0,'a',NULL,1)",
        "INSERT INTO slots (n,kind,j,slot_nul,status,updated_at) VALUES (1,'alias',1,x'01','used',1)",
        "INSERT INTO bonos VALUES (1,0,'free',zeroblob(32),'requested',NULL,'texto',NULL)",
        "INSERT INTO slots (n,kind,j,slot_nul,status,updated_at) VALUES (1,'mailbox',1,randomblob(32),'used',1)",
        "INSERT INTO slots (n,kind,j,slot_nul,status,updated_at) VALUES (1,'mailbox',2,randomblob(32),'reserved',1)",
        "INSERT INTO slots (n,kind,j,slot_nul,status,round,updated_at) VALUES (1,'mailbox',3,randomblob(32),'revealing',1,1)",
        "INSERT INTO slots (n,kind,j,slot_nul,status,round,pending_name,updated_at) VALUES (1,'alias',4,randomblob(32),'reserved',1,'x',1)",
        "INSERT INTO slots (n,kind,j,slot_nul,status,updated_at) VALUES (1,'mailbox',5,randomblob(32),'reserving',1)",
        "INSERT INTO slots (n,kind,j,slot_nul,status,pending_name,updated_at) VALUES (1,'mailbox',6,randomblob(32),'burned','x',1)",
        "UPDATE chain_cursor SET min_leaf_count = 1048577",
        "INSERT INTO chain_cursor (id) VALUES (2)",
    ];
    for sql in bad {
        assert!(conn.execute(sql, []).is_err(), "should reject: {sql}");
    }
}

#[test]
fn unreadable_rows_are_db_errors_not_panics() {
    let (_d, s) = fresh();
    {
        let conn = s.conn();
        conn.execute_batch("PRAGMA ignore_check_constraints = ON;").unwrap();
        conn.execute(
            "INSERT INTO bonos VALUES (1,0,'raro',zeroblob(32),'requested',NULL,1,NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO addresses (addr_key, kind, n, j, display, name, created_at)
             VALUES (x'0102','alias',0,0,'a',NULL,1)",
            [],
        )
        .unwrap();
    }
    assert_eq!(s.list_bonos(), Err(StoreError::Db));
    assert_eq!(s.list_addresses(), Err(StoreError::Db));
}

// ---------- bonos ----------

#[test]
fn bono_two_leaves_share_n_and_insert_is_idempotent() {
    let (_d, s) = fresh();
    assert!(s.insert_bono(&leaf(0, 0, Plan::Free)).unwrap());
    assert!(s.insert_bono(&leaf(0, 1, Plan::Paid)).unwrap());
    assert!(!s.insert_bono(&leaf(0, 1, Plan::Paid)).unwrap());
    let all = s.list_bonos().unwrap();
    assert_eq!(
        all.iter().map(|b| (b.n, b.k, b.plan)).collect::<Vec<_>>(),
        [(0, 0, Plan::Free), (0, 1, Plan::Paid)]
    );
}

#[test]
fn bono_insert_with_different_data_is_a_conflict() {
    let (_d, s) = fresh();
    s.insert_bono(&leaf(0, 0, Plan::Free)).unwrap();
    assert_eq!(s.insert_bono(&leaf(0, 0, Plan::Paid)), Err(StoreError::Conflict));
    let other_id = BonoLeaf {
        id: [9; 32],
        ..leaf(0, 0, Plan::Free)
    };
    assert_eq!(s.insert_bono(&other_id), Err(StoreError::Conflict));
    let included = BonoLeaf {
        status: BonoStatus::Included,
        position: Some(3),
        ..leaf(5, 0, Plan::Free)
    };
    assert_eq!(s.insert_bono(&included), Err(StoreError::InvalidTransition));
    assert_eq!(s.get_bono(5, 0).unwrap(), None);
}

#[test]
fn bono_included_raises_ratchet_and_closes_journal_atomically() {
    let (_d, s) = fresh();
    s.insert_bono(&leaf(3, 0, Plan::Free)).unwrap();
    s.put_journal(&entry("buy-3", 1)).unwrap();
    s.mark_bono_included_and_raise(3, 0, 41, Some("buy-3")).unwrap();
    let got = s.get_bono(3, 0).unwrap().unwrap();
    assert_eq!((got.status, got.position), (BonoStatus::Included, Some(41)));
    assert_eq!(s.get_chain_cursor().unwrap().min_leaf_count, 42);
    assert!(s.list_journal().unwrap().is_empty());
    s.mark_bono_included_and_raise(3, 0, 41, None).unwrap(); // repeating is harmless
    assert_eq!(
        s.mark_bono_included_and_raise(3, 0, 43, None),
        Err(StoreError::Conflict)
    );
}

#[test]
fn bono_included_failure_changes_nothing() {
    let (_d, s) = fresh();
    s.put_journal(&entry("buy-9", 1)).unwrap();
    assert_eq!(
        s.mark_bono_included_and_raise(9, 0, 5, Some("buy-9")),
        Err(StoreError::NotFound)
    );
    assert_eq!(s.list_journal().unwrap().len(), 1);
    assert_eq!(s.get_chain_cursor().unwrap().min_leaf_count, 0);
    s.insert_bono(&leaf(9, 0, Plan::Free)).unwrap();
    assert_eq!(
        s.mark_bono_included_and_raise(9, 0, MAX_MIN_LEAF_COUNT, None),
        Err(StoreError::OutOfRange)
    );
    assert_eq!(s.get_bono(9, 9).unwrap(), None);
}

#[test]
fn bono_usable_at_is_stored() {
    let (_d, s) = fresh();
    s.insert_bono(&leaf(1, 0, Plan::Paid)).unwrap();
    s.set_bono_usable_at(1, 0, 999).unwrap();
    assert_eq!(s.get_bono(1, 0).unwrap().unwrap().usable_at, Some(999));
    assert_eq!(s.set_bono_usable_at(7, 0, 1), Err(StoreError::NotFound));
}

// ---------- slots ----------

#[test]
fn can_become_matrix() {
    use SlotStatus::*;
    let valid = [(Reserving, Used), (Reserving, Burned)];
    for from in SlotStatus::ALL {
        for to in SlotStatus::ALL {
            assert_eq!(from.can_become(*to), valid.contains(&(*from, *to)), "{from:?} -> {to:?}");
        }
    }
}

#[test]
fn reconcile_matrix() {
    use SlotStatus::*;
    let valid = [
        (Reserving, Reserving),
        (Used, Used),
        (Burned, Burned),
        (Reserving, Used),
        (Reserving, Burned),
        (Burned, Used),
    ];
    for from in SlotStatus::ALL {
        for to in SlotStatus::ALL {
            assert_eq!(
                from.reconcile_ok(*to),
                valid.contains(&(*from, *to)),
                "{from:?} -> {to:?}"
            );
        }
    }
}

#[test]
fn mailbox_flow_keeps_the_name_until_used_and_clears_it_at_the_end() {
    let (_d, s) = fresh();
    mailbox_in(&s, SlotStatus::Reserving);
    assert_eq!(s.get_slot(key()).unwrap().unwrap().pending_name.as_deref(), Some("juan"));
    go(&s, SlotStatus::Used, &data(None, Some(5))).unwrap();
    let end = s.get_slot(key()).unwrap().unwrap();
    assert_eq!(
        (end.status, end.addr_key, end.pending_name),
        (SlotStatus::Used, Some([5; 32]), None)
    );
}

#[test]
fn alias_goes_straight_to_used() {
    let (_d, s) = fresh();
    s.insert_slot(&slot_at(alias_key(), SlotStatus::Reserving, SlotPatch::default()))
        .unwrap();
    s.transition_slot(alias_key(), SlotStatus::Used, &data(None, Some(4)), 2)
        .unwrap();
    assert_eq!(s.get_slot(alias_key()).unwrap().unwrap().status, SlotStatus::Used);
}

#[test]
fn slot_invalid_transitions_and_final_states() {
    use SlotStatus::*;
    for (from, to) in [(Used, Burned), (Burned, Used), (Used, Reserving), (Burned, Reserving)] {
        let (_d, s) = fresh();
        mailbox_in(&s, from);
        assert_eq!(
            go(&s, to, &data(Some("x"), Some(1))),
            Err(StoreError::Conflict),
            "{from:?}->{to:?}"
        );
        assert_eq!(s.get_slot(key()).unwrap().unwrap().status, from);
    }
}

#[test]
fn repeating_a_transition_is_harmless_unless_data_differs() {
    let (_d, s) = fresh();
    mailbox_in(&s, SlotStatus::Reserving);
    go(&s, SlotStatus::Reserving, &reserving_data()).unwrap();
    go(&s, SlotStatus::Reserving, &SlotPatch::default()).unwrap();
    assert_eq!(
        go(&s, SlotStatus::Reserving, &data(Some("otro"), None)),
        Err(StoreError::Conflict)
    );
}

#[test]
fn transitions_require_their_data() {
    let (_s_dir, s) = fresh();
    mailbox_in(&s, SlotStatus::Reserving);
    assert_eq!(
        go(&s, SlotStatus::Used, &SlotPatch::default()),
        Err(StoreError::MissingData)
    );
    let nameless = slot_at(SlotKey { j: 9, ..key() }, SlotStatus::Reserving, SlotPatch::default());
    assert_eq!(s.insert_slot(&nameless), Err(StoreError::MissingData)); // a reserving mailbox needs a name
    let used = slot_at(SlotKey { j: 8, ..key() }, SlotStatus::Used, SlotPatch::default());
    assert_eq!(s.insert_slot(&used), Err(StoreError::MissingData));
    let alias = slot_at(alias_key(), SlotStatus::Reserving, SlotPatch::default());
    s.insert_slot(&alias).unwrap(); // a reserving alias needs no name
}

#[test]
fn a_transition_never_overwrites_fixed_data() {
    let (_d, s) = fresh();
    mailbox_in(&s, SlotStatus::Reserving); // name "juan"
    assert_eq!(
        go(&s, SlotStatus::Used, &data(Some("otro"), Some(5))),
        Err(StoreError::Conflict)
    );
    go(&s, SlotStatus::Used, &data(None, Some(5))).unwrap();
    assert_eq!(
        go(&s, SlotStatus::Used, &data(None, Some(6))),
        Err(StoreError::Conflict)
    );
}

#[test]
fn missing_slot() {
    let (_d, s) = fresh();
    assert_eq!(
        go(&s, SlotStatus::Burned, &SlotPatch::default()),
        Err(StoreError::NotFound)
    );
}

#[test]
fn reconcile_follows_the_chain() {
    let (_d, s) = fresh();
    mailbox_in(&s, SlotStatus::Reserving);
    s.reconcile_slot(key(), SlotStatus::Used, &data(None, Some(6)), 20)
        .unwrap();
    assert_eq!(s.get_slot(key()).unwrap().unwrap().status, SlotStatus::Used);
    assert_eq!(
        s.reconcile_slot(key(), SlotStatus::Burned, &SlotPatch::default(), 21),
        Err(StoreError::Conflict)
    );
    let (_d2, s2) = fresh();
    mailbox_in(&s2, SlotStatus::Reserving);
    s2.reconcile_slot(key(), SlotStatus::Burned, &SlotPatch::default(), 1)
        .unwrap();
    s2.reconcile_slot(key(), SlotStatus::Used, &data(None, Some(6)), 2)
        .unwrap(); // burned → used
    assert_eq!(s2.get_slot(key()).unwrap().unwrap().status, SlotStatus::Used);
}

#[test]
fn complete_slot_is_atomic() {
    let (_d, s) = fresh();
    mailbox_in(&s, SlotStatus::Reserving);
    s.put_journal(&entry("reveal-1", 1)).unwrap();
    // Another key already holds (n, kind, j): everything is rolled back.
    s.insert_address(&mailbox_address(1)).unwrap();
    let clash = s.complete_slot(key(), &mailbox_address(2), Some("reveal-1"), 30);
    assert_eq!(clash, Err(StoreError::Conflict));
    assert_eq!(s.get_slot(key()).unwrap().unwrap().status, SlotStatus::Reserving);
    assert_eq!(s.list_journal().unwrap().len(), 1);
}

#[test]
fn complete_slot_success_and_repeat() {
    let (_d, s) = fresh();
    mailbox_in(&s, SlotStatus::Reserving);
    s.put_journal(&entry("reveal-1", 1)).unwrap();
    s.complete_slot(key(), &mailbox_address(1), Some("reveal-1"), 30)
        .unwrap();
    s.complete_slot(key(), &mailbox_address(1), Some("reveal-1"), 31)
        .unwrap(); // repeating is harmless
    let slot = s.get_slot(key()).unwrap().unwrap();
    assert_eq!((slot.status, slot.addr_key), (SlotStatus::Used, Some([1; 32])));
    assert_eq!(s.get_address(&[1; 32]).unwrap(), Some(mailbox_address(1)));
    assert!(s.list_journal().unwrap().is_empty());
}

#[test]
fn complete_slot_rejects_an_address_of_another_slot() {
    let (_d, s) = fresh();
    mailbox_in(&s, SlotStatus::Reserving);
    assert_eq!(s.complete_slot(key(), &address(1), None, 1), Err(StoreError::Conflict));
}

#[test]
fn the_attempt_counter_never_resets_on_its_own() {
    let (_d, s) = fresh();
    mailbox_in(&s, SlotStatus::Reserving);
    assert_eq!(s.bump_slot_attempts(key(), 5).unwrap(), 1);
    assert_eq!(s.bump_slot_attempts(key(), 6).unwrap(), 2);
    go(&s, SlotStatus::Burned, &SlotPatch::default()).unwrap();
    assert_eq!(s.get_slot(key()).unwrap().unwrap().attempts, 2);
    let missing = SlotKey { j: 99, ..key() };
    assert_eq!(s.bump_slot_attempts(missing, 1), Err(StoreError::NotFound));
}

#[test]
fn release_only_a_never_attempted_reserving_slot() {
    let (_d, s) = fresh();
    assert_eq!(s.release_slot(key()), Err(StoreError::NotFound));
    mailbox_in(&s, SlotStatus::Reserving);
    s.bump_slot_attempts(key(), 1).unwrap();
    assert_eq!(s.release_slot(key()), Err(StoreError::InvalidTransition)); // cannot release once attempted
    let other = SlotKey { j: 5, ..key() };
    s.insert_slot(&slot_at(other, SlotStatus::Reserving, reserving_data()))
        .unwrap();
    s.release_slot(other).unwrap();
    assert_eq!(s.get_slot(other).unwrap(), None);
    let used = SlotKey { j: 6, ..key() };
    s.insert_slot(&slot_at(used, SlotStatus::Used, data(None, Some(6))))
        .unwrap();
    assert_eq!(s.release_slot(used), Err(StoreError::InvalidTransition));
}

#[test]
fn free_name_taken_slot_frees_only_a_reserving_mailbox_even_with_attempts() {
    let (_d, s) = fresh();
    mailbox_in(&s, SlotStatus::Reserving);
    s.bump_slot_attempts(key(), 1).unwrap();
    s.free_name_taken_slot(key()).unwrap();
    assert_eq!(s.get_slot(key()).unwrap(), None, "freed with an attempt counted");
    s.free_name_taken_slot(key()).unwrap(); // nothing left: harmless
    let used = SlotKey { j: 6, ..key() };
    s.insert_slot(&slot_at(used, SlotStatus::Used, data(None, Some(6)))).unwrap();
    s.free_name_taken_slot(used).unwrap();
    assert_eq!(s.get_slot(used).unwrap().unwrap().status, SlotStatus::Used, "a used slot stays");
    s.insert_slot(&slot_at(alias_key(), SlotStatus::Reserving, SlotPatch::default())).unwrap();
    s.free_name_taken_slot(alias_key()).unwrap();
    assert!(s.get_slot(alias_key()).unwrap().is_some(), "an alias is never freed this way");
}

#[test]
fn slot_unique_nullifier_listing_and_by_status() {
    let (_d, s) = fresh();
    mailbox_in(&s, SlotStatus::Reserving);
    let clash = Slot {
        key: SlotKey { j: 3, ..key() },
        ..slot_at(key(), SlotStatus::Reserving, reserving_data())
    };
    assert_eq!(s.insert_slot(&clash), Err(StoreError::Conflict)); // same slot_nul
    assert_eq!(s.list_slots(1).unwrap().len(), 1);
    assert!(s.list_slots(2).unwrap().is_empty());
    assert_eq!(s.slots_by_status(SlotStatus::Reserving).unwrap().len(), 1);
    assert!(s.slots_by_status(SlotStatus::Used).unwrap().is_empty());
}


// ---------- addresses ----------

#[test]
fn addresses_insert_idempotent_conflicting_get_and_list() {
    let (_d, s) = fresh();
    assert!(s.insert_address(&address(2)).unwrap());
    assert!(s.insert_address(&address(1)).unwrap());
    assert!(!s.insert_address(&address(1)).unwrap());
    let renamed = Address {
        display: "otra@nightmail.local".into(),
        ..address(1)
    };
    assert_eq!(s.insert_address(&renamed), Err(StoreError::Conflict));
    let same_slot = Address {
        addr_key: [9; 32],
        ..address(1)
    };
    assert_eq!(s.insert_address(&same_slot), Err(StoreError::Conflict));
    assert_eq!(s.get_address(&[1; 32]).unwrap(), Some(address(1)));
    assert_eq!(s.get_address(&[9; 32]).unwrap(), None);
    let keys: Vec<_> = s.list_addresses().unwrap().iter().map(|a| a.addr_key[0]).collect();
    assert_eq!(keys, [1, 2]);
}

// ---------- messages ----------

#[test]
fn message_insert_is_idempotent_and_needs_its_address() {
    let (_d, s) = fresh();
    assert!(s.insert_message(&message(1, "m1", 10)).is_err());
    s.insert_address(&address(1)).unwrap();
    assert!(s.insert_message(&message(1, "m1", 10)).unwrap().is_some());
    assert_eq!(s.insert_message(&message(1, "m1", 10)).unwrap(), None);
    assert_eq!(s.list_messages(&MessageFilter::default()).unwrap().len(), 1);
}

#[test]
fn message_list_filters_orders_and_paginates() {
    let (_d, s) = fresh();
    s.insert_address(&address(1)).unwrap();
    s.insert_address(&address(2)).unwrap();
    s.insert_message(&message(1, "a", 10)).unwrap();
    s.insert_message(&message(2, "b", 30)).unwrap();
    let mid = s.insert_message(&message(1, "c", 20)).unwrap().unwrap();
    let tie = s.insert_message(&message(2, "d", 30)).unwrap().unwrap();
    let all = s.list_messages(&MessageFilter::default()).unwrap();
    let ids: Vec<_> = all.iter().map(|m| m.server_id.as_str()).collect();
    assert_eq!(ids, ["d", "b", "c", "a"]);
    assert_eq!(all[0].id, tie);
    let only1 = s
        .list_messages(&MessageFilter {
            addr_key: Some([1; 32]),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(only1.iter().map(|m| m.id).collect::<Vec<_>>(), [mid, 1]);
    let page = MessageFilter {
        limit: Some(2),
        offset: 1,
        ..Default::default()
    };
    let page: Vec<_> = s
        .list_messages(&page)
        .unwrap()
        .into_iter()
        .map(|m| m.server_id)
        .collect();
    assert_eq!(page, ["b", "c"]);
}

#[test]
fn message_flags_archived_filter_deleted_and_get() {
    let (_d, s) = fresh();
    s.insert_address(&address(1)).unwrap();
    let id = s.insert_message(&message(1, "a", 10)).unwrap().unwrap();
    s.insert_message(&message(1, "b", 5)).unwrap();
    s.set_flags(
        id,
        &MessageFlags {
            is_read: Some(true),
            starred: Some(true),
            ..Default::default()
        },
    )
    .unwrap();
    s.set_flags(
        id,
        &MessageFlags {
            archived: Some(true),
            ..Default::default()
        },
    )
    .unwrap();
    let got = s.get_message(id).unwrap().unwrap();
    let f = (
        got.summary.is_read,
        got.summary.starred,
        got.summary.archived,
        got.summary.deleted,
    );
    assert_eq!(f, (true, true, true, false));
    assert_eq!(got.raw, message(1, "a", 10).raw);
    let archived = |a| {
        s.list_messages(&MessageFilter {
            archived: a,
            ..Default::default()
        })
        .unwrap()
        .len()
    };
    assert_eq!((archived(Some(true)), archived(Some(false)), archived(None)), (1, 1, 2));
    s.set_flags(
        id,
        &MessageFlags {
            deleted: Some(true),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(s.list_messages(&MessageFilter::default()).unwrap().len(), 1);
    let with_deleted = MessageFilter {
        include_deleted: true,
        ..Default::default()
    };
    assert_eq!(s.list_messages(&with_deleted).unwrap().len(), 2);
    assert_eq!(s.set_flags(999, &MessageFlags::default()), Err(StoreError::NotFound));
    assert_eq!(s.get_message(999).unwrap(), None);
}

#[test]
fn message_flags_many_all_or_nothing() {
    let (_d, s) = fresh();
    s.insert_address(&address(1)).unwrap();
    let ids: Vec<i64> = ["a", "b", "c"]
        .iter()
        .enumerate()
        .map(|(i, sid)| s.insert_message(&message(1, sid, i as i64)).unwrap().unwrap())
        .collect();
    let state = |s: &LocalStore| -> Vec<(bool, bool, bool)> {
        ids.iter()
            .map(|id| {
                let m = s.get_message(*id).unwrap().unwrap().summary;
                (m.is_read, m.archived, m.deleted)
            })
            .collect()
    };
    // One id does not exist: nothing changes.
    let archive = MessageFlags { archived: Some(true), ..Default::default() };
    assert_eq!(s.set_flags_many(&[ids[0], 999, ids[1]], &archive), Err(StoreError::NotFound));
    assert_eq!(state(&s), vec![(false, false, false); 3]);
    // Two (one repeated): only those flags on only those messages.
    s.set_flags_many(&[ids[0], ids[1], ids[0]], &archive).unwrap();
    assert_eq!(state(&s), vec![(false, true, false), (false, true, false), (false, false, false)]);
    let delete = MessageFlags { deleted: Some(true), ..Default::default() };
    s.set_flags_many(&[ids[1], ids[2]], &delete).unwrap();
    assert_eq!(state(&s), vec![(false, true, false), (false, true, true), (false, false, true)]);
    assert_eq!(s.list_messages(&MessageFilter::default()).unwrap().len(), 1);
    // Empty: nothing to do.
    s.set_flags_many(&[], &delete).unwrap();
}

#[test]
fn message_parsed_fields() {
    let (_d, s) = fresh();
    s.insert_address(&address(1)).unwrap();
    let id = s.insert_message(&message(1, "a", 10)).unwrap().unwrap();
    let parsed = ParsedFields {
        from_addr: Some("x@y".into()),
        subject: Some("Asunto".into()),
        sent_at: Some(9),
        preview: Some("vista".into()),
    };
    s.set_parsed(id, &parsed).unwrap();
    assert_eq!(s.get_message(id).unwrap().unwrap().summary.parsed, parsed);
    assert_eq!(s.set_parsed(999, &parsed), Err(StoreError::NotFound));
}

#[test]
fn deleting_address_cascades_to_messages_and_cursor() {
    let (_d, s) = fresh();
    s.insert_address(&address(1)).unwrap();
    s.insert_message(&message(1, "a", 10)).unwrap();
    s.set_sync_cursor(&[1; 32], "t0").unwrap();
    s.conn().execute("DELETE FROM addresses", []).unwrap();
    assert!(s.list_messages(&MessageFilter::default()).unwrap().is_empty());
    assert_eq!(s.get_sync_cursor(&[1; 32]).unwrap(), None);
}

// ---------- meta, cursors, ratchet, journal ----------

#[test]
fn meta_and_sync_cursor_upsert() {
    let (_d, s) = fresh();
    assert_eq!(s.get_meta("x").unwrap(), None);
    s.set_meta("x", b"1").unwrap();
    s.set_meta("x", b"2").unwrap();
    assert_eq!(s.get_meta("x").unwrap(), Some(b"2".to_vec()));
    s.insert_address(&address(1)).unwrap();
    s.set_sync_cursor(&[1; 32], "a").unwrap();
    s.set_sync_cursor(&[1; 32], "b").unwrap();
    assert_eq!(s.get_sync_cursor(&[1; 32]).unwrap(), Some("b".into()));
    assert!(s.set_sync_cursor(&[7; 32], "z").is_err());
}

#[test]
fn ratchet_only_goes_up_and_caps() {
    let (_d, s) = fresh();
    assert_eq!(
        s.get_chain_cursor().unwrap(),
        ChainCursor {
            min_leaf_count: 0,
            behind_streak: 0
        }
    );
    assert_eq!(s.raise_min_leaf_count(10).unwrap(), 10);
    assert_eq!(s.raise_min_leaf_count(5).unwrap(), 10);
    assert_eq!(s.raise_min_leaf_count(20).unwrap(), 20);
    assert_eq!(s.raise_min_leaf_count(MAX_MIN_LEAF_COUNT).unwrap(), MAX_MIN_LEAF_COUNT);
    assert_eq!(
        s.raise_min_leaf_count(MAX_MIN_LEAF_COUNT + 1),
        Err(StoreError::OutOfRange)
    );
    assert_eq!(s.get_chain_cursor().unwrap().min_leaf_count, MAX_MIN_LEAF_COUNT);
}

#[test]
fn ratchet_reset_goes_to_the_included_leaves_and_streak_counts() {
    let (_d, s) = fresh();
    assert_eq!(s.increment_behind_streak().unwrap(), 1);
    assert_eq!(s.increment_behind_streak().unwrap(), 2);
    s.insert_bono(&leaf(1, 0, Plan::Free)).unwrap();
    s.insert_bono(&leaf(2, 0, Plan::Free)).unwrap();
    s.mark_bono_included_and_raise(1, 0, 7, None).unwrap();
    s.mark_bono_included_and_raise(2, 0, 30, None).unwrap();
    s.raise_min_leaf_count(900).unwrap();
    s.reset_min_leaf_count().unwrap();
    assert_eq!(
        s.get_chain_cursor().unwrap(),
        ChainCursor {
            min_leaf_count: 31,
            behind_streak: 0
        }
    );
    s.increment_behind_streak().unwrap();
    s.reset_behind_streak().unwrap();
    assert_eq!(s.get_chain_cursor().unwrap().behind_streak, 0);
}

#[test]
fn ratchet_reset_without_leaves_is_zero() {
    let (_d, s) = fresh();
    s.raise_min_leaf_count(50).unwrap();
    s.reset_min_leaf_count().unwrap();
    assert_eq!(s.get_chain_cursor().unwrap().min_leaf_count, 0);
}

#[test]
fn journal_put_list_remove() {
    let (_d, s) = fresh();
    s.put_journal(&entry("b", 20)).unwrap();
    s.put_journal(&entry("a", 10)).unwrap();
    s.put_journal(&entry("a", 10)).unwrap();
    assert_eq!(s.list_journal().unwrap(), [entry("a", 10), entry("b", 20)]);
    assert!(s.remove_journal("a").unwrap());
    assert!(!s.remove_journal("a").unwrap());
    assert_eq!(s.list_journal().unwrap(), [entry("b", 20)]);
}

// ---------- atomic operations ----------

#[test]
fn mark_included_and_raise_is_atomic_for_real() {
    let (_d, s) = fresh();
    s.insert_bono(&leaf(9, 0, Plan::Free)).unwrap();
    s.put_journal(&entry("buy-9", 1)).unwrap();
    // The ratchet fails after the leaf is marked: everything must roll back.
    s.conn()
        .execute_batch("CREATE TRIGGER boom BEFORE UPDATE ON chain_cursor BEGIN SELECT RAISE(ABORT, 'boom'); END;")
        .unwrap();
    assert!(s.mark_bono_included_and_raise(9, 0, 5, Some("buy-9")).is_err());
    let leaf = s.get_bono(9, 0).unwrap().unwrap();
    assert_eq!((leaf.status, leaf.position), (BonoStatus::Requested, None));
    assert_eq!(s.list_journal().unwrap().len(), 1);
}

#[test]
fn requested_leaf_can_be_forgotten_but_not_an_included_one() {
    let (_d, s) = fresh();
    s.insert_bono(&leaf(1, 0, Plan::Free)).unwrap();
    s.insert_bono(&leaf(2, 0, Plan::Free)).unwrap();
    s.mark_bono_included_and_raise(2, 0, 4, None).unwrap();
    s.forget_requested_bono(1, 0).unwrap();
    assert_eq!(s.get_bono(1, 0).unwrap(), None);
    assert_eq!(s.forget_requested_bono(2, 0), Err(StoreError::InvalidTransition));
    assert_eq!(s.forget_requested_bono(7, 0), Err(StoreError::NotFound));
    s.insert_bono(&leaf(1, 0, Plan::Paid)).unwrap(); // can be requested again with another plan
}

fn recovered_slot(status: SlotStatus) -> Slot {
    slot_at(key(), status, SlotPatch::default())
}

#[test]
fn reconcile_address_creates_slot_and_address_when_missing() {
    let (_d, s) = fresh();
    s.reconcile_address(&recovered_slot(SlotStatus::Used), &mailbox_address(1), 50)
        .unwrap();
    s.reconcile_address(&recovered_slot(SlotStatus::Used), &mailbox_address(1), 51)
        .unwrap(); // repeat
    let slot = s.get_slot(key()).unwrap().unwrap();
    assert_eq!((slot.status, slot.addr_key), (SlotStatus::Used, Some([1; 32])));
    assert_eq!(s.get_address(&[1; 32]).unwrap(), Some(mailbox_address(1)));
}

#[test]
fn reconcile_address_upgrades_an_existing_slot() {
    for from in [SlotStatus::Burned, SlotStatus::Reserving] {
        let (_d, s) = fresh();
        mailbox_in(&s, from);
        s.reconcile_address(&recovered_slot(SlotStatus::Used), &mailbox_address(1), 50)
            .unwrap();
        let slot = s.get_slot(key()).unwrap().unwrap();
        assert_eq!(
            (slot.status, slot.addr_key, slot.pending_name),
            (SlotStatus::Used, Some([1; 32]), None)
        );
    }
}

#[test]
fn reconcile_address_contradictions_change_nothing() {
    let (_d, s) = fresh();
    s.reconcile_address(&recovered_slot(SlotStatus::Used), &mailbox_address(1), 50)
        .unwrap();
    let other_nul = Slot {
        slot_nul: [1; 32],
        ..recovered_slot(SlotStatus::Used)
    };
    assert_eq!(
        s.reconcile_address(&other_nul, &mailbox_address(1), 51),
        Err(StoreError::Conflict)
    );
    let used = recovered_slot(SlotStatus::Used);
    assert_eq!(
        s.reconcile_address(&used, &mailbox_address(2), 51),
        Err(StoreError::Conflict)
    );
    assert_eq!(s.reconcile_address(&used, &address(1), 51), Err(StoreError::Conflict));
    // The address clashes with another at (n, kind, j): the new slot is not left half-done.
    let (_d2, s2) = fresh();
    s2.insert_address(&mailbox_address(1)).unwrap();
    assert!(s2.reconcile_address(&used, &mailbox_address(2), 1).is_err());
    assert_eq!(s2.get_slot(key()).unwrap(), None);
}

#[test]
fn scope_is_normalized_and_validated() {
    let s = StoreScope::new(" DevNet ", " 0xAbC1 ").unwrap();
    assert_eq!((s.network.as_str(), s.contract.as_str()), ("devnet", "abc1"));
    for (net, contract) in [
        ("", "ab"),
        ("dev net", "ab"),
        ("devnet", ""),
        ("devnet", "xyz"),
        ("devnet", "0x"),
    ] {
        assert_eq!(
            StoreScope::new(net, contract),
            Err(StoreError::InvalidScope),
            "{net:?} {contract:?}"
        );
    }
    let (dir, store) = fresh();
    store.close().unwrap();
    let shouting = StoreScope {
        network: "DEVNET".into(),
        contract: "0xC1".into(),
    };
    assert!(LocalStore::open(&db_path(&dir), &KEY, &shouting).is_ok());
    let empty = StoreScope {
        network: String::new(),
        contract: "c1".into(),
    };
    assert_eq!(open_err(&dir, &KEY, &empty), Some(StoreError::InvalidScope));
}

#[test]
fn scope_is_checked_before_migrating() {
    let (dir, store) = fresh();
    store.conn().execute_batch("PRAGMA user_version = 99;").unwrap();
    store.close().unwrap();
    let other = StoreScope {
        network: "preprod".into(),
        ..scope()
    };
    assert_eq!(open_err(&dir, &KEY, &other), Some(StoreError::ScopeMismatch));
}

#[cfg(unix)]
#[test]
fn folder_writable_by_others_is_refused_with_a_clear_error() {
    use std::os::unix::fs::PermissionsExt;
    let dir = TempDir::new().unwrap();
    let folder = dir.path().join("sub");
    std::fs::create_dir(&folder).unwrap();
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o777)).unwrap();
    assert_eq!(open_err(&dir, &KEY, &scope()), Some(StoreError::InsecurePermissions));
    assert!(
        StoreError::InsecurePermissions
            .to_string()
            .contains("insecure permissions")
    );
}

#[test]
fn migration_already_applied_by_another_process_is_skipped() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("race.db");
    let first = rusqlite::Connection::open(&path).unwrap();
    let second = rusqlite::Connection::open(&path).unwrap();
    let v1 = "CREATE TABLE a(x);";
    schema::migrate_with(&first, &[v1]).unwrap();
    // `second` decided to migrate before `first` finished: once inside the transaction it re-reads the version.
    schema::apply(&second, v1, 1).unwrap();
    assert_eq!(schema::version(&second).unwrap(), 1);
}

#[test]
fn a_migration_that_commits_by_itself_is_an_error() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    assert_eq!(
        schema::migrate_with(&conn, &["CREATE TABLE a(x); COMMIT;"]),
        Err(StoreError::Db)
    );
}

#[test]
fn debug_of_filters_and_leaves_hides_keys() {
    let filter = MessageFilter {
        addr_key: Some([0xAB; 32]),
        ..Default::default()
    };
    let shown = format!("{:?} {:?}", filter, leaf(1, 0, Plan::Free));
    assert!(
        !shown.contains("171") && !shown.contains("addr_key") && !shown.contains("id:"),
        "{shown}"
    );
}

// ---------- MailSync support ----------

#[test]
fn known_server_ids_uses_only_that_address_and_chunks() {
    let (_d, s) = fresh();
    s.insert_address(&address(1)).unwrap();
    s.insert_address(&address(2)).unwrap();
    s.insert_message(&message(1, "a", 1)).unwrap();
    s.insert_message(&message(1, "b", 2)).unwrap();
    s.insert_message(&message(2, "c", 3)).unwrap();
    let ask = |k: u8, ids: &[&str]| {
        let ids: Vec<String> = ids.iter().map(|x| x.to_string()).collect();
        let mut v: Vec<_> = s.known_server_ids(&[k; 32], &ids).unwrap().into_iter().collect();
        v.sort();
        v
    };
    assert_eq!(ask(1, &["a", "b", "c", "z"]), ["a", "b"]);
    assert_eq!(ask(2, &["a", "c"]), ["c"]);
    assert!(ask(1, &[]).is_empty());
    let many: Vec<String> = (0..1200).map(|i| format!("m{i}")).collect();
    for id in many.iter().step_by(300) {
        s.insert_message(&message(1, id, 9)).unwrap();
    }
    assert_eq!(s.known_server_ids(&[1; 32], &many).unwrap().len(), 4);
}

#[test]
fn sync_cursor_is_monotonic_and_resettable() {
    let (_d, s) = fresh();
    s.insert_address(&address(1)).unwrap();
    let cursor = || s.get_sync_cursor(&[1; 32]).unwrap().unwrap();
    s.set_sync_cursor(&[1; 32], "10").unwrap();
    s.set_sync_cursor(&[1; 32], "9").unwrap(); // lower: ignored
    assert_eq!(cursor(), "10");
    s.set_sync_cursor(&[1; 32], "100").unwrap(); // numeric, not lexical
    assert_eq!(cursor(), "100");
    s.set_sync_cursor(&[1; 32], "100").unwrap();
    s.set_sync_cursor(&[1; 32], "no es un número").unwrap(); // non-numeric: stored
    assert_eq!(cursor(), "no es un número");
    s.set_sync_cursor(&[1; 32], "5").unwrap(); // the stored one is non-numeric: accepted
    assert_eq!(cursor(), "5");
    s.reset_sync_cursor(&[1; 32]).unwrap();
    assert_eq!(cursor(), "0");
    assert!(s.reset_sync_cursor(&[9; 32]).is_err()); // unknown address
}

#[test]
fn message_attempts_and_skips() {
    let (_d, s) = fresh();
    s.insert_address(&address(1)).unwrap();
    let k = [1; 32];
    assert!(!s.is_skipped(&k, "m1").unwrap());
    assert_eq!(s.bump_message_attempt(&k, "m1", 1).unwrap(), 1);
    assert_eq!(s.bump_message_attempt(&k, "m1", 2).unwrap(), 2);
    assert!(!s.is_skipped(&k, "m1").unwrap()); // counting is not skipping
    s.mark_skipped(&k, "m1", SkipReason::TooLarge, 3).unwrap();
    assert!(s.is_skipped(&k, "m1").unwrap());
    assert_eq!(s.skip_reason(&k, "m1").unwrap(), Some(SkipReason::TooLarge));
    assert_eq!(s.bump_message_attempt(&k, "m1", 4).unwrap(), 3); // keeps the count
    s.mark_skipped(&k, "m2", SkipReason::Failed, 5).unwrap(); // skip without having counted
    assert_eq!(s.bump_message_attempt(&k, "m2", 6).unwrap(), 1);
    assert!(s.forget_skipped(&k, "m1").unwrap());
    assert!(!s.forget_skipped(&k, "m1").unwrap());
    assert!(!s.is_skipped(&k, "m1").unwrap());
    assert_eq!(s.bump_message_attempt(&k, "m1", 7).unwrap(), 1); // starts from zero
    assert!(s.bump_message_attempt(&[7; 32], "m1", 1).is_err()); // unknown address
    s.conn().execute("DELETE FROM addresses", []).unwrap();
    assert!(!s.is_skipped(&k, "m2").unwrap()); // cascade
}

#[test]
fn every_skip_reason_is_accepted_by_the_schema() {
    let (_d, s) = fresh();
    s.insert_address(&address(1)).unwrap();
    for (i, reason) in SkipReason::ALL.iter().enumerate() {
        s.mark_skipped(&[1; 32], &format!("m{i}"), *reason, 1).unwrap();
        assert_eq!(s.skip_reason(&[1; 32], &format!("m{i}")).unwrap(), Some(*reason));
    }
    let bad = s.conn().execute("UPDATE skipped_messages SET reason = 'raro'", []);
    assert!(bad.is_err());
}

// ---------- orchestrator operations ----------

#[test]
fn include_bono_sets_usable_at_only_once_and_closes_the_journal() {
    let (_d, s) = fresh();
    s.insert_bono(&leaf(0, 0, Plan::Paid)).unwrap();
    s.put_journal(&entry("buy-bono/0/0", 1)).unwrap();
    s.include_bono(0, 0, 4, 100, Some("buy-bono/0/0")).unwrap();
    let b = s.get_bono(0, 0).unwrap().unwrap();
    assert_eq!((b.status, b.position, b.usable_at), (BonoStatus::Included, Some(4), Some(100)));
    assert!(s.list_journal().unwrap().is_empty());
    assert_eq!(s.get_chain_cursor().unwrap().min_leaf_count, 5);
    s.include_bono(0, 0, 4, 999, None).unwrap(); // repeat: harmless, does not move usable_at
    assert_eq!(s.get_bono(0, 0).unwrap().unwrap().usable_at, Some(100));
    assert_eq!(s.include_bono(0, 0, 5, 1, None), Err(StoreError::Conflict));
    assert_eq!(s.include_bono(9, 0, 5, 1, None), Err(StoreError::NotFound));
}

#[test]
fn reset_slot_attempts_only_for_open_slots() {
    let (_d, s) = fresh();
    mailbox_in(&s, SlotStatus::Reserving);
    s.bump_slot_attempts(key(), 2).unwrap();
    s.bump_slot_attempts(key(), 2).unwrap();
    s.reset_slot_attempts(key(), 3).unwrap();
    assert_eq!(s.get_slot(key()).unwrap().unwrap().attempts, 0);
    go(&s, SlotStatus::Burned, &SlotPatch::default()).unwrap();
    assert_eq!(s.reset_slot_attempts(key(), 4), Err(StoreError::InvalidTransition));
    assert_eq!(s.reset_slot_attempts(alias_key(), 4), Err(StoreError::NotFound));
}

#[test]
fn set_address_name_only_for_unnamed_mailboxes() {
    let (_d, s) = fresh();
    let unnamed = Address { display: String::new(), ..mailbox_address(3) };
    s.insert_address(&unnamed).unwrap();
    s.set_address_name(&[3; 32], "juan", "juan@nightmail.local").unwrap();
    let a = s.get_address(&[3; 32]).unwrap().unwrap();
    assert_eq!((a.name.as_deref(), a.display.as_str()), (Some("juan"), "juan@nightmail.local"));
    assert_eq!(s.set_address_name(&[3; 32], "otro", "x"), Err(StoreError::Conflict));
    s.insert_address(&address(4)).unwrap();
    assert_eq!(s.set_address_name(&[4; 32], "alias", "x"), Err(StoreError::Conflict), "an alias has no name");
    assert_eq!(s.set_address_name(&[9; 32], "x", "x"), Err(StoreError::NotFound));
}

#[test]
fn claim_bono_leaf_keeps_one_method_per_leaf() {
    let (_d, s) = fresh();
    assert!(s.claim_bono_leaf(&leaf(0, 0, Plan::Paid), "method/0/0", b"fiat").unwrap());
    assert!(s.claim_bono_leaf(&leaf(0, 0, Plan::Paid), "method/0/0", b"fiat").unwrap(), "the same one: harmless");
    assert!(!s.claim_bono_leaf(&leaf(0, 0, Plan::Paid), "method/0/0", b"shielded").unwrap());
    assert_eq!(s.get_meta("method/0/0").unwrap().as_deref(), Some(&b"fiat"[..]));
    s.set_meta("receipt/0/0", b"r").unwrap();
    s.forget_bono_request(0, 0, &["method/0/0", "receipt/0/0"]).unwrap();
    assert!(s.get_bono(0, 0).unwrap().is_none());
    assert_eq!(s.get_meta("method/0/0").unwrap().as_deref(), Some(&b""[..]));
    assert!(s.claim_bono_leaf(&leaf(0, 0, Plan::Paid), "method/0/0", b"shielded").unwrap(), "empty: free");
    assert_eq!(s.forget_bono_request(5, 0, &[]), Err(StoreError::NotFound));
}

#[test]
fn abandon_reserving_slot_is_one_operation() {
    let (_d, s) = fresh();
    // `Slot::abandonable` predicts what the SQL does in each case (the UI uses it to show the button).
    let predicts = |not_after: i64| s.get_slot(key()).unwrap().unwrap().abandonable(not_after);
    mailbox_in(&s, SlotStatus::Reserving);
    assert!(predicts(0));
    assert!(s.abandon_reserving_slot(key(), 0).unwrap(), "no attempts: always");
    mailbox_in(&s, SlotStatus::Reserving);
    s.bump_slot_attempts(key(), 100).unwrap();
    assert!(!predicts(100));
    assert!(!s.abandon_reserving_slot(key(), 100).unwrap(), "last proof not before the limit");
    assert!(predicts(101));
    assert!(s.abandon_reserving_slot(key(), 101).unwrap());
    mailbox_in(&s, SlotStatus::Burned);
    assert!(!predicts(i64::MAX));
    assert!(!s.abandon_reserving_slot(key(), i64::MAX).unwrap(), "only `reserving`");
}

// ---------- abandoned addresses (migration v2) ----------

/// Creates, through the real `open` path but with only migration v1, a database stuck at v1, with data.
fn v1_database_with_data(dir: &TempDir) {
    let s = LocalStore::open_with_migrations(&db_path(dir), &KEY, &scope(), &schema::MIGRATIONS[..1]).unwrap();
    assert_eq!(s.schema_version().unwrap(), 1);
    let a = address(1);
    s.conn()
        .execute(
            "INSERT INTO addresses (addr_key, kind, n, j, display, name, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![a.addr_key, a.kind, a.n, a.j, a.display, a.name, a.created_at],
        )
        .unwrap();
    s.conn()
        .execute(
            "INSERT INTO messages (addr_key, server_id, received_at, size_bucket, raw, is_read) VALUES (?1,'s1',5,4096,x'01',1)",
            params![a.addr_key],
        )
        .unwrap();
    s.conn()
        .execute("INSERT INTO sync_cursors (addr_key, since) VALUES (?1, 'c9')", params![a.addr_key])
        .unwrap();
    s.close().unwrap();
}

#[test]
fn encrypted_v1_database_migrates_to_the_current_version_without_losing_data() {
    let dir = TempDir::new().unwrap();
    v1_database_with_data(&dir);
    let s = open_in(&dir);
    assert_eq!(s.schema_version().unwrap(), CURRENT);
    assert_eq!(s.list_addresses().unwrap(), vec![address(1)]);
    assert!(s.list_abandoned_addresses().unwrap().is_empty());
    let messages = s.list_messages(&MessageFilter::default()).unwrap();
    assert_eq!(messages.len(), 1);
    assert!(messages[0].is_read);
    assert_eq!(s.get_message(messages[0].id).unwrap().unwrap().raw, vec![1]);
    assert_eq!(s.get_sync_cursor(&[1; 32]).unwrap().as_deref(), Some("c9"));
    // The new column exists and starts empty. Reopening does not migrate again.
    let column: Option<i64> = s
        .conn()
        .query_row("SELECT abandoned_at FROM addresses", [], |r| r.get(0))
        .unwrap();
    assert_eq!(column, None);
    s.close().unwrap();
    assert_eq!(open_in(&dir).schema_version().unwrap(), CURRENT);
}

#[test]
fn abandon_address_twice_and_missing() {
    let (_d, s) = fresh();
    s.insert_address(&address(1)).unwrap();
    s.insert_address(&address(2)).unwrap();
    assert!(s.abandon_address(&[1; 32], 50).unwrap());
    assert!(!s.abandon_address(&[1; 32], 60).unwrap(), "the second time changes nothing");
    let first: i64 = s
        .conn()
        .query_row("SELECT abandoned_at FROM addresses WHERE addr_key = ?1", [[1u8; 32]], |r| r.get(0))
        .unwrap();
    assert_eq!(first, 50, "keeps the first date");
    assert_eq!(s.abandon_address(&[9; 32], 50), Err(StoreError::NotFound));
    assert_eq!(s.list_addresses().unwrap(), vec![address(2)]);
    assert_eq!(s.list_abandoned_addresses().unwrap(), vec![address(1)]);
    // The row stays: `get_address` sees it and nobody can take its slot or key.
    assert_eq!(s.get_address(&[1; 32]).unwrap(), Some(address(1)));
    let same_slot = Address { addr_key: [8; 32], ..address(1) };
    assert_eq!(s.insert_address(&same_slot), Err(StoreError::Conflict));
}

#[test]
fn restoring_an_abandoned_address_is_no_conflict_and_keeps_it_abandoned() {
    let (_d, s) = fresh();
    let used = recovered_slot(SlotStatus::Used);
    s.reconcile_address(&used, &mailbox_address(1), 50).unwrap();
    s.abandon_address(&[1; 32], 60).unwrap();
    let later = Address { created_at: 999, ..mailbox_address(1) };
    s.reconcile_address(&used, &later, 70).unwrap();
    assert_eq!(s.insert_address(&mailbox_address(1)), Ok(false));
    assert!(s.list_addresses().unwrap().is_empty(), "not reactivated");
    assert_eq!(s.list_abandoned_addresses().unwrap(), vec![mailbox_address(1)]);
    assert!(!s.abandon_address(&[1; 32], 80).unwrap());
}

#[test]
fn messages_of_abandoned_addresses_are_hidden_not_deleted() {
    let (_d, s) = fresh();
    s.insert_address(&address(1)).unwrap();
    s.insert_address(&address(2)).unwrap();
    let hidden = s.insert_message(&message(1, "a", 10)).unwrap().unwrap();
    s.insert_message(&message(2, "b", 20)).unwrap();
    s.insert_message(&message(1, "c", 30)).unwrap();
    assert_eq!(s.list_messages(&MessageFilter::default()).unwrap().len(), 3);
    s.abandon_address(&[1; 32], 40).unwrap();
    let ids = |f: MessageFilter| -> Vec<String> {
        s.list_messages(&f).unwrap().into_iter().map(|m| m.server_id).collect()
    };
    assert_eq!(ids(MessageFilter::default()), vec!["b"]);
    let only_abandoned = MessageFilter { addr_key: Some([1; 32]), ..Default::default() };
    assert!(ids(only_abandoned).is_empty(), "not even when asking for that address");
    let everything = MessageFilter { include_deleted: true, archived: None, ..Default::default() };
    assert_eq!(ids(everything), vec!["b"]);
    // Unread (the UI counts them on this list): only those of active addresses.
    let unread = s.list_messages(&MessageFilter::default()).unwrap().iter().filter(|m| !m.is_read).count();
    assert_eq!(unread, 1);
    // Hidden, not deleted: still stored and still recognised by sync (not downloaded again).
    let stored: i64 = s
        .conn()
        .query_row("SELECT COUNT(*) FROM messages WHERE addr_key = ?1", [[1u8; 32]], |r| r.get(0))
        .unwrap();
    assert_eq!(stored, 2);
    assert_eq!(s.known_server_ids(&[1; 32], &["a".into(), "c".into()]).unwrap().len(), 2);
    // But the app does not see them: they cannot be opened or re-flagged (not even in bulk).
    assert!(s.get_message(hidden).unwrap().is_none());
    let read = MessageFlags { is_read: Some(true), ..Default::default() };
    assert_eq!(s.set_flags(hidden, &read), Err(StoreError::NotFound));
    let visible = s.list_messages(&MessageFilter::default()).unwrap()[0].id;
    assert_eq!(s.set_flags_many(&[visible, hidden], &read), Err(StoreError::NotFound));
    assert!(!s.get_message(visible).unwrap().unwrap().summary.is_read, "all or none");
    s.set_flags(visible, &read).unwrap();
}

#[test]
fn unread_counts_only_active_addresses() {
    let (_d, s) = fresh();
    s.insert_address(&address(1)).unwrap();
    s.insert_address(&address(2)).unwrap();
    s.insert_message(&message(1, "activa", 10)).unwrap();
    s.insert_message(&message(2, "abandonada", 20)).unwrap();
    s.abandon_address(&[2; 32], 30).unwrap();
    // Another one arrives for the abandoned address (a sync round already in progress): it does not count either.
    s.insert_message(&message(2, "tarde", 40)).unwrap();
    let unread = s.list_messages(&MessageFilter::default()).unwrap().iter().filter(|m| !m.is_read).count();
    assert_eq!(unread, 1);
}

#[test]
fn filter_by_an_active_address_works_beside_an_abandoned_one() {
    let (_d, s) = fresh();
    s.insert_address(&address(1)).unwrap();
    s.insert_address(&address(2)).unwrap();
    s.insert_message(&message(1, "a", 10)).unwrap();
    s.insert_message(&message(2, "b", 20)).unwrap();
    s.insert_message(&message(1, "c", 30)).unwrap();
    s.abandon_address(&[2; 32], 40).unwrap();
    let only_active = MessageFilter { addr_key: Some([1; 32]), ..Default::default() };
    let ids: Vec<String> = s.list_messages(&only_active).unwrap().into_iter().map(|m| m.server_id).collect();
    assert_eq!(ids, vec!["c", "a"]);
}

#[test]
fn pagination_skips_hidden_messages() {
    let (_d, s) = fresh();
    s.insert_address(&address(1)).unwrap();
    s.insert_address(&address(2)).unwrap();
    // Interleaved: active at 10, 30, 50 and 70; abandoned at 20, 40 and 60.
    for (i, t) in [10, 20, 30, 40, 50, 60, 70].into_iter().enumerate() {
        let addr = if i % 2 == 0 { 1 } else { 2 };
        s.insert_message(&message(addr, &format!("m{t}"), t)).unwrap();
    }
    s.abandon_address(&[2; 32], 80).unwrap();
    let page = |offset| -> Vec<String> {
        let f = MessageFilter { limit: Some(2), offset, ..Default::default() };
        s.list_messages(&f).unwrap().into_iter().map(|m| m.server_id).collect()
    };
    assert_eq!(page(0), vec!["m70", "m50"]);
    assert_eq!(page(2), vec!["m30", "m10"]);
    assert!(page(4).is_empty());
}

#[test]
fn naming_an_abandoned_mailbox_is_not_found() {
    let (_d, s) = fresh();
    let unnamed = Address { name: None, display: String::new(), ..mailbox_address(1) };
    s.insert_address(&unnamed).unwrap();
    assert!(!s.is_address_abandoned(&[1; 32]).unwrap());
    s.abandon_address(&[1; 32], 10).unwrap();
    assert!(s.is_address_abandoned(&[1; 32]).unwrap());
    assert!(!s.is_address_abandoned(&[9; 32]).unwrap(), "one that does not exist is not");
    assert_eq!(s.set_address_name(&[1; 32], "ana", "ana@d"), Err(StoreError::NotFound));
    assert_eq!(s.list_abandoned_addresses().unwrap(), vec![unnamed], "does not give it a name");
}

// ---------- sent messages (migration v3) ----------

/// A message sent from address `addr`, with Message-ID `[id; 16]`.
fn sent(addr: u8, id: u8, sent_at: i64) -> NewSentMessage {
    NewSentMessage {
        message_id: [id; 16],
        addr_key: [addr; 32],
        from_addr: format!("a{addr}@nightmail.local"),
        to_addr: "destino@nightmail.local".into(),
        subject: format!("asunto {id}"),
        body: zeroize::Zeroizing::new(format!("cuerpo {id}")),
        sent_at,
    }
}

/// Fresh store with active addresses 1 and 2.
fn with_senders() -> (TempDir, LocalStore) {
    let (dir, s) = fresh();
    s.insert_address(&address(1)).unwrap();
    s.insert_address(&address(2)).unwrap();
    (dir, s)
}

fn sent_ids(s: &LocalStore, filter: SentFilter) -> Vec<u8> {
    s.list_sent(&filter).unwrap().iter().map(|m| m.message_id[0]).collect()
}

#[test]
fn sent_insert_is_idempotent_on_the_message_id() {
    let (_d, s) = with_senders();
    let m = sent(1, 1, 10);
    let id = match s.insert_sent(&m).unwrap() {
        SentInsert::New(id) => id,
        other => panic!("expected a new row, got {other:?}"),
    };
    assert_eq!(s.insert_sent(&m).unwrap(), SentInsert::Existing(id));
    // Still the same message once its state has changed.
    s.set_sent_state(id, SentState::Sent).unwrap();
    assert_eq!(s.insert_sent(&m).unwrap(), SentInsert::Existing(id));
    assert_eq!(s.count_sent(None).unwrap(), 1);
    assert_eq!(s.find_sent(&[1; 16]).unwrap(), Some(id));
    assert_eq!(s.find_sent(&[9; 16]).unwrap(), None);
    // The same Message-ID with any other content is a conflict and changes nothing.
    let changes: [fn(&mut NewSentMessage); 6] = [
        |m| m.addr_key = [2; 32],
        |m| m.from_addr = "otra@nightmail.local".into(),
        |m| m.to_addr = "otro@nightmail.local".into(),
        |m| m.subject = "otro".into(),
        |m| m.body = zeroize::Zeroizing::new("otro".into()),
        |m| m.sent_at = 11,
    ];
    for change in changes {
        let mut other = m.clone();
        change(&mut other);
        assert_eq!(s.insert_sent(&other), Err(StoreError::Conflict));
    }
    let stored = s.get_sent(id).unwrap().unwrap();
    assert_eq!((stored.summary.subject.as_str(), stored.body.as_str()), ("asunto 1", "cuerpo 1"));
    assert_eq!(s.count_sent(None).unwrap(), 1);
}

#[test]
fn sent_needs_an_active_sending_address() {
    let (_d, s) = with_senders();
    assert_eq!(s.insert_sent(&sent(9, 1, 10)), Err(StoreError::NotFound));
    s.abandon_address(&[2; 32], 5).unwrap();
    assert_eq!(s.insert_sent(&sent(2, 2, 10)), Err(StoreError::NotFound));
    let rows: i64 = s.conn().query_row("SELECT count(*) FROM sent_messages", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 0);
}

#[test]
fn sent_get_returns_everything_with_the_body() {
    let (_d, s) = with_senders();
    let m = sent(1, 7, 1_700_000_000);
    let id = s.insert_sent(&m).unwrap().id();
    let got = s.get_sent(id).unwrap().unwrap();
    let expected = SentSummary {
        id,
        message_id: m.message_id,
        addr_key: m.addr_key,
        from_addr: m.from_addr.clone(),
        to_addr: m.to_addr.clone(),
        subject: m.subject.clone(),
        sent_at: m.sent_at,
        state: SentState::Queued,
    };
    assert_eq!(got, SentMessage { summary: expected.clone(), body: m.body.clone() });
    assert_eq!(s.list_sent(&SentFilter::default()).unwrap(), vec![expected]);
    assert_eq!(s.get_sent(id + 1).unwrap(), None);
}

#[test]
fn sent_list_is_newest_first_paginated_and_filtered_by_sender() {
    let (_d, s) = with_senders();
    // Inserted out of order; 3 and 4 share their date, so the later id goes first.
    for (addr, id, at) in [(1, 1, 30), (2, 2, 10), (1, 3, 20), (2, 4, 20), (1, 5, 40)] {
        s.insert_sent(&sent(addr, id, at)).unwrap();
    }
    assert_eq!(sent_ids(&s, SentFilter::default()), [5, 1, 4, 3, 2]);
    let page = |limit, offset| sent_ids(&s, SentFilter { limit: Some(limit), offset, ..Default::default() });
    assert_eq!(page(2, 0), [5, 1]);
    assert_eq!(page(2, 2), [4, 3]);
    assert_eq!(page(2, 4), [2]);
    assert!(page(2, 6).is_empty());
    let only = |addr: u8| SentFilter { addr_key: Some([addr; 32]), ..Default::default() };
    assert_eq!(sent_ids(&s, only(1)), [5, 1, 3]);
    assert_eq!(sent_ids(&s, only(2)), [4, 2]);
    assert_eq!(sent_ids(&s, SentFilter { limit: Some(1), offset: 1, ..only(1) }), [1]);
    assert!(sent_ids(&s, only(9)).is_empty());
    assert_eq!(s.count_sent(None).unwrap(), 5);
    assert_eq!(s.count_sent(Some(&[1; 32])).unwrap(), 3);
    assert_eq!(s.count_sent(Some(&[9; 32])).unwrap(), 0);
}

#[test]
fn sent_list_uses_the_indexes() {
    let (_d, s) = with_senders();
    let plan = |sql: &str| -> String {
        let conn = s.conn();
        let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let rows = stmt.query_map([], |r| r.get::<_, String>(3)).unwrap();
        rows.map(|row| row.unwrap()).collect::<Vec<_>>().join(" | ")
    };
    let by_date = plan("SELECT id FROM sent_messages ORDER BY sent_at DESC, id DESC");
    assert!(by_date.contains("sent_messages_by_date"), "{by_date}");
    let by_sender = plan("SELECT id FROM sent_messages WHERE addr_key = x'01' ORDER BY sent_at DESC, id DESC");
    assert!(by_sender.contains("sent_messages_by_sender"), "{by_sender}");
}

#[test]
fn sent_state_matrix() {
    use SentState::*;
    let (f1, f2) = (Failed(SendFailure::Network), Failed(SendFailure::MailboxFull));
    let allowed = [
        (Queued, Queued),
        (Queued, Sent),
        (Queued, f1),
        (Queued, f2),
        (Sent, Sent),
        (f1, f1),
        (f1, f2),
        (f1, Queued),
        (f2, f2),
        (f2, f1),
        (f2, Queued),
    ];
    for from in [Queued, Sent, f1, f2] {
        for to in [Queued, Sent, f1, f2] {
            assert_eq!(from.can_become(to), allowed.contains(&(from, to)), "{from:?} -> {to:?}");
        }
    }
}

#[test]
fn sent_state_changes_follow_the_rules() {
    let (_d, s) = with_senders();
    let id = s.insert_sent(&sent(1, 1, 10)).unwrap().id();
    let state = |s: &LocalStore| s.get_sent(id).unwrap().unwrap().summary.state;
    assert_eq!(state(&s), SentState::Queued);
    s.set_sent_state(id, SentState::Failed(SendFailure::Network)).unwrap();
    assert_eq!(state(&s), SentState::Failed(SendFailure::Network));
    s.set_sent_state(id, SentState::Failed(SendFailure::RateLimited)).unwrap();
    assert_eq!(state(&s), SentState::Failed(SendFailure::RateLimited));
    assert_eq!(s.set_sent_state(id, SentState::Sent), Err(StoreError::InvalidTransition), "retry goes through queued");
    s.set_sent_state(id, SentState::Queued).unwrap();
    s.set_sent_state(id, SentState::Sent).unwrap();
    s.set_sent_state(id, SentState::Sent).unwrap();
    for to in [SentState::Queued, SentState::Failed(SendFailure::Failed)] {
        assert_eq!(s.set_sent_state(id, to), Err(StoreError::InvalidTransition));
    }
    assert_eq!(state(&s), SentState::Sent);
    assert_eq!(s.set_sent_state(id + 1, SentState::Sent), Err(StoreError::NotFound));
}

#[test]
fn every_send_failure_and_status_is_accepted_by_the_schema() {
    let (_d, s) = with_senders();
    for (i, reason) in SendFailure::ALL.iter().enumerate() {
        let id = s.insert_sent(&sent(1, i as u8, 1)).unwrap().id();
        s.set_sent_state(id, SentState::Failed(*reason)).unwrap();
        assert_eq!(s.get_sent(id).unwrap().unwrap().summary.state, SentState::Failed(*reason));
    }
    let conn = s.conn();
    for status in SentStatus::ALL {
        let failure = (*status == SentStatus::Failed).then_some(SendFailure::Failed);
        conn.execute("UPDATE sent_messages SET status = ?1, failure = ?2", params![status, failure]).unwrap();
    }
}

#[test]
fn sent_schema_rejects_bad_rows() {
    let (_d, s) = with_senders();
    let id = s.insert_sent(&sent(1, 1, 10)).unwrap().id();
    let conn = s.conn();
    let insert = |message_id: &str, rest: &str| {
        format!(
            "INSERT INTO sent_messages (message_id, addr_key, from_addr, to_addr, subject, body, sent_at, status, failure)
             VALUES ({message_id}, {rest})"
        )
    };
    let a1 ="x'0101010101010101010101010101010101010101010101010101010101010101'";
    let bad = [
        insert("x'01'", &format!("{a1}, 'a', 'b', 's', 'c', 1, 'queued', NULL")),
        insert("randomblob(16)", "x'01', 'a', 'b', 's', 'c', 1, 'queued', NULL"),
        insert("randomblob(16)", &format!("{a1}, '', 'b', 's', 'c', 1, 'queued', NULL")),
        insert("randomblob(16)", &format!("{a1}, 'a', '', 's', 'c', 1, 'queued', NULL")),
        insert("randomblob(16)", &format!("{a1}, 'a', printf('%.256c', 'x'), 's', 'c', 1, 'queued', NULL")),
        insert("randomblob(16)", &format!("{a1}, 'a', 'b', printf('%.1025c', 'x'), 'c', 1, 'queued', NULL")),
        insert("randomblob(16)", &format!("{a1}, 'a', 'b', 's', 'c', -1, 'queued', NULL")),
        insert("randomblob(16)", &format!("{a1}, 'a', 'b', 's', 'c', 9007199254740992, 'queued', NULL")),
        insert("randomblob(16)", &format!("{a1}, 'a', 'b', 's', 'c', 1, 'raro', NULL")),
        insert("randomblob(16)", &format!("{a1}, 'a', 'b', 's', 'c', 1, 'failed', NULL")),
        insert("randomblob(16)", &format!("{a1}, 'a', 'b', 's', 'c', 1, 'sent', 'network'")),
        insert("randomblob(16)", &format!("{a1}, 'a', 'b', 's', 'c', 1, 'failed', 'raro'")),
        insert("randomblob(16)", &format!("{a1}, 'a', 'b', 's', x'00', 1, 'queued', NULL")),
        // Unknown sending address (foreign key).
        insert("randomblob(16)", &format!("x'{}', 'a', 'b', 's', 'c', 1, 'queued', NULL", "09".repeat(32))),
    ];
    for sql in &bad {
        assert!(conn.execute(sql, []).is_err(), "should reject: {sql}");
    }
    // The base row of those cases is valid; an update is checked too (body must stay text).
    conn.execute(&insert("randomblob(16)", &format!("{a1}, 'a', 'b', 's', 'c', 1, 'queued', NULL")), []).unwrap();
    assert!(conn.execute(&format!("UPDATE sent_messages SET body = zeroblob(10) WHERE id = {id}"), []).is_err());
    let at_limit = format!("UPDATE sent_messages SET body = printf('%.{MAX_SENT_BODY_LENGTH}c', 'x') WHERE id = {id}");
    conn.execute(&at_limit, []).unwrap();
    let over = format!("UPDATE sent_messages SET body = body || 'x' WHERE id = {id}");
    assert!(conn.execute(&over, []).is_err());
}

#[test]
fn sent_limits_are_checked_before_writing() {
    let (_d, s) = with_senders();
    let long = |n: usize| "x".repeat(n);
    let mut at_limit = sent(1, 1, MAX_SENT_AT);
    at_limit.from_addr = long(MAX_SENT_ADDRESS_LENGTH);
    at_limit.to_addr = long(MAX_SENT_ADDRESS_LENGTH);
    at_limit.subject = long(MAX_SENT_SUBJECT_LENGTH);
    at_limit.body = zeroize::Zeroizing::new(long(MAX_SENT_BODY_LENGTH));
    let id = s.insert_sent(&at_limit).unwrap().id();
    assert_eq!(s.get_sent(id).unwrap().unwrap().body.len(), MAX_SENT_BODY_LENGTH);
    let mut empty = sent(1, 2, 0);
    empty.subject.clear();
    empty.body = zeroize::Zeroizing::new(String::new());
    s.insert_sent(&empty).unwrap();
    // Limits count bytes, not characters.
    let mut multibyte = sent(1, 3, 1);
    multibyte.subject = "ñ".repeat(MAX_SENT_SUBJECT_LENGTH / 2 + 1);
    let over: [fn(&mut NewSentMessage); 8] = [
        |m| m.from_addr.clear(),
        |m| m.to_addr.clear(),
        |m| m.from_addr = "x".repeat(MAX_SENT_ADDRESS_LENGTH + 1),
        |m| m.to_addr = "x".repeat(MAX_SENT_ADDRESS_LENGTH + 1),
        |m| m.subject = "x".repeat(MAX_SENT_SUBJECT_LENGTH + 1),
        |m| m.body = zeroize::Zeroizing::new("x".repeat(MAX_SENT_BODY_LENGTH + 1)),
        |m| m.sent_at = -1,
        |m| m.sent_at = MAX_SENT_AT + 1,
    ];
    for change in over {
        let mut m = sent(1, 4, 1);
        change(&mut m);
        assert_eq!(s.insert_sent(&m), Err(StoreError::OutOfRange));
    }
    assert_eq!(s.insert_sent(&multibyte), Err(StoreError::OutOfRange));
    assert_eq!(s.count_sent(None).unwrap(), 2);
}

#[test]
fn sent_delete_removes_only_that_message() {
    let (_d, s) = with_senders();
    let first = s.insert_sent(&sent(1, 1, 10)).unwrap().id();
    let second = s.insert_sent(&sent(1, 2, 20)).unwrap().id();
    s.delete_sent(first).unwrap();
    assert_eq!(s.get_sent(first).unwrap(), None);
    assert_eq!(s.find_sent(&[1; 16]).unwrap(), None);
    assert_eq!(s.delete_sent(first), Err(StoreError::NotFound));
    assert_eq!(s.set_sent_state(first, SentState::Sent), Err(StoreError::NotFound));
    assert_eq!(sent_ids(&s, SentFilter::default()), [2]);
    assert_eq!(s.count_sent(None).unwrap(), 1);
    assert!(s.get_sent(second).unwrap().is_some());
    // Deleted for real: the same Message-ID can be saved again as a new row.
    assert!(matches!(s.insert_sent(&sent(1, 1, 10)).unwrap(), SentInsert::New(_)));
}

#[test]
fn sent_of_an_abandoned_address_is_hidden_not_deleted() {
    let (_d, s) = with_senders();
    let hidden = s.insert_sent(&sent(1, 1, 10)).unwrap().id();
    s.insert_sent(&sent(2, 2, 20)).unwrap();
    s.abandon_address(&[1; 32], 30).unwrap();
    assert_eq!(sent_ids(&s, SentFilter::default()), [2]);
    assert!(sent_ids(&s, SentFilter { addr_key: Some([1; 32]), ..Default::default() }).is_empty());
    assert_eq!(s.count_sent(None).unwrap(), 1);
    assert_eq!(s.count_sent(Some(&[1; 32])).unwrap(), 0);
    assert_eq!(s.get_sent(hidden).unwrap(), None);
    assert_eq!(s.find_sent(&[1; 16]).unwrap(), None);
    assert_eq!(s.set_sent_state(hidden, SentState::Sent), Err(StoreError::NotFound));
    assert_eq!(s.delete_sent(hidden), Err(StoreError::NotFound));
    let rows: i64 = s.conn().query_row("SELECT count(*) FROM sent_messages", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 2, "kept in the file");
    // Removing the address row itself cascades, as for received mail.
    s.conn().execute("DELETE FROM addresses WHERE addr_key = ?1", [[1u8; 32]]).unwrap();
    let rows: i64 = s.conn().query_row("SELECT count(*) FROM sent_messages", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 1);
}

#[test]
fn sent_is_encrypted_on_disk_and_a_wrong_key_reveals_nothing() {
    let (dir, s) = with_senders();
    let mut m = sent(1, 1, 10);
    m.subject = "ASUNTO-ENVIADO-RECONOCIBLE".into();
    m.body = zeroize::Zeroizing::new("CUERPO-ENVIADO-RECONOCIBLE".into());
    m.to_addr = "DESTINO-RECONOCIBLE@nightmail.local".into();
    s.insert_sent(&m).unwrap();
    let wal = std::fs::read(dir.path().join("sub").join("nightmail.db-wal")).unwrap();
    s.close().unwrap();
    let file = std::fs::read(db_path(&dir)).unwrap();
    for bytes in [&wal, &file] {
        for secret in [&b"ASUNTO-ENVIADO"[..], b"CUERPO-ENVIADO", b"DESTINO-RECONOCIBLE", &[1; 16]] {
            assert!(!bytes.windows(secret.len()).any(|w| w == secret));
        }
    }
    let err = LocalStore::open(&db_path(&dir), &[8; 32], &scope()).err();
    assert_eq!(err, Some(StoreError::WrongKey));
    assert_eq!(err.unwrap().to_string(), "wrong database key", "the error carries no data");
    assert_eq!(std::fs::read(db_path(&dir)).unwrap(), file, "a wrong key changes nothing");
    let again = open_in(&dir);
    assert_eq!(again.count_sent(None).unwrap(), 1);
}

#[test]
fn sent_debug_hides_personal_data() {
    let mut m = sent(1, 0xAB, 10);
    m.subject = "ASUNTO-PRIVADO".into();
    m.body = zeroize::Zeroizing::new("CUERPO-PRIVADO".into());
    let summary = SentSummary {
        id: 1,
        message_id: m.message_id,
        addr_key: m.addr_key,
        from_addr: m.from_addr.clone(),
        to_addr: m.to_addr.clone(),
        subject: m.subject.clone(),
        sent_at: m.sent_at,
        state: SentState::Failed(SendFailure::Network),
    };
    let full = SentMessage { summary: summary.clone(), body: m.body.clone() };
    let filter = SentFilter { addr_key: Some([0xCD; 32]), limit: Some(5), offset: 0 };
    let shown = format!("{m:?} {summary:?} {full:?} {filter:?}");
    for secret in ["nightmail.local", "ASUNTO", "CUERPO", "171", "205", "ab", "cd"] {
        assert!(!shown.contains(secret), "Debug leaks {secret}: {shown}");
    }
    assert!(shown.contains("Network"), "the state is not personal data: {shown}");
}

/// Creates, through the real `open` path but without migration v3, a v2 database with an address, a message and a
/// cursor.
fn v2_database_with_data(dir: &TempDir) {
    let s = LocalStore::open_with_migrations(&db_path(dir), &KEY, &scope(), &schema::MIGRATIONS[..2]).unwrap();
    assert_eq!(s.schema_version().unwrap(), 2);
    s.insert_address(&address(1)).unwrap();
    s.insert_address(&address(2)).unwrap();
    s.abandon_address(&[2; 32], 7).unwrap();
    s.insert_message(&message(1, "s1", 5)).unwrap();
    s.set_sync_cursor(&[1; 32], "c9").unwrap();
    assert!(s.conn().prepare("SELECT id FROM sent_messages").is_err(), "v2 has no sent table");
    s.close().unwrap();
}

#[test]
fn encrypted_v2_database_migrates_to_v3_without_losing_data() {
    let dir = TempDir::new().unwrap();
    v2_database_with_data(&dir);
    let s = open_in(&dir);
    assert_eq!(s.schema_version().unwrap(), CURRENT);
    assert_eq!(s.list_addresses().unwrap(), vec![address(1)]);
    assert_eq!(s.list_abandoned_addresses().unwrap(), vec![address(2)]);
    let messages = s.list_messages(&MessageFilter::default()).unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(s.get_message(messages[0].id).unwrap().unwrap().raw, message(1, "s1", 5).raw);
    assert_eq!(s.get_sync_cursor(&[1; 32]).unwrap().as_deref(), Some("c9"));
    // The new table starts empty and works.
    assert_eq!(s.count_sent(None).unwrap(), 0);
    let id = s.insert_sent(&sent(1, 1, 10)).unwrap().id();
    s.close().unwrap();
    let again = open_in(&dir);
    assert_eq!(again.schema_version().unwrap(), CURRENT);
    assert_eq!(again.get_sent(id).unwrap().unwrap().body.as_str(), "cuerpo 1");
}

#[test]
fn a_failed_v3_migration_leaves_the_v2_database_untouched() {
    let dir = TempDir::new().unwrap();
    v2_database_with_data(&dir);
    let broken = [schema::MIGRATIONS[0], schema::MIGRATIONS[1], "CREATE TABLE sent_messages (x); ESTO NO ES SQL;"];
    let err = LocalStore::open_with_migrations(&db_path(&dir), &KEY, &scope(), &broken).err();
    assert_eq!(err, Some(StoreError::Db));
    let s = LocalStore::open_with_migrations(&db_path(&dir), &KEY, &scope(), &schema::MIGRATIONS[..2]).unwrap();
    assert_eq!(s.schema_version().unwrap(), 2);
    assert!(s.conn().prepare("SELECT x FROM sent_messages").is_err(), "the half migration must not remain");
    s.close().unwrap();
    assert_eq!(open_in(&dir).schema_version().unwrap(), CURRENT);
}

// ---------- one-step mailboxes (migration v5) ----------

#[test]
fn migration_v5_burns_the_two_step_reservations() {
    let dir = TempDir::new().unwrap();
    {
        let s = LocalStore::open_with_migrations(&db_path(&dir), &KEY, &scope(), &schema::MIGRATIONS[..4]).unwrap();
        assert_eq!(s.schema_version().unwrap(), 4);
        let insert = "INSERT INTO slots (n, kind, j, slot_nul, status, addr_key, round, pending_name, reserve_attempts, \
                      reveal_attempts, updated_at) VALUES (1, 'mailbox', ?1, ?2, ?3, NULL, 7, ?4, 1, ?5, 1)";
        s.conn().execute(insert, params![0, [1u8; 32], "reserved", Option::<String>::None, 0]).unwrap();
        s.conn().execute(insert, params![1, [2u8; 32], "revealing", Some("juan"), 1]).unwrap();
        s.conn().execute(insert, params![2, [3u8; 32], "reserving", Some("ana"), 0]).unwrap();
    }
    let s = open_in(&dir);
    assert_eq!(s.schema_version().unwrap(), CURRENT);
    let slots = s.list_slots(1).unwrap();
    let got: Vec<(u32, SlotStatus, Option<String>)> =
        slots.into_iter().map(|x| (x.key.j, x.status, x.pending_name)).collect();
    assert_eq!(
        got,
        [
            (0, SlotStatus::Burned, None),
            (1, SlotStatus::Burned, None),
            (2, SlotStatus::Reserving, Some("ana".into())),
        ]
    );
}
