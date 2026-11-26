//! Orchestrator: bono flows (free plan, simulated payment, shielded payment) and address flows (two-step mailbox,
//! alias), with their retries, through the sidecar, the relayer and the Issuer.
//!
//! - Everything external goes through the [`ports`] traits; the real implementations are [`sidecar::SidecarChain`],
//!   [`http::HttpIssuer`] and [`http::HttpRelayer`].
//! - Each step records its state in the `LocalStore` before calling out, so [`Orchestrator::resume`] can pick it up
//!   after the app closes.
//! - Progress goes out on a channel ([`Progress`]); errors are [`OrchError`] (fixed codes, no sidecar data: never
//!   `ageMs`, `id` or secrets).
//! - `Recovery` (restoring from the seed on a clean profile) lives in `crate::recovery`, on the same type.
//! - Looking NightMail addresses up in the registry (the recipient and the sender of a mail) is in [`directory`].

mod actions;
pub(crate) mod addresses;
pub(crate) mod bonos;
pub(crate) mod chain;
mod directory;
mod dust;
pub mod http;
pub mod ports;
mod prove;
mod resume;
mod settle;
pub mod sidecar;
mod types;
mod wallet;

#[cfg(test)]
pub(crate) mod fakes;
#[cfg(test)]
mod tests;

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;

use crate::keys::KeyManager;
use crate::protocol::{self, InitializeResult, SecretHex};
use crate::store::LocalStore;
use ports::Env;

#[allow(unused_imports)]
pub use addresses::NameCheck;
#[allow(unused_imports)]
pub use addresses::sync_target;
#[allow(unused_imports)]
pub use bonos::BonoInfo;
pub use dust::{DustClaim, DustSetup};
pub(crate) use bonos::NO_EXPIRY;
#[allow(unused_imports)]
pub use resume::{PendingSlot, PendingStage, ResumeReport, RetryHint, ServerParts, SlotFailure};
#[allow(unused_imports)]
pub use types::{AddressView, OrchError, OrchEvent, Progress, ProgressEvent, SlotId, tracked};
pub use wallet::WalletSnapshot;

/// Sidecar methods the orchestrator needs.
const REQUIRED_METHODS: &[&str] = &[
    "contract.hashes",
    "contract.snapshot",
    "contract.findBonos",
    "contract.proveCall",
    "wallet.open",
    "wallet.close",
    "wallet.sync",
    "wallet.registerDust",
    "wallet.faucet",
    "wallet.buyBono",
];

/// Proof cap per slot and operation (reserve or reveal) before the slot is paused. Counts every distinct proof the
/// relayer receives (ticket, `bad-ttl` or rejection) plus `not-a-bono` rejections; it is not reset between turns, only
/// when the slot is resumed. Rejections cost no fee. After a node rejection `drive` makes the next proof right away
/// (after one block). The relayer allows 3 rejections per client per hour (`faultsPerIpPerHour`); beyond that it
/// answers 429 and the app waits as asked without proving anything.
pub const MAX_PROOFS: u32 = 10;

/// Retry caps (provisional defaults).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    /// Proofs received by the relayer (plus `not-a-bono` rejections) per slot and operation ([`MAX_PROOFS`]). When
    /// exhausted the slot is paused: it keeps its state and the user can resume it (`resume_paused_slot`).
    pub max_proofs: u32,
    /// Consecutive `behind` within one operation.
    pub max_behind: u32,
    /// Global `behind` streak (persisted; only a success resets it) at which everything using the ratchet stops
    /// (`StaleState`) until the user retries (`retry_stale`) or starts an address operation, which syncs again on its
    /// own (`sync_for_user_address_op`).
    pub behind_halt: u32,
    /// Consecutive transient failures (sidecar down, indexer or proof server not answering, `old` state).
    pub max_transient: u32,
    pub transient_wait: Duration,
    /// Consecutive `busy` answers from the relayer or Issuer, and the maximum wait for each.
    pub max_busy: u32,
    pub max_busy_wait: Duration,
    /// `wallet.buyBono` calls with the same `id` before leaving it "pending".
    pub max_buy_calls: u32,
    /// Waits for DUST to cover the fee (`INSUFFICIENT_FUNDS dust`, a safe rejection: nothing was sent) in a payment or
    /// faucet call, and the length of each. Freshly registered NIGHT takes ~1 min on the devnet.
    pub dust_waits: u32,
    pub dust_wait: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_proofs: MAX_PROOFS,
            max_behind: 2,
            behind_halt: 6,
            max_transient: 3,
            transient_wait: Duration::from_secs(3),
            max_busy: 5,
            max_busy_wait: Duration::from_secs(300),
            max_buy_calls: 3,
            dust_waits: 18,
            dust_wait: Duration::from_secs(10),
        }
    }
}

/// Pacing (production values still to be decided).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Pacing {
    /// Random wait between a bono's inclusion and its first use, in `[min, max]`.
    pub usable_delay: (Duration, Duration),
    /// Insertions after the leaf the tree must have before the leaf is spent.
    pub later_issuances: u32,
    /// Random delay before each address operation.
    pub op_delay: (Duration, Duration),
    /// Polling interval (ticket, round, issuance, block) and maximum polls per wait.
    pub poll: Duration,
    pub max_polls: u32,
}

impl Pacing {
    /// Devnet: hardly anyone else issues bonos, so N = 0 and short waits.
    pub fn devnet() -> Self {
        Self {
            usable_delay: (Duration::ZERO, Duration::from_secs(5)),
            later_issuances: 0,
            op_delay: (Duration::ZERO, Duration::from_secs(5)),
            poll: Duration::from_secs(2),
            max_polls: 150,
        }
    }

    /// Provisional values for a public network.
    pub fn public_network() -> Self {
        Self {
            usable_delay: (Duration::from_secs(10 * 60), Duration::from_secs(2 * 3600)),
            later_issuances: 3,
            op_delay: (Duration::from_secs(30), Duration::from_secs(10 * 60)),
            poll: Duration::from_secs(5),
            max_polls: 360,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrchestratorConfig {
    /// Network (`undeployed` | `preprod`); recorded in the purchase journal.
    pub network: String,
    /// Registry address (32-byte hex, lowercase).
    pub contract_address: String,
    /// Mail domain (`nightmail.local`).
    pub mail_domain: String,
    /// Simulated CAPTCHA and card.
    pub captcha_token: String,
    pub card_token: String,
    /// SHA-256 fingerprint of the Issuer's receipt public key (published out of band).
    pub issuer_key: [u8; 32],
    /// Absolute path of the wallet state directory (0700, one per network and profile).
    pub wallet_state_dir: String,
    pub retry: RetryPolicy,
    pub pacing: Pacing,
}

pub type Result<T> = std::result::Result<T, OrchError>;

/// What the orchestrator needs.
pub struct Deps<C, I, R> {
    pub chain: C,
    pub issuer: I,
    pub relayer: R,
    pub env: Arc<dyn Env>,
    pub store: Arc<LocalStore>,
    pub keys: Arc<KeyManager>,
    pub config: OrchestratorConfig,
    pub events: Option<mpsc::UnboundedSender<OrchEvent>>,
}

pub struct Orchestrator<C, I, R> {
    pub(crate) d: Deps<C, I, R>,
    /// One address operation at a time (create_*, provide_name, resume, recover): no bursts, and no two operations
    /// picking the same slot.
    pub(crate) ops: tokio::sync::Mutex<()>,
    /// Alias text already computed per `addrKey` (for the free-suffix check and the [`directory`]).
    pub(crate) alias_texts: std::sync::Mutex<std::collections::HashMap<String, String>>,
    /// The last registry read for looking addresses up ([`directory`]); its lock makes those reads one at a time.
    pub(crate) directory: tokio::sync::Mutex<Option<directory::CachedRegistry>>,
    /// One bono operation at a time (free plan, payments, abandon, faucet, shutdown): `try_lock` → `Busy`.
    pub(crate) bono_ops: tokio::sync::Mutex<()>,
    /// A `wallet.buyBono` may still be running in the sidecar (deadline or closed channel): do not close the wallet.
    pub(crate) wallet_in_flight: std::sync::atomic::AtomicBool,
    /// The sidecar wallet, shared between the foreground and the background DUST registration (`dust`).
    pub(crate) wallet_share: dust::WalletShare,
    /// Unshielded wallet address, saved when opening it (`wallet.open` does not return it if already open).
    pub(crate) wallet_address: std::sync::Mutex<Option<String>>,
    /// Unix time before which the relayer asked us not to come back (429): until then nothing is proved or sent, so
    /// no slot attempt is spent. In memory only.
    pub(crate) relay_not_before: std::sync::atomic::AtomicI64,
    /// The slot [`Orchestrator::drive`] is working on right now (one at a time, under `ops`): `pending_slots` marks it
    /// as running so the UI does not offer to retry or abandon it meanwhile. In memory only.
    pub(crate) driving: std::sync::Mutex<Option<crate::store::SlotKey>>,
    /// Slots whose last `drive` failed with something that does not clear by itself (`may_clear_by_itself`), with
    /// that error: they are stopped. The background retry (`resume_background`) leaves them alone; they are only
    /// driven again on user request ("Retry", "Resume") or at unlock. In memory only: after a restart, the unlock
    /// `resume` tries them again and repopulates it.
    pub(crate) stuck: std::sync::Mutex<Vec<(crate::store::SlotKey, OrchError)>>,
}

/// Is this sidecar usable? Minor ≥ 4 and every required method.
fn check_handshake(init: &InitializeResult) -> Result<()> {
    let has_all = REQUIRED_METHODS.iter().all(|m| init.methods.iter().any(|x| x == m));
    if protocol::compatible(&init.protocol_version, protocol::PROTOCOL_VERSION) && has_all {
        Ok(())
    } else {
        Err(OrchError::SidecarTooOld)
    }
}

impl<C: ports::Chain, I: ports::Issuer, R: ports::Relayer> Orchestrator<C, I, R> {
    /// Checks the sidecar (version and methods) and returns the orchestrator.
    pub async fn start(deps: Deps<C, I, R>) -> Result<Self> {
        let init = deps.chain.handshake().await.map_err(|_| OrchError::MidnightUnavailable)?;
        check_handshake(&init)?;
        if !std::path::Path::new(&deps.config.wallet_state_dir).is_absolute() {
            return Err(OrchError::BadConfig);
        }
        Ok(Self {
            d: deps,
            ops: tokio::sync::Mutex::new(()),
            alias_texts: Default::default(),
            directory: Default::default(),
            bono_ops: tokio::sync::Mutex::new(()),
            wallet_in_flight: Default::default(),
            wallet_share: Default::default(),
            wallet_address: Default::default(),
            relay_not_before: Default::default(),
            driving: Default::default(),
            stuck: Default::default(),
        })
    }
}

impl<C, I, R> Orchestrator<C, I, R> {
    pub(crate) fn emit(&self, progress: Progress) {
        if let Some(tx) = &self.d.events {
            let _ = tx.send(OrchEvent::Progress(ProgressEvent { op: types::current_op(), progress }));
        }
    }

    pub(crate) fn now(&self) -> i64 {
        self.d.env.now()
    }

    pub(crate) async fn sleep(&self, duration: Duration) {
        self.d.env.sleep(duration).await;
    }

    /// Uniform duration in `[min, max]`.
    pub(crate) fn random_between(&self, (min, max): (Duration, Duration)) -> Duration {
        let span = max.saturating_sub(min).as_millis() as u64;
        min + Duration::from_millis(self.d.env.random_below(span + 1))
    }

    /// Random delay before an operation, so operations do not come in recognisable bursts.
    pub(crate) async fn pace(&self) {
        self.sleep(self.random_between(self.d.config.pacing.op_delay)).await;
    }

    /// Runs `f` on the store on a blocking thread.
    pub(crate) async fn db<T, F>(&self, f: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&LocalStore) -> crate::store::Result<T> + Send + 'static,
    {
        Ok(self.d.store.with(f).await?)
    }

    /// `s` of bono n, in hex, for the sidecar.
    pub(crate) fn bono_secret(&self, n: u32) -> SecretHex {
        SecretHex::from_bytes(&self.d.keys.bono_secret(n))
    }

    pub(crate) fn contract(&self) -> String {
        self.d.config.contract_address.clone()
    }
}

/// 32-byte hex from the sidecar → bytes (a malformed response is an internal error).
pub(crate) fn bytes32(text: &str) -> Result<[u8; 32]> {
    let mut out = [0u8; 32];
    hex::decode_to_slice(text, &mut out).map_err(|_| OrchError::Internal)?;
    Ok(out)
}

/// Contract quota (`slotLimit`): free 1 mailbox + 2 aliases; paid 5 + 20.
pub(crate) fn slot_limit(plan: crate::store::Plan, kind: crate::store::SlotKind) -> u32 {
    use crate::store::{Plan, SlotKind};
    match (plan, kind) {
        (Plan::Free, SlotKind::Mailbox) => 1,
        (Plan::Free, SlotKind::Alias) => 2,
        (Plan::Paid, SlotKind::Mailbox) => 5,
        (Plan::Paid, SlotKind::Alias) => 20,
    }
}

pub(crate) fn to_protocol_plan(plan: crate::store::Plan) -> protocol::Plan {
    if plan == crate::store::Plan::Paid { protocol::Plan::Paid } else { protocol::Plan::Free }
}

pub(crate) fn to_protocol_kind(kind: crate::store::SlotKind) -> protocol::AddressKind {
    match kind {
        crate::store::SlotKind::Mailbox => protocol::AddressKind::Mailbox,
        crate::store::SlotKind::Alias => protocol::AddressKind::Alias,
    }
}
