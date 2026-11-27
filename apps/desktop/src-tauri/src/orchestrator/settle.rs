//! What the chain says about a slot, and how it is applied to the store. The chain wins, but only for what it can
//! actually prove: an address with our keys (→ `used`). A spent nullifier with nothing attached, or a rejection the
//! view does not explain, means an indexer contradicting the contract: `StaleState`, nothing burned. Outside `recover`
//! (which sees the whole state and burns spent nullifiers with nothing attached), a slot is only burned when the
//! chain confirms the address on our nullifier has foreign keys.

use super::ports::{Chain, Issuer, Relayer};
use super::{OrchError, Orchestrator, Result, bytes32, to_protocol_kind};
use crate::crypto::{NAME_CIPHER_LENGTH, open_name};
use crate::protocol::{AddressEntry, HashOp};
use crate::store::{Address, Slot, SlotKey, SlotKind, SlotPatch, SlotStatus};

/// Chain facts about a slot, from a single state read.
#[derive(Debug, Default)]
pub(crate) struct Facts {
    /// Block time of the state read (Unix ms).
    pub block_timestamp: u64,
    /// The address registered with the slot's nullifier.
    pub address: Option<AddressEntry>,
    /// The mailbox name already belongs to another address.
    pub name_taken: bool,
    /// The nullifier is spent.
    pub spent: bool,
}

impl<C: Chain, I: Issuer, R: Relayer> Orchestrator<C, I, R> {
    /// Reads the state and gathers the slot's facts (`name_key`: `addrKey` of the mailbox name, if any).
    pub(crate) async fn facts(&self, slot: &Slot, name_key: Option<&str>) -> Result<Facts> {
        let view = self.chain_view().await?;
        let nul = hex::encode(slot.slot_nul);
        let address = view.address_by_nul(&nul).cloned();
        let name_taken = address.is_none() && name_key.is_some_and(|k| view.has_addr_key(k));
        Ok(Facts {
            block_timestamp: view.block_timestamp,
            spent: view.nullifiers.contains(&nul),
            address,
            name_taken,
        })
    }

    /// If the chain already has the result of an earlier proof, applies it to the store (`true`).
    pub(crate) async fn settled(&self, slot: &Slot, facts: &Facts) -> Result<bool> {
        let Some(entry) = &facts.address else { return Ok(false) };
        self.adopt(slot, entry).await.map(|()| true)
    }

    /// After `slot-already-used`: the chain must explain it; otherwise `StaleState`.
    pub(crate) async fn settle_used(&self, slot: &Slot, name_key: Option<&str>) -> Result<()> {
        let facts = self.facts(slot, name_key).await?;
        if self.settled(slot, &facts).await? { Ok(()) } else { Err(OrchError::StaleState) }
    }

    pub(crate) async fn reconcile(&self, key: SlotKey, to: SlotStatus, patch: SlotPatch) -> Result<()> {
        let now = self.now();
        self.db(move |s| s.reconcile_slot(key, to, &patch, now)).await
    }

    /// Records the on-chain address as ours (if its keys are the slot's); otherwise someone spent the nullifier with
    /// our `s` and the slot is burned.
    pub(crate) async fn adopt(&self, slot: &Slot, entry: &AddressEntry) -> Result<()> {
        match self.address_from_entry(slot.key, entry, slot.pending_name.clone()).await? {
            Some(address) => {
                let (slot, now) = (slot.clone(), self.now());
                self.db(move |s| s.reconcile_address(&slot, &address, now)).await
            }
            None => self.reconcile(slot.key, SlotStatus::Burned, SlotPatch::default()).await,
        }
    }

    /// Our address from an on-chain record, or `None` if it is not ours: keys differ from the slot's or, for an alias,
    /// `addrKey` does not derive from them. A mailbox name: the known one if it matches `addrKey`; otherwise the one in
    /// `nameCipher`, checked the same way; with neither, empty `display` and null `name` (the app will ask).
    pub(crate) async fn address_from_entry(
        &self,
        key: SlotKey,
        entry: &AddressEntry,
        known: Option<String>,
    ) -> Result<Option<Address>> {
        if !self.keys_match(key, entry).await? {
            return Ok(None);
        }
        let (display, name) = match key.kind {
            SlotKind::Alias => (self.alias_display(&entry.addr_key).await?, None),
            SlotKind::Mailbox => {
                let name = match self.name_if_matches(known, &entry.addr_key).await? {
                    Some(name) => Some(name),
                    None => self.name_from_cipher(entry).await?,
                };
                (name.as_ref().map_or(String::new(), |n| format!("{n}@{}", self.d.config.mail_domain)), name)
            }
        };
        let addr_key = bytes32(&entry.addr_key)?;
        Ok(Some(Address { addr_key, kind: key.kind, n: key.n, j: key.j, display, name, created_at: self.now() }))
    }

    async fn keys_match(&self, key: SlotKey, entry: &AddressEntry) -> Result<bool> {
        let keys = self.address_keys(key)?;
        let (enc_pk, auth_pk) = (hex::encode(keys.enc_public), hex::encode(keys.auth_public));
        if entry.enc_pk != enc_pk || entry.auth_pk != auth_pk || entry.kind != to_protocol_kind(key.kind) {
            return Ok(false);
        }
        if key.kind == SlotKind::Mailbox {
            return Ok(true);
        }
        let op = HashOp::AliasAddrKey { enc_pk, auth_pk, slot_nul: entry.slot_nul.clone() };
        Ok(self.hash(op).await? == entry.addr_key)
    }

    /// The name, if `addrKey(name)` matches the record (a name the sidecar rejects does not match).
    async fn name_if_matches(&self, name: Option<String>, addr_key: &str) -> Result<Option<String>> {
        let Some(name) = name else { return Ok(None) };
        match self.hash(HashOp::AddrKey { name: name.clone() }).await {
            Ok(key) => Ok((key == addr_key).then_some(name)),
            Err(OrchError::NameRejected { .. }) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Opens `nameCipher` (tolerating failure) and requires `addrKey(name) == addrKey` of the record.
    async fn name_from_cipher(&self, entry: &AddressEntry) -> Result<Option<String>> {
        let (mut sealed, mut nul) = ([0u8; NAME_CIPHER_LENGTH], [0u8; 32]);
        let decoded =
            hex::decode_to_slice(&entry.name_cipher, &mut sealed).and(hex::decode_to_slice(&entry.slot_nul, &mut nul));
        let opened = decoded.ok().and_then(|()| open_name(&self.d.keys.names_key(), &nul, &sealed).ok());
        self.name_if_matches(opened, &entry.addr_key).await
    }
}
