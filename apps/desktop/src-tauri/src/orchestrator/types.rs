//! Types the UI sees: errors, progress with its operation id, and views without internal data. ts-rs generates them
//! into `apps/desktop/src/bindings/` when `cargo test` runs.

use std::future::Future;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::protocol::{AddressKind, CallProblem, FundsAsset, NameProblem, WalletProblem};
use crate::store::{Address, SlotKey, SlotKind, StoreError};

/// Errors for the UI: fixed codes, no library text or sidecar data.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "code", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub enum OrchError {
    /// The sidecar does not start or answer, or the indexer/proof server still do not answer after retrying.
    MidnightUnavailable,
    /// Sidecar protocol minor < 1.5, or missing the `wallet.*` methods.
    SidecarTooOld,
    /// The app and the deployed contract do not match (neutral wording: "check for an update").
    ContractMismatch,
    /// The block is ahead of the system clock: check the time.
    Clock,
    /// The indexer is behind what was already seen or contradicts the contract. With the `behind` streak at its cap
    /// it persists until `retry_stale` or the next address operation the user asks for (`sync_for_user_address_op`).
    StaleState,
    /// This seed already has an included free plan (one per seed, provisionally).
    AlreadyHasPlan,
    /// Invalid configuration (e.g. a non-absolute wallet directory).
    BadConfig,
    /// A bono operation (payment, plan, abandon, faucet) is already running.
    Busy,
    NameRejected {
        reason: NameProblem,
    },
    NameTaken,
    /// No bono has a free slot of that kind.
    NoFreeSlot,
    /// There is a slot, but the bono cannot be used yet: until `usable_at` (Unix seconds) or, if `null`, until the
    /// tree has the required later insertions. The orchestrator does not wait (provisional).
    BonoNotReady {
        #[ts(type = "number | null")]
        usable_at: Option<i64>,
    },
    /// The contract rejected the call locally (nothing was proved or sent).
    CallRejected {
        reason: CallProblem,
    },
    /// The slot's proof cap is exhausted: the slot stays paused in its state (`resume_paused_slot`).
    AttemptsExhausted,
    /// The slot was spent without an address (someone else's name confirmed, or foreign keys on our nullifier).
    SlotBurned,
    /// The mailbox has no name matching the chain (restored or contradictory): ask the user.
    NeedsName,
    /// The given name does not match the chain.
    WrongName,
    /// The alias suffix already belongs to someone else (practically impossible: 60 bits).
    AliasSuffixTaken,
    RelayerRefused,
    RateLimited {
        #[ts(type = "number")]
        retry_after_s: u64,
    },
    /// Issuer or relayer busy, or answering with an error, after retrying.
    ServiceUnavailable,
    /// The NightMail server (relayer or Issuer) does not answer: connection refused or deadline passed after retrying.
    ServerUnreachable,
    CaptchaFailed,
    PaymentFailed,
    /// The Issuer could not issue.
    IssueFailed,
    /// The receipt is not for our request, is not signed by the published key, or its deadline is invalid.
    BadReceipt,
    /// The issuance or payment is still not visible on chain, or the leaf is claimed by another payment method:
    /// pick it up with `resume`, or the user abandons it with `forget_pending_bono` (once it can no longer land).
    StillPending,
    /// The price changed: re-read it and ask the user.
    PriceChanged,
    InsufficientFunds {
        asset: FundsAsset,
    },
    Wallet {
        reason: WalletProblem,
    },
    Store,
    Internal,
}

impl std::fmt::Display for OrchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "orchestrator error: {self:?}")
    }
}

impl std::error::Error for OrchError {}

impl From<StoreError> for OrchError {
    fn from(_: StoreError) -> Self {
        OrchError::Store
    }
}

/// Progress of an operation, for the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "stage", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub enum Progress {
    /// Another address operation is running: this one waits its turn.
    Queued,
    RequestingBono,
    WaitingIssuer,
    WaitingInclusion,
    BonoReady {
        n: u32,
    },
    WalletSyncing,
    RegisteringDust,
    Paying,
    Proving,
    Relaying,
    /// A service (Midnight, relayer or Issuer) could not handle the request: retrying after a pause.
    Retrying,
    /// The NightMail server does not answer: retrying after a pause.
    ServerUnreachable,
    /// The wallet has no DUST for the fee yet: waiting for its NIGHT to generate it.
    WaitingDust,
    WaitingRound {
        #[ts(type = "number")]
        round: u64,
    },
    /// The saved wallet state could not be used; syncing from scratch (this will take a while).
    WalletStateDiscarded,
    AddressReady,
    Recovering {
        n: u32,
    },
}

/// A progress event with the operation it belongs to (the caller sets the id with [`tracked`]; 0 = no id).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub struct ProgressEvent {
    #[ts(type = "number")]
    pub op: u64,
    pub progress: Progress,
}

/// What the orchestrator tells the app: an operation's progress, or that the list of unfinished slots changed
/// without going through the store (a slot started or stopped running: see `Driving`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrchEvent {
    Progress(ProgressEvent),
    PendingChanged,
}

tokio::task_local! {
    static OP: u64;
}

/// Runs `future` with operation id `op`, which its progress events carry.
pub fn tracked<F: Future>(op: u64, future: F) -> impl Future<Output = F::Output> {
    OP.scope(op, future)
}

/// Id of the current operation (0 outside [`tracked`]).
pub(crate) fn current_op() -> u64 {
    OP.try_with(|op| *op).unwrap_or(0)
}

/// A slot, for the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub struct SlotId {
    pub n: u32,
    pub kind: AddressKind,
    pub j: u32,
}

impl From<SlotKey> for SlotId {
    fn from(key: SlotKey) -> Self {
        Self { n: key.n, kind: super::to_protocol_kind(key.kind), j: key.j }
    }
}

impl From<SlotId> for SlotKey {
    fn from(id: SlotId) -> Self {
        let kind = match id.kind {
            AddressKind::Mailbox => SlotKind::Mailbox,
            AddressKind::Alias => SlotKind::Alias,
        };
        Self { n: id.n, kind, j: id.j }
    }
}

/// One of our addresses, for the UI (no raw `addr_key`: it goes as hex, which is how MailSync asks for it).
#[derive(Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub struct AddressView {
    pub addr_key: String,
    pub slot: SlotId,
    /// Full address; empty for a restored mailbox without a name (show "unknown name").
    pub display: String,
    pub name: Option<String>,
    #[ts(type = "number")]
    pub created_at: i64,
}

/// `Debug` omits the address and name (personal data).
impl std::fmt::Debug for AddressView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AddressView").field("slot", &self.slot).finish_non_exhaustive()
    }
}

impl From<&Address> for AddressView {
    fn from(a: &Address) -> Self {
        Self {
            addr_key: hex::encode(a.addr_key),
            slot: SlotKey { n: a.n, kind: a.kind, j: a.j }.into(),
            display: a.display.clone(),
            name: a.name.clone(),
            created_at: a.created_at,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn progress_carries_the_operation_id() {
        assert_eq!(current_op(), 0);
        assert_eq!(tracked(7, async { current_op() }).await, 7);
    }

    #[test]
    fn views_round_trip_and_hide_personal_data() {
        let key = SlotKey { n: 2, kind: SlotKind::Mailbox, j: 1 };
        assert_eq!(SlotKey::from(SlotId::from(key)), key);
        let alias = SlotKey { n: 0, kind: SlotKind::Alias, j: 3 };
        assert_eq!(SlotKey::from(SlotId::from(alias)), alias);
        let address = Address {
            addr_key: [0xab; 32],
            kind: SlotKind::Mailbox,
            n: 2,
            j: 1,
            display: "juan@nightmail.local".into(),
            name: Some("juan".into()),
            created_at: 5,
        };
        let view = AddressView::from(&address);
        assert_eq!((view.addr_key.as_str(), view.slot), ("ab".repeat(32).as_str(), SlotId::from(key)));
        assert!(!format!("{view:?}").contains("juan"));
        let json = serde_json::to_value(OrchError::BonoNotReady { usable_at: Some(9) }).unwrap();
        assert_eq!(json, serde_json::json!({ "code": "bonoNotReady", "usableAt": 9 }));
    }
}
