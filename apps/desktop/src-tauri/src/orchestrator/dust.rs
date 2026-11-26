//! Background registration of NIGHT for DUST, and the shared sidecar wallet.
//!
//! - As soon as a wallet read ([`Orchestrator::wallet_snapshot`], or [`Orchestrator::check_dust`] once at unlock)
//!   sees unregistered NIGHT, the registration is claimed ([`DustClaim`]) and the app runs it in a task
//!   ([`Orchestrator::setup_dust`]), so the first payment does not wait the ~15-30 min it takes to generate the DUST
//!   for the registration fee.
//! - No loops: a registration that finishes (successfully or not) is not repeated until the wallet holds more NIGHT
//!   than then. The state lives in memory only, so restarting (or unlocking) the app tries again.
//! - There is a single open wallet in the sidecar, used concurrently by the foreground (under `bono_lock`) and the
//!   background registration (which does not take `bono_lock`, so a payment never waits for it). Each use holds a
//!   [`WalletLease`]: the first opens the wallet and the last closes it. Opening and closing happen under `gate`, so a
//!   close never pulls the wallet from under a use that just started.
//! - A use dropped without going through `Orchestrator::leave_wallet` (task aborted on lock or exit) only decrements
//!   the count without closing: closing the session then calls `Orchestrator::shutdown`, which closes the wallet (or,
//!   with a `buyBono` possibly in flight, leaves it to the sidecar). That task's `registerDust` does not continue:
//!   dropping the call sends `$/cancel` (`rpc.rs`).
//! - One registration at a time (`registering`): the payment's own (`prepare_wallet`) waits for the background one,
//!   after which the sidecar finds nothing left to register (no double registration).

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use ts_rs::TS;

use super::ports::{Chain, Issuer, Relayer};
use super::{Orchestrator, Result};
use super::chain::data_of;
use crate::protocol::{WalletBalance, WalletProblem, WalletUnavailableData, codes};
use crate::rpc::RpcError;

/// The background registration, for the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub enum DustSetup {
    /// Nothing to show: no unregistered NIGHT, or already registered.
    Idle,
    /// Registering NIGHT in the background.
    Activating,
    /// The last background registration failed and unregistered NIGHT remains: not retried until more NIGHT arrives
    /// or the app restarts.
    Failed,
}

/// What is known about the background registration. In memory only.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SetupState {
    #[default]
    Idle,
    Running,
    /// Finished with `night` NIGHT in the wallet: not repeated until there is more.
    Done { night: u128, failed: bool },
}

fn amount(text: &str) -> u128 {
    text.parse().unwrap_or(0)
}

/// Should a background registration run? With unregistered NIGHT and nothing running; after an attempt, only with more
/// NIGHT than then. Returns the current NIGHT (recorded when it finishes).
pub(crate) fn wants_setup(state: SetupState, balance: &WalletBalance) -> Option<u128> {
    let night = amount(&balance.night);
    if amount(&balance.unregistered_night) == 0 {
        return None;
    }
    match state {
        SetupState::Idle => Some(night),
        SetupState::Running => None,
        SetupState::Done { night: before, .. } => (night > before).then_some(night),
    }
}

pub(crate) fn setup_view(state: SetupState, balance: &WalletBalance) -> DustSetup {
    match state {
        SetupState::Running => DustSetup::Activating,
        SetupState::Done { failed: true, .. } if amount(&balance.unregistered_night) > 0 => DustSetup::Failed,
        _ => DustSetup::Idle,
    }
}

/// One use of the sidecar wallet (counted until dropped; [`Orchestrator::leave_wallet`] does the closing).
pub(crate) struct WalletLease {
    users: Arc<AtomicU32>,
}

impl Drop for WalletLease {
    fn drop(&mut self) {
        self.users.fetch_sub(1, Ordering::SeqCst);
    }
}

/// The shared wallet and the background registration.
#[derive(Default)]
pub(crate) struct WalletShare {
    users: Arc<AtomicU32>,
    /// Opening and closing the wallet.
    gate: tokio::sync::Mutex<()>,
    /// One `wallet.registerDust` at a time.
    registering: tokio::sync::Mutex<()>,
    setup: Arc<Mutex<SetupState>>,
}

impl WalletShare {
    fn lease(&self) -> WalletLease {
        self.users.fetch_add(1, Ordering::SeqCst);
        WalletLease { users: Arc::clone(&self.users) }
    }

    fn setup(&self) -> std::sync::MutexGuard<'_, SetupState> {
        self.setup.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// The claimed background registration, with the wallet left open by the read that claimed it. Dropping it unfinished
/// (task aborted on lock or exit) restores the state to what it was before the claim.
pub struct DustClaim {
    setup: Arc<Mutex<SetupState>>,
    night: u128,
    lease: Option<WalletLease>,
    finished: bool,
}

impl std::fmt::Debug for DustClaim {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DustClaim").finish_non_exhaustive()
    }
}

impl DustClaim {
    fn finish(mut self, failed: bool) {
        *self.setup.lock().unwrap_or_else(|e| e.into_inner()) = SetupState::Done { night: self.night, failed };
        self.finished = true;
    }
}

impl Drop for DustClaim {
    fn drop(&mut self) {
        if !self.finished {
            *self.setup.lock().unwrap_or_else(|e| e.into_inner()) = SetupState::Idle;
        }
    }
}

impl<C, I, R> Orchestrator<C, I, R> {
    /// Claims the background registration if due (see [`wants_setup`]). Only with the wallet open (within a use).
    pub(crate) fn claim_dust_setup(&self, balance: &WalletBalance) -> Option<DustClaim> {
        let share = &self.wallet_share;
        let mut state = share.setup();
        let night = wants_setup(*state, balance)?;
        *state = SetupState::Running;
        Some(DustClaim { setup: Arc::clone(&share.setup), night, lease: Some(share.lease()), finished: false })
    }

    pub(crate) fn dust_setup(&self, balance: &WalletBalance) -> DustSetup {
        setup_view(*self.wallet_share.setup(), balance)
    }
}

impl<C: Chain, I: Issuer, R: Relayer> Orchestrator<C, I, R> {
    /// Runs `work` with the wallet open (opening it if unused) and closes it if this is the last use.
    pub(crate) async fn with_wallet<T, F>(&self, work: F) -> Result<T>
    where
        F: Future<Output = Result<T>>,
    {
        let lease = self.wallet_share.lease();
        let result = async {
            self.open_shared().await?;
            work.await
        }
        .await;
        self.leave_wallet(lease).await;
        result
    }

    async fn open_shared(&self) -> Result<()> {
        let _gate = self.wallet_share.gate.lock().await;
        self.open_wallet().await
    }

    async fn leave_wallet(&self, lease: WalletLease) {
        let _gate = self.wallet_share.gate.lock().await;
        drop(lease);
        if self.wallet_share.users.load(Ordering::SeqCst) == 0 {
            self.close_wallet_if_idle().await;
        }
    }

    /// The payment's `wallet.registerDust`: waits for a running background registration (after which nothing is left).
    pub(crate) async fn register_dust(&self) -> Result<bool> {
        let _one = self.wallet_share.registering.lock().await;
        let chain = &self.d.chain;
        Ok(self.call_sidecar(false, |_| chain.wallet_register_dust()).await?.registered)
    }

    /// Background read (once at unlock): opens and syncs the wallet and claims the registration if due. Without
    /// `bono_lock`: it does not hold up a payment or clash with `resume` (it shares the wallet like any use).
    pub async fn check_dust(&self) -> Result<Option<DustClaim>> {
        self.with_wallet(async { Ok(self.claim_dust_setup(&self.sync_wallet().await?)) }).await
    }

    /// The claimed background registration: no retries (a failure waits for more NIGHT or an app restart), except once
    /// after resyncing if the wallet was behind (`not-synced`). Does not take `bono_lock`. Returns `false` on failure.
    pub async fn setup_dust(&self, mut claim: DustClaim) -> bool {
        let lease = claim.lease.take();
        let registered = {
            let _one = self.wallet_share.registering.lock().await;
            match self.d.chain.wallet_register_dust().await {
                Err(e) if not_synced(&e) && self.sync_wallet().await.is_ok() => self.d.chain.wallet_register_dust().await,
                other => other,
            }
        };
        if let Some(lease) = lease {
            self.leave_wallet(lease).await;
        }
        claim.finish(registered.is_err());
        registered.is_ok()
    }
}

fn not_synced(error: &RpcError) -> bool {
    let RpcError::Remote { code: codes::WALLET_UNAVAILABLE, data, .. } = error else { return false };
    data_of::<WalletUnavailableData>(data).is_some_and(|d| d.reason == WalletProblem::NotSynced)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn balance(night: &str, unregistered: &str) -> WalletBalance {
        WalletBalance {
            synced: true,
            night: night.into(),
            unregistered_night: unregistered.into(),
            dust: "0".into(),
            dust_coins: 0,
            tokens: vec![],
        }
    }

    #[test]
    fn background_setup_only_with_unregistered_night_and_never_twice_for_the_same_night() {
        let done = |night, failed| SetupState::Done { night, failed };
        assert_eq!(wants_setup(SetupState::Idle, &balance("10", "10")), Some(10));
        assert_eq!(wants_setup(SetupState::Idle, &balance("10", "0")), None, "all registered");
        assert_eq!(wants_setup(SetupState::Idle, &balance("x", "y")), None, "unreadable: nothing");
        assert_eq!(wants_setup(SetupState::Running, &balance("10", "10")), None, "already running");
        assert_eq!(wants_setup(done(10, true), &balance("10", "10")), None, "failed with this NIGHT: no loop");
        assert_eq!(wants_setup(done(10, false), &balance("10", "10")), None, "the wallet does not see it registered yet");
        assert_eq!(wants_setup(done(10, true), &balance("15", "15")), Some(15), "more NIGHT arrived");
        assert_eq!(wants_setup(done(10, false), &balance("12", "2")), Some(12));
    }

    #[test]
    fn the_view_shows_activating_and_a_failure_only_while_night_is_unregistered() {
        let failed = SetupState::Done { night: 10, failed: true };
        assert_eq!(setup_view(SetupState::Running, &balance("10", "10")), DustSetup::Activating);
        assert_eq!(setup_view(failed, &balance("10", "10")), DustSetup::Failed);
        assert_eq!(setup_view(failed, &balance("10", "0")), DustSetup::Idle, "a payment registered it later");
        assert_eq!(setup_view(SetupState::Done { night: 10, failed: false }, &balance("10", "10")), DustSetup::Idle);
        assert_eq!(setup_view(SetupState::Idle, &balance("10", "10")), DustSetup::Idle);
    }
}
