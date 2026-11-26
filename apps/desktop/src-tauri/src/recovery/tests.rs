//! Restore against the fake sidecar: one profile creates things through the orchestrator and another, clean profile
//! with the same seed restores them from the chain.

use super::*;
use crate::orchestrator::fakes::*;
use crate::orchestrator::ports::BonoPeriod;
use crate::protocol::{AddressEntry, AddressKind, PendingNameEntry};
use crate::store::Address;

fn set(world: &Shared, f: impl FnOnce(&mut World)) {
    f(&mut world.lock().unwrap());
}

fn summary(addresses: Vec<Address>) -> Vec<(String, Option<String>, SlotKind, u32, u32)> {
    let mut out: Vec<_> = addresses.into_iter().map(|a| (a.display, a.name, a.kind, a.n, a.j)).collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Puts an unrevealed reservation of `name` on chain in slot (0, mailbox, j), with our commitment.
async fn unrevealed(h: &Harness, j: u32, name: &str) -> SlotKey {
    let key = SlotKey { n: 0, kind: SlotKind::Mailbox, j };
    let orch = &h.orch;
    let nul = orch.slot_nul(key).await.unwrap();
    let keys = orch.address_keys(key).unwrap();
    let salt = crate::protocol::SecretHex::from_bytes(&orch.d.keys.mailbox_salt(0, j as u8));
    let addr_key = orch.hash(HashOp::AddrKey { name: name.into() }).await.unwrap();
    let commit = orch
        .hash(HashOp::Commit {
            addr_key,
            enc_pk: hex::encode(keys.enc_public),
            auth_pk: hex::encode(keys.auth_public),
            salt,
            slot_nul: nul.clone(),
        })
        .await
        .unwrap();
    set(&h.world, |w| {
        w.nullifiers.insert(nul.clone());
        w.pending.push(PendingNameEntry { slot_nul: nul, reserved_round: w.round.to_string(), commit });
    });
    key
}

async fn nul_of(h: &Harness, kind: SlotKind, j: u32) -> String {
    h.orch.slot_nul(SlotKey { n: 0, kind, j }).await.unwrap()
}

#[tokio::test]
async fn a_clean_profile_restores_what_the_orchestrator_created() {
    let a = harness().await;
    set(&a.world, |w| w.auto_round = true);
    a.orch.request_free_plan().await.unwrap();
    a.orch.pay_fiat(BonoPeriod::Monthly).await.unwrap();
    a.orch.create_mailbox("Juan").await.unwrap();
    a.orch.create_alias().await.unwrap();
    a.orch.create_alias().await.unwrap();
    let pending = unrevealed(&a, 1, "pepe").await;
    // A burned slot (nullifier with nothing attached) and an address in our slot with foreign keys.
    let burned = nul_of(&a, SlotKind::Alias, 2).await;
    let foreign = nul_of(&a, SlotKind::Alias, 3).await;
    set(&a.world, |w| {
        w.nullifiers.insert(burned);
        w.nullifiers.insert(foreign.clone());
        w.addresses.push(AddressEntry {
            addr_key: "44".repeat(32),
            enc_pk: "55".repeat(32),
            auth_pk: "66".repeat(32),
            kind: AddressKind::Alias,
            name_cipher: "00".repeat(104),
            slot_nul: foreign,
        });
    });

    let b = harness_on(a.world.clone(), config()).await;
    let report = b.orch.recover().await.unwrap();
    assert_eq!(
        report,
        RecoveryReport { bonos: 1, addresses: 3, burned: 2, conflicts: 0, needs_name: vec![pending.into()] }
    );
    assert_eq!(summary(b.store.list_addresses().unwrap()), summary(a.store.list_addresses().unwrap()));
    let bono = b.store.get_bono(0, 1).unwrap().unwrap();
    assert_eq!((bono.plan, bono.status), (Plan::Paid, BonoStatus::Included));
    assert_eq!(b.store.get_chain_cursor().unwrap().min_leaf_count, 2);
    let stored = b.store.get_slot(pending).unwrap().unwrap();
    assert_eq!((stored.status, stored.pending_name.as_deref()), (SlotStatus::Reserved, None));

    // Restoring again is harmless.
    assert_eq!(
        b.orch.recover().await.unwrap(),
        RecoveryReport { bonos: 1, addresses: 3, burned: 0, conflicts: 0, needs_name: vec![pending.into()] }
    );

    // The app asks for the name; one that does not match the commitment spends nothing.
    assert_eq!(b.orch.provide_name(pending.into(), "otro").await, Err(OrchError::WrongName));
    assert_eq!(b.orch.resume().await.unwrap().needs_name, vec![SlotId::from(pending)]);
    let mailbox = b.orch.provide_name(pending.into(), "Pepe").await.unwrap();
    assert_eq!(mailbox.display, "pepe@nightmail.local");
    // Another alias on the paid plan continues at the first free slot.
    let next = b.orch.create_alias().await.unwrap();
    assert_eq!(next.slot.j, 4);
}

#[tokio::test]
async fn bonos_are_found_until_a_gap_of_three() {
    let h = harness().await;
    for n in [0u32, 2, 6] {
        let id = id_k(h.orch.bono_secret(n).expose(), 0);
        set(&h.world, |w| w.issue(&id, crate::protocol::Plan::Free));
    }
    let report = h.orch.recover().await.unwrap();
    assert_eq!(report.bonos, 2, "n = 6 remains after 3 bonos in a row without a leaf");
    let found: Vec<u32> = h.store.list_bonos().unwrap().iter().map(|b| b.n).collect();
    assert_eq!(found, [0, 2]);
}

#[tokio::test]
async fn nothing_on_chain_restores_nothing() {
    let h = harness().await;
    assert_eq!(h.orch.recover().await.unwrap(), RecoveryReport::default());
    assert!(h.store.list_bonos().unwrap().is_empty());
}

#[tokio::test]
async fn an_unreadable_name_cipher_keeps_the_address_without_a_name() {
    let a = harness().await;
    set(&a.world, |w| w.auto_round = true);
    a.orch.request_free_plan().await.unwrap();
    a.orch.create_mailbox("ana").await.unwrap();
    set(&a.world, |w| w.addresses[0].name_cipher = "ab".repeat(104));
    let b = harness_on(a.world.clone(), config()).await;
    assert_eq!(b.orch.recover().await.unwrap().addresses, 1);
    let restored = &b.store.list_addresses().unwrap()[0];
    assert_eq!((restored.display.as_str(), restored.name.as_deref()), ("", None));
    assert_eq!(restored.addr_key, a.store.list_addresses().unwrap()[0].addr_key);
}

#[test]
fn slot_keys_follow_the_contract_quota() {
    assert_eq!(slot_keys(0, Plan::Free).len(), 3);
    assert_eq!(slot_keys(4, Plan::Paid).len(), 25);
    let found = Found { n: 1, k: 0, plan: Plan::Free, id: "5151".into(), position: 0 };
    assert!(!format!("{found:?}").contains("5151"));
}

#[tokio::test]
async fn a_restored_mailbox_whose_name_does_not_match_asks_for_it() {
    let a = harness().await;
    set(&a.world, |w| w.auto_round = true);
    a.orch.request_free_plan().await.unwrap();
    let ana = a.orch.create_mailbox("ana").await.unwrap();
    // `nameCipher` of a different name (correctly encrypted with our key): does not match `addrKey`.
    let nul = nul_of(&a, SlotKind::Mailbox, 0).await;
    let other = crate::crypto::seal_name(&a.orch.d.keys.names_key(), &bytes32(&nul).unwrap(), "otro").unwrap();
    set(&a.world, |w| w.addresses[0].name_cipher = hex::encode(other));
    let b = harness_on(a.world.clone(), config()).await;
    let report = b.orch.recover().await.unwrap();
    let k = SlotKey { n: 0, kind: SlotKind::Mailbox, j: 0 };
    assert_eq!((report.addresses, report.needs_name.clone()), (1, vec![SlotId::from(k)]));
    assert_eq!(b.orch.resume().await.unwrap().needs_name, vec![SlotId::from(k)]);
    assert_eq!(b.orch.provide_name(k.into(), "otro").await, Err(OrchError::WrongName));
    let named = b.orch.provide_name(k.into(), "Ana").await.unwrap();
    assert_eq!((named.display, named.addr_key), (ana.display, ana.addr_key));
}

#[tokio::test]
async fn an_abandoned_mailbox_is_neither_counted_nor_asked_for_its_name() {
    let a = harness().await;
    set(&a.world, |w| w.auto_round = true);
    a.orch.request_free_plan().await.unwrap();
    a.orch.create_mailbox("ana").await.unwrap();
    set(&a.world, |w| w.addresses[0].name_cipher = "ab".repeat(104));
    let b = harness_on(a.world.clone(), config()).await;
    let k = SlotKey { n: 0, kind: SlotKind::Mailbox, j: 0 };
    let report = b.orch.recover().await.unwrap();
    assert_eq!((report.addresses, report.needs_name.clone()), (1, vec![SlotId::from(k)]));
    let addr_key = b.store.list_addresses().unwrap()[0].addr_key;
    assert!(b.store.abandon_address(&addr_key, 1).unwrap());
    // Restoring again on the same profile: still abandoned, neither counted nor asking for a name.
    let again = b.orch.recover().await.unwrap();
    assert_eq!((again.addresses, again.needs_name), (0, vec![]));
    assert!(b.store.list_addresses().unwrap().is_empty());
    assert_eq!(b.store.list_abandoned_addresses().unwrap().len(), 1);
    // Resuming (`unnamed_mailboxes`) does not ask for it either.
    assert!(b.orch.resume().await.unwrap().needs_name.is_empty());
}

#[tokio::test]
async fn a_paid_bono_bought_first_is_restored_with_k_0() {
    let a = harness().await;
    a.orch.pay_shielded(PRICE).await.unwrap();
    for _ in 0..3 {
        a.orch.create_alias().await.unwrap();
    }
    let b = harness_on(a.world.clone(), config()).await;
    let report = b.orch.recover().await.unwrap();
    assert_eq!((report.bonos, report.addresses), (1, 3));
    let bono = b.store.get_bono(0, 0).unwrap().unwrap();
    assert_eq!((bono.plan, bono.status), (Plan::Paid, BonoStatus::Included));
}

#[tokio::test]
async fn a_contradictory_local_slot_is_skipped_and_counted() {
    let a = harness().await;
    a.orch.request_free_plan().await.unwrap();
    a.orch.create_alias().await.unwrap();
    // Profile B already has that slot with another nullifier (another seed's database, or corrupt).
    let b = harness_on(a.world.clone(), config()).await;
    let k = SlotKey { n: 0, kind: SlotKind::Alias, j: 0 };
    let wrong = crate::store::Slot {
        key: k,
        slot_nul: [9; 32],
        status: SlotStatus::Burned,
        addr_key: None,
        round: None,
        pending_name: None,
        reserve_attempts: 0,
        reveal_attempts: 0,
        updated_at: 0,
    };
    b.store.insert_slot(&wrong).unwrap();
    let report = b.orch.recover().await.unwrap();
    assert_eq!((report.conflicts, report.addresses), (1, 0));
}

/// Sent messages live only on the device that sent them: a restore never brings them back, and restoring again on
/// the same profile leaves them as they were.
#[tokio::test]
async fn sent_messages_are_not_restored_and_survive_a_restore_on_the_same_profile() {
    use crate::store::{NewSentMessage, SentFilter, SentState};
    let a = harness().await;
    set(&a.world, |w| w.auto_round = true);
    a.orch.request_free_plan().await.unwrap();
    a.orch.create_mailbox("ana").await.unwrap();
    let ana = a.store.list_addresses().unwrap().remove(0);
    let sent = NewSentMessage {
        message_id: [1; 16],
        addr_key: ana.addr_key,
        from_addr: ana.display.clone(),
        to_addr: "pepe@nightmail.local".into(),
        subject: "hola".into(),
        body: zeroize::Zeroizing::new("cuerpo".into()),
        sent_at: 10,
    };
    let id = a.store.insert_sent(&sent).unwrap().id();
    a.store.set_sent_state(id, SentState::Sent).unwrap();

    let again = a.orch.recover().await.unwrap();
    assert_eq!(again.addresses, 1);
    let kept = a.store.get_sent(id).unwrap().unwrap();
    assert_eq!((kept.summary.state, kept.body.as_str()), (SentState::Sent, "cuerpo"));

    let b = harness_on(a.world.clone(), config()).await;
    assert_eq!(b.orch.recover().await.unwrap().addresses, 1);
    assert_eq!(b.store.list_addresses().unwrap()[0].addr_key, ana.addr_key);
    assert!(b.store.list_sent(&SentFilter::default()).unwrap().is_empty());
    assert_eq!(b.store.count_sent(None).unwrap(), 0);
}

#[tokio::test]
async fn recover_keeps_an_existing_usable_at() {
    let a = harness().await;
    let bono = a.orch.request_free_plan().await.unwrap();
    a.store.set_bono_usable_at(0, 0, bono.usable_at + 9999).unwrap();
    a.orch.recover().await.unwrap();
    assert_eq!(a.store.get_bono(0, 0).unwrap().unwrap().usable_at, Some(bono.usable_at + 9999));
}
