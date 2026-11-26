//! One proof and its submission to the relayer:
//! - before proving, the relayer must answer (`wait_for_relayer`): nothing is proved while the server is down;
//! - `busy` or a network failure before the relayer accepts it → the same bytes after a wait, capped;
//! - each distinct proof counts as a slot attempt once the relayer receives it; a `not-a-bono` rejection counts too
//!   (an indexer hiding the leaf could otherwise recognise the bono through the retries);
//! - `expired`/`rejected`/`failed`/`unknown`/`bad-ttl` → `Retry` after a later block: the caller checks the chain
//!   again before asking for another proof (the previous one may have landed).
//!
//! The per-slot proof cap is checked by the steps in `addresses.rs`, after looking at the chain.

use std::sync::atomic::Ordering;

use super::ports::{Chain, Issuer, RelayError, RelayOutcome, Relayer, Submitted, TicketState};
use super::{OrchError, Orchestrator, Progress, Result};
use crate::protocol::{CallProblem, ContractProveCallParams, ContractProveCallResult, ProveCall};
use crate::store::{AttemptKind, SlotKey};

/// How a call ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Relayed {
    Included,
    /// The contract rejected it locally (nothing was proved or sent).
    Rejected(CallProblem),
    /// Not known to have landed: check the chain and, if absent, make another proof.
    Retry,
}

/// What to do after a submission.
enum RelayEnd {
    Included,
    Reprove,
}

fn relay_error(error: RelayError) -> OrchError {
    match error {
        RelayError::RateLimited { retry_after_s } => OrchError::RateLimited { retry_after_s },
        RelayError::NotRelayable => OrchError::RelayerRefused,
        RelayError::Unreachable => OrchError::ServerUnreachable,
        RelayError::BadConfig => OrchError::BadConfig,
        RelayError::NotFound | RelayError::Unavailable | RelayError::BadResponse => OrchError::ServiceUnavailable,
    }
}

/// Reason for waiting before calling the relayer or Issuer again: what is shown meanwhile and the error once exhausted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Holdup {
    /// It answered "busy" or with an error.
    Busy,
    /// It did not answer (connection refused or deadline passed).
    Unreachable,
}

impl Holdup {
    fn progress(self) -> Progress {
        match self {
            Holdup::Busy => Progress::Retrying,
            Holdup::Unreachable => Progress::ServerUnreachable,
        }
    }

    fn error(self) -> OrchError {
        match self {
            Holdup::Busy => OrchError::ServiceUnavailable,
            Holdup::Unreachable => OrchError::ServerUnreachable,
        }
    }
}

/// Did the relayer receive the proof? It accepted it (ticket), looked at it and rejected it (`bad-ttl`, a 4xx about
/// the transaction), or gave an unintelligible answer (it may have accepted it). "Busy", 429, 5xx and no answer: not
/// received.
fn received(reply: &std::result::Result<Submitted, RelayError>) -> bool {
    matches!(
        reply,
        Ok(Submitted::Ticket(_) | Submitted::BadTtl) | Err(RelayError::NotRelayable | RelayError::BadResponse)
    )
}

/// Ticket polls before leaving it as `StillPending` (the same ticket while it stays queued).
const TICKET_POLL_FACTOR: u32 = 3;

impl<C: Chain, I: Issuer, R: Relayer> Orchestrator<C, I, R> {
    /// One proof of `call` and its submission; accepted attempts count on slot `slot` (counter `attempt`).
    pub(crate) async fn prove_and_relay(
        &self,
        call: &ProveCall,
        slot: SlotKey,
        attempt: AttemptKind,
    ) -> Result<Relayed> {
        self.relay_allowed()?;
        self.wait_for_relayer().await?;
        let proved = match self.prove(call).await {
            Ok(proved) => proved,
            Err(OrchError::CallRejected { reason }) => {
                if reason == CallProblem::NotABono {
                    self.count_attempt(slot, attempt).await?;
                }
                return Ok(Relayed::Rejected(reason));
            }
            Err(e) => return Err(e),
        };
        let end = self.relay(&proved.tx, slot, attempt).await.inspect_err(|e| self.note_rate_limit(*e))?;
        match end {
            RelayEnd::Included => {
                // One of our proofs was included, so the indexer was up to date.
                self.db(|s| s.reset_behind_streak()).await?;
                Ok(Relayed::Included)
            }
            RelayEnd::Reprove => {
                self.wait_block_after(proved.block_height).await?;
                Ok(Relayed::Retry)
            }
        }
    }

    /// With a relayer 429 still in force, `RateLimited` with the remaining time, without proving or counting anything.
    fn relay_allowed(&self) -> Result<()> {
        let until = self.relay_not_before.load(Ordering::SeqCst);
        let now = self.now();
        if now < until { Err(OrchError::RateLimited { retry_after_s: (until - now) as u64 }) } else { Ok(()) }
    }

    /// Before proving, the relayer must answer. Proving costs minutes of CPU, and a proof that cannot be sent is
    /// useless for the next turn (it carries a TTL and is computed over the current chain state). With no answer it
    /// waits like a resend (`Holdup::Unreachable`) and, if still silent, returns `ServerUnreachable` without having
    /// proved or counted any slot attempt. If the relayer goes down during the proof, `relay` resends the same bytes.
    async fn wait_for_relayer(&self) -> Result<()> {
        let mut tries = 0;
        while !self.d.relayer.reachable().await {
            self.busy_wait(&mut tries, self.d.config.retry.transient_wait.as_secs(), Holdup::Unreachable).await?;
        }
        Ok(())
    }

    /// Records until when the relayer asked us not to come back.
    fn note_rate_limit(&self, error: OrchError) {
        if let OrchError::RateLimited { retry_after_s } = error {
            let until = self.now().saturating_add(i64::try_from(retry_after_s).unwrap_or(i64::MAX));
            self.relay_not_before.fetch_max(until, Ordering::SeqCst);
        }
    }

    async fn count_attempt(&self, slot: SlotKey, attempt: AttemptKind) -> Result<()> {
        let now = self.now();
        self.db(move |s| s.bump_slot_attempts(slot, attempt, now)).await.map(drop)
    }

    /// `contract.proveCall` with the ratchet and the shared policy; `CALL_REJECTED` comes out as `CallRejected`.
    pub(crate) async fn prove(&self, call: &ProveCall) -> Result<ContractProveCallResult> {
        self.emit(Progress::Proving);
        let (chain, contract) = (&self.d.chain, self.contract());
        self.call_sidecar(true, |min| {
            let params =
                ContractProveCallParams { contract_address: contract.clone(), call: call.clone(), min_leaf_count: min };
            async move { chain.prove_call(&params).await }
        })
        .await
    }

    async fn relay(&self, tx: &str, slot: SlotKey, attempt: AttemptKind) -> Result<RelayEnd> {
        self.emit(Progress::Relaying);
        let mut busy = 0;
        let mut counted = false;
        loop {
            let transient = self.d.config.retry.transient_wait.as_secs();
            let reply = self.d.relayer.submit(tx).await;
            // Each distinct proof counts once, when the relayer receives it (accepts it, or looks at it and rejects
            // it); resending the same bytes does not count. If it never got it (no answer, 5xx, "busy", 429), it
            // does not count: the relayer may go down during the proof.
            if !counted && received(&reply) {
                self.count_attempt(slot, attempt).await?;
                counted = true;
            }
            let (wait, holdup) = match reply {
                Ok(Submitted::BadTtl) => return Ok(RelayEnd::Reprove),
                Ok(Submitted::Busy { retry_after_s }) => (retry_after_s, Holdup::Busy),
                Err(RelayError::Unavailable) => (transient, Holdup::Busy),
                Err(RelayError::Unreachable) => (transient, Holdup::Unreachable),
                Err(e) => return Err(relay_error(e)),
                Ok(Submitted::Ticket(ticket)) => match self.poll_ticket(&ticket).await? {
                    RelayOutcome::Included => return Ok(RelayEnd::Included),
                    RelayOutcome::Refused => return Err(OrchError::RelayerRefused),
                    RelayOutcome::Busy { retry_after_s } => (retry_after_s, Holdup::Busy),
                    RelayOutcome::Expired | RelayOutcome::Rejected | RelayOutcome::Unknown | RelayOutcome::Failed => {
                        return Ok(RelayEnd::Reprove);
                    }
                },
            };
            self.busy_wait(&mut busy, wait, holdup).await?;
        }
    }

    /// Waits before calling the relayer or Issuer again, with a cap on count and duration. When exhausted, the error
    /// of the last wait: `ServerUnreachable` if it still does not answer, `ServiceUnavailable` if it answers but does
    /// not serve.
    pub(crate) async fn busy_wait(&self, busy: &mut u32, retry_after_s: u64, holdup: Holdup) -> Result<()> {
        *busy += 1;
        let retry = self.d.config.retry;
        if *busy > retry.max_busy {
            return Err(holdup.error());
        }
        self.emit(holdup.progress());
        self.sleep(std::time::Duration::from_secs(retry_after_s).min(retry.max_busy_wait)).await;
        Ok(())
    }

    /// Polls the same ticket until it finishes. Lost ticket (404) = `unknown`; still queued after the cap →
    /// `StillPending` (the slot keeps its counted attempt; `resume` checks the chain before another proof).
    async fn poll_ticket(&self, ticket: &str) -> Result<RelayOutcome> {
        for _ in 0..self.d.config.pacing.max_polls * TICKET_POLL_FACTOR {
            match self.d.relayer.status(ticket).await {
                Ok(TicketState::Done(outcome)) => return Ok(outcome),
                Ok(TicketState::Queued) | Err(RelayError::Unavailable | RelayError::Unreachable) => {}
                Err(RelayError::NotFound) => return Ok(RelayOutcome::Unknown),
                Err(e) => return Err(relay_error(e)),
            }
            self.sleep(self.d.config.pacing.poll).await;
        }
        Err(OrchError::StillPending)
    }
}
