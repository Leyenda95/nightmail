//! End to end on the devnet: the app layer with the real sidecar, Issuer, relayer and mail server.
//!
//! create seed → free plan → mailbox (two steps) + 2 aliases → the demo sends mail → MailSync downloads it → the list
//! shows it; restore the phrase on a clean profile → `recover` → same mailbox with its name, the aliases and the mail.
//!
//! Needs the devnet, the payer and the server running with `NIGHTMAIL_NETWORK=undeployed` (like
//! `apps/server/test-e2e/flow.e2e.ts`), `node` on the PATH (nvm) and `NIGHTMAIL_ISSUER_RECEIPT_KEY=sha256:…` (printed
//! by the server). Run: `cargo test app::e2e -- --ignored --nocapture`.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::tests::private_tempdir;
use super::*;
use zeroize::Zeroizing;
use crate::protocol::{AddressKind, InitializeParams};
use crate::supervisor::SidecarConfig;
use crate::transport::TransportConfig;

pub(super) const PASSWORD: &str = "contraseña de la demo";
/// Deadline for mail to reach each profile.
const MAIL_WAIT: Duration = Duration::from_secs(180);

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

pub(super) fn real_app(profile: &std::path::Path) -> App {
    let deployment = std::fs::read_to_string(repo().join(".data/operator/undeployed/contracts.json")).ok();
    let config =
        AppConfig::devnet(profile.to_path_buf(), |name| std::env::var(name).ok(), deployment.as_deref()).expect("config");
    let sidecar = Arc::new(SidecarSupervisor::new(Ok(SidecarConfig::dev()), InitializeParams::devnet(true)));
    let transport = Arc::new(Transport::direct(&TransportConfig::default()).unwrap());
    let sink: EventSink = Arc::new(|event| {
        if let AppEvent::Progress { event } = &event {
            eprintln!("  · op {} {:?}", event.op, event.progress);
        } else {
            eprintln!("  · {event:?}");
        }
    });
    App::new(config, sidecar, transport, sink)
}

/// A new name on every run (the devnet chain keeps earlier ones): letters and digits, not alias-shaped.
pub(super) fn fresh_name() -> String {
    let mut bytes = [0u8; 4];
    getrandom::fill(&mut bytes).unwrap();
    format!("juan{}", hex::encode(bytes))
}

/// Sends with `tools/demo-mailer` (the server's SMTP, 127.0.0.1:2525).
fn send_demo_mail(targets: &[String]) {
    let mut cmd = std::process::Command::new("node");
    cmd.current_dir(repo()).arg("tools/demo-mailer/src/cli.ts").args(["--name", "Juan"]);
    for t in targets {
        cmd.args(["--to", t]);
    }
    let out = cmd.output().expect("node");
    eprintln!("{}", String::from_utf8_lossy(&out.stdout));
    assert!(out.status.success(), "demo-mailer: {}", String::from_utf8_lossy(&out.stderr));
}

/// Waits until the list has at least `count` messages (requesting MailSync rounds).
async fn wait_for_mail(session: &Session, count: usize) -> Vec<MessageView> {
    let start = Instant::now();
    loop {
        session.sync_now();
        let list = session.messages(MessageQuery::default()).await.unwrap();
        if list.len() >= count {
            return list;
        }
        assert!(start.elapsed() < MAIL_WAIT, "only {} of {count} messages", list.len());
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

/// Repeats `op` while the bono is not usable yet (`BonoNotReady` with `usable_at`): the orchestrator does not wait,
/// so the caller does, as the UI will.
pub(super) async fn when_usable<T, F, Fut>(mut op: F) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    for _ in 0..5 {
        match op().await {
            Err(AppError::Orch(OrchError::BonoNotReady { usable_at: Some(at) })) => {
                let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
                tokio::time::sleep(Duration::from_secs((at - now).clamp(0, 600) as u64 + 1)).await;
            }
            other => return other,
        }
    }
    op().await
}

fn sorted_subjects(list: &[MessageView]) -> Vec<String> {
    let mut subjects: Vec<String> = list.iter().map(|m| m.subject.clone().unwrap_or_default()).collect();
    subjects.sort();
    subjects
}

fn by_slot(mut list: Vec<AddressView>) -> Vec<(u32, AddressKind, u32, String, Option<String>)> {
    list.sort_by_key(|a| (a.slot.n, a.slot.kind == AddressKind::Alias, a.slot.j));
    list.into_iter().map(|a| (a.slot.n, a.slot.kind, a.slot.j, a.display, a.name)).collect()
}

/// Sends 5,000 NIGHT to the payment wallet with `npm run fund-night` (it uses the operator wallet, so the payer must
/// be stopped).
fn fund_night(address: &str) {
    let out = std::process::Command::new("npm")
        .current_dir(repo())
        .env("NIGHTMAIL_NETWORK", "undeployed")
        .args(["run", "--silent", "fund-night", "-w", "apps/server", "--", address])
        .output()
        .expect("npm");
    eprintln!("{}", String::from_utf8_lossy(&out.stdout));
    assert!(out.status.success(), "fund-night: {}", String::from_utf8_lossy(&out.stderr));
}

/// Repeats `wallet` until `ready` (the balance takes a few seconds to show after a transaction).
async fn wallet_until(session: &Session, ready: impl Fn(&WalletView) -> bool) -> WalletView {
    let start = Instant::now();
    loop {
        let wallet = session.wallet(0).await.expect("wallet");
        if ready(&wallet) {
            return wallet;
        }
        assert!(start.elapsed() < Duration::from_secs(300), "the wallet never reaches the expected state: {wallet:?}");
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

/// The whole shielded payment through the UI commands: view the wallet → receive NIGHT → faucet → price → pay → paid
/// plan (5 + 20). Needs the devnet and the payer stopped (`fund-night` uses the operator wallet); neither the Issuer
/// nor the relayer is involved. Run: `cargo test app::e2e::shielded -- --ignored --nocapture`.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the devnet with the payer stopped (see the comment)"]
async fn shielded_payment_on_devnet() {
    let started = Instant::now();
    let profile = private_tempdir();
    let app = real_app(profile.path());
    app.create_seed_now(Secret(Zeroizing::new(PASSWORD.into()))).await.unwrap();
    let session = app.session().await.unwrap();

    let wallet = session.wallet(1).await.expect("wallet");
    assert!(wallet.faucet, "the devnet contracts.json includes the TestToken");
    assert_eq!((wallet.night.as_str(), wallet.token.as_str(), wallet.dust_ready), ("0", "0", false));
    let address = wallet.unshielded_address.expect("address");
    assert!(address.starts_with("mn_addr_undeployed1"), "{address}");
    fund_night(&address);
    wallet_until(&session, |w| w.night != "0").await;
    eprintln!("NIGHT received ({:?})", started.elapsed());

    let price = session.price().await.expect("price");
    session.faucet(2).await.expect("faucet");
    let wallet = wallet_until(&session, |w| w.token == price).await;
    assert!(wallet.dust_ready);
    eprintln!("TestToken {} from the faucet ({:?})", wallet.token, started.elapsed());

    let bono = session.pay_shielded(price, 3).await.expect("shielded payment");
    assert!(bono.plan == crate::protocol::Plan::Paid);
    let plan = session.plan().await.unwrap();
    assert_eq!((plan.mailboxes.limit, plan.aliases.limit), (5, 20), "{plan:?}");
    assert!(plan.bonos.iter().any(|b| b.paid && b.included));
    let wallet = session.wallet(4).await.unwrap();
    assert_eq!(wallet.token, "0", "paid exactly the price");
    eprintln!("paid plan ({:?})", started.elapsed());
    app.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the devnet, the payer and the server (see the header)"]
async fn create_receive_and_restore_on_devnet() {
    let started = Instant::now();
    let first = private_tempdir();
    let app = real_app(first.path());

    // 1. Seed, free plan, mailbox and two aliases.
    let phrase = app.create_seed_now(Secret(Zeroizing::new(PASSWORD.into()))).await.unwrap();
    let session = app.session().await.unwrap();
    let bono = session.free_plan(1).await.expect("free plan");
    eprintln!("bono {} ready ({:?})", bono.n, started.elapsed());
    let name = fresh_name();
    assert!(session.check_name(name.clone()).await.unwrap().available);
    let mailbox = when_usable(|| session.create_mailbox(name.clone(), 2)).await.expect("mailbox");
    assert_eq!(mailbox.name.as_deref(), Some(name.as_str()));
    assert!(mailbox.display.starts_with(&format!("{name}@")));
    let alias1 = session.create_alias(3).await.expect("alias 1");
    let alias2 = session.create_alias(4).await.expect("alias 2");
    let plan = session.plan().await.unwrap();
    assert_eq!((plan.mailboxes, plan.aliases), (Quota { used: 1, limit: 1 }, Quota { used: 2, limit: 2 }));
    assert_eq!(session.create_alias(5).await.unwrap_err(), AppError::Orch(OrchError::NoFreeSlot));
    eprintln!("addresses ready ({:?})", started.elapsed());

    // 2. The demo sends; the list shows it (and it can be opened).
    send_demo_mail(&[
        format!("{}=personal", mailbox.display),
        format!("{}=attachment", alias1.display),
        format!("{}=invoice", alias2.display),
    ]);
    let list = wait_for_mail(&session, 3).await;
    for m in &list {
        let detail = session.message(m.id).await.unwrap();
        assert!(!detail.unreadable && detail.summary.subject.is_some() && detail.summary.from.is_some());
    }
    let subjects = sorted_subjects(&list);
    let addresses = by_slot(session.addresses().await.unwrap());
    eprintln!("mail received: {subjects:?} ({:?})", started.elapsed());
    app.shutdown().await;

    // 3. Restore on a clean profile: everything comes back.
    let clean = private_tempdir();
    let restored = real_app(clean.path());
    let phrase = Secret(Zeroizing::new(phrase.phrase.clone()));
    restored.restore_seed(phrase, Secret(Zeroizing::new("otra".into()))).await.expect("restore");
    let report = restored.recover(9).await.expect("recover");
    assert_eq!((report.bonos, report.addresses, report.burned, report.conflicts), (1, 3, 0, 0), "{report:?}");
    assert!(report.needs_name.is_empty());
    let session = restored.session().await.unwrap();
    assert_eq!(by_slot(session.addresses().await.unwrap()), addresses);
    let list = wait_for_mail(&session, 3).await;
    assert_eq!(sorted_subjects(&list), subjects);
    eprintln!("restored ({:?})", started.elapsed());
    restored.shutdown().await;
}
