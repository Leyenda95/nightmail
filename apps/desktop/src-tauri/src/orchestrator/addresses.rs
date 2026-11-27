//! Address flows: name check, mailbox and alias, each in one transaction.
//!
//! A slot is recorded as `reserving` before anything is proved and becomes `used` once its address lands, so
//! [`Orchestrator::drive`] resumes any half-done slot (also after an app restart). Each turn checks the chain first
//! (`settle.rs`), since an earlier proof may have landed; only if nothing is there is the proof cap checked (the slot
//! is paused) and a new proof made. One address operation at a time (`ops`; `Queued` if it has to wait). A bono that
//! is not usable yet is not waited for while holding the lock: `BonoNotReady { usable_at }`.

use serde::Serialize;
use tokio::sync::mpsc;
use ts_rs::TS;

use super::ports::{Chain, Issuer, Relayer};
use super::prove::Relayed;
use super::types::{AddressView, OrchEvent, SlotId};
use super::{OrchError, Orchestrator, Result, bytes32, slot_limit, to_protocol_kind, to_protocol_plan};
use crate::crypto::{open_name, seal_name};
use crate::keys::{AddressKeys, KeyManager};
use crate::mail::sync::SyncTarget;
use crate::protocol::{CallProblem, CreateAliasArgs, HashOp, NameProblem, ProveCall, RegisterMailboxArgs, SlotWitnesses};
use crate::store::{Address, BonoLeaf, BonoStatus, Plan, Slot, SlotKey, SlotKind, SlotStatus};

/// Result of `check_name`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub struct NameCheck {
    /// Name as normalised by the sidecar (the one registered).
    pub normalized: String,
    pub available: bool,
}

/// Marks the slot being driven (`drive`, and `resume` from before its wait) and clears the mark on drop, including on
/// error or when the future is dropped. Setting and clearing notify the app (`PendingChanged`), which re-reads the
/// list. Everything runs under `ops` (one at a time): only the same slot's mark can already be set (`resume`'s, before
/// its `drive`), and then this one leaves it alone.
pub(crate) struct Driving<'a> {
    cell: &'a std::sync::Mutex<Option<SlotKey>>,
    events: Option<&'a mpsc::UnboundedSender<OrchEvent>>,
    key: SlotKey,
    owner: bool,
}

impl<'a> Driving<'a> {
    pub(crate) fn mark(
        cell: &'a std::sync::Mutex<Option<SlotKey>>,
        events: Option<&'a mpsc::UnboundedSender<OrchEvent>>,
        key: SlotKey,
    ) -> Self {
        let previous = cell.lock().unwrap_or_else(|e| e.into_inner()).replace(key);
        debug_assert!(previous.is_none() || previous == Some(key), "two slots in progress at once");
        let owner = previous.is_none();
        if owner && let Some(tx) = events {
            let _ = tx.send(OrchEvent::PendingChanged);
        }
        Self { cell, events, key, owner }
    }
}

impl Drop for Driving<'_> {
    fn drop(&mut self) {
        if !self.owner {
            return;
        }
        let mut current = self.cell.lock().unwrap_or_else(|e| e.into_inner());
        // Only clear our own mark: if another one replaced it, leave it.
        if *current == Some(self.key) {
            *current = None;
            drop(current);
            if let Some(tx) = self.events {
                let _ = tx.send(OrchEvent::PendingChanged);
            }
        }
    }
}

/// The leaf bono `n`'s slots are spent with: the paid one if any (5 + 20), otherwise the free one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Spend {
    pub n: u32,
    pub k: u32,
    pub plan: Plan,
}

/// The best included leaf of each bono, by `n`.
pub(crate) fn spends(bonos: &[BonoLeaf]) -> Vec<(Spend, &BonoLeaf)> {
    let mut out: Vec<(Spend, &BonoLeaf)> = Vec::new();
    for b in bonos.iter().filter(|b| b.status == BonoStatus::Included) {
        let spend = Spend { n: b.n, k: b.k, plan: b.plan };
        match out.iter_mut().find(|(s, _)| s.n == b.n) {
            Some(slot) if b.plan == Plan::Paid => *slot = (spend, b),
            Some(_) => {}
            None => out.push((spend, b)),
        }
    }
    out
}

/// Which leaf spends slot `key` right now: the paid one if already usable; otherwise the free one if the slot fits its
/// quota; otherwise `BonoNotReady` until the paid one is (a not-yet-usable leaf is never used for a proof).
pub(crate) fn spend_now(bonos: &[BonoLeaf], key: SlotKey, now: i64) -> Result<Spend> {
    let included = |plan: Plan| {
        bonos.iter().filter(|b| b.n == key.n && b.plan == plan && b.status == BonoStatus::Included).max_by_key(|b| b.k)
    };
    let usable = |b: &BonoLeaf| b.usable_at.is_none_or(|t| t <= now);
    let as_spend = |b: &BonoLeaf| Spend { n: b.n, k: b.k, plan: b.plan };
    match (included(Plan::Paid), included(Plan::Free)) {
        (Some(paid), _) if usable(paid) => Ok(as_spend(paid)),
        (_, Some(free)) if key.j < slot_limit(Plan::Free, key.kind) => Ok(as_spend(free)),
        (Some(paid), _) => Err(OrchError::BonoNotReady { usable_at: paid.usable_at }),
        (None, None) => Err(OrchError::Internal),
        (None, Some(_)) => Err(OrchError::NoFreeSlot),
    }
}

/// Alias-shaped local part (`….` plus 12 letters or digits): the server would resolve it as an alias.
pub(crate) fn alias_form(name: &str) -> bool {
    name.rsplit_once('.').is_some_and(|(_, s)| s.len() == 12 && s.bytes().all(|b| b.is_ascii_alphanumeric()))
}

/// What MailSync needs for one of our addresses: only the seed (mail works without Midnight).
pub fn sync_target(keys: &KeyManager, address: &Address) -> Result<SyncTarget> {
    let j = u8::try_from(address.j).map_err(|_| OrchError::Internal)?;
    let keys = keys.address_keys(address.n, to_protocol_kind(address.kind), j);
    Ok(SyncTarget { addr_key: address.addr_key, address: address.display.to_ascii_lowercase(), keys })
}

fn suffix(alias_text: &str) -> &str {
    alias_text.rsplit('.').next().unwrap_or(alias_text)
}

/// Maximum loop turns for one slot in one call; then `StillPending` (picked up by `resume`).
const MAX_STEPS: u32 = 32;
// A slot can use up its proof cap in a single call (one turn per proof), so `MAX_STEPS` must not cut in before it.
const _: () = assert!(MAX_STEPS > super::MAX_PROOFS);

impl<C: Chain, I: Issuer, R: Relayer> Orchestrator<C, I, R> {
    /// Is the name valid and free in the contract state?
    /// One of our own addresses counts too: right after it lands the indexer (which follows finalized blocks) may not
    /// show it yet.
    pub async fn check_name(&self, name: &str) -> Result<NameCheck> {
        let (normalized, addr_key) = self.normalize(name).await?;
        let view = self.chain_view().await?;
        let wanted = normalized.clone();
        let ours = self.db(move |s| s.list_addresses()).await?.iter().any(|a| a.name.as_deref() == Some(&wanted));
        Ok(NameCheck { available: !view.has_addr_key(&addr_key) && !ours, normalized })
    }

    /// Normalised name and its `addrKey` (`NAME_REJECTED` → `NameRejected`).
    pub(crate) async fn normalize(&self, name: &str) -> Result<(String, String)> {
        let ops = vec![HashOp::NormalizeName { name: name.into() }, HashOp::AddrKey { name: name.into() }];
        let mut results = self.hash_all(ops).await?.into_iter();
        let (Some(normalized), Some(addr_key)) = (results.next(), results.next()) else {
            return Err(OrchError::Internal);
        };
        if alias_form(&normalized) {
            return Err(OrchError::NameRejected { reason: NameProblem::AliasForm });
        }
        Ok((normalized, addr_key))
    }

    /// Mailbox with a chosen name in one transaction (`registerMailbox`). The name is checked again right before
    /// proving. A half-done mailbox with that name is resumed. Syncs again on its own first
    /// (`sync_for_user_address_op`).
    pub async fn create_mailbox(&self, name: &str) -> Result<AddressView> {
        let check = self.check_name(name).await?;
        if !check.available {
            return Err(OrchError::NameTaken);
        }
        let _guard = self.address_lock().await;
        self.sync_for_user_address_op().await?;
        let key = self.mailbox_slot(check.normalized).await?;
        self.run_slot(key).await
    }

    /// Random alias in one step. A half-done alias is resumed. Syncs again on its own first
    /// (`sync_for_user_address_op`).
    pub async fn create_alias(&self) -> Result<AddressView> {
        let _guard = self.address_lock().await;
        self.sync_for_user_address_op().await?;
        let pending = self.db(|s| s.slots_by_status(SlotStatus::Reserving)).await?;
        let key = match pending.into_iter().find(|s| s.key.kind == SlotKind::Alias) {
            Some(slot) => slot.key,
            None => self.start_slot(SlotKind::Alias, None).await?,
        };
        self.run_slot(key).await
    }

    /// A half-done mailbox with that name is resumed (never two registrations of the same name); one with another
    /// name and no attempts is released.
    async fn mailbox_slot(&self, name: String) -> Result<SlotKey> {
        for slot in self.db(|s| s.slots_by_status(SlotStatus::Reserving)).await? {
            if slot.key.kind != SlotKind::Mailbox {
                continue;
            }
            if slot.pending_name.as_deref() == Some(name.as_str()) {
                return Ok(slot.key);
            }
            self.release_untouched(slot.key).await;
        }
        self.start_slot(SlotKind::Mailbox, Some(name)).await
    }

    /// `drive` and, if it fails without spending anything (still `reserving` with no attempts), release the slot.
    async fn run_slot(&self, key: SlotKey) -> Result<AddressView> {
        let result = self.drive(key).await;
        if result.is_err() {
            self.release_untouched(key).await;
        }
        result.map(|a| AddressView::from(&a))
    }

    pub(crate) async fn release_untouched(&self, key: SlotKey) {
        let _ = self.db(move |s| s.release_slot(key)).await;
    }

    /// Drives the slot to `used` (or an error), whatever state it was left in. Meanwhile it is marked as running and,
    /// if it ends with an error that does not clear by itself, as stopped (`pending_slots`).
    pub(crate) async fn drive(&self, key: SlotKey) -> Result<Address> {
        let _driving = Driving::mark(&self.driving, self.d.events.as_ref(), key);
        let result = self.drive_steps(key).await;
        let mut list = self.stuck.lock().unwrap_or_else(|e| e.into_inner());
        list.retain(|(k, _)| *k != key);
        if let Err(error) = result.as_ref()
            && !error.may_clear_by_itself()
        {
            list.push((key, *error));
        }
        drop(list);
        result
    }

    async fn drive_steps(&self, key: SlotKey) -> Result<Address> {
        for _ in 0..MAX_STEPS {
            let slot = self.slot(key).await?;
            let done = match (slot.status, key.kind) {
                (SlotStatus::Used, _) => return self.used_address(&slot).await,
                (SlotStatus::Burned, _) => return Err(OrchError::SlotBurned),
                (_, SlotKind::Mailbox) => self.register_mailbox(&slot).await?,
                (_, SlotKind::Alias) => self.spend_alias(&slot).await?,
            };
            if let Some(address) = done {
                return Ok(address);
            }
        }
        Err(OrchError::StillPending)
    }

    /// A mailbox without a readable name: the user types it, and it is checked against the chain (`addrKey`) before it
    /// is accepted.
    pub async fn provide_name(&self, slot: SlotId, name: &str) -> Result<AddressView> {
        let _guard = self.address_lock().await;
        self.sync_for_user_address_op().await?;
        let key = SlotKey::from(slot);
        let slot = self.slot(key).await?;
        let (normalized, addr_key) = self.normalize(name).await?;
        let address = match (key.kind, slot.status, slot.pending_name.as_deref()) {
            (SlotKind::Mailbox, SlotStatus::Used, _) => self.name_used(&slot, &normalized, &addr_key).await,
            (_, SlotStatus::Burned, _) => Err(OrchError::SlotBurned),
            (SlotKind::Mailbox, _, Some(known)) if known == normalized => self.drive(key).await,
            (SlotKind::Mailbox, _, _) => Err(OrchError::WrongName),
            (SlotKind::Alias, _, _) => Err(OrchError::Internal),
        };
        address.map(|a| AddressView::from(&a))
    }

    /// Mailbox already registered: the name must yield its `addrKey`; if it already had a name, only that one is valid.
    async fn name_used(&self, slot: &Slot, normalized: &str, addr_key: &str) -> Result<Address> {
        let mine = slot.addr_key.ok_or(OrchError::Internal)?;
        if hex::encode(mine) != addr_key {
            return Err(OrchError::WrongName);
        }
        let stored = self.db(move |s| s.get_address(&mine)).await?.ok_or(OrchError::Internal)?;
        if stored.name.is_none() {
            let (name, display) = (normalized.to_owned(), format!("{normalized}@{}", self.d.config.mail_domain));
            self.db(move |s| s.set_address_name(&mine, &name, &display)).await?;
        }
        self.used_address(slot).await
    }

    pub(crate) fn address_keys(&self, key: SlotKey) -> Result<AddressKeys> {
        let j = u8::try_from(key.j).map_err(|_| OrchError::Internal)?;
        Ok(self.d.keys.address_keys(key.n, to_protocol_kind(key.kind), j))
    }

    pub(crate) async fn slot(&self, key: SlotKey) -> Result<Slot> {
        self.db(move |s| s.get_slot(key)).await?.ok_or(OrchError::Internal)
    }

    /// The address of a `used` slot; a mailbox without a name asks for it.
    async fn used_address(&self, slot: &Slot) -> Result<Address> {
        let addr_key = slot.addr_key.ok_or(OrchError::Internal)?;
        let address = self.db(move |s| s.get_address(&addr_key)).await?.ok_or(OrchError::Internal)?;
        if address.kind == SlotKind::Mailbox && address.name.is_none() {
            return Err(OrchError::NeedsName);
        }
        Ok(address)
    }

    /// Picks a free slot of a usable bono and records it as `reserving` (with the name, for a mailbox).
    async fn start_slot(&self, kind: SlotKind, name: Option<String>) -> Result<SlotKey> {
        let key = self.pick_slot(kind).await?;
        let slot_nul = bytes32(&self.slot_nul(key).await?)?;
        let slot = Slot {
            key,
            slot_nul,
            status: SlotStatus::Reserving,
            addr_key: None,
            pending_name: name,
            attempts: 0,
            updated_at: self.now(),
        };
        self.db(move |s| s.insert_slot(&slot)).await?;
        Ok(key)
    }

    /// The first free slot of the kind in a bono usable now and with the required later insertions. If none:
    /// `BonoNotReady` with the earliest known time (or `null` if insertions are missing), or `NoFreeSlot`.
    async fn pick_slot(&self, kind: SlotKind) -> Result<SlotKey> {
        let bonos = self.db(|s| s.list_bonos()).await?;
        let now = self.now();
        let mut candidates = Vec::new();
        for (spend, leaf) in spends(&bonos) {
            let n = spend.n;
            let slots = self.db(move |s| s.list_slots(n)).await?;
            let used: Vec<u32> = slots.iter().filter(|s| s.key.kind == kind).map(|s| s.key.j).collect();
            if let Some(j) = (0..slot_limit(spend.plan, kind)).find(|j| !used.contains(j)) {
                candidates.push((leaf.usable_at.unwrap_or(now).max(now), SlotKey { n, kind, j }, leaf.clone()));
            }
        }
        candidates.sort_by_key(|(ready, key, _)| (*ready, key.n));
        let earliest = candidates.iter().map(|(ready, _, _)| *ready).find(|ready| *ready > now);
        if candidates.is_empty() {
            return Err(OrchError::NoFreeSlot);
        }
        for (ready, key, leaf) in candidates {
            if ready <= now && self.later_issuances_ok(&leaf).await? {
                return Ok(key);
            }
        }
        Err(OrchError::BonoNotReady { usable_at: earliest })
    }

    /// Do not spend a bono until the tree has N insertions after its leaf (so the spend is not linked to the purchase).
    async fn later_issuances_ok(&self, leaf: &BonoLeaf) -> Result<bool> {
        let wanted = self.d.config.pacing.later_issuances;
        if wanted == 0 {
            return Ok(true);
        }
        let hash = self.leaf_of(&hex::encode(leaf.id), leaf.plan).await?;
        let (count, positions) = self.find_leaves(&[hash]).await?;
        Ok(positions[0].is_some_and(|position| count.saturating_sub(position + 1) >= wanted))
    }

    pub(crate) fn slot_nul_op(&self, key: SlotKey) -> Result<HashOp> {
        let j = u8::try_from(key.j).map_err(|_| OrchError::Internal)?;
        Ok(HashOp::SlotNul { s: self.bono_secret(key.n), kind: to_protocol_kind(key.kind), j, generation: 0 })
    }

    pub(crate) async fn slot_nul(&self, key: SlotKey) -> Result<String> {
        self.hash(self.slot_nul_op(key)?).await
    }

    async fn witnesses(&self, key: SlotKey) -> Result<SlotWitnesses> {
        let bonos = self.db(|s| s.list_bonos()).await?;
        let spend = spend_now(&bonos, key, self.now())?;
        Ok(SlotWitnesses {
            s: self.bono_secret(key.n),
            k: spend.k,
            plan: to_protocol_plan(spend.plan),
            valid_until: super::bonos::NO_EXPIRY,
            j: u8::try_from(key.j).map_err(|_| OrchError::Internal)?,
        })
    }

    /// The slot's proof cap (checked after looking at the chain): when exhausted the slot stays paused.
    fn check_cap(&self, slot: &Slot) -> Result<()> {
        if slot.attempts >= self.d.config.retry.max_proofs {
            Err(OrchError::AttemptsExhausted)
        } else {
            Ok(())
        }
    }

    // --- Mailbox ---------------------------------------------------------------------------------------------

    /// `registerMailbox`: `Some(address)` if it landed; `None` if another turn is needed. The name is checked against
    /// the state read just before proving. If it already belongs to someone else (seen in the state, or the contract
    /// rejects it locally), nothing of this slot was spent and no proof of it can land, so the slot is freed
    /// ([`Self::name_taken`]). If another registration takes the name between the proof and its block, the node
    /// rejects the whole transaction (no fee, slot not spent) and the next turn sees the name taken.
    async fn register_mailbox(&self, slot: &Slot) -> Result<Option<Address>> {
        let name = slot.pending_name.clone().ok_or(OrchError::NeedsName)?;
        let addr_key = self.hash(HashOp::AddrKey { name: name.clone() }).await?;
        if slot.attempts > 0 {
            self.catch_up_unless_refused(slot.key).await?;
        }
        let facts = self.facts(slot, Some(&addr_key)).await?;
        if self.settled(slot, &facts).await? {
            return Ok(None);
        }
        // A spent nullifier with no address of ours contradicts the contract: never free such a slot.
        if facts.spent {
            return Err(OrchError::StaleState);
        }
        if facts.name_taken {
            return self.name_taken(slot).await;
        }
        self.check_cap(slot)?;
        let keys = self.address_keys(slot.key)?;
        let args = RegisterMailboxArgs {
            name: name.clone(),
            enc_pk: hex::encode(keys.enc_public),
            auth_pk: hex::encode(keys.auth_public),
            name_cipher: self.sealed_name(&slot.slot_nul, &name)?,
        };
        let call = ProveCall::RegisterMailbox { args, witnesses: self.witnesses(slot.key).await? };
        match self.prove_and_relay(&call, slot.key).await? {
            Relayed::Included => self.finish(slot, bytes32(&addr_key)?, Some(name)).await.map(Some),
            Relayed::Retry => Ok(None),
            Relayed::Rejected(CallProblem::SlotAlreadyUsed) => {
                self.settle_used(slot, Some(&addr_key)).await.map(|()| None)
            }
            Relayed::Rejected(CallProblem::AddressTaken) => self.name_taken(slot).await,
            Relayed::Rejected(reason) => Err(OrchError::CallRejected { reason }),
        }
    }

    /// The name belongs to another address: frees the slot (even with attempts: none of its proofs can land, they
    /// would all fail as taken) so it can register another name, and reports `NameTaken`.
    async fn name_taken<T>(&self, slot: &Slot) -> Result<T> {
        let key = slot.key;
        self.db(move |s| s.free_name_taken_slot(key)).await?;
        self.stuck.lock().unwrap_or_else(|e| e.into_inner()).retain(|(k, _)| *k != key);
        Err(OrchError::NameTaken)
    }

    /// `nameCipher` of the name, round-trip checked before sending.
    fn sealed_name(&self, slot_nul: &[u8; 32], name: &str) -> Result<String> {
        let key = self.d.keys.names_key();
        let sealed = seal_name(&key, slot_nul, name).map_err(|_| OrchError::Internal)?;
        match open_name(&key, slot_nul, &sealed) {
            Ok(back) if back == name => Ok(hex::encode(sealed)),
            _ => Err(OrchError::Internal),
        }
    }

    /// Closes the slot with its address (atomic in the store).
    async fn finish(&self, slot: &Slot, addr_key: [u8; 32], name: Option<String>) -> Result<Address> {
        let display = match &name {
            Some(name) => format!("{name}@{}", self.d.config.mail_domain),
            None => self.alias_display(&hex::encode(addr_key)).await?,
        };
        let address = Address {
            addr_key,
            kind: slot.key.kind,
            n: slot.key.n,
            j: slot.key.j,
            display,
            name,
            created_at: self.now(),
        };
        let (key, now, stored) = (slot.key, self.now(), address.clone());
        self.db(move |s| s.complete_slot(key, &stored, None, now)).await?;
        self.emit(super::Progress::AddressReady);
        Ok(address)
    }

    pub(crate) async fn alias_display(&self, addr_key: &str) -> Result<String> {
        let text = self.alias_texts(vec![addr_key.to_owned()]).await?.pop().ok_or(OrchError::Internal)?;
        Ok(format!("{text}@{}", self.d.config.mail_domain))
    }

    /// Text of each alias (`words.suffix`), with the in-memory cache (it never changes for an `addrKey`).
    pub(crate) async fn alias_texts(&self, keys: Vec<String>) -> Result<Vec<String>> {
        let missing: Vec<String> = {
            let cache = self.alias_texts.lock().map_err(|_| OrchError::Internal)?;
            keys.iter().filter(|k| !cache.contains_key(*k)).cloned().collect()
        };
        let ops = missing.iter().map(|k| HashOp::AliasAddress { addr_key: k.clone() }).collect();
        let texts = self.hash_all(ops).await?;
        let mut cache = self.alias_texts.lock().map_err(|_| OrchError::Internal)?;
        cache.extend(missing.into_iter().zip(texts));
        keys.iter().map(|k| cache.get(k).cloned().ok_or(OrchError::Internal)).collect()
    }

    // --- Alias ---------------------------------------------------------------------------------------------

    async fn spend_alias(&self, slot: &Slot) -> Result<Option<Address>> {
        if slot.attempts > 0 {
            self.catch_up_unless_refused(slot.key).await?;
        }
        let facts = self.facts(slot, None).await?;
        if self.settled(slot, &facts).await? {
            return Ok(None);
        }
        if facts.spent {
            return Err(OrchError::StaleState);
        }
        self.check_cap(slot)?;
        let keys = self.address_keys(slot.key)?;
        let (enc_pk, auth_pk) = (hex::encode(keys.enc_public), hex::encode(keys.auth_public));
        let op = HashOp::AliasAddrKey {
            enc_pk: enc_pk.clone(),
            auth_pk: auth_pk.clone(),
            slot_nul: hex::encode(slot.slot_nul),
        };
        let addr_key = self.hash(op).await?;
        self.check_suffix_free(&addr_key).await?;
        let witnesses = self.witnesses(slot.key).await?;
        let call = ProveCall::CreateAlias { args: CreateAliasArgs { enc_pk, auth_pk }, witnesses };
        match self.prove_and_relay(&call, slot.key).await? {
            Relayed::Included => self.finish(slot, bytes32(&addr_key)?, None).await.map(Some),
            Relayed::Retry => Ok(None),
            Relayed::Rejected(CallProblem::SlotAlreadyUsed) => self.settle_used(slot, None).await.map(|()| None),
            Relayed::Rejected(reason) => Err(OrchError::CallRejected { reason }),
        }
    }

    /// An alias suffix belongs to whoever registers it first; check it is free before spending the slot.
    async fn check_suffix_free(&self, addr_key: &str) -> Result<()> {
        let view = self.chain_view().await?;
        let others: Vec<String> = view
            .addresses
            .iter()
            .filter(|a| a.kind == crate::protocol::AddressKind::Alias && a.addr_key != addr_key)
            .map(|a| a.addr_key.clone())
            .collect();
        let mut texts = self.alias_texts(others).await?;
        let mine = self.alias_texts(vec![addr_key.to_owned()]).await?.pop().ok_or(OrchError::Internal)?;
        texts.retain(|t| suffix(t) == suffix(&mine));
        if texts.is_empty() { Ok(()) } else { Err(OrchError::AliasSuffixTaken) }
    }
}
