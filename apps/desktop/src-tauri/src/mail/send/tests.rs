use std::collections::VecDeque;
use std::time::Duration;

use tempfile::TempDir;

use super::*;
use crate::mail::client::ClientConfig;
use crate::mail::directory::{LocalPart, parse_address};
use crate::mail::e2e::{ReceivedMail, open_mail_envelope};
use crate::mail::fake_mailbox::TestBox;
use crate::mail::test_server::{Length, Reply, Request, TestServer};
use crate::store::{SentFilter, SlotKind, StoreScope};
use crate::transport::{Transport, TransportConfig, USER_AGENT};

const DOMAIN: &str = "nightmail.local";
const ALICE: &str = "alice@nightmail.local";
const BOB: &str = "bob@nightmail.local";
/// Far from the local clock, so a mail dated with the local clock would show.
const SERVER_TIME: u64 = 1_900_000_000;

const NO_PACE: ClientConfig = ClientConfig {
    busy_retries: 0,
    busy_max_wait: Duration::ZERO,
    pace: Duration::ZERO,
    pace_jitter: Duration::ZERO,
};

/// Our keys and a registry with Bob only. `fail` makes every lookup answer that error.
struct Ctx {
    alice: TestBox,
    bob: TestBox,
    fail: Mutex<Option<DirectoryError>>,
}

impl Ctx {
    fn bob(&self) -> Recipient {
        Recipient {
            address: BOB.into(),
            addr_key: self.bob.addr_key,
            enc_pk: self.bob.enc_public(),
            auth_pk: self.bob.auth_public(),
        }
    }

    fn fail_with(&self, error: Option<DirectoryError>) {
        *self.fail.lock().unwrap() = error;
    }
}

impl SendContext for Ctx {
    fn auth_seed(&self, address: &Address) -> Option<Zeroizing<[u8; 32]>> {
        (address.addr_key == self.alice.addr_key).then(|| Zeroizing::new(self.alice.auth_seed))
    }

    async fn resolve_recipient(&self, text: &str) -> std::result::Result<Recipient, DirectoryError> {
        if let Some(error) = *self.fail.lock().unwrap() {
            return Err(error);
        }
        match parse_address(text, DOMAIN)? {
            LocalPart::Mailbox(name) if name == "bob" => Ok(self.bob()),
            _ => Err(DirectoryError::NotFound),
        }
    }
}

/// What the fake server answers: `/v1/time` (`None`: 500) and the next deliveries (then `200`). It records the stored
/// states it sees while each delivery arrives.
struct Script {
    time: Option<u64>,
    deliveries: VecDeque<Reply>,
    states_seen: Vec<Vec<SentState>>,
}

struct Fixture {
    _dir: TempDir,
    store: Arc<LocalStore>,
    server: TestServer,
    script: Arc<Mutex<Script>>,
    outbox: Outbox,
    ctx: Ctx,
}

fn alice_address(alice: &TestBox) -> Address {
    Address {
        addr_key: alice.addr_key,
        kind: SlotKind::Mailbox,
        n: 0,
        j: 0,
        display: ALICE.into(),
        name: Some("alice".into()),
        created_at: 1,
    }
}

fn delivered() -> Reply {
    Reply::new(200).header("Content-Type", "application/json").body(r#"{"status":"delivered"}"#)
}

fn answer(script: &Mutex<Script>, store: &LocalStore, request: &Request) -> Reply {
    let mut script = script.lock().unwrap();
    if request.target == "/v1/time" {
        return match script.time {
            // A cookie the client must never send back.
            Some(time) => Reply::new(200).header("Set-Cookie", "seen=1; Path=/").body(format!(r#"{{"time":{time}}}"#)),
            None => Reply::new(500),
        };
    }
    let states = store.list_sent(&SentFilter::default()).unwrap().iter().map(|m| m.state).collect();
    script.states_seen.push(states);
    script.deliveries.pop_front().unwrap_or_else(delivered)
}

async fn fixture_with(transport: TransportConfig) -> Fixture {
    let dir = TempDir::new().unwrap();
    let scope = StoreScope { network: "devnet".into(), contract: "c1".into() };
    let store = Arc::new(LocalStore::open(&dir.path().join("db"), &[5; 32], &scope).unwrap());
    let ctx = Ctx { alice: TestBox::new(0xa1), bob: TestBox::new(0xb0), fail: Mutex::new(None) };
    store.insert_address(&alice_address(&ctx.alice)).unwrap();
    let script = Script { time: Some(SERVER_TIME), deliveries: VecDeque::new(), states_seen: Vec::new() };
    let script = Arc::new(Mutex::new(script));
    let (seen_script, seen_store) = (script.clone(), store.clone());
    let server = TestServer::start(move |request| answer(&seen_script, &seen_store, request)).await;
    let transport = Arc::new(Transport::direct(&transport).unwrap());
    let outbox = Outbox::new(MailboxClient::new(transport, server.base.clone(), NO_PACE), store.clone());
    Fixture { _dir: dir, store, server, script, outbox, ctx }
}

async fn fixture() -> Fixture {
    fixture_with(TransportConfig { total_timeout: Duration::from_secs(10), connect_timeout: Duration::from_secs(5) })
        .await
}

impl Fixture {
    async fn send_to(&self, to: &str, subject: &str, body: &str) -> Result<i64> {
        self.outbox.send(&self.ctx, &self.ctx.alice.addr_key, to, subject, Zeroizing::new(body.to_owned())).await
    }

    async fn send(&self) -> i64 {
        self.send_to(" Bob@NightMail.local ", "Hola", "Hola, Bob.\r\nHasta luego.").await.unwrap()
    }

    fn answer_next(&self, reply: Reply) {
        self.script.lock().unwrap().deliveries.push_back(reply);
    }

    fn state(&self, id: i64) -> SentState {
        self.store.get_sent(id).unwrap().unwrap().summary.state
    }

    fn deliveries(&self) -> Vec<Request> {
        self.server.requests().into_iter().filter(|r| r.method == "POST").collect()
    }

    fn time_requests(&self) -> usize {
        self.server.requests().iter().filter(|r| r.target == "/v1/time").count()
    }

    /// Opens a delivered envelope as Bob, with the registry's key for Alice.
    fn open_as_bob(&self, envelope: &[u8]) -> ReceivedMail {
        let me = Party { addr_key: self.ctx.bob.addr_key, address: BOB };
        let alice = (self.ctx.alice.addr_key, self.ctx.alice.auth_public());
        open_mail_envelope(&self.ctx.bob.enc_secret, envelope, &me, |key, address| {
            Ok((*key == alice.0 && address == ALICE).then_some(alice.1))
        })
        .unwrap()
    }

    fn assert_nothing_went_out(&self) {
        assert!(self.deliveries().is_empty(), "no delivery");
        assert_eq!(self.store.count_sent(None).unwrap(), 0, "nothing stored");
    }
}

#[tokio::test]
async fn sends_a_signed_sealed_mail_dated_by_the_server_and_marks_it_sent_after_200() {
    let f = fixture().await;
    let id = f.send().await;

    assert_eq!(f.state(id), SentState::Sent);
    let requests = f.server.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!((requests[0].method.as_str(), requests[0].target.as_str()), ("GET", "/v1/time"));
    assert_eq!(requests[1].target, format!("/v1/box/{}/deliver", hex::encode(f.ctx.bob.addr_key)));
    assert_eq!(f.server.connection_count(), 2, "one connection per request");
    let delivery = &requests[1];
    assert_eq!(delivery.header("content-type"), Some("application/octet-stream"));
    assert_eq!(delivery.header("content-length"), Some(delivery.body.len().to_string().as_str()));

    let mail = f.open_as_bob(&delivery.body);
    assert!(mail.sender_verified, "signed by Alice's auth key, for Bob");
    assert_eq!((mail.sender.address.as_str(), mail.recipient.address.as_str()), (ALICE, BOB));
    assert_eq!(mail.date, SERVER_TIME, "the server's time, not the local clock");
    assert_eq!((mail.subject.as_str(), mail.body.as_str()), ("Hola", "Hola, Bob.\r\nHasta luego."));

    let stored = f.store.get_sent(id).unwrap().unwrap();
    assert_eq!(stored.summary.message_id, mail.message_id);
    assert_eq!(stored.summary.sent_at, SERVER_TIME as i64);
    assert_eq!((stored.summary.from_addr.as_str(), stored.summary.to_addr.as_str()), (ALICE, BOB));
    assert_eq!(stored.summary.subject, "Hola");
    assert_eq!(stored.body.as_str(), "Hola, Bob.\r\nHasta luego.");
}

#[tokio::test]
async fn it_is_saved_as_queued_before_the_delivery_and_sent_only_after_200() {
    let f = fixture().await;
    let id = f.send().await;
    assert_eq!(f.script.lock().unwrap().states_seen, [vec![SentState::Queued]], "stored before going out");
    assert_eq!(f.state(id), SentState::Sent);

    f.answer_next(Reply::new(202));
    let other = f.send().await;
    assert_eq!(f.state(other), SentState::Failed(SendFailure::Failed), "only a 200 is sent");
}

#[tokio::test]
async fn the_delivery_says_nothing_about_who_sends() {
    let f = fixture().await;
    f.send().await;
    let delivery = f.deliveries().pop().unwrap();
    let names: Vec<&str> = delivery.headers.iter().map(|(name, _)| name.as_str()).collect();
    for name in &names {
        assert!(
            ["host", "user-agent", "accept", "content-type", "content-length"].contains(name),
            "unexpected header {name}"
        );
    }
    assert_eq!(delivery.header("user-agent"), Some(USER_AGENT));
    assert!(delivery.header("cookie").is_none(), "the cookie from /v1/time is not sent back");
    assert!(!names.iter().any(|n| n.starts_with("nightmail-")), "no request signature");
    let target = delivery.target.to_ascii_lowercase();
    assert!(!target.contains(&hex::encode(f.ctx.alice.addr_key)) && !target.contains('?'));
    let body = String::from_utf8_lossy(&delivery.body);
    assert!(!body.contains("alice") && !body.contains("Hola"), "the envelope is sealed");
}

#[tokio::test]
async fn each_refusal_becomes_its_failure() {
    let f = fixture().await;
    let cases = [
        (Reply::new(404), SendFailure::NoRecipient),
        (Reply::new(429).header("Retry-After", "3600"), SendFailure::RateLimited),
        (Reply::new(507), SendFailure::MailboxFull),
        (Reply::new(413), SendFailure::TooLarge),
        (Reply::new(400), SendFailure::Failed),
        (Reply::new(503).header("Retry-After", "30"), SendFailure::ChainUnavailable),
        (Reply::new(500), SendFailure::Failed),
        (Reply::new(502), SendFailure::Network),
        (Reply::new(302).header("Location", "http://127.0.0.1:1/"), SendFailure::Failed),
    ];
    for (reply, reason) in cases {
        let status = reply.status;
        f.answer_next(reply);
        let id = f.send().await;
        assert_eq!(f.state(id), SentState::Failed(reason), "{status}");
    }
    assert_eq!(f.deliveries().len(), 9, "a redirect is not followed");
}

#[tokio::test]
async fn a_retry_after_is_kept_and_no_retry_goes_out_before_it() {
    let f = fixture().await;
    f.answer_next(Reply::new(429).header("Retry-After", "3600"));
    let id = f.send().await;
    let at = f.outbox.retry_at(id).expect("kept");
    assert!((at - local_now() - 3600).abs() <= 5, "{at}");

    f.outbox.retry(&f.ctx, id).await.unwrap();
    assert_eq!(f.deliveries().len(), 1, "not retried before the server said");
    assert_eq!(f.state(id), SentState::Failed(SendFailure::RateLimited));

    // A refusal without `Retry-After` does not hold a retry back.
    f.answer_next(Reply::new(503));
    let other = f.send().await;
    assert_eq!(f.outbox.retry_at(other), None);
}

#[tokio::test]
async fn network_failures_leave_it_failed_and_retryable() {
    let quick = TransportConfig { total_timeout: Duration::from_millis(800), connect_timeout: Duration::from_secs(1) };
    let f = fixture_with(quick).await;
    f.answer_next(Reply::hang());
    let id = f.send().await;
    assert_eq!(f.state(id), SentState::Failed(SendFailure::Network), "no answer in time");

    // The server said 200, but the answer was cut short: it may have arrived, it may not.
    f.answer_next(delivered().length(Length::Declared(500)));
    let cut = f.send().await;
    assert_eq!(f.state(cut), SentState::Failed(SendFailure::Network));

    f.outbox.retry(&f.ctx, id).await.unwrap();
    assert_eq!(f.state(id), SentState::Sent);
}

#[tokio::test]
async fn without_the_server_time_nothing_is_stored_or_sent() {
    let f = fixture().await;
    f.script.lock().unwrap().time = None;
    let error = f.send_to(BOB, "Hola", "x").await.unwrap_err();
    assert_eq!(error, OutboxError::Send(SendError::ServerTimeUnavailable));
    f.assert_nothing_went_out();

    // A server time past what a mail date can hold is no better.
    f.script.lock().unwrap().time = Some(MAX_DATE + 1);
    let error = f.send_to(BOB, "Hola", "x").await.unwrap_err();
    assert_eq!(error, OutboxError::Send(SendError::ServerTimeUnavailable));
    f.assert_nothing_went_out();
}

#[tokio::test]
async fn recipient_problems_stop_it_before_anything_goes_out() {
    let f = fixture().await;
    let cases = [
        ("nadie@nightmail.local", SendError::RecipientNotFound),
        ("bob@gmail.com", SendError::RecipientForeignDomain),
        ("bob", SendError::RecipientInvalid),
        ("bob @nightmail.local", SendError::RecipientInvalid),
    ];
    for (to, expected) in cases {
        assert_eq!(f.send_to(to, "Hola", "x").await.unwrap_err(), OutboxError::Send(expected), "{to}");
    }
    for (error, expected) in [
        (DirectoryError::Unusable, SendError::RecipientUnusable),
        (DirectoryError::RegistryUnavailable, SendError::RegistryUnavailable),
        (DirectoryError::RegistryStale, SendError::RegistryStale),
        (DirectoryError::Clock, SendError::RegistryClock),
    ] {
        f.ctx.fail_with(Some(error));
        assert_eq!(f.send_to(BOB, "Hola", "x").await.unwrap_err(), OutboxError::Send(expected));
    }
    f.assert_nothing_went_out();
    assert!(f.server.requests().is_empty(), "not even the time is asked for");
}

#[tokio::test]
async fn content_outside_the_format_is_refused_before_anything_goes_out() {
    let f = fixture().await;
    let long_subject = "a".repeat(e2e::MAX_SUBJECT_LENGTH + 1);
    let huge_body = "a".repeat(MAX_MAIL_LENGTH);
    let cases = [
        ("Hola\nadiós", "x", SendError::SubjectInvalid),
        (long_subject.as_str(), "x", SendError::SubjectInvalid),
        ("Hola", "factura\u{202e}fdp.exe", SendError::BodyInvalid),
        ("Hola", "\u{7}", SendError::BodyInvalid),
        ("Hola", huge_body.as_str(), SendError::MessageTooLarge),
    ];
    for (subject, body, expected) in cases {
        assert_eq!(f.send_to(BOB, subject, body).await.unwrap_err(), OutboxError::Send(expected));
    }
    f.assert_nothing_went_out();
    assert!(f.server.requests().is_empty());
}

#[tokio::test]
async fn only_our_active_addresses_send() {
    let f = fixture().await;
    let stranger = TestBox::new(0x5a);
    let body = || Zeroizing::new("x".to_owned());
    let error = f.outbox.send(&f.ctx, &stranger.addr_key, BOB, "Hola", body()).await.unwrap_err();
    assert_eq!(error, OutboxError::Send(SendError::SenderUnavailable));

    f.store.abandon_address(&f.ctx.alice.addr_key, 2).unwrap();
    let error = f.outbox.send(&f.ctx, &f.ctx.alice.addr_key, BOB, "Hola", body()).await.unwrap_err();
    assert_eq!(error, OutboxError::Send(SendError::SenderUnavailable));
    assert!(f.server.requests().is_empty());
}

#[tokio::test]
async fn a_retry_sends_the_same_mail_again_until_it_is_sent() {
    let f = fixture().await;
    f.answer_next(Reply::new(503));
    let id = f.send().await;
    assert_eq!(f.state(id), SentState::Failed(SendFailure::ChainUnavailable));

    f.outbox.retry(&f.ctx, id).await.unwrap();
    assert_eq!(f.state(id), SentState::Sent);
    let deliveries = f.deliveries();
    assert_eq!(deliveries.len(), 2);
    assert_ne!(deliveries[0].body, deliveries[1].body, "sealed anew");
    let (first, second) = (f.open_as_bob(&deliveries[0].body), f.open_as_bob(&deliveries[1].body));
    assert!(first == second, "same Message-ID, date, sender, subject and body: Bob keeps one");
    assert!(second.sender_verified);
    assert_eq!(f.time_requests(), 1, "the date is the first one, not a new server time");

    f.outbox.retry(&f.ctx, id).await.unwrap();
    assert_eq!(f.deliveries().len(), 2, "a sent message is not delivered again");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_retries_deliver_once() {
    let f = fixture().await;
    f.answer_next(Reply::new(404));
    let id = f.send().await;
    let (a, b, c) = tokio::join!(f.outbox.retry(&f.ctx, id), f.outbox.retry(&f.ctx, id), f.outbox.retry(&f.ctx, id));
    assert_eq!((a, b, c), (Ok(()), Ok(()), Ok(())));
    assert_eq!(f.deliveries().len(), 2, "the first send and a single retry");
    assert_eq!(f.state(id), SentState::Sent);
    assert!(f.outbox.in_flight.map().is_empty(), "no lock left behind");
}

#[tokio::test]
async fn a_retry_looks_the_recipient_up_again() {
    let f = fixture().await;
    f.answer_next(Reply::new(500));
    let id = f.send().await;
    for (error, reason) in [
        (DirectoryError::RegistryUnavailable, SendFailure::ChainUnavailable),
        (DirectoryError::RegistryStale, SendFailure::ChainUnavailable),
        (DirectoryError::NotFound, SendFailure::NoRecipient),
        (DirectoryError::Unusable, SendFailure::RecipientKey),
    ] {
        f.ctx.fail_with(Some(error));
        f.outbox.retry(&f.ctx, id).await.unwrap();
        assert_eq!(f.state(id), SentState::Failed(reason));
    }
    assert_eq!(f.deliveries().len(), 1, "nothing goes out without the recipient's key");
    f.ctx.fail_with(None);
    f.outbox.retry(&f.ctx, id).await.unwrap();
    assert_eq!(f.state(id), SentState::Sent);
}

#[tokio::test]
async fn a_queued_message_left_by_a_closed_app_can_be_retried() {
    let f = fixture().await;
    f.answer_next(Reply::new(500));
    let id = f.send().await;
    f.store.set_sent_state(id, SentState::Queued).unwrap();
    f.outbox.retry(&f.ctx, id).await.unwrap();
    assert_eq!(f.state(id), SentState::Sent);
}

#[tokio::test]
async fn deleting_removes_it_for_good() {
    let f = fixture().await;
    f.answer_next(Reply::new(429).header("Retry-After", "60"));
    let id = f.send().await;
    f.outbox.delete(id).await.unwrap();
    assert_eq!(f.store.count_sent(None).unwrap(), 0);
    assert_eq!(f.outbox.retry_at(id), None);
    assert_eq!(f.outbox.retry(&f.ctx, id).await, Err(OutboxError::NotFound));
    assert_eq!(f.outbox.delete(id).await, Err(OutboxError::NotFound));
}

#[test]
fn delivery_answers_map_to_fixed_states() {
    let answer = |status: u16, retry_after: Option<u64>| {
        outcome(Ok(HttpResponse { status, date: None, retry_after, body: b"{\"error\":\"secret\"}".to_vec() }))
    };
    assert_eq!(answer(200, Some(5)), (SentState::Sent, None));
    assert_eq!(answer(429, Some(3600)), (SentState::Failed(SendFailure::RateLimited), Some(3600)));
    assert_eq!(answer(503, Some(30)), (SentState::Failed(SendFailure::ChainUnavailable), Some(30)));
    assert_eq!(answer(404, Some(30)), (SentState::Failed(SendFailure::NoRecipient), None), "only 429 and 503 wait");
    assert_eq!(answer(507, None), (SentState::Failed(SendFailure::MailboxFull), None));
    assert_eq!(answer(413, None), (SentState::Failed(SendFailure::TooLarge), None));
    assert_eq!(answer(400, None), (SentState::Failed(SendFailure::Failed), None));
    assert_eq!(answer(504, None), (SentState::Failed(SendFailure::Network), None));
    let lost = [TransportError::Network, TransportError::Timeout, TransportError::Interrupted, TransportError::TooLarge];
    for error in lost {
        assert_eq!(outcome(Err(error)), (SentState::Failed(SendFailure::Network), None), "{error:?}");
    }
    assert_eq!(outcome(Err(TransportError::BadUrl)), (SentState::Failed(SendFailure::Failed), None));
}

#[test]
fn errors_are_fixed_codes() {
    let codes = serde_json::to_string(&[SendError::RecipientNotFound, SendError::ServerTimeUnavailable]).unwrap();
    assert_eq!(codes, r#"[{"code":"recipientNotFound"},{"code":"serverTimeUnavailable"}]"#);
    assert_eq!(SendError::from(DirectoryError::ForeignDomain), SendError::RecipientForeignDomain);
}

#[tokio::test]
async fn messages_with_the_same_id_wait_for_each_other() {
    let locks = MessageLocks::default();
    let first = locks.lock([1; MESSAGE_ID_LENGTH]).await;
    let other = tokio::time::timeout(Duration::from_millis(50), locks.lock([2; MESSAGE_ID_LENGTH])).await;
    assert!(other.is_ok(), "another message does not wait");
    drop(other);
    let same = tokio::time::timeout(Duration::from_millis(50), locks.lock([1; MESSAGE_ID_LENGTH])).await;
    assert!(same.is_err(), "the same message waits");
    drop(first);
    assert!(locks.map().is_empty());
    let _again = locks.lock([1; MESSAGE_ID_LENGTH]).await;
}

/// Kills the server when the test ends, however it ends.
struct Child(std::process::Child);

impl Drop for Child {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// The real Mailbox API (`apps/server/test/serve-mailbox-api.ts`: in memory, with Bob's box only): Alice sends, Bob
/// lists and downloads it with his signed session and opens it with the sender verified; a box the server does not
/// know is `no-recipient`. Needs `node` 24 on the PATH (nvm) and the repo's `node_modules`. Run:
/// `cargo test mail::send -- --ignored`.
#[tokio::test]
#[ignore = "needs node and the repo's node_modules (see the comment)"]
async fn delivers_through_the_real_mailbox_api() {
    use std::io::BufRead;

    let ctx = Ctx { alice: TestBox::new(0xa1), bob: TestBox::new(0xb0), fail: Mutex::new(None) };
    let boxes = serde_json::json!([{
        "addrKey": hex::encode(ctx.bob.addr_key),
        "encPk": hex::encode(ctx.bob.enc_public()),
        "authPk": hex::encode(ctx.bob.auth_public()),
    }]);
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../server/test/serve-mailbox-api.ts");
    let mut child = std::process::Command::new("node")
        .arg(script)
        .arg(boxes.to_string())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("node");
    let stdout = child.stdout.take().unwrap();
    let child = Child(child);
    let line = tokio::task::spawn_blocking(move || {
        let mut line = String::new();
        std::io::BufReader::new(stdout).read_line(&mut line).map(|_| line)
    })
    .await
    .unwrap()
    .unwrap();
    let base = crate::transport::BaseUrl::parse(line.trim()).expect("the server's base URL");

    let dir = TempDir::new().unwrap();
    let scope = StoreScope { network: "devnet".into(), contract: "c1".into() };
    let store = Arc::new(LocalStore::open(&dir.path().join("db"), &[5; 32], &scope).unwrap());
    store.insert_address(&alice_address(&ctx.alice)).unwrap();
    let transport = Arc::new(Transport::direct(&TransportConfig::default()).unwrap());
    let client = || MailboxClient::new(transport.clone(), base.clone(), NO_PACE);
    let outbox = Outbox::new(client(), store.clone());

    let body = Zeroizing::new("Hola, Bob.\r\nEsto va cifrado.".to_owned());
    let id = outbox.send(&ctx, &ctx.alice.addr_key, BOB, "De Alice", body).await.unwrap();
    assert_eq!(store.get_sent(id).unwrap().unwrap().summary.state, SentState::Sent);

    let bob = client();
    let mut session = bob.open_session(&ctx.bob.addr_key, &ctx.bob.auth_seed).await.unwrap();
    let page = bob.list(&mut session, 0).await.unwrap();
    assert_eq!(page.messages.len(), 1);
    let envelope = bob.download(&mut session, &page.messages[0]).await.unwrap();
    let me = Party { addr_key: ctx.bob.addr_key, address: BOB };
    let alice = (ctx.alice.addr_key, ctx.alice.auth_public());
    let mail = open_mail_envelope(&ctx.bob.enc_secret, &envelope, &me, |key, address| {
        Ok((*key == alice.0 && address == ALICE).then_some(alice.1))
    })
    .unwrap();
    assert!(mail.sender_verified);
    assert_eq!((mail.subject.as_str(), mail.body.as_str()), ("De Alice", "Hola, Bob.\r\nEsto va cifrado."));
    assert_eq!(i64::try_from(mail.date).unwrap(), store.get_sent(id).unwrap().unwrap().summary.sent_at);

    let stray = crate::crypto::seal_envelope(&ctx.bob.enc_public(), b"x").unwrap();
    assert_eq!(outcome(client().deliver(&[0x77; 32], stray).await), (SentState::Failed(SendFailure::NoRecipient), None));
    drop(child);
}
