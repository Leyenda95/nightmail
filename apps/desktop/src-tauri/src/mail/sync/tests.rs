use std::sync::Arc;
use std::time::Duration;

use tempfile::TempDir;

use super::*;
use crate::mail::client::ClientConfig;
use crate::mail::fake_mailbox::{FakeMailbox, TestBox};
use crate::mail::inbox::tests::NoRegistry;
use crate::mail::parser::tests::{MULTIPART, plain};
use crate::mail::test_server::Reply;
use crate::mail::test_server::TestServer;
use crate::store::{Address, MessageFilter, ParsedFields, SlotKind, StoreScope};
use crate::transport::{BaseUrl, Transport, TransportConfig};

pub(super) const QUICK: SyncConfig = SyncConfig {
    pause_min: Duration::ZERO,
    pause_max: Duration::ZERO,
    max_pages: 20,
    backoff_base: Duration::from_secs(60),
    backoff_cap: Duration::from_secs(600),
    max_attempts: 5,
    attempt_spacing: Duration::ZERO,
    max_pending_in_a_row: 3,
    round_budget: 256 << 20,
    round_timeout: Duration::from_secs(60),
    sender_retry_base: Duration::ZERO,
    sender_retry_cap: Duration::ZERO,
    sender_max_attempts: 3,
};

pub(super) const NO_PACE: ClientConfig = ClientConfig {
    busy_retries: 3,
    busy_max_wait: Duration::from_secs(5),
    pace: Duration::ZERO,
    pace_jitter: Duration::ZERO,
};

struct Fixture {
    _dir: TempDir,
    store: Arc<LocalStore>,
    fake: Arc<FakeMailbox>,
    server: TestServer,
    sync: MailSync,
    boxes: Vec<TestBox>,
}

fn address(tb: &TestBox) -> Address {
    Address {
        addr_key: tb.addr_key,
        kind: SlotKind::Alias,
        n: 0,
        j: u32::from(tb.addr_key[0]),
        display: format!("a{}@nightmail.local", tb.addr_key[0]),
        name: None,
        created_at: 1,
    }
}

/// Fake mailbox with `count` addresses (registered on the server and in the store).
async fn fixture_with(count: u8, config: SyncConfig, client: ClientConfig) -> Fixture {
    let dir = TempDir::new().unwrap();
    let scope = StoreScope { network: "devnet".into(), contract: "c1".into() };
    let store = Arc::new(LocalStore::open(&dir.path().join("db"), &[3; 32], &scope).unwrap());
    let (fake, server) = FakeMailbox::serve(0).await;
    let boxes: Vec<_> = (1..=count).map(TestBox::new).collect();
    for tb in &boxes {
        fake.add_box(tb);
        store.insert_address(&address(tb)).unwrap();
    }
    let transport = Arc::new(Transport::direct(&TransportConfig::default()).unwrap());
    let client = MailboxClient::new(transport, server.base.clone(), client);
    let sync = MailSync::new(client, store.clone(), config);
    Fixture { _dir: dir, store, fake, server, sync, boxes }
}

async fn fixture(count: u8, config: SyncConfig) -> Fixture {
    fixture_with(count, config, NO_PACE).await
}

impl Fixture {
    fn targets(&self) -> Vec<SyncTarget> {
        let target = |tb: &TestBox| SyncTarget { addr_key: tb.addr_key, address: address(tb).display, keys: tb.keys() };
        self.boxes.iter().map(target).collect()
    }

    async fn run(&self) -> SyncReport {
        self.sync.sync_all(&self.targets(), &NoRegistry).await.unwrap()
    }

    fn cursor(&self, tb: &TestBox) -> Option<String> {
        self.store.get_sync_cursor(&tb.addr_key).unwrap()
    }

    fn subjects(&self, tb: &TestBox) -> Vec<String> {
        let filter = MessageFilter { addr_key: Some(tb.addr_key), ..MessageFilter::default() };
        let mut subjects: Vec<_> =
            self.store.list_messages(&filter).unwrap().into_iter().filter_map(|m| m.parsed.subject).collect();
        subjects.sort();
        subjects
    }

    fn downloads(&self) -> usize {
        self.server.requests().iter().filter(|r| r.target.contains("/messages/")).count()
    }

    fn skip_reason(&self, tb: &TestBox, id: &str) -> Option<SkipReason> {
        self.store.skip_reason(&tb.addr_key, id).unwrap()
    }

    /// Another app session (another `MailSync`) on the same store, against `base`.
    fn sync_for(&self, base: &BaseUrl, config: SyncConfig) -> MailSync {
        let transport = Arc::new(Transport::direct(&TransportConfig::default()).unwrap());
        MailSync::new(MailboxClient::new(transport, base.clone(), NO_PACE), self.store.clone(), config)
    }

    fn break_message(&self, id: &str, status: u16) {
        self.fake.set(|s| {
            s.broken.insert(id.to_owned(), status);
        });
    }

    /// `count` messages `m0`, `m1`… for the first address.
    fn deliver_many(&self, count: usize) -> Vec<String> {
        (0..count).map(|i| self.fake.deliver(&self.boxes[0], plain(&format!("m{i:02}"), "x").as_bytes())).collect()
    }
}

fn report(stored: usize, skipped: usize, failed: usize, deferred: usize) -> SyncReport {
    SyncReport { stored, skipped, failed, deferred, ..SyncReport::default() }
}

#[tokio::test]
async fn stores_parsed_messages_of_each_address_and_advances_the_cursor() {
    let f = fixture(2, QUICK).await;
    let (a, b) = (&f.boxes[0], &f.boxes[1]);
    f.fake.deliver(a, MULTIPART.as_bytes());
    f.fake.deliver(a, plain("segundo", "hola").as_bytes());
    f.fake.deliver(b, plain("para b", "adiós").as_bytes());
    assert_eq!(f.run().await, report(3, 0, 0, 0));
    assert_eq!(f.subjects(a), ["Reunión del miércoles", "segundo"]);
    assert_eq!(f.subjects(b), ["para b"]);
    assert_eq!((f.cursor(a).as_deref(), f.cursor(b).as_deref()), (Some("2"), Some("1")));
    let stored = f.store.list_messages(&MessageFilter::default()).unwrap();
    let full = f.store.get_message(stored.iter().find(|m| m.addr_key == b.addr_key).unwrap().id).unwrap().unwrap();
    assert_eq!(full.raw, plain("para b", "adiós").as_bytes());
    assert_eq!((full.summary.size_bucket, full.summary.received_at), (4096, 0));
    assert_eq!(full.summary.parsed.preview.as_deref(), Some("adiós"));
}

#[tokio::test]
async fn every_request_has_its_own_connection_and_every_address_its_own_time() {
    let f = fixture(2, QUICK).await;
    f.fake.deliver(&f.boxes[0], b"Subject: x\r\n\r\ny");
    f.run().await;
    assert_eq!(f.server.connection_count(), f.server.requests().len());
    assert_eq!(f.server.requests().iter().filter(|r| r.target == "/v1/time").count(), 2);
}

#[tokio::test]
async fn stored_messages_are_never_downloaded_again() {
    let f = fixture(1, QUICK).await;
    let a = &f.boxes[0];
    f.deliver_many(3);
    assert_eq!(f.run().await.stored, 3);
    assert_eq!(f.run().await, report(0, 0, 0, 0));
    f.store.reset_sync_cursor(&a.addr_key).unwrap();
    assert_eq!(f.run().await, report(0, 0, 0, 0));
    assert_eq!(f.downloads(), 3, "neither through the cursor nor when relisting");
    assert_eq!(f.cursor(a).as_deref(), Some("3"));
}

#[tokio::test]
async fn the_client_keeps_under_the_server_rate_limit() {
    let pace = ClientConfig { pace: Duration::from_millis(150), ..NO_PACE };
    let f = fixture_with(1, QUICK, pace).await;
    f.fake.set(|s| (s.rate_limit, s.retry_after) = (Some((10, Duration::from_secs(1))), 60));
    f.deliver_many(12);
    assert_eq!(f.run().await, report(12, 0, 0, 0));
    assert_eq!(f.downloads(), 12);
}

#[tokio::test]
async fn long_429_defers_the_address_keeping_its_progress() {
    let f = fixture(1, QUICK).await;
    let a = &f.boxes[0];
    f.fake.set(|s| (s.rate_limit, s.retry_after) = (Some((5, Duration::from_secs(60))), 60));
    f.deliver_many(12);
    assert_eq!(f.run().await, report(4, 0, 1, 0));
    assert_eq!(f.cursor(a).as_deref(), Some("4"));
    assert_eq!(f.run().await, report(0, 0, 0, 1));
    f.fake.set(|s| s.rate_limit = None);
    lock(&f.sync.backoff).clear();
    assert_eq!(f.run().await, report(8, 0, 0, 0));
    assert_eq!(f.downloads(), 13, "4 + the rejected one + 8");
}

#[tokio::test]
async fn corrupt_envelopes_are_recorded_as_skipped() {
    let f = fixture(1, QUICK).await;
    let a = &f.boxes[0];
    let mut corrupt = f.fake.envelope(&f.fake.deliver(a, b"Subject: roto\r\n\r\nx"));
    corrupt[70] ^= 1;
    let bad = [f.fake.deliver_envelope(a, corrupt), f.fake.deliver_envelope(a, vec![1, 1, 0])];
    f.fake.deliver(a, plain("bueno", "x").as_bytes());
    assert_eq!(f.run().await, report(2, 2, 0, 0));
    assert_eq!(f.subjects(a), ["bueno", "roto"]);
    assert_eq!(f.cursor(a).as_deref(), Some("4"));
    assert!(bad.iter().all(|id| f.skip_reason(a, id) == Some(SkipReason::Undecryptable)));
    f.store.reset_sync_cursor(&a.addr_key).unwrap();
    f.run().await;
    assert_eq!(f.downloads(), 4, "skipped ones are not requested again");
}

#[tokio::test]
async fn missing_and_oversized_messages_are_skipped_with_their_reason() {
    let f = fixture(1, QUICK).await;
    let a = &f.boxes[0];
    let ids = f.deliver_many(3);
    let big = f.fake.deliver(a, &[b'x'; 5000]);
    f.fake.set(|s| {
        s.broken.insert(ids[1].clone(), 404);
        s.listed_size.insert(big.clone(), 4096);
    });
    assert_eq!(f.run().await, report(2, 2, 0, 0));
    assert_eq!(
        (f.skip_reason(a, &ids[1]), f.skip_reason(a, &big)),
        (Some(SkipReason::NotFound), Some(SkipReason::TooLarge))
    );
    assert_eq!(f.cursor(a).as_deref(), Some("4"));
}

#[tokio::test]
async fn unparseable_message_is_stored_without_fields() {
    let f = fixture(1, QUICK).await;
    f.fake.deliver(&f.boxes[0], b"");
    assert_eq!(f.run().await.stored, 1);
    let stored = f.store.list_messages(&MessageFilter::default()).unwrap();
    assert_eq!(stored[0].parsed, ParsedFields::default());
}

#[tokio::test]
async fn pages_are_followed_up_to_the_limit() {
    let f = fixture(1, SyncConfig { max_pages: 2, ..QUICK }).await;
    let a = &f.boxes[0];
    f.fake.set(|s| s.page_size = 2);
    f.deliver_many(5);
    assert_eq!(f.run().await.stored, 4);
    assert_eq!(f.cursor(a).as_deref(), Some("4"));
    assert_eq!(f.run().await.stored, 1);
    assert_eq!(f.cursor(a).as_deref(), Some("5"));
}

#[tokio::test]
async fn the_round_budget_pauses_without_failing() {
    let f = fixture(1, SyncConfig { round_budget: 2 * (4096 + 62), ..QUICK }).await;
    let a = &f.boxes[0];
    f.deliver_many(3);
    assert_eq!(f.run().await, report(2, 0, 0, 0));
    assert_eq!(f.cursor(a).as_deref(), Some("2"));
    assert_eq!(f.run().await, report(1, 0, 0, 0));
}

#[tokio::test]
async fn cursor_ahead_of_the_server_is_brought_back_once_per_session() {
    let f = fixture(1, QUICK).await;
    let a = &f.boxes[0];
    f.store.set_sync_cursor(&a.addr_key, "50").unwrap();
    f.deliver_many(2);
    assert_eq!(f.run().await.stored, 2);
    assert_eq!(f.cursor(a).as_deref(), Some("2"));
    f.deliver_many(1);
    assert_eq!(f.run().await.stored, 1);
    let lists: Vec<_> =
        f.server.requests().into_iter().filter(|r| r.target.contains("since=")).map(|r| r.target).collect();
    assert!(lists.last().unwrap().ends_with("since=3") && lists[lists.len() - 2].ends_with("since=2"));
}

#[tokio::test]
async fn unreadable_cursor_is_reset() {
    let f = fixture(1, QUICK).await;
    let a = &f.boxes[0];
    f.store.reset_sync_cursor(&a.addr_key).unwrap();
    f.store.set_sync_cursor(&a.addr_key, "no es un número").unwrap();
    f.deliver_many(1);
    assert_eq!(f.run().await, report(1, 0, 0, 0));
    assert_eq!(f.cursor(a).as_deref(), Some("1"));
}

#[tokio::test]
async fn failure_keeps_the_cursor_and_defers_only_that_address() {
    let f = fixture(2, QUICK).await;
    let (a, b) = (&f.boxes[0], &f.boxes[1]);
    f.fake.deliver(a, plain("a1", "x").as_bytes());
    f.fake.deliver(b, plain("b1", "x").as_bytes());
    f.fake.set(|s| s.reject_next = 2);
    assert_eq!(f.run().await, report(1, 0, 1, 0));
    let (failed, ok) = if f.cursor(a).is_none() { (a, b) } else { (b, a) };
    assert_eq!((f.cursor(failed), f.cursor(ok).as_deref()), (None, Some("1")));
    f.fake.deliver(ok, plain("otro", "x").as_bytes());
    assert_eq!(f.run().await, SyncReport { fresh: 1, ..report(1, 0, 0, 1) });
}

#[tokio::test]
async fn deferral_ends_and_success_clears_it() {
    let f = fixture(1, SyncConfig { backoff_base: Duration::from_millis(50), ..QUICK }).await;
    f.fake.set(|s| s.fail_next = 1);
    assert_eq!(f.run().await.failed, 1);
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert_eq!(f.run().await, report(0, 0, 0, 0));
    assert!(lock(&f.sync.backoff).is_empty());
}

#[tokio::test]
async fn backoff_doubles_up_to_the_cap_or_what_the_server_asks() {
    let config = SyncConfig { backoff_base: Duration::from_secs(10), backoff_cap: Duration::from_secs(25), ..QUICK };
    let f = fixture(0, config).await;
    let key = [9; 32];
    let wait = |f: &Fixture| lock(&f.sync.backoff)[&key].not_before.duration_since(Instant::now()).as_secs_f64();
    let waits: Vec<f64> = (0..3)
        .map(|_| {
            f.sync.defer(key, MailError::Protocol);
            wait(&f)
        })
        .collect();
    assert!((9.0..=10.0).contains(&waits[0]) && (19.0..=20.0).contains(&waits[1]) && (24.0..=25.0).contains(&waits[2]));
    f.sync.defer(key, MailError::Busy { retry_after: 100 });
    assert!((99.0..=100.0).contains(&wait(&f)));
    f.sync.defer(key, MailError::Busy { retry_after: u64::MAX });
    assert!(wait(&f) <= 25.0, "an impossible wait does not overflow");
    assert_eq!(lock(&f.sync.backoff)[&key].failures, 5);
}

#[tokio::test]
async fn address_missing_from_the_store_fails() {
    let f = fixture(0, QUICK).await;
    let stranger = TestBox::new(77);
    f.fake.add_box(&stranger);
    f.fake.deliver(&stranger, b"Subject: x\r\n\r\ny");
    let target = SyncTarget { addr_key: stranger.addr_key, address: address(&stranger).display, keys: stranger.keys() };
    assert_eq!(f.sync.sync_all(&[target], &NoRegistry).await.unwrap().failed, 1);
}

#[tokio::test]
async fn rounds_do_not_overlap() {
    let pause = Duration::from_millis(200);
    let f = fixture(2, SyncConfig { pause_min: pause, pause_max: pause, ..QUICK }).await;
    let targets = f.targets();
    let (first, second) = tokio::join!(f.sync.sync_all(&targets, &NoRegistry), f.sync.sync_all(&targets, &NoRegistry));
    assert!(first.is_some() && second.is_none());
}

#[tokio::test]
async fn the_round_deadline_is_respected() {
    let f = fixture(1, SyncConfig { round_timeout: Duration::ZERO, ..QUICK }).await;
    f.deliver_many(1);
    assert_eq!(f.run().await, report(0, 0, 0, 0));
    assert!(f.server.requests().is_empty());
}

#[test]
fn cursor_after_a_partial_page() {
    let entry = |i: u8| ListedMessage { id: format!("{i:032}"), size: 4096, received_at: 0 };
    let page = |next| MessagePage { messages: (0..3).map(entry).collect(), next };
    assert_eq!(cursor_after(10, &page(13), 3), 13);
    assert_eq!(cursor_after(10, &page(13), 1), 11);
    assert_eq!(cursor_after(10, &page(20), 3), 20);
    assert_eq!(cursor_after(10, &page(20), 2), 10, "without contiguity the sequence is unknown");
}

#[test]
fn shuffle_is_a_permutation_and_varies() {
    let items: Vec<u32> = (0..20).collect();
    let orders: Vec<Vec<u32>> = (0..5).map(|_| shuffled(&items).into_iter().copied().collect()).collect();
    for order in &orders {
        let mut sorted = order.clone();
        sorted.sort();
        assert_eq!(sorted, items);
    }
    assert!(orders.iter().any(|o| *o != items));
    assert!(shuffled::<u32>(&[]).is_empty());
}

#[tokio::test]
async fn pauses_are_applied_between_addresses() {
    let pause = Duration::from_millis(150);
    let f = fixture(3, SyncConfig { pause_min: pause, pause_max: pause, ..QUICK }).await;
    let started = Instant::now();
    f.run().await;
    assert!(started.elapsed() >= pause * 2);
}

// ---------- Failing messages ----------

#[tokio::test]
async fn a_failing_message_does_not_block_the_rest_and_ends_as_failed() {
    let f = fixture(1, SyncConfig { max_attempts: 4, ..QUICK }).await;
    let a = &f.boxes[0];
    let ids = f.deliver_many(3);
    f.break_message(&ids[1], 500);
    assert_eq!(f.run().await, report(2, 0, 0, 0));
    assert_eq!(f.cursor(a).as_deref(), Some("1"), "the cursor stops at the gap");
    for _ in 0..2 {
        assert_eq!(f.run().await, report(0, 0, 0, 0));
    }
    assert_eq!(f.run().await, report(0, 1, 0, 0));
    assert_eq!(f.skip_reason(a, &ids[1]), Some(SkipReason::Failed));
    assert_eq!(f.cursor(a).as_deref(), Some("3"));
    assert_eq!(f.run().await, report(0, 0, 0, 0));
    assert_eq!(f.downloads(), 3 + 3, "one download per round; neither stored nor `failed` ones repeat in the session");
}

#[tokio::test]
async fn failed_messages_are_retried_by_the_relisting_of_the_next_session() {
    let f = fixture(1, SyncConfig { max_attempts: 1, ..QUICK }).await;
    let a = &f.boxes[0];
    let ids = f.deliver_many(2);
    f.break_message(&ids[0], 503);
    f.run().await;
    assert_eq!(f.skip_reason(a, &ids[0]), Some(SkipReason::Failed));
    f.fake.set(|s| s.broken.clear());
    let next_session = f.sync_for(&f.server.base, QUICK);
    assert_eq!(next_session.sync_all(&f.targets(), &NoRegistry).await.unwrap().stored, 1);
    assert_eq!(f.skip_reason(a, &ids[0]), None, "stored: its attempts row is deleted");
}

#[tokio::test]
async fn definitive_skips_are_not_retried_by_the_relisting() {
    let f = fixture(1, QUICK).await;
    let ids = f.deliver_many(1);
    f.break_message(&ids[0], 404);
    f.run().await;
    f.fake.set(|s| s.broken.clear());
    f.sync_for(&f.server.base, QUICK).sync_all(&f.targets(), &NoRegistry).await.unwrap();
    assert_eq!(f.downloads(), 1);
}

#[tokio::test]
async fn the_cursor_never_jumps_over_a_pending_message() {
    let f = fixture(1, SyncConfig { max_pages: 2, max_attempts: 100, ..QUICK }).await;
    let a = &f.boxes[0];
    f.fake.set(|s| s.page_size = 2);
    let ids = f.deliver_many(5);
    f.break_message(&ids[1], 500);
    assert_eq!((f.run().await.stored, f.cursor(a)), (3, Some("1".into())));
    assert_eq!((f.run().await.stored, f.cursor(a)), (1, Some("1".into())));
    f.fake.set(|s| s.broken.clear());
    assert_eq!((f.run().await.stored, f.cursor(a)), (1, Some("5".into())));
}

#[tokio::test]
async fn several_transient_failures_in_a_row_stop_the_address() {
    let f = fixture(1, QUICK).await;
    for id in f.deliver_many(5) {
        f.break_message(&id, 500);
    }
    assert_eq!(f.run().await, report(0, 0, 1, 0));
    assert_eq!(f.downloads(), 3);
}

#[tokio::test]
async fn an_attempt_counts_only_if_the_previous_one_is_old_enough() {
    for (spacing, skipped) in [(Duration::ZERO, 1), (Duration::from_secs(600), 0)] {
        let f = fixture(1, SyncConfig { max_attempts: 2, attempt_spacing: spacing, ..QUICK }).await;
        let ids = f.deliver_many(1);
        f.break_message(&ids[0], 500);
        let skipped_in_two_rounds = f.run().await.skipped + f.run().await.skipped;
        assert_eq!(skipped_in_two_rounds, skipped, "{spacing:?}");
    }
}

#[tokio::test]
async fn a_message_that_killed_the_analyzer_is_stored_unparsed() {
    let f = fixture(1, QUICK).await;
    let a = &f.boxes[0];
    let id = f.fake.deliver(a, MULTIPART.as_bytes());
    f.store.set_meta("mail.parsing.sync", &[&a.addr_key[..], id.as_bytes()].concat()).unwrap();
    assert_eq!(f.run().await.stored, 1);
    let stored = f.store.list_messages(&MessageFilter::default()).unwrap();
    assert_eq!(stored[0].parsed, ParsedFields::default());
}

// ---------- Stop and deadline ----------

/// A server that gives the time and then never answers.
async fn hanging_server() -> TestServer {
    TestServer::start(|r| {
        if r.target == "/v1/time" { Reply::new(200).body("{\"time\":1800000000}") } else { Reply::hang() }
    })
    .await
}

#[tokio::test]
async fn stop_interrupts_a_pause_and_waits_for_the_round() {
    let pause = Duration::from_secs(10);
    let f = fixture(2, SyncConfig { pause_min: pause, pause_max: pause, ..QUICK }).await;
    for tb in &f.boxes {
        f.fake.deliver(tb, b"Subject: x\r\n\r\ny");
    }
    let targets = f.targets();
    let started = Instant::now();
    let stopper = async {
        tokio::time::sleep(Duration::from_millis(200)).await;
        f.sync.stop().await;
    };
    let (report, ()) = tokio::join!(f.sync.sync_all(&targets, &NoRegistry), stopper);
    assert_eq!(report.unwrap().stored, 1);
    assert!(started.elapsed() < Duration::from_secs(8));
}

#[tokio::test]
async fn stop_interrupts_a_request_in_flight() {
    let f = fixture(1, QUICK).await;
    let server = hanging_server().await;
    let sync = f.sync_for(&server.base, QUICK);
    let targets = f.targets();
    let started = Instant::now();
    let stopper = async {
        tokio::time::sleep(Duration::from_millis(200)).await;
        sync.stop().await;
    };
    let (report, ()) = tokio::join!(sync.sync_all(&targets, &NoRegistry), stopper);
    assert_eq!(report.unwrap(), report_zero());
    assert!(started.elapsed() < Duration::from_secs(8));
}

fn report_zero() -> SyncReport {
    SyncReport::default()
}

#[tokio::test]
async fn the_round_deadline_cuts_a_request_in_flight() {
    let f = fixture(1, QUICK).await;
    let server = hanging_server().await;
    let sync = f.sync_for(&server.base, SyncConfig { round_timeout: Duration::from_millis(300), ..QUICK });
    let started = Instant::now();
    assert_eq!(sync.sync_all(&f.targets(), &NoRegistry).await.unwrap(), report_zero());
    assert!(started.elapsed() < Duration::from_secs(8));
}

#[tokio::test]
async fn stop_without_a_round_does_not_affect_the_next_one() {
    let f = fixture(1, QUICK).await;
    f.deliver_many(1);
    f.sync.stop().await;
    assert_eq!(f.run().await.stored, 1);
}

#[tokio::test]
async fn a_pending_message_is_downloaded_once_per_round() {
    let f = fixture(1, SyncConfig { max_attempts: 100, ..QUICK }).await;
    let ids = f.deliver_many(2);
    f.break_message(&ids[0], 500);
    f.run().await;
    assert_eq!(f.downloads(), 2, "the cursor pass and the relisting do not request it twice");
}

/// An address that always fails (three messages the server will not give) does not hide new mail of the others.
#[tokio::test]
async fn new_mail_counts_for_an_address_even_while_another_keeps_failing() {
    let f = fixture(2, SyncConfig { max_attempts: 100, ..QUICK }).await;
    let (a, b) = (&f.boxes[0], &f.boxes[1]);
    f.fake.deliver(a, plain("atrasado", "x").as_bytes());
    for i in 0..3 {
        let id = f.fake.deliver(b, plain(&format!("roto {i}"), "x").as_bytes());
        f.break_message(&id, 500);
    }
    let first = f.run().await;
    assert_eq!((first.stored, first.failed, first.fresh), (1, 1, 0), "the backlog is not new");
    f.fake.deliver(a, plain("nuevo", "x").as_bytes());
    let second = f.run().await;
    assert_eq!((second.stored, second.deferred, second.fresh), (1, 1, 1));
}

/// An address added mid-session (restored or created) brings older mail, which is not new. After its first clean pass,
/// what arrives is.
#[tokio::test]
async fn an_address_added_mid_session_counts_only_after_its_first_clean_pass() {
    let f = fixture(2, QUICK).await;
    let (a, b) = (&f.boxes[0], &f.boxes[1]);
    let targets = f.targets();
    f.sync.sync_all(&targets[..1], &NoRegistry).await.unwrap();
    f.fake.deliver(b, plain("viejo 1", "x").as_bytes());
    f.fake.deliver(b, plain("viejo 2", "x").as_bytes());
    f.fake.deliver(a, plain("nuevo para a", "x").as_bytes());
    let joined = f.run().await;
    assert_eq!((joined.stored, joined.fresh), (3, 1));
    f.fake.deliver(b, plain("nuevo para b", "x").as_bytes());
    let next = f.run().await;
    assert_eq!((next.stored, next.fresh), (1, 1));
}

/// A pass that stops at `max_pages` has not reached the end: the rest is backlog.
#[tokio::test]
async fn an_address_is_not_caught_up_until_its_pass_reaches_the_end() {
    let f = fixture(1, SyncConfig { max_pages: 1, ..QUICK }).await;
    f.fake.set(|s| s.page_size = 1);
    f.deliver_many(2);
    assert_eq!(f.run().await.stored, 1);
    let rest = f.run().await;
    assert_eq!((rest.stored, rest.fresh), (1, 0));
}

/// Unlocking creates another `MailSync`: what arrived meanwhile is backlog, even if it was caught up before.
#[tokio::test]
async fn a_new_session_starts_without_fresh_mail() {
    let f = fixture(1, QUICK).await;
    f.run().await;
    f.deliver_many(1);
    let again = f.sync_for(&f.server.base, QUICK);
    let report = again.sync_all(&f.targets(), &NoRegistry).await.unwrap();
    assert_eq!((report.stored, report.fresh), (1, 0));
}
