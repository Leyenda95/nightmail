//! MailSync: downloads each address's mail separately.
//!
//! Rounds ([`MailSync::sync_all`]) never overlap. Addresses go in random order with a random pause between them,
//! each with its own [`Session`] (its own server time and pace). Per address:
//! 1. **Pass from the stored cursor**, so new mail arrives first.
//! 2. **Relist from 0**, once per app session: recovers what the cursor may have skipped, retries `failed` messages
//!    and, if the server is behind the stored cursor, moves back to it. It may span several rounds and only advances
//!    over gap-free stretches.
//!
//! What counts as new mail (the app's notification) is decided here, per address: `SyncReport::fresh`.
//!
//! End-to-end mail ([`super::inbox`]) needs its sender looked up in the registry before it is stored, through the
//! [`SenderDirectory`] each round is given. If the registry does not answer, the mail is kept aside in the store and
//! tried again at the start of later rounds for that address: `sender_retry_base` after the first try, doubling up to
//! `sender_retry_cap`, at most `sender_max_attempts` times per app session (each session starts them again). Mail
//! waiting this way is not downloaded again and does not hold the cursor back.
//!
//! In each pass:
//! - anything already stored or skipped is not requested again (when relisting, `failed` ones are);
//! - per message: download (at most its bucket) → open, parse (with the circuit breaker, [`parser::parse_once`]) and
//!   store, all on one blocking thread;
//! - **definitive** skips: cannot be opened (`undecryptable`), the server does not have it (`not-found`), larger than
//!   its bucket (`too-large`). A transient failure (timeout, cut, 5xx…) only counts an attempt if the previous
//!   counted one was more than `attempt_spacing` ago; at `max_attempts` it becomes `failed`, which is not
//!   definitive: each session's relist retries it. `max_pending_in_a_row` consecutive transient failures stop the
//!   address (something is wrong with the network or server; no point burning attempts);
//! - the stored (monotonic) cursor and the relist progress only advance up to the last gap-free point;
//! - a byte budget per address and round, and a round deadline.
//!
//! [`MailSync::stop`] is immediate and awaitable: it interrupts pauses, waits and in-flight requests, and returns once
//! the round has released the store. Dropping the [`MailSync::sync_all`] future is also safe: every store write is
//! atomic and one already running finishes on its own blocking thread.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use tokio::sync::Notify;
use zeroize::{Zeroize, Zeroizing};

use super::client::{ListedMessage, MAX_CURSOR, MailError, MailboxClient, MessagePage, Session, local_now};
use super::directory::DirectoryError;
use super::e2e::{Address, is_e2e_mail};
use super::inbox::{self, Arrival, SenderAnswer, SenderDirectory, Settled};
use super::parser::{self, Breaker};
use super::{random_below, random_between};
use crate::crypto::open_envelope;
use crate::keys::AddressKeys;
use crate::store::{E2eInsert, LocalStore, NewMessage, PendingE2e, SkipReason, StoreError};
use crate::transport::TransportError;

/// Provisional defaults.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyncConfig {
    /// Random pause between two addresses, in `[pause_min, pause_max]`.
    pub pause_min: Duration,
    pub pause_max: Duration,
    /// Maximum pages per pass.
    pub max_pages: u32,
    /// Wait after an address's first failure; doubles with each consecutive failure up to `backoff_cap`.
    pub backoff_base: Duration,
    pub backoff_cap: Duration,
    /// Counted attempts before a message is marked `failed`.
    pub max_attempts: u32,
    /// Minimum gap between two counted attempts on the same message.
    pub attempt_spacing: Duration,
    /// Consecutive transient failures that stop the address for this round.
    pub max_pending_in_a_row: u32,
    /// Envelope bytes per address and round.
    pub round_budget: u64,
    /// Deadline for a whole round.
    pub round_timeout: Duration,
    /// Wait before looking up the sender of an end-to-end mail again after the registry did not answer; doubles with
    /// each try up to `sender_retry_cap`.
    pub sender_retry_base: Duration,
    pub sender_retry_cap: Duration,
    /// Tries per app session to look up the sender of one mail.
    pub sender_max_attempts: u32,
}

impl Default for SyncConfig {
    fn default() -> Self {
        Self {
            pause_min: Duration::from_secs(1),
            pause_max: Duration::from_secs(10),
            max_pages: 20,
            backoff_base: Duration::from_secs(1),
            backoff_cap: Duration::from_secs(300),
            max_attempts: 5,
            attempt_spacing: Duration::from_secs(10 * 60),
            max_pending_in_a_row: 3,
            round_budget: 256 << 20,
            round_timeout: Duration::from_secs(30 * 60),
            sender_retry_base: Duration::from_secs(60),
            sender_retry_cap: Duration::from_secs(60 * 60),
            sender_max_attempts: 8,
        }
    }
}

/// One of our addresses, with its keys.
pub struct SyncTarget {
    pub addr_key: [u8; 32],
    /// As `local@domain` in lowercase: an end-to-end mail is verified only if it was signed for exactly this text.
    pub address: String,
    pub keys: AddressKeys,
}

/// Round summary, without saying which addresses.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SyncReport {
    /// New messages stored.
    pub stored: usize,
    /// Messages skipped in this round.
    pub skipped: usize,
    /// Addresses that failed in this round.
    pub failed: usize,
    /// Addresses postponed because of earlier failures.
    pub deferred: usize,
    /// The new mail within `stored`: what the from-cursor pass stored for addresses that were already caught up when
    /// the round started (see `MailSync::caught_up`). Backlog and relist recoveries do not count.
    pub fresh: usize,
}

#[derive(Debug, Clone, Copy)]
struct Backoff {
    failures: u32,
    not_before: Instant,
}

/// Relist from 0, once per app session and address.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Relist {
    /// To do or in progress: continue from this cursor.
    Pending(u64),
    Done,
}

/// Why an address is left unfinished.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Halt {
    /// Failure: postponed.
    Error(MailError),
    /// Budget, deadline or stop: not a failure.
    Pause,
}

impl From<MailError> for Halt {
    fn from(error: MailError) -> Self {
        Self::Error(error)
    }
}

impl From<StoreError> for Halt {
    fn from(_: StoreError) -> Self {
        Self::Error(MailError::Store)
    }
}

/// What happened to a message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Outcome {
    /// Stored or skipped: not requested again.
    Done,
    /// Transient failure: will be retried.
    Pending(MailError),
}

/// A round: its stop generation, deadline and where to look up the senders of end-to-end mail.
struct Round<'a> {
    generation: u64,
    deadline: Instant,
    senders: &'a dyn SenderDirectory,
    /// A lookup in this round found the registry not answering: the rest of the round does not ask again.
    registry_down: AtomicBool,
}

/// One address in one round.
struct Pass<'a> {
    target: &'a SyncTarget,
    session: Session<'a>,
    budget: u64,
    round: &'a Round<'a>,
    report: &'a mut SyncReport,
    /// Whatever is stored now is new mail (`SyncReport::fresh`).
    fresh: bool,
    /// Messages already downloaded this round and whether they finished, so the second pass does not request them
    /// again.
    tried: HashMap<String, bool>,
}

impl Pass<'_> {
    fn addr_key(&self) -> [u8; 32] {
        self.target.addr_key
    }

    /// Takes `bytes` from the budget if they fit.
    fn spend(&mut self, bytes: u64) -> bool {
        let fits = bytes <= self.budget;
        self.budget = self.budget.saturating_sub(if fits { bytes } else { 0 });
        fits
    }
}

pub struct MailSync {
    client: MailboxClient,
    store: Arc<LocalStore>,
    config: SyncConfig,
    backoff: Mutex<HashMap<[u8; 32], Backoff>>,
    relists: Mutex<HashMap<[u8; 32], Relist>>,
    /// Addresses caught up in this session: their from-cursor pass reached the end of the list in a round without
    /// failure or postponement. From then on, what that pass stores is new mail. Locking creates a new `MailSync`, so
    /// mail that arrived meanwhile, and older mail of a restored or newly created address, counts as backlog.
    caught_up: Mutex<HashSet<[u8; 32]>>,
    /// Last counted attempt per message (in memory: after an app restart the first one counts again).
    attempts: Mutex<HashMap<([u8; 32], String), Instant>>,
    /// Addresses whose end-to-end mail waiting for a sender lookup got its tries back in this session.
    rearmed: Mutex<HashSet<[u8; 32]>>,
    round: tokio::sync::Mutex<()>,
    /// Bumped by every `stop()`; a round stops once it is no longer its own.
    stop_generation: AtomicU64,
    stop_notify: Notify,
}

/// Fisher-Yates.
fn shuffled<T>(items: &[T]) -> Vec<&T> {
    let mut order: Vec<&T> = items.iter().collect();
    for i in (1..order.len()).rev() {
        order.swap(i, random_below(i as u64 + 1) as usize);
    }
    order
}

/// Cursor after finishing the first `done` messages of the page. Without the whole page, a message's sequence number
/// is only known if the page is contiguous (`next` = `since` + messages).
fn cursor_after(since: u64, page: &MessagePage, done: usize) -> u64 {
    let contiguous = page.next == since + page.messages.len() as u64;
    match done {
        _ if done == page.messages.len() => page.next,
        _ if contiguous => since + done as u64,
        _ => since,
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// What the blocking step made of a downloaded envelope.
enum Kept {
    /// It does not open.
    Undecryptable,
    /// Stored; `true` if it is new.
    Stored(bool),
    /// Marked as an end-to-end mail, but neither that nor a MIME message the parser can read ([`inbox`]).
    Unparseable,
    /// An end-to-end mail: its sender must be looked up before it is stored.
    E2e { plaintext: Zeroizing<Vec<u8>>, declared: Address },
    /// An end-to-end mail kept aside until its sender can be looked up.
    Pending,
}

/// Opens the envelope and stores it as a MIME message ([`keep_mime`]), unless it holds an end-to-end mail, readable or
/// not ([`inbox`]). On a blocking thread.
fn keep_envelope(
    store: &LocalStore,
    secret: &[u8; 32],
    addr_key: [u8; 32],
    listed: &ListedMessage,
    envelope: Vec<u8>,
) -> crate::store::Result<Kept> {
    let Ok(raw) = open_envelope(secret, &envelope) else { return Ok(Kept::Undecryptable) };
    drop(envelope);
    if let Some(declared) = inbox::declared_sender(&raw) {
        return Ok(Kept::E2e { plaintext: raw, declared });
    }
    if inbox::is_unreadable_e2e(&raw) {
        return Ok(Kept::Unparseable);
    }
    keep_mime(store, addr_key, listed, raw)
}

/// Parses (with the circuit breaker) and stores a MIME message, and forgets its failed attempts. A plaintext with the
/// end-to-end marker that does not parse either is not stored ([`Kept::Unparseable`]).
fn keep_mime(
    store: &LocalStore,
    addr_key: [u8; 32],
    listed: &ListedMessage,
    mut raw: Zeroizing<Vec<u8>>,
) -> crate::store::Result<Kept> {
    // `raw` stays in `Zeroizing` until `NewMessage` is built, so it is wiped on drop if `parse_once` fails.
    let marker = [&addr_key[..], listed.id.as_bytes()].concat();
    let parsed = parser::parse_once(store, Breaker::Sync, &marker, &raw)?;
    if parsed.is_none() && is_e2e_mail(&raw) {
        return Ok(Kept::Unparseable);
    }
    let mut message = NewMessage {
        addr_key,
        server_id: listed.id.clone(),
        received_at: listed.received_at,
        size_bucket: listed.size,
        raw: std::mem::take(&mut *raw),
        parsed: parsed.map(|message| message.fields()).unwrap_or_default(),
    };
    let inserted = store.insert_message(&message);
    // Do not leave plaintext in freed memory. Partial: the parser's copies (strings in `ParsedMessage`) are not
    // wiped.
    message.raw.zeroize();
    let new = inserted?.is_some();
    store.forget_skipped(&addr_key, &listed.id)?;
    Ok(Kept::Stored(new))
}

/// Stores an end-to-end mail with the registry's answer about its sender, or keeps it aside if there was none (its
/// first try counted, the next one due at `next_at`). On a blocking thread.
fn keep_e2e(
    store: &LocalStore,
    arrival: &Arrival,
    listed: &ListedMessage,
    plaintext: Zeroizing<Vec<u8>>,
    declared: &Address,
    answer: SenderAnswer,
    next_at: i64,
) -> crate::store::Result<Kept> {
    match inbox::settle(store, arrival, &plaintext, declared, answer)? {
        Settled::Stored(inserted) => Ok(Kept::Stored(matches!(inserted, E2eInsert::Stored { .. }))),
        Settled::SenderUnavailable => {
            let pending = PendingE2e {
                addr_key: arrival.addr_key,
                server_id: arrival.server_id.clone(),
                received_at: arrival.received_at,
                size_bucket: arrival.size_bucket,
                plaintext,
            };
            store.add_e2e_pending(&pending, next_at)?;
            Ok(Kept::Pending)
        }
        // `declared_sender` decoded it, so this does not happen; if it did, it is a MIME message like any other.
        Settled::NotE2e => keep_mime(store, arrival.addr_key, listed, plaintext),
    }
}

/// Tries a mail waiting for its sender lookup again: `Some(true)` if it was stored as a new message, `None` if it
/// still waits (`attempts` tries so far, the next one due at `next_at`). On a blocking thread.
fn retry_e2e(
    store: &LocalStore,
    arrival: &Arrival,
    pending: &PendingE2e,
    declared: &Address,
    answer: SenderAnswer,
    (attempts, next_at): (u32, i64),
) -> crate::store::Result<Option<bool>> {
    let (addr_key, id) = (&arrival.addr_key, &arrival.server_id);
    match inbox::settle(store, arrival, &pending.plaintext, declared, answer)? {
        Settled::Stored(inserted) => Ok(Some(matches!(inserted, E2eInsert::Stored { .. }))),
        Settled::SenderUnavailable => store.retry_e2e_pending(addr_key, id, attempts, next_at).map(|()| None),
        Settled::NotE2e => store.drop_e2e_pending(addr_key, id).map(|()| Some(false)),
    }
}

/// A skip that is never retried.
fn is_definitive(reason: SkipReason) -> bool {
    matches!(reason, SkipReason::Undecryptable | SkipReason::TooLarge | SkipReason::NotFound)
}

/// Of `ids`, those not to request: stored or skipped (when relisting, only definitive skips).
fn done_ids(
    store: &LocalStore,
    addr_key: &[u8; 32],
    ids: &[String],
    relisting: bool,
) -> crate::store::Result<HashSet<String>> {
    let mut done = store.known_server_ids(addr_key, ids)?;
    for id in ids {
        if done.contains(id) {
            continue;
        }
        if store.skip_reason(addr_key, id)?.is_some_and(|reason| !relisting || is_definitive(reason)) {
            done.insert(id.clone());
        }
    }
    Ok(done)
}

impl MailSync {
    pub fn new(client: MailboxClient, store: Arc<LocalStore>, config: SyncConfig) -> Self {
        Self {
            client,
            store,
            config,
            backoff: Mutex::default(),
            relists: Mutex::default(),
            caught_up: Mutex::default(),
            attempts: Mutex::default(),
            rearmed: Mutex::default(),
            round: tokio::sync::Mutex::new(()),
            stop_generation: AtomicU64::new(0),
            stop_notify: Notify::new(),
        }
    }

    /// Stops the current round as soon as possible and returns once it has released the store (stored data is kept).
    /// With no round running it returns at once and does not affect the next one.
    pub async fn stop(&self) {
        self.stop_generation.fetch_add(1, Ordering::SeqCst);
        self.stop_notify.notify_waiters();
        drop(self.round.lock().await);
    }

    /// Tests: takes the round, like one stuck on a blocking thread (which cannot be interrupted).
    #[cfg(test)]
    pub(crate) async fn hold_round(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.round.lock().await
    }

    /// One round over every address, looking up the senders of end-to-end mail in `senders`; `None` if another one
    /// is already running.
    pub async fn sync_all(&self, targets: &[SyncTarget], senders: &dyn SenderDirectory) -> Option<SyncReport> {
        // Read the generation before taking the round, so a `stop()` arriving in between stops it.
        let generation = self.stop_generation.load(Ordering::SeqCst);
        let _round = self.round.try_lock().ok()?;
        let deadline = Instant::now() + self.config.round_timeout;
        let round = Round { generation, deadline, senders, registry_down: AtomicBool::new(false) };
        let mut report = SyncReport::default();
        for (i, target) in shuffled(targets).into_iter().enumerate() {
            let pause =
                if i > 0 { random_between(self.config.pause_min, self.config.pause_max) } else { Duration::ZERO };
            if self.halted(&round) || self.interruptible(&round, sleep_ok(pause)).await.is_err() {
                break;
            }
            self.sync_target(target, &round, &mut report).await;
        }
        Some(report)
    }

    fn halted(&self, round: &Round<'_>) -> bool {
        self.stop_generation.load(Ordering::SeqCst) != round.generation || Instant::now() >= round.deadline
    }

    /// Returns when the round must stop (stop requested or deadline passed).
    async fn interrupted(&self, round: &Round<'_>) {
        loop {
            let notified = self.stop_notify.notified();
            if self.halted(round) {
                return;
            }
            tokio::select! {
                () = notified => {}
                () = tokio::time::sleep_until(round.deadline.into()) => {}
            }
        }
    }

    /// A wait or request that a stop or the deadline cuts off immediately.
    async fn interruptible<T>(
        &self,
        round: &Round<'_>,
        call: impl Future<Output = Result<T, MailError>>,
    ) -> Result<T, Halt> {
        tokio::select! {
            result = call => result.map_err(Halt::from),
            () = self.interrupted(round) => Err(Halt::Pause),
        }
    }

    async fn sync_target(&self, target: &SyncTarget, round: &Round<'_>, report: &mut SyncReport) {
        if !self.is_due(&target.addr_key) {
            report.deferred += 1;
            return;
        }
        match self.sync_address(target, round, report).await {
            Ok(()) => {
                lock(&self.backoff).remove(&target.addr_key);
            }
            Err(Halt::Pause) => {}
            Err(Halt::Error(error)) => {
                report.failed += 1;
                self.defer(target.addr_key, error);
            }
        }
    }

    fn is_due(&self, addr_key: &[u8; 32]) -> bool {
        lock(&self.backoff).get(addr_key).is_none_or(|b| Instant::now() >= b.not_before)
    }

    /// Waits `base · 2^(failures − 1)`, capped, or longer if the server asked for it.
    fn defer(&self, addr_key: [u8; 32], error: MailError) {
        let mut backoffs = lock(&self.backoff);
        let failures = backoffs.get(&addr_key).map_or(1, |b| b.failures.saturating_add(1));
        let doubling = self.config.backoff_base.saturating_mul(1 << (failures - 1).min(20));
        let asked = match error {
            MailError::Busy { retry_after } => Duration::from_secs(retry_after),
            _ => Duration::ZERO,
        };
        let wait = doubling.min(self.config.backoff_cap).max(asked);
        let not_before = Instant::now().checked_add(wait).unwrap_or_else(|| Instant::now() + self.config.backoff_cap);
        backoffs.insert(addr_key, Backoff { failures, not_before });
    }

    async fn sync_address(&self, target: &SyncTarget, round: &Round<'_>, report: &mut SyncReport) -> Result<(), Halt> {
        self.retry_senders(target, round, report).await?;
        let opening = self.client.open_session(&target.addr_key, &target.keys.auth_seed);
        let session = self.interruptible(round, opening).await?;
        let fresh = lock(&self.caught_up).contains(&target.addr_key);
        let mut pass =
            Pass { target, session, budget: self.config.round_budget, round, report, fresh, tried: HashMap::new() };
        let stored = self.load_cursor(target.addr_key).await?;
        let reached_end = self.walk(&mut pass, stored, false).await?;
        pass.fresh = false;
        let relist = *lock(&self.relists).entry(target.addr_key).or_insert(Relist::Pending(0));
        if let Relist::Pending(from) = relist {
            self.walk(&mut pass, from, true).await?;
        }
        if reached_end {
            lock(&self.caught_up).insert(target.addr_key);
        }
        Ok(())
    }

    /// Walks the pages from `since`; `true` if it reached the end of the list. The stored cursor (and relist progress)
    /// only advance while the pass has no gaps.
    async fn walk(&self, pass: &mut Pass<'_>, mut since: u64, relisting: bool) -> Result<bool, Halt> {
        let mut clean = true;
        for _ in 0..self.config.max_pages {
            let page = self.interruptible(pass.round, self.client.list(&mut pass.session, since)).await?;
            if page.messages.is_empty() {
                self.finish_listing(pass.addr_key(), since, relisting && clean).await?;
                return Ok(true);
            }
            let (done, result) = self.sync_page(pass, &page, relisting).await;
            if clean {
                self.advance(pass.addr_key(), cursor_after(since, &page, done), relisting).await?;
            }
            clean &= done == page.messages.len();
            result?;
            since = page.next;
        }
        Ok(false)
    }

    async fn advance(&self, addr_key: [u8; 32], reached: u64, relisting: bool) -> Result<(), Halt> {
        self.save_cursor(addr_key, reached).await?;
        if relisting {
            lock(&self.relists).insert(addr_key, Relist::Pending(reached));
        }
        Ok(())
    }

    /// End of the list. A complete, gap-free relist finishes; if the server is behind the stored cursor, move back to
    /// it.
    async fn finish_listing(&self, addr_key: [u8; 32], since: u64, completed_relist: bool) -> Result<(), Halt> {
        if !completed_relist {
            return Ok(());
        }
        lock(&self.relists).insert(addr_key, Relist::Done);
        if self.load_cursor(addr_key).await? > since {
            log::warn!("mail: the mailbox server is behind the saved cursor; restarting");
            self.store.with(move |store| store.reset_sync_cursor(&addr_key)).await?;
            self.save_cursor(addr_key, since).await?;
        }
        Ok(())
    }

    /// The messages of one page, not cut short by a transient failure (unless `max_pending_in_a_row` in a row).
    /// Returns how many from the start finished and, if it had to stop, why.
    async fn sync_page(&self, pass: &mut Pass<'_>, page: &MessagePage, relisting: bool) -> (usize, Result<(), Halt>) {
        let ids: Vec<String> = page.messages.iter().map(|m| m.id.clone()).collect();
        let addr_key = pass.addr_key();
        let done = match self.store.with(move |store| done_ids(store, &addr_key, &ids, relisting)).await {
            Ok(done) => done,
            Err(error) => return (0, Err(error.into())),
        };
        let (mut prefix, mut gap, mut in_a_row) = (0, false, 0);
        for listed in &page.messages {
            let finished = if done.contains(&listed.id) { Some(true) } else { pass.tried.get(&listed.id).copied() };
            if let Some(finished) = finished {
                prefix += usize::from(!gap && finished);
                gap |= !finished;
                continue;
            }
            match self.sync_message(pass, listed).await {
                Ok(Outcome::Done) => {
                    pass.tried.insert(listed.id.clone(), true);
                    prefix += usize::from(!gap);
                    in_a_row = 0;
                }
                Ok(Outcome::Pending(error)) => {
                    pass.tried.insert(listed.id.clone(), false);
                    gap = true;
                    in_a_row += 1;
                    if in_a_row >= self.config.max_pending_in_a_row {
                        return (prefix, Err(Halt::Error(error)));
                    }
                }
                Err(halt) => return (prefix, Err(halt)),
            }
        }
        (prefix, Ok(()))
    }

    async fn sync_message(&self, pass: &mut Pass<'_>, listed: &ListedMessage) -> Result<Outcome, Halt> {
        if self.halted(pass.round) || !pass.spend(listed.envelope_length() as u64) {
            return Err(Halt::Pause);
        }
        let download = self.client.download(&mut pass.session, listed);
        match self.interruptible(pass.round, download).await {
            Ok(envelope) => self.keep(pass, listed, envelope).await,
            Err(Halt::Error(error)) => self.failed_download(pass, listed, error).await,
            Err(Halt::Pause) => Err(Halt::Pause),
        }
    }

    async fn failed_download(
        &self,
        pass: &mut Pass<'_>,
        listed: &ListedMessage,
        error: MailError,
    ) -> Result<Outcome, Halt> {
        match error {
            MailError::NotFound => self.skip(pass, listed, SkipReason::NotFound).await,
            MailError::Transport(TransportError::TooLarge) => self.skip(pass, listed, SkipReason::TooLarge).await,
            MailError::Transport(TransportError::Timeout | TransportError::Interrupted) | MailError::Protocol => {
                self.count_attempt(pass, listed, error).await
            }
            other => Err(Halt::Error(other)),
        }
    }

    /// Whether this attempt counts: only if the previous counted one on the same message was over `attempt_spacing`
    /// ago.
    fn attempt_counts(&self, addr_key: [u8; 32], id: &str) -> bool {
        let mut attempts = lock(&self.attempts);
        let key = (addr_key, id.to_owned());
        let recent = attempts.get(&key).is_some_and(|at| at.elapsed() < self.config.attempt_spacing);
        if !recent {
            attempts.insert(key, Instant::now());
        }
        !recent
    }

    async fn count_attempt(
        &self,
        pass: &mut Pass<'_>,
        listed: &ListedMessage,
        error: MailError,
    ) -> Result<Outcome, Halt> {
        if !self.attempt_counts(pass.addr_key(), &listed.id) {
            return Ok(Outcome::Pending(error));
        }
        let (addr_key, id) = (pass.addr_key(), listed.id.clone());
        let attempts = self.store.with(move |store| store.bump_message_attempt(&addr_key, &id, local_now())).await?;
        if attempts >= self.config.max_attempts {
            self.skip(pass, listed, SkipReason::Failed).await
        } else {
            Ok(Outcome::Pending(error))
        }
    }

    async fn skip(&self, pass: &mut Pass<'_>, listed: &ListedMessage, reason: SkipReason) -> Result<Outcome, Halt> {
        log::warn!("mail: skipping a message ({})", reason.as_str());
        let (addr_key, id) = (pass.addr_key(), listed.id.clone());
        self.store.with(move |store| store.mark_skipped(&addr_key, &id, reason, local_now())).await?;
        pass.report.skipped += 1;
        Ok(Outcome::Done)
    }

    async fn keep(&self, pass: &mut Pass<'_>, listed: &ListedMessage, envelope: Vec<u8>) -> Result<Outcome, Halt> {
        let (addr_key, entry) = (pass.addr_key(), listed.clone());
        let secret = Zeroizing::new(*pass.target.keys.enc_secret);
        let mut kept = self.store.with(move |store| keep_envelope(store, &secret, addr_key, &entry, envelope)).await?;
        if let Kept::E2e { plaintext, declared } = kept {
            let answer = self.lookup(pass.round, &declared).await?;
            let arrival = arrival(pass.target, &listed.id, listed.received_at, listed.size);
            let (entry, next_at) = (listed.clone(), local_now().saturating_add(self.sender_wait(1)));
            let keeping =
                move |store: &LocalStore| keep_e2e(store, &arrival, &entry, plaintext, &declared, answer, next_at);
            kept = self.store.with(keeping).await?;
        }
        match kept {
            Kept::Undecryptable => self.skip(pass, listed, SkipReason::Undecryptable).await,
            Kept::Unparseable => self.skip(pass, listed, SkipReason::Unparseable).await,
            Kept::Stored(new) => {
                pass.report.stored += usize::from(new);
                pass.report.fresh += usize::from(new && pass.fresh);
                Ok(Outcome::Done)
            }
            Kept::Pending | Kept::E2e { .. } => Ok(Outcome::Done),
        }
    }

    /// Asks the round's directory about a declared sender; a stop or the deadline cut it short. Once the registry did
    /// not answer in this round, it is not asked again until the next one.
    async fn lookup(&self, round: &Round<'_>, declared: &Address) -> Result<SenderAnswer, Halt> {
        if round.registry_down.load(Ordering::SeqCst) {
            return Ok(Err(DirectoryError::RegistryUnavailable));
        }
        let lookup = round.senders.resolve_sender(&declared.addr_key, &declared.address);
        let answer = self.interruptible(round, async { Ok(lookup.await) }).await?;
        if answer.is_err() {
            round.registry_down.store(true, Ordering::SeqCst);
        }
        Ok(answer)
    }

    /// Seconds to wait before the next sender lookup of a mail that already had `attempts` tries.
    fn sender_wait(&self, attempts: u32) -> i64 {
        let doubling = self.config.sender_retry_base.saturating_mul(1 << attempts.saturating_sub(1).min(20));
        i64::try_from(doubling.min(self.config.sender_retry_cap).as_secs()).unwrap_or(i64::MAX)
    }

    /// Tries again the end-to-end mail of this address that waits for its sender lookup and is due. The first time in
    /// this session, all of it gets its tries back. Once the registry does not answer, the rest waits for a later
    /// round.
    async fn retry_senders(&self, target: &SyncTarget, round: &Round<'_>, report: &mut SyncReport) -> Result<(), Halt> {
        let addr_key = target.addr_key;
        if lock(&self.rearmed).insert(addr_key) {
            self.store.with(move |store| store.rearm_e2e_pending(&addr_key)).await?;
        }
        let max = self.config.sender_max_attempts;
        let due = self.store.with(move |store| store.due_e2e_pending(&addr_key, local_now(), max)).await?;
        let fresh = lock(&self.caught_up).contains(&addr_key);
        for entry in due {
            if self.halted(round) {
                return Err(Halt::Pause);
            }
            let id = entry.server_id.clone();
            let Some(pending) = self.store.with(move |store| store.get_e2e_pending(&addr_key, &id)).await? else {
                continue;
            };
            let arrival = arrival(target, &pending.server_id, pending.received_at, pending.size_bucket);
            let Some(declared) = inbox::declared_sender(&pending.plaintext) else {
                // It decoded when it arrived; if a newer app reads it differently, it is dropped rather than retried.
                self.store.with(move |store| store.drop_e2e_pending(&addr_key, &arrival.server_id)).await?;
                continue;
            };
            let answer = self.lookup(round, &declared).await?;
            let unavailable = answer.is_err();
            let attempts = entry.attempts.saturating_add(1);
            let retry = (attempts, local_now().saturating_add(self.sender_wait(attempts)));
            let retrying = move |store: &LocalStore| retry_e2e(store, &arrival, &pending, &declared, answer, retry);
            if let Some(new) = self.store.with(retrying).await? {
                report.stored += usize::from(new);
                report.fresh += usize::from(new && fresh);
            }
            if unavailable {
                break;
            }
        }
        Ok(())
    }

    /// Stored cursor; an unreadable one is reset to 0.
    async fn load_cursor(&self, addr_key: [u8; 32]) -> Result<u64, Halt> {
        let text = self.store.with(move |store| store.get_sync_cursor(&addr_key)).await?;
        match text.map(|t| t.parse::<u64>().ok().filter(|&n| n <= MAX_CURSOR)) {
            None => Ok(0),
            Some(Some(cursor)) => Ok(cursor),
            Some(None) => {
                log::warn!("mail: unreadable cursor; restarting");
                self.store.with(move |store| store.reset_sync_cursor(&addr_key)).await?;
                Ok(0)
            }
        }
    }

    /// Monotonic (guaranteed by the store).
    async fn save_cursor(&self, addr_key: [u8; 32], cursor: u64) -> Result<(), Halt> {
        Ok(self.store.with(move |store| store.set_sync_cursor(&addr_key, &cursor.to_string())).await?)
    }
}

/// Where a message of `target` arrived, for [`inbox`].
fn arrival(target: &SyncTarget, server_id: &str, received_at: i64, size_bucket: u32) -> Arrival {
    Arrival {
        addr_key: target.addr_key,
        address: target.address.clone(),
        server_id: server_id.to_owned(),
        received_at,
        size_bucket,
    }
}

/// A pause shaped as a request that cannot fail (so [`MailSync::interruptible`] can cut it).
async fn sleep_ok(pause: Duration) -> Result<(), MailError> {
    tokio::time::sleep(pause).await;
    Ok(())
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod e2e_tests;
