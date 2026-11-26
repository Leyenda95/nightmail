//! Test doubles: a sidecar with the contract state in memory (fake but deterministic hashes, and the same checks as
//! the contract: leaf, quota, nullifier, round, commitment), a relayer that applies transactions to that state, an
//! Issuer that signs real receipts, and a clock that advances on sleep. Each double accepts scripted answers
//! (`script_*`) for the error paths.

use std::collections::{BTreeSet, HashMap, VecDeque};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use ed25519_dalek::{Signer, SigningKey};
use serde_json::json;
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tokio::sync::mpsc;

use super::http::receipt_message;
use super::ports::*;
use super::{Deps, Orchestrator, OrchestratorConfig, Pacing, Progress, RetryPolicy};
use crate::keys::KeyManager;
use crate::protocol::*;
use crate::rpc::RpcError;
use crate::store::{LocalStore, StoreScope};

pub const CONTRACT: &str = "0a739f6611111111111111111111111111111111111111111111111111111111";
pub const PRICE: &str = "1000000";
/// Initial time of the fake clock (Unix seconds).
pub const START: u64 = 1_800_000_000;
const ISSUER_SEED: [u8; 32] = [7; 32];

pub fn remote(code: i64, data: serde_json::Value) -> RpcError {
    RpcError::Remote { code, message: String::new(), data: Some(data) }
}

pub fn rejected(reason: &str) -> RpcError {
    remote(codes::CALL_REJECTED, json!({ "reason": reason }))
}

pub fn stale(reason: &str, age_ms: i64) -> RpcError {
    remote(codes::STALE_STATE, json!({ "reason": reason, "ageMs": age_ms, "leafCount": 0 }))
}

fn h(parts: &[&str]) -> String {
    hex::encode(Sha256::digest(parts.join("|").as_bytes()))
}

fn plan_text(plan: Plan) -> &'static str {
    if plan == Plan::Paid { "paid" } else { "free" }
}

fn kind_text(kind: AddressKind) -> &'static str {
    if kind == AddressKind::Alias { "alias" } else { "mailbox" }
}

fn limit(plan: Plan, kind: AddressKind) -> u8 {
    match (plan, kind) {
        (Plan::Free, AddressKind::Mailbox) => 1,
        (Plan::Free, AddressKind::Alias) => 2,
        (Plan::Paid, AddressKind::Mailbox) => 5,
        (Plan::Paid, AddressKind::Alias) => 20,
    }
}

/// Fake normalisation: lowercase; `admin` reserved; empty, with spaces or with `..`, invalid; alias shape rejected.
fn normalize(name: &str) -> Result<String, RpcError> {
    let n = name.trim().to_lowercase();
    let reason = if n.is_empty() || n.contains(' ') || n.contains("..") {
        "invalid"
    } else if n == "admin" {
        "reserved"
    } else if super::addresses::alias_form(&n) {
        "alias-form"
    } else {
        return Ok(n);
    };
    Err(remote(codes::NAME_REJECTED, json!({ "reason": reason })))
}

pub fn id_k(s: &str, k: u32) -> String {
    h(&["id", s, &k.to_string()])
}

pub fn leaf(id: &str, plan: Plan) -> String {
    h(&["leaf", id, plan_text(plan), &u32::MAX.to_string()])
}

fn slot_nul(s: &str, kind: AddressKind, j: u8) -> String {
    h(&["nul", s, kind_text(kind), &j.to_string(), "0"])
}

fn addr_key(name: &str) -> Result<String, RpcError> {
    Ok(h(&["addr", &normalize(name)?]))
}

pub fn alias_key(enc: &str, auth: &str, nul: &str) -> String {
    h(&["alias", enc, auth, nul])
}

fn commit(addr: &str, enc: &str, auth: &str, salt: &str, nul: &str) -> String {
    h(&["commit", addr, enc, auth, salt, nul])
}

pub fn alias_text(addr_key: &str) -> String {
    format!("nube.verde.{}", &addr_key[..12])
}

fn hash_op(w: &World, op: &HashOp) -> Result<String, RpcError> {
    if let HashOp::AddrKey { name } = op
        && let Some(addr_key) = w.name_keys.get(&normalize(name)?)
    {
        return Ok(addr_key.clone());
    }
    if let HashOp::AliasAddress { addr_key } = op
        && let Some(text) = w.alias_texts.get(addr_key)
    {
        return Ok(text.clone());
    }
    Ok(match op {
        HashOp::IdK { s, k } => id_k(s.expose(), *k),
        HashOp::Leaf { id, plan, .. } => leaf(id, *plan),
        HashOp::SlotNul { s, kind, j, .. } => slot_nul(s.expose(), *kind, *j),
        HashOp::NormalizeName { name } => normalize(name)?,
        HashOp::AddrKey { name } => addr_key(name)?,
        HashOp::AliasAddrKey { enc_pk, auth_pk, slot_nul } => alias_key(enc_pk, auth_pk, slot_nul),
        HashOp::Commit { addr_key, enc_pk, auth_pk, salt, slot_nul } => {
            commit(addr_key, enc_pk, auth_pk, salt.expose(), slot_nul)
        }
        HashOp::AliasAddress { addr_key } => alias_text(addr_key),
    })
}

/// What a proved transaction does when it lands.
#[derive(Debug, Clone)]
enum Effect {
    Reserve { nul: String, pending: PendingNameEntry },
    Alias { entry: AddressEntry },
    Reveal { entry: AddressEntry },
}

/// State of the contract and the doubles.
#[derive(Default)]
pub struct World {
    pub leaves: Vec<String>,
    pub nullifiers: BTreeSet<String>,
    pub addresses: Vec<AddressEntry>,
    pub pending: Vec<PendingNameEntry>,
    pub round: u64,
    pub block: u32,
    /// Every state read advances the round (the server's RoundTicker).
    pub auto_round: bool,
    /// Items per page for `contract.snapshot` without a limit.
    pub page: usize,
    txs: HashMap<String, Effect>,
    /// Slots/ids issued by the Issuer and how many polls remain.
    issuing: HashMap<String, (Plan, u32)>,
    pub issue_delay: u32,
    pub wallet_open: bool,
    pub dust_coins: u32,
    pub methods: Vec<String>,
    pub protocol: String,
    /// Calls made (method), in order.
    pub calls: Vec<String>,
    pub script_prove: VecDeque<RpcError>,
    pub script_find: VecDeque<RpcError>,
    pub script_snapshot: VecDeque<RpcError>,
    pub script_buy: VecDeque<RpcError>,
    pub script_open: VecDeque<RpcError>,
    pub script_faucet: VecDeque<RpcError>,
    /// Wallet NIGHT (units) and whether `registerDust` finds nothing to register.
    pub night: u64,
    pub register_nothing: bool,
    /// Answers of `Relayer::reachable` (empty: it answers).
    pub script_reachable: VecDeque<bool>,
    /// The part of `night` not registered for DUST (`wallet.sync`); `registerDust` sets it to 0.
    pub unregistered_night: u64,
    /// Errors for the next `registerDust` calls.
    pub script_register: VecDeque<RpcError>,
    /// The next `registerDust` call waits for a permit from this semaphore (later ones do not wait).
    pub register_gate: Option<Arc<tokio::sync::Semaphore>>,
    /// What each successful `registerDust` returned (`registered`).
    pub register_results: Vec<bool>,
    pub script_submit: VecDeque<Result<Submitted, RelayError>>,
    pub script_status: VecDeque<Result<TicketState, RelayError>>,
    pub script_issue: VecDeque<Result<IssueReply, IssuerError>>,
    pub script_issue_status: VecDeque<Result<IssueReply, IssuerError>>,
    /// Sign receipts with another key.
    pub forge_receipts: bool,
    pub min_leaf_seen: Vec<Option<u32>>,
    /// Foreign addresses that appear after the next transaction lands (a race for a name).
    pub after_apply: Vec<AddressEntry>,
    /// Transactions that land but the relayer reports as `unknown`.
    pub report_unknown: u32,
    /// Insertion deadline signed by the fake Issuer.
    pub insert_by: u64,
    /// Rounds proposed in each proved `reserveMailbox`.
    pub reserve_rounds: Vec<u64>,
    /// `wallet.open` reports it set the saved state aside.
    pub state_discarded: bool,
    /// Block time of every state read (Unix ms).
    pub block_time_ms: u64,
    /// `addrKey` of these normalised names and text of these aliases instead of the fake hashes (real vectors).
    pub name_keys: HashMap<String, String>,
    pub alias_texts: HashMap<String, String>,
}

pub type Shared = Arc<Mutex<World>>;

pub fn world() -> Shared {
    Arc::new(Mutex::new(World {
        page: 2,
        dust_coins: 1,
        insert_by: START + 3000,
        protocol: "1.5".into(),
        methods: super::REQUIRED_METHODS.iter().map(|m| m.to_string()).collect(),
        ..World::default()
    }))
}

impl World {
    fn witness_check(&self, w: &SlotWitnesses, kind: AddressKind) -> Result<String, RpcError> {
        let s = w.s.expose();
        if !self.leaves.contains(&leaf(&id_k(s, w.k), w.plan)) {
            return Err(rejected("not-a-bono"));
        }
        if w.j >= limit(w.plan, kind) {
            return Err(rejected("no-slots-left"));
        }
        let nul = slot_nul(s, kind, w.j);
        if self.nullifiers.contains(&nul) {
            return Err(rejected("slot-already-used"));
        }
        Ok(nul)
    }

    fn effect(&self, call: &ProveCall) -> Result<Effect, RpcError> {
        match call {
            ProveCall::ReserveMailbox { args, witnesses } => {
                let nul = self.witness_check(witnesses, AddressKind::Mailbox)?;
                let r: u64 = args.round.parse().unwrap();
                if self.round > r {
                    return Err(rejected("stale-round"));
                }
                let pending = PendingNameEntry {
                    slot_nul: nul.clone(),
                    reserved_round: args.round.clone(),
                    commit: args.commit.clone(),
                };
                Ok(Effect::Reserve { nul, pending })
            }
            ProveCall::CreateAlias { args, witnesses } => {
                let nul = self.witness_check(witnesses, AddressKind::Alias)?;
                let addr_key = alias_key(&args.enc_pk, &args.auth_pk, &nul);
                let entry = AddressEntry {
                    addr_key,
                    enc_pk: args.enc_pk.clone(),
                    auth_pk: args.auth_pk.clone(),
                    kind: AddressKind::Alias,
                    name_cipher: "00".repeat(104),
                    slot_nul: nul,
                };
                Ok(Effect::Alias { entry })
            }
            ProveCall::RevealMailbox { args } => self.reveal_effect(args),
        }
    }

    fn reveal_effect(&self, a: &RevealMailboxArgs) -> Result<Effect, RpcError> {
        let pending = self.pending.iter().find(|p| p.slot_nul == a.slot_nul).ok_or_else(|| rejected("not-reserved"))?;
        let addr = addr_key(&a.name)?;
        if commit(&addr, &a.enc_pk, &a.auth_pk, a.salt.expose(), &a.slot_nul) != pending.commit {
            return Err(rejected("wrong-reveal"));
        }
        if self.round <= pending.reserved_round.parse::<u64>().unwrap() {
            return Err(rejected("too-early"));
        }
        if self.addresses.iter().any(|x| x.addr_key == addr) {
            return Err(rejected("address-taken"));
        }
        let entry = AddressEntry {
            addr_key: addr,
            enc_pk: a.enc_pk.clone(),
            auth_pk: a.auth_pk.clone(),
            kind: AddressKind::Mailbox,
            name_cipher: a.name_cipher.clone(),
            slot_nul: a.slot_nul.clone(),
        };
        Ok(Effect::Reveal { entry })
    }

    /// Applies a transaction when it enters a block, re-checking it against the state at that moment.
    fn apply(&mut self, effect: Effect) -> bool {
        let ok = match &effect {
            Effect::Reserve { nul, .. } | Effect::Alias { entry: AddressEntry { slot_nul: nul, .. } } => {
                !self.nullifiers.contains(nul)
            }
            Effect::Reveal { entry } => {
                self.pending.iter().any(|p| p.slot_nul == entry.slot_nul)
                    && !self.addresses.iter().any(|a| a.addr_key == entry.addr_key)
            }
        };
        if ok {
            self.block += 1;
            match effect {
                Effect::Reserve { nul, pending } => {
                    self.nullifiers.insert(nul);
                    self.pending.push(pending);
                }
                Effect::Alias { entry } => {
                    self.nullifiers.insert(entry.slot_nul.clone());
                    self.addresses.push(entry);
                }
                Effect::Reveal { entry } => {
                    self.pending.retain(|p| p.slot_nul != entry.slot_nul);
                    self.addresses.push(entry);
                }
            }
            let others = std::mem::take(&mut self.after_apply);
            self.addresses.extend(others);
        }
        ok
    }

    fn behind(&self, min: Option<u32>) -> Result<(), RpcError> {
        match min {
            Some(m) if (self.leaves.len() as u32) < m => Err(stale("behind", 1000)),
            _ => Ok(()),
        }
    }

    /// Issues a bono (what the operator's payer would do).
    pub fn issue(&mut self, id: &str, plan: Plan) {
        let leaf = leaf(id, plan);
        if !self.leaves.contains(&leaf) {
            self.leaves.push(leaf);
            self.block += 1;
        }
    }

    fn snapshot_page(&mut self, cursor: Option<&SnapshotCursor>, limit: Option<u32>) -> ContractSnapshot {
        self.block += 1;
        if self.auto_round && cursor.is_none() {
            self.round += 1;
        }
        let size = limit.map_or(self.page, |l| l as usize);
        let start = |c: Option<&SnapshotCursor>, f: fn(&SnapshotCursor) -> Option<u32>| c.map_or(Some(0), f);
        let (nul_list, nul_next) =
            page(&self.nullifiers.iter().cloned().collect::<Vec<_>>(), start(cursor, |c| c.slot_nullifiers), size);
        let (addresses, addr_next) = page(&self.addresses, start(cursor, |c| c.addresses), size);
        let (pending, pend_next) = page(&self.pending, start(cursor, |c| c.pending_names), size);
        let more = nul_next.is_some() || addr_next.is_some() || pend_next.is_some();
        let next = more.then_some(SnapshotCursor {
            block_height: self.block,
            slot_nullifiers: nul_next,
            addresses: addr_next,
            pending_names: pend_next,
        });
        ContractSnapshot {
            block_height: self.block,
            block_hash: "00".repeat(32),
            block_timestamp: self.block_time_ms,
            round: self.round.to_string(),
            price: PRICE.into(),
            old_prices: vec![],
            bonos: BonosSummary { leaf_count: self.leaves.len() as u32, root: "0".into() },
            totals: SnapshotTotals {
                slot_nullifiers: self.nullifiers.len() as u32,
                addresses: self.addresses.len() as u32,
                pending_names: self.pending.len() as u32,
            },
            slot_nullifiers: nul_list,
            addresses,
            pending_names: pending,
            next,
        }
    }
}

fn page<T: Clone>(all: &[T], start: Option<u32>, size: usize) -> (Vec<T>, Option<u32>) {
    let Some(start) = start.map(|s| s as usize) else { return (Vec::new(), None) };
    let end = (start + size).min(all.len());
    let items = all.get(start..end).map(<[T]>::to_vec).unwrap_or_default();
    (items, (end < all.len()).then_some(end as u32))
}

pub struct FakeChain(pub Shared);

impl FakeChain {
    fn log(&self, method: &str) -> std::sync::MutexGuard<'_, World> {
        let mut w = self.0.lock().unwrap();
        w.calls.push(method.into());
        w
    }
}

impl Chain for FakeChain {
    async fn handshake(&self) -> Result<InitializeResult, RpcError> {
        let w = self.log("initialize");
        Ok(InitializeResult {
            protocol_version: w.protocol.clone(),
            sidecar_version: "0".into(),
            methods: w.methods.clone(),
        })
    }

    async fn hashes(&self, p: &ContractHashesParams) -> Result<ContractHashesResult, RpcError> {
        let w = self.log("contract.hashes");
        let results = p.ops.iter().map(|op| hash_op(&w, op)).collect::<Result<_, _>>()?;
        Ok(ContractHashesResult { ctx: p.contract_address.clone(), results })
    }

    async fn snapshot(&self, p: &ContractSnapshotParams) -> Result<ContractSnapshot, RpcError> {
        let mut w = self.log("contract.snapshot");
        if let Some(e) = w.script_snapshot.pop_front() {
            return Err(e);
        }
        Ok(w.snapshot_page(p.cursor.as_ref(), p.limit))
    }

    async fn find_bonos(&self, p: &ContractFindBonosParams) -> Result<ContractFindBonosResult, RpcError> {
        let mut w = self.log("contract.findBonos");
        w.min_leaf_seen.push(p.min_leaf_count);
        if let Some(e) = w.script_find.pop_front() {
            return Err(e);
        }
        w.behind(p.min_leaf_count)?;
        let positions = p.leaves.iter().map(|l| w.leaves.iter().position(|x| x == l).map(|i| i as u32)).collect();
        Ok(ContractFindBonosResult { block_height: w.block, leaf_count: w.leaves.len() as u32, positions })
    }

    async fn prove_call(&self, p: &ContractProveCallParams) -> Result<ContractProveCallResult, RpcError> {
        let mut w = self.log("contract.proveCall");
        w.min_leaf_seen.push(p.min_leaf_count);
        if let Some(e) = w.script_prove.pop_front() {
            return Err(e);
        }
        if let ProveCall::ReserveMailbox { args, .. } = &p.call {
            w.reserve_rounds.push(args.round.parse().unwrap());
        }
        w.behind(p.min_leaf_count)?;
        let effect = w.effect(&p.call)?;
        let tx = format!("tx{}", w.txs.len());
        w.txs.insert(tx.clone(), effect);
        Ok(ContractProveCallResult { tx, block_height: w.block })
    }

    async fn wallet_open(&self, _p: &WalletOpenParams) -> Result<WalletOpenResult, RpcError> {
        let mut w = self.log("wallet.open");
        if let Some(e) = w.script_open.pop_front() {
            return Err(e);
        }
        if w.wallet_open {
            return Err(remote(codes::WALLET_UNAVAILABLE, json!({ "reason": "already-open" })));
        }
        w.wallet_open = true;
        Ok(WalletOpenResult {
            unshielded_address: "u".into(),
            shielded_address: "s".into(),
            restored: false,
            state_discarded: w.state_discarded,
        })
    }

    async fn wallet_close(&self) -> Result<(), RpcError> {
        let mut w = self.log("wallet.close");
        w.wallet_open = false;
        Ok(())
    }

    async fn wallet_sync(&self) -> Result<WalletBalance, RpcError> {
        let w = self.log("wallet.sync");
        Ok(WalletBalance {
            synced: true,
            night: w.night.to_string(),
            unregistered_night: w.unregistered_night.to_string(),
            dust: "0".into(),
            dust_coins: w.dust_coins,
            tokens: vec![],
        })
    }

    async fn wallet_register_dust(&self) -> Result<WalletRegisterDustResult, RpcError> {
        let gate = self.log("wallet.registerDust").register_gate.take();
        if let Some(gate) = gate {
            gate.acquire().await.unwrap().forget();
        }
        let mut w = self.0.lock().unwrap();
        if let Some(e) = w.script_register.pop_front() {
            return Err(e);
        }
        // With NIGHT modelled (night > 0) and nothing unregistered there is nothing to do, as in the sidecar.
        let nothing = w.register_nothing || (w.night > 0 && w.unregistered_night == 0);
        w.register_results.push(!nothing);
        if nothing {
            return Ok(WalletRegisterDustResult { registered: false });
        }
        w.unregistered_night = 0;
        w.dust_coins = 1;
        Ok(WalletRegisterDustResult { registered: true })
    }

    async fn wallet_faucet(&self, _p: &WalletFaucetParams) -> Result<WalletFaucetResult, RpcError> {
        let mut w = self.log("wallet.faucet");
        if let Some(e) = w.script_faucet.pop_front() {
            return Err(e);
        }
        Ok(WalletFaucetResult { tx_id: "00".repeat(32) })
    }

    async fn wallet_buy_bono(&self, p: &WalletBuyBonoParams) -> Result<WalletBuyBonoResult, RpcError> {
        let mut w = self.log("wallet.buyBono");
        if let Some(e) = w.script_buy.pop_front() {
            return Err(e);
        }
        if !w.wallet_open {
            return Err(remote(codes::WALLET_UNAVAILABLE, json!({ "reason": "not-open" })));
        }
        if p.amount != PRICE {
            return Err(rejected("wrong-amount"));
        }
        let already_included = w.leaves.contains(&leaf(&p.id, Plan::Paid));
        w.issue(&p.id, Plan::Paid);
        Ok(WalletBuyBonoResult { block_height: w.block, already_included })
    }
}

pub struct FakeRelayer(pub Shared);

impl Relayer for FakeRelayer {
    async fn reachable(&self) -> bool {
        let mut w = self.0.lock().unwrap();
        w.calls.push("reach".into());
        w.script_reachable.pop_front().unwrap_or(true)
    }

    async fn submit(&self, tx: &str) -> Result<Submitted, RelayError> {
        let mut w = self.0.lock().unwrap();
        w.calls.push("relay".into());
        w.script_submit.pop_front().unwrap_or_else(|| Ok(Submitted::Ticket(tx.into())))
    }

    async fn status(&self, ticket: &str) -> Result<TicketState, RelayError> {
        let mut w = self.0.lock().unwrap();
        if let Some(scripted) = w.script_status.pop_front() {
            return scripted;
        }
        let effect = w.txs.remove(ticket).ok_or(RelayError::NotFound)?;
        let outcome = match (w.apply(effect), w.report_unknown) {
            (true, 0) => RelayOutcome::Included,
            (true, _) => {
                w.report_unknown -= 1;
                RelayOutcome::Unknown
            }
            (false, _) => RelayOutcome::Rejected,
        };
        Ok(TicketState::Done(outcome))
    }
}

pub struct FakeIssuer(pub Shared);

impl FakeIssuer {
    pub fn reply(w: &World, id: &str, plan: Plan, period: &str, state: IssueState) -> IssueReply {
        let seed = if w.forge_receipts { [9; 32] } else { ISSUER_SEED };
        let key = SigningKey::from_bytes(&seed);
        let (contract, idb) = (super::bytes32(CONTRACT).unwrap(), super::bytes32(id).unwrap());
        let period_byte = ["none", "monthly", "annual"].iter().position(|p| *p == period).unwrap() as u8;
        let signature = key.sign(&receipt_message(&contract, &idb, plan, period_byte, w.insert_by));
        IssueReply {
            id: id.into(),
            plan,
            state,
            receipt: Receipt {
                contract: CONTRACT.into(),
                period: period.into(),
                insert_by: w.insert_by,
                signature: hex::encode(signature.to_bytes()),
                public_key: hex::encode(key.verifying_key().to_bytes()),
            },
        }
    }

    pub fn fingerprint() -> [u8; 32] {
        Sha256::digest(SigningKey::from_bytes(&ISSUER_SEED).verifying_key().to_bytes()).into()
    }
}

fn issue_state(w: &mut World, id: &str) -> Option<IssueState> {
    let (plan, left) = *w.issuing.get(id)?;
    if left == 0 {
        w.issue(id, plan);
        return Some(IssueState::Issued);
    }
    w.issuing.insert(id.into(), (plan, left - 1));
    Some(IssueState::Pending)
}

impl Issuer for FakeIssuer {
    async fn request(&self, id: &str, request: &IssueRequest<'_>) -> Result<IssueReply, IssuerError> {
        let mut w = self.0.lock().unwrap();
        w.calls.push("issuer.request".into());
        if let Some(scripted) = w.script_issue.pop_front() {
            return scripted;
        }
        let delay = w.issue_delay;
        w.issuing.entry(id.into()).or_insert((request.plan(), delay));
        let state = issue_state(&mut w, id).unwrap();
        Ok(Self::reply(&w, id, request.plan(), request.period_text(), state))
    }

    async fn status(&self, id: &str) -> Result<IssueReply, IssuerError> {
        let mut w = self.0.lock().unwrap();
        if let Some(scripted) = w.script_issue_status.pop_front() {
            return scripted;
        }
        let state = issue_state(&mut w, id).ok_or(IssuerError::NotFound)?;
        let plan = w.issuing[id].0;
        Ok(Self::reply(&w, id, plan, "none", state))
    }
}

/// Clock that advances on sleep; fixed randomness (`random`, 0 by default).
#[derive(Default)]
pub struct FakeEnv {
    pub now: AtomicI64,
    pub random: AtomicI64,
    pub slept: Mutex<Vec<Duration>>,
}

impl Env for FakeEnv {
    fn now(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }

    fn sleep(&self, duration: Duration) -> BoxFuture<'_, ()> {
        self.slept.lock().unwrap().push(duration);
        self.now.fetch_add(duration.as_secs() as i64, Ordering::SeqCst);
        Box::pin(async {})
    }

    fn random_below(&self, bound: u64) -> u64 {
        (self.random.load(Ordering::SeqCst) as u64).min(bound.saturating_sub(1))
    }
}

/// A single seed for all tests (production Argon2id is slow, so it runs once).
pub fn keys() -> Arc<KeyManager> {
    static KEYS: OnceLock<(TempDir, Arc<KeyManager>)> = OnceLock::new();
    let (_, keys) = KEYS.get_or_init(|| {
        let dir = TempDir::new().unwrap();
        let phrase = format!("{} art", ["abandon"; 23].join(" "));
        let keys = crate::keys::restore(dir.path(), &phrase, "contraseña de test").unwrap();
        (dir, Arc::new(keys))
    });
    keys.clone()
}

pub fn config() -> OrchestratorConfig {
    OrchestratorConfig {
        network: "undeployed".into(),
        contract_address: CONTRACT.into(),
        mail_domain: "nightmail.local".into(),
        captcha_token: "captcha".into(),
        card_token: "card".into(),
        issuer_key: FakeIssuer::fingerprint(),
        // Absolute on every OS ("/tmp" is not on Windows and would give BadConfig).
        wallet_state_dir: std::env::temp_dir().join("wallet").to_string_lossy().into_owned(),
        retry: RetryPolicy::default(),
        pacing: Pacing { max_polls: 20, ..Pacing::devnet() },
    }
}

pub type Orch = Orchestrator<FakeChain, FakeIssuer, FakeRelayer>;

pub struct Harness {
    pub world: Shared,
    pub orch: Orch,
    pub env: Arc<FakeEnv>,
    pub store: Arc<LocalStore>,
    pub events: mpsc::UnboundedReceiver<super::OrchEvent>,
    _dir: TempDir,
}

impl Harness {
    pub fn calls(&self, method: &str) -> usize {
        self.world.lock().unwrap().calls.iter().filter(|c| *c == method).count()
    }

    pub fn progress(&mut self) -> Vec<Progress> {
        self.progress_events().into_iter().map(|e| e.progress).collect()
    }

    /// Progress events received (excluding `PendingChanged`).
    pub fn progress_events(&mut self) -> Vec<super::ProgressEvent> {
        std::iter::from_fn(|| self.events.try_recv().ok())
            .filter_map(|e| match e {
                super::OrchEvent::Progress(p) => Some(p),
                super::OrchEvent::PendingChanged => None,
            })
            .collect()
    }
}

/// Orchestrator on a fresh profile (empty store) and the given world.
pub async fn harness_on(world: Shared, config: OrchestratorConfig) -> Harness {
    let dir = TempDir::new().unwrap();
    let scope = StoreScope::new("undeployed", CONTRACT).unwrap();
    let store = Arc::new(LocalStore::open(&dir.path().join("db"), &[5; 32], &scope).unwrap());
    let env = Arc::new(FakeEnv::default());
    env.now.store(START as i64, Ordering::SeqCst);
    let (tx, events) = mpsc::unbounded_channel();
    let deps = Deps {
        chain: FakeChain(world.clone()),
        issuer: FakeIssuer(world.clone()),
        relayer: FakeRelayer(world.clone()),
        env: env.clone(),
        store: store.clone(),
        keys: keys(),
        config,
        events: Some(tx),
    };
    let orch = Orchestrator::start(deps).await.unwrap();
    Harness { world, orch, env, store, events, _dir: dir }
}

pub async fn harness() -> Harness {
    harness_on(world(), config()).await
}
