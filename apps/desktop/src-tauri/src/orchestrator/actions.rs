//! Explicit user actions (never automatic), operation locks and orderly shutdown.

use std::sync::atomic::Ordering;

use tokio::sync::MutexGuard;

use super::bonos::{journal_id, method_key, receipt_key};
use super::ports::{Chain, Issuer, Relayer};
use super::types::{AddressView, SlotId};
use super::{OrchError, Orchestrator, Progress, Result};
use crate::store::{SlotKey, SlotStatus};

/// Margin after a receipt's insertion deadline before the leaf may be abandoned (provisional).
pub(super) const FORGET_MARGIN_S: i64 = 5 * 60;
/// A submitted proof can land until its TTL (up to 35 min, and the relayer/payer may extend it to 1 h), so a slot
/// with attempts can only be abandoned 65 min after its last proof.
pub(super) const ABANDON_TTL_S: i64 = 65 * 60;

impl<C, I, R> Orchestrator<C, I, R> {
    /// Lock for address operations; announces `Queued` if it has to wait.
    pub(crate) async fn address_lock(&self) -> MutexGuard<'_, ()> {
        match self.ops.try_lock() {
            Ok(guard) => guard,
            Err(_) => {
                self.emit(Progress::Queued);
                self.ops.lock().await
            }
        }
    }

    /// Lock for bono operations. They do not queue (a payment never waits for another): `Busy`.
    pub(crate) fn bono_lock(&self) -> Result<MutexGuard<'_, ()>> {
        self.bono_ops.try_lock().map_err(|_| OrchError::Busy)
    }

    /// Is a payment running, or a `buyBono` that may still be in flight? Then the app must not close the sidecar.
    pub fn wallet_busy(&self) -> bool {
        self.bono_ops.try_lock().is_err() || self.wallet_in_flight.load(Ordering::SeqCst)
    }
}

impl<C: Chain, I: Issuer, R: Relayer> Orchestrator<C, I, R> {
    /// User action after a persistent `StaleState`: try again (resets the `behind` streak).
    pub async fn retry_stale(&self) -> Result<()> {
        self.db(|s| s.reset_behind_streak()).await
    }

    /// Before an address operation the user asked for (create, resume a paused one, provide its name): sync again on
    /// our own, exactly as `retry_stale` does, so a lasting `StaleState` left by earlier work does not block it and the
    /// user never needs "Sync again" there. The operation then still has its own `max_behind` cap. Work nobody asked
    /// for (`resume_background`, the `resume` at unlock, bonos) never does this, so a lagging or lying indexer still
    /// stops it at the global cap.
    pub(crate) async fn sync_for_user_address_op(&self) -> Result<()> {
        self.retry_stale().await
    }

    /// User action: resumes a slot paused by the proof cap (its counters reset) and drives it.
    pub async fn resume_paused_slot(&self, slot: SlotId) -> Result<AddressView> {
        let _guard = self.address_lock().await;
        self.sync_for_user_address_op().await?;
        let (key, now) = (SlotKey::from(slot), self.now());
        self.db(move |s| s.reset_slot_attempts(key, now)).await?;
        self.drive(key).await.map(|a| AddressView::from(&a))
    }

    /// User action: abandons a `reserving` mailbox or alias to start another (e.g. with another name). Without
    /// attempts, always; with attempts, only if the chain has nothing for that slot and its last proof's TTL (65 min)
    /// has expired; otherwise `StillPending`.
    pub async fn abandon_slot(&self, slot: SlotId) -> Result<()> {
        let _guard = self.address_lock().await;
        let key = SlotKey::from(slot);
        let current = self.slot(key).await?;
        if current.status != SlotStatus::Reserving {
            return Err(OrchError::StillPending);
        }
        if current.attempts > 0 {
            let facts = self.facts(&current, None).await?;
            let quiet = facts.address.is_none() && !facts.spent;
            if !quiet {
                return Err(OrchError::StillPending);
            }
        }
        let not_after = self.now() - ABANDON_TTL_S;
        if self.db(move |s| s.abandon_reserving_slot(key, not_after)).await? {
            self.stuck.lock().unwrap_or_else(|e| e.into_inner()).retain(|(k, _)| *k != key);
            Ok(())
        } else {
            Err(OrchError::StillPending)
        }
    }

    /// User action: abandons a requested leaf that was never issued (to pay another way). Not allowed while it can
    /// still land: a purchase in the journal, or a receipt with now ≤ insertBy + 5 min; with no saved receipt (lost
    /// response) the Issuer is asked first (`known_receipt`). If the leaf is already in the tree, it is marked
    /// included instead of abandoned.
    pub async fn forget_pending_bono(&self, n: u32, k: u32) -> Result<()> {
        let _guard = self.bono_lock()?;
        // Journal purchases past their TTL can no longer land: close them here too, not only in `resume` (which may
        // not run again until the next unlock).
        self.forget_stale_purchases().await?;
        if self.db(|s| s.list_journal()).await?.iter().any(|e| e.id == journal_id(n, k)) {
            return Err(OrchError::StillPending);
        }
        let insert_by = self.known_receipt(n, k).await?.map(|r| r.insert_by);
        let deadline = insert_by.map(|t| i64::try_from(t).unwrap_or(i64::MAX).saturating_add(FORGET_MARGIN_S));
        if deadline.is_some_and(|d| self.now() <= d) {
            return Err(OrchError::StillPending);
        }
        let bono = self.db(move |s| s.get_bono(n, k)).await?.ok_or(OrchError::Internal)?;
        let leaf = self.leaf_of(&hex::encode(bono.id), bono.plan).await?;
        if let Some(position) = self.find_leaves(&[leaf]).await?.1[0] {
            return self.settle_leaf(n, k, bono.plan, position, None).await.map(drop);
        }
        self.db(move |s| s.forget_bono_request(n, k, &[&method_key(n, k), &receipt_key(n, k)])).await
    }

    /// Orderly shutdown (on app exit): waits for the running bono operation and closes the wallet, unless a `buyBono`
    /// may still be in flight (its journal entry protects it; it closes with the sidecar).
    pub async fn shutdown(&self) {
        let _guard = self.bono_ops.lock().await;
        self.close_wallet_if_idle().await;
    }
}
