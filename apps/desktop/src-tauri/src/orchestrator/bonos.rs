//! Bono flows with the Issuer: free plan (simulated CAPTCHA) and simulated card payment. The shielded payment lives
//! in `wallet.rs`; the shared parts (requested leaf, claimed method, inclusion) live here.
//!
//! - `n` is the next free one; upgrading the plan keeps `n`, uses `k + 1` and plan `paid`. An unfinished request
//!   (leaf `requested`) is repeated with the same `id` (the Issuer and `wallet.buyBono` are idempotent per `id`).
//! - One free plan per seed, counting only included ones (provisional).
//! - A leaf is paid by exactly one method: the method is claimed in the store (with the leaf, in one transaction)
//!   before any external call; another method on the same leaf gets `StillPending`. Only inclusion or
//!   `forget_pending_bono` release it. One bono operation at a time (`bono_lock`).
//! - After issuance: `findBonos` → position → `include_bono` (marks it, raises the ratchet with a backed value and
//!   sets `usable_at` = now + random wait, all in one transaction).

use serde::Serialize;
use ts_rs::TS;

use super::http::{ExpectedReceipt, verify_receipt};
use super::prove::Holdup;
use super::ports::{Chain, IssueReply, IssueRequest, IssueState, Issuer, IssuerError, Receipt, Relayer};
use super::{OrchError, Orchestrator, Progress, Result, bytes32, to_protocol_plan};
use crate::protocol::{HashOp, Plan as WirePlan};
use crate::store::{BonoLeaf, BonoStatus, Plan};

/// `validUntil` for now: no expiry.
pub(crate) const NO_EXPIRY: u32 = u32::MAX;
/// Kind of the shielded purchase journal entries.
pub(crate) const BUY_JOURNAL_KIND: &str = "buy-bono";
/// Maximum receipt insertion deadline: the Issuer's (3900 s) plus a clock margin.
const RECEIPT_MAX_AHEAD_S: i64 = 3900 + 300;
/// Claimable payment methods (value of `method/<n>/<k>`).
pub(crate) const METHOD_FREE: &str = "free";
/// Night Plus by simulated card. Leaves claimed before the period was dropped keep `fiat:monthly` or `fiat:annual`.
const METHOD_FIAT: &str = "fiat";
pub(crate) const METHOD_SHIELDED: &str = "shielded";

pub(crate) fn receipt_key(n: u32, k: u32) -> String {
    format!("receipt/{n}/{k}")
}

pub(crate) fn journal_id(n: u32, k: u32) -> String {
    format!("{BUY_JOURNAL_KIND}/{n}/{k}")
}

pub(crate) fn method_key(n: u32, k: u32) -> String {
    format!("method/{n}/{k}")
}

/// A ready bono. Neither `Debug` nor the UI sees the position (it identifies the leaf in the tree).
#[derive(Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub struct BonoInfo {
    pub n: u32,
    pub k: u32,
    pub plan: WirePlan,
    #[serde(skip)]
    pub position: u32,
    /// Unix seconds from which it can be used.
    #[ts(type = "number")]
    pub usable_at: i64,
}

/// `Debug` of a bono leaf without `id` or position (they identify the leaf): only `(n, k, plan)`.
pub(crate) fn debug_leaf(
    f: &mut std::fmt::Formatter<'_>,
    name: &str,
    (n, k, plan): (u32, u32, WirePlan),
) -> std::fmt::Result {
    f.debug_struct(name).field("n", &n).field("k", &k).field("plan", &plan).finish_non_exhaustive()
}

impl std::fmt::Debug for BonoInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        debug_leaf(f, "BonoInfo", (self.n, self.k, self.plan))
    }
}

/// Which leaf to request: an unfinished one of the same plan; for a paid plan, upgrade the last included free bono
/// without a paid leaf; otherwise a new bono.
pub(crate) fn pick_leaf(bonos: &[BonoLeaf], plan: Plan) -> (u32, u32) {
    if let Some(b) = bonos.iter().find(|b| b.status == BonoStatus::Requested && b.plan == plan) {
        return (b.n, b.k);
    }
    let has_paid = |n: u32| bonos.iter().any(|b| b.n == n && b.plan == Plan::Paid);
    let upgradable = bonos
        .iter()
        .filter(|b| plan == Plan::Paid && b.status == BonoStatus::Included && b.plan == Plan::Free && !has_paid(b.n))
        .map(|b| b.n)
        .max();
    match upgradable {
        Some(n) => (n, bonos.iter().filter(|b| b.n == n).map(|b| b.k + 1).max().unwrap_or(0)),
        None => (bonos.iter().map(|b| b.n + 1).max().unwrap_or(0), 0),
    }
}

/// Is this claimed method the card one (`fiat`, or `fiat:monthly` | `fiat:annual` from before Night Plus)?
fn is_card_method(method: &str) -> bool {
    matches!(method, METHOD_FIAT | "fiat:monthly" | "fiat:annual")
}

fn issuer_error(error: IssuerError) -> OrchError {
    match error {
        IssuerError::RateLimited { retry_after_s } => OrchError::RateLimited { retry_after_s },
        IssuerError::CaptchaFailed => OrchError::CaptchaFailed,
        IssuerError::PaymentFailed => OrchError::PaymentFailed,
        // The Issuer holds the leaf with the other plan: wait or abandon it (provisional).
        IssuerError::IdConflict => OrchError::StillPending,
        IssuerError::Unreachable => OrchError::ServerUnreachable,
        IssuerError::BadConfig => OrchError::BadConfig,
        IssuerError::Busy { .. } | IssuerError::NotFound | IssuerError::Unavailable | IssuerError::BadResponse => {
            OrchError::ServiceUnavailable
        }
    }
}

impl<C: Chain, I: Issuer, R: Relayer> Orchestrator<C, I, R> {
    /// Free plan: CAPTCHA (simulated: the configured token) → Issuer → issuance → leaf in the tree. Only one per seed:
    /// with one already included, `AlreadyHasPlan`.
    pub async fn request_free_plan(&self) -> Result<BonoInfo> {
        let _guard = self.bono_lock()?;
        let bonos = self.db(|s| s.list_bonos()).await?;
        if bonos.iter().any(|b| b.plan == Plan::Free && b.status == BonoStatus::Included) {
            return Err(OrchError::AlreadyHasPlan);
        }
        let token = self.d.config.captcha_token.clone();
        self.issue(IssueRequest::Free { captcha_token: &token }, METHOD_FREE.into()).await
    }

    /// Simulated card payment of Night Plus (no period, the bono does not expire for now). If the leaf was already
    /// claimed by a card payment (also one from before the period was dropped), that same request is repeated.
    pub async fn pay_fiat(&self) -> Result<BonoInfo> {
        let _guard = self.bono_lock()?;
        let (n, k) = self.choose_leaf(Plan::Paid).await?;
        let claimed = self.db(move |s| s.get_meta(&method_key(n, k))).await?;
        let claimed = claimed.and_then(|v| String::from_utf8(v).ok()).filter(|m| is_card_method(m));
        let method = claimed.unwrap_or_else(|| METHOD_FIAT.into());
        let token = self.d.config.card_token.clone();
        self.issue(IssueRequest::Fiat { card_token: &token }, method).await
    }

    async fn issue(&self, request: IssueRequest<'_>, method: String) -> Result<BonoInfo> {
        let plan = if request.plan() == WirePlan::Paid { Plan::Paid } else { Plan::Free };
        let (n, k) = self.choose_leaf(plan).await?;
        let id = self.request_leaf(n, k, plan, &method).await?;
        // With a receipt already saved (a retry) do not request again: wait for that request's issuance.
        let state = if self.saved_receipt(n, k).await? {
            IssueState::Pending
        } else {
            self.emit(Progress::RequestingBono);
            let reply = self.ask_issuer(&id, &request).await?;
            self.save_receipt(n, k, &reply).await?;
            reply.state
        };
        if let Err(e) = self.wait_issued(&id, state).await {
            if e == OrchError::IssueFailed {
                // The Issuer will not issue that request: the receipt is void and a new request can be made.
                self.db(move |s| s.set_meta(&receipt_key(n, k), &[])).await?;
            }
            return Err(e);
        }
        self.include(n, k, plan, &id, None).await
    }

    pub(crate) async fn choose_leaf(&self, plan: Plan) -> Result<(u32, u32)> {
        let bonos = self.db(|s| s.list_bonos()).await?;
        Ok(pick_leaf(&bonos, plan))
    }

    async fn saved_receipt(&self, n: u32, k: u32) -> Result<bool> {
        Ok(self.db(move |s| s.get_meta(&receipt_key(n, k))).await?.is_some_and(|v| !v.is_empty()))
    }

    /// Computes `id_k` and, in one transaction, records the leaf as requested and claims `method` for it. If another
    /// method already holds it: `StillPending`.
    pub(crate) async fn request_leaf(&self, n: u32, k: u32, plan: Plan, method: &str) -> Result<String> {
        let id = self.hash(HashOp::IdK { s: self.bono_secret(n), k }).await?;
        let leaf = BonoLeaf {
            n,
            k,
            plan,
            id: bytes32(&id)?,
            status: BonoStatus::Requested,
            position: None,
            requested_at: self.now(),
            usable_at: None,
        };
        let method = method.as_bytes().to_vec();
        if self.db(move |s| s.claim_bono_leaf(&leaf, &method_key(n, k), &method)).await? {
            Ok(id)
        } else {
            Err(OrchError::StillPending)
        }
    }

    async fn ask_issuer(&self, id: &str, request: &IssueRequest<'_>) -> Result<IssueReply> {
        let mut busy = 0;
        loop {
            match self.d.issuer.request(id, request).await {
                Ok(reply) => return self.checked(reply, id, request),
                Err(IssuerError::Busy { retry_after_s }) => self.busy_wait(&mut busy, retry_after_s, Holdup::Busy).await?,
                Err(e) => return Err(issuer_error(e)),
            }
        }
    }

    /// The receipt must be for this request, signed by the published key, with a future and bounded insertion deadline.
    fn checked(&self, reply: IssueReply, id: &str, request: &IssueRequest<'_>) -> Result<IssueReply> {
        let expected = ExpectedReceipt {
            contract: &self.d.config.contract_address,
            id,
            plan: request.plan(),
            period: request.receipt_period(),
            key_fingerprint: &self.d.config.issuer_key,
        };
        let now = self.now();
        let insert_by = i64::try_from(reply.receipt.insert_by).unwrap_or(i64::MAX);
        let in_window = now < insert_by && insert_by <= now + RECEIPT_MAX_AHEAD_S;
        if in_window && verify_receipt(&reply, &expected) { Ok(reply) } else { Err(OrchError::BadReceipt) }
    }

    /// Receipt of leaf (n, k), to decide whether it can be abandoned: the saved one or, if none and the Issuer claimed
    /// the leaf (lost response), whatever `status` returns. 404 or `failed` → none (can be abandoned); a valid receipt
    /// → saved and its deadline applies; no answer or an unverifiable receipt → `StillPending` (it may have charged).
    pub(crate) async fn known_receipt(&self, n: u32, k: u32) -> Result<Option<Receipt>> {
        let saved = self.db(move |s| s.get_meta(&receipt_key(n, k))).await?;
        if let Some(receipt) = saved.and_then(|v| serde_json::from_slice::<Receipt>(&v).ok()) {
            return Ok(Some(receipt));
        }
        let method = self.db(move |s| s.get_meta(&method_key(n, k))).await?.and_then(|v| String::from_utf8(v).ok());
        let request = match method.as_deref() {
            Some(METHOD_FREE) => IssueRequest::Free { captcha_token: "" },
            Some(m) if is_card_method(m) => IssueRequest::Fiat { card_token: "" },
            Some(_) => return Ok(None),
            None => return Ok(None),
        };
        let bono = self.db(move |s| s.get_bono(n, k)).await?.ok_or(OrchError::Internal)?;
        let id = hex::encode(bono.id);
        match self.d.issuer.status(&id).await {
            Err(IssuerError::NotFound) => Ok(None),
            Ok(reply) if reply.state == IssueState::Failed => Ok(None),
            Ok(reply) => self.verified_receipt(n, k, reply, &id, &request).await.map(Some),
            Err(_) => Err(OrchError::StillPending),
        }
    }

    async fn verified_receipt(
        &self,
        n: u32,
        k: u32,
        reply: IssueReply,
        id: &str,
        request: &IssueRequest<'_>,
    ) -> Result<Receipt> {
        let expected = ExpectedReceipt {
            contract: &self.d.config.contract_address,
            id,
            plan: request.plan(),
            period: request.receipt_period(),
            key_fingerprint: &self.d.config.issuer_key,
        };
        if !verify_receipt(&reply, &expected) {
            return Err(OrchError::StillPending);
        }
        self.save_receipt(n, k, &reply).await?;
        Ok(reply.receipt)
    }

    /// The receipt stays local: proof that the operator charged and committed to inserting.
    async fn save_receipt(&self, n: u32, k: u32, reply: &IssueReply) -> Result<()> {
        let value = serde_json::to_vec(&reply.receipt).map_err(|_| OrchError::Internal)?;
        self.db(move |s| s.set_meta(&receipt_key(n, k), &value)).await
    }

    async fn wait_issued(&self, id: &str, first: IssueState) -> Result<()> {
        self.emit(Progress::WaitingIssuer);
        let mut state = first;
        for _ in 0..self.d.config.pacing.max_polls {
            match state {
                IssueState::Issued => return Ok(()),
                IssueState::Failed => return Err(OrchError::IssueFailed),
                IssueState::Pending => self.sleep(self.d.config.pacing.poll).await,
            }
            state = match self.d.issuer.status(id).await {
                Ok(reply) => reply.state,
                Err(IssuerError::Unavailable | IssuerError::Unreachable | IssuerError::Busy { .. }) => IssueState::Pending,
                Err(e) => return Err(issuer_error(e)),
            };
        }
        Err(OrchError::StillPending)
    }

    /// Waits for the leaf in the tree and marks it included (closing the journal entry, if any).
    pub(crate) async fn include(
        &self,
        n: u32,
        k: u32,
        plan: Plan,
        id: &str,
        journal: Option<String>,
    ) -> Result<BonoInfo> {
        self.emit(Progress::WaitingInclusion);
        let leaf = self.leaf_of(id, plan).await?;
        let position = self.wait_leaf(&leaf).await?;
        self.settle_leaf(n, k, plan, position, journal).await
    }

    pub(crate) async fn leaf_of(&self, id: &str, plan: Plan) -> Result<String> {
        self.hash(HashOp::Leaf { id: id.into(), plan: to_protocol_plan(plan), valid_until: NO_EXPIRY }).await
    }

    /// Polls for the leaf; `behind` answers during the whole wait count towards the persisted global streak (not
    /// reset here).
    async fn wait_leaf(&self, leaf: &str) -> Result<u32> {
        let leaves = [leaf.to_owned()];
        for _ in 0..self.d.config.pacing.max_polls {
            if let Some(position) = self.find_leaves(&leaves).await?.1[0] {
                return Ok(position);
            }
            self.sleep(self.d.config.pacing.poll).await;
        }
        Err(OrchError::StillPending)
    }

    /// Leaf included at `position`: a single transaction (mark, ratchet, `usable_at` if unset, journal); then the
    /// claimed method is released.
    pub(crate) async fn settle_leaf(
        &self,
        n: u32,
        k: u32,
        plan: Plan,
        position: u32,
        journal: Option<String>,
    ) -> Result<BonoInfo> {
        let usable = self.now() + self.random_between(self.d.config.pacing.usable_delay).as_secs() as i64;
        let closes_journal = journal.is_some();
        self.db(move |s| s.include_bono(n, k, position, usable, journal.as_deref())).await?;
        if closes_journal {
            // The purchase is resolved: none of its buyBono calls is still in flight.
            self.wallet_in_flight.store(false, std::sync::atomic::Ordering::SeqCst);
        }
        let stored = self.db(move |s| s.get_bono(n, k)).await?.and_then(|b| b.usable_at);
        self.db(move |s| s.set_meta(&method_key(n, k), &[])).await?;
        self.emit(Progress::BonoReady { n });
        Ok(BonoInfo { n, k, plan: to_protocol_plan(plan), position, usable_at: stored.unwrap_or(usable) })
    }

    /// Current paid plan price in token units (decimal): what the UI shows and the user accepts.
    pub async fn current_price(&self) -> Result<String> {
        Ok(self.head().await?.price)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leaf(n: u32, k: u32, plan: Plan, status: BonoStatus) -> BonoLeaf {
        BonoLeaf { n, k, plan, id: [n as u8; 32], status, position: None, requested_at: 0, usable_at: None }
    }

    #[test]
    fn pick_leaf_cases() {
        use BonoStatus::*;
        assert_eq!(pick_leaf(&[], Plan::Free), (0, 0));
        assert_eq!(pick_leaf(&[], Plan::Paid), (0, 0));
        let free0 = leaf(0, 0, Plan::Free, Included);
        assert_eq!(pick_leaf(std::slice::from_ref(&free0), Plan::Free), (1, 0), "another free one = new bono");
        assert_eq!(pick_leaf(std::slice::from_ref(&free0), Plan::Paid), (0, 1), "plan upgrade: same n, k + 1");
        let paid1 = leaf(0, 1, Plan::Paid, Included);
        assert_eq!(pick_leaf(&[free0.clone(), paid1], Plan::Paid), (1, 0), "already upgraded: new bono");
        let pending = leaf(3, 0, Plan::Paid, Requested);
        assert_eq!(pick_leaf(&[free0.clone(), pending], Plan::Paid), (3, 0), "unfinished request: same id");
        let free_requested = leaf(0, 0, Plan::Free, Requested);
        assert_eq!(pick_leaf(&[free_requested], Plan::Paid), (1, 0), "a free one not yet included is not upgraded");
    }

    #[test]
    fn issuer_errors_map_to_fixed_codes() {
        let limited = issuer_error(IssuerError::RateLimited { retry_after_s: 5 });
        assert_eq!(limited, OrchError::RateLimited { retry_after_s: 5 });
        assert_eq!(issuer_error(IssuerError::CaptchaFailed), OrchError::CaptchaFailed);
        assert_eq!(issuer_error(IssuerError::PaymentFailed), OrchError::PaymentFailed);
        assert_eq!(issuer_error(IssuerError::IdConflict), OrchError::StillPending);
        for e in [IssuerError::Busy { retry_after_s: 1 }, IssuerError::NotFound, IssuerError::Unavailable] {
            assert_eq!(issuer_error(e), OrchError::ServiceUnavailable);
        }
        assert_eq!(issuer_error(IssuerError::BadResponse), OrchError::ServiceUnavailable);
        assert_eq!(issuer_error(IssuerError::Unreachable), OrchError::ServerUnreachable);
        assert_eq!(issuer_error(IssuerError::BadConfig), OrchError::BadConfig);
    }

    #[test]
    fn methods_and_bono_info() {
        assert!(is_card_method(METHOD_FIAT));
        assert!(is_card_method("fiat:monthly") && is_card_method("fiat:annual"), "claimed before Night Plus");
        assert!(!is_card_method(METHOD_SHIELDED) && !is_card_method(METHOD_FREE));
        let info = BonoInfo { n: 1, k: 0, plan: WirePlan::Free, position: 777, usable_at: 0 };
        assert!(!format!("{info:?}").contains("777"));
        assert!(serde_json::to_value(info).unwrap().get("position").is_none());
    }
}
