//! Application layer tests without Midnight (sidecar unavailable): seed, session and local mail.

use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use super::*;
use zeroize::Zeroizing;
use crate::protocol::InitializeParams;
use crate::store::{Address, NewMessage, ParsedFields, SlotKind};
use crate::transport::TransportConfig;

const R: &str = "0a739f66e79db0e112edf84dd6569ad674f2c60f6f116d72d2de37f14bf41587";
const KEY: &str = "sha256:2fbf047edf2f486015d47830036fdf78399dee92327208228329e63403590892";

fn secret(text: &str) -> Secret {
    Secret(Zeroizing::new(text.into()))
}

/// App on a temp directory, with the sidecar unavailable and events recorded.
fn make_app(dir: &std::path::Path) -> (App, Arc<StdMutex<Vec<AppEvent>>>) {
    let events = Arc::new(StdMutex::new(Vec::new()));
    let seen = Arc::clone(&events);
    (build_app(dir, Arc::new(move |e| seen.lock().unwrap().push(e))), events)
}

/// Events with their arrival time.
type TimedEvents = Arc<StdMutex<Vec<(Instant, AppEvent)>>>;

/// Like [`make_app`], with each event's time (to measure retry waits).
fn make_timed_app(dir: &std::path::Path) -> (App, TimedEvents) {
    make_timed_app_on(dir, CLOSED)
}

/// Like [`make_timed_app`], with the NightMail server (mail, relayer and Issuer) at `server`.
fn make_timed_app_on(dir: &std::path::Path, server: &str) -> (App, TimedEvents) {
    let events = Arc::new(StdMutex::new(Vec::new()));
    let seen = Arc::clone(&events);
    (build_app_on(dir, Arc::new(move |e| seen.lock().unwrap().push((Instant::now(), e))), server), events)
}

/// A closed port, so tests do not depend on a real NightMail server that may be running on the machine.
const CLOSED: &str = "http://127.0.0.1:9";

fn build_app(dir: &std::path::Path, sink: EventSink) -> App {
    build_app_on(dir, sink, CLOSED)
}

fn build_app_on(dir: &std::path::Path, sink: EventSink, server: &str) -> App {
    let env = |name: &str| match name {
        "NIGHTMAIL_REGISTRY_ADDRESS" => Some(R.to_string()),
        "NIGHTMAIL_ISSUER_RECEIPT_KEY" => Some(KEY.to_string()),
        "NIGHTMAIL_API_URL" | "NIGHTMAIL_RELAYER_URL" | "NIGHTMAIL_ISSUER_URL" => Some(server.to_string()),
        _ => None,
    };
    let config = AppConfig::devnet(dir.to_path_buf(), env, None).unwrap();
    let sidecar = Arc::new(SidecarSupervisor::new(Err("no sidecar in tests".into()), InitializeParams::devnet(false)));
    let transport = Arc::new(Transport::direct(&TransportConfig::default()).unwrap());
    App::new(config, sidecar, transport, sink)
}

/// Private (0700) temp directory, like the profile's.
pub(super) fn private_tempdir() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fsutil::ensure_private_dir(dir.path()).unwrap();
    dir
}

const MIME: &[u8] = b"From: Tienda <tienda@example.com>\r\nTo: juan.perez@nightmail.local\r\nSubject: Pedido\r\n\
Date: Thu, 19 Nov 2026 10:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nGracias por tu compra.\r\n";

#[tokio::test(flavor = "multi_thread")]
async fn seed_lifecycle_create_lock_unlock_reveal() {
    let dir = private_tempdir();
    let (app, _) = make_app(dir.path());
    assert_eq!(app.status().await, AppStatus { has_seed: false, unlocked: false });
    assert_eq!(app.unlock(secret("x")).await.unwrap_err(), AppError::Core(CoreError::NoSeed));

    let phrase = app.create_seed_now(secret("contraseña")).await.unwrap();
    assert_eq!(phrase.phrase.split(' ').count(), 24);
    assert_eq!(app.status().await, AppStatus { has_seed: true, unlocked: true });
    assert_eq!(app.create_seed_now(secret("otra")).await.unwrap_err(), AppError::Core(CoreError::AlreadyUnlocked));

    app.lock().await.unwrap();
    assert_eq!(app.session().await.err(), Some(AppError::Core(CoreError::NotUnlocked)));
    assert_eq!(app.unlock(secret("mala")).await.unwrap_err(), AppError::Core(CoreError::WrongPassword));
    app.unlock(secret("contraseña")).await.unwrap();
    assert_eq!(app.reveal_seed(secret("contraseña")).await.unwrap().phrase, phrase.phrase);
    assert_eq!(app.reveal_seed(secret("mala")).await.unwrap_err(), AppError::Core(CoreError::WrongPassword));
    app.shutdown().await;
}

/// The taskbar badge is decided and set while holding the session lock (a lock cannot slip in between decision and
/// image), and it follows the session: never opened, open, closed.
#[tokio::test(flavor = "multi_thread")]
async fn taskbar_badge_is_decided_under_the_session_lock() {
    use crate::badge::SessionNow;
    let dir = private_tempdir();
    let (app, _) = make_app(dir.path());
    let now = || {
        app.with_session_now(|now| {
            assert!(app.session.try_lock().is_err(), "the badge is set without the session lock");
            now
        })
    };
    assert_eq!(now().await, SessionNow::NeverOpened);
    app.create_seed_now(secret("contraseña")).await.unwrap();
    assert_eq!(now().await, SessionNow::Open);
    app.lock().await.unwrap();
    assert_eq!(now().await, SessionNow::Closed);
    // Afterwards the lock is free.
    assert!(app.session.try_lock().is_ok());
    app.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn change_password_needs_the_session_and_the_current_password() {
    let dir = private_tempdir();
    let (app, _) = make_app(dir.path());
    let change = |current: &str, new: &str| app.change_password(secret(current), secret(new));
    assert_eq!(change("x", "y").await.unwrap_err(), AppError::Core(CoreError::NotUnlocked));
    let phrase = app.create_seed_now(secret("contraseña")).await.unwrap();
    let seed_file = app.config.seed_dir().join(keys::SEED_FILE_NAME);
    let before = std::fs::read(&seed_file).unwrap();

    assert_eq!(change("mala", "nueva").await.unwrap_err(), AppError::Core(CoreError::WrongPassword));
    assert_eq!(change("contraseña", "").await.unwrap_err(), AppError::Core(CoreError::EmptyPassword));
    assert_eq!(std::fs::read(&seed_file).unwrap(), before, "a failed attempt leaves the file untouched");

    change("contraseña", "nueva").await.unwrap();
    // The session stays open and usable (database and keys do not depend on the password).
    app.session().await.unwrap().plan().await.unwrap();
    app.lock().await.unwrap();
    assert_eq!(app.unlock(secret("contraseña")).await.unwrap_err(), AppError::Core(CoreError::WrongPassword));
    assert_eq!(change("nueva", "otra").await.unwrap_err(), AppError::Core(CoreError::NotUnlocked));
    app.unlock(secret("nueva")).await.unwrap();
    assert_eq!(app.reveal_seed(secret("nueva")).await.unwrap().phrase, phrase.phrase);
    app.shutdown().await;
}

/// Midway through a password change, locking answers `sessionBusy` and app exit waits for it: when `shutdown`
/// returns the file is already the new one and no temp file is left.
#[tokio::test(flavor = "multi_thread")]
async fn lock_and_shutdown_respect_a_password_change_in_progress() {
    let dir = private_tempdir();
    let app = Arc::new(make_app(dir.path()).0);
    app.create_seed_now(secret("contraseña")).await.unwrap();
    let seed_dir = app.config.seed_dir().to_path_buf();
    let before = std::fs::read(seed_dir.join(keys::SEED_FILE_NAME)).unwrap();
    let session = app.session().await.unwrap();

    // The test holds the turn: the change gets in (already counted as in flight) and waits in the queue.
    let turn = app.password_change.lock().await;
    let changing = tokio::spawn({
        let app = Arc::clone(&app);
        async move { app.change_password(secret("contraseña"), secret("nueva")).await }
    });
    while lock_usage(&session.usage).active == 0 {
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    assert_eq!(app.lock().await.unwrap_err(), AppError::Core(CoreError::SessionBusy));
    drop(session);
    // Margin for the change to be queued (there is no await between counting the operation and asking for the turn).
    tokio::time::sleep(Duration::from_millis(20)).await;

    // Releasing the turn hands it to the change, first in the queue; `shutdown` waits behind it.
    drop(turn);
    app.shutdown().await;
    let temporaries = std::fs::read_dir(&seed_dir)
        .unwrap()
        .filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().ends_with(".tmp"))
        .count();
    assert_eq!(temporaries, 0, "no temporary file is left");
    assert_ne!(std::fs::read(seed_dir.join(keys::SEED_FILE_NAME)).unwrap(), before);
    changing.await.unwrap().unwrap();
    assert!(keys::unlock(&seed_dir, "nueva").is_ok());
    assert_eq!(keys::unlock(&seed_dir, "contraseña").err(), Some(keys::KeyError::Locked));
}

#[tokio::test(flavor = "multi_thread")]
async fn without_midnight_mail_still_works_and_chain_ops_fail_cleanly() {
    let dir = private_tempdir();
    let (app, _) = make_app(dir.path());
    app.create_seed_now(secret("contraseña")).await.unwrap();
    let session = app.session().await.unwrap();

    assert_eq!(session.free_plan(1).await.unwrap_err(), AppError::Orch(OrchError::MidnightUnavailable));
    let plan = session.plan().await.unwrap();
    assert_eq!((plan.bonos.len(), plan.mailboxes, plan.aliases), (0, Quota { used: 0, limit: 0 }, Quota { used: 0, limit: 0 }));
    assert!(session.addresses().await.unwrap().is_empty());

    // The address exists (the message references it); the server does not, so sync fails harmlessly.
    let address = Address {
        addr_key: [7; 32],
        kind: SlotKind::Mailbox,
        n: 0,
        j: 0,
        display: "juan@nightmail.local".into(),
        name: Some("juan".into()),
        created_at: 1,
    };
    session.store.with(move |s| s.insert_address(&address)).await.unwrap();
    assert_eq!(session.addresses().await.unwrap()[0].display, "juan@nightmail.local");
    let new = NewMessage {
        addr_key: [7; 32],
        server_id: "m1".into(),
        received_at: 100,
        size_bucket: 1,
        raw: MIME.to_vec(),
        parsed: ParsedFields::default(),
    };
    let id = session.store.with(move |s| s.insert_message(&new)).await.unwrap().unwrap();
    let list = session.messages(MessageQuery::default()).await.unwrap();
    assert_eq!((list.len(), list[0].subject.as_deref()), (1, None));

    let detail = session.message(id).await.unwrap();
    assert_eq!(detail.summary.subject.as_deref(), Some("Pedido"));
    assert!(detail.text.as_deref().unwrap().contains("Gracias"));
    assert!(!detail.unreadable && !detail.truncated);
    // Stored without fields and read fine: the list now has them.
    let list = session.messages(MessageQuery::default()).await.unwrap();
    assert_eq!(list[0].subject.as_deref(), Some("Pedido"));

    session.set_flags(id, FlagsInput { is_read: Some(true), ..Default::default() }).await.unwrap();
    assert!(session.messages(MessageQuery::default()).await.unwrap()[0].is_read);
    assert_eq!(session.message(id + 1).await.unwrap_err(), AppError::Core(CoreError::NotFound));
    assert_eq!(session.set_flags(id + 1, FlagsInput::default()).await.unwrap_err(), AppError::Core(CoreError::NotFound));

    // In bulk: a missing id leaves nothing half-done; too many is `InvalidInput`; valid ones all change.
    let archive = || FlagsInput { archived: Some(true), ..Default::default() };
    assert_eq!(session.set_flags_many(vec![id, id + 1], archive()).await.unwrap_err(), AppError::Core(CoreError::NotFound));
    let inbox = || MessageQuery { archived: Some(false), ..Default::default() };
    assert_eq!(session.messages(inbox()).await.unwrap().len(), 1);
    let too_many = vec![id; MAX_BULK_IDS + 1];
    assert_eq!(session.set_flags_many(too_many, archive()).await.unwrap_err(), AppError::Core(CoreError::InvalidInput));
    session.set_flags_many(vec![id], archive()).await.unwrap();
    assert!(session.messages(inbox()).await.unwrap().is_empty());
    app.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn without_midnight_the_sender_of_an_e2e_mail_is_looked_up_later() {
    let dir = private_tempdir();
    let (app, _) = make_app(dir.path());
    app.create_seed_now(secret("contraseña")).await.unwrap();
    let session = app.session().await.unwrap();
    // "Unavailable", not "not registered": the mail waits instead of being marked unverified.
    let answer = SessionSenders(&session).resolve_sender(&[2; 32], "ana@nightmail.local").await;
    assert_eq!(answer, Err(DirectoryError::RegistryUnavailable));
    app.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn abandon_address_hides_it_keeps_its_slot_and_stops_syncing_it() {
    let dir = private_tempdir();
    let (app, events) = make_app(dir.path());
    app.create_seed_now(secret("contraseña")).await.unwrap();
    let session = app.session().await.unwrap();
    let address = |key: u8, kind, j| Address {
        addr_key: [key; 32],
        kind,
        n: 0,
        j,
        display: format!("a{key}@nightmail.local"),
        name: Some(format!("a{key}")),
        created_at: 1,
    };
    session.store.with(move |s| s.insert_address(&address(7, SlotKind::Mailbox, 0))).await.unwrap();
    session.store.with(move |s| s.insert_address(&address(8, SlotKind::Alias, 0))).await.unwrap();
    assert_eq!(session.addresses().await.unwrap().len(), 2);
    let key = hex::encode([7u8; 32]);

    session.abandon_address(key.clone()).await.unwrap();
    let left = session.addresses().await.unwrap();
    assert_eq!(left.iter().map(|a| a.display.as_str()).collect::<Vec<_>>(), ["a8@nightmail.local"]);
    let plan = session.plan().await.unwrap();
    assert_eq!((plan.mailboxes.used, plan.mailboxes_abandoned, plan.aliases.used, plan.aliases_abandoned), (1, 1, 1, 0));
    // Sync no longer requests it.
    let targets = session.targets().await.unwrap();
    assert_eq!(targets.len(), 1);
    let seen = wait_event(&events, |e| matches!(e, AppEvent::AddressesChanged)).await;
    assert_eq!(seen.iter().filter(|e| matches!(e, AppEvent::AddressesChanged)).count(), 1);

    // Repeating changes nothing and does not notify again. Missing or malformed: error.
    session.abandon_address(key).await.unwrap();
    assert_eq!(events.lock().unwrap().iter().filter(|e| matches!(e, AppEvent::AddressesChanged)).count(), 1);
    assert_eq!(session.abandon_address(hex::encode([9u8; 32])).await.unwrap_err(), AppError::Core(CoreError::NotFound));
    assert_eq!(session.abandon_address("zz".into()).await.unwrap_err(), AppError::Core(CoreError::InvalidInput));
    assert_eq!(session.abandon_address("11".repeat(33)).await.unwrap_err(), AppError::Core(CoreError::InvalidInput));
    assert_eq!(session.plan().await.unwrap().mailboxes_abandoned, 1);
    app.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_mail_of_an_abandoned_address_is_hidden_and_it_cannot_be_named() {
    let dir = private_tempdir();
    let (app, _) = make_app(dir.path());
    app.create_seed_now(secret("contraseña")).await.unwrap();
    let session = app.session().await.unwrap();
    // A restored mailbox without a name (`used` slot) and an alias, each with an unread message.
    let mailbox = Address {
        addr_key: [7; 32],
        kind: SlotKind::Mailbox,
        n: 0,
        j: 0,
        display: String::new(),
        name: None,
        created_at: 1,
    };
    let alias = Address { addr_key: [8; 32], kind: SlotKind::Alias, display: "a8@nightmail.local".into(), ..mailbox.clone() };
    let key = crate::store::SlotKey { n: 0, kind: SlotKind::Mailbox, j: 0 };
    let used = crate::store::Slot {
        key,
        slot_nul: [5; 32],
        status: SlotStatus::Used,
        addr_key: Some([7; 32]),
        round: None,
        pending_name: None,
        reserve_attempts: 0,
        reveal_attempts: 0,
        updated_at: 0,
    };
    session
        .store
        .with(move |s| {
            s.insert_address(&mailbox)?;
            s.insert_address(&alias)?;
            s.insert_slot(&used)
        })
        .await
        .unwrap();
    let message = |addr: u8, server_id: &str| NewMessage {
        addr_key: [addr; 32],
        server_id: server_id.into(),
        received_at: 100,
        size_bucket: 1,
        raw: MIME.to_vec(),
        parsed: ParsedFields::default(),
    };
    let (m7, m8) = (message(7, "m7"), message(8, "m8"));
    let hidden = session.store.with(move |s| s.insert_message(&m7)).await.unwrap().unwrap();
    session.store.with(move |s| s.insert_message(&m8)).await.unwrap();
    assert_eq!(session.messages(MessageQuery::default()).await.unwrap().len(), 2);

    session.abandon_address(hex::encode([7u8; 32])).await.unwrap();
    // Its mail no longer shows or counts as unread, and requesting it by its old id neither opens nor changes it.
    let list = session.messages(MessageQuery::default()).await.unwrap();
    assert_eq!(list.iter().map(|m| m.addr_key.as_str()).collect::<Vec<_>>(), [hex::encode([8u8; 32])]);
    assert_eq!(list.iter().filter(|m| !m.is_read).count(), 1);
    assert_eq!(session.message(hidden).await.unwrap_err(), AppError::Core(CoreError::NotFound));
    let read = || FlagsInput { is_read: Some(true), ..Default::default() };
    assert_eq!(session.set_flags(hidden, read()).await.unwrap_err(), AppError::Core(CoreError::NotFound));
    assert_eq!(session.set_flags_many(vec![hidden], read()).await.unwrap_err(), AppError::Core(CoreError::NotFound));
    // Nor can it be named (checked before touching Midnight, which is absent here).
    let named = session.provide_name(SlotId::from(key), "ana".into(), 1).await;
    assert_eq!(named.unwrap_err(), AppError::Core(CoreError::NotFound));
    app.shutdown().await;
}

/// Waits (at most 2 s) for an event matching `pred`.
async fn wait_event(events: &StdMutex<Vec<AppEvent>>, pred: impl Fn(&AppEvent) -> bool) -> Vec<AppEvent> {
    for _ in 0..100 {
        if events.lock().unwrap().iter().any(&pred) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    events.lock().unwrap().clone()
}

#[tokio::test(flavor = "multi_thread")]
async fn restore_leaves_recovery_pending_until_recover_succeeds() {
    let dir = private_tempdir();
    let (app, _) = make_app(dir.path());
    let phrase = app.create_seed_now(secret("uno")).await.unwrap();
    app.shutdown().await;

    let clean = private_tempdir();
    let (restored, events) = make_app(clean.path());
    restored.restore_seed(secret(&phrase.phrase), secret("dos")).await.unwrap();
    assert_eq!(restored.status().await, AppStatus { has_seed: true, unlocked: true });
    let session = restored.session().await.unwrap();
    // Not restored: no plan or addresses (slots already used on chain must not be spent).
    let pending = AppError::Core(CoreError::RecoveryPending);
    assert_eq!(session.free_plan(1).await.unwrap_err(), pending);
    assert_eq!(session.create_alias(2).await.unwrap_err(), pending);
    assert_eq!(session.create_mailbox("juan".into(), 3).await.unwrap_err(), pending);
    assert_eq!(restored.recover(4).await.unwrap_err(), AppError::Orch(OrchError::MidnightUnavailable));
    // Unlocking again retries the restore (not `resume`).
    restored.lock().await.unwrap();
    restored.unlock(secret("dos")).await.unwrap();
    let seen = wait_event(&events, |e| matches!(e, AppEvent::RecoverFailed { .. })).await;
    assert!(seen.contains(&AppEvent::RecoverFailed { error: OrchError::MidnightUnavailable }), "{seen:?}");
    assert!(!seen.iter().any(|e| matches!(e, AppEvent::ResumeFailed { .. })));
    restored.shutdown().await;

    let other = private_tempdir();
    let (bad, _) = make_app(other.path());
    let err = bad.restore_seed(secret("no es una frase"), secret("dos")).await.unwrap_err();
    assert_eq!(err, AppError::Core(CoreError::InvalidPhrase));
    assert_eq!(bad.status().await, AppStatus { has_seed: false, unlocked: false });
}

fn resume_failures(events: &StdMutex<Vec<AppEvent>>) -> usize {
    events.lock().unwrap().iter().filter(|e| matches!(e, AppEvent::ResumeFailed { .. })).count()
}

/// Waits (at most 2 s) until `done` holds.
async fn wait_until(done: impl Fn() -> bool) {
    for _ in 0..100 {
        if done() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

/// Like [`wait_until`], up to 10 s: for nominal waits of hundreds of ms on a loaded machine. It only extends the
/// deadline; the tests' timing bounds are unchanged.
async fn wait_long(done: impl Fn() -> bool) {
    for _ in 0..500 {
        if done() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

/// A half-done alias in the store (as if the app had closed midway).
async fn half_done_alias(session: &Session) {
    let slot = crate::store::Slot {
        key: crate::store::SlotKey { n: 0, kind: SlotKind::Alias, j: 0 },
        slot_nul: [7; 32],
        status: SlotStatus::Reserving,
        addr_key: None,
        round: None,
        pending_name: None,
        reserve_attempts: 0,
        reveal_attempts: 0,
        updated_at: 0,
    };
    session.store.with(move |s| s.insert_slot(&slot)).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn without_pending_work_unlock_does_not_start_midnight() {
    let dir = private_tempdir();
    let (app, events) = make_app(dir.path());
    app.create_seed_now(secret("clave")).await.unwrap();
    app.lock().await.unwrap();
    app.unlock(secret("clave")).await.unwrap();
    let session = app.session().await.unwrap();
    // The requested turn (at unlock, or "Retry now") still yields an empty report: the UI clears the old notice and
    // the button does not stay on "Retrying…".
    let empty = AppEvent::Resumed { report: ResumeReport::default() };
    wait_until(|| events.lock().unwrap().contains(&empty)).await;
    wait_until(|| !session.resume_state().running).await;
    assert!(!session.resume_state().running, "nothing half-done: the loop ends");
    assert_eq!(resume_failures(&events), 0, "with no work, Midnight is not called and no failure is reported");
    assert_eq!(events.lock().unwrap().iter().filter(|e| **e == empty).count(), 1);
    session.resume_now();
    wait_until(|| events.lock().unwrap().iter().filter(|e| **e == empty).count() == 2).await;
    assert_eq!(events.lock().unwrap().iter().filter(|e| **e == empty).count(), 2, "'Retry now' with nothing to do");
    app.shutdown().await;
}

/// If a failure notice is left with no work behind it (the user finished or abandoned the slot), the next turn
/// clears it with an empty report and the loop ends.
#[tokio::test(flavor = "multi_thread")]
async fn a_resume_notice_is_cleared_when_nothing_is_left() {
    let dir = private_tempdir();
    let (app, events) = make_app(dir.path());
    app.create_seed_now(secret("clave")).await.unwrap();
    let session = app.session().await.unwrap();
    half_done_alias(&session).await;
    session.resume_now();
    wait_until(|| resume_failures(&events) >= 1).await;
    let key = crate::store::SlotKey { n: 0, kind: SlotKind::Alias, j: 0 };
    assert!(session.store.with(move |s| s.abandon_reserving_slot(key, 0)).await.unwrap());
    wait_until(|| !session.resume_state().running).await;
    let seen = events.lock().unwrap().clone();
    assert_eq!(seen.last(), Some(&AppEvent::Resumed { report: ResumeReport::default() }), "{seen:?}");
    app.shutdown().await;
}

/// Every turn with a result announces itself first (`resumeStarted`), and each start notice is followed by its result
/// before the next one, so the UI knows when a turn is running, even one requested elsewhere (otherwise the notice
/// stayed unchanged after "Retry now" while the turn was already running).
#[tokio::test(flavor = "multi_thread")]
async fn every_resume_turn_announces_its_start_before_its_result() {
    let dir = private_tempdir();
    let (app, events) = make_app(dir.path());
    app.create_seed_now(secret("clave")).await.unwrap();
    let session = app.session().await.unwrap();
    // With nothing unfinished, the requested turn still announces its start.
    session.resume_now();
    wait_until(|| !session.resume_state().running).await;
    half_done_alias(&session).await;
    session.resume_now();
    wait_until(|| resume_failures(&events) >= 1).await;
    let seen: Vec<AppEvent> = events
        .lock()
        .unwrap()
        .iter()
        .filter(|e| matches!(e, AppEvent::ResumeStarted | AppEvent::Resumed { .. } | AppEvent::ResumeFailed { .. }))
        .cloned()
        .collect();
    assert!(seen.len() >= 4, "{seen:?}");
    let mut running = false;
    for e in &seen {
        let started = *e == AppEvent::ResumeStarted;
        assert_ne!(started, running, "start and result alternate, beginning with start: {seen:?}");
        running = started;
    }
    app.shutdown().await;
}

/// A turn cut short by a panic does not leave the UI on "Retrying…" (it sends a result). Cut short by the session
/// closing, it sends nothing.
#[tokio::test(flavor = "multi_thread")]
async fn a_turn_cut_short_still_sends_a_result_unless_the_session_is_closing() {
    let dir = private_tempdir();
    let (app, events) = make_app(dir.path());
    app.create_seed_now(secret("clave")).await.unwrap();
    let session = app.session().await.unwrap();
    wait_until(|| !session.resume_state().running).await;
    let cut = AppEvent::ResumeFailed { error: OrchError::Internal };
    let guard = |in_turn| ResumeRunning { session: Arc::clone(&session), armed: false, in_turn };
    drop(guard(false));
    assert!(!events.lock().unwrap().contains(&cut), "between rounds there is nothing to close");
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _running = guard(true);
        panic!("round cut short");
    }));
    assert!(panicked.is_err());
    assert_eq!(events.lock().unwrap().iter().filter(|e| **e == cut).count(), 1);
    session.stop.send_replace(true);
    drop(guard(true));
    assert_eq!(events.lock().unwrap().iter().filter(|e| **e == cut).count(), 1, "closing: nothing");
    app.shutdown().await;
}

/// The wait of ladder step `attempt` in tests.
fn step(attempt: usize) -> Duration {
    RESUME_SECOND * resume_retry_delay_s(attempt) as u32
}

/// Times of the `resumeFailed` events.
fn failure_times(events: &StdMutex<Vec<(Instant, AppEvent)>>) -> Vec<Instant> {
    let events = events.lock().unwrap();
    events.iter().filter(|(_, e)| matches!(e, AppEvent::ResumeFailed { .. })).map(|(t, _)| *t).collect()
}

/// A failed user operation starts the retry in waiting mode (first ladder step) and, with the loop already alive,
/// neither advances nor resets its ladder. Something that leaves nothing unfinished does not start it.
#[tokio::test(flavor = "multi_thread")]
async fn an_operation_failure_waits_for_the_ladder_and_never_advances_it() {
    let dir = private_tempdir();
    let (app, events) = make_timed_app(dir.path());
    app.create_seed_now(secret("clave")).await.unwrap();
    let session = app.session().await.unwrap();
    half_done_alias(&session).await;
    for error in [OrchError::Busy, OrchError::BonoNotReady { usable_at: None }, OrchError::NameTaken] {
        session.retry_later_if_needed::<()>(&Err(AppError::Orch(error)));
    }
    assert!(!session.resume_state().running, "busy, bonoNotReady or a taken name leave nothing half-done");
    let start = Instant::now();
    session.retry_later_if_needed::<()>(&Err(AppError::Orch(OrchError::StillPending)));
    assert!(session.resume_state().running, "starts in the waiting state");
    wait_long(|| !failure_times(&events).is_empty()).await;
    let first = failure_times(&events)[0];
    assert!(first - start >= step(0), "no immediate round: {:?}", first - start);
    // Another failure while waiting for the second step: it does not advance it.
    session.retry_later_if_needed::<()>(&Err(AppError::Orch(OrchError::StillPending)));
    wait_long(|| failure_times(&events).len() >= 2).await;
    let times = failure_times(&events);
    assert!(times[1] - times[0] >= step(1), "{:?}", times[1] - times[0]);
    app.shutdown().await;
}

/// The loop climbs the ladder (each wait longer than the previous) and "Retry now" resets it.
#[tokio::test(flavor = "multi_thread")]
async fn the_loop_climbs_the_ladder_and_a_request_restarts_it() {
    let dir = private_tempdir();
    let (app, events) = make_timed_app(dir.path());
    app.create_seed_now(secret("clave")).await.unwrap();
    half_done_alias(&app.session().await.unwrap()).await;
    app.lock().await.unwrap();
    app.unlock(secret("clave")).await.unwrap();
    let session = app.session().await.unwrap();
    wait_long(|| failure_times(&events).len() >= 3).await;
    session.resume_now();
    wait_long(|| failure_times(&events).len() >= 5).await;
    let t = failure_times(&events);
    assert!(t.len() >= 5, "{t:?}");
    assert!(t[1] - t[0] >= step(0) && t[2] - t[1] >= step(1), "{:?} {:?}", t[1] - t[0], t[2] - t[1]);
    assert!(t[3] - t[2] < step(2), "the request does not wait for the step");
    let after = t[4] - t[3];
    assert!(after >= step(0) && after < step(2), "the backoff ladder goes back to the first step: {after:?}");
    app.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn unlock_resumes_in_background_and_retries_while_midnight_is_down() {
    let dir = private_tempdir();
    let (app, events) = make_app(dir.path());
    app.create_seed_now(secret("clave")).await.unwrap();
    half_done_alias(&app.session().await.unwrap()).await;
    app.lock().await.unwrap();
    app.unlock(secret("clave")).await.unwrap();
    let seen = wait_event(&events, |e| matches!(e, AppEvent::ResumeFailed { .. })).await;
    assert!(seen.contains(&AppEvent::ResumeFailed { error: OrchError::MidnightUnavailable }), "{seen:?}");
    // Midnight may come back: the loop stays alive (waiting for its step) and "Retry now" advances it.
    let session = app.session().await.unwrap();
    assert!(session.resume_state().running, "retryable failure: the loop goes on");
    let before = resume_failures(&events);
    session.resume_now();
    wait_until(|| resume_failures(&events) > before).await;
    assert!(resume_failures(&events) > before, "one more round, without waiting for the ladder");
    assert!(session.resume_state().running);
    assert_eq!(session.pending_slots().await.unwrap_err(), AppError::Orch(OrchError::MidnightUnavailable));
    app.shutdown().await;
    wait_until(|| !session.resume_state().running).await;
    assert!(!session.resume_state().running, "the aborted task releases the flag");
    let closed = resume_failures(&events);
    session.resume_now();
    session.resume_later();
    tokio::time::sleep(step(0) + Duration::from_millis(100)).await;
    assert_eq!(resume_failures(&events), closed, "with the session closed nothing starts");
    assert!(!session.resume_state().running);
}

#[tokio::test(flavor = "multi_thread")]
async fn no_task_escapes_a_session_that_is_closing() {
    let dir = private_tempdir();
    let (app, events) = make_app(dir.path());
    app.create_seed_now(secret("clave")).await.unwrap();
    let session = app.session().await.unwrap();
    half_done_alias(&session).await;
    // Race: `close` has already set `stop` (and aborted the tasks) but `usage.closed` is not visible yet.
    session.stop.send_replace(true);
    session.resume_now();
    assert!(!session.resume_state().running, "not launched: the guard cleared the flag");
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert_eq!(resume_failures(&events), 0);
    app.shutdown().await;
}

/// While our server is not serving there are no turns (and no proofs), not even at ladder times; as soon as it
/// answers (the same check as the service status), one turn right away.
#[tokio::test(flavor = "multi_thread")]
async fn with_our_server_down_the_loop_waits_for_it_and_resumes_as_soon_as_it_answers() {
    use crate::mail::test_server::{Reply, TestServer};
    use std::sync::atomic::{AtomicBool, Ordering};
    let up = Arc::new(AtomicBool::new(false));
    let answers = Arc::clone(&up);
    let server = TestServer::start(move |_| Reply::new(if answers.load(Ordering::SeqCst) { 405 } else { 503 })).await;
    let dir = private_tempdir();
    let (app, events) = make_timed_app_on(dir.path(), &format!("http://{}", server.base.host()));
    app.create_seed_now(secret("clave")).await.unwrap();
    let session = app.session().await.unwrap();
    half_done_alias(&session).await;
    session.retry_later_if_needed::<()>(&Err(AppError::Orch(OrchError::ServerUnreachable)));
    assert!(session.resume_state().running);
    // Several checks (one per `SERVER_POLL_S`) and longer than the second step: no turn.
    let polls = || server.requests().iter().filter(|r| r.target == RELAYER_PING).count();
    wait_long(|| polls() >= 4).await;
    tokio::time::sleep(step(0) + step(1)).await;
    assert!(polls() >= 4, "checks whether it answers: {}", polls());
    assert_eq!(failure_times(&events).len(), 0, "no rounds while the server is down");
    let back = Instant::now();
    up.store(true, Ordering::SeqCst);
    wait_long(|| !failure_times(&events).is_empty()).await;
    let first = failure_times(&events)[0];
    assert!(first - back < step(0), "once it answers, a round right away: {:?}", first - back);
    assert!(server.requests().iter().all(|r| r.target == RELAYER_PING), "only the relayer is checked");
    app.shutdown().await;
}

/// An operation failing because the server is not serving, with the loop alive and waiting on a long step, switches
/// it to checking the server (every `SERVER_POLL_S`), and as soon as it answers, one turn right away.
#[tokio::test(flavor = "multi_thread")]
async fn a_server_failure_moves_a_waiting_loop_from_the_ladder_to_the_server_check() {
    use crate::mail::test_server::{Reply, TestServer};
    use std::sync::atomic::{AtomicBool, Ordering};
    let up = Arc::new(AtomicBool::new(false));
    let answers = Arc::clone(&up);
    let server = TestServer::start(move |_| Reply::new(if answers.load(Ordering::SeqCst) { 405 } else { 503 })).await;
    let dir = private_tempdir();
    let (app, events) = make_timed_app_on(dir.path(), &format!("http://{}", server.base.host()));
    app.create_seed_now(secret("clave")).await.unwrap();
    let session = app.session().await.unwrap();
    half_done_alias(&session).await;
    // A failure not caused by the server: the loop starts at the first step (without checking the server), runs its
    // turn (which fails: no Midnight) and waits for the second step.
    session.retry_later_if_needed::<()>(&Err(AppError::Orch(OrchError::StillPending)));
    wait_long(|| !failure_times(&events).is_empty()).await;
    assert!(server.requests().is_empty());
    let failed = Instant::now();
    session.retry_later_if_needed::<()>(&Err(AppError::Orch(OrchError::ServiceUnavailable)));
    let polls = || server.requests().iter().filter(|r| r.target == RELAYER_PING).count();
    wait_long(|| polls() >= 1).await;
    let checked = failed.elapsed();
    assert!(polls() >= 1 && checked < step(1) / 3, "switches to checking the server without waiting for the step: {checked:?}");
    up.store(true, Ordering::SeqCst);
    let back = Instant::now();
    wait_long(|| failure_times(&events).len() >= 2).await;
    let second = failure_times(&events)[1];
    assert!(second - back < step(0), "once it answers, a round right away: {:?}", second - back);
    app.shutdown().await;
}

/// With the server answering, repeated "server" failures of operations wake the loop but do not reset its step: the
/// turn comes on time.
#[tokio::test(flavor = "multi_thread")]
async fn repeated_server_failures_do_not_postpone_the_next_turn() {
    use crate::mail::test_server::{Reply, TestServer};
    let server = TestServer::start(|_| Reply::new(405)).await;
    let dir = private_tempdir();
    let (app, events) = make_timed_app_on(dir.path(), &format!("http://{}", server.base.host()));
    app.create_seed_now(secret("clave")).await.unwrap();
    let session = app.session().await.unwrap();
    half_done_alias(&session).await;
    session.retry_later_if_needed::<()>(&Err(AppError::Orch(OrchError::StillPending)));
    wait_long(|| !failure_times(&events).is_empty()).await;
    let first = failure_times(&events)[0];
    // For longer than the second step, a "server" failure every so often.
    while first.elapsed() < step(1) + step(0) {
        session.retry_later_if_needed::<()>(&Err(AppError::Orch(OrchError::ServiceUnavailable)));
        tokio::time::sleep(step(0) / 4).await;
    }
    let times = failure_times(&events);
    assert!(times.len() >= 2, "the second step's round arrived: {times:?}");
    assert!(times[1] - first < step(1) + step(0), "{:?}", times[1] - first);
    app.shutdown().await;
}

#[test]
fn resume_retry_waits_grow_slowly_and_stay_at_thirty_minutes() {
    let secs: Vec<u64> = (0..6).map(resume_retry_delay_s).collect();
    assert_eq!(secs, [120, 300, 900, 1800, 1800, 1800]);
}

#[test]
fn the_wait_respects_the_server_and_the_purchase_cleanup() {
    let hint = |not_before_s, due_in_s| RetryHint { pending: true, not_before_s, due_in_s, ..RetryHint::default() };
    assert_eq!(resume_wait_s(0, RetryHint::default()), 120);
    assert_eq!(resume_wait_s(0, hint(3600, None)), 3600, "what the relayer asked for");
    assert_eq!(resume_wait_s(3, hint(60, None)), 1800, "never before the step");
    assert_eq!(resume_wait_s(3, hint(0, Some(700))), 700, "the round that closes the purchase comes on time");
    assert_eq!(resume_wait_s(0, hint(0, Some(0))), 120, "already due (could not close): the ladder goes on (V1)");
}

/// An expired purchase the turn cannot close (here a payment in flight holds the bono lock) gives `due_in_s = 0`;
/// later turns follow the ladder instead of running once per second.
#[tokio::test(flavor = "multi_thread")]
async fn an_expired_purchase_that_cannot_close_does_not_spin_the_loop() {
    use crate::orchestrator::fakes::{PRICE, harness};
    use crate::rpc::RpcError;
    let h = harness().await;
    h.world.lock().unwrap().script_buy.extend([RpcError::Timeout, RpcError::Timeout, RpcError::Timeout]);
    assert_eq!(h.orch.pay_shielded(PRICE).await, Err(OrchError::StillPending));
    h.env.now.fetch_add(40 * 60, std::sync::atomic::Ordering::SeqCst);
    let _paying = h.orch.bono_lock().unwrap();
    let report = h.orch.resume().await.unwrap();
    assert_eq!(report.bonos_error, Some(OrchError::Busy));
    assert_eq!(report.retry.due_in_s, Some(0), "due and not closed");
    let waits: Vec<u64> = (0..5).map(|attempt| resume_wait_s(attempt, report.retry)).collect();
    assert_eq!(waits, [120, 300, 900, 1800, 1800]);
}

/// A request found by the turn as it starts (the wait expired just as `resume_now` arrived) counts as requested,
/// exactly once; a `resume_later` notice does not.
#[tokio::test(flavor = "multi_thread")]
async fn a_request_found_at_the_start_of_a_turn_counts_as_asked() {
    let dir = private_tempdir();
    let (app, _) = make_app(dir.path());
    app.create_seed_now(secret("clave")).await.unwrap();
    let session = app.session().await.unwrap();
    session.resume_state().later = true;
    assert!(!session.clear_resume_marks(), "`later` is not a request");
    session.resume_state().requested = true;
    assert!(session.clear_resume_marks());
    assert!(!session.clear_resume_marks(), "handled");
    app.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn lock_refuses_with_an_operation_in_flight_and_a_closed_session_is_not_reused() {
    let dir = private_tempdir();
    let (app, _) = make_app(dir.path());
    app.create_seed_now(secret("clave")).await.unwrap();
    let session = app.session().await.unwrap();
    {
        let _op = session.enter().unwrap();
        assert_eq!(app.lock().await.unwrap_err(), AppError::Core(CoreError::SessionBusy));
        assert!(app.status().await.unlocked);
    }
    assert!(!app.wallet_busy());
    app.lock().await.unwrap();
    // A command that took the session before the lock no longer uses it.
    assert_eq!(session.plan().await.unwrap_err(), AppError::Core(CoreError::NotUnlocked));
    assert_eq!(session.free_plan(1).await.unwrap_err(), AppError::Core(CoreError::NotUnlocked));
    app.lock().await.unwrap(); // no session: nothing to do
    app.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn create_seed_saves_the_seed_even_if_the_session_cannot_open() {
    let dir = private_tempdir();
    let (app, _) = make_app(dir.path());
    // A database from another seed in the profile: the session does not open (wrong key).
    let (other, _) = make_app(dir.path());
    other.create_seed_now(secret("otra")).await.unwrap();
    other.shutdown().await;
    std::fs::remove_file(dir.path().join(keys::SEED_FILE_NAME)).unwrap();

    let draft = app.draft_seed().await.unwrap();
    app.create_seed(draft.id, secret("clave")).await.unwrap();
    assert_eq!(app.status().await, AppStatus { has_seed: true, unlocked: false });
    // The words shown are the ones saved: unlocking later reveals them.
    assert_eq!(app.reveal_seed(secret("clave")).await.unwrap().phrase, draft.phrase);
    app.shutdown().await;
}

/// Creating shows the words before the password exists: until `create_seed` nothing is on disk, asking again gives
/// the same words, and what is saved is exactly what was shown.
#[tokio::test(flavor = "multi_thread")]
async fn the_draft_is_only_in_memory_until_the_password_and_saves_the_words_shown() {
    let dir = private_tempdir();
    let (app, _) = make_app(dir.path());
    let draft = app.draft_seed().await.unwrap();
    assert_eq!(draft.phrase.split(' ').count(), 24);
    let again = app.draft_seed().await.unwrap();
    assert_eq!((again.id, &again.phrase), (draft.id, &draft.phrase), "a second ask gives the same words");
    assert_eq!(app.status().await, AppStatus { has_seed: false, unlocked: false });
    assert!(!dir.path().join(keys::SEED_FILE_NAME).exists(), "nothing saved before the password");

    // A failed save keeps the draft: the same words can be saved on the next try.
    assert_eq!(app.create_seed(draft.id, secret("")).await.unwrap_err(), AppError::Core(CoreError::EmptyPassword));
    assert!(!dir.path().join(keys::SEED_FILE_NAME).exists());
    // Another id never saves the current words.
    assert_eq!(app.create_seed(draft.id + 1, secret("clave")).await.unwrap_err(), AppError::Core(CoreError::NotFound));

    app.create_seed(draft.id, secret("clave")).await.unwrap();
    assert_eq!(app.status().await, AppStatus { has_seed: true, unlocked: true });
    assert_eq!(app.draft_seed().await.unwrap_err(), AppError::Core(CoreError::AlreadyUnlocked));
    app.lock().await.unwrap();
    // Once saved, the draft is gone and this profile has its seed.
    assert_eq!(app.create_seed(draft.id, secret("clave")).await.unwrap_err(), AppError::Core(CoreError::NotFound));
    assert_eq!(app.draft_seed().await.unwrap_err(), AppError::Core(CoreError::SeedExists));
    app.unlock(secret("clave")).await.unwrap();
    assert_eq!(app.reveal_seed(secret("clave")).await.unwrap().phrase, draft.phrase);
    app.shutdown().await;
}

/// Back from the words: they are dropped and the next draft has other words and another id. Discarding with another
/// id leaves the current draft alone.
#[tokio::test(flavor = "multi_thread")]
async fn discarding_the_draft_drops_its_words() {
    let dir = private_tempdir();
    let (app, _) = make_app(dir.path());
    let first = app.draft_seed().await.unwrap();
    app.discard_seed_draft(first.id + 1);
    assert_eq!(app.draft_seed().await.unwrap().id, first.id, "another id discards nothing");
    app.discard_seed_draft(first.id);
    assert_eq!(app.create_seed(first.id, secret("clave")).await.unwrap_err(), AppError::Core(CoreError::NotFound));
    let second = app.draft_seed().await.unwrap();
    assert_ne!(second.id, first.id);
    assert_ne!(second.phrase, first.phrase);
    assert!(!dir.path().join(keys::SEED_FILE_NAME).exists());
    // Restoring instead also drops a draft left behind.
    let restore_phrase = first.phrase.clone();
    app.restore_seed(secret(&restore_phrase), secret("clave")).await.unwrap();
    app.lock().await.unwrap();
    assert_eq!(app.create_seed(second.id, secret("clave")).await.unwrap_err(), AppError::Core(CoreError::NotFound));
    app.shutdown().await;
}

/// On exit the process ends without dropping the `App`: `shutdown` wipes the draft itself.
#[tokio::test(flavor = "multi_thread")]
async fn shutdown_wipes_the_draft() {
    let dir = private_tempdir();
    let (app, _) = make_app(dir.path());
    let draft = app.draft_seed().await.unwrap();
    app.shutdown().await;
    assert_eq!(app.create_seed(draft.id, secret("clave")).await.unwrap_err(), AppError::Core(CoreError::NotFound));
    assert!(!dir.path().join(keys::SEED_FILE_NAME).exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn inputs_are_bounded() {
    let dir = private_tempdir();
    let (app, _) = make_app(dir.path());
    app.create_seed_now(secret("clave")).await.unwrap();
    let session = app.session().await.unwrap();
    let invalid = AppError::Core(CoreError::InvalidInput);
    assert_eq!(session.check_name("a".repeat(MAX_NAME_BYTES + 1)).await.unwrap_err(), invalid);
    assert_eq!(session.pay_shielded("9".repeat(MAX_AMOUNT_CHARS + 1), 1).await.unwrap_err(), invalid);
    // Without a `token` in the deployment there is no faucet (and Midnight is never reached).
    assert_eq!(session.faucet(1).await.unwrap_err(), AppError::Core(CoreError::NoTestToken));
    let bad = MessageQuery { addr_key: Some("zz".into()), ..Default::default() };
    assert_eq!(session.messages(bad).await.unwrap_err(), invalid);
    app.shutdown().await;
}

/// A round that never releases the store (a long parse on a blocking thread cannot be interrupted) does not leave
/// locking waiting forever: after `SYNC_STOP_WAIT` closing goes on.
#[tokio::test(flavor = "multi_thread")]
async fn lock_does_not_wait_forever_for_a_stuck_sync_round() {
    let dir = private_tempdir();
    let (app, _) = make_app(dir.path());
    app.create_seed_now(secret("clave")).await.unwrap();
    let session = app.session().await.unwrap();
    let round = session.sync.hold_round().await;
    let started = std::time::Instant::now();
    app.lock().await.unwrap();
    let waited = started.elapsed();
    assert!(waited >= SYNC_STOP_WAIT && waited < SYNC_STOP_WAIT + std::time::Duration::from_secs(5), "{waited:?}");
    assert!(!app.status().await.unlocked);
    drop(round);
    app.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn server_health_says_which_service_answers() {
    use crate::mail::test_server::{Reply, TestServer};
    let server = TestServer::start(|_| Reply::new(405)).await;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let closed = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    drop(listener);
    let up = format!("http://{}", server.base.host());
    let dir = private_tempdir();
    let env = |name: &str| match name {
        "NIGHTMAIL_REGISTRY_ADDRESS" => Some(R.to_string()),
        "NIGHTMAIL_ISSUER_RECEIPT_KEY" => Some(KEY.to_string()),
        "NIGHTMAIL_API_URL" | "NIGHTMAIL_RELAYER_URL" => Some(up.clone()),
        "NIGHTMAIL_ISSUER_URL" => Some(closed.clone()),
        _ => None,
    };
    let config = AppConfig::devnet(dir.path().to_path_buf(), env, None).unwrap();
    let sidecar = Arc::new(SidecarSupervisor::new(Err("no sidecar".into()), InitializeParams::devnet(false)));
    let transport = Arc::new(Transport::direct(&TransportConfig::default()).unwrap());
    let app = App::new(config, sidecar, transport, Arc::new(|_| {}));
    // No session: the check does not need one.
    assert_eq!(app.server_health().await, ServerHealth { mailbox: true, relayer: true, issuer: false });
    let mut targets: Vec<String> = server.requests().into_iter().map(|r| r.target).collect();
    targets.sort();
    assert_eq!(targets, ["/v1/relay", "/v1/time"]);
}
