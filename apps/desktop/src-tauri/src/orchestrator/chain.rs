//! Sidecar calls with the shared error policy (transient errors, `STALE_STATE`, the `minLeafCount` ratchet) and the
//! paginated view of the contract state. Used by the orchestrator and `Recovery`.

use std::collections::HashSet;
use std::future::Future;

use serde::de::DeserializeOwned;
use serde_json::Value;

use super::ports::{Chain, Issuer, Relayer};
use super::{OrchError, Orchestrator, Progress, Result};
use crate::protocol::{
    AddressEntry, CallProblem, CallRejectedData, ContractFindBonosParams, ContractHashesParams, ContractSnapshot,
    ContractSnapshotParams, HashOp, InsufficientFundsData, NameRejectedData, StaleProblem,
    StaleStateData, WalletUnavailableData, codes,
};
use crate::rpc::RpcError;

/// Time of the last `behind` (`meta`, Unix seconds as 8 big-endian bytes).
const LAST_BEHIND_KEY: &str = "behind.last";
/// With no `behind` for this long, the streak is forgotten (provisional).
const BEHIND_FORGET_S: i64 = 24 * 3600;
/// Maximum operations or leaves per call (`contract.hashes`, `contract.findBonos`).
const BATCH: usize = 1024;

/// Retries already made within one call.
#[derive(Default)]
pub(crate) struct Tries {
    transient: u32,
    behind: u32,
}

/// Typed `data` of a remote error; unintelligible `data` is ignored (`.ok()`, see protocol.rs).
pub(crate) fn data_of<T: DeserializeOwned>(data: &Option<Value>) -> Option<T> {
    data.clone().and_then(|d| serde_json::from_value(d).ok())
}

/// Remote error that retrying will not fix → UI error (without raw `data`). Missing or unintelligible `data` is not
/// disguised as a specific reason: `Internal` (except `CALL_REJECTED`, which has `other`).
pub(crate) fn remote_error(code: i64, data: &Option<Value>) -> OrchError {
    let internal = OrchError::Internal;
    match code {
        codes::CONTRACT_MISMATCH => OrchError::ContractMismatch,
        codes::NAME_REJECTED => {
            data_of::<NameRejectedData>(data).map_or(internal, |d| OrchError::NameRejected { reason: d.reason })
        }
        codes::CALL_REJECTED => OrchError::CallRejected { reason: call_problem(data) },
        codes::WALLET_UNAVAILABLE => {
            data_of::<WalletUnavailableData>(data).map_or(internal, |d| OrchError::Wallet { reason: d.reason })
        }
        codes::INSUFFICIENT_FUNDS => {
            data_of::<InsufficientFundsData>(data).map_or(internal, |d| OrchError::InsufficientFunds { asset: d.asset })
        }
        codes::CONTRACT_NOT_FOUND | codes::NOT_INITIALIZED => OrchError::MidnightUnavailable,
        _ => internal,
    }
}

pub(crate) fn call_problem(data: &Option<Value>) -> CallProblem {
    data_of::<CallRejectedData>(data).map_or(CallProblem::Other, |d| d.reason)
}

/// The registry's public state, read in full (every page, at the same height).
#[derive(Debug, Default)]
pub(crate) struct ChainView {
    pub block_height: u32,
    /// Unix ms.
    pub block_timestamp: u64,
    pub nullifiers: HashSet<String>,
    pub addresses: Vec<AddressEntry>,
}

impl ChainView {
    pub fn address_by_nul(&self, slot_nul: &str) -> Option<&AddressEntry> {
        self.addresses.iter().find(|a| a.slot_nul == slot_nul)
    }

    pub fn has_addr_key(&self, addr_key: &str) -> bool {
        self.addresses.iter().any(|a| a.addr_key == addr_key)
    }

    fn absorb(&mut self, page: ContractSnapshot) -> Result<()> {
        self.block_height = page.block_height;
        self.block_timestamp = page.block_timestamp;
        self.nullifiers.extend(page.slot_nullifiers);
        self.addresses.extend(page.addresses);
        Ok(())
    }
}

/// Midnight block slot (AURA), in seconds: one block per slot, timed at the slot's start. The contract sees block time
/// in whole seconds.
pub(crate) const SLOT_S: u64 = 6;

/// Slot of a block time in Unix ms.
pub(crate) fn slot_of(ms: u64) -> u64 {
    ms / (SLOT_S * 1000)
}

/// How far the node's latest block may be ahead of the indexer's (which follows finalized blocks, measured ~15-20 s
/// behind) for the node to be believed. A node further ahead, or behind the indexer, is lagging, on another chain or
/// lying: the core then waits for the indexer instead. This bounds what a lying node can do: a wait at most this much
/// longer.
pub(crate) const HEAD_AHEAD_MAX_MS: u64 = 45_000;

/// Is the node's block time `head_ms` believable against the indexer's `indexer_ms`?
pub(crate) fn plausible_head(head_ms: u64, indexer_ms: u64) -> bool {
    head_ms >= indexer_ms && head_ms - indexer_ms <= HEAD_AHEAD_MAX_MS
}

impl<C: Chain, I: Issuer, R: Relayer> Orchestrator<C, I, R> {
    /// Calls the sidecar with the shared policy. With `ratchet`, `call` receives the stored `minLeafCount` and, with
    /// the `behind` streak at its cap, no call is made (`StaleState` until the user acts, see `ratchet`). A success does not reset
    /// the streak, so a `findBonos` succeeding between polls cannot bypass it.
    pub(crate) async fn call_sidecar<T, F, Fut>(&self, ratchet: bool, mut call: F) -> Result<T>
    where
        F: FnMut(Option<u32>) -> Fut,
        Fut: Future<Output = std::result::Result<T, RpcError>>,
    {
        let mut tries = Tries::default();
        loop {
            let min = if ratchet { Some(self.ratchet().await?) } else { None };
            match call(min).await {
                Ok(value) => return Ok(value),
                Err(e) => self.on_rpc_error(e, &mut tries).await?,
            }
        }
    }

    /// Decides what to do on an error: `Ok(())` means the wait is done and a retry may follow.
    pub(crate) async fn on_rpc_error(&self, error: RpcError, tries: &mut Tries) -> Result<()> {
        match error {
            RpcError::Timeout | RpcError::Closed => self.transient(tries).await,
            RpcError::Remote { code: codes::UPSTREAM_UNAVAILABLE | codes::PROVER_UNAVAILABLE, .. } => {
                self.transient(tries).await
            }
            RpcError::Remote { code: codes::STALE_STATE, data, .. } => self.stale(data_of(&data), tries).await,
            RpcError::Remote { code, data, .. } => Err(remote_error(code, &data)),
            RpcError::BadResponse(_) | RpcError::Encode(_) => Err(OrchError::Internal),
        }
    }

    async fn transient(&self, tries: &mut Tries) -> Result<()> {
        tries.transient += 1;
        if tries.transient > self.d.config.retry.max_transient {
            return Err(OrchError::MidnightUnavailable);
        }
        self.emit(Progress::Retrying);
        self.sleep(self.d.config.retry.transient_wait).await;
        Ok(())
    }

    /// `future` is not fixed by retrying (clock); `behind` with its caps; `old` (or unknown `data`) as a transient
    /// failure. `ageMs` does not leave this function.
    async fn stale(&self, data: Option<StaleStateData>, tries: &mut Tries) -> Result<()> {
        match data {
            Some(d) if d.reason == StaleProblem::Future => Err(OrchError::Clock),
            Some(d) if d.reason == StaleProblem::Behind => self.behind(tries).await,
            _ => self.transient(tries).await,
        }
    }

    /// Only one of our own leaves raises the ratchet (position + 1), so a `behind` is an indexer lagging or hiding
    /// leaves. No automatic reset (provisional). It counts towards the persisted global streak (bisection across
    /// operations raises it too); at the cap, a persistent `StaleState`; within one operation, at most `max_behind`
    /// retries with random backoff.
    async fn behind(&self, tries: &mut Tries) -> Result<()> {
        let retry = self.d.config.retry;
        let now = self.now().to_be_bytes();
        let streak = self
            .db(move |s| {
                s.set_meta(LAST_BEHIND_KEY, &now)?;
                s.increment_behind_streak()
            })
            .await?;
        tries.behind += 1;
        if streak >= retry.behind_halt || tries.behind > retry.max_behind {
            return Err(OrchError::StaleState);
        }
        let poll = self.d.config.pacing.poll;
        self.sleep(self.random_between((poll, poll * 3))).await;
        Ok(())
    }

    /// Stored `minLeafCount`, or `StaleState` if the `behind` streak is at its cap. The streak only resets with one of
    /// our proofs included (`prove.rs`), after 24 h without `behind`, or when the user acts (`retry_stale`, or an
    /// address operation they ask for: `sync_for_user_address_op`).
    async fn ratchet(&self) -> Result<u32> {
        let now = self.now();
        let cursor = self
            .db(move |s| {
                let last = s.get_meta(LAST_BEHIND_KEY)?.and_then(|v| <[u8; 8]>::try_from(v.as_slice()).ok());
                if last.is_some_and(|l| now - i64::from_be_bytes(l) > BEHIND_FORGET_S) {
                    s.reset_behind_streak()?;
                }
                s.get_chain_cursor()
            })
            .await?;
        if cursor.behind_streak >= self.d.config.retry.behind_halt {
            return Err(OrchError::StaleState);
        }
        Ok(cursor.min_leaf_count)
    }

    /// `contract.hashes` in batches of 1024; one result per operation, in order.
    pub(crate) async fn hash_all(&self, ops: Vec<HashOp>) -> Result<Vec<String>> {
        let mut out = Vec::with_capacity(ops.len());
        for chunk in ops.chunks(BATCH) {
            let (chain, contract) = (&self.d.chain, self.contract());
            let result = self
                .call_sidecar(false, |_| {
                    let params = ContractHashesParams { contract_address: contract.clone(), ops: chunk.to_vec() };
                    async move { chain.hashes(&params).await }
                })
                .await?;
            if result.results.len() != chunk.len() {
                return Err(OrchError::Internal);
            }
            out.extend(result.results);
        }
        Ok(out)
    }

    pub(crate) async fn hash(&self, op: HashOp) -> Result<String> {
        self.hash_all(vec![op]).await?.pop().ok_or(OrchError::Internal)
    }

    /// `contract.findBonos` in batches, with the ratchet: `(tree leaf count, position of each requested leaf)`.
    pub(crate) async fn find_leaves(&self, leaves: &[String]) -> Result<(u32, Vec<Option<u32>>)> {
        let (mut leaf_count, mut positions) = (0, Vec::with_capacity(leaves.len()));
        for chunk in leaves.chunks(BATCH) {
            let (chain, contract) = (&self.d.chain, self.contract());
            let result = self
                .call_sidecar(true, |min| {
                    let params = ContractFindBonosParams {
                        contract_address: contract.clone(),
                        leaves: chunk.to_vec(),
                        min_leaf_count: min,
                    };
                    async move { chain.find_bonos(&params).await }
                })
                .await?;
            if result.positions.len() != chunk.len() {
                return Err(OrchError::Internal);
            }
            leaf_count = leaf_count.max(result.leaf_count);
            positions.extend(result.positions);
        }
        Ok((leaf_count, positions))
    }

    /// One page of the state; `None` if the cursor expired (`SNAPSHOT_EXPIRED`: start over).
    async fn snapshot_page(
        &self,
        cursor: Option<crate::protocol::SnapshotCursor>,
        limit: Option<u32>,
    ) -> Result<Option<ContractSnapshot>> {
        let (chain, contract) = (&self.d.chain, self.contract());
        self.call_sidecar(false, |_| {
            let params = ContractSnapshotParams { contract_address: contract.clone(), cursor: cursor.clone(), limit };
            async move {
                match chain.snapshot(&params).await {
                    Err(RpcError::Remote { code: codes::SNAPSHOT_EXPIRED, .. }) => Ok(None),
                    other => other.map(Some),
                }
            }
        })
        .await
    }

    /// Minimal first page: height, block time, price.
    pub(crate) async fn head(&self) -> Result<ContractSnapshot> {
        self.snapshot_page(None, Some(1)).await?.ok_or(OrchError::Internal)
    }

    /// The whole state (one walk at a time: the sidecar only keeps the latest). An expired cursor starts over, with a
    /// cap.
    pub(crate) async fn chain_view(&self) -> Result<ChainView> {
        for _ in 0..=self.d.config.retry.max_transient {
            if let Some(view) = self.try_chain_view().await? {
                return Ok(view);
            }
        }
        Err(OrchError::MidnightUnavailable)
    }

    async fn try_chain_view(&self) -> Result<Option<ChainView>> {
        let (mut view, mut cursor) = (ChainView::default(), None);
        loop {
            let Some(page) = self.snapshot_page(cursor, None).await? else { return Ok(None) };
            cursor = page.next.clone();
            view.absorb(page)?;
            if cursor.is_none() {
                return Ok(Some(view));
            }
        }
    }

    /// Waits (capped) until `done` holds on the state head.
    pub(crate) async fn wait_head(&self, done: impl Fn(&ContractSnapshot) -> bool) -> Result<ContractSnapshot> {
        for _ in 0..self.d.config.pacing.max_polls {
            let head = self.head().await?;
            if done(&head) {
                return Ok(head);
            }
            self.sleep(self.d.config.pacing.poll).await;
        }
        Err(OrchError::StillPending)
    }

    /// Waits for the indexer to move past the block that was proved against (before a new proof).
    pub(crate) async fn wait_block_after(&self, height: u32) -> Result<()> {
        self.wait_head(|h| h.block_height > height).await.map(drop)
    }

    /// The node's latest block time (Unix ms, `chain.head`) if it answers and is believable against the indexer's
    /// block time `indexer_ms` ([`plausible_head`]); otherwise `None` and the caller uses the indexer. If the node is
    /// further ahead than allowed, `indexer_ms` may just be old (read before a wait): it is read again once.
    pub(crate) async fn node_head(&self, indexer_ms: &mut u64) -> Option<u64> {
        let head = self.d.chain.head().await.ok()?.timestamp;
        if plausible_head(head, *indexer_ms) {
            return Some(head);
        }
        if head > *indexer_ms {
            let fresh = self.head().await.ok()?.block_timestamp;
            *indexer_ms = (*indexer_ms).max(fresh);
        }
        plausible_head(head, *indexer_ms).then_some(head)
    }

    /// Before another proof for a slot that already sent one: waits (capped) until the indexer shows the block the
    /// node had when this was called, so a proof sent earlier that landed (the relayer answers once it is in a block,
    /// before the indexer, which follows finalized blocks, shows it) is seen instead of being proved again, which the
    /// node would reject. Without a believable node block time it returns at once: the caller reads the chain as
    /// before.
    pub(crate) async fn catch_up_with_node(&self) -> Result<()> {
        let mut indexer_ms = self.head().await?.block_timestamp;
        let Some(head) = self.node_head(&mut indexer_ms).await else { return Ok(()) };
        if indexer_ms >= head {
            return Ok(());
        }
        self.wait_head(|h| h.block_timestamp >= head).await.map(drop)
    }
}
