//! End-to-end mail through sync: the registry lookup, its retries, deduplication, and SMTP mail left as it was. The
//! last test replays the shared vectors (`packages/test-vectors/crypto/e2e-mail.json`) through the whole path.

use std::sync::Arc;

use serde_json::Value;
use tempfile::TempDir;

use super::tests::{NO_PACE, QUICK};
use super::*;
use crate::crypto::random_bytes;
use crate::crypto::test_vectors::{array, bytes, items, load, text};
use crate::mail::fake_mailbox::{FakeMailbox, TestBox};
use crate::mail::inbox::tests::{FakeDirectory, TestSender};
use crate::mail::parser::tests::plain;
use crate::mail::test_server::TestServer;
use crate::store::{Address, MessageFilter, MessageFlags, MessageSummary, SlotKind, StoreScope};
use crate::transport::{Transport, TransportConfig};

struct Fixture {
    _dir: TempDir,
    store: Arc<LocalStore>,
    fake: Arc<FakeMailbox>,
    server: TestServer,
    sync: MailSync,
    tb: TestBox,
    /// Our address as text.
    me: String,
    directory: FakeDirectory,
}

/// One address of ours, `me`, with the keys of `tb`, on a fake mailbox server.
async fn fixture_for(tb: TestBox, me: &str, config: SyncConfig) -> Fixture {
    let dir = TempDir::new().unwrap();
    let scope = StoreScope { network: "devnet".into(), contract: "c1".into() };
    let store = Arc::new(LocalStore::open(&dir.path().join("db"), &[3; 32], &scope).unwrap());
    let (fake, server) = FakeMailbox::serve(0).await;
    fake.add_box(&tb);
    let kind = SlotKind::Mailbox;
    let address = Address { addr_key: tb.addr_key, kind, n: 0, j: 0, display: me.into(), name: None, created_at: 1 };
    store.insert_address(&address).unwrap();
    let sync = MailSync::new(client_for(&server), store.clone(), config);
    Fixture { _dir: dir, store, fake, server, sync, tb, me: me.into(), directory: FakeDirectory::default() }
}

fn client_for(server: &TestServer) -> MailboxClient {
    let transport = Arc::new(Transport::direct(&TransportConfig::default()).unwrap());
    MailboxClient::new(transport, server.base.clone(), NO_PACE)
}

async fn fixture(config: SyncConfig) -> Fixture {
    fixture_for(TestBox::new(1), "juan@nightmail.local", config).await
}

impl Fixture {
    fn targets(&self) -> Vec<SyncTarget> {
        vec![SyncTarget { addr_key: self.tb.addr_key, address: self.me.clone(), keys: self.tb.keys() }]
    }

    async fn run(&self) -> SyncReport {
        self.sync.sync_all(&self.targets(), &self.directory).await.unwrap()
    }

    /// A round of another app session on the same store.
    async fn run_new_session(&self) -> SyncReport {
        let next = MailSync::new(client_for(&self.server), self.store.clone(), self.sync.config);
        next.sync_all(&self.targets(), &self.directory).await.unwrap()
    }

    fn me(&self) -> ([u8; 32], &str) {
        (self.tb.addr_key, &self.me)
    }

    /// Seals `plaintext` to our address and delivers it.
    fn deliver(&self, plaintext: &[u8]) -> String {
        self.fake.deliver(&self.tb, plaintext)
    }

    fn messages(&self) -> Vec<MessageSummary> {
        let filter = MessageFilter { include_deleted: true, ..MessageFilter::default() };
        self.store.list_messages(&filter).unwrap()
    }

    fn downloads(&self) -> usize {
        self.server.requests().iter().filter(|r| r.target.contains("/messages/")).count()
    }

    fn pending(&self) -> usize {
        self.store.due_e2e_pending(&self.tb.addr_key, i64::MAX, u32::MAX).unwrap().len()
    }

    fn cursor(&self) -> Option<String> {
        self.store.get_sync_cursor(&self.tb.addr_key).unwrap()
    }
}

fn ana() -> TestSender {
    TestSender::new(2, "ana@nightmail.local")
}

fn verdicts(f: &Fixture) -> Vec<(bool, bool)> {
    f.messages().iter().map(|m| (m.e2e, m.sender_verified)).collect()
}

#[tokio::test]
async fn a_verified_mail_is_stored_with_its_verdict_and_counts_as_new() {
    let f = fixture(QUICK).await;
    let sender = ana();
    sender.register(&f.directory);
    f.deliver(&sender.sign([1; 16], f.me(), "Hola", "Primer correo"));
    assert_eq!(f.run().await, SyncReport { stored: 1, ..SyncReport::default() }, "backlog: not new mail");
    let message = &f.messages()[0];
    assert!(message.e2e && message.sender_verified);
    assert_eq!(message.parsed.from_addr.as_deref(), Some("<ana@nightmail.local>"));
    assert_eq!(message.parsed.subject.as_deref(), Some("Hola"));
    assert_eq!(message.parsed.sent_at, Some(message.received_at), "dated by its arrival");
    // Caught up: what arrives now is new mail.
    f.deliver(&sender.sign([2; 16], f.me(), "Otra", "Segundo"));
    assert_eq!(f.run().await, SyncReport { stored: 1, fresh: 1, ..SyncReport::default() });
}

#[tokio::test]
async fn mail_that_does_not_check_out_is_stored_unverified() {
    let f = fixture(QUICK).await;
    let sender = ana();
    sender.register(&f.directory);
    let impostor = TestSender::new(3, "eva@nightmail.local");
    f.directory.register(impostor.addr_key, &impostor.address, sender.auth_public());
    f.deliver(&TestSender::new(4, "ana@gmail.com").sign([1; 16], f.me(), "otro dominio", "x"));
    f.deliver(&TestSender::new(5, "nadie@nightmail.local").sign([2; 16], f.me(), "no registrado", "x"));
    f.deliver(&impostor.sign([3; 16], f.me(), "firma mala", "x"));
    f.deliver(&sender.sign([4; 16], ([9; 32], "otro@nightmail.local"), "para otro", "x"));
    assert_eq!(f.run().await.stored, 4);
    assert_eq!(verdicts(&f), [(true, false); 4]);
}

#[tokio::test]
async fn without_the_registry_the_mail_waits_and_is_stored_on_the_next_round() {
    let f = fixture(QUICK).await;
    let sender = ana();
    sender.register(&f.directory);
    f.directory.fail_next(1);
    f.deliver(&sender.sign([1; 16], f.me(), "Hola", "x"));
    f.deliver(plain("smtp", "después").as_bytes());
    let first = f.run().await;
    // The SMTP mail behind it is not held up, nor is the cursor; the e2e mail is not marked unverified.
    assert_eq!((first.stored, first.skipped, first.failed), (1, 0, 0));
    assert_eq!((f.pending(), f.cursor().as_deref()), (1, Some("2")));
    assert_eq!(verdicts(&f), [(false, false)]);
    let second = f.run().await;
    assert_eq!((second.stored, second.fresh), (1, 1));
    assert_eq!(f.pending(), 0);
    let mut verdicts = verdicts(&f);
    verdicts.sort();
    assert_eq!(verdicts, [(false, false), (true, true)]);
    // Kept, not downloaded again.
    assert_eq!(f.downloads(), 2);
    assert_eq!(f.directory.lookups(), 2);
}

#[tokio::test]
async fn sender_lookups_back_off_and_stop_until_the_next_session() {
    let config = SyncConfig { sender_max_attempts: 3, ..QUICK };
    let f = fixture(config).await;
    let sender = ana();
    sender.register(&f.directory);
    f.directory.fail_next(u32::MAX);
    f.deliver(&sender.sign([1; 16], f.me(), "Hola", "x"));
    f.deliver(&sender.sign([2; 16], f.me(), "Adiós", "x"));
    f.run().await;
    // Once the registry did not answer, the round does not ask again: the second mail waits without a lookup.
    assert_eq!((f.directory.lookups(), f.pending()), (1, 2));
    // Each later round tries the oldest one due, and stops at the first failure.
    f.run().await;
    assert_eq!(f.directory.lookups(), 2);
    for _ in 0..6 {
        f.run().await;
    }
    // Three tries each in this session (the second mail's first one was its arrival).
    assert_eq!(f.directory.lookups(), 5);
    assert_eq!((f.pending(), f.messages().len()), (2, 0));
    // A later session tries again; now the registry answers.
    f.directory.fail_next(0);
    assert_eq!(f.run_new_session().await.stored, 2);
    assert_eq!(verdicts(&f), [(true, true); 2]);
    assert_eq!(f.downloads(), 2);
}

#[tokio::test]
async fn a_backoff_waits_before_the_next_lookup() {
    let hour = Duration::from_secs(3600);
    let config = SyncConfig { sender_retry_base: hour, sender_retry_cap: hour, ..QUICK };
    let f = fixture(config).await;
    let sender = ana();
    sender.register(&f.directory);
    f.directory.fail_next(1);
    f.deliver(&sender.sign([1; 16], f.me(), "Hola", "x"));
    f.run().await;
    f.run().await;
    assert_eq!((f.directory.lookups(), f.pending()), (1, 1), "not due for an hour");
    assert_eq!(f.run_new_session().await.stored, 1, "a new session does not wait");
}

#[tokio::test]
async fn a_redelivered_mail_is_stored_once_and_not_downloaded_again() {
    let f = fixture(QUICK).await;
    let sender = ana();
    sender.register(&f.directory);
    let mail = sender.sign([1; 16], f.me(), "Hola", "x");
    f.deliver(&mail);
    f.deliver(&mail);
    assert_eq!(f.run().await.stored, 1);
    assert_eq!(verdicts(&f), [(true, true)]);
    f.run_new_session().await;
    assert_eq!(f.downloads(), 2, "the dropped copy is not downloaded again when relisting");
}

#[tokio::test]
async fn an_unverified_copy_never_blocks_the_verified_mail() {
    let f = fixture(QUICK).await;
    let sender = ana();
    sender.register(&f.directory);
    // Someone else claims to be Ana, with her mail's id, before and after the real one.
    let forger = TestSender { seed: random_bytes(), addr_key: sender.addr_key, address: sender.address.clone() };
    f.deliver(&forger.sign([1; 16], f.me(), "falso", "x"));
    f.run().await;
    assert_eq!(verdicts(&f), [(true, false)]);
    f.deliver(&sender.sign([1; 16], f.me(), "real", "x"));
    f.deliver(&forger.sign([1; 16], f.me(), "falso otra vez", "x"));
    f.run().await;
    let messages = f.messages();
    assert_eq!(messages.len(), 1);
    assert!(messages[0].sender_verified);
    assert_eq!(messages[0].parsed.subject.as_deref(), Some("real"));
}

#[tokio::test]
async fn a_deleted_mail_is_not_brought_back() {
    let f = fixture(QUICK).await;
    let sender = ana();
    sender.register(&f.directory);
    let mail = sender.sign([1; 16], f.me(), "Hola", "x");
    f.deliver(&mail);
    f.run().await;
    let id = f.messages()[0].id;
    f.store.set_flags(id, &MessageFlags { deleted: Some(true), ..MessageFlags::default() }).unwrap();
    f.deliver(&mail);
    assert_eq!(f.run().await.stored, 0);
    let messages = f.messages();
    assert_eq!((messages.len(), messages[0].deleted), (1, true));
}

#[tokio::test]
async fn smtp_mail_and_marked_text_that_is_no_e2e_mail_go_the_mime_way() {
    let f = fixture(QUICK).await;
    f.deliver(plain("normal", "hola").as_bytes());
    // An SMTP message may begin with the marker (anyone can send that): it is still a MIME message.
    f.deliver(b"nightmail:e2e is a header too\r\nSubject: marcado\r\n\r\ncuerpo");
    // A version this app does not know, and a damaged v1 mail: no MIME message either (the parser would still make an
    // empty one out of them).
    let mut newer = ana().sign([1; 16], f.me(), "Hola", "x");
    newer[13] = 2;
    let newer_id = f.deliver(&newer);
    let mut damaged = ana().sign([2; 16], f.me(), "Hola", "x");
    damaged.truncate(damaged.len() - 1);
    let damaged_id = f.deliver(&damaged);
    let report = f.run().await;
    assert_eq!(f.directory.lookups(), 0, "none of them is an e2e mail");
    assert_eq!((report.stored, report.skipped), (2, 2));
    let mut subjects: Vec<_> = f.messages().into_iter().map(|m| (m.parsed.subject, m.e2e)).collect();
    subjects.sort();
    assert_eq!(subjects, [(Some("marcado".into()), false), (Some("normal".into()), false)]);
    for id in [&newer_id, &damaged_id] {
        assert_eq!(f.store.skip_reason(&f.tb.addr_key, id).unwrap(), Some(SkipReason::Unparseable));
    }
    // Not final: the next session's relisting downloads them again, for an app that can read them.
    let downloads = f.downloads();
    f.run_new_session().await;
    assert_eq!(f.downloads(), downloads + 2);
}

/// `recipient` (`addrKey` and address) as our address, with the vectors' recipient key, and the vectors' directory as
/// the registry.
async fn vectors_fixture(vectors: &Value, recipient: &Value) -> Fixture {
    let tb = TestBox {
        addr_key: array(&recipient["addrKey"]),
        enc_secret: array(&vectors["recipient"]["encSecretKey"]),
        auth_seed: random_bytes(),
    };
    let f = fixture_for(tb, text(&recipient["address"]), QUICK).await;
    for entry in items(&vectors["directory"]) {
        f.directory.register(array(&entry["addrKey"]), text(&entry["address"]), array(&entry["authPublicKey"]));
    }
    f
}

#[tokio::test]
async fn the_shared_vectors_open_and_verify_through_sync() {
    let vectors = load("e2e-mail.json");
    // Each valid mail (as the TypeScript side sealed it) in its own mailbox: they share sender and id, so one store
    // would keep only the first.
    for case in items(&vectors["valid"]).iter().filter(|case| case.get("envelope").is_some()) {
        let f = vectors_fixture(&vectors, &case["mail"]["recipient"]).await;
        f.fake.deliver_envelope(&f.tb, bytes(&case["envelope"]));
        assert_eq!(f.run().await.stored, 1, "{}", text(&case["name"]));
        let message = &f.messages()[0];
        let mail = &case["mail"];
        assert!(message.e2e && message.sender_verified, "{}", text(&case["name"]));
        assert_eq!(message.parsed.from_addr, Some(format!("<{}>", text(&mail["sender"]["address"]))));
        let full = f.store.get_message(message.id).unwrap().unwrap();
        let parsed = crate::mail::parser::parse(&full.raw).unwrap();
        assert_eq!(parsed.text.as_deref().unwrap_or_default(), text(&mail["body"]), "{}", text(&case["name"]));
    }
    // Every unverified one in one mailbox: none blocks another, though several claim the same sender and id.
    let f = vectors_fixture(&vectors, &vectors["recipient"]).await;
    for case in items(&vectors["unverified"]) {
        f.deliver(&bytes(&case["plaintext"]));
    }
    let count = items(&vectors["unverified"]).len();
    assert_eq!(f.run().await.stored, count);
    assert_eq!(verdicts(&f), vec![(true, false); count]);
    // A sender key with a small-order component: each vector says whether it verifies.
    for case in items(&vectors["mixedOrderKey"]) {
        let f = vectors_fixture(&vectors, &case["mail"]["recipient"]).await;
        f.deliver(&bytes(&case["plaintext"]));
        assert_eq!(f.run().await.stored, 1);
        assert_eq!(verdicts(&f), [(true, case["senderVerified"].as_bool().unwrap())], "{}", text(&case["name"]));
    }
}
