//! End to end on the devnet: two profiles write to each other through NightMail.
//!
//! Profiles A and B (temporary folders) each get a free plan and a mailbox through the real Issuer and relayer. A
//! sends to B; B syncs and sees it sealed end to end with the sender checked, subject and body intact, and A has it
//! in «Sent» as `sent`. B answers A the same way. Then the refusals: an address that does not exist, a mail over
//! 25 MiB, an envelope over the server's largest one, a box the server does not know, and the same mail (same
//! Message-ID) delivered twice, which B keeps once. Times are printed for the address creation, the sending and the
//! receiving.
//!
//! Needs the devnet, the payer and the mail server running (`NIGHTMAIL_NETWORK=undeployed`), with the delivery route
//! (`POST /v1/box/<addrKey>/deliver`), `node` 24 on the PATH and `NIGHTMAIL_ISSUER_RECEIPT_KEY`. The Mailbox API is
//! `NIGHTMAIL_API_URL` (default `http://127.0.0.1:8787`). `tools/dev/e2e-send.sh` sets all of that up and runs:
//! `cargo test --lib app::e2e_send -- --ignored --nocapture`.

use std::sync::Arc;
use std::time::{Duration, Instant};

use zeroize::Zeroizing;

use super::e2e::{PASSWORD, fresh_name, real_app, when_usable};
use super::send::{SentQuery, SentStatusView};
use super::tests::private_tempdir;
use super::*;
use crate::mail::client::{ClientConfig, MailboxClient};
use crate::mail::e2e::{self as mail_e2e, MAX_MAIL_LENGTH, OutgoingMail, Party};
use crate::mail::send::{SendContext, SendError, outcome};
use crate::store::{SendFailure, SentState};
use crate::transport::{BaseUrl, TransportConfig};

/// Deadline for a mail to reach the other profile.
const MAIL_WAIT: Duration = Duration::from_secs(180);

/// One profile: its app, session and mailbox.
struct Profile {
    _dir: Option<tempfile::TempDir>,
    app: App,
    session: Arc<Session>,
    mailbox: AddressView,
}

/// The profile's folder: `$NIGHTMAIL_E2E_PROFILES/<label>` (kept, reused on the next run), or a temporary one.
fn profile_dir(label: &str) -> (Option<tempfile::TempDir>, std::path::PathBuf) {
    match std::env::var_os("NIGHTMAIL_E2E_PROFILES") {
        Some(root) => {
            let path = std::path::PathBuf::from(root).join(label);
            std::fs::create_dir_all(&path).unwrap();
            fsutil::ensure_private_dir(&path).unwrap();
            (None, path)
        }
        None => {
            let dir = private_tempdir();
            let path = dir.path().to_path_buf();
            (Some(dir), path)
        }
    }
}

/// A profile with a mailbox: a kept one that already has it, or a new seed with a plan and a new mailbox. Returns it
/// and how long the address took (`None`: reused). The plan is the free one; once the Issuer's free plans for this
/// IP are used up for the day, the simulated card.
async fn profile(label: &str) -> (Profile, Option<Duration>) {
    let (dir, path) = profile_dir(label);
    let app = real_app(&path);
    let password = || Secret(Zeroizing::new(PASSWORD.into()));
    if app.status().await.has_seed {
        app.unlock(password()).await.unwrap_or_else(|e| panic!("{label}: unlock: {e:?}"));
    } else {
        app.create_seed(password()).await.unwrap();
    }
    let session = app.session().await.unwrap();
    let kept = session.addresses().await.unwrap().into_iter().find(|a| a.name.is_some() && !a.display.is_empty());
    if let Some(mailbox) = kept {
        eprintln!("{label}: reusing mailbox {}", mailbox.display);
        return (Profile { _dir: dir, app, session, mailbox }, None);
    }

    let started = Instant::now();
    // A kept profile may have its plan already (a run stopped before the mailbox).
    if session.plan().await.unwrap().bonos.is_empty() {
        match session.free_plan(1).await {
            Ok(_) => {}
            Err(AppError::Orch(OrchError::RateLimited { .. })) => {
                eprintln!("{label}: no free plan left for this IP today, paying with the simulated card");
                session.pay_fiat(PeriodInput::Monthly, 1).await.unwrap_or_else(|e| panic!("{label}: card: {e:?}"));
            }
            Err(e) => panic!("{label}: free plan: {e:?}"),
        }
    }
    let name = fresh_name();
    let mut attempts = 0;
    let mailbox = loop {
        match when_usable(|| session.create_mailbox(name.clone(), 2)).await {
            // The relayer spaces out the addresses created from one IP: both profiles share it.
            Err(AppError::Orch(OrchError::RateLimited { retry_after_s })) if attempts < 5 => {
                attempts += 1;
                eprintln!("{label}: the relayer asks to wait {retry_after_s} s");
                tokio::time::sleep(Duration::from_secs(retry_after_s.min(600) + 1)).await;
            }
            other => break other.unwrap_or_else(|e| panic!("{label}: mailbox: {e:?}")),
        }
    };
    let took = started.elapsed();
    eprintln!("{label}: mailbox {} ready in {took:.1?}", mailbox.display);
    (Profile { _dir: dir, app, session, mailbox }, Some(took))
}

/// A word that makes this run's subjects unique (kept profiles keep earlier runs' mail).
fn run_tag() -> String {
    let mut bytes = [0u8; 4];
    getrandom::fill(&mut bytes).unwrap();
    hex::encode(bytes)
}

/// How many listed mails have that subject.
fn with_subject(list: &[MessageView], subject: &str) -> usize {
    list.iter().filter(|m| m.subject.as_deref() == Some(subject)).count()
}

/// Waits until the profile's list passes `done` (asking MailSync for rounds); returns it.
async fn wait_until(session: &Session, done: impl Fn(&[MessageView]) -> bool) -> Vec<MessageView> {
    let start = Instant::now();
    loop {
        session.sync_now();
        let list = session.messages(MessageQuery::default()).await.unwrap();
        if done(&list) {
            return list;
        }
        assert!(start.elapsed() < MAIL_WAIT, "the mail did not arrive in time ({} listed)", list.len());
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

async fn wait_for_subject(session: &Session, subject: &str) -> Vec<MessageView> {
    wait_until(session, |list| list.iter().any(|m| m.subject.as_deref() == Some(subject))).await
}

/// Sends, checks the stored state, and returns how long `send_mail` took.
async fn send(from: &Profile, to: &str, subject: &str, body: &str) -> (SentView, Duration) {
    let started = Instant::now();
    let sent = from
        .session
        .send_mail(from.mailbox.addr_key.clone(), to.into(), subject.into(), Secret(Zeroizing::new(body.into())))
        .await
        .expect("send_mail");
    (sent, started.elapsed())
}

/// The newest received mail with that subject, opened: it is sealed end to end by `from`, with the sender checked,
/// for `to`, with exactly that body.
async fn check_received(to: &Profile, from: &Profile, list: &[MessageView], subject: &str, body: &str) {
    let view = list.iter().find(|m| m.subject.as_deref() == Some(subject)).expect("the mail is listed");
    assert!(view.e2e, "sealed end to end by the sender");
    assert!(view.sender_verified, "sender checked against the registry");
    assert_eq!(view.addr_key, to.mailbox.addr_key, "in the recipient's mailbox");
    assert!(view.from.as_deref().is_some_and(|f| f.contains(&from.mailbox.display)), "from the sender's address");
    let detail = to.session.message(view.id).await.unwrap();
    assert!(!detail.unreadable && !detail.truncated);
    assert_eq!(detail.text.as_deref(), Some(body), "body intact");
    // The parser writes an address without a display name as `<address>`.
    assert_eq!(detail.to, [format!("<{}>", to.mailbox.display)]);
}

/// The sent message with that subject: in «Sent» as `sent`, from and to the right addresses.
async fn check_sent(from: &Profile, to: &Profile, subject: &str, body: &str) {
    let list = from.session.list_sent(SentQuery::default()).await.unwrap();
    let sent = list.iter().find(|m| m.subject == subject).expect("in Sent");
    assert_eq!((sent.status, sent.failure), (SentStatusView::Sent, None));
    assert_eq!((sent.from.as_str(), sent.to.as_str()), (from.mailbox.display.as_str(), to.mailbox.display.as_str()));
    assert_eq!(sent.addr_key, from.mailbox.addr_key);
    assert_eq!(from.session.get_sent(sent.id).await.unwrap().body, body);
}

fn mailbox_client(app: &App) -> MailboxClient {
    let transport = Arc::new(Transport::direct(&TransportConfig::default()).unwrap());
    MailboxClient::new(transport, app.config.mail_api.clone(), ClientConfig::default())
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the devnet, the payer and the server with the delivery route (see the header)"]
async fn two_addresses_write_to_each_other_on_devnet() {
    let started = Instant::now();
    let base = std::env::var("NIGHTMAIL_API_URL").unwrap_or_else(|_| "http://127.0.0.1:8787".into());
    eprintln!("Mailbox API {base}");
    assert!(BaseUrl::parse(&base).is_ok(), "NIGHTMAIL_API_URL");

    // 1. Two profiles, one mailbox each, created at the same time.
    let ((a, a_took), (b, b_took)) = tokio::join!(profile("A"), profile("B"));

    // 2. A writes to B.
    let tag = run_tag();
    let subject = format!("Hola desde A {tag}");
    let body = "Hola, B.\r\nEsto va cifrado de punta a punta.\r\nA.";
    let (sent, send_took) = send(&a, &b.mailbox.display, &subject, body).await;
    assert_eq!((sent.status, sent.failure), (SentStatusView::Sent, None), "the server took it");
    let receiving = Instant::now();
    let list = wait_for_subject(&b.session, &subject).await;
    let receive_took = receiving.elapsed();
    assert_eq!(with_subject(&list, &subject), 1);
    check_received(&b, &a, &list, &subject, body).await;
    check_sent(&a, &b, &subject, body).await;
    eprintln!("A → B: sent in {send_took:.1?}, received in {receive_took:.1?}");

    // 3. B answers A, written as the user would (other case, spaces around).
    let reply_subject = format!("Re: {subject}");
    let reply_body = "Recibido, A.\r\nUn saludo.";
    let to_a = format!("  {}  ", a.mailbox.display.to_uppercase());
    let (reply, reply_send_took) = send(&b, &to_a, &reply_subject, reply_body).await;
    assert_eq!(reply.status, SentStatusView::Sent);
    let receiving = Instant::now();
    let list = wait_for_subject(&a.session, &reply_subject).await;
    let reply_receive_took = receiving.elapsed();
    check_received(&a, &b, &list, &reply_subject, reply_body).await;
    check_sent(&b, &a, &reply_subject, reply_body).await;
    eprintln!("B → A: sent in {reply_send_took:.1?}, received in {reply_receive_took:.1?}");

    // 4. An address that does not exist: refused before anything is stored or sent.
    let sent_before = a.session.count_sent(None).await.unwrap();
    let nobody = format!("{}@{}", fresh_name(), a.app.config.mail_domain);
    let error = a
        .session
        .send_mail(a.mailbox.addr_key.clone(), nobody, "Hola".into(), Secret(Zeroizing::new("x".into())))
        .await
        .unwrap_err();
    assert_eq!(error, AppError::Send(SendError::RecipientNotFound));
    // A mail over 25 MiB: refused the same way.
    let huge = "a".repeat(MAX_MAIL_LENGTH + 1);
    let error = a
        .session
        .send_mail(a.mailbox.addr_key.clone(), b.mailbox.display.clone(), "Grande".into(), Secret(Zeroizing::new(huge)))
        .await
        .unwrap_err();
    assert_eq!(error, AppError::Send(SendError::MessageTooLarge));
    assert_eq!(a.session.count_sent(None).await.unwrap(), sent_before, "nothing stored");

    // 5. The server's own refusals, through the delivery route: a box it does not know, and an envelope longer than
    //    the largest one.
    let client = mailbox_client(&a.app);
    let b_key: [u8; 32] = hex::decode(&b.mailbox.addr_key).unwrap().try_into().unwrap();
    let stray = crate::crypto::seal_envelope(&[0x42; 32], b"x").unwrap();
    let mut unknown = [0u8; 32];
    getrandom::fill(&mut unknown).unwrap();
    assert_eq!(outcome(client.deliver(&unknown, stray).await).0, SentState::Failed(SendFailure::NoRecipient));
    let oversized = vec![1u8; 32 * 1024 * 1024 + 64 * 1024];
    let (state, _) = outcome(client.deliver(&b_key, oversized).await);
    eprintln!("oversized envelope: {state:?}");
    assert_eq!(state, SentState::Failed(SendFailure::TooLarge));

    // 6. The same mail (same Message-ID and date) delivered again, as a retry or a server that replays it: B keeps
    //    one. A later mail shows when B has gone past the copy.
    let first = a.session.list_sent(SentQuery::default()).await.unwrap();
    let first = first.iter().find(|m| m.subject == subject).unwrap();
    let stored = a.session.store.get_sent(first.id).unwrap().unwrap();
    let a_address = a.session.store.get_address(&stored.summary.addr_key).unwrap().unwrap();
    let auth_seed = SendContext::auth_seed(a.session.as_ref(), &a_address).unwrap();
    let recipient = SendContext::resolve_recipient(a.session.as_ref(), &stored.summary.to_addr).await.unwrap();
    let again = OutgoingMail {
        message_id: stored.summary.message_id,
        date: u64::try_from(stored.summary.sent_at).unwrap(),
        sender: Party { addr_key: stored.summary.addr_key, address: &stored.summary.from_addr },
        recipient: Party { addr_key: recipient.addr_key, address: &recipient.address },
        subject: &stored.summary.subject,
        body: &stored.body,
    };
    let envelope = mail_e2e::seal_mail(&auth_seed, &recipient.enc_pk, &again).unwrap();
    assert_eq!(outcome(client.deliver(&recipient.addr_key, envelope).await).0, SentState::Sent, "the server takes it");
    // A retry of a message already sent sends nothing.
    assert_eq!(a.session.retry_sent(first.id).await.unwrap().status, SentStatusView::Sent);
    let marker = format!("Marca {tag}");
    send(&a, &b.mailbox.display, &marker, "Después de la copia.").await;
    let list = wait_for_subject(&b.session, &marker).await;
    assert_eq!((with_subject(&list, &subject), with_subject(&list, &marker)), (1, 1), "the copy is not shown twice");

    eprintln!(
        "times: mailbox A {a_took:.1?}, mailbox B {b_took:.1?} (in parallel, None: reused); A → B sent {send_took:.1?}, received \
         {receive_took:.1?}; B → A sent {reply_send_took:.1?}, received {reply_receive_took:.1?}; total {:.1?}",
        started.elapsed()
    );
    a.app.shutdown().await;
    b.app.shutdown().await;
}
