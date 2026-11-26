use super::*;
use crate::mail::fake_mailbox::{FakeMailbox, TestBox};
use crate::mail::test_server::{Reply, TestServer};
use crate::transport::TransportConfig;

/// No pacing: tests that do not measure it do not wait.
const NO_PACE: ClientConfig = ClientConfig {
    busy_retries: 3,
    busy_max_wait: Duration::from_secs(5),
    pace: Duration::ZERO,
    pace_jitter: Duration::ZERO,
};

fn client_with(server: &TestServer, config: ClientConfig) -> MailboxClient {
    let transport = Arc::new(Transport::direct(&TransportConfig::default()).unwrap());
    MailboxClient::new(transport, server.base.clone(), config)
}

fn client_for(server: &TestServer) -> MailboxClient {
    client_with(server, NO_PACE)
}

fn signed_targets(server: &TestServer) -> Vec<String> {
    server.requests().into_iter().filter(|r| r.target != TIME_PATH).map(|r| r.target).collect()
}

fn nonces(server: &TestServer) -> Vec<String> {
    server.requests().iter().filter_map(|r| r.header("nightmail-nonce").map(str::to_owned)).collect()
}

async fn open<'a>(client: &MailboxClient, tb: &'a TestBox) -> Session<'a> {
    client.open_session(&tb.addr_key, &tb.auth_seed).await.unwrap()
}

fn listed(id: &str) -> ListedMessage {
    ListedMessage { id: id.to_owned(), size: 4096, received_at: 0 }
}

#[tokio::test]
async fn lists_and_downloads_signing_with_server_time() {
    let (fake, server, tb) = FakeMailbox::with_box(3600).await;
    let id = fake.deliver(&tb, b"Subject: hola\r\n\r\nx");
    let client = client_for(&server);
    let mut session = open(&client, &tb).await;
    let page = client.list(&mut session, 0).await.unwrap();
    assert_eq!((page.next, page.messages[0].id.as_str(), page.messages[0].size), (1, id.as_str(), 4096));
    let envelope = client.download(&mut session, &page.messages[0]).await.unwrap();
    assert_eq!(envelope, fake.envelope(&id));
    assert_eq!(signed_targets(&server), [list_path(&tb.addr_key, 0), message_path(&tb.addr_key, &id)]);
    assert_eq!(server.requests()[0].target, TIME_PATH, "the time is fetched before signing");
    assert_eq!(server.connection_count(), server.requests().len(), "one connection per request");
}

#[tokio::test]
async fn every_session_asks_its_own_server_time() {
    let (fake, server, a) = FakeMailbox::with_box(0).await;
    let b = TestBox::new(2);
    fake.add_box(&b);
    let client = client_for(&server);
    for tb in [&a, &b] {
        let mut session = open(&client, tb).await;
        client.list(&mut session, 0).await.unwrap();
    }
    let targets: Vec<_> = server.requests().into_iter().map(|r| r.target).collect();
    let (la, lb) = (list_path(&a.addr_key, 0), list_path(&b.addr_key, 0));
    assert_eq!(targets, [TIME_PATH, &la, TIME_PATH, &lb]);
}

#[tokio::test]
async fn rejected_request_is_retried_once_with_the_date_of_the_rejection() {
    let (fake, server, tb) = FakeMailbox::with_box(-7200).await;
    fake.set(|s| s.time_lie = -500);
    let client = client_for(&server);
    let mut session = open(&client, &tb).await;
    assert!(client.list(&mut session, 0).await.unwrap().messages.is_empty());
    let nonces = nonces(&server);
    assert_eq!(signed_targets(&server).len(), 2);
    assert_ne!(nonces[0], nonces[1]);
    client.list(&mut session, 0).await.unwrap();
    assert_eq!(signed_targets(&server).len(), 3, "the session now signs with the corrected time");
}

#[tokio::test]
async fn rejection_without_date_asks_the_time_again() {
    let (fake, server, tb) = FakeMailbox::with_box(0).await;
    fake.set(|s| (s.reject_next, s.omit_date) = (1, true));
    let client = client_for(&server);
    let mut session = open(&client, &tb).await;
    client.list(&mut session, 0).await.unwrap();
    let targets: Vec<_> = server.requests().into_iter().map(|r| r.target).collect();
    let list = list_path(&tb.addr_key, 0);
    assert_eq!(targets, [TIME_PATH, &list, TIME_PATH, &list]);
}

#[tokio::test]
async fn second_rejection_is_not_retried() {
    let (fake, server, tb) = FakeMailbox::with_box(0).await;
    fake.set(|s| s.reject_next = 5);
    let client = client_for(&server);
    let mut session = open(&client, &tb).await;
    let result = client.list(&mut session, 0).await;
    assert_eq!((result, signed_targets(&server).len()), (Err(MailError::Unauthorized), 2));
}

#[tokio::test]
async fn requests_of_a_session_keep_the_pace() {
    let (_fake, server, tb) = FakeMailbox::with_box(0).await;
    let pace = Duration::from_millis(150);
    let client = client_with(&server, ClientConfig { pace, pace_jitter: Duration::from_millis(50), ..NO_PACE });
    let mut session = open(&client, &tb).await;
    let started = Instant::now();
    for _ in 0..4 {
        client.list(&mut session, 0).await.unwrap();
    }
    assert!(started.elapsed() >= pace * 3);
}

#[tokio::test]
async fn short_busy_is_waited_for_and_retried() {
    let (fake, server, tb) = FakeMailbox::with_box(0).await;
    let id = fake.deliver(&tb, b"x");
    fake.set(|s| s.busy_next = 1);
    let client = client_for(&server);
    let mut session = open(&client, &tb).await;
    let started = Instant::now();
    assert!(client.download(&mut session, &listed(&id)).await.is_ok());
    assert!(started.elapsed() >= Duration::from_secs(1));
    assert_eq!(signed_targets(&server).len(), 2);
}

#[tokio::test]
async fn busy_beyond_the_policy_is_returned() {
    let (fake, server, tb) = FakeMailbox::with_box(0).await;
    fake.set(|s| (s.busy_next, s.retry_after) = (1, 60));
    let client = client_for(&server);
    let mut session = open(&client, &tb).await;
    assert_eq!(client.list(&mut session, 0).await, Err(MailError::Busy { retry_after: 60 }));
    fake.set(|s| (s.busy_next, s.retry_after) = (2, 1));
    let client = client_with(&server, ClientConfig { busy_retries: 1, ..NO_PACE });
    assert_eq!(client.list(&mut session, 0).await, Err(MailError::Busy { retry_after: 1 }));
}

#[tokio::test]
async fn download_limit_is_the_listed_bucket() {
    let (fake, server, tb) = FakeMailbox::with_box(0).await;
    let id = fake.deliver(&tb, &[b'x'; 5000]);
    let client = client_for(&server);
    let mut session = open(&client, &tb).await;
    let too_large = Err(MailError::Transport(TransportError::TooLarge));
    assert_eq!(client.download(&mut session, &listed(&id)).await, too_large);
    let bucket = ListedMessage { size: 8192, ..listed(&id) };
    assert_eq!(client.download(&mut session, &bucket).await.unwrap().len(), 8192 + 62);
}

#[tokio::test]
async fn statuses_without_retry() {
    let (fake, server, tb) = FakeMailbox::with_box(0).await;
    let client = client_for(&server);
    let mut session = open(&client, &tb).await;
    assert_eq!(client.download(&mut session, &listed(&"0".repeat(32))).await, Err(MailError::NotFound));
    fake.set(|s| s.fail_next = 1);
    assert_eq!(client.list(&mut session, 0).await, Err(MailError::Protocol));
}

#[tokio::test]
async fn invalid_inputs_never_reach_the_network() {
    let (_fake, server, tb) = FakeMailbox::with_box(0).await;
    let client = client_for(&server);
    let mut session = open(&client, &tb).await;
    assert_eq!(client.download(&mut session, &listed("../../time")).await, Err(MailError::Protocol));
    assert_eq!(client.list(&mut session, MAX_CURSOR + 1).await, Err(MailError::Protocol));
    assert_eq!(server.requests().len(), 1, "only the time");
}

#[tokio::test]
async fn bad_time_replies_are_protocol_errors() {
    for reply in [
        Reply::new(200).body("{\"time\":\"ayer\"}"),
        Reply::new(200).body(format!("{{\"time\":{}}}", MAX_TIMESTAMP + 1)),
        Reply::new(503),
    ] {
        let server = TestServer::start(move |_| reply.clone()).await;
        assert_eq!(client_for(&server).server_time().await, Err(MailError::Protocol));
    }
}

#[test]
fn page_validation() {
    let id = "ab".repeat(16);
    let page = |messages: &str, next: u64| format!("{{\"messages\":[{messages}],\"next\":{next}}}");
    let entry = |id: &str, size: u64, at: i64| format!("{{\"id\":\"{id}\",\"size\":{size},\"receivedAt\":{at}}}");
    let good = entry(&id, 4096, 3600);
    assert!(parse_page(page(&good, 6).as_bytes(), 5).is_ok());
    assert!(parse_page(page(&entry(&id, 1 << 25, 0), 6).as_bytes(), 5).is_ok());
    assert!(parse_page(page("", 5).as_bytes(), 5).is_ok());
    let full = vec![good.clone(); MAX_PAGE_ENTRIES].join(",");
    assert!(parse_page(page(&full, 1005).as_bytes(), 5).is_ok());
    for (body, since) in [
        (page(&good, 5), 5),
        (page("", 6), 5),
        (page("", 4), 5),
        (page(&entry("AB", 4096, 0), 6), 5),
        (page(&entry(&id.to_uppercase(), 4096, 0), 6), 5),
        (page(&good, MAX_CURSOR + 1), 5),
        (page(&entry(&id, 4097, 0), 6), 5),
        (page(&entry(&id, 2048, 0), 6), 5),
        (page(&entry(&id, 1 << 26, 0), 6), 5),
        (page(&entry(&id, 4096, -1), 6), 5),
        (page(&entry(&id, 4096, 1 << 53), 6), 5),
        (page(&format!("{full},{good}"), 2000), 5),
        ("no es json".to_owned(), 0),
    ] {
        assert_eq!(
            parse_page(body.as_bytes(), since),
            Err(MailError::Protocol),
            "{since} {}",
            &body[..80.min(body.len())]
        );
    }
}

/// Against the real server (devnet): `NIGHTMAIL_MAILBOX_URL=http://127.0.0.1:8787 cargo test -- --ignored real_server`.
/// Server time and the signature of a nonexistent address: the server cannot tell it from a bad signature, so it
/// must answer 401 twice (with the `Date` retry) and nothing more.
#[tokio::test]
#[ignore = "needs the devnet server running"]
async fn real_server_time_and_rejection_of_an_unknown_address() {
    let url = std::env::var("NIGHTMAIL_MAILBOX_URL").unwrap_or_else(|_| "http://127.0.0.1:8787".into());
    let transport = Arc::new(Transport::direct(&TransportConfig::default()).unwrap());
    let client = MailboxClient::new(transport, BaseUrl::parse(&url).unwrap(), ClientConfig::default());
    let tb = TestBox::new(0xee);
    let mut session = open(&client, &tb).await;
    assert!(session.clock.server_time.abs_diff(local_now() as u64) < 24 * 3600);
    assert_eq!(client.list(&mut session, 0).await, Err(MailError::Unauthorized));
}

#[test]
fn message_ids() {
    assert!(is_message_id(&"0123456789abcdef".repeat(2)));
    assert!(!is_message_id(&"0".repeat(31)));
    assert!(!is_message_id(&format!("{}g", "0".repeat(31))));
}

#[test]
fn errors_have_fixed_messages() {
    let all = [
        (MailError::Transport(TransportError::Timeout), "the server did not answer in time"),
        (MailError::Unauthorized, "the mailbox server rejected the request"),
        (MailError::Busy { retry_after: 3 }, "the mailbox server is busy"),
        (MailError::NotFound, "message not found"),
        (MailError::Protocol, "invalid mailbox server response"),
        (MailError::Store, "local store error"),
    ];
    for (error, text) in all {
        assert_eq!(error.to_string(), text);
    }
}
