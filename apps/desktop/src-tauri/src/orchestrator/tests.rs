//! Orchestrator tests against the doubles in `fakes.rs`.

use super::fakes::*;
use super::ports::{IssuerError, RelayError, RelayOutcome, Submitted, TicketState};
use super::*;
use crate::protocol::{AddressEntry, AddressKind, CallProblem, FundsAsset, HashOp, NameProblem, codes};
use crate::rpc::RpcError;
use crate::store::{BonoStatus, Plan, Slot, SlotKey, SlotKind, SlotStatus};

fn set(h: &Harness, f: impl FnOnce(&mut World)) {
    f(&mut h.world.lock().unwrap());
}

async fn free_bono(h: &Harness) -> BonoInfo {
    h.orch.request_free_plan().await.unwrap()
}

fn key(kind: SlotKind, j: u32) -> SlotKey {
    SlotKey { n: 0, kind, j }
}

fn slot(h: &Harness, kind: SlotKind, j: u32) -> Option<Slot> {
    h.store.get_slot(key(kind, j)).unwrap()
}

fn status(h: &Harness, kind: SlotKind, j: u32) -> SlotStatus {
    slot(h, kind, j).unwrap().status
}

fn unavailable() -> RpcError {
    remote(codes::PROVER_UNAVAILABLE, serde_json::Value::Null)
}

fn foreign(addr_key: String, kind: AddressKind, slot_nul: String) -> AddressEntry {
    AddressEntry {
        addr_key,
        enc_pk: "11".repeat(32),
        auth_pk: "22".repeat(32),
        kind,
        name_cipher: "00".repeat(104),
        slot_nul,
    }
}

/// Records a `reserving` mailbox by hand (as if the app had closed before proving).
async fn reserving_mailbox(h: &Harness, name: &str) -> SlotKey {
    let k = key(SlotKind::Mailbox, 0);
    let nul = bytes32(&h.orch.slot_nul(k).await.unwrap()).unwrap();
    let row = Slot {
        key: k,
        slot_nul: nul,
        status: SlotStatus::Reserving,
        addr_key: None,
        pending_name: Some(name.into()),
        attempts: 0,
        updated_at: 0,
    };
    h.store.insert_slot(&row).unwrap();
    k
}

// --- Startup ----------------------------------------------------------------------------------------------

#[tokio::test]
async fn start_requires_protocol_1_5_wallet_methods_and_an_absolute_wallet_dir() {
    let dir = tempfile::TempDir::new().unwrap();
    let scope = crate::store::StoreScope::new("undeployed", CONTRACT).unwrap();
    let store = Arc::new(crate::store::LocalStore::open(&dir.path().join("db"), &[1; 32], &scope).unwrap());
    let deps = |w: &Shared, config: OrchestratorConfig| Deps {
        chain: FakeChain(w.clone()),
        issuer: FakeIssuer(w.clone()),
        relayer: FakeRelayer(w.clone()),
        env: Arc::new(FakeEnv::default()),
        store: store.clone(),
        keys: keys(),
        config,
        events: None,
    };
    let old = world();
    old.lock().unwrap().protocol = "1.4".into();
    assert_eq!(Orchestrator::start(deps(&old, config())).await.err(), Some(OrchError::SidecarTooOld));
    let missing = world();
    missing.lock().unwrap().methods.retain(|m| m != "wallet.close");
    assert_eq!(Orchestrator::start(deps(&missing, config())).await.err(), Some(OrchError::SidecarTooOld));
    let relative = OrchestratorConfig { wallet_state_dir: "wallet".into(), ..config() };
    assert_eq!(Orchestrator::start(deps(&world(), relative)).await.err(), Some(OrchError::BadConfig));
    assert!(Orchestrator::start(deps(&world(), config())).await.is_ok());
}

#[test]
fn orchestrator_futures_are_send() {
    fn assert_send<T: Send>(_: &T) {}
    let rt = tokio::runtime::Runtime::new().unwrap();
    let h = rt.block_on(harness());
    assert_send(&h.orch.create_alias());
    assert_send(&h.orch.create_mailbox("x"));
    assert_send(&h.orch.pay_shielded("1"));
    assert_send(&h.orch.resume());
    assert_send(&h.orch.recover());
    let id = key(SlotKind::Mailbox, 0).into();
    assert_send(&h.orch.provide_name(id, "x"));
    assert_send(&h.orch.check_name("x"));
    assert_send(&h.orch.request_free_plan());
    assert_send(&h.orch.pay_fiat());
    assert_send(&h.orch.faucet("t", "1"));
    assert_send(&h.orch.current_price());
    assert_send(&h.orch.wallet_snapshot());
    assert_send(&h.orch.retry_stale());
    assert_send(&h.orch.resume_paused_slot(id));
    assert_send(&h.orch.abandon_slot(id));
    assert_send(&h.orch.forget_pending_bono(0, 0));
    assert_send(&h.orch.shutdown());
    assert_send(&tracked(1, h.orch.create_alias()));
}

#[test]
fn one_pacing_for_every_network() {
    let p = Pacing::default();
    assert_eq!((p.usable_delay, p.later_issuances), ((Duration::ZERO, Duration::from_secs(5)), 0));
    assert_eq!((p.poll, p.max_polls), (Duration::from_secs(2), 150));
}

// --- Bonos ------------------------------------------------------------------------------------------------

#[tokio::test]
async fn free_plan_is_issued_included_and_raises_the_ratchet() {
    let mut h = harness().await;
    set(&h, |w| w.issue_delay = 2);
    let bono = free_bono(&h).await;
    assert_eq!((bono.n, bono.k, bono.plan, bono.position), (0, 0, crate::protocol::Plan::Free, 0));
    let stored = h.store.get_bono(0, 0).unwrap().unwrap();
    assert_eq!(
        (stored.status, stored.position, stored.usable_at),
        (BonoStatus::Included, Some(0), Some(bono.usable_at))
    );
    assert_eq!(h.store.get_chain_cursor().unwrap().min_leaf_count, 1);
    assert!(h.store.get_meta("receipt/0/0").unwrap().is_some(), "the receipt is stored locally");
    let progress = h.progress();
    assert!(progress.contains(&Progress::WaitingIssuer) && progress.contains(&Progress::BonoReady { n: 0 }));
    assert_eq!(h.orch.request_free_plan().await, Err(OrchError::AlreadyHasPlan), "one free plan per seed");
}

#[tokio::test]
async fn usable_at_uses_the_random_delay() {
    let h = harness().await;
    h.env.random.store(3000, std::sync::atomic::Ordering::SeqCst);
    let bono = free_bono(&h).await;
    assert_eq!(bono.usable_at, h.env.now() + 3, "3000 ms random wait (without sleeping)");
}

#[tokio::test]
async fn a_card_claim_from_before_night_plus_is_resumed() {
    let h = harness().await;
    // A leaf claimed by card when the payment still had a period (`fiat:annual`): paying by card resumes it.
    h.store.set_meta("method/0/0", b"fiat:annual").unwrap();
    // Claiming it again as `fiat` would be another method (`StillPending`): the old claim is reused instead.
    let paid = h.orch.pay_fiat().await.unwrap();
    assert_eq!((paid.n, paid.k, paid.plan), (0, 0, crate::protocol::Plan::Paid));
    assert_eq!(h.store.get_meta("method/0/0").unwrap().as_deref(), Some(&b""[..]), "released once included");
}

#[tokio::test]
async fn upgrading_reuses_n_with_the_next_k() {
    let h = harness().await;
    free_bono(&h).await;
    let paid = h.orch.pay_fiat().await.unwrap();
    assert_eq!((paid.n, paid.k, paid.plan), (0, 1, crate::protocol::Plan::Paid));
    let another = h.orch.pay_fiat().await.unwrap();
    assert_eq!((another.n, another.k), (1, 0));
}

#[tokio::test]
async fn receipts_must_be_signed_and_within_the_insertion_window() {
    let h = harness().await;
    set(&h, |w| w.forge_receipts = true);
    assert_eq!(h.orch.request_free_plan().await, Err(OrchError::BadReceipt));
    set(&h, |w| {
        w.forge_receipts = false;
        w.insert_by = START + 10_000;
    });
    assert_eq!(h.orch.request_free_plan().await, Err(OrchError::BadReceipt), "deadline too far away");
    set(&h, |w| w.insert_by = START - 1);
    assert_eq!(h.orch.request_free_plan().await, Err(OrchError::BadReceipt), "deadline passed");
    set(&h, |w| w.insert_by = START + 3000);
    assert!(h.orch.request_free_plan().await.is_ok());
}

#[tokio::test]
async fn issuer_errors_and_busy() {
    let h = harness().await;
    set(&h, |w| w.script_issue.push_back(Err(IssuerError::CaptchaFailed)));
    assert_eq!(h.orch.request_free_plan().await, Err(OrchError::CaptchaFailed));
    assert_eq!(h.store.list_bonos().unwrap().len(), 1);
    set(&h, |w| w.script_issue.push_back(Err(IssuerError::RateLimited { retry_after_s: 9 })));
    assert_eq!(h.orch.request_free_plan().await, Err(OrchError::RateLimited { retry_after_s: 9 }));
    set(&h, |w| {
        w.script_issue
            .extend([Err(IssuerError::Busy { retry_after_s: 5 }), Err(IssuerError::Busy { retry_after_s: 500 })])
    });
    assert!(h.orch.request_free_plan().await.is_ok(), "busy → wait and repeat the same id");
    assert_eq!(h.store.list_bonos().unwrap().len(), 1, "the same leaf requested");
    let slept = h.env.slept.lock().unwrap().clone();
    assert!(slept.contains(&Duration::from_secs(5)) && slept.contains(&Duration::from_secs(300)), "capped wait");
    set(&h, |w| w.script_issue.extend((0..6).map(|_| Err(IssuerError::Busy { retry_after_s: 1 }))));
    assert_eq!(h.orch.pay_fiat().await, Err(OrchError::ServiceUnavailable));
}

#[tokio::test]
async fn pending_issue_is_waited_failed_issue_reported_and_retries_poll_the_status() {
    let h = harness().await;
    set(&h, |w| {
        w.issue_delay = 1;
        w.script_issue_status.push_back(Err(IssuerError::Unavailable));
    });
    assert!(h.orch.request_free_plan().await.is_ok(), "a failed poll does not cut the wait short");
    set(&h, |w| w.issue_delay = 100);
    assert_eq!(h.orch.pay_fiat().await, Err(OrchError::StillPending));
    // With a saved receipt nothing is requested again: keep waiting for that request.
    let id = id_k(h.orch.bono_secret(0).expose(), 1);
    let mut issued = pending_reply(&id);
    issued.state = ports::IssueState::Issued;
    set(&h, |w| {
        w.issue(&id, crate::protocol::Plan::Paid);
        w.script_issue_status.push_back(Ok(issued));
    });
    let requests = h.calls("issuer.request");
    assert!(h.orch.pay_fiat().await.is_ok());
    assert_eq!(h.calls("issuer.request"), requests);
}

#[tokio::test]
async fn failed_issue_and_conflict() {
    let h = harness().await;
    set(&h, |w| w.issue_delay = 1);
    let mut failed = pending_reply(&id_k(h.orch.bono_secret(0).expose(), 0));
    failed.state = ports::IssueState::Failed;
    set(&h, |w| w.script_issue_status.push_back(Ok(failed)));
    assert_eq!(h.orch.request_free_plan().await, Err(OrchError::IssueFailed));
    set(&h, |w| w.script_issue.push_back(Err(IssuerError::IdConflict)));
    assert_eq!(
        h.orch.pay_fiat().await,
        Err(OrchError::StillPending),
        "409: the Issuer holds the leaf"
    );
}

/// An Issuer reply to script `status` with (the receipt is not checked in `status`).
fn pending_reply(id: &str) -> ports::IssueReply {
    ports::IssueReply {
        id: id.into(),
        plan: crate::protocol::Plan::Free,
        state: ports::IssueState::Pending,
        receipt: ports::Receipt {
            contract: CONTRACT.into(),
            period: "none".into(),
            insert_by: 0,
            signature: String::new(),
            public_key: String::new(),
        },
    }
}

#[tokio::test]
async fn shielded_payment_journals_and_closes_the_wallet() {
    let mut h = harness().await;
    set(&h, |w| {
        w.dust_coins = 0;
        w.state_discarded = true;
    });
    let bono = h.orch.pay_shielded(PRICE).await.unwrap();
    assert_eq!((bono.n, bono.k, bono.plan), (0, 0, crate::protocol::Plan::Paid));
    assert!(h.store.list_journal().unwrap().is_empty(), "journal closed with the leaf in the tree");
    assert_eq!((h.calls("wallet.registerDust"), h.calls("wallet.close")), (1, 1));
    assert!(h.progress().contains(&Progress::WalletStateDiscarded));
    assert!(!h.world.lock().unwrap().wallet_open, "closed after the purchase");
}

#[tokio::test]
async fn shielded_payment_errors() {
    let h = harness().await;
    assert_eq!(h.orch.pay_shielded("5").await, Err(OrchError::PriceChanged));
    let journal = h.store.list_journal().unwrap();
    assert_eq!(journal.len(), 1, "recorded before paying and still there");
    let purchase: wallet::Purchase = serde_json::from_slice(&journal[0].payload).unwrap();
    assert_eq!((purchase.network.as_str(), purchase.amount.as_str(), purchase.n), ("undeployed", "5", 0));
    assert_eq!(h.calls("wallet.close"), 1, "nothing in flight: it closes");
    set(&h, |w| w.script_buy.extend([RpcError::Timeout, RpcError::Timeout, RpcError::Timeout]));
    assert_eq!(h.orch.pay_shielded(PRICE).await, Err(OrchError::StillPending));
    assert_eq!(h.calls("wallet.buyBono"), 4, "same id retried with a cap");
    assert_eq!(h.calls("wallet.close"), 1, "a buyBono may still be in flight: it does not close");
    let no_funds = remote(codes::INSUFFICIENT_FUNDS, serde_json::json!({ "asset": "token" }));
    set(&h, |w| w.script_buy.push_back(no_funds));
    assert_eq!(h.orch.pay_shielded(PRICE).await, Err(OrchError::InsufficientFunds { asset: FundsAsset::Token }));
}

#[tokio::test]
async fn a_prepare_failure_writes_no_journal() {
    let h = harness().await;
    let in_use = remote(codes::WALLET_UNAVAILABLE, serde_json::json!({ "reason": "in-use" }));
    set(&h, |w| w.script_open.push_back(in_use));
    let error = OrchError::Wallet { reason: crate::protocol::WalletProblem::InUse };
    assert_eq!(h.orch.pay_shielded(PRICE).await, Err(error));
    assert!(h.store.list_journal().unwrap().is_empty());
}

#[tokio::test]
async fn shielded_payment_reopens_and_resyncs_the_wallet() {
    let h = harness().await;
    let not_open = remote(codes::WALLET_UNAVAILABLE, serde_json::json!({ "reason": "not-open" }));
    let not_synced = remote(codes::WALLET_UNAVAILABLE, serde_json::json!({ "reason": "not-synced" }));
    set(&h, |w| w.script_buy.extend([not_open, not_synced]));
    set(&h, |w| {
        w.script_open.push_back(remote(codes::WALLET_UNAVAILABLE, serde_json::json!({ "reason": "already-open" })))
    });
    assert!(h.orch.pay_shielded(PRICE).await.is_ok());
    assert_eq!(h.calls("wallet.open"), 2);
}

#[tokio::test]
async fn one_leaf_one_payment_method() {
    let h = harness().await;
    // Card payment pending (receipt saved): the same leaf cannot be paid shielded.
    set(&h, |w| w.issue_delay = 100);
    assert_eq!(h.orch.pay_fiat().await, Err(OrchError::StillPending));
    assert_eq!(h.orch.pay_shielded(PRICE).await, Err(OrchError::StillPending));
    assert_eq!(h.calls("wallet.buyBono"), 0);
    // The user abandons it: it can then be paid shielded (n = 0 again, with the same id).
    assert_eq!(h.orch.forget_pending_bono(0, 0).await, Err(OrchError::StillPending), "within insertBy + 5 min");
    h.env.now.fetch_add(3301, std::sync::atomic::Ordering::SeqCst);
    h.orch.forget_pending_bono(0, 0).await.unwrap();
    set(&h, |w| w.script_buy.extend([RpcError::Timeout, RpcError::Timeout, RpcError::Timeout]));
    assert_eq!(h.orch.pay_shielded(PRICE).await, Err(OrchError::StillPending));
    // Shielded purchase in the journal: neither card nor abandoning.
    assert_eq!(h.orch.pay_fiat().await, Err(OrchError::StillPending));
    assert_eq!(h.orch.forget_pending_bono(0, 0).await, Err(OrchError::StillPending));
}

#[tokio::test]
async fn a_failed_shielded_attempt_can_be_forgotten_35_min_later_without_unlocking_again() {
    let h = harness().await;
    let no_funds = remote(codes::INSUFFICIENT_FUNDS, serde_json::json!({ "asset": "token" }));
    set(&h, |w| w.script_buy.push_back(no_funds));
    assert_eq!(h.orch.pay_shielded(PRICE).await, Err(OrchError::InsufficientFunds { asset: FundsAsset::Token }));
    assert_eq!(h.orch.pay_fiat().await, Err(OrchError::StillPending), "leaf claimed");
    assert_eq!(h.orch.forget_pending_bono(0, 0).await, Err(OrchError::StillPending), "the journal protects it");
    h.env.now.fetch_add(resume::BUY_CLEANUP_S + 1, std::sync::atomic::Ordering::SeqCst);
    // Without `resume` in between: abandoning first closes the expired journal purchases.
    h.orch.forget_pending_bono(0, 0).await.unwrap();
    assert!(h.store.list_journal().unwrap().is_empty());
    assert!(!h.orch.wallet_busy());
    assert!(h.orch.pay_fiat().await.is_ok(), "another method can now be used to pay");
}

#[tokio::test]
async fn resume_settles_purchases_from_the_journal() {
    let h = harness().await;
    set(&h, |w| w.script_buy.extend([RpcError::Timeout, RpcError::Timeout, RpcError::Timeout]));
    assert_eq!(h.orch.pay_shielded(PRICE).await, Err(OrchError::StillPending));
    let id = id_k(h.orch.bono_secret(0).expose(), 0);
    set(&h, |w| w.issue(&id, crate::protocol::Plan::Paid));
    assert_eq!(h.orch.resume().await.unwrap().bonos_included, 1);
    assert!(h.store.list_journal().unwrap().is_empty());
    assert!(!h.orch.wallet_busy(), "journal closed: no buyBono is still in flight");
    // Another purchase that never lands: forgotten after 35 min.
    set(&h, |w| w.script_buy.extend([RpcError::Timeout, RpcError::Timeout, RpcError::Timeout]));
    assert_eq!(h.orch.pay_shielded(PRICE).await, Err(OrchError::StillPending));
    h.orch.resume().await.unwrap();
    assert_eq!(h.store.list_journal().unwrap().len(), 1, "it can still get in");
    h.env.now.fetch_add(36 * 60, std::sync::atomic::Ordering::SeqCst);
    h.orch.resume().await.unwrap();
    assert!(h.store.list_journal().unwrap().is_empty());
}

#[tokio::test]
async fn faucet_is_called_once_without_retries() {
    let h = harness().await;
    assert!(h.orch.faucet("aa", "5").await.is_ok());
    assert_eq!(h.calls("wallet.faucet"), 1);
    assert_eq!(h.orch.current_price().await.unwrap(), PRICE);
}

fn no_dust() -> RpcError {
    remote(codes::INSUFFICIENT_FUNDS, serde_json::json!({ "asset": "dust" }))
}

#[tokio::test]
async fn faucet_registers_dust_first_and_waits_for_it() {
    let mut h = harness().await;
    set(&h, |w| {
        w.dust_coins = 0;
        w.script_faucet.extend([no_dust(), no_dust()]);
    });
    assert!(h.orch.faucet("aa", "5").await.is_ok());
    assert_eq!((h.calls("wallet.registerDust"), h.calls("wallet.faucet")), (1, 3), "safe rejection: retried");
    assert_eq!(h.progress().iter().filter(|p| **p == Progress::WaitingDust).count(), 2);
    assert_eq!(h.calls("wallet.close"), 1);
}

#[tokio::test]
async fn faucet_gives_up_waiting_for_dust() {
    let h = harness().await;
    let waits = RetryPolicy::default().dust_waits as usize;
    set(&h, |w| w.script_faucet.extend(std::iter::repeat_with(no_dust).take(waits + 1)));
    assert_eq!(h.orch.faucet("aa", "5").await, Err(OrchError::InsufficientFunds { asset: FundsAsset::Dust }));
    assert_eq!(h.calls("wallet.faucet"), waits + 1);
    let other = remote(codes::INSUFFICIENT_FUNDS, serde_json::json!({ "asset": "token" }));
    set(&h, |w| w.script_faucet.push_back(other));
    let error = OrchError::InsufficientFunds { asset: FundsAsset::Token };
    assert_eq!(h.orch.faucet("aa", "5").await, Err(error), "other error: no retry");
    assert_eq!(h.calls("wallet.faucet"), waits + 2);
}

#[tokio::test]
async fn shielded_payment_waits_for_dust() {
    let mut h = harness().await;
    set(&h, |w| w.script_buy.extend([no_dust(), no_dust()]));
    assert!(h.orch.pay_shielded(PRICE).await.is_ok());
    assert_eq!(h.calls("wallet.buyBono"), 3, "DUST waits do not use up the call cap");
    assert!(h.progress().contains(&Progress::WaitingDust));
}

#[tokio::test]
async fn without_night_there_is_no_dust_to_wait_for() {
    let mut h = harness().await;
    set(&h, |w| {
        w.dust_coins = 0;
        w.register_nothing = true;
    });
    let expected = OrchError::InsufficientFunds { asset: FundsAsset::Dust };
    assert_eq!(h.orch.faucet("aa", "5").await, Err(expected), "right away, no waits");
    assert_eq!(h.calls("wallet.faucet"), 0);
    assert_eq!(h.orch.pay_shielded(PRICE).await.map(drop), Err(expected));
    assert_eq!(h.calls("wallet.buyBono"), 0);
    assert!(!h.progress().contains(&Progress::WaitingDust));
    // With NIGHT already registered (but no DUST coins yet) it does wait.
    set(&h, |w| {
        w.night = 5_000_000_000;
        w.script_faucet.push_back(no_dust());
    });
    assert!(h.orch.faucet("aa", "5").await.is_ok());
    assert_eq!(h.calls("wallet.faucet"), 2);
}

#[tokio::test]
async fn shielded_payment_gives_up_waiting_for_dust() {
    let h = harness().await;
    let waits = RetryPolicy::default().dust_waits as usize;
    set(&h, |w| w.script_buy.extend(std::iter::repeat_with(no_dust).take(waits + 1)));
    assert_eq!(h.orch.pay_shielded(PRICE).await, Err(OrchError::InsufficientFunds { asset: FundsAsset::Dust }));
    assert_eq!(h.calls("wallet.buyBono"), waits + 1);
    assert_eq!(h.calls("wallet.close"), 1, "nothing in flight: it closes");
    let journal = h.store.list_journal().unwrap();
    assert_eq!(journal.len(), 1, "the purchase stays recorded");
    let first: wallet::Purchase = serde_json::from_slice(&journal[0].payload).unwrap();
    // With funds, the next attempt pays the same leaf with the same id.
    assert!(h.orch.pay_shielded(PRICE).await.is_ok());
    assert_eq!(h.calls("wallet.buyBono"), waits + 2);
    let bonos = h.store.list_bonos().unwrap();
    assert_eq!(bonos.iter().filter(|b| b.plan == crate::store::Plan::Paid).count(), 1);
    assert_eq!((bonos[0].n, bonos[0].k), (first.n, first.k));
}

#[tokio::test]
async fn faucet_is_not_retried_after_an_unknown_ending() {
    let h = harness().await;
    set(&h, |w| w.script_faucet.extend([no_dust(), RpcError::Timeout]));
    assert_eq!(h.orch.faucet("aa", "5").await, Err(OrchError::MidnightUnavailable));
    assert_eq!(h.calls("wallet.faucet"), 2, "after the deadline, not one more");
    for error in [
        RpcError::Closed,
        remote(codes::TX_REJECTED, serde_json::json!(null)),
        remote(codes::CANCELLED, serde_json::json!(null)),
    ] {
        let before = h.calls("wallet.faucet");
        set(&h, |w| w.script_faucet.push_back(error));
        assert!(h.orch.faucet("aa", "5").await.is_err());
        assert_eq!(h.calls("wallet.faucet"), before + 1, "an uncertain outcome is not retried");
    }
}

#[tokio::test]
async fn faucet_resyncs_when_the_wallet_is_behind() {
    let h = harness().await;
    let not_synced = || remote(codes::WALLET_UNAVAILABLE, serde_json::json!({ "reason": "not-synced" }));
    set(&h, |w| w.script_faucet.extend([not_synced(), not_synced()]));
    assert!(h.orch.faucet("aa", "5").await.is_ok());
    assert_eq!((h.calls("wallet.faucet"), h.calls("wallet.sync")), (3, 3));
    set(&h, |w| w.script_faucet.extend([not_synced(), not_synced(), not_synced()]));
    let error = OrchError::Wallet { reason: crate::protocol::WalletProblem::NotSynced };
    assert_eq!(h.orch.faucet("aa", "5").await, Err(error), "capped");
}

#[tokio::test]
async fn wallet_snapshot_opens_syncs_and_closes() {
    let h = harness().await;
    set(&h, |w| w.dust_coins = 2);
    set(&h, |w| w.night = 5_000);
    let (snapshot, claim) = h.orch.wallet_snapshot().await.unwrap();
    assert_eq!((snapshot.unshielded_address.as_deref(), snapshot.balance.dust_coins), (Some("u"), 2));
    assert_eq!((snapshot.dust_setup, claim.is_none()), (DustSetup::Idle, true), "all NIGHT already generates DUST");
    assert_eq!((h.calls("wallet.open"), h.calls("wallet.sync"), h.calls("wallet.close")), (1, 1, 1));
    assert_eq!(h.calls("wallet.registerDust"), 0, "only looks: spends nothing");
}

#[tokio::test]
async fn wallet_snapshot_with_the_wallet_left_open() {
    let h = harness().await;
    // A buyBono may still be in flight: the wallet stays open and is not closed by a read.
    set(&h, |w| w.script_buy.extend([RpcError::Timeout, RpcError::Timeout, RpcError::Timeout]));
    assert_eq!(h.orch.pay_shielded(PRICE).await, Err(OrchError::StillPending));
    let (snapshot, _) = h.orch.wallet_snapshot().await.unwrap();
    assert_eq!(snapshot.unshielded_address.as_deref(), Some("u"), "the one from the previous open");
    assert!(h.world.lock().unwrap().wallet_open, "does not close with a buyBono in flight");
}

#[tokio::test]
async fn wallet_snapshot_without_a_known_address() {
    let h = harness().await;
    set(&h, |w| w.wallet_open = true);
    assert_eq!(h.orch.wallet_snapshot().await.unwrap().0.unshielded_address, None, "not made up");
}

#[tokio::test]
async fn wallet_snapshot_waits_for_no_bono_operation() {
    let h = harness().await;
    let _guard = h.orch.bono_lock().unwrap();
    assert_eq!(h.orch.wallet_snapshot().await.err(), Some(OrchError::Busy));
    assert_eq!(h.calls("wallet.open"), 0);
}

// --- Background NIGHT-for-DUST registration ---------------------------------------------------------------

fn night(h: &Harness, total: u64, unregistered: u64) {
    set(h, |w| {
        (w.night, w.unregistered_night) = (total, unregistered);
        w.dust_coins = 0;
    });
}

#[tokio::test]
async fn unregistered_night_is_registered_in_the_background_once() {
    let h = harness().await;
    night(&h, 5_000, 5_000);
    let (snapshot, claim) = h.orch.wallet_snapshot().await.unwrap();
    let claim = claim.expect("unregistered NIGHT: the background registration is claimed");
    assert_eq!(snapshot.dust_setup, DustSetup::Activating);
    assert_eq!(h.calls("wallet.close"), 0, "the wallet stays open for the registration");
    // Another read meanwhile: no second registration and the wallet stays open.
    let (again, second) = h.orch.wallet_snapshot().await.unwrap();
    assert_eq!((again.dust_setup, second.is_none(), h.calls("wallet.close")), (DustSetup::Activating, true, 0));
    assert!(h.orch.setup_dust(claim).await);
    assert_eq!((h.calls("wallet.registerDust"), h.calls("wallet.close")), (1, 1), "closes with the last use");
    assert!(!h.world.lock().unwrap().wallet_open);
    let (done, none) = h.orch.wallet_snapshot().await.unwrap();
    assert_eq!((done.dust_setup, none.is_none()), (DustSetup::Idle, true));
    // More NIGHT arrives: it gets registered too.
    night(&h, 6_000, 1_000);
    assert!(h.orch.wallet_snapshot().await.unwrap().1.is_some());
}

#[tokio::test]
async fn a_failed_background_setup_is_not_retried_until_more_night_arrives() {
    let h = harness().await;
    night(&h, 10, 10);
    set(&h, |w| w.script_register.push_back(no_dust()));
    let claim = h.orch.wallet_snapshot().await.unwrap().1.unwrap();
    assert!(!h.orch.setup_dust(claim).await);
    for _ in 0..3 {
        let (snapshot, claim) = h.orch.wallet_snapshot().await.unwrap();
        assert_eq!((snapshot.dust_setup, claim.is_none()), (DustSetup::Failed, true), "no loop and no more attempts");
    }
    assert_eq!(h.calls("wallet.registerDust"), 1);
    assert!(!h.world.lock().unwrap().wallet_open);
    night(&h, 20, 20);
    let (snapshot, claim) = h.orch.wallet_snapshot().await.unwrap();
    assert_eq!((snapshot.dust_setup, claim.is_some()), (DustSetup::Activating, true), "with more NIGHT, again");
}

#[tokio::test]
async fn an_abandoned_claim_is_claimed_again_by_the_next_look() {
    let h = harness().await;
    night(&h, 10, 10);
    let claim = h.orch.wallet_snapshot().await.unwrap().1;
    drop(claim); // the task was aborted (lock or exit)
    // Dropping the use only decrements: the session close (`shutdown`), right after, closes the wallet.
    assert!(h.world.lock().unwrap().wallet_open);
    h.orch.shutdown().await;
    assert!(!h.world.lock().unwrap().wallet_open, "closing the session closes the wallet");
    let (snapshot, claim) = h.orch.wallet_snapshot().await.unwrap();
    assert_eq!((snapshot.dust_setup, claim.is_some()), (DustSetup::Activating, true));
    assert_eq!(h.calls("wallet.registerDust"), 0);
}

#[tokio::test]
async fn a_background_setup_behind_the_chain_resyncs_and_retries_once() {
    let h = harness().await;
    night(&h, 10, 10);
    let not_synced = || remote(codes::WALLET_UNAVAILABLE, serde_json::json!({ "reason": "not-synced" }));
    set(&h, |w| w.script_register.push_back(not_synced()));
    let claim = h.orch.wallet_snapshot().await.unwrap().1.unwrap();
    assert!(h.orch.setup_dust(claim).await);
    assert_eq!((h.calls("wallet.registerDust"), h.calls("wallet.sync")), (2, 2));
    // Twice in a row: only one retry, and it counts as a failure.
    night(&h, 20, 20);
    set(&h, |w| w.script_register.extend([not_synced(), not_synced()]));
    let claim = h.orch.wallet_snapshot().await.unwrap().1.unwrap();
    assert!(!h.orch.setup_dust(claim).await);
    assert_eq!(h.calls("wallet.registerDust"), 4);
    assert_eq!(h.orch.wallet_snapshot().await.unwrap().0.dust_setup, DustSetup::Failed);
}

/// At unlock: a read without the bono lock (does not clash with `resume` or hold up a payment).
#[tokio::test]
async fn the_unlock_check_claims_without_the_bono_lock_and_closes_when_there_is_nothing() {
    let h = harness().await;
    night(&h, 10, 0);
    assert!(h.orch.check_dust().await.unwrap().is_none());
    assert_eq!((h.calls("wallet.open"), h.calls("wallet.sync"), h.calls("wallet.close")), (1, 1, 1));
    night(&h, 10, 10);
    let _paying = h.orch.bono_lock().unwrap();
    let claim = h.orch.check_dust().await.unwrap().expect("with unregistered NIGHT");
    assert!(h.world.lock().unwrap().wallet_open, "stays open for the registration");
    assert!(h.orch.setup_dust(claim).await);
    assert!(!h.world.lock().unwrap().wallet_open);
}

/// A payment during a background registration: it does not wait for the bono lock or register concurrently. Its
/// `registerDust` comes after the background one, and the wallet closes once, at the end.
#[tokio::test]
async fn a_payment_during_the_background_setup_waits_for_it_without_registering_twice() {
    let h = harness().await;
    night(&h, 5_000, 5_000);
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    set(&h, |w| w.register_gate = Some(gate.clone()));
    let claim = h.orch.wallet_snapshot().await.unwrap().1.unwrap();
    let control = async {
        // The payment already synced (second sync): now it waits for the background registration.
        while h.calls("wallet.sync") < 2 {
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
        assert_eq!((h.calls("wallet.registerDust"), h.calls("wallet.buyBono")), (1, 0));
        assert_eq!(h.calls("wallet.close"), 0);
        gate.add_permits(1);
    };
    let work = async { tokio::join!(h.orch.setup_dust(claim), h.orch.pay_shielded(PRICE), control) };
    let (registered, paid, ()) = tokio::time::timeout(std::time::Duration::from_secs(10), work).await.unwrap();
    assert!(registered && paid.is_ok());
    let calls = h.world.lock().unwrap().calls.clone();
    let registers: Vec<usize> = (0..calls.len()).filter(|i| calls[*i] == "wallet.registerDust").collect();
    let buy = calls.iter().position(|c| c == "wallet.buyBono").unwrap();
    assert_eq!(registers.len(), 2);
    assert!(registers[1] < buy);
    assert_eq!(h.world.lock().unwrap().register_results, [true, false], "the payment one no longer registers anything");
    assert_eq!(h.calls("wallet.close"), 1);
    assert!(!h.world.lock().unwrap().wallet_open);
}

// --- Addresses ----------------------------------------------------------------------------------------------

#[tokio::test]
async fn aliases_fill_the_free_quota() {
    let mut h = harness().await;
    free_bono(&h).await;
    let first = h.orch.create_alias().await.unwrap();
    let second = h.orch.create_alias().await.unwrap();
    assert_eq!((first.slot.j, second.slot.j, first.slot.kind), (0, 1, AddressKind::Alias));
    assert!(first.display.starts_with("nube.verde.") && first.display.ends_with("@nightmail.local"));
    assert_eq!(h.orch.create_alias().await, Err(OrchError::NoFreeSlot));
    assert!(h.progress().contains(&Progress::AddressReady));
    let stored = h.store.get_address(&bytes32(&first.addr_key).unwrap()).unwrap().unwrap();
    assert_eq!(sync_target(&keys(), &stored).unwrap().addr_key, stored.addr_key);
}

#[tokio::test]
async fn concurrent_operations_take_different_slots() {
    let h = harness().await;
    free_bono(&h).await;
    let (a, b) = tokio::join!(h.orch.create_alias(), h.orch.create_alias());
    let mut js = [a.unwrap().slot.j, b.unwrap().slot.j];
    js.sort();
    assert_eq!(js, [0, 1]);
}

#[tokio::test]
async fn no_bono_means_no_free_slot() {
    let h = harness().await;
    assert_eq!(h.orch.create_alias().await, Err(OrchError::NoFreeSlot));
}

#[tokio::test]
async fn mailbox_in_one_step() {
    let h = harness().await;
    free_bono(&h).await;
    let check = h.orch.check_name("Juan.Perez").await.unwrap();
    assert_eq!(check, NameCheck { normalized: "juan.perez".into(), available: true });
    let mailbox = h.orch.create_mailbox("Juan.Perez").await.unwrap();
    assert_eq!((mailbox.display.as_str(), mailbox.name.as_deref()), ("juan.perez@nightmail.local", Some("juan.perez")));
    assert_eq!(status(&h, SlotKind::Mailbox, 0), SlotStatus::Used);
    assert_eq!((h.calls("contract.proveCall"), h.calls("relay")), (1, 1), "a single transaction");
    assert_eq!(h.orch.create_mailbox("juan.perez").await, Err(OrchError::NameTaken));
}

/// The relays and proofs of a run, with the node's block time when each happened (Unix ms).
fn timeline(w: &World, what: &str) -> Vec<u64> {
    w.timeline.iter().filter(|(w, _)| *w == what).map(|(_, t)| *t).collect()
}

/// A live chain (blocks every 6 s on the fake clock, the indexer 18 s behind) and room for longer waits.
async fn live_harness(f: impl FnOnce(&mut World)) -> Harness {
    let cfg = OrchestratorConfig { pacing: Pacing { max_polls: 100, ..Pacing::default() }, ..config() };
    let h = harness_on(world(), cfg).await;
    set(&h, |w| {
        w.live = true;
        w.indexer_lag_ms = 18_000;
        f(w);
    });
    free_bono(&h).await;
    h
}

// --- The indexer behind the relayer's answer ---------------------------------------------------------------
// In the live fake the indexer (18 s behind the node) shows a transaction only once it reaches its block, while the
// relayer answers as soon as it is in a block: right after an answer, the state read is the old one.

#[tokio::test]
async fn a_mailbox_that_landed_but_was_reported_unknown_is_seen_not_proved_again() {
    let h = live_harness(|w| w.report_unknown = 1).await;
    h.orch.create_mailbox("ana").await.unwrap();
    assert_eq!((h.calls("contract.proveCall"), h.calls("relay")), (1, 1), "the next turn waited for the indexer");
    assert_eq!(status(&h, SlotKind::Mailbox, 0), SlotStatus::Used);
}

#[tokio::test]
async fn an_alias_that_landed_but_was_reported_unknown_is_adopted_not_proved_again() {
    let h = live_harness(|w| w.report_unknown = 1).await;
    let alias = h.orch.create_alias().await.unwrap();
    assert_eq!(alias.slot.j, 0);
    assert_eq!((h.calls("contract.proveCall"), h.calls("relay")), (1, 1));
}

#[tokio::test]
async fn a_name_just_created_is_not_offered_again_while_the_indexer_has_not_caught_up() {
    let h = live_harness(|_| {}).await;
    h.orch.create_mailbox("ana").await.unwrap();
    let taken = h.orch.hash(HashOp::AddrKey { name: "ana".into() }).await.unwrap();
    {
        let w = h.world.lock().unwrap();
        let landed = w.addresses.iter().any(|a| a.addr_key == taken);
        assert!(landed && !w.visible_addresses().contains(&taken), "indexer behind");
    }
    assert!(!h.orch.check_name("Ana").await.unwrap().available, "our own address counts");
    assert_eq!(h.orch.create_mailbox("ana").await, Err(OrchError::NameTaken), "no second slot spent on it");
}

#[tokio::test]
async fn after_a_mailbox_the_node_refused_the_next_one_does_not_wait_for_the_indexer() {
    let h = live_harness(|w| w.refuse_next.push_back("mailbox")).await;
    h.orch.create_mailbox("ana").await.unwrap();
    let w = h.world.lock().unwrap();
    let (proofs, relays) = (timeline(&w, "contract.proveCall"), timeline(&w, "relay"));
    assert_eq!(relays.len(), 2);
    // A definite refusal cannot land later: no waiting for the indexer (18 s behind) to catch up.
    assert!(proofs[1] - relays[0] < 18_000, "the second proof came {} ms after the first relay", proofs[1] - relays[0]);
    drop(w);
    assert_eq!(status(&h, SlotKind::Mailbox, 0), SlotStatus::Used);
}

#[tokio::test]
async fn names_are_validated() {
    let h = harness().await;
    assert_eq!(h.orch.check_name("admin").await, Err(OrchError::NameRejected { reason: NameProblem::Reserved }));
    assert_eq!(h.orch.check_name("a b").await, Err(OrchError::NameRejected { reason: NameProblem::Invalid }));
    assert!(addresses::alias_form("nube.verde.abcdef123456"));
    assert!(!addresses::alias_form("juan.perez"));
}

#[tokio::test]
async fn a_name_taken_before_registering_frees_the_slot() {
    let h = harness().await;
    free_bono(&h).await;
    let k = reserving_mailbox(&h, "eva").await;
    let taken = h.orch.hash(HashOp::AddrKey { name: "eva".into() }).await.unwrap();
    set(&h, |w| w.addresses.push(foreign(taken, AddressKind::Mailbox, "33".repeat(32))));
    assert_eq!(h.orch.drive(k).await, Err(OrchError::NameTaken));
    assert!(slot(&h, SlotKind::Mailbox, 0).is_none(), "the slot is freed");
    assert_eq!(h.calls("contract.proveCall"), 0);
}

#[tokio::test]
async fn a_name_taken_after_an_attempt_frees_the_slot_too() {
    let h = harness().await;
    free_bono(&h).await;
    let k = key(SlotKind::Mailbox, 0);
    let nul = bytes32(&h.orch.slot_nul(k).await.unwrap()).unwrap();
    let row = Slot {
        key: k,
        slot_nul: nul,
        status: SlotStatus::Reserving,
        addr_key: None,
        pending_name: Some("eva".into()),
        attempts: 1,
        updated_at: 0,
    };
    h.store.insert_slot(&row).unwrap();
    let taken = h.orch.hash(HashOp::AddrKey { name: "eva".into() }).await.unwrap();
    set(&h, |w| w.addresses.push(foreign(taken, AddressKind::Mailbox, "33".repeat(32))));
    assert_eq!(h.orch.drive(k).await, Err(OrchError::NameTaken));
    assert!(slot(&h, SlotKind::Mailbox, 0).is_none(), "none of its proofs can land: the slot is freed");
    assert_eq!(h.orch.pending_slots().await.unwrap(), []);
    assert_eq!(h.orch.create_mailbox("otra").await.unwrap().slot.j, 0, "the same slot takes another name");
}

#[tokio::test]
async fn a_taken_name_never_frees_a_slot_whose_nullifier_is_spent() {
    let h = harness().await;
    free_bono(&h).await;
    let k = reserving_mailbox(&h, "eva").await;
    let nul = h.orch.slot_nul(k).await.unwrap();
    let taken = h.orch.hash(HashOp::AddrKey { name: "eva".into() }).await.unwrap();
    set(&h, |w| {
        w.nullifiers.insert(nul);
        w.addresses.push(foreign(taken, AddressKind::Mailbox, "33".repeat(32)));
    });
    assert_eq!(h.orch.drive(k).await, Err(OrchError::StaleState), "the indexer contradicts the contract");
    assert_eq!(status(&h, SlotKind::Mailbox, 0), SlotStatus::Reserving, "the slot is kept, not freed");
    assert_eq!(h.calls("contract.proveCall"), 0);
}

#[tokio::test]
async fn a_name_the_contract_rejects_locally_as_taken_frees_the_slot() {
    let h = harness().await;
    free_bono(&h).await;
    set(&h, |w| w.script_prove.push_back(rejected("address-taken")));
    assert_eq!(h.orch.create_mailbox("eva").await, Err(OrchError::NameTaken));
    assert!(slot(&h, SlotKind::Mailbox, 0).is_none());
    assert_eq!(h.calls("relay"), 0, "nothing was sent");
    assert_eq!(h.orch.create_mailbox("otra").await.unwrap().slot.j, 0);
}

#[tokio::test]
async fn create_mailbox_resumes_or_releases_a_previous_reserving_slot() {
    let h = harness().await;
    set(&h, |w| w.auto_time = true);
    free_bono(&h).await;
    reserving_mailbox(&h, "ana").await;
    let bea = h.orch.create_mailbox("bea").await.unwrap();
    assert_eq!((bea.slot.j, bea.name.as_deref()), (0, Some("bea")), "the 'ana' one with no attempts was released");
}

#[tokio::test]
async fn create_mailbox_resumes_the_same_name() {
    let h = harness().await;
    set(&h, |w| w.auto_time = true);
    free_bono(&h).await;
    reserving_mailbox(&h, "ana").await;
    assert_eq!(h.orch.create_mailbox("ana").await.unwrap().slot.j, 0);
}

#[tokio::test]
async fn a_failure_before_sending_releases_the_slot() {
    let h = harness().await;
    free_bono(&h).await;
    set(&h, |w| w.script_prove.extend((0..4).map(|_| unavailable())));
    assert_eq!(h.orch.create_alias().await, Err(OrchError::MidnightUnavailable));
    assert!(slot(&h, SlotKind::Alias, 0).is_none(), "neither ghost nor duplicate");
    assert_eq!(h.orch.create_alias().await.unwrap().slot.j, 0);
}

#[tokio::test]
async fn a_pending_alias_slot_is_resumed_by_create_alias() {
    let h = harness().await;
    free_bono(&h).await;
    set(&h, |w| w.script_submit.push_back(Err(RelayError::NotRelayable)));
    h.orch.create_alias().await.unwrap_err();
    assert_eq!(slot(&h, SlotKind::Alias, 0).unwrap().attempts, 1, "received: the slot is kept");
    assert_eq!(h.orch.create_alias().await.unwrap().slot.j, 0, "the same slot is resumed");
    assert_eq!(h.store.list_slots(0).unwrap().len(), 1, "no new slot");
    assert_eq!(slot(&h, SlotKind::Alias, 0).unwrap().attempts, 2);
}

#[tokio::test]
async fn a_name_taken_between_the_proof_and_its_block_frees_the_slot_without_spending_it() {
    let h = harness().await;
    free_bono(&h).await;
    let theirs = h.orch.hash(HashOp::AddrKey { name: "eva".into() }).await.unwrap();
    set(&h, |w| w.before_apply.push(foreign(theirs, AddressKind::Mailbox, "33".repeat(32))));
    assert_eq!(h.orch.create_mailbox("eva").await, Err(OrchError::NameTaken));
    assert_eq!((h.calls("contract.proveCall"), h.calls("relay")), (1, 1), "the node rejected the whole transaction");
    let nul = h.orch.slot_nul(key(SlotKind::Mailbox, 0)).await.unwrap();
    assert!(!h.world.lock().unwrap().nullifiers.contains(&nul), "the slot was not spent");
    assert!(slot(&h, SlotKind::Mailbox, 0).is_none(), "and it is free again");
    assert_eq!(h.orch.create_mailbox("otra").await.unwrap().slot.j, 0);
}

#[tokio::test]
async fn interrupted_mailbox_is_resumed() {
    let h = harness().await;
    free_bono(&h).await;
    set(&h, |w| w.script_submit.push_back(Err(RelayError::NotRelayable)));
    assert_eq!(h.orch.create_mailbox("luz").await, Err(OrchError::RelayerRefused));
    assert_eq!(status(&h, SlotKind::Mailbox, 0), SlotStatus::Reserving, "received: the slot is kept");
    let report = h.orch.resume().await.unwrap();
    assert_eq!((report.addresses, report.failed.len()), (1, 0));
    assert_eq!(h.store.list_addresses().unwrap()[0].display, "luz@nightmail.local");
}

#[tokio::test]
async fn relayer_busy_and_network_errors_resend_the_same_bytes_without_counting() {
    let h = harness().await;
    free_bono(&h).await;
    set(&h, |w| {
        w.script_submit.extend([Ok(Submitted::Busy { retry_after_s: 7 }), Err(RelayError::Unavailable)]);
        w.script_status.push_back(Ok(TicketState::Queued));
    });
    h.orch.create_alias().await.unwrap();
    assert_eq!((h.calls("contract.proveCall"), h.calls("relay")), (1, 3), "one proof, three submissions");
    assert!(h.env.slept.lock().unwrap().contains(&Duration::from_secs(7)));
    assert_eq!(slot(&h, SlotKind::Alias, 0).unwrap().attempts, 1, "only the accepted submission counts");
}

#[tokio::test]
async fn an_unreachable_relayer_is_told_apart_from_a_busy_one() {
    let mut h = harness().await;
    free_bono(&h).await;
    // Busy, then no answer up to the cap: what counts is how it ends.
    set(&h, |w| {
        w.script_submit.push_back(Ok(Submitted::Busy { retry_after_s: 1 }));
        w.script_submit.extend((0..5).map(|_| Err(RelayError::Unreachable)));
    });
    assert_eq!(h.orch.create_alias().await, Err(OrchError::ServerUnreachable));
    let progress = h.progress();
    assert_eq!(progress.iter().filter(|p| **p == Progress::Retrying).count(), 1, "only the 'busy' one");
    assert_eq!(progress.iter().filter(|p| **p == Progress::ServerUnreachable).count(), 4);
    assert_eq!(h.calls("contract.proveCall"), 1, "the same bytes on every resend");
    // The other way round: no answer, then busy up to the cap → the generic text.
    set(&h, |w| {
        w.script_submit.push_back(Err(RelayError::Unreachable));
        w.script_submit.extend((0..5).map(|_| Ok(Submitted::Busy { retry_after_s: 1 })));
    });
    assert_eq!(h.orch.create_alias().await, Err(OrchError::ServiceUnavailable));
    assert!(OrchError::ServerUnreachable.may_clear_by_itself());
}

#[tokio::test]
async fn with_the_relayer_down_nothing_is_proved_or_counted() {
    let mut h = harness().await;
    free_bono(&h).await;
    h.progress();
    // No answer up to the wait cap: no proof and no attempt spent.
    set(&h, |w| w.script_reachable.extend([false; 6]));
    assert_eq!(h.orch.create_alias().await, Err(OrchError::ServerUnreachable));
    assert_eq!((h.calls("reach"), h.calls("contract.proveCall"), h.calls("relay")), (6, 0, 0));
    assert_eq!(slot(&h, SlotKind::Alias, 0).map_or(0, |s| s.attempts), 0, "no attempt spent");
    let progress = h.progress();
    assert_eq!(progress.iter().filter(|p| **p == Progress::ServerUnreachable).count(), 5);
    assert!(!progress.contains(&Progress::Proving));
    // It answers again on the third check: then one proof is made and sent.
    set(&h, |w| w.script_reachable.extend([false, false]));
    h.orch.create_alias().await.unwrap();
    assert_eq!((h.calls("reach"), h.calls("contract.proveCall")), (9, 1));
    assert_eq!(slot(&h, SlotKind::Alias, 0).unwrap().attempts, 1);
}

#[tokio::test]
async fn a_proof_the_relayer_never_received_spends_no_attempt() {
    let h = harness().await;
    free_bono(&h).await;
    // It answers before proving and goes down during the proof: busy, 5xx and no answer do not count.
    set(&h, |w| {
        w.script_submit.extend([Ok(Submitted::Busy { retry_after_s: 1 }), Err(RelayError::Unavailable)]);
        w.script_submit.extend((0..4).map(|_| Err(RelayError::Unreachable)));
    });
    assert_eq!(h.orch.create_alias().await, Err(OrchError::ServerUnreachable));
    assert_eq!(h.calls("contract.proveCall"), 1);
    assert_eq!(slot(&h, SlotKind::Alias, 0).map_or(0, |s| s.attempts), 0, "it never received it");
    // Another proof the relayer does receive (and rejects twice with the same bytes): it counts once.
    set(&h, |w| w.script_submit.extend([Ok(Submitted::Busy { retry_after_s: 1 }), Err(RelayError::NotRelayable)]));
    assert_eq!(h.orch.create_alias().await, Err(OrchError::RelayerRefused));
    assert_eq!(slot(&h, SlotKind::Alias, 0).unwrap().attempts, 1);
    // Accepted after a "busy": one proof, one attempt.
    set(&h, |w| w.script_submit.push_back(Ok(Submitted::Busy { retry_after_s: 1 })));
    h.orch.create_alias().await.unwrap();
    assert_eq!(slot(&h, SlotKind::Alias, 0).unwrap().attempts, 2);
}

#[tokio::test]
async fn bad_ttl_and_expired_mean_a_new_proof_after_a_later_block() {
    let h = harness().await;
    free_bono(&h).await;
    set(&h, |w| {
        w.script_submit.push_back(Ok(Submitted::BadTtl));
        w.script_status.push_back(Ok(TicketState::Done(RelayOutcome::Expired)));
    });
    let snapshots = h.calls("contract.snapshot");
    h.orch.create_alias().await.unwrap();
    assert_eq!(h.calls("contract.proveCall"), 3, "bad-ttl and expired: a new proof each time");
    assert_eq!(slot(&h, SlotKind::Alias, 0).unwrap().attempts, 3, "each distinct proof counts");
    assert!(h.calls("contract.snapshot") > snapshots + 3, "waited for a later block and checked the chain");
}

#[tokio::test]
async fn proof_cap_pauses_the_slot_until_the_user_resumes_it() {
    let h = harness().await;
    free_bono(&h).await;
    set(&h, |w| w.script_status.extend((0..MAX_PROOFS).map(|_| Ok(TicketState::Done(RelayOutcome::Rejected)))));
    assert_eq!(h.orch.create_alias().await, Err(OrchError::AttemptsExhausted));
    assert_eq!(status(&h, SlotKind::Alias, 0), SlotStatus::Reserving, "paused in its state");
    assert_eq!(h.calls("contract.proveCall"), MAX_PROOFS as usize, "{MAX_PROOFS} rejections and no more proofs");
    assert_eq!(slot(&h, SlotKind::Alias, 0).unwrap().attempts, MAX_PROOFS);
    let report = h.orch.resume().await.unwrap();
    assert_eq!(
        report.failed,
        [SlotFailure { slot: key(SlotKind::Alias, 0).into(), error: OrchError::AttemptsExhausted }]
    );
    assert_eq!(h.orch.resume_paused_slot(key(SlotKind::Alias, 0).into()).await.unwrap().slot.j, 0);
}

#[tokio::test]
async fn pending_slots_lists_half_done_slots_and_marks_the_paused_ones() {
    let h = harness().await;
    free_bono(&h).await;
    assert_eq!(h.orch.pending_slots().await.unwrap(), []);
    let mailbox = reserving_mailbox(&h, "juan.perez").await;
    set(&h, |w| w.script_status.extend((0..MAX_PROOFS).map(|_| Ok(TicketState::Done(RelayOutcome::Rejected)))));
    assert_eq!(h.orch.create_alias().await, Err(OrchError::AttemptsExhausted));
    let pending = h.orch.pending_slots().await.unwrap();
    assert_eq!(
        pending,
        [
            PendingSlot {
                slot: mailbox.into(),
                paused: false,
                in_progress: false,
                stopped: false,
                stop_reason: None,
                abandonable: true,
                name: Some("juan.perez".into())
            },
            PendingSlot {
                slot: key(SlotKind::Alias, 0).into(),
                paused: true,
                in_progress: false,
                stopped: true,
                stop_reason: Some(OrchError::AttemptsExhausted),
                abandonable: false,
                name: None
            },
        ],
        "mailbox before alias; the alias used up its cap and its proofs can still get in"
    );
    assert!(!format!("{:?}", pending[0]).contains("juan"), "Debug without the name");
    h.env.now.fetch_add(actions::ABANDON_TTL_S + 1, std::sync::atomic::Ordering::SeqCst);
    assert!(h.orch.pending_slots().await.unwrap()[1].abandonable, "past the TTL of its last proof");
    h.orch.resume_paused_slot(key(SlotKind::Alias, 0).into()).await.unwrap();
    assert_eq!(h.orch.pending_slots().await.unwrap().len(), 1, "the alias is done");
}

#[tokio::test]
async fn pending_slots_marks_the_slot_an_operation_is_driving() {
    let h = harness().await;
    free_bono(&h).await;
    let mailbox = reserving_mailbox(&h, "juan.perez").await;
    let in_progress = |p: Vec<PendingSlot>| p.iter().map(|p| p.in_progress).collect::<Vec<_>>();
    {
        let _driving = addresses::Driving::mark(&h.orch.driving, None, mailbox);
        assert_eq!(in_progress(h.orch.pending_slots().await.unwrap()), [true]);
    }
    assert_eq!(in_progress(h.orch.pending_slots().await.unwrap()), [false], "when it finishes (or fails), the mark is cleared");
    // `drive` marks the slot and unmarks it on exit, also on error.
    set(&h, |w| w.script_status.extend((0..MAX_PROOFS).map(|_| Ok(TicketState::Done(RelayOutcome::Rejected)))));
    assert_eq!(h.orch.create_alias().await, Err(OrchError::AttemptsExhausted));
    assert_eq!(in_progress(h.orch.pending_slots().await.unwrap()), [false, false]);
}

#[tokio::test]
async fn pending_slots_marks_as_stopped_only_what_needs_the_user() {
    let h = harness().await;
    free_bono(&h).await;
    let stopped = |p: Vec<PendingSlot>| p.iter().map(|p| p.stopped).collect::<Vec<_>>();
    // A failure that clears by itself (Midnight not answering): the app will retry it, it is not stopped.
    set(&h, |w| w.script_status.push_back(Err(RelayError::RateLimited { retry_after_s: 60 })));
    assert!(h.orch.create_alias().await.unwrap_err().may_clear_by_itself());
    assert_eq!(stopped(h.orch.pending_slots().await.unwrap()), [false]);
    assert_eq!(h.orch.pending_slots().await.unwrap()[0].stop_reason, None, "not stopped, no reason");
    // A rejection that would just repeat: stopped until the user acts.
    h.env.now.fetch_add(61, std::sync::atomic::Ordering::SeqCst);
    set(&h, |w| w.script_status.push_back(Ok(TicketState::Done(RelayOutcome::Refused))));
    assert_eq!(h.orch.resume().await.unwrap().failed[0].error, OrchError::RelayerRefused);
    assert_eq!(stopped(h.orch.pending_slots().await.unwrap()), [true]);
    assert_eq!(
        h.orch.pending_slots().await.unwrap()[0].stop_reason,
        Some(OrchError::RelayerRefused),
        "the row says why: the error of its last attempt"
    );
    // Really stopped: the background retry leaves it alone (and spends no proof), but reports it.
    let proofs = h.calls("contract.proveCall");
    let report = h.orch.resume_background().await.unwrap();
    assert_eq!(h.calls("contract.proveCall"), proofs, "the background loop does not drive a stopped slot");
    assert_eq!(report.failed[0].error, OrchError::RelayerRefused, "it shows in the report with its last error");
    assert!(!report.needs_retry(), "and it does not keep the loop alive");
    assert_eq!(stopped(h.orch.pending_slots().await.unwrap()), [true]);
    // What the user asks for ("Retry", or unlocking) does drive it. If it succeeds, it is no longer stopped.
    h.orch.resume().await.unwrap();
    assert_eq!(h.orch.pending_slots().await.unwrap(), []);
    assert!(h.orch.stuck.lock().unwrap().is_empty(), "a `drive` that succeeds removes it");
}

#[tokio::test]
async fn the_background_retry_skips_a_slot_out_of_attempts_but_the_user_can_resume_it() {
    let h = harness().await;
    free_bono(&h).await;
    set(&h, |w| w.script_status.extend((0..MAX_PROOFS).map(|_| Ok(TicketState::Done(RelayOutcome::Rejected)))));
    assert_eq!(h.orch.create_alias().await, Err(OrchError::AttemptsExhausted));
    let snapshots = h.calls("contract.snapshot");
    let report = h.orch.resume_background().await.unwrap();
    assert_eq!(report.failed[0].error, OrchError::AttemptsExhausted);
    assert_eq!(h.calls("contract.snapshot"), snapshots, "does not even check the chain for it");
    assert!(h.orch.pending_slots().await.unwrap()[0].stopped);
}

#[tokio::test]
async fn in_progress_wins_over_stopped() {
    let h = harness().await;
    free_bono(&h).await;
    set(&h, |w| w.script_submit.push_back(Err(RelayError::NotRelayable)));
    assert_eq!(h.orch.create_alias().await, Err(OrchError::RelayerRefused));
    let alias = key(SlotKind::Alias, 0);
    assert!(h.orch.pending_slots().await.unwrap()[0].stopped);
    let _driving = addresses::Driving::mark(&h.orch.driving, None, alias);
    let row = &h.orch.pending_slots().await.unwrap()[0];
    assert!(row.in_progress && !row.stopped, "while being driven, it is not stopped");
}

#[tokio::test]
async fn a_slot_in_progress_has_no_stop_reason_even_with_a_saved_error() {
    let h = harness().await;
    free_bono(&h).await;
    set(&h, |w| w.script_submit.push_back(Err(RelayError::NotRelayable)));
    assert_eq!(h.orch.create_alias().await, Err(OrchError::RelayerRefused));
    let alias = key(SlotKind::Alias, 0);
    assert_eq!(*h.orch.stuck.lock().unwrap(), [(alias, OrchError::RelayerRefused)], "the error is saved");
    let _driving = addresses::Driving::mark(&h.orch.driving, None, alias);
    assert_eq!(h.orch.pending_slots().await.unwrap()[0].stop_reason, None, "in progress: no stop reason");
}

#[tokio::test]
async fn attempts_exhausted_wins_over_a_saved_error() {
    let h = harness().await;
    free_bono(&h).await;
    set(&h, |w| w.script_status.extend((0..MAX_PROOFS).map(|_| Ok(TicketState::Done(RelayOutcome::Rejected)))));
    assert_eq!(h.orch.create_alias().await, Err(OrchError::AttemptsExhausted));
    let alias = key(SlotKind::Alias, 0);
    // Cap used up and, on top of that, the last attempt stored with another error that does not clear by itself.
    *h.orch.stuck.lock().unwrap() = vec![(alias, OrchError::RelayerRefused)];
    let row = &h.orch.pending_slots().await.unwrap()[0];
    assert!(row.stopped);
    assert_eq!(row.stop_reason, Some(OrchError::AttemptsExhausted), "the cap wins over the error");
}

#[tokio::test]
async fn a_saved_error_is_cleared_when_the_next_attempt_fails_with_something_passing() {
    let h = harness().await;
    free_bono(&h).await;
    set(&h, |w| w.script_submit.push_back(Err(RelayError::NotRelayable)));
    assert_eq!(h.orch.create_alias().await, Err(OrchError::RelayerRefused));
    assert_eq!(h.orch.pending_slots().await.unwrap()[0].stop_reason, Some(OrchError::RelayerRefused));
    // The user retries and this time something that clears by itself fails: no longer stopped, old error dropped.
    set(&h, |w| w.script_submit.push_back(Err(RelayError::RateLimited { retry_after_s: 60 })));
    assert!(h.orch.resume().await.unwrap().failed[0].error.may_clear_by_itself());
    assert!(h.orch.stuck.lock().unwrap().is_empty(), "the saved error is cleared");
    let row = &h.orch.pending_slots().await.unwrap()[0];
    assert!(!row.stopped);
    assert_eq!(row.stop_reason, None);
}

#[tokio::test]
async fn driving_a_slot_tells_the_app_when_it_starts_and_ends() {
    let mut h = harness().await;
    free_bono(&h).await;
    let _ = std::iter::from_fn(|| h.events.try_recv().ok()).count();
    h.orch.create_alias().await.unwrap();
    let events: Vec<OrchEvent> = std::iter::from_fn(|| h.events.try_recv().ok()).collect();
    let changes: Vec<usize> =
        events.iter().enumerate().filter(|(_, e)| **e == OrchEvent::PendingChanged).map(|(i, _)| i).collect();
    assert_eq!(changes.len(), 2, "one when setting the mark and another when clearing it: {events:?}");
    let proving = events.iter().position(|e| matches!(e, OrchEvent::Progress(p) if p.progress == Progress::Proving));
    assert!(proving.is_some_and(|i| changes[0] < i && i < changes[1]), "the proof runs with the slot marked");
}

#[tokio::test]
async fn resume_marks_the_slot_and_tells_the_app_before_its_wait() {
    let mut h = harness().await;
    free_bono(&h).await;
    set(&h, |w| w.script_submit.push_back(Err(RelayError::NotRelayable)));
    assert_eq!(h.orch.create_alias().await, Err(OrchError::RelayerRefused));
    let _ = std::iter::from_fn(|| h.events.try_recv().ok()).count();
    h.orch.resume().await.unwrap();
    let events: Vec<OrchEvent> = std::iter::from_fn(|| h.events.try_recv().ok()).collect();
    assert_eq!(events.first(), Some(&OrchEvent::PendingChanged), "first, before the wait and the proof");
    assert_eq!(events.iter().filter(|e| **e == OrchEvent::PendingChanged).count(), 2, "the `drive` mark is not repeated");
}

#[test]
fn resume_retries_alone_only_what_can_clear_up_by_itself() {
    let failed = |error| ResumeReport {
        failed: vec![SlotFailure { slot: key(SlotKind::Alias, 0).into(), error }],
        ..Default::default()
    };
    assert!(!ResumeReport::default().needs_retry());
    for error in
        [OrchError::ServiceUnavailable, OrchError::MidnightUnavailable, OrchError::Busy, OrchError::StillPending]
    {
        assert!(failed(error).needs_retry(), "{error:?}");
    }
    for error in [
        OrchError::AttemptsExhausted,
        OrchError::StaleState,
        OrchError::NeedsName,
        OrchError::WrongName,
        OrchError::SlotBurned,
        OrchError::NameTaken,
        OrchError::NameRejected { reason: NameProblem::Reserved },
        OrchError::BadConfig,
        OrchError::ContractMismatch,
        OrchError::SidecarTooOld,
        OrchError::Clock,
        OrchError::Internal,
        OrchError::Store,
        OrchError::CallRejected { reason: CallProblem::NotABono },
        OrchError::CallRejected { reason: CallProblem::SlotAlreadyUsed },
        OrchError::CallRejected { reason: CallProblem::AddressTaken },
        // Deterministic: the suffix comes from fixed keys and `slot_nul`.
        OrchError::AliasSuffixTaken,
    ] {
        assert!(!failed(error).needs_retry(), "{error:?}");
    }
    let bonos = |error| ResumeReport { bonos_error: Some(error), ..Default::default() };
    assert!(bonos(OrchError::Busy).needs_retry(), "with a payment in flight the leaves are checked later");
    assert!(!bonos(OrchError::StaleState).needs_retry());
    let mixed = ResumeReport {
        failed: vec![
            SlotFailure { slot: key(SlotKind::Alias, 0).into(), error: OrchError::AttemptsExhausted },
            SlotFailure { slot: key(SlotKind::Alias, 1).into(), error: OrchError::RateLimited { retry_after_s: 5 } },
        ],
        ..Default::default()
    };
    assert!(mixed.needs_retry(), "one retryable failure is enough");
}

/// A `resume` turn with the relayer not answering says in its report to wait for the relayer (the app loop reads this
/// to stop turning until it answers).
#[tokio::test]
async fn a_resume_turn_with_the_relayer_down_asks_to_wait_for_it() {
    let h = harness().await;
    free_bono(&h).await;
    // A half-done alias (a submitted proof the relayer refused).
    set(&h, |w| w.script_submit.push_back(Err(RelayError::NotRelayable)));
    assert_eq!(h.orch.create_alias().await, Err(OrchError::RelayerRefused));
    let proofs = h.calls("contract.proveCall");
    set(&h, |w| w.script_reachable.extend([false; 6]));
    let report = h.orch.resume().await.unwrap();
    assert_eq!(report.failed[0].error, OrchError::ServerUnreachable);
    assert_eq!(report.retry.server, ServerParts { relayer: true, issuer: false });
    assert_eq!(h.calls("contract.proveCall"), proofs, "without proving anything");
}

#[test]
fn the_report_says_which_part_of_our_server_did_not_serve() {
    let report = |failed: Vec<OrchError>, bonos_error| ResumeReport {
        failed: failed.into_iter().map(|error| SlotFailure { slot: key(SlotKind::Alias, 0).into(), error }).collect(),
        bonos_error,
        ..Default::default()
    };
    assert_eq!(report(vec![], None).server_down(), ServerParts::default());
    let relayer = ServerParts { relayer: true, issuer: false };
    assert_eq!(report(vec![OrchError::NameTaken, OrchError::ServerUnreachable], None).server_down(), relayer);
    assert_eq!(report(vec![OrchError::ServiceUnavailable], None).server_down(), relayer);
    let issuer = ServerParts { relayer: false, issuer: true };
    assert_eq!(report(vec![], Some(OrchError::ServiceUnavailable)).server_down(), issuer);
    let others = vec![OrchError::RateLimited { retry_after_s: 5 }, OrchError::MidnightUnavailable, OrchError::AttemptsExhausted];
    assert!(!report(others, Some(OrchError::Busy)).server_down().any(), "a 429 says when to come back, and the rest is not the server");
}

#[tokio::test]
async fn with_the_cap_reached_the_chain_is_checked_first() {
    let h = harness().await;
    free_bono(&h).await;
    // Lost tickets up to the last proof of the cap, which lands but the relayer reports `unknown`.
    set(&h, |w| {
        w.script_status.extend((1..MAX_PROOFS).map(|_| Err(RelayError::NotFound)));
        w.report_unknown = 1;
    });
    let alias = h.orch.create_alias().await.unwrap();
    assert_eq!(h.calls("contract.proveCall"), MAX_PROOFS as usize, "with the cap used up, the chain had the address");
    assert_eq!(h.store.get_address(&bytes32(&alias.addr_key).unwrap()).unwrap().unwrap().display, alias.display);
}

#[tokio::test]
async fn unknown_that_did_enter_is_found_without_a_new_proof() {
    let h = harness().await;
    set(&h, |w| {
        w.auto_time = true;
        w.report_unknown = 1;
    });
    free_bono(&h).await;
    let mailbox = h.orch.create_mailbox("sol").await.unwrap();
    assert_eq!(mailbox.name.as_deref(), Some("sol"));
    assert_eq!(h.calls("contract.proveCall"), 1, "the address was seen on chain: no second proof");
}

#[tokio::test]
async fn relayer_errors_count_only_a_received_proof() {
    let h = harness().await;
    free_bono(&h).await;
    set(&h, |w| w.script_submit.push_back(Err(RelayError::NotRelayable)));
    assert_eq!(h.orch.create_alias().await, Err(OrchError::RelayerRefused));
    assert_eq!(slot(&h, SlotKind::Alias, 0).unwrap().attempts, 1, "submitted: it counts and the slot is kept");
    set(&h, |w| w.script_submit.push_back(Err(RelayError::RateLimited { retry_after_s: 3600 })));
    assert_eq!(h.orch.create_alias().await, Err(OrchError::RateLimited { retry_after_s: 3600 }));
    // No new proof is sent until what the relayer asked for has passed.
    h.env.now.fetch_add(3600, std::sync::atomic::Ordering::SeqCst);
    set(&h, |w| w.script_submit.extend((0..6).map(|_| Ok(Submitted::Busy { retry_after_s: 1 }))));
    assert_eq!(h.orch.create_alias().await, Err(OrchError::ServiceUnavailable));
    assert_eq!(slot(&h, SlotKind::Alias, 0).unwrap().attempts, 1, "429 and 'busy': it did not receive it");
    set(&h, |w| w.script_status.push_back(Ok(TicketState::Done(RelayOutcome::Refused))));
    assert_eq!(h.orch.create_alias().await, Err(OrchError::RelayerRefused));
    assert_eq!(slot(&h, SlotKind::Alias, 0).unwrap().attempts, 2, "accepted (ticket): it counts");
    assert_eq!(h.orch.create_alias().await.unwrap().slot.j, 0);
}

/// A relayer 429 says when to come back; until then no proof (it is known to be rejected and would spend a slot
/// attempt), neither from a user operation nor from `resume`, and the report says how long to wait.
#[tokio::test]
async fn a_rate_limited_relayer_gets_no_proof_until_it_allows_one() {
    let h = harness().await;
    free_bono(&h).await;
    set(&h, |w| w.script_status.push_back(Err(RelayError::RateLimited { retry_after_s: 3600 })));
    assert_eq!(h.orch.create_alias().await, Err(OrchError::RateLimited { retry_after_s: 3600 }));
    let (proofs, attempts) = (h.calls("contract.proveCall"), slot(&h, SlotKind::Alias, 0).unwrap().attempts);
    h.env.now.fetch_add(600, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(h.orch.create_alias().await, Err(OrchError::RateLimited { retry_after_s: 3000 }));
    let report = h.orch.resume().await.unwrap();
    assert!(matches!(report.failed[..], [SlotFailure { error: OrchError::RateLimited { .. }, .. }]), "{report:?}");
    assert!(report.needs_retry());
    assert!((2990..=3000).contains(&report.retry.not_before_s), "{:?}", report.retry);
    assert_eq!(h.calls("contract.proveCall"), proofs, "not one more proof");
    assert_eq!(slot(&h, SlotKind::Alias, 0).unwrap().attempts, attempts, "not one more attempt");
    h.env.now.fetch_add(3000, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(h.orch.create_alias().await.unwrap().slot.j, 0, "after the deadline, it goes on");
}

#[test]
fn the_report_says_how_long_a_retry_is_pointless() {
    let now = 1_000;
    let failure = |j, error| SlotFailure { slot: key(SlotKind::Alias, j).into(), error };
    let report = ResumeReport {
        failed: vec![
            failure(0, OrchError::RateLimited { retry_after_s: 60 }),
            failure(1, OrchError::BonoNotReady { usable_at: Some(now + 500) }),
            failure(2, OrchError::BonoNotReady { usable_at: None }),
            failure(3, OrchError::ServiceUnavailable),
        ],
        ..Default::default()
    };
    assert_eq!(report.not_before_s(now), 500);
    assert_eq!(report.not_before_s(now + 600), 60, "an already usable bono delays nothing");
    assert_eq!(ResumeReport::default().not_before_s(now), 0);
}

/// Pending work without an error (journal purchase, leaf with a valid receipt) is looked at again, and the turn that
/// closes an expired purchase comes on time (and clears `wallet_in_flight`).
#[tokio::test]
async fn resume_keeps_looking_at_a_purchase_in_the_journal_until_it_closes() {
    let h = harness().await;
    set(&h, |w| w.script_buy.extend([RpcError::Timeout, RpcError::Timeout, RpcError::Timeout]));
    assert_eq!(h.orch.pay_shielded(PRICE).await, Err(OrchError::StillPending));
    assert!(h.orch.wallet_busy(), "a buyBono may still be in flight");
    assert_eq!(h.orch.payment_pending().await, Ok(true));
    let report = h.orch.resume().await.unwrap();
    assert!(report.failed.is_empty() && report.bonos_error.is_none(), "{report:?}");
    assert!(report.needs_retry(), "it can still get in: checked again");
    let due = report.retry.due_in_s.unwrap();
    assert!(due > resume::BUY_CLEANUP_S as u64 && due <= (resume::BUY_CLEANUP_S + 120) as u64, "{due}");
    h.env.now.fetch_add(due as i64, std::sync::atomic::Ordering::SeqCst);
    let report = h.orch.resume().await.unwrap();
    assert!(h.store.list_journal().unwrap().is_empty());
    assert!(!h.orch.wallet_busy(), "the round at its due time settles it: 'Lock' and exit no longer wait");
    assert!(!report.needs_retry() && report.retry.due_in_s.is_none());
    assert_eq!(h.orch.payment_pending().await, Ok(false));
}

/// With Midnight down (the leaf lookup fails) the turn still closes expired purchases: `wallet_in_flight` clears and
/// no expired entry is left in the journal.
#[tokio::test]
async fn resume_closes_expired_purchases_even_if_the_leaves_cannot_be_checked() {
    let h = harness().await;
    set(&h, |w| w.script_buy.extend([RpcError::Timeout, RpcError::Timeout, RpcError::Timeout]));
    assert_eq!(h.orch.pay_shielded(PRICE).await, Err(OrchError::StillPending));
    h.env.now.fetch_add(resume::BUY_CLEANUP_S + 1, std::sync::atomic::Ordering::SeqCst);
    set(&h, |w| w.script_find.extend((0..20).map(|_| RpcError::Timeout)));
    let report = h.orch.resume().await.unwrap();
    assert!(report.bonos_error.is_some(), "the leaf query failed: {report:?}");
    assert!(h.store.list_journal().unwrap().is_empty(), "the expired purchase is closed anyway");
    assert!(!h.orch.wallet_busy());
    assert_eq!(report.retry.due_in_s, None);
    assert_eq!(h.store.get_bono(0, 0).unwrap().unwrap().status, BonoStatus::Requested, "the leaf is not touched");
}

/// Abandoning with a `buyBono` that may still be in flight.
#[tokio::test]
async fn forgetting_a_purchase_left_in_flight_waits_for_its_window_and_frees_the_wallet() {
    let h = harness().await;
    set(&h, |w| w.script_buy.extend([RpcError::Timeout, RpcError::Timeout, RpcError::Timeout]));
    assert_eq!(h.orch.pay_shielded(PRICE).await, Err(OrchError::StillPending));
    assert!(h.orch.wallet_busy());
    assert_eq!(h.orch.forget_pending_bono(0, 0).await, Err(OrchError::StillPending), "it can still get in");
    assert!(h.orch.wallet_busy(), "still in flight: neither 'Lock' nor exit");
    h.env.now.fetch_add(resume::BUY_CLEANUP_S + 1, std::sync::atomic::Ordering::SeqCst);
    h.orch.forget_pending_bono(0, 0).await.unwrap();
    assert!(!h.orch.wallet_busy(), "with the journal closed, no buyBono is still in flight");
    assert!(h.store.get_bono(0, 0).unwrap().is_none());
}

#[tokio::test]
async fn resume_keeps_looking_at_a_leaf_with_a_receipt_in_its_window() {
    let h = harness().await;
    // An Issuer 429 leaves nothing that may resolve itself (leaf claimed, no receipt).
    set(&h, |w| w.script_issue.push_back(Err(IssuerError::RateLimited { retry_after_s: 9 })));
    assert_eq!(h.orch.request_free_plan().await, Err(OrchError::RateLimited { retry_after_s: 9 }));
    assert_eq!(h.orch.payment_pending().await, Ok(false));
    set(&h, |w| w.issue_delay = 100);
    assert_eq!(h.orch.pay_fiat().await, Err(OrchError::StillPending));
    assert_eq!(h.orch.payment_pending().await, Ok(true));
    let report = h.orch.resume().await.unwrap();
    assert!(report.failed.is_empty() && report.bonos_error.is_none(), "{report:?}");
    assert!(report.needs_retry(), "the Issuer committed to inserting it: checked again");
    assert_eq!(report.retry.due_in_s, None);
    h.env.now.fetch_add(3301, std::sync::atomic::Ordering::SeqCst);
    let report = h.orch.resume().await.unwrap();
    assert!(!report.needs_retry(), "past the deadline: the user can now abandon it");
}

#[tokio::test]
async fn a_queued_ticket_is_polled_until_the_cap() {
    let h = harness().await;
    free_bono(&h).await;
    set(&h, |w| w.script_status.extend((0..60).map(|_| Ok(TicketState::Queued))));
    assert_eq!(h.orch.create_alias().await, Err(OrchError::StillPending));
    assert_eq!(slot(&h, SlotKind::Alias, 0).unwrap().attempts, 1);
}

#[tokio::test]
async fn foreign_keys_at_our_nullifier_burn_the_slot() {
    let h = harness().await;
    free_bono(&h).await;
    let nul = h.orch.slot_nul(key(SlotKind::Alias, 0)).await.unwrap();
    set(&h, |w| {
        w.nullifiers.insert(nul.clone());
        w.addresses.push(foreign("44".repeat(32), AddressKind::Alias, nul));
    });
    assert_eq!(h.orch.create_alias().await, Err(OrchError::SlotBurned));
    assert_eq!(status(&h, SlotKind::Alias, 0), SlotStatus::Burned);
}

#[tokio::test]
async fn a_spent_nullifier_without_address_is_stale_state_not_burned() {
    let h = harness().await;
    free_bono(&h).await;
    set(&h, |w| w.script_prove.push_back(rejected("slot-already-used")));
    assert_eq!(h.orch.create_alias().await, Err(OrchError::StaleState));
    assert!(slot(&h, SlotKind::Alias, 0).is_none(), "nothing submitted: released, never burned");
    let nul = h.orch.slot_nul(key(SlotKind::Alias, 0)).await.unwrap();
    set(&h, |w| {
        w.nullifiers.insert(nul);
    });
    assert_eq!(h.orch.create_alias().await, Err(OrchError::StaleState));
    assert!(slot(&h, SlotKind::Alias, 0).is_none());
    assert_eq!(h.calls("contract.proveCall"), 1, "with the nullifier spent and nothing found, nothing is proved");
}

#[tokio::test]
async fn alias_suffix_taken() {
    let h = harness().await;
    free_bono(&h).await;
    let k = key(SlotKind::Alias, 0);
    let keys = h.orch.address_keys(k).unwrap();
    let nul = h.orch.slot_nul(k).await.unwrap();
    let mine = alias_key(&hex::encode(keys.enc_public), &hex::encode(keys.auth_public), &nul);
    let theirs = format!("{}{}", &mine[..12], "f".repeat(52));
    set(&h, |w| w.addresses.push(foreign(theirs, AddressKind::Alias, "55".repeat(32))));
    assert_eq!(h.orch.create_alias().await, Err(OrchError::AliasSuffixTaken));
    assert!(slot(&h, SlotKind::Alias, 0).is_none());
}

// --- Sidecar errors -----------------------------------------------------------------------------------------

#[tokio::test]
async fn sidecar_errors_policy() {
    let h = harness().await;
    free_bono(&h).await;
    set(&h, |w| w.script_prove.push_back(stale("future", -90_000)));
    assert_eq!(h.orch.create_alias().await, Err(OrchError::Clock));
    set(&h, |w| w.script_prove.extend([unavailable(), RpcError::Timeout, stale("old", 200_000)]));
    assert!(h.orch.create_alias().await.is_ok(), "transient failures: capped retry");
    set(&h, |w| w.script_prove.push_back(rejected("no-slots-left")));
    assert_eq!(h.orch.create_alias().await, Err(OrchError::CallRejected { reason: CallProblem::NoSlotsLeft }));
}

#[tokio::test]
async fn not_a_bono_counts_as_an_attempt() {
    let h = harness().await;
    free_bono(&h).await;
    set(&h, |w| w.script_prove.push_back(rejected("not-a-bono")));
    assert_eq!(h.orch.create_alias().await, Err(OrchError::CallRejected { reason: CallProblem::NotABono }));
    assert_eq!(slot(&h, SlotKind::Alias, 0).unwrap().attempts, 1);
}

#[tokio::test]
async fn contract_mismatch_is_neutral_and_saves_nothing() {
    let h = harness().await;
    free_bono(&h).await;
    set(&h, |w| w.script_prove.push_back(remote(codes::CONTRACT_MISMATCH, serde_json::Value::Null)));
    assert_eq!(h.orch.create_alias().await, Err(OrchError::ContractMismatch));
    assert!(slot(&h, SlotKind::Alias, 0).is_none(), "nothing proved or submitted: the slot is released");
    assert_eq!(h.calls("relay"), 0);
    assert!(h.orch.create_alias().await.is_ok(), "checked again on every attempt");
}

#[tokio::test]
async fn behind_has_a_per_operation_cap_and_a_durable_global_stop() {
    let h = harness().await;
    free_bono(&h).await;
    set(&h, |w| w.script_prove.extend((0..3).map(|_| stale("behind", 1_000))));
    assert_eq!(h.orch.create_alias().await, Err(OrchError::StaleState), "3 in a row in one operation");
    assert_eq!(h.store.get_chain_cursor().unwrap(), crate::store::ChainCursor { min_leaf_count: 1, behind_streak: 3 });
    set(&h, |w| w.script_prove.extend((0..3).map(|_| stale("behind", 1_000))));
    assert_eq!(h.orch.create_alias().await, Err(OrchError::StaleState), "syncs again first, but keeps its own cap");
    assert_eq!(h.store.get_chain_cursor().unwrap().behind_streak, 3, "the streak started again from 0");
    // Work nobody asked for stops at the global cap, without calling the sidecar.
    for _ in 0..3 {
        h.store.increment_behind_streak().unwrap();
    }
    let finds = h.calls("contract.findBonos");
    let leaf = ["00".repeat(32)];
    assert_eq!(h.orch.find_leaves(&leaf).await.err(), Some(OrchError::StaleState), "global streak at the cap: lasting");
    assert_eq!(h.orch.find_leaves(&leaf).await.err(), Some(OrchError::StaleState));
    assert_eq!(h.calls("contract.findBonos"), finds, "without calling the sidecar");
    // "Sync again" lifts it, and so does an address operation the user asks for, on its own.
    h.orch.retry_stale().await.unwrap();
    assert_ne!(h.orch.find_leaves(&leaf).await.err(), Some(OrchError::StaleState));
    for _ in 0..6 {
        h.store.increment_behind_streak().unwrap();
    }
    assert!(h.orch.create_alias().await.is_ok(), "creating syncs again on its own at the cap");
    assert_eq!(h.store.get_chain_cursor().unwrap().behind_streak, 0, "a success resets the streak to 0");
    assert_eq!(h.store.get_chain_cursor().unwrap().min_leaf_count, 1, "no ratchet reset");
    assert!(h.world.lock().unwrap().min_leaf_seen.iter().all(Option::is_some), "minLeafCount on every call");
}

/// The user never needs "Sync again" to create a mailbox or resume a paused alias: they sync again on their own.
#[tokio::test]
async fn address_operations_the_user_asks_for_sync_again_on_their_own() {
    let h = harness().await;
    set(&h, |w| w.auto_time = true);
    free_bono(&h).await;
    let at_cap = |h: &Harness| {
        for _ in 0..h.orch.d.config.retry.behind_halt {
            h.store.increment_behind_streak().unwrap();
        }
    };
    at_cap(&h);
    assert_eq!(h.orch.create_mailbox("ana").await.unwrap().name.as_deref(), Some("ana"));
    set(&h, |w| w.script_status.extend((0..MAX_PROOFS).map(|_| Ok(TicketState::Done(RelayOutcome::Rejected)))));
    assert_eq!(h.orch.create_alias().await, Err(OrchError::AttemptsExhausted));
    at_cap(&h);
    assert!(h.orch.resume_paused_slot(key(SlotKind::Alias, 0).into()).await.is_ok());
}

#[tokio::test]
async fn snapshot_expired_restarts_the_walk() {
    let h = harness().await;
    let expired = || remote(codes::SNAPSHOT_EXPIRED, serde_json::Value::Null);
    set(&h, |w| w.script_snapshot.push_back(expired()));
    assert!(h.orch.check_name("ana").await.unwrap().available);
    set(&h, |w| w.script_snapshot.extend((0..5).map(|_| expired())));
    assert_eq!(h.orch.check_name("ana").await, Err(OrchError::MidnightUnavailable));
}

// --- Pacing -----------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_bono_not_yet_usable_is_reported_not_awaited() {
    let mut cfg = config();
    cfg.pacing.usable_delay = (Duration::from_secs(60), Duration::from_secs(60));
    cfg.pacing.later_issuances = 1;
    let h = harness_on(world(), cfg).await;
    let bono = free_bono(&h).await;
    assert_eq!(h.orch.create_alias().await, Err(OrchError::BonoNotReady { usable_at: Some(bono.usable_at) }));
    assert!(!h.env.slept.lock().unwrap().contains(&Duration::from_secs(60)), "does not wait while holding the lock");
    h.env.now.fetch_add(60, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(h.orch.create_alias().await, Err(OrchError::BonoNotReady { usable_at: None }), "issuances missing");
    set(&h, |w| w.issue(&"ee".repeat(32), crate::protocol::Plan::Free));
    assert!(h.orch.create_alias().await.is_ok());
}

// --- Payment and reservation edge cases ---------------------------------------------------------------------

#[tokio::test]
async fn the_same_name_is_never_registered_twice() {
    let h = harness().await;
    h.orch.pay_fiat().await.unwrap();
    set(&h, |w| w.script_submit.push_back(Err(RelayError::NotRelayable)));
    assert_eq!(h.orch.create_mailbox("ana").await, Err(OrchError::RelayerRefused));
    h.orch.create_mailbox("ana").await.unwrap();
    assert!(slot(&h, SlotKind::Mailbox, 1).is_none(), "no other paid slot spent");
}

#[tokio::test]
async fn a_lost_card_reply_blocks_a_shielded_payment_of_the_same_leaf() {
    let h = harness().await;
    set(&h, |w| w.script_issue.push_back(Err(IssuerError::Unavailable)));
    assert_eq!(h.orch.pay_fiat().await, Err(OrchError::ServiceUnavailable));
    assert_eq!(h.orch.pay_shielded(PRICE).await, Err(OrchError::StillPending));
    assert_eq!(h.calls("wallet.open"), 0, "the wallet is not even opened");
    // Retrying by card repeats that request.
    let paid = h.orch.pay_fiat().await.unwrap();
    assert_eq!(paid.plan, crate::protocol::Plan::Paid);
}

#[tokio::test]
async fn bono_operations_do_not_overlap() {
    let h = harness().await;
    let (a, b) = tokio::join!(h.orch.pay_shielded(PRICE), h.orch.pay_fiat());
    assert!(matches!((a, b), (Ok(_), Err(OrchError::Busy)) | (Err(OrchError::Busy), Ok(_))));
}

#[tokio::test]
async fn the_journal_is_restamped_before_every_buy_call() {
    let h = harness().await;
    set(&h, |w| w.script_buy.extend([RpcError::Timeout, RpcError::Timeout, RpcError::Timeout]));
    assert_eq!(h.orch.pay_shielded(PRICE).await, Err(OrchError::StillPending));
    assert_eq!(h.store.list_journal().unwrap()[0].started_at, h.env.now(), "time of the last call");
    assert!(h.env.now() > START as i64);
    assert!(h.orch.wallet_busy(), "a buyBono may still be in flight");
    h.orch.shutdown().await;
    assert_eq!(h.calls("wallet.close"), 0, "does not close with a buyBono in flight");
}

#[tokio::test]
async fn shutdown_closes_an_idle_wallet() {
    let h = harness().await;
    assert!(!h.orch.wallet_busy());
    h.orch.shutdown().await;
    assert_eq!(h.calls("wallet.close"), 1);
}

#[tokio::test]
async fn forget_settles_a_leaf_already_in_the_tree() {
    let h = harness().await;
    set(&h, |w| w.issue_delay = 100);
    assert_eq!(h.orch.pay_fiat().await, Err(OrchError::StillPending));
    h.env.now.fetch_add(4000, std::sync::atomic::Ordering::SeqCst);
    let id = id_k(h.orch.bono_secret(0).expose(), 0);
    set(&h, |w| w.issue(&id, crate::protocol::Plan::Paid));
    h.orch.forget_pending_bono(0, 0).await.unwrap();
    assert_eq!(h.store.get_bono(0, 0).unwrap().unwrap().status, BonoStatus::Included, "it got in: not abandoned");
}

#[tokio::test]
async fn behind_while_polling_counts_and_a_find_success_does_not_reset_it() {
    let h = harness().await;
    set(&h, |w| w.script_find.extend([stale("behind", 1_000), stale("behind", 1_000)]));
    free_bono(&h).await;
    assert_eq!(h.store.get_chain_cursor().unwrap().behind_streak, 2);
    // Creating syncs again first (streak 0); the `behind` during the operation raises it to 1 and the included proof
    // brings it back to 0.
    set(&h, |w| w.script_prove.push_back(stale("behind", 1_000)));
    h.orch.create_alias().await.unwrap();
    assert_eq!(h.store.get_chain_cursor().unwrap().behind_streak, 0, "one of our own proofs included");
    set(&h, |w| w.script_find.push_back(stale("behind", 1_000)));
    let id = id_k(h.orch.bono_secret(1).expose(), 0);
    set(&h, |w| w.issue(&id, crate::protocol::Plan::Free));
    h.store.claim_bono_leaf(&requested(1, &id), "method/1/0", b"free").unwrap();
    h.orch.resume().await.unwrap();
    assert_eq!(h.store.get_chain_cursor().unwrap().behind_streak, 1);
    h.env.now.fetch_add(25 * 3600, std::sync::atomic::Ordering::SeqCst);
    // Not an address operation (those sync again on their own): only the 24 h rule can reset it here.
    let _ = h.orch.find_leaves(&["00".repeat(32)]).await;
    assert_eq!(h.store.get_chain_cursor().unwrap().behind_streak, 0, "24 h without behind");
}

fn requested(n: u32, id: &str) -> crate::store::BonoLeaf {
    crate::store::BonoLeaf {
        n,
        k: 0,
        plan: Plan::Free,
        id: bytes32(id).unwrap(),
        status: BonoStatus::Requested,
        position: None,
        requested_at: 0,
        usable_at: None,
    }
}

#[tokio::test]
async fn a_failed_free_plan_can_be_asked_again() {
    let h = harness().await;
    set(&h, |w| w.issue_delay = 1);
    let mut failed = pending_reply(&id_k(h.orch.bono_secret(0).expose(), 0));
    failed.state = ports::IssueState::Failed;
    set(&h, |w| w.script_issue_status.push_back(Ok(failed)));
    assert_eq!(h.orch.request_free_plan().await, Err(OrchError::IssueFailed));
    set(&h, |w| w.issue_delay = 0);
    assert!(h.orch.request_free_plan().await.is_ok());
    assert_eq!(h.calls("issuer.request"), 2, "requested again");
}

#[tokio::test]
async fn abandoning_a_reserving_slot_needs_an_expired_ttl_and_nothing_on_chain() {
    let h = harness().await;
    free_bono(&h).await;
    set(&h, |w| w.script_submit.push_back(Err(RelayError::NotRelayable)));
    assert_eq!(h.orch.create_alias().await, Err(OrchError::RelayerRefused));
    let id = key(SlotKind::Alias, 0).into();
    assert_eq!(h.orch.abandon_slot(id).await, Err(OrchError::StillPending), "its proof could still get in");
    h.env.now.fetch_add(66 * 60, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(h.orch.stuck.lock().unwrap().len(), 1, "stopped by the rejection");
    h.orch.abandon_slot(id).await.unwrap();
    assert!(slot(&h, SlotKind::Alias, 0).is_none());
    assert!(h.orch.stuck.lock().unwrap().is_empty(), "abandoning it removes it from the stopped ones");
    assert_eq!(h.orch.abandon_slot(id).await, Err(OrchError::Internal), "no longer exists");
}

#[tokio::test]
async fn provide_name_on_registered_and_alias_slots() {
    let h = harness().await;
    set(&h, |w| w.auto_time = true);
    free_bono(&h).await;
    h.orch.create_mailbox("ana").await.unwrap();
    h.orch.create_alias().await.unwrap();
    let id = key(SlotKind::Mailbox, 0).into();
    assert_eq!(h.orch.provide_name(id, "Ana").await.unwrap().name.as_deref(), Some("ana"), "the same one: harmless");
    assert_eq!(h.orch.provide_name(id, "otro").await, Err(OrchError::WrongName));
    assert_eq!(h.orch.provide_name(key(SlotKind::Alias, 0).into(), "x").await, Err(OrchError::Internal));
}

#[tokio::test]
async fn a_waiting_address_operation_says_queued() {
    let mut h = harness().await;
    free_bono(&h).await;
    let (a, b) = tokio::join!(tracked(1, h.orch.create_alias()), tracked(2, h.orch.create_alias()));
    assert!(a.is_ok() && b.is_ok());
    let events: Vec<ProgressEvent> = h.progress_events();
    assert!(events.iter().any(|e| e.progress == Progress::Queued));
    assert!(events.iter().any(|e| e.op == 1) && events.iter().any(|e| e.op == 2));
}

#[test]
fn the_free_quota_is_used_while_the_paid_leaf_is_not_usable() {
    use crate::store::BonoLeaf;
    let leaf = |k, plan, usable_at| BonoLeaf {
        n: 0,
        k,
        plan,
        id: [0; 32],
        status: BonoStatus::Included,
        position: Some(k),
        requested_at: 0,
        usable_at: Some(usable_at),
    };
    let bonos = [leaf(0, Plan::Free, 0), leaf(1, Plan::Paid, 100)];
    let at = |j, now| addresses::spend_now(&bonos, key(SlotKind::Alias, j), now);
    assert_eq!(at(0, 50).unwrap().plan, Plan::Free);
    assert_eq!(at(5, 50), Err(OrchError::BonoNotReady { usable_at: Some(100) }));
    assert_eq!(at(5, 100).unwrap().plan, Plan::Paid);
    assert_eq!(addresses::spend_now(&bonos[..1], key(SlotKind::Alias, 5), 50), Err(OrchError::NoFreeSlot));
    assert_eq!(addresses::spend_now(&[], key(SlotKind::Alias, 0), 50), Err(OrchError::Internal));
}

// --- Abandoning requested leaves ----------------------------------------------------------------------------

#[tokio::test]
async fn forget_after_a_lost_issuer_reply_asks_the_issuer_first() {
    let h = harness().await;
    set(&h, |w| w.script_issue.push_back(Err(IssuerError::Unavailable)));
    assert_eq!(h.orch.pay_fiat().await, Err(OrchError::ServiceUnavailable));
    // The Issuer did register it (charged): its receipt is valid and within its deadline.
    let id = id_k(h.orch.bono_secret(0).expose(), 0);
    let charged = {
        let w = h.world.lock().unwrap();
        // A request from before Night Plus dropped the period: its `monthly` receipt is still valid.
        FakeIssuer::reply(&w, &id, crate::protocol::Plan::Paid, "monthly", ports::IssueState::Pending)
    };
    set(&h, |w| w.script_issue_status.push_back(Ok(charged)));
    assert_eq!(h.orch.forget_pending_bono(0, 0).await, Err(OrchError::StillPending));
    assert!(h.store.get_meta("receipt/0/0").unwrap().is_some_and(|r| !r.is_empty()), "the receipt is stored");
    // No answer from the Issuer: not allowed either.
    let h2 = harness().await;
    set(&h2, |w| {
        w.script_issue.push_back(Err(IssuerError::Unavailable));
        w.script_issue_status.push_back(Err(IssuerError::Unavailable));
    });
    assert_eq!(h2.orch.pay_fiat().await, Err(OrchError::ServiceUnavailable));
    assert_eq!(h2.orch.forget_pending_bono(0, 0).await, Err(OrchError::StillPending));
    // The Issuer does not know it (404): it can be abandoned.
    h2.orch.forget_pending_bono(0, 0).await.unwrap();
    assert!(h2.store.get_bono(0, 0).unwrap().is_none());
}

#[tokio::test]
async fn a_closed_channel_does_not_leave_a_buy_in_flight() {
    let h = harness().await;
    set(&h, |w| w.script_buy.extend([RpcError::Closed, RpcError::Closed, RpcError::Closed]));
    assert_eq!(h.orch.pay_shielded(PRICE).await, Err(OrchError::StillPending));
    assert!(!h.orch.wallet_busy());
    assert_eq!(h.calls("wallet.close"), 1);
}
