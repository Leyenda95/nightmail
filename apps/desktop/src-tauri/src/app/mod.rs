//! Application layer: what sits behind the Tauri commands, independent of Tauri so it can be tested end to end on
//! the devnet (`e2e.rs`).
//!
//! - Seed: create, unlock, restore and reveal (Argon2id on a blocking thread).
//! - Session (after unlock): encrypted store, the MailSync loop and the orchestrator, which is started the first time
//!   it is needed (mail works without Midnight) and resumed in the background on unlock (`resume`).
//! - Every command using the session enters through a guard ([`Session::enter`]): locking while an operation or a
//!   wallet payment is in flight answers `sessionBusy`, and a closed session is never reused.
//! - Restore only saves the seed and opens the session; `recover` rebuilds from the chain. Until it finishes, plan and
//!   address commands answer `recoveryPending`, so slots already used on chain are not spent again.
//! - Events reach the UI through a single sink ([`AppEvent`]).

pub mod config;
#[cfg(test)]
mod e2e;
#[cfg(test)]
mod e2e_send;
pub mod send;
pub mod views;

use std::sync::{Arc, OnceLock};

use tokio::sync::{Mutex, Notify, mpsc, watch};
use tokio::task::JoinHandle;

use crate::fsutil;
use crate::keys::{self, KeyManager};
use crate::mail::client::{ClientConfig, MailboxClient};
use crate::mail::directory::DirectoryError;
use crate::mail::inbox::{BoxFuture, SenderAnswer, SenderDirectory};
use crate::mail::parser::{Breaker, parse_once};
use crate::mail::send::Outbox;
use crate::mail::sync::{MailSync, SyncTarget};
use crate::orchestrator::http::{HttpIssuer, HttpRelayer};
use crate::orchestrator::ports::{BonoPeriod, SystemEnv};
use crate::orchestrator::sidecar::SidecarChain;
use crate::orchestrator::{
    AddressView, BonoInfo, Deps, NameCheck, OrchError, OrchEvent, Orchestrator, OrchestratorConfig, PendingSlot,
    ResumeReport, RetryHint, RetryPolicy, ServerParts, SlotId, sync_target, tracked,
};
use crate::recovery::RecoveryReport;
use crate::store::{BonoStatus, LocalStore, SlotStatus, StoreScope};
use crate::supervisor::SidecarSupervisor;
use crate::transport::Transport;
pub use config::AppConfig;
pub use send::{SentDetail, SentQuery, SentView};
pub use views::*;

pub type RealOrchestrator = Orchestrator<SidecarChain, HttpIssuer, HttpRelayer>;
pub type EventSink = Arc<dyn Fn(AppEvent) + Send + Sync>;
pub type Result<T> = std::result::Result<T, AppError>;

/// Maximum wait for the orchestrator's orderly shutdown when the session closes. With a payment in flight this is
/// never reached: exit is postponed ([`App::wallet_busy`]) and locking answers `sessionBusy`.
const SHUTDOWN_WAIT: std::time::Duration = std::time::Duration::from_secs(15);
/// How often [`App::shutdown_released`] looks whether the database was released.
const RELEASE_POLL: std::time::Duration = std::time::Duration::from_millis(10);
/// Maximum wait for sync to release the store when the session closes. It only runs out if the round is inside a
/// blocking thread (parsing or storing a message), which cannot be interrupted: closing goes on, the round task is
/// aborted, and that thread finishes its message alone (an atomic store write; the store stays open while in use)
/// and drops its copy of the key and plaintext when done.
#[cfg(not(test))]
const SYNC_STOP_WAIT: std::time::Duration = std::time::Duration::from_secs(10);
/// Short in tests so the deadline test does not wait 10 real seconds.
#[cfg(test)]
const SYNC_STOP_WAIT: std::time::Duration = std::time::Duration::from_millis(300);
/// `meta` mark: the seed was restored and `recover` has not yet completed successfully.
const RECOVERY_PENDING: &str = "app.recovery-pending";
/// Caps on input coming from the UI.
const MAX_NAME_BYTES: usize = 256;
const MAX_AMOUNT_CHARS: usize = 40;
/// Messages per `set_flags_many` call: what fits in one list page (`MAX_PAGE`), the most the UI can have selected.
pub const MAX_BULK_IDS: usize = MAX_PAGE as usize;
/// Deadline for each NightMail server check ([`App::server_health`]).
const SERVER_PING_WAIT: std::time::Duration = std::time::Duration::from_secs(5);
/// Paths requested to see whether each part of the server answers (a data-free `GET` to an existing route).
const MAIL_API_PING: &str = "/v1/time";
const RELAYER_PING: &str = "/v1/relay";
const ISSUER_PING: &str = "/v1/bono/status";
/// While our server is not serving, how often (in retry "seconds") to check whether it answers again; matches the
/// sidebar's service status check (`health.ts`, every 30 s).
const SERVER_POLL_S: u32 = 30;

pub struct App {
    config: Arc<AppConfig>,
    sidecar: Arc<SidecarSupervisor>,
    transport: Arc<Transport>,
    sink: EventSink,
    session: Mutex<Option<Arc<Session>>>,
    /// Whether a session has been opened since the app started (taskbar badge: padlock or nothing, `crate::badge`).
    /// Written while holding the `session` lock.
    ever_opened: std::sync::atomic::AtomicBool,
    /// Queues password changes (each reads and replaces the seed file).
    password_change: Mutex<()>,
    /// The words of a profile being created, with their `id`, between [`App::draft_seed`] and saving or discarding
    /// them. Only in memory, wiped when dropped, discarded, saved, or on [`App::shutdown`] (on exit the process ends
    /// without running `Drop`).
    seed_draft: std::sync::Mutex<Option<(u32, keys::Draft)>>,
    /// Last draft `id` handed out.
    draft_ids: std::sync::atomic::AtomicU32,
    /// The database of the last session opened, to know when nothing holds it any more ([`App::shutdown_released`]).
    last_store: std::sync::Mutex<std::sync::Weak<LocalStore>>,
}

/// Session usage: closed, or with `active` operations in flight.
#[derive(Debug, Default)]
struct Usage {
    closed: bool,
    active: usize,
}

/// An operation in flight on the session (counted until dropped).
pub struct OpGuard<'a> {
    usage: &'a std::sync::Mutex<Usage>,
}

impl Drop for OpGuard<'_> {
    fn drop(&mut self) {
        lock_usage(self.usage).active -= 1;
    }
}

fn lock_usage(usage: &std::sync::Mutex<Usage>) -> std::sync::MutexGuard<'_, Usage> {
    usage.lock().unwrap_or_else(|e| e.into_inner())
}

/// What exists while the app is unlocked.
pub struct Session {
    keys: Arc<KeyManager>,
    store: Arc<LocalStore>,
    sync: Arc<MailSync>,
    /// Sending mail and the sent messages' delivery states ([`send`]).
    outbox: Outbox,
    config: Arc<AppConfig>,
    sidecar: Arc<SidecarSupervisor>,
    transport: Arc<Transport>,
    events: mpsc::UnboundedSender<OrchEvent>,
    /// The orchestrator once started; `starting` serialises startup.
    orch: OnceLock<Arc<RealOrchestrator>>,
    starting: Mutex<()>,
    usage: std::sync::Mutex<Usage>,
    stop: watch::Sender<bool>,
    wake: Notify,
    tasks: std::sync::Mutex<Vec<JoinHandle<()>>>,
    sink: EventSink,
    /// The `resume` loop (automatic retry) and its wake-up signal.
    resuming: std::sync::Mutex<ResumeLoop>,
    resume_wake: Notify,
    /// Tells the `resume` loop that an operation found our server not serving (see `ResumeLoop::server`).
    server_wake: Notify,
}

/// `resume` loop state: whether it is alive, whether someone asked for another turn right now (`resume_now`), and
/// whether an operation left work unfinished while it ran (`resume_later`: the loop will not end without another
/// turn, but does not run it early either).
#[derive(Default)]
struct ResumeLoop {
    running: bool,
    requested: bool,
    later: bool,
    /// Server parts a user operation found not serving while the loop was alive: the loop switches to waiting for
    /// them to answer even if it was on a long step of the backoff ladder.
    server: ServerParts,
}

/// Delays between automatic `resume` retries while something remains that can resolve itself (the last one
/// repeats). Deliberately slow. It does not space out node rejections: when the node rejects a proof, `drive` makes
/// the next one in the same turn after a block, up to `MAX_PROOFS` (10), then pauses. The relayer is what spaces
/// them: after 3 rejections per hour it answers 429 and the turn waits as asked (`not_before_s`). Not used while our
/// server is not serving either: then there are no turns until it answers (`SERVER_POLL_S`), and one turn right
/// after. It covers the rest of what fixes itself (Midnight down, the wallet, a receipt still queued) and a server
/// that answers but does not serve ("busy"). A failed user operation neither advances nor resets the ladder;
/// "Retry now" does.
const RESUME_RETRY_DELAYS_S: [u64; 4] = [120, 300, 900, 1800];

/// One retry "second". 2 ms in tests, so they exercise the loop's ladder without waiting minutes.
#[cfg(not(test))]
const RESUME_SECOND: std::time::Duration = std::time::Duration::from_secs(1);
#[cfg(test)]
const RESUME_SECOND: std::time::Duration = std::time::Duration::from_millis(2);

fn resume_retry_delay_s(attempt: usize) -> u64 {
    let last = RESUME_RETRY_DELAYS_S.len() - 1;
    RESUME_RETRY_DELAYS_S[attempt.min(last)]
}

/// Wait (in seconds) before the next turn: the ladder step, never earlier than what the relayer or a bono asks for,
/// and never later than the deadline to close an expired purchase in the journal. If that deadline already passed
/// (`0`: the turn could not close it), it had its chance and the ladder applies.
fn resume_wait_s(attempt: usize, hint: RetryHint) -> u64 {
    let wait = resume_retry_delay_s(attempt).max(hint.not_before_s);
    hint.due_in_s.filter(|due| *due > 0).map_or(wait, |due| wait.min(due))
}

/// What a `resume` turn leaves behind: whether to come back, when, and whether the UI was left with a failure notice.
#[derive(Debug, Default, Clone, Copy)]
struct Turn {
    retry: bool,
    hint: RetryHint,
    notice: bool,
}

/// What the loop does after a turn.
enum Next {
    Now,
    Wait,
    Done,
}

/// Runs a blocking function (Argon2id, files) off the async thread.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tokio::task::spawn_blocking(f).await.map_err(|_| AppError::Core(CoreError::Internal))?
}

/// Moves the phrase without copying it: the `Zeroizing` buffer moves into [`SeedPhrase`] (wiped on drop).
fn take_phrase(phrase: &mut zeroize::Zeroizing<String>) -> SeedPhrase {
    SeedPhrase { phrase: std::mem::take(&mut **phrase) }
}

#[cfg(test)]
impl App {
    /// Both steps of creating at once (draft, then save), for tests: the words that were saved.
    pub async fn create_seed_now(&self, password: Secret) -> Result<SeedPhrase> {
        let draft = self.draft_seed().await?;
        self.create_seed(draft.id, password).await?;
        Ok(SeedPhrase { phrase: draft.phrase.clone() })
    }
}

impl App {
    pub fn new(config: AppConfig, sidecar: Arc<SidecarSupervisor>, transport: Arc<Transport>, sink: EventSink) -> Self {
        Self {
            config: Arc::new(config),
            sidecar,
            transport,
            sink,
            session: Mutex::new(None),
            ever_opened: Default::default(),
            password_change: Mutex::new(()),
            seed_draft: std::sync::Mutex::new(None),
            draft_ids: Default::default(),
            last_store: Default::default(),
        }
    }

    pub async fn status(&self) -> AppStatus {
        let has_seed = self.has_seed_file();
        AppStatus { has_seed, unlocked: self.session.lock().await.is_some() }
    }

    /// Do the Mailbox API, relayer and Issuer answer? A data-free `GET` to an existing route on each: it need not
    /// succeed, it only has to answer without a 5xx (relayer and Issuer answer 405 to a `GET`).
    pub async fn server_health(&self) -> ServerHealth {
        let (t, c) = (&self.transport, &self.config);
        let (mailbox, relayer, issuer) = tokio::join!(
            t.answers(&c.mail_api, MAIL_API_PING, SERVER_PING_WAIT),
            t.answers(&c.relayer, RELAYER_PING, SERVER_PING_WAIT),
            t.answers(&c.issuer, ISSUER_PING, SERVER_PING_WAIT),
        );
        ServerHealth { mailbox, relayer, issuer }
    }

    /// Open session, or `NotUnlocked`.
    pub async fn session(&self) -> Result<Arc<Session>> {
        self.session.lock().await.clone().ok_or(AppError::Core(CoreError::NotUnlocked))
    }

    /// First step of creating a profile: 24 new words to show before the password exists. They stay only in this
    /// process's memory ([`keys::Draft`], wiped on drop) and nothing is written until [`App::create_seed`]. Asked again
    /// before that (or before [`App::discard_seed_draft`]) it answers the same words and `id`, so a screen that asks
    /// twice can never show words other than the ones that will be saved.
    pub async fn draft_seed(&self) -> Result<SeedDraft> {
        let _slot = self.unlocked_slot().await?;
        if self.has_seed_file() {
            return Err(AppError::Core(CoreError::SeedExists));
        }
        let mut held = self.draft();
        let (id, draft) = held.get_or_insert_with(|| {
            let id = self.draft_ids.fetch_add(1, std::sync::atomic::Ordering::Relaxed).wrapping_add(1);
            (id, keys::Draft::new())
        });
        let mut phrase = draft.phrase();
        // Moved without copying: the `Zeroizing` buffer goes into `SeedDraft` (wiped on drop).
        Ok(SeedDraft { id: *id, phrase: std::mem::take(&mut *phrase) })
    }

    /// Second step: saves the words of draft `draft` sealed with the password and opens the session. Another `id`
    /// (discarded, replaced or already saved) is `NotFound`. If saving fails (empty password, disk) the draft stays,
    /// so the same words can be saved on the next try. Once saved the draft is dropped: the words live on only in
    /// `seed.v1`, encrypted. The session may fail to open afterwards: the seed is saved and the app stays locked.
    pub async fn create_seed(&self, draft: u32, password: Secret) -> Result<()> {
        let mut slot = self.unlocked_slot().await?;
        let chosen = match &*self.draft() {
            Some((id, held)) if *id == draft => held.duplicate(),
            _ => return Err(AppError::Core(CoreError::NotFound)),
        };
        let dir = self.config.seed_dir().to_path_buf();
        let keys = blocking(move || Ok(keys::create(&dir, &chosen, &password.0)?)).await?;
        self.forget_draft();
        match self.open(keys, false).await {
            Ok(session) => self.put(&mut slot, session),
            Err(e) => log::warn!("[app] seed created, but the session did not open: {e:?}"),
        }
        Ok(())
    }

    /// Drops draft `draft` (back from its screen). Another `id` leaves the current one as is.
    pub fn discard_seed_draft(&self, draft: u32) {
        let mut held = self.draft();
        if held.as_ref().is_some_and(|(id, _)| *id == draft) {
            *held = None;
        }
    }

    fn draft(&self) -> std::sync::MutexGuard<'_, Option<(u32, keys::Draft)>> {
        self.seed_draft.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn forget_draft(&self) {
        *self.draft() = None;
    }

    fn has_seed_file(&self) -> bool {
        self.config.seed_dir().join(keys::SEED_FILE_NAME).exists()
    }

    /// Opens the seed with the password and resumes unfinished work (or the restore) in the background.
    pub async fn unlock(&self, password: Secret) -> Result<()> {
        let mut slot = self.unlocked_slot().await?;
        let dir = self.config.seed_dir().to_path_buf();
        let keys = blocking(move || Ok(keys::unlock(&dir, &password.0)?)).await?;
        let session = self.open(keys, true).await?;
        self.forget_draft();
        self.put(&mut slot, session);
        Ok(())
    }

    /// Saves the seed from a phrase and opens the session with the restore pending: the UI then calls
    /// [`App::recover`] (and if the app closes first, the next unlock resumes it).
    pub async fn restore_seed(&self, phrase: Secret, password: Secret) -> Result<()> {
        let mut slot = self.unlocked_slot().await?;
        let dir = self.config.seed_dir().to_path_buf();
        let keys = blocking(move || Ok(keys::restore(&dir, &phrase.0, &password.0)?)).await?;
        let session = self.open(keys, false).await?;
        session.store.with(|s| s.set_meta(RECOVERY_PENDING, b"1")).await?;
        self.forget_draft();
        self.put(&mut slot, session);
        Ok(())
    }

    /// Rebuilds bonos, slots and addresses from the chain. Repeatable.
    pub async fn recover(&self, op: u64) -> Result<RecoveryReport> {
        self.session().await?.recover(op).await
    }

    /// Shows the phrase again (asks for the password again).
    pub async fn reveal_seed(&self, password: Secret) -> Result<SeedPhrase> {
        let dir = self.config.seed_dir().to_path_buf();
        let mut phrase = blocking(move || Ok(keys::reveal_phrase(&dir, &password.0)?)).await?;
        Ok(take_phrase(&mut phrase))
    }

    /// Changes the password while the session is open. The current one is checked by opening the seed file (not
    /// against memory); only that file is rewritten ([`keys::change_password`]): the database and the wallet use keys
    /// derived from the phrase, so the session stays open as is. While it runs it counts as an operation in flight
    /// ([`Session::enter`]): locking answers `sessionBusy` and the session cannot close midway (so create, restore and
    /// unlock, which require a closed session, cannot interleave). Concurrent changes are queued (`password_change`).
    /// The session lock is not held during Argon2id: [`App::wallet_busy`] reads it with `try_lock` and would report
    /// "no payment" while one is running.
    pub async fn change_password(&self, current: Secret, new: Secret) -> Result<()> {
        let session = self.session().await?;
        let _op = session.enter()?;
        let _one_at_a_time = self.password_change.lock().await;
        let dir = self.config.seed_dir().to_path_buf();
        blocking(move || Ok(keys::change_password(&dir, &current.0, &new.0)?)).await
    }

    /// Closes the session: stops sync and the orchestrator and drops the keys. With an operation or payment in
    /// flight, `sessionBusy` (nothing is cut off).
    pub async fn lock(&self) -> Result<()> {
        let mut slot = self.session.lock().await;
        if let Some(session) = slot.as_ref() {
            session.try_close()?;
        }
        if let Some(session) = slot.take() {
            session.close().await;
        }
        Ok(())
    }

    /// Would [`App::lock`] answer `sessionBusy` now (an operation or payment in flight)? Non-blocking: during an unlock
    /// in progress, `false`.
    pub fn session_busy(&self) -> bool {
        self.session.try_lock().is_ok_and(|slot| {
            slot.as_ref().is_some_and(|s| lock_usage(&s.usage).active > 0 || s.wallet_busy())
        })
    }

    /// Is a wallet payment in flight? If so the app must not exit. Non-blocking: if the session lock is held (unlock
    /// in progress) there cannot be a payment.
    pub fn wallet_busy(&self) -> bool {
        self.session.try_lock().is_ok_and(|slot| slot.as_ref().is_some_and(|s| s.wallet_busy()))
    }

    /// Shutdown on app exit (no payment in flight by now): the session, even with operations running (they resume
    /// next time), then the sidecar. A password change in progress is not resumable, so it is awaited (seconds of
    /// Argon2id) to avoid dying with the temp file written and `seed.v1` not replaced. Capped in case the disk hangs;
    /// even then the atomic `rename` leaves either the old or the new file, complete. First of all, the words of a
    /// profile being created are wiped (the process ends without dropping the `App`).
    pub async fn shutdown(&self) {
        self.close_for_good().await;
        self.sidecar.shutdown().await;
    }

    /// What [`App::shutdown`] does before stopping the sidecar.
    async fn close_for_good(&self) {
        self.forget_draft();
        let _change = tokio::time::timeout(SHUTDOWN_WAIT, self.password_change.lock()).await;
        let session = self.session.lock().await.take();
        if let Some(session) = session {
            lock_usage(&session.usage).closed = true;
            session.close().await;
        }
    }

    /// Like [`App::shutdown`], before another profile opens in this same process (switching profiles, always with the
    /// session already locked): the sidecar is killed at once instead of being given its grace period (session and
    /// wallet are already closed, so nothing of this profile is open in it), and afterwards it waits until nothing
    /// holds the last session's database any more, so its files are really closed before the profile is released or
    /// its files are removed. Closing aborts the session's tasks, and an aborted task drops its copy only when the
    /// runtime gets to it, or, inside a blocking thread, when that thread finishes its message. Capped
    /// (`SHUTDOWN_WAIT`): returns whether it was released in time.
    pub async fn shutdown_released(&self) -> bool {
        self.close_for_good().await;
        self.sidecar.kill().await;
        let store = self.last_store.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let deadline = tokio::time::Instant::now() + SHUTDOWN_WAIT;
        while store.strong_count() > 0 {
            if tokio::time::Instant::now() >= deadline {
                log::warn!("[app] the database of the closed profile is still in use");
                return false;
            }
            tokio::time::sleep(RELEASE_POLL).await;
        }
        true
    }

    /// Puts the open session in place.
    fn put(&self, slot: &mut Option<Arc<Session>>, session: Arc<Session>) {
        *self.last_store.lock().unwrap_or_else(|e| e.into_inner()) = Arc::downgrade(&session.store);
        *slot = Some(session);
        self.ever_opened.store(true, std::sync::atomic::Ordering::Relaxed);
    }

    /// For the taskbar badge: calls `f` with the current session state (open, closed after being open, or never opened
    /// since startup) while holding the session lock until `f` returns. A number read right before locking therefore
    /// cannot reach the window after the padlock: `lock` waits. Waits for an unlock in progress. `f` must not take
    /// another lock or wait on the main thread.
    pub async fn with_session_now<R>(&self, f: impl FnOnce(crate::badge::SessionNow) -> R) -> R {
        use crate::badge::SessionNow;
        let slot = self.session.lock().await;
        let now = if slot.is_some() {
            SessionNow::Open
        } else if self.ever_opened.load(std::sync::atomic::Ordering::Relaxed) {
            SessionNow::Closed
        } else {
            SessionNow::NeverOpened
        };
        f(now)
    }

    async fn unlocked_slot(&self) -> Result<tokio::sync::MutexGuard<'_, Option<Arc<Session>>>> {
        let slot = self.session.lock().await;
        if slot.is_some() { Err(AppError::Core(CoreError::AlreadyUnlocked)) } else { Ok(slot) }
    }

    async fn open(&self, keys: KeyManager, resume: bool) -> Result<Arc<Session>> {
        let config = Arc::clone(&self.config);
        let db_key = keys.db_key();
        let store = blocking(move || {
            fsutil::ensure_private_dir(&config.wallet_dir()).map_err(|_| CoreError::Storage)?;
            let scope = StoreScope::new(&config.network, &config.contract).map_err(|_| CoreError::BadConfig)?;
            Ok(LocalStore::open(&config.store_path(), &db_key, &scope)?)
        })
        .await?;
        let store = Arc::new(store);
        let client = MailboxClient::new(Arc::clone(&self.transport), self.config.mail_api.clone(), ClientConfig::default());
        let (events, mut received) = mpsc::unbounded_channel();
        let session = Arc::new(Session {
            keys: Arc::new(keys),
            sync: Arc::new(MailSync::new(client, Arc::clone(&store), self.config.sync)),
            outbox: Outbox::new(
                MailboxClient::new(Arc::clone(&self.transport), self.config.mail_api.clone(), ClientConfig::default()),
                Arc::clone(&store),
            ),
            store,
            config: Arc::clone(&self.config),
            sidecar: Arc::clone(&self.sidecar),
            transport: Arc::clone(&self.transport),
            events,
            orch: OnceLock::new(),
            starting: Mutex::new(()),
            usage: Default::default(),
            stop: watch::channel(false).0,
            wake: Notify::new(),
            tasks: Default::default(),
            sink: Arc::clone(&self.sink),
            resuming: Default::default(),
            resume_wake: Notify::new(),
            server_wake: Notify::new(),
        });
        let sink = Arc::clone(&self.sink);
        session.spawn(async move {
            while let Some(event) = received.recv().await {
                sink(match event {
                    OrchEvent::Progress(event) => AppEvent::Progress { event },
                    OrchEvent::PendingChanged => AppEvent::PendingChanged,
                });
            }
        });
        session.spawn(sync_loop(Arc::clone(&session), Arc::clone(&self.sink)));
        if resume {
            session.spawn(resume_in_background(Arc::clone(&session)));
            session.spawn(dust_at_unlock(Arc::clone(&session)));
        }
        Ok(session)
    }
}

/// Where MailSync looks up the sender of a received end-to-end mail: the registry, through the orchestrator (started
/// if it was not). Without Midnight the answer is "unavailable", and the mail waits to be looked up again.
struct SessionSenders<'s>(&'s Session);

impl SenderDirectory for SessionSenders<'_> {
    fn resolve_sender<'a>(&'a self, addr_key: &'a [u8; 32], address: &'a str) -> BoxFuture<'a, SenderAnswer> {
        Box::pin(async move {
            let orch = self.0.orchestrator().await.map_err(|_| DirectoryError::RegistryUnavailable)?;
            orch.resolve_sender(addr_key, address).await
        })
    }
}

/// MailSync loop: one round, then wait for the interval, a wake-up (`sync_now`, new address) or shutdown.
async fn sync_loop(session: Arc<Session>, sink: EventSink) {
    let mut stop = session.stop.subscribe();
    while !*stop.borrow() {
        if let Ok(targets) = session.targets().await
            && !targets.is_empty()
            && let Some(report) = session.sync.sync_all(&targets, &SessionSenders(&session)).await
        {
            sink(AppEvent::Synced { report: report.into() });
        }
        tokio::select! {
            _ = tokio::time::sleep(session.config.sync_interval) => {}
            _ = session.wake.notified() => {}
            _ = stop.changed() => {}
        }
    }
}

fn orch_error(e: AppError) -> OrchError {
    match e {
        AppError::Orch(error) => error,
        AppError::Core(_) | AppError::Link(_) | AppError::Send(_) => OrchError::Internal,
    }
}

/// On unlock: the pending restore if there is one; otherwise unfinished work (with automatic retry).
async fn resume_in_background(session: Arc<Session>) {
    if session.recovery_pending().await.unwrap_or(false) {
        let event = match session.recover(0).await {
            Ok(report) => AppEvent::Recovered { report },
            Err(e) => AppEvent::RecoverFailed { error: orch_error(e) },
        };
        (session.sink)(event);
    } else {
        session.resume_now();
    }
}

/// On unlock, a single wallet read: if it holds unregistered NIGHT, register it for DUST right away even if the
/// wallet page is never opened, so the first payment does not wait the ~15-30 min for fee DUST. Once per session:
/// without Midnight or with nothing to register, it is not repeated until the next unlock or a wallet view.
async fn dust_at_unlock(session: Arc<Session>) {
    let Ok(orch) = session.orchestrator().await else { return };
    if let Ok(Some(claim)) = orch.check_dust().await {
        session.setup_dust(&orch, claim);
    }
}

/// Marks the `resume` loop as alive while it exists: if the task is aborted (shutdown) or panics, the mark clears
/// itself. On normal exit it is cleared under the lock and disarmed.
/// `in_turn`: a turn is in progress. If a panic cuts it, its start notice (`ResumeStarted`) would be left without a
/// result and the UI would stay on "Retrying…", so one is sent (`Internal`). Not needed when the session closes (the
/// UI forgets the notice on lock), so none is sent then.
struct ResumeRunning {
    session: Arc<Session>,
    armed: bool,
    in_turn: bool,
}

impl Drop for ResumeRunning {
    fn drop(&mut self) {
        if self.armed {
            self.session.resume_state().running = false;
        }
        if self.in_turn && !*self.session.stop.borrow() {
            (self.session.sink)(AppEvent::ResumeFailed { error: OrchError::Internal });
        }
    }
}

/// `resume` loop: one turn and, if something that can resolve itself remains, another after the wait (or sooner if
/// asked via `resume_now`). With `wait_first` (started by `resume_later`) it begins with the `first` wait (the first
/// ladder step or, with our server not serving, until it answers). Ends when nothing retryable or pending remains, or
/// when the session closes.
async fn resume_loop(mut running: ResumeRunning, wait_first: bool, first: RetryHint) {
    let session = Arc::clone(&running.session);
    let mut stop = session.stop.subscribe();
    let (mut attempt, mut asked, mut skip) = (0, !wait_first, wait_first);
    let mut turn = Turn { retry: true, hint: first, ..Turn::default() };
    // Waiting for our server to answer (the previous turn found it not serving).
    let mut server_wait = false;
    // End of the current ladder step. Kept even if the loop wakes without a turn, so an operation that found the
    // server not serving while it does answer cannot postpone the turn over and over.
    let mut ladder_end: Option<tokio::time::Instant> = None;
    loop {
        if !std::mem::take(&mut skip) {
            if *stop.borrow() {
                return;
            }
            ladder_end = None;
            // A request arriving just as the wait expired counts as requested.
            if session.clear_resume_marks() {
                (attempt, asked) = (0, true);
            }
            // A requested turn, or one after a failure notice, reports even if nothing remains.
            running.in_turn = true;
            turn = session.resume_turn(asked || turn.notice, asked).await;
            running.in_turn = false;
        }
        // Prepare the wake-up before checking `requested`, so a request in between is not lost.
        let wake = session.resume_wake.notified();
        tokio::pin!(wake);
        wake.as_mut().enable();
        match session.after_turn(turn.retry, *stop.borrow()) {
            Next::Now => {
                (attempt, asked) = (0, true);
                continue;
            }
            Next::Done => {
                running.armed = false;
                return;
            }
            Next::Wait => {}
        }
        // Our server not serving: no turn (and no proof) until it answers, and as soon as it does, one turn right
        // away with the ladder reset. If it was already answering (serving badly or "busy"), the ladder applies.
        // Whatever a user operation found meanwhile counts too.
        let server_wake = session.server_wake.notified();
        tokio::pin!(server_wake);
        server_wake.as_mut().enable();
        turn.hint.server = session.take_server_marks(turn.hint.server);
        let down = turn.hint.server.any() && !session.server_answers(turn.hint.server).await;
        if std::mem::replace(&mut server_wait, down) && !down {
            (attempt, asked) = (0, false);
            continue;
        }
        let until = if down {
            tokio::time::Instant::now() + RESUME_SECOND.saturating_mul(SERVER_POLL_S)
        } else {
            let wait_s = u32::try_from(resume_wait_s(attempt, turn.hint)).unwrap_or(u32::MAX);
            *ladder_end.get_or_insert_with(|| tokio::time::Instant::now() + RESUME_SECOND.saturating_mul(wait_s))
        };
        tokio::select! {
            () = tokio::time::sleep_until(until) => {
                if down {
                    skip = true;
                } else {
                    (attempt, asked) = (attempt + 1, false);
                }
            }
            // Asking for another turn resets the ladder and stops waiting for the server.
            () = &mut wake => (attempt, asked, server_wait) = (0, true, false),
            // An operation found the server not serving: check again now (without a turn).
            () = &mut server_wake => skip = true,
            _ = stop.changed() => return,
        }
    }
}

fn check_len(text: &str, max: usize) -> Result<()> {
    if text.len() > max { Err(AppError::Core(CoreError::InvalidInput)) } else { Ok(()) }
}

impl Session {
    /// Spawns a session task. If the session is already closing nothing is spawned: `close` sets `stop` before taking
    /// `tasks` to abort them, and `stop` is checked here while holding `tasks`, so no task escapes. Finished tasks are
    /// dropped.
    fn spawn(&self, future: impl std::future::Future<Output = ()> + Send + 'static) {
        let mut tasks = self.tasks.lock().unwrap_or_else(|e| e.into_inner());
        if *self.stop.borrow() {
            return;
        }
        tasks.retain(|t| !t.is_finished());
        tasks.push(tokio::spawn(future));
    }

    /// Guard for an operation: `NotUnlocked` if the session has already closed.
    fn enter(&self) -> Result<OpGuard<'_>> {
        let mut usage = lock_usage(&self.usage);
        if usage.closed {
            return Err(AppError::Core(CoreError::NotUnlocked));
        }
        usage.active += 1;
        Ok(OpGuard { usage: &self.usage })
    }

    fn wallet_busy(&self) -> bool {
        self.orch.get().is_some_and(|orch| orch.wallet_busy())
    }

    /// Marks the session closed if no operation or payment is in flight.
    fn try_close(&self) -> Result<()> {
        let mut usage = lock_usage(&self.usage);
        if usage.active > 0 || self.wallet_busy() {
            return Err(AppError::Core(CoreError::SessionBusy));
        }
        usage.closed = true;
        Ok(())
    }

    /// The orchestrator, started on first use (checks the sidecar). Without Midnight, `MidnightUnavailable`.
    async fn orchestrator(&self) -> Result<Arc<RealOrchestrator>> {
        if let Some(orch) = self.orch.get() {
            return Ok(Arc::clone(orch));
        }
        let _starting = self.starting.lock().await;
        if let Some(orch) = self.orch.get() {
            return Ok(Arc::clone(orch));
        }
        if lock_usage(&self.usage).closed {
            return Err(AppError::Core(CoreError::NotUnlocked));
        }
        let orch = Arc::new(Orchestrator::start(self.deps()?).await?);
        Ok(Arc::clone(self.orch.get_or_init(|| orch)))
    }

    fn deps(&self) -> Result<Deps<SidecarChain, HttpIssuer, HttpRelayer>> {
        let c = &self.config;
        let wallet_dir = c.wallet_dir().to_str().ok_or(AppError::Core(CoreError::BadConfig))?.to_owned();
        Ok(Deps {
            chain: SidecarChain::new(Arc::clone(&self.sidecar)),
            issuer: HttpIssuer::new(Arc::clone(&self.transport), c.issuer.clone()),
            relayer: HttpRelayer::new(Arc::clone(&self.transport), c.relayer.clone()),
            env: Arc::new(SystemEnv),
            store: Arc::clone(&self.store),
            keys: Arc::clone(&self.keys),
            config: OrchestratorConfig {
                network: c.network.clone(),
                contract_address: c.contract.clone(),
                mail_domain: c.mail_domain.clone(),
                captcha_token: c.captcha_token.clone(),
                card_token: c.card_token.clone(),
                issuer_key: c.issuer_key,
                wallet_state_dir: wallet_dir,
                retry: RetryPolicy::default(),
                pacing: c.pacing,
            },
            events: Some(self.events.clone()),
        })
    }

    async fn targets(&self) -> Result<Vec<SyncTarget>> {
        let addresses = self.store.with(|s| s.list_addresses()).await?;
        Ok(addresses.iter().filter_map(|a| sync_target(&self.keys, a).ok()).collect())
    }

    async fn recovery_pending(&self) -> Result<bool> {
        Ok(self.store.with(|s| s.get_meta(RECOVERY_PENDING)).await?.is_some_and(|v| !v.is_empty()))
    }

    /// Plan and addresses wait for the restore to finish.
    async fn require_recovered(&self) -> Result<()> {
        if self.recovery_pending().await? { Err(AppError::Core(CoreError::RecoveryPending)) } else { Ok(()) }
    }

    /// Requests a sync round now.
    pub fn sync_now(&self) {
        self.wake.notify_one();
    }

    async fn close(&self) {
        self.stop.send_replace(true);
        let _ = tokio::time::timeout(SYNC_STOP_WAIT, self.sync.stop()).await;
        let tasks: Vec<_> = std::mem::take(&mut *self.tasks.lock().unwrap_or_else(|e| e.into_inner()));
        // Anything unfinished was saved before each external call and resumes on unlock.
        tasks.iter().for_each(JoinHandle::abort);
        if let Some(orch) = self.orch.get() {
            let _ = tokio::time::timeout(SHUTDOWN_WAIT, orch.shutdown()).await;
        }
    }

    // ---------- Restore ----------

    pub async fn recover(&self, op: u64) -> Result<RecoveryReport> {
        let _op = self.enter()?;
        let orch = self.orchestrator().await?;
        let report = tracked(op, orch.recover()).await?;
        self.store.with(|s| s.set_meta(RECOVERY_PENDING, b"")).await?;
        self.sync_now();
        Ok(report)
    }

    // ---------- Plan and addresses ----------

    pub async fn plan(&self) -> Result<PlanView> {
        let _op = self.enter()?;
        let (bonos, addresses, abandoned) =
            self.store.with(|s| Ok((s.list_bonos()?, s.list_addresses()?, s.list_abandoned_addresses()?))).await?;
        Ok(PlanView::build(&bonos, &addresses, &abandoned))
    }

    pub async fn price(&self) -> Result<String> {
        let _op = self.enter()?;
        Ok(self.orchestrator().await?.current_price().await?)
    }

    pub async fn free_plan(&self, op: u64) -> Result<BonoInfo> {
        let _op = self.enter()?;
        self.require_recovered().await?;
        let orch = self.orchestrator().await?;
        Ok(tracked(op, orch.request_free_plan()).await?)
    }

    pub async fn pay_fiat(&self, period: PeriodInput, op: u64) -> Result<BonoInfo> {
        let _op = self.enter()?;
        self.require_recovered().await?;
        let period = match period {
            PeriodInput::Monthly => BonoPeriod::Monthly,
            PeriodInput::Annual => BonoPeriod::Annual,
        };
        let orch = self.orchestrator().await?;
        Ok(tracked(op, orch.pay_fiat(period)).await?)
    }

    pub async fn pay_shielded(&self, amount: String, op: u64) -> Result<BonoInfo> {
        check_len(&amount, MAX_AMOUNT_CHARS)?;
        let _op = self.enter()?;
        self.require_recovered().await?;
        let orch = self.orchestrator().await?;
        Ok(tracked(op, orch.pay_shielded(&amount)).await?)
    }

    /// The payment wallet (opens, syncs and closes; may be slow the first time). If it holds unregistered NIGHT, it
    /// is registered for DUST in a session task (not an operation in flight: locking or exiting cuts it off and it is
    /// retried next session) and the UI is notified when done (`WalletChanged`).
    pub async fn wallet(&self, op: u64) -> Result<WalletView> {
        let _op = self.enter()?;
        let orch = self.orchestrator().await?;
        let (snapshot, setup) = tracked(op, orch.wallet_snapshot()).await?;
        if let Some(claim) = setup {
            self.setup_dust(&orch, claim);
        }
        Ok(WalletView::build(snapshot, self.config.test_token.as_ref()))
    }

    /// Starts the claimed background registration and notifies when done (`WalletChanged`).
    fn setup_dust(&self, orch: &Arc<RealOrchestrator>, claim: crate::orchestrator::DustClaim) {
        let (sink, orch) = (Arc::clone(&self.sink), Arc::clone(orch));
        self.spawn(async move {
            orch.setup_dust(claim).await;
            sink(AppEvent::WalletChanged);
        });
    }

    /// TestToken faucet (test networks only): mints the current price, just enough for a paid plan.
    pub async fn faucet(&self, op: u64) -> Result<()> {
        let _op = self.enter()?;
        let token = self.config.test_token.clone().ok_or(AppError::Core(CoreError::NoTestToken))?;
        let orch = self.orchestrator().await?;
        let price = orch.current_price().await?;
        Ok(tracked(op, orch.faucet(&token.address, &price)).await?)
    }

    pub async fn addresses(&self) -> Result<Vec<AddressView>> {
        let _op = self.enter()?;
        let addresses = self.store.with(|s| s.list_addresses()).await?;
        Ok(addresses.iter().map(AddressView::from).collect())
    }

    /// Abandons one of our addresses (`addr_key` in hex, as in [`AddressView`]): only a local mark, the chain and
    /// server are untouched. Irreversible from the app. Already abandoned: no-op. Malformed: `InvalidInput`; not one
    /// of ours: `NotFound`. Notifies the UI only if something changed.
    pub async fn abandon_address(&self, addr_key: String) -> Result<()> {
        check_len(&addr_key, 2 * 32)?;
        let _op = self.enter()?;
        let mut key = [0u8; 32];
        hex::decode_to_slice(&addr_key, &mut key).map_err(|_| CoreError::InvalidInput)?;
        let now = crate::orchestrator::ports::Env::now(&SystemEnv);
        let changed = match self.store.with(move |s| s.abandon_address(&key, now)).await {
            Err(crate::store::StoreError::NotFound) => return Err(AppError::Core(CoreError::NotFound)),
            other => other?,
        };
        if changed {
            (self.sink)(AppEvent::AddressesChanged);
        }
        Ok(())
    }

    pub async fn check_name(&self, name: String) -> Result<NameCheck> {
        check_len(&name, MAX_NAME_BYTES)?;
        let _op = self.enter()?;
        Ok(self.orchestrator().await?.check_name(&name).await?)
    }

    pub async fn create_mailbox(&self, name: String, op: u64) -> Result<AddressView> {
        check_len(&name, MAX_NAME_BYTES)?;
        let _op = self.enter()?;
        self.require_recovered().await?;
        let orch = self.orchestrator().await?;
        let view = tracked(op, orch.create_mailbox(&name)).await?;
        self.sync_now();
        Ok(view)
    }

    pub async fn create_alias(&self, op: u64) -> Result<AddressView> {
        let _op = self.enter()?;
        self.require_recovered().await?;
        let orch = self.orchestrator().await?;
        let view = tracked(op, orch.create_alias()).await?;
        self.sync_now();
        Ok(view)
    }

    /// Name for a restored mailbox without a readable name (`needsName`). For an abandoned address: `NotFound` (the
    /// app no longer tracks it).
    pub async fn provide_name(&self, slot: SlotId, name: String, op: u64) -> Result<AddressView> {
        check_len(&name, MAX_NAME_BYTES)?;
        let _op = self.enter()?;
        let key = crate::store::SlotKey::from(slot);
        // If the slot's address is marked abandoned in the store, answer `NotFound` without reaching the
        // orchestrator: nothing is requested from the network, nothing is written, and the given name is dropped. A
        // slot without `addr_key` (no name yet) is not abandoned and goes ahead. The check and `orch.provide_name`
        // are separate steps, so an abandon arriving in between is not stopped by this guard.
        let abandoned = self
            .store
            .with(move |s| match s.get_slot(key)?.and_then(|slot| slot.addr_key) {
                Some(addr_key) => s.is_address_abandoned(&addr_key),
                None => Ok(false),
            })
            .await?;
        if abandoned {
            return Err(AppError::Core(CoreError::NotFound));
        }
        let orch = self.orchestrator().await?;
        let view = tracked(op, orch.provide_name(slot, &name)).await?;
        self.sync_now();
        Ok(view)
    }

    // ---------- User actions after an error ----------

    fn resume_state(&self) -> std::sync::MutexGuard<'_, ResumeLoop> {
        self.resuming.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// At the start of a turn, earlier requests and notices are handled by it. Returns whether there was a request.
    fn clear_resume_marks(&self) -> bool {
        let mut state = self.resume_state();
        state.later = false;
        std::mem::take(&mut state.requested)
    }

    /// After a turn, with the loop mark held: another one now (requested), wait, or finish (clearing the mark).
    fn after_turn(&self, retry: bool, stopped: bool) -> Next {
        let mut state = self.resume_state();
        if state.requested && !stopped {
            return Next::Now;
        }
        if retry || state.later {
            return Next::Wait;
        }
        state.running = false;
        Next::Done
    }

    /// One loop turn. With nothing unfinished (or the restore pending) Midnight is not started; with `announce`, an
    /// empty report clears the UI notice. With `asked` (user request or fresh unlock) stopped slots are handled too.
    /// Every turn with a result first sends `ResumeStarted`, so "Retry now" stays busy until then.
    async fn resume_turn(&self, announce: bool, asked: bool) -> Turn {
        if self.has_pending_work().await {
            (self.sink)(AppEvent::ResumeStarted);
            return self.resume_once(asked).await;
        }
        if announce {
            (self.sink)(AppEvent::ResumeStarted);
            (self.sink)(AppEvent::Resumed { report: ResumeReport::default() });
        }
        Turn::default()
    }

    /// One `resume` turn, with its event.
    async fn resume_once(&self, asked: bool) -> Turn {
        let result = match self.orchestrator().await {
            Ok(orch) if asked => orch.resume().await.map_err(AppError::from),
            Ok(orch) => orch.resume_background().await.map_err(AppError::from),
            Err(e) => Err(e),
        };
        match result {
            Ok(report) => {
                self.wake.notify_one();
                let notice = report.bonos_error.is_some() || !report.failed.is_empty();
                let turn = Turn { retry: report.needs_retry(), hint: report.retry, notice };
                (self.sink)(AppEvent::Resumed { report });
                turn
            }
            Err(e) => {
                let error = orch_error(e);
                (self.sink)(AppEvent::ResumeFailed { error });
                Turn { retry: error.may_clear_by_itself(), hint: RetryHint::default(), notice: true }
            }
        }
    }

    /// Resumes unfinished work now ("Retry now" button; also on unlock). If the retry loop is alive it is advanced and
    /// its ladder reset; otherwise it is started. The result arrives as an event (`resumed`/`resumeFailed`; with
    /// nothing pending, an empty `resumed`).
    pub fn resume_now(self: &Arc<Self>) {
        self.start_resume_loop(false, RetryHint::default(), |state| state.requested = true);
        // With no loop waiting this wakes nobody; if there is one, it has seen `requested` or will on waking.
        self.resume_wake.notify_waiters();
    }

    /// A user operation left something unfinished: let the automatic retry look at it in due course. If the loop is
    /// not alive it is started in waiting mode (first ladder step); if it is, it is neither advanced nor reset, but it
    /// will not end without another turn.
    pub fn resume_later(self: &Arc<Self>) {
        self.start_resume_loop(true, RetryHint::default(), |state| state.later = true);
    }

    /// Like [`Session::resume_later`], after a failure because our server was not serving: if the loop is not alive,
    /// it starts by waiting for the relayer to answer instead of the first ladder step.
    fn resume_when_server_answers(self: &Arc<Self>) {
        let relayer = ServerParts { relayer: true, issuer: false };
        let first = RetryHint { server: relayer, ..RetryHint::default() };
        self.start_resume_loop(true, first, |state| {
            state.later = true;
            state.server = relayer;
        });
        // If the loop is alive and waiting on its ladder step, make it check the server now.
        self.server_wake.notify_waiters();
    }

    /// The turn's server parts plus those flagged by a user operation (clearing the flags).
    fn take_server_marks(&self, parts: ServerParts) -> ServerParts {
        let marked = std::mem::take(&mut self.resume_state().server);
        ServerParts { relayer: parts.relayer || marked.relayer, issuer: parts.issuer || marked.issuer }
    }

    /// Do the parts of our server in `parts` answer? Same check as [`App::server_health`].
    async fn server_answers(&self, parts: ServerParts) -> bool {
        let (t, c) = (&self.transport, &self.config);
        let (relayer, issuer) = tokio::join!(
            async { !parts.relayer || t.answers(&c.relayer, RELAYER_PING, SERVER_PING_WAIT).await },
            async { !parts.issuer || t.answers(&c.issuer, ISSUER_PING, SERVER_PING_WAIT).await },
        );
        relayer && issuer
    }

    /// Starts the loop if it is not alive; if it is, `if_running` updates its state (under the lock, so the loop
    /// cannot end in between without seeing it). With the session closed, nothing.
    fn start_resume_loop(self: &Arc<Self>, wait_first: bool, first: RetryHint, if_running: impl FnOnce(&mut ResumeLoop)) {
        if lock_usage(&self.usage).closed {
            return;
        }
        let mut state = self.resume_state();
        if state.running {
            return if_running(&mut state);
        }
        state.running = true;
        drop(state);
        // If `spawn` does not start it (session closing), the guard is dropped here and clears the mark.
        self.spawn(resume_loop(ResumeRunning { session: Arc::clone(self), armed: true, in_turn: false }, wait_first, first));
    }

    /// After a user address operation: if it ended with a failure that may resolve itself and may leave the slot
    /// unfinished, schedule a waiting retry ([`Session::resume_later`]). `busy` and `bonoNotReady` leave nothing.
    pub fn retry_later_if_needed<T>(self: &Arc<Self>, result: &Result<T>) {
        if let Err(AppError::Orch(error)) = result
            && error.may_clear_by_itself()
            && !matches!(error, OrchError::Busy | OrchError::BonoNotReady { .. })
        {
            if error.server_down() { self.resume_when_server_answers() } else { self.resume_later() }
        }
    }

    /// After a payment that did not finish: if a purchase remains in the journal or a leaf has an unexpired receipt,
    /// schedule a waiting retry. A 429 or an Issuer `busy` leaves nothing like that.
    pub async fn retry_later_if_payment_pending<T>(self: &Arc<Self>, result: &Result<T>) {
        if result.is_err()
            && let Some(orch) = self.orch.get()
            && orch.payment_pending().await.unwrap_or(false)
        {
            self.resume_later();
        }
    }

    /// Is there anything `resume` can pick up? Unfinished slots, requested leaves or purchases in the journal. Not
    /// while the restore is pending (`recover` handles that).
    async fn has_pending_work(&self) -> bool {
        if self.recovery_pending().await.unwrap_or(true) {
            return false;
        }
        let work = self
            .store
            .with(|s| {
                let slots = !s.slots_by_status(SlotStatus::Reserving)?.is_empty();
                let bonos = s.list_bonos()?.iter().any(|b| b.status == BonoStatus::Requested);
                Ok(slots || bonos || !s.list_journal()?.is_empty())
            })
            .await;
        // If the store cannot be read, let `resume` report it.
        work.unwrap_or(true)
    }

    /// Unfinished mailboxes and aliases, to resume or abandon them.
    pub async fn pending_slots(&self) -> Result<Vec<PendingSlot>> {
        let _op = self.enter()?;
        Ok(self.orchestrator().await?.pending_slots().await?)
    }

    /// After a persistent `staleState`.
    pub async fn retry_stale(&self) -> Result<()> {
        let _op = self.enter()?;
        Ok(self.orchestrator().await?.retry_stale().await?)
    }

    /// After `attemptsExhausted`: resumes the paused slot.
    pub async fn resume_paused_slot(&self, slot: SlotId, op: u64) -> Result<AddressView> {
        let _op = self.enter()?;
        self.require_recovered().await?;
        let orch = self.orchestrator().await?;
        let view = tracked(op, orch.resume_paused_slot(slot)).await?;
        self.sync_now();
        Ok(view)
    }

    /// Abandons a half-reserved mailbox or alias (e.g. to pick another name).
    pub async fn abandon_slot(&self, slot: SlotId) -> Result<()> {
        let _op = self.enter()?;
        Ok(self.orchestrator().await?.abandon_slot(slot).await?)
    }

    /// Abandons a requested leaf that was never issued (to pay another way).
    pub async fn forget_pending_bono(&self, n: u32, k: u32) -> Result<()> {
        let _op = self.enter()?;
        Ok(self.orchestrator().await?.forget_pending_bono(n, k).await?)
    }

    // ---------- Mail ----------

    pub async fn messages(&self, query: MessageQuery) -> Result<Vec<MessageView>> {
        let filter = query.filter()?;
        let _op = self.enter()?;
        let list = self.store.with(move |s| s.list_messages(&filter)).await?;
        Ok(list.iter().map(MessageView::from).collect())
    }

    /// Opens a message: parses it with the read circuit breaker and, if it had been stored without fields and now
    /// parses fine, saves them (see the `mail::parser` contract).
    pub async fn message(&self, id: i64) -> Result<MessageDetail> {
        let _op = self.enter()?;
        let detail = self
            .store
            .with(move |s| {
                let Some(message) = s.get_message(id)? else { return Ok(None) };
                let parsed = parse_once(s, Breaker::Read, &id.to_be_bytes(), &message.raw)?;
                if let Some(p) = &parsed
                    && message.summary.parsed == Default::default()
                {
                    s.set_parsed(id, &p.fields())?;
                }
                Ok(Some(MessageDetail::build(&message.summary, parsed)))
            })
            .await?;
        detail.ok_or(AppError::Core(CoreError::NotFound))
    }

    pub async fn set_flags(&self, id: i64, flags: FlagsInput) -> Result<()> {
        let _op = self.enter()?;
        let exists = self.store.with(move |s| s.get_message(id).map(|m| m.is_some())).await?;
        if !exists {
            return Err(AppError::Core(CoreError::NotFound));
        }
        Ok(self.store.with(move |s| s.set_flags(id, &flags.into())).await?)
    }

    /// Applies the same flags to several messages (Inbox or Archive selection), all or none. More than
    /// [`MAX_BULK_IDS`]: `InvalidInput`; any missing: `NotFound` (and nothing changes).
    pub async fn set_flags_many(&self, ids: Vec<i64>, flags: FlagsInput) -> Result<()> {
        let _op = self.enter()?;
        if ids.len() > MAX_BULK_IDS {
            return Err(AppError::Core(CoreError::InvalidInput));
        }
        match self.store.with(move |s| s.set_flags_many(&ids, &flags.into())).await {
            Err(crate::store::StoreError::NotFound) => Err(AppError::Core(CoreError::NotFound)),
            other => Ok(other?),
        }
    }
}

#[cfg(test)]
mod tests;
