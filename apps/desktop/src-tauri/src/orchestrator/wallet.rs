//! Shielded payment with the embedded wallet, and the faucet.
//!
//! - The `shielded` method is claimed for the leaf before opening the wallet (`request_leaf`).
//! - The journal entry is written (and rewritten with the time) right before every `wallet.buyBono` call, so the
//!   35 min cleanup counts from the last one. Anything other than a result is "unknown" and retried with the same
//!   `id`; the entry is only closed once the leaf is in the tree (or, in `resume`, 35 min later without a leaf).
//! - The wallet is closed when done (provisional), unless a `buyBono` may still be running in the sidecar
//!   (`wallet_in_flight`: set by a deadline, cleared by a result or by closing its journal entry) or the background
//!   DUST registration is still running (`dust`: closed with the last use).

use std::sync::atomic::Ordering;

use serde::{Deserialize, Serialize};

use super::bonos::{BUY_JOURNAL_KIND, BonoInfo, METHOD_SHIELDED, journal_id};
use super::chain::{call_problem, data_of, remote_error};
use super::ports::{Chain, Issuer, Relayer};
use super::{DustClaim, DustSetup, OrchError, Orchestrator, Progress, Result};
use crate::protocol::{
    CallProblem, FundsAsset, SecretHex, StaleProblem, StaleStateData, WalletBalance, WalletBuyBonoParams, WalletFaucetParams,
    WalletOpenParams, WalletProblem, WalletUnavailableData, codes,
};
use crate::rpc::RpcError;
use crate::store::{JournalEntry, Plan};

/// Wallet reopenings or resyncs within one purchase (they do not use up the `buyBono` call cap).
const MAX_WALLET_FIXES: u32 = 2;

/// What is written to the journal before paying. `Debug` omits the `id`.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Purchase {
    pub network: String,
    pub contract: String,
    pub id: String,
    pub amount: String,
    pub n: u32,
    pub k: u32,
}

impl std::fmt::Debug for Purchase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Purchase").field("n", &self.n).field("k", &self.k).finish_non_exhaustive()
    }
}

/// What is shown of the embedded wallet ([`Orchestrator::wallet_snapshot`]). `Debug` omits the address.
#[derive(Clone, PartialEq, Eq)]
pub struct WalletSnapshot {
    pub unshielded_address: Option<String>,
    pub balance: WalletBalance,
    /// The background NIGHT-for-DUST registration, including any claimed by this read.
    pub dust_setup: DustSetup,
}

impl std::fmt::Debug for WalletSnapshot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WalletSnapshot")
            .field("balance", &self.balance)
            .field("dust_setup", &self.dust_setup)
            .finish_non_exhaustive()
    }
}

/// What to do after a `wallet.buyBono` error.
#[derive(Debug, PartialEq, Eq)]
enum BuyNext {
    /// Unknown outcome or safe rejection: another call with the same `id`.
    Retry,
    Reopen,
    Resync,
    /// Not enough DUST for the fee (safe rejection): wait for it to be generated and repeat.
    WaitDust,
    Fail(OrchError),
}

const NO_DUST: OrchError = OrchError::InsufficientFunds { asset: FundsAsset::Dust };

fn buy_next(error: &RpcError) -> BuyNext {
    let RpcError::Remote { code, data, .. } = error else {
        let unknown = matches!(error, RpcError::Timeout | RpcError::Closed);
        return if unknown { BuyNext::Retry } else { BuyNext::Fail(OrchError::Internal) };
    };
    match *code {
        codes::CANCELLED | codes::TX_REJECTED | codes::UPSTREAM_UNAVAILABLE | codes::PROVER_UNAVAILABLE => {
            BuyNext::Retry
        }
        codes::WALLET_UNAVAILABLE => match data_of::<WalletUnavailableData>(data).map(|d| d.reason) {
            Some(WalletProblem::NotOpen) => BuyNext::Reopen,
            Some(WalletProblem::NotSynced) => BuyNext::Resync,
            _ => BuyNext::Fail(remote_error(*code, data)),
        },
        codes::CALL_REJECTED => match call_problem(data) {
            CallProblem::WrongAmount | CallProblem::OldPriceExpired => BuyNext::Fail(OrchError::PriceChanged),
            reason => BuyNext::Fail(OrchError::CallRejected { reason }),
        },
        codes::STALE_STATE => {
            let future = data_of::<StaleStateData>(data).is_some_and(|d| d.reason == StaleProblem::Future);
            if future { BuyNext::Fail(OrchError::Clock) } else { BuyNext::Retry }
        }
        code => match remote_error(code, data) {
            NO_DUST => BuyNext::WaitDust,
            e => BuyNext::Fail(e),
        },
    }
}

impl<C: Chain, I: Issuer, R: Relayer> Orchestrator<C, I, R> {
    /// Shielded payment: open → sync → registerDust if there are no DUST coins → buyBono (with the accepted amount).
    /// The wallet closes with the last use.
    pub async fn pay_shielded(&self, amount: &str) -> Result<BonoInfo> {
        let _guard = self.bono_lock()?;
        let (n, k) = self.choose_leaf(Plan::Paid).await?;
        let id = self.request_leaf(n, k, Plan::Paid, METHOD_SHIELDED).await?;
        let purchase = Purchase {
            network: self.d.config.network.clone(),
            contract: self.d.config.contract_address.clone(),
            id: id.clone(),
            amount: amount.into(),
            n,
            k,
        };
        self.with_wallet(self.prepare_and_buy(&purchase)).await?;
        self.include(n, k, Plan::Paid, &id, Some(journal_id(n, k))).await
    }

    async fn prepare_and_buy(&self, purchase: &Purchase) -> Result<()> {
        self.prepare_wallet().await?;
        self.emit(Progress::Paying);
        self.buy(purchase).await
    }

    /// Writes (or rewrites with the current time) the purchase in the journal.
    async fn journal_purchase(&self, purchase: &Purchase) -> Result<()> {
        let entry = JournalEntry {
            id: journal_id(purchase.n, purchase.k),
            kind: BUY_JOURNAL_KIND.into(),
            payload: serde_json::to_vec(purchase).map_err(|_| OrchError::Internal)?,
            started_at: self.now(),
        };
        self.db(move |s| s.put_journal(&entry)).await
    }

    pub(super) async fn open_wallet(&self) -> Result<()> {
        let keys = &self.d.keys;
        let params = WalletOpenParams {
            seed: SecretHex::from_bytes(&keys.wallet_seed()),
            state_key: SecretHex::from_bytes(&keys.wallet_state_key()),
            state_dir: self.d.config.wallet_state_dir.clone(),
        };
        let chain = &self.d.chain;
        match self.call_sidecar(false, |_| chain.wallet_open(&params)).await {
            Ok(opened) => {
                if opened.state_discarded {
                    self.emit(Progress::WalletStateDiscarded);
                }
                *self.wallet_address.lock().unwrap_or_else(|e| e.into_inner()) = Some(opened.unshielded_address);
                Ok(())
            }
            Err(OrchError::Wallet { reason: WalletProblem::AlreadyOpen }) => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// Unshielded address and balance of the embedded wallet (opens, syncs and closes). The address is `None` if the
    /// wallet was already open (a `buyBono` in flight) and this orchestrator had not seen it yet. If it sees
    /// unregistered NIGHT it also claims the background registration (`dust`): the wallet stays open for it and the
    /// caller starts it with [`Orchestrator::setup_dust`].
    pub async fn wallet_snapshot(&self) -> Result<(WalletSnapshot, Option<DustClaim>)> {
        let _guard = self.bono_lock()?;
        self.with_wallet(self.snapshot_once()).await
    }

    async fn snapshot_once(&self) -> Result<(WalletSnapshot, Option<DustClaim>)> {
        let balance = self.sync_wallet().await?;
        let claim = self.claim_dust_setup(&balance);
        let unshielded_address = self.wallet_address.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let dust_setup = self.dust_setup(&balance);
        Ok((WalletSnapshot { unshielded_address, balance, dust_setup }, claim))
    }

    /// Closes the wallet (best effort), unless a `buyBono` may still be in flight.
    pub(crate) async fn close_wallet_if_idle(&self) {
        if !self.wallet_in_flight.load(Ordering::SeqCst) {
            let _ = self.d.chain.wallet_close().await;
        }
    }

    pub(super) async fn sync_wallet(&self) -> Result<WalletBalance> {
        self.emit(Progress::WalletSyncing);
        let chain = &self.d.chain;
        self.call_sidecar(false, |_| chain.wallet_sync()).await
    }

    /// Syncs (with the wallet already open) and registers NIGHT for DUST if there are no DUST coins (if the background
    /// is registering, waits for it). With neither DUST nor NIGHT to generate it there is nothing to wait for:
    /// `InsufficientFunds dust` immediately.
    async fn prepare_wallet(&self) -> Result<()> {
        let balance = self.sync_wallet().await?;
        if balance.dust_coins == 0 {
            self.emit(Progress::RegisteringDust);
            let registered = self.register_dust().await?;
            if !registered && balance.night == "0" {
                return Err(NO_DUST);
            }
        }
        Ok(())
    }

    /// `wallet.buyBono` with the same `id`: at most `max_buy_calls` unknown outcomes; reopening or resyncing the wallet
    /// does not use up that cap (it has its own).
    async fn buy(&self, purchase: &Purchase) -> Result<()> {
        let params = WalletBuyBonoParams {
            contract_address: self.contract(),
            id: purchase.id.clone(),
            amount: purchase.amount.clone(),
        };
        let (mut unknown, mut fixes, mut dust) = (0, 0, 0);
        loop {
            self.journal_purchase(purchase).await?;
            let error = match self.d.chain.wallet_buy_bono(&params).await {
                Ok(_) => {
                    self.wallet_in_flight.store(false, Ordering::SeqCst);
                    return Ok(());
                }
                Err(e) => e,
            };
            if matches!(error, RpcError::Timeout) {
                // The sidecar is asked to drop it ($/cancel), but an already submitted transaction runs its course and
                // may land: treat it as in flight (a closed channel means a dead sidecar, so nothing continues).
                self.wallet_in_flight.store(true, Ordering::SeqCst);
            }
            // The last call's time is when it returned (it may have taken up to 45 min).
            self.journal_purchase(purchase).await?;
            match buy_next(&error) {
                BuyNext::Retry => {
                    unknown += 1;
                    if unknown >= self.d.config.retry.max_buy_calls {
                        return Err(OrchError::StillPending);
                    }
                    self.sleep(self.d.config.retry.transient_wait).await;
                }
                BuyNext::Fail(e) => return Err(e),
                BuyNext::WaitDust => self.wait_for_dust(&mut dust).await?,
                fix => {
                    fixes += 1;
                    if fixes > MAX_WALLET_FIXES {
                        return Err(OrchError::MidnightUnavailable);
                    }
                    if fix == BuyNext::Reopen {
                        self.open_wallet().await?
                    } else {
                        self.sync_wallet().await.map(drop)?
                    }
                }
            }
        }
    }

    /// One more wait for DUST (`waited` counts those of this operation); once capped, `InsufficientFunds dust`.
    async fn wait_for_dust(&self, waited: &mut u32) -> Result<()> {
        *waited += 1;
        if *waited > self.d.config.retry.dust_waits {
            return Err(NO_DUST);
        }
        self.emit(Progress::WaitingDust);
        self.sleep(self.d.config.retry.dust_wait).await;
        Ok(())
    }

    /// Mints TestToken (test networks only), with the wallet prepared as for a payment (registers NIGHT for DUST if
    /// needed). Not idempotent: no retries, except after `INSUFFICIENT_FUNDS dust` (nothing was sent). Closes the
    /// wallet.
    pub async fn faucet(&self, token_address: &str, amount: &str) -> Result<()> {
        let _guard = self.bono_lock()?;
        self.with_wallet(self.faucet_once(token_address, amount)).await
    }

    async fn faucet_once(&self, token_address: &str, amount: &str) -> Result<()> {
        self.prepare_wallet().await?;
        let params = WalletFaucetParams { token_address: token_address.into(), amount: amount.into() };
        // Only repeated after safe rejections: `INSUFFICIENT_FUNDS` only comes from balancing, before signing and
        // sending (sidecar `wallet.ts`, `payFor`), and `not-synced` before building (`walletCall.ts`, `keysOf`).
        let (mut dust, mut fixes) = (0, 0);
        loop {
            match self.d.chain.wallet_faucet(&params).await {
                Ok(_) => return Ok(()),
                Err(RpcError::Remote { code, data, .. }) => match remote_error(code, &data) {
                    NO_DUST => self.wait_for_dust(&mut dust).await?,
                    OrchError::Wallet { reason: WalletProblem::NotSynced } if fixes < MAX_WALLET_FIXES => {
                        fixes += 1;
                        self.sync_wallet().await?;
                    }
                    e => return Err(e),
                },
                Err(_) => return Err(OrchError::MidnightUnavailable),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn remote(code: i64, data: serde_json::Value) -> RpcError {
        RpcError::Remote { code, message: String::new(), data: Some(data) }
    }

    #[test]
    fn buy_errors() {
        use serde_json::json;
        assert_eq!(buy_next(&RpcError::Timeout), BuyNext::Retry);
        assert_eq!(buy_next(&RpcError::Closed), BuyNext::Retry);
        assert_eq!(buy_next(&RpcError::BadResponse("x".into())), BuyNext::Fail(OrchError::Internal));
        assert_eq!(buy_next(&remote(codes::TX_REJECTED, json!(null))), BuyNext::Retry);
        assert_eq!(buy_next(&remote(codes::CANCELLED, json!(null))), BuyNext::Retry);
        let wallet = |r: &str| remote(codes::WALLET_UNAVAILABLE, json!({ "reason": r }));
        assert_eq!(buy_next(&wallet("not-open")), BuyNext::Reopen);
        assert_eq!(buy_next(&wallet("not-synced")), BuyNext::Resync);
        assert_eq!(buy_next(&wallet("in-use")), BuyNext::Fail(OrchError::Wallet { reason: WalletProblem::InUse }));
        assert_eq!(buy_next(&wallet("?")), BuyNext::Fail(OrchError::Internal), "no reason: none is made up");
        let rejected = |r: &str| remote(codes::CALL_REJECTED, json!({ "reason": r }));
        assert_eq!(buy_next(&rejected("wrong-amount")), BuyNext::Fail(OrchError::PriceChanged));
        assert_eq!(buy_next(&rejected("old-price-expired")), BuyNext::Fail(OrchError::PriceChanged));
        let token = BuyNext::Fail(OrchError::CallRejected { reason: CallProblem::WrongToken });
        assert_eq!(buy_next(&rejected("wrong-token")), token);
        let stale = |r: &str| remote(codes::STALE_STATE, json!({ "reason": r, "ageMs": 1 }));
        assert_eq!(buy_next(&stale("future")), BuyNext::Fail(OrchError::Clock));
        assert_eq!(buy_next(&stale("old")), BuyNext::Retry);
        assert_eq!(buy_next(&remote(codes::INSUFFICIENT_FUNDS, json!({ "asset": "dust" }))), BuyNext::WaitDust);
        let token = BuyNext::Fail(OrchError::InsufficientFunds { asset: FundsAsset::Token });
        assert_eq!(buy_next(&remote(codes::INSUFFICIENT_FUNDS, json!({ "asset": "token" }))), token);
        assert_eq!(buy_next(&remote(codes::INSUFFICIENT_FUNDS, json!(null))), BuyNext::Fail(OrchError::Internal));
    }

    #[test]
    fn purchase_debug_hides_the_id() {
        let purchase =
            Purchase { network: "x".into(), contract: "c".into(), id: "5151".into(), amount: "1".into(), n: 1, k: 0 };
        assert!(!format!("{purchase:?}").contains("5151"));
    }
}
