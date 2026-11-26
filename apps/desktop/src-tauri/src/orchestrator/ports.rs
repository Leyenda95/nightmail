//! Orchestrator ports: everything outside the core (sidecar, Issuer, relayer, clock and randomness) sits behind a
//! trait so every path can be tested with doubles. Real implementations: `sidecar.rs` and `http.rs`.

use std::future::Future;
use std::pin::Pin;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::protocol::{
    ContractFindBonosParams, ContractFindBonosResult, ContractHashesParams, ContractHashesResult,
    ContractProveCallParams, ContractProveCallResult, ContractSnapshot, ContractSnapshotParams, InitializeResult, Plan,
    WalletBalance, WalletBuyBonoParams, WalletBuyBonoResult, WalletFaucetParams, WalletFaucetResult, WalletOpenParams,
    WalletOpenResult, WalletRegisterDustResult,
};
use crate::rpc::RpcError;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Injectable clock and randomness.
pub trait Env: Send + Sync {
    /// Unix seconds UTC.
    fn now(&self) -> i64;
    fn sleep(&self, duration: Duration) -> BoxFuture<'_, ()>;
    /// Uniform integer in `[0, bound)`; 0 if `bound` is 0.
    fn random_below(&self, bound: u64) -> u64;
}

/// System clock, `tokio::time::sleep` and the OS random generator.
pub struct SystemEnv;

impl Env for SystemEnv {
    fn now(&self) -> i64 {
        SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
    }

    fn sleep(&self, duration: Duration) -> BoxFuture<'_, ()> {
        Box::pin(tokio::time::sleep(duration))
    }

    fn random_below(&self, bound: u64) -> u64 {
        // Modulo bias is negligible: the bounds are small (wait seconds, indices).
        if bound == 0 { 0 } else { u64::from_le_bytes(crate::crypto::random_bytes()) % bound }
    }
}

/// What the core asks of `midnight-sidecar` (protocol in `protocol.rs`). Errors are those of `rpc.rs`.
pub trait Chain: Send + Sync {
    /// `initialize` result of the running sidecar (version and methods).
    fn handshake(&self) -> impl Future<Output = Result<InitializeResult, RpcError>> + Send;
    fn hashes(&self, p: &ContractHashesParams) -> impl Future<Output = Result<ContractHashesResult, RpcError>> + Send;
    fn snapshot(&self, p: &ContractSnapshotParams) -> impl Future<Output = Result<ContractSnapshot, RpcError>> + Send;
    fn find_bonos(
        &self,
        p: &ContractFindBonosParams,
    ) -> impl Future<Output = Result<ContractFindBonosResult, RpcError>> + Send;
    fn prove_call(
        &self,
        p: &ContractProveCallParams,
    ) -> impl Future<Output = Result<ContractProveCallResult, RpcError>> + Send;
    fn wallet_open(&self, p: &WalletOpenParams) -> impl Future<Output = Result<WalletOpenResult, RpcError>> + Send;
    fn wallet_close(&self) -> impl Future<Output = Result<(), RpcError>> + Send;
    fn wallet_sync(&self) -> impl Future<Output = Result<WalletBalance, RpcError>> + Send;
    fn wallet_register_dust(&self) -> impl Future<Output = Result<WalletRegisterDustResult, RpcError>> + Send;
    fn wallet_faucet(
        &self,
        p: &WalletFaucetParams,
    ) -> impl Future<Output = Result<WalletFaucetResult, RpcError>> + Send;
    fn wallet_buy_bono(
        &self,
        p: &WalletBuyBonoParams,
    ) -> impl Future<Output = Result<WalletBuyBonoResult, RpcError>> + Send;
}

// --- Issuer (apps/server/src/issuer/issuer-api.ts) -----------------------------------------------------------

/// Simulated payment period (only displayed for now: the bono does not expire).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BonoPeriod {
    Monthly,
    Annual,
}

/// What is requested from the Issuer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IssueRequest<'a> {
    Free { captcha_token: &'a str },
    Fiat { card_token: &'a str, period: BonoPeriod },
}

impl IssueRequest<'_> {
    pub fn plan(&self) -> Plan {
        match self {
            Self::Free { .. } => Plan::Free,
            Self::Fiat { .. } => Plan::Paid,
        }
    }

    /// Period text in the receipt (`none` for the free plan).
    pub fn period_text(&self) -> &'static str {
        match self {
            Self::Free { .. } => "none",
            Self::Fiat { period: BonoPeriod::Monthly, .. } => "monthly",
            Self::Fiat { period: BonoPeriod::Annual, .. } => "annual",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IssueState {
    Pending,
    Issued,
    Failed,
}

/// Signed Issuer receipt (v2, `packages/test-vectors/issuer/receipt-v2.json`). Lowercase hex.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub contract: String,
    pub period: String,
    pub insert_by: u64,
    pub signature: String,
    pub public_key: String,
}

/// `Debug` omits the `id` and the receipt (the `id` links to the payment).
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueReply {
    pub id: String,
    pub plan: Plan,
    pub state: IssueState,
    pub receipt: Receipt,
}

impl std::fmt::Debug for IssueReply {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IssueReply").field("plan", &self.plan).field("state", &self.state).finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IssuerError {
    /// 503: too many pending; retry after `retry_after_s`.
    Busy {
        retry_after_s: u64,
    },
    /// 429.
    RateLimited {
        retry_after_s: u64,
    },
    CaptchaFailed,
    PaymentFailed,
    /// 409: that `id` is already requested with the other plan.
    IdConflict,
    /// 404 on `status`.
    NotFound,
    /// 5xx, or a cut-off response: the server answers but cannot serve.
    Unavailable,
    /// No response: connection refused or deadline passed (the server is not running or unreachable).
    Unreachable,
    /// The configured Issuer URL is invalid (waiting will not fix it).
    BadConfig,
    /// Unintelligible response.
    BadResponse,
}

pub trait Issuer: Send + Sync {
    fn request(
        &self,
        id: &str,
        request: &IssueRequest<'_>,
    ) -> impl Future<Output = Result<IssueReply, IssuerError>> + Send;
    fn status(&self, id: &str) -> impl Future<Output = Result<IssueReply, IssuerError>> + Send;
}

// --- Relayer (apps/server/src/relayer/relayer-api.ts) ---------------------------------------------------------

/// Response to `POST /v1/relay`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Submitted {
    /// 202: queued.
    Ticket(String),
    /// 503: not accepted; send the same bytes again after `retry_after_s`.
    Busy { retry_after_s: u64 },
    /// 422 `bad-ttl`: the transaction has too little time left; a new proof is needed.
    BadTtl,
}

/// How a relay ended (`/v1/relay/status`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayOutcome {
    Included,
    Rejected,
    Unknown,
    Failed,
    Refused,
    Busy { retry_after_s: u64 },
    Expired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TicketState {
    Queued,
    Done(RelayOutcome),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayError {
    RateLimited {
        retry_after_s: u64,
    },
    /// 422 (except `bad-ttl`), 400 or 409: the relayer does not accept it.
    NotRelayable,
    /// 404 for the ticket.
    NotFound,
    /// 5xx, or a cut-off response: the relayer answers but cannot serve.
    Unavailable,
    /// No response: connection refused or deadline passed (the relayer is not running or unreachable).
    Unreachable,
    /// The configured relayer URL is invalid (waiting will not fix it).
    BadConfig,
    BadResponse,
}

pub trait Relayer: Send + Sync {
    /// Does the relayer answer? A cheap check that sends nothing (before requesting a proof).
    fn reachable(&self) -> impl Future<Output = bool> + Send;
    fn submit(&self, tx: &str) -> impl Future<Output = Result<Submitted, RelayError>> + Send;
    fn status(&self, ticket: &str) -> impl Future<Output = Result<TicketState, RelayError>> + Send;
}
