//! Restore: given the seed on a clean profile, rebuild bonos, slots and addresses from the contract's public state.
//!
//! 1. Scan bonos `n = 0, 1, …` until `GAP` consecutive ones have no leaf. Candidate leaves are `k ∈ {0, 1}` ×
//!    {free, paid} with `validUntil = SIN_CADUCIDAD` (`contract.hashes`), looked up with `contract.findBonos` in
//!    batches of 64 bonos (256 leaves, under the 1024-per-call limit).
//! 2. Derive the nullifiers of every slot of each bono found (contract quotas: free 1 + 2, paid 5 + 20).
//! 3. Look each nullifier up in the full state (`contract.snapshot`, all pages): its address (checking the
//!    registered keys are `address_keys(n, kind, j)` and, for an alias, that `addrKey` derives from them; otherwise
//!    the slot is burned), its unrevealed reservation (`reserved` with no name, the app will ask for it), or a spent
//!    nullifier with nothing attached (`burned`, safe to conclude here because the whole state is visible).
//!
//! Store operations are idempotent, so restoring twice changes nothing. A slot that contradicts local data is
//! skipped and counted instead of aborting. Issuer receipts are local: a paid bono still queued is not visible until
//! it is inserted.

use serde::Serialize;
use ts_rs::TS;

use crate::orchestrator::chain::{ChainView, parse_round};
use crate::orchestrator::ports::{Chain, Issuer, Relayer};
use crate::orchestrator::{OrchError, Orchestrator, Progress, Result, SlotId, bytes32, slot_limit, to_protocol_plan};
use crate::protocol::HashOp;
use crate::store::{BonoLeaf, BonoStatus, Plan, Slot, SlotKey, SlotKind, SlotPatch, SlotStatus};

/// Consecutive leafless bonos after which scanning stops (provisional value).
pub const GAP: u32 = 3;
/// Candidate leaves per bono: `k` ∈ {0, 1} (purchase or free plan, plus one plan upgrade).
const LEAVES_PER_K: u32 = 2;
/// Bonos per batch (4 leaves each, so 256 leaves per `findBonos`).
const BATCH_N: u32 = 64;
/// Upper bound for `n`: there cannot be more bonos than leaves in the tree.
const MAX_N: u32 = 1 << 20;
const PLANS: [Plan; 2] = [Plan::Free, Plan::Paid];

/// Restore summary (does not say which addresses).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub struct RecoveryReport {
    pub bonos: u32,
    pub addresses: u32,
    pub burned: u32,
    /// Leaves or slots contradicting this profile's data; skipped rather than aborting the restore.
    pub conflicts: u32,
    /// Mailboxes without a name (unrevealed reservation or unreadable name); ask the user (`Orchestrator::provide_name`).
    pub needs_name: Vec<SlotId>,
}

/// A leaf found in the tree. `Debug` omits the `id`.
#[derive(Clone, PartialEq, Eq)]
struct Found {
    n: u32,
    k: u32,
    plan: Plan,
    id: String,
    position: u32,
}

impl std::fmt::Debug for Found {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        crate::orchestrator::bonos::debug_leaf(f, "Found", (self.n, self.k, to_protocol_plan(self.plan)))
    }
}

impl<C: Chain, I: Issuer, R: Relayer> Orchestrator<C, I, R> {
    /// Restores from the chain. Afterwards the addresses are in the store, ready for MailSync.
    pub async fn recover(&self) -> Result<RecoveryReport> {
        let _guard = self.address_lock().await;
        let mut conflicts = 0;
        let mut found = self.scan_bonos().await?;
        // A leaf contradicting local data is skipped and counted; paid leaves go first so they win.
        found.sort_by_key(|f| (f.plan != Plan::Paid, f.n, f.k));
        for leaf in &found {
            match self.store_found(leaf).await {
                Err(OrchError::Store) => conflicts += 1,
                other => other?,
            }
        }
        let bonos = self.db(|s| s.list_bonos()).await?;
        let spends = crate::orchestrator::addresses::spends(&bonos);
        let mut report = RecoveryReport { bonos: spends.len() as u32, conflicts, ..RecoveryReport::default() };
        let view = self.chain_view().await?;
        for (spend, _) in spends {
            let keys = slot_keys(spend.n, spend.plan);
            let ops = keys.iter().map(|k| self.slot_nul_op(*k)).collect::<Result<Vec<_>>>()?;
            let nuls = self.hash_all(ops).await?;
            for (key, nul) in keys.into_iter().zip(nuls) {
                match self.recover_slot(key, &nul, &view, &mut report).await {
                    Err(OrchError::Store) => report.conflicts += 1,
                    other => other?,
                }
            }
        }
        Ok(report)
    }

    /// Scans `n = 0, 1, …` in batches until `GAP` consecutive bonos have no leaf.
    async fn scan_bonos(&self) -> Result<Vec<Found>> {
        let (mut found, mut gap, mut n) = (Vec::new(), 0, 0);
        while gap < GAP && n < MAX_N {
            self.emit(Progress::Recovering { n });
            let batch: Vec<u32> = (n..n + BATCH_N).collect();
            for hits in self.leaves_of(&batch).await? {
                if gap >= GAP {
                    break;
                }
                gap = if hits.is_empty() { gap + 1 } else { 0 };
                found.extend(hits);
            }
            n += BATCH_N;
        }
        Ok(found)
    }

    /// For each `n` in the batch, the leaves present in the tree, in batch order.
    async fn leaves_of(&self, batch: &[u32]) -> Result<Vec<Vec<Found>>> {
        let pairs: Vec<(u32, u32)> = batch.iter().flat_map(|&n| (0..LEAVES_PER_K).map(move |k| (n, k))).collect();
        let ids =
            self.hash_all(pairs.iter().map(|&(n, k)| HashOp::IdK { s: self.bono_secret(n), k }).collect()).await?;
        let candidates: Vec<(usize, Plan)> = (0..ids.len()).flat_map(|i| PLANS.map(|plan| (i, plan))).collect();
        let leaf_ops = candidates.iter().map(|&(i, plan)| HashOp::Leaf {
            id: ids[i].clone(),
            plan: to_protocol_plan(plan),
            valid_until: crate::orchestrator::NO_EXPIRY,
        });
        let leaves = self.hash_all(leaf_ops.collect()).await?;
        let (_, positions) = self.find_leaves(&leaves).await?;
        let mut out: Vec<Vec<Found>> = batch.iter().map(|_| Vec::new()).collect();
        for (&(i, plan), position) in candidates.iter().zip(positions) {
            let Some(position) = position else { continue };
            let (n, k) = pairs[i];
            out[(n - batch[0]) as usize].push(Found { n, k, plan, id: ids[i].clone(), position });
        }
        Ok(out)
    }

    /// Records the leaf (as requested if missing) and marks it included, usable now if it had no `usable_at`. Idempotent.
    async fn store_found(&self, f: &Found) -> Result<()> {
        let leaf = BonoLeaf {
            n: f.n,
            k: f.k,
            plan: f.plan,
            id: bytes32(&f.id)?,
            status: BonoStatus::Requested,
            position: None,
            requested_at: self.now(),
            usable_at: None,
        };
        let (n, k, position, now) = (f.n, f.k, f.position, self.now());
        self.db(move |s| {
            s.insert_bono(&leaf)?;
            s.include_bono(n, k, position, now, None)
        })
        .await
    }

    async fn recover_slot(&self, key: SlotKey, nul: &str, view: &ChainView, report: &mut RecoveryReport) -> Result<()> {
        let slot = self.local_slot(key, nul).await?;
        if let Some(entry) = view.address_by_nul(nul) {
            let Some(address) = self.address_from_entry(key, entry, None).await? else {
                return self.mark(slot, SlotStatus::Burned, SlotPatch::default(), &mut report.burned).await;
            };
            // A slot abandoned on this profile is still reconciled (it stays abandoned), but the app no longer
            // tracks it: no name prompt and not counted.
            let addr_key = address.addr_key;
            let abandoned = self.db(move |s| s.is_address_abandoned(&addr_key)).await?;
            if !abandoned && address.kind == SlotKind::Mailbox && address.name.is_none() {
                report.needs_name.push(key.into());
            }
            let now = self.now();
            self.db(move |s| s.reconcile_address(&slot, &address, now)).await?;
            if !abandoned {
                report.addresses += 1;
            }
        } else if let Some(pending) = view.pending_by_nul(nul).filter(|_| key.kind == SlotKind::Mailbox) {
            let patch = SlotPatch { round: Some(parse_round(&pending.reserved_round)?), ..SlotPatch::default() };
            self.mark(slot, SlotStatus::Reserved, patch, &mut 0).await?;
            if self.db(move |s| s.get_slot(key)).await?.is_some_and(|s| s.pending_name.is_none()) {
                report.needs_name.push(key.into());
            }
        } else if view.nullifiers.contains(nul) {
            self.mark(slot, SlotStatus::Burned, SlotPatch::default(), &mut report.burned).await?;
        }
        Ok(())
    }

    /// The slot as stored, or a new one (not yet recorded) with its nullifier.
    async fn local_slot(&self, key: SlotKey, nul: &str) -> Result<Slot> {
        let (existing, slot_nul) = (self.db(move |s| s.get_slot(key)).await?, bytes32(nul)?);
        if existing.as_ref().is_some_and(|s| s.slot_nul != slot_nul) {
            return Err(OrchError::Store); // local slot belongs to another seed or is corrupt: skip it
        }
        Ok(existing.unwrap_or(Slot {
            key,
            slot_nul,
            status: SlotStatus::Reserved,
            addr_key: None,
            round: None,
            pending_name: None,
            reserve_attempts: 0,
            reveal_attempts: 0,
            updated_at: self.now(),
        }))
    }

    /// Moves the slot to `to` using what the chain says: creates it if missing, otherwise reconciles it (a slot
    /// already in that state is not counted again).
    async fn mark(&self, slot: Slot, to: SlotStatus, patch: SlotPatch, counter: &mut u32) -> Result<()> {
        let (key, now) = (slot.key, self.now());
        let stored = self.db(move |s| s.get_slot(key)).await?;
        if stored.as_ref().is_some_and(|s| s.status == to) {
            return Ok(());
        }
        let new = Slot { status: to, round: patch.round.or(slot.round), updated_at: now, ..slot };
        self.db(move |s| if stored.is_some() { s.reconcile_slot(key, to, &patch, now) } else { s.insert_slot(&new) })
            .await?;
        *counter += 1;
        Ok(())
    }
}

/// Every slot of a bono with that plan.
fn slot_keys(n: u32, plan: Plan) -> Vec<SlotKey> {
    [SlotKind::Mailbox, SlotKind::Alias]
        .into_iter()
        .flat_map(|kind| (0..slot_limit(plan, kind)).map(move |j| SlotKey { n, kind, j }))
        .collect()
}

#[cfg(test)]
mod tests;
