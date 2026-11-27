//! Picking up what was left unfinished when the app closed: requested leaves already in the tree, shielded purchases
//! in the journal, and slots in `reserving`.

use serde::Serialize;
use ts_rs::TS;

use super::actions::{ABANDON_TTL_S, FORGET_MARGIN_S};
use super::bonos::{BUY_JOURNAL_KIND, journal_id, receipt_key};
use super::ports::{Chain, Issuer, Receipt, Relayer};
use super::types::SlotId;
use super::{OrchError, Orchestrator, Result};
use crate::protocol::AddressKind;
use crate::store::{BonoLeaf, BonoStatus, Slot, SlotKey, SlotKind, SlotStatus};

/// A purchase without a leaf is forgotten 35 min after its last call (the transaction's TTL has expired by then).
/// This is also a proof's maximum TTL.
pub(crate) const BUY_CLEANUP_S: i64 = 35 * 60;
/// Margin after `BUY_CLEANUP_S` for the `resume` turn that closes an expired journal purchase.
const CLEANUP_MARGIN_S: i64 = 60;

/// Seconds from `now` until `at` (0 if already past).
fn secs_until(now: i64, at: i64) -> u64 {
    u64::try_from(at.saturating_sub(now)).unwrap_or(0)
}

/// When to look again (for the automatic retry; the UI does not see this).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RetryHint {
    /// Something is pending without an error and may resolve itself: a purchase in the journal or a requested leaf
    /// with its receipt still valid (`insertBy` + 5 min). Look again even with no failures.
    pub pending: bool,
    /// Before this (seconds from the report) another turn is pointless: what the relayer asked for (429) or the time
    /// until a bono becomes usable.
    pub not_before_s: u64,
    /// The oldest journal purchase is closed (and `wallet_in_flight` cleared) by the turn that comes after this many
    /// seconds: the retry must not sleep longer than this.
    pub due_in_s: Option<u64>,
    /// Parts of our server that were not serving. While they stay silent no turn runs (nothing is proved), and as
    /// soon as they answer, one turn right away.
    pub server: ServerParts,
}

/// Parts of our server that the unfinished work depends on.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ServerParts {
    /// The relayer (address operations).
    pub relayer: bool,
    /// The Issuer (bono leaves).
    pub issuer: bool,
}

impl ServerParts {
    pub fn any(self) -> bool {
        self.relayer || self.issuer
    }
}

impl OrchError {
    /// Our server was not serving: it did not answer, or answered with an error or "busy" (not a rejection).
    pub fn server_down(self) -> bool {
        matches!(self, OrchError::ServiceUnavailable | OrchError::ServerUnreachable)
    }
}

/// A slot still unfinished, and why.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub struct SlotFailure {
    pub slot: SlotId,
    pub error: OrchError,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub struct ResumeReport {
    /// Requested leaves that were already in the tree.
    pub bonos_included: u32,
    /// Why the requested leaves could not be checked (retried on the next `resume`), or `null`. With a payment
    /// running they are not checked (`busy`).
    pub bonos_error: Option<OrchError>,
    /// Addresses completed.
    pub addresses: u32,
    /// Mailboxes without a readable name, deduplicated: ask for it (`provide_name`).
    pub needs_name: Vec<SlotId>,
    /// Slots still unfinished, with the reason (retried on the next `resume`; `AttemptsExhausted` = paused).
    pub failed: Vec<SlotFailure>,
    #[serde(skip)]
    #[ts(skip)]
    pub retry: RetryHint,
}

impl ResumeReport {
    /// Is it worth retrying on our own (in the background)? Yes if something failed for a reason that may clear by
    /// itself (network, service, round, wallet…) or something is pending without an error ([`RetryHint::pending`]).
    /// Not for what only the user can fix: slot paused by the proof cap (`resume_paused_slot`), persistent stale state
    /// (`retry_stale`), missing or wrong name, burned slot, wrong configuration or contract. Retrying is cheap: each
    /// slot checks the chain first and its proof cap pauses it.
    pub fn needs_retry(&self) -> bool {
        self.retry.pending
            || self.bonos_error.is_some_and(OrchError::may_clear_by_itself)
            || self.failed.iter().any(|f| f.error.may_clear_by_itself())
    }

    /// Seconds from `now` before which retrying is pointless: the larger of what the relayer asked for (429) and the
    /// time until a bono becomes usable.
    pub(crate) fn not_before_s(&self, now: i64) -> u64 {
        let wait = |error: OrchError| match error {
            OrchError::RateLimited { retry_after_s } => retry_after_s,
            OrchError::BonoNotReady { usable_at: Some(at) } => secs_until(now, at),
            _ => 0,
        };
        self.failed.iter().map(|f| wait(f.error)).max().unwrap_or(0)
    }

    /// Parts of the server that were not serving in this turn: the relayer if a slot failed that way, the Issuer if
    /// the leaves did.
    pub(crate) fn server_down(&self) -> ServerParts {
        ServerParts {
            relayer: self.failed.iter().any(|f| f.error.server_down()),
            issuer: self.bonos_error.is_some_and(OrchError::server_down),
        }
    }
}

impl OrchError {
    /// Can it go away without the user doing anything? (see [`ResumeReport::needs_retry`]). An allowlist with an
    /// exhaustive `match`, so a new variant forces a decision. `Internal` and `Store` are not retried automatically
    /// (provisional; the UI shows them with "Retry now").
    pub fn may_clear_by_itself(self) -> bool {
        match self {
            OrchError::MidnightUnavailable
            | OrchError::Busy
            | OrchError::BonoNotReady { .. }
            | OrchError::RateLimited { .. }
            | OrchError::ServiceUnavailable
            | OrchError::ServerUnreachable
            | OrchError::StillPending
            | OrchError::Wallet { .. } => true,
            // A contract rejection would just repeat.
            OrchError::CallRejected { .. }
            | OrchError::SidecarTooOld
            | OrchError::ContractMismatch
            | OrchError::Clock
            | OrchError::StaleState
            | OrchError::AlreadyHasPlan
            | OrchError::BadConfig
            | OrchError::NameRejected { .. }
            | OrchError::NameTaken
            | OrchError::NoFreeSlot
            | OrchError::AttemptsExhausted
            | OrchError::SlotBurned
            | OrchError::NeedsName
            | OrchError::WrongName
            // Deterministic: the suffix comes from fixed keys and `slot_nul`.
            | OrchError::AliasSuffixTaken
            | OrchError::RelayerRefused
            | OrchError::CaptchaFailed
            | OrchError::PaymentFailed
            | OrchError::IssueFailed
            | OrchError::BadReceipt
            | OrchError::PriceChanged
            | OrchError::InsufficientFunds { .. }
            | OrchError::Store
            | OrchError::Internal => false,
        }
    }
}

/// An unfinished mailbox or alias, for the UI. `Debug` omits the name.
#[derive(Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub struct PendingSlot {
    pub slot: SlotId,
    /// Used up its proof cap: waits for the user to resume it (`resume_paused_slot`).
    pub paused: bool,
    /// An operation is driving it right now (create, pick up or resume): there is nothing to retry or abandon until it
    /// finishes.
    pub in_progress: bool,
    /// Stopped: it will not continue without the user. It used up its proof cap, or its last attempt failed with
    /// something that does not clear by itself. The background retry (`resume_background`) leaves it alone; it is
    /// driven again by "Retry", "Resume" or at unlock. Otherwise (and if not running) the app will retry it on its own.
    pub stopped: bool,
    /// Why it is stopped (`stopped`), to show on its row; `null` if it is not. Proof cap used up: `AttemptsExhausted`;
    /// otherwise the error of its last `drive` (`stuck`).
    pub stop_reason: Option<OrchError>,
    /// The store would already allow abandoning it (`abandon_slot`): `reserving`, with no attempts or 65 min after the
    /// last. The chain may still refuse (`StillPending`) if it sees one of its proofs.
    pub abandonable: bool,
    /// Name chosen for the mailbox (local only), or `null` (alias).
    pub name: Option<String>,
}

impl std::fmt::Debug for PendingSlot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PendingSlot")
            .field("slot", &self.slot)
            .field("paused", &self.paused)
            .field("in_progress", &self.in_progress)
            .field("stopped", &self.stopped)
            .field("stop_reason", &self.stop_reason)
            .field("abandonable", &self.abandonable)
            .finish()
    }
}

/// Has it used up its proof cap (the same count as `drive`'s)?
fn exhausted(slot: &Slot, max_proofs: u32) -> bool {
    slot.attempts >= max_proofs
}

impl PendingSlot {
    /// `driving`: the slot `drive` is on right now, if any. `stuck`: the error of its last `drive`, if it failed with
    /// something that does not clear by itself. `not_after`: the `abandon_slot` limit (now minus its TTL).
    fn build(
        slot: Slot,
        max_proofs: u32,
        driving: Option<SlotKey>,
        stuck: Option<OrchError>,
        not_after: i64,
    ) -> Option<Self> {
        if slot.status != SlotStatus::Reserving {
            return None;
        }
        let paused = exhausted(&slot, max_proofs);
        let in_progress = driving == Some(slot.key);
        // A running row is never stopped. Otherwise, reasons that need something from the user come first.
        let stop_reason = if in_progress {
            None
        } else if paused {
            Some(OrchError::AttemptsExhausted)
        } else {
            stuck
        };
        Some(Self {
            slot: slot.key.into(),
            paused,
            in_progress,
            stopped: stop_reason.is_some(),
            stop_reason,
            abandonable: slot.abandonable(not_after),
            name: slot.pending_name,
        })
    }
}

impl<C, I, R> Orchestrator<C, I, R> {
    /// Unfinished mailboxes and aliases (to resume or abandon from the UI). Only reads the store.
    pub async fn pending_slots(&self) -> Result<Vec<PendingSlot>> {
        let max = self.d.config.retry.max_proofs;
        let not_after = self.now() - ABANDON_TTL_S;
        // A single read, so a slot changing state between queries cannot appear twice or go missing.
        let slots = self.db(|s| s.slots_by_status(SlotStatus::Reserving)).await?;
        // The mark is read after the store. If a `drive` finishes between the two reads, the row shows the previous
        // state without the mark, and the read triggered by its `PendingChanged` (when the mark clears) corrects it.
        let driving = *self.driving.lock().unwrap_or_else(|e| e.into_inner());
        let stuck = {
            let mut list = self.stuck.lock().unwrap_or_else(|e| e.into_inner());
            // Anything no longer unfinished (completed, released or abandoned) is no longer kept.
            list.retain(|(k, _)| slots.iter().any(|s| s.key == *k));
            list.clone()
        };
        let mut pending: Vec<PendingSlot> = slots
            .into_iter()
            .filter_map(|slot| {
                let error = stuck.iter().find(|(k, _)| *k == slot.key).map(|(_, error)| *error);
                PendingSlot::build(slot, max, driving, error, not_after)
            })
            .collect();
        pending.sort_by_key(|p| (p.slot.n, p.slot.kind == AddressKind::Alias, p.slot.j));
        Ok(pending)
    }
}

impl<C: Chain, I: Issuer, R: Relayer> Orchestrator<C, I, R> {
    /// Picks up everything pending, including stopped slots: the user asked ("Retry") or just unlocked. A failing slot
    /// or failing leaves do not prevent picking up the rest.
    pub async fn resume(&self) -> Result<ResumeReport> {
        self.resume_with(true).await
    }

    /// The automatic background retry: like [`Orchestrator::resume`], but leaving stopped slots alone (they will not
    /// continue without the user). They appear in the report with their last error, as if attempted.
    pub async fn resume_background(&self) -> Result<ResumeReport> {
        self.resume_with(false).await
    }

    async fn resume_with(&self, asked: bool) -> Result<ResumeReport> {
        let _guard = self.address_lock().await;
        let mut report = ResumeReport::default();
        match self.resume_bonos().await {
            Ok(included) => report.bonos_included = included,
            Err(e) => report.bonos_error = Some(e),
        }
        for slot in self.db(|s| s.slots_by_status(SlotStatus::Reserving)).await? {
            self.resume_slot(slot, asked, &mut report).await;
        }
        let unnamed = self.unnamed_mailboxes().await?;
        report.needs_name.extend(unnamed.into_iter().map(SlotId::from));
        report.needs_name.sort_by_key(|s| (s.n, s.j));
        report.needs_name.dedup();
        report.retry = self.retry_hint(&report).await?;
        Ok(report)
    }

    /// When to look at what remains again (see [`RetryHint`]). Only reads the store.
    async fn retry_hint(&self, report: &ResumeReport) -> Result<RetryHint> {
        let now = self.now();
        let buys = self.journal_buys().await?;
        let due_in_s = buys.iter().map(|t| secs_until(now, t + BUY_CLEANUP_S + CLEANUP_MARGIN_S)).min();
        let pending = !buys.is_empty() || self.receipt_in_window(now).await?;
        Ok(RetryHint { pending, not_before_s: report.not_before_s(now), due_in_s, server: report.server_down() })
    }

    /// Is there a payment that may resolve itself (journal purchase or a leaf with a valid receipt)? Lets the app
    /// schedule the retry after a payment that did not finish. Only reads the store.
    pub async fn payment_pending(&self) -> Result<bool> {
        Ok(!self.journal_buys().await?.is_empty() || self.receipt_in_window(self.now()).await?)
    }

    /// Time of the last call of each shielded purchase in the journal.
    async fn journal_buys(&self) -> Result<Vec<i64>> {
        let journal = self.db(|s| s.list_journal()).await?;
        Ok(journal.into_iter().filter(|e| e.kind == BUY_JOURNAL_KIND).map(|e| e.started_at).collect())
    }

    /// Does any requested leaf have a receipt that can still be honoured (now ≤ `insertBy` + 5 min, the same rule as
    /// `forget_pending_bono`)?
    async fn receipt_in_window(&self, now: i64) -> Result<bool> {
        let requested: Vec<BonoLeaf> =
            self.db(|s| s.list_bonos()).await?.into_iter().filter(|b| b.status == BonoStatus::Requested).collect();
        for b in requested {
            let saved = self.db(move |s| s.get_meta(&receipt_key(b.n, b.k))).await?;
            let insert_by = saved.and_then(|v| serde_json::from_slice::<Receipt>(&v).ok()).map(|r| r.insert_by);
            let deadline = insert_by.map(|t| i64::try_from(t).unwrap_or(i64::MAX).saturating_add(FORGET_MARGIN_S));
            if deadline.is_some_and(|d| now <= d) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    async fn resume_slot(&self, slot: Slot, asked: bool, report: &mut ResumeReport) {
        if !asked && let Some(error) = self.stopped_error(&slot) {
            report.failed.push(SlotFailure { slot: slot.key.into(), error });
            return;
        }
        // Marked right away, so the row shows "in progress" as soon as "Retry" is pressed.
        let _driving = super::addresses::Driving::mark(&self.driving, self.d.events.as_ref(), slot.key);
        match self.drive(slot.key).await {
            Ok(_) => report.addresses += 1,
            Err(OrchError::NeedsName) => report.needs_name.push(slot.key.into()),
            Err(error) => report.failed.push(SlotFailure { slot: slot.key.into(), error }),
        }
    }

    /// Why a slot is stopped (its last error), or `None` if the app can carry on with it by itself.
    fn stopped_error(&self, slot: &Slot) -> Option<OrchError> {
        if exhausted(slot, self.d.config.retry.max_proofs) {
            return Some(OrchError::AttemptsExhausted);
        }
        let stuck = self.stuck.lock().unwrap_or_else(|e| e.into_inner());
        stuck.iter().find(|(k, _)| *k == slot.key).map(|(_, error)| *error)
    }

    /// Registered mailboxes whose name could not be recovered.
    async fn unnamed_mailboxes(&self) -> Result<Vec<SlotKey>> {
        let addresses = self.db(|s| s.list_addresses()).await?;
        Ok(addresses
            .iter()
            .filter(|a| a.kind == SlotKind::Mailbox && a.name.is_none())
            .map(|a| SlotKey { n: a.n, kind: a.kind, j: a.j })
            .collect())
    }

    /// Requested leaves: those already in the tree are marked included (closing their journal entry). Journal
    /// purchases without a leaf 35 min after their last call are closed since they can no longer land; this also
    /// happens if the leaf lookup fails (Midnight down) so `wallet_in_flight` still clears: the closing rule is purely
    /// time based, as in `forget_pending_bono`. With a payment running, nothing.
    async fn resume_bonos(&self) -> Result<u32> {
        let _guard = self.bono_lock()?;
        let included = self.settle_found_leaves().await;
        self.forget_stale_purchases().await?;
        included
    }

    /// Requested leaves already in the tree are marked included (closing their journal entry, if any).
    async fn settle_found_leaves(&self) -> Result<u32> {
        let requested: Vec<BonoLeaf> =
            self.db(|s| s.list_bonos()).await?.into_iter().filter(|b| b.status == BonoStatus::Requested).collect();
        let journal = self.db(|s| s.list_journal()).await?;
        let mut leaves = Vec::with_capacity(requested.len());
        for b in &requested {
            leaves.push(self.leaf_of(&hex::encode(b.id), b.plan).await?);
        }
        let positions = if leaves.is_empty() { Vec::new() } else { self.find_leaves(&leaves).await?.1 };
        let mut included = 0;
        for (b, position) in requested.iter().zip(positions) {
            let Some(position) = position else { continue };
            let id = journal_id(b.n, b.k);
            let entry = journal.iter().any(|e| e.id == id).then_some(id);
            self.settle_leaf(b.n, b.k, b.plan, position, entry).await?;
            included += 1;
        }
        Ok(included)
    }

    pub(super) async fn forget_stale_purchases(&self) -> Result<()> {
        let now = self.now();
        for entry in self.db(|s| s.list_journal()).await? {
            if entry.kind == BUY_JOURNAL_KIND && now - entry.started_at > BUY_CLEANUP_S {
                self.db(move |s| s.remove_journal(&entry.id)).await?;
                self.wallet_in_flight.store(false, std::sync::atomic::Ordering::SeqCst);
            }
        }
        Ok(())
    }
}
