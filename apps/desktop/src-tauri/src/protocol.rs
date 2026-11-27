//! Core ↔ `midnight-sidecar` protocol (JSON-RPC 2.0, NDJSON over stdio).
//!
//! **Single source of the types.** `cargo test` generates the TypeScript types with ts-rs into
//! `apps/midnight-sidecar/src/protocol/` (see `.cargo/config.toml`). Do not edit the generated `.ts` files by hand.
//!
//! **Encoding convention** (for every method):
//! - bytes (`Bytes<N>`, keys, hashes): lowercase hex string, no `0x`;
//! - integers that do not fit in 53 bits (`bigint`, `Field`, `Uint<64>`): decimal string;
//! - never raw `Uint8Array` or `bigint` in JSON.
//!
//! **Versioning:** `PROTOCOL_VERSION` is `major.minor`. On a major mismatch the core rejects the sidecar in
//! `initialize`.

// Some types and codes are only used on the TypeScript side (exported with ts-rs).
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::fmt;
use ts_rs::TS;
use zeroize::Zeroizing;

/// 1.1: `contract.snapshot` and `contract.hashes`, codes -32005..-32008.
/// 1.2: `contract.findBonos` and `contract.proveCall`, codes -32009..-32011.
/// 1.3: `STALE_STATE` carries `data` (`StaleStateData`), `minLeafCount` in `contract.findBonos` and
/// `contract.proveCall`, code -32012 (`CONTRACT_MISMATCH`).
/// 1.4: `wallet.*` methods (`open`, `close`, `sync`, `balance`, `registerDust`, `faucet`, `buyBono`), codes
/// -32013..-32015 and the `wrong-token`, `wrong-amount` and `old-price-expired` reasons in `CALL_REJECTED`.
/// 1.5: `unregisteredNight` in `WalletBalance` (the core registers that NIGHT for DUST in the background).
/// 1.6: `chain.head` (the node's latest block time) and `blockTime` in `contract.proveCall`.
/// 2.0: one-step `registerMailbox` replaces `reserveMailbox`/`revealMailbox`; no `blockTime`, `commit` hash or
/// `pendingNames`.
pub const PROTOCOL_VERSION: &str = "2.0";

/// Major part of a `major.minor` string.
pub fn major(version: &str) -> &str {
    version.split('.').next().unwrap_or(version)
}

/// Minor part of a `major.minor` string (0 if missing or not a number).
fn minor(version: &str) -> u32 {
    version.split('.').nth(1).and_then(|m| m.parse().ok()).unwrap_or(0)
}

/// Whether a sidecar with that version works for the core: same major and an equal or newer minor. An older sidecar
/// would silently ignore fields the core believes are applied (e.g. `minLeafCount`, 1.3).
pub fn compatible(sidecar: &str, core: &str) -> bool {
    major(sidecar) == major(core) && minor(sidecar) >= minor(core)
}

/// Error codes: the standard JSON-RPC ones and the application's own (`-32000..-32099`). Must match
/// `packages/test-vectors/rpc/error-codes.json`.
pub mod codes {
    pub const PARSE_ERROR: i64 = -32700;
    pub const INVALID_REQUEST: i64 = -32600;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const INVALID_PARAMS: i64 = -32602;
    pub const INTERNAL_ERROR: i64 = -32603;
    /// Internal sidecar error with a fixed message (details never cross the boundary).
    pub const APP_INTERNAL: i64 = -32000;
    pub const NOT_INITIALIZED: i64 = -32001;
    pub const PROTOCOL_MISMATCH: i64 = -32002;
    pub const INVALID_CONFIG: i64 = -32003;
    pub const CANCELLED: i64 = -32004;
    /// `contract.snapshot`: no NightMailRegistry at that address at that height (`Contract not found`).
    pub const CONTRACT_NOT_FOUND: i64 = -32005;
    /// The indexer does not answer: network, timeout, 429, 5xx or GraphQL errors (`Indexer unavailable`).
    /// Retryable, but the core must cap retries with growing backoff: a GraphQL error may not be transient. A
    /// response that cannot be understood is still `APP_INTERNAL`.
    pub const UPSTREAM_UNAVAILABLE: i64 = -32006;
    /// `contract.snapshot` with a cursor whose state the sidecar no longer holds (`Snapshot expired`): start over
    /// without a cursor.
    pub const SNAPSHOT_EXPIRED: i64 = -32007;
    /// `contract.hashes`: mailbox name rejected (`Name rejected`). The reason is in `data` (`NameRejectedData`);
    /// the UI picks its text from the reason, never from the message.
    pub const NAME_REJECTED: i64 = -32008;
    /// `contract.proveCall`: the circuit, run locally against the current state, failed a contract check
    /// (`Call rejected`). The reason is in `data` (`CallRejectedData`). Nothing was proved or sent: no fee paid and
    /// no slot spent.
    pub const CALL_REJECTED: i64 = -32009;
    /// `contract.proveCall` (and `contract.findBonos` with `minLeafCount`): the indexer's state cannot be used to
    /// prove against its root (`Stale chain state`). The reason is in `data` (`StaleStateData`). `old` and `behind`
    /// can be retried later (capped, with random backoff); `future` is not fixed by retrying, the UI asks the user to
    /// check the system clock. Missing or unknown `data` (another minor version, a new reason) is treated as plain
    /// STALE_STATE: the core deserialises it with `.ok()` and never fails because of it.
    pub const STALE_STATE: i64 = -32010;
    /// `contract.proveCall`: the local proof server does not answer: network, timeout, 429 or 5xx
    /// (`Proof server unavailable`). Retryable with another `proveCall` (fresh path and proof).
    pub const PROVER_UNAVAILABLE: i64 = -32011;
    /// `contract.proveCall`: the circuit's verifier key in the deployed contract is not the one the app ships
    /// (`Contract version mismatch`): app and contract disagree in either direction (operator maintenance before or
    /// after an app release, a few blocks mid-change, a disabled circuit, or a lying indexer). Nothing was proved.
    /// The core does not persist "app outdated": it rechecks on every attempt, and the UI uses neutral wording
    /// (check for an update; if you just updated, retry later).
    pub const CONTRACT_MISMATCH: i64 = -32012;
    /// `wallet.*` methods: the wallet cannot do what was asked (`Wallet unavailable`). The reason is in `data`
    /// (`WalletUnavailableData`): `not-open`, `already-open`, `in-use` (another process holds the lock on that
    /// directory) or `not-synced` (spending before it is synced).
    pub const WALLET_UNAVAILABLE: i64 = -32013;
    /// `wallet.buyBono`, `wallet.faucet` or `wallet.registerDust`: insufficient balance (`Insufficient funds`).
    /// `data.asset` (`InsufficientFundsData`) says of what: `token` or `dust` (the fee).
    pub const INSUFFICIENT_FUNDS: i64 = -32014;
    /// The node rejected the transaction on submission (`Transaction rejected`): it definitely did not land.
    /// Retryable with another call (fresh proof).
    pub const TX_REJECTED: i64 = -32015;
}

#[derive(Serialize, Deserialize, TS, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Network {
    Undeployed,
    Preprod,
}

/// Midnight endpoints. Only the core decides them (never sidecar environment variables).
#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Endpoints {
    pub proof_server: String,
    pub indexer: String,
    pub indexer_ws: String,
    pub node: String,
}

#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct InitializeParams {
    pub protocol_version: String,
    pub network: Network,
    /// The sidecar only accepts a local (loopback) proof server, since it receives the witnesses, including the
    /// bono secret. A remote (TEE) prover will get its own configuration once the app can verify attestation.
    pub endpoints: Endpoints,
    /// Debug builds only: the sidecar logs error details to stderr.
    pub debug: bool,
}

impl InitializeParams {
    /// Local devnet (`infra/devnet`).
    pub fn devnet(debug: bool) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION.into(),
            network: Network::Undeployed,
            endpoints: Endpoints {
                proof_server: "http://127.0.0.1:6300".into(),
                indexer: "http://127.0.0.1:8088/api/v4/graphql".into(),
                indexer_ws: "ws://127.0.0.1:8088/api/v4/graphql/ws".into(),
                node: "ws://127.0.0.1:9944".into(),
            },
            debug,
        }
    }
}

#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct InitializeResult {
    pub protocol_version: String,
    pub sidecar_version: String,
    pub methods: Vec<String>,
}

#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PingResult {
    pub pong: bool,
    pub sidecar_version: String,
    pub node: String,
    pub proof_server: bool,
    pub indexer: bool,
}

/// Progress notification sidecar → core (`{"method":"progress","params":...}`, no `id`).
/// `contract.proveCall` stages, in order: `reading-state`, `building` and `proving` (no percentage).
/// `wallet.sync`: `syncing` (with percentage). `wallet.registerDust`: `waiting-dust`, `submitting`. `wallet.faucet`:
/// the proveCall stages plus `paying`. `wallet.buyBono`: the proveCall stages, `paying` and `waiting-inclusion`
/// (with `expiresAt`).
#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProgressParams {
    /// `id` of the request this refers to.
    pub request_id: u32,
    pub stage: String,
    /// 0-100, if known.
    pub percent: Option<u8>,
    /// `waiting-inclusion`: until when (Unix ms, block time) the submitted transaction can still land.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub expires_at: Option<u64>,
}

/// Core → sidecar notification to abandon a request (`$/cancel`).
#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CancelParams {
    pub id: u32,
}

// --- NightMailRegistry -------------------------------------------------------------------------
// Hashes and state come from the compiled contract (`packages/midnight`, in the sidecar): the core does not
// reimplement any `persistentHash` encoding.

/// Bono plan (the contract's `Plan`).
#[derive(Serialize, Deserialize, TS, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Plan {
    Free,
    Paid,
}

/// Address and slot kind (the contract's `Kind`).
#[derive(Serialize, Deserialize, TS, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum AddressKind {
    Mailbox,
    Alias,
}

/// Secret in hex (bono `s`, commitment `salt`): wiped from memory on drop and hidden from `Debug`. A plain string
/// in JSON.
#[derive(Clone, PartialEq, Eq)]
pub struct SecretHex(Zeroizing<String>);

impl SecretHex {
    pub fn new(hex: impl Into<String>) -> Self {
        Self(Zeroizing::new(hex.into()))
    }
    pub fn expose(&self) -> &str {
        &self.0
    }

    /// Hex of a 32-byte secret, written straight into the wiped buffer (no intermediate `String`).
    pub fn from_bytes(bytes: &[u8; 32]) -> Self {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut text = Zeroizing::new(String::with_capacity(64));
        for byte in bytes {
            text.push(char::from(HEX[usize::from(byte >> 4)]));
            text.push(char::from(HEX[usize::from(byte & 0x0f)]));
        }
        Self(text)
    }
}

impl fmt::Debug for SecretHex {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretHex(<redacted>)")
    }
}

impl Serialize for SecretHex {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for SecretHex {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        String::deserialize(deserializer).map(Self::new)
    }
}

/// One `contract.hashes` operation. 32-byte values in hex; `name` is the mailbox name as typed by the user (the
/// sidecar normalises it, so the app and the server share a single normalisation).
#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum HashOp {
    /// `bonoId(ctx, s, k)`.
    IdK {
        #[ts(type = "string")]
        s: SecretHex,
        k: u32,
    },
    /// `bonoLeaf(ctx, id, plan, validUntil)`; `validUntil` is `u32::MAX` (no expiry) for now.
    Leaf { id: String, plan: Plan, valid_until: u32 },
    /// `slotNullifier(ctx, s, kind, j, gen)`; `gen` is 0 for now.
    SlotNul {
        #[ts(type = "string")]
        s: SecretHex,
        kind: AddressKind,
        j: u8,
        // `gen` is a reserved word in Rust 2024.
        #[serde(rename = "gen")]
        generation: u32,
    },
    /// Normalised name (text; the contract uses it zero-padded to 64 bytes).
    NormalizeName { name: String },
    /// `addressKey(normalised name)`.
    AddrKey { name: String },
    /// `aliasKey(encPk, authPk, slotNul)`.
    AliasAddrKey { enc_pk: String, auth_pk: String, slot_nul: String },
    /// Local part of an alias address: `words.suffix`.
    AliasAddress { addr_key: String },
}

/// Why a mailbox name is rejected (`normalizeName`/`addrKey` of `contract.hashes`).
#[derive(Serialize, Deserialize, TS, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
#[ts(export)]
pub enum NameProblem {
    /// Not a valid name (characters, length, separators).
    Invalid,
    /// Ends in `.` plus 12 letters or digits, so it would resolve as an alias.
    AliasForm,
    /// Reserved role name (postmaster, admin, abuse…).
    Reserved,
}

/// `data` of the `NAME_REJECTED` error.
#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NameRejectedData {
    pub reason: NameProblem,
}

/// `contract.hashes`: several operations in one call (restore computes many).
#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ContractHashesParams {
    /// Contract address (32-byte hex); provides the `ctx` for the hashes that use it.
    pub contract_address: String,
    /// Between 1 and 1024 operations.
    pub ops: Vec<HashOp>,
}

#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ContractHashesResult {
    pub ctx: String,
    /// One result per operation, in order: hex, except `normalizeName` and `aliasAddress` (text).
    pub results: Vec<String>,
}

/// Where a `contract.snapshot` continues: the height fixed by the first page and the offset of each collection
/// (`null` = that collection is complete).
#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SnapshotCursor {
    pub block_height: u32,
    pub slot_nullifiers: Option<u32>,
    pub addresses: Option<u32>,
}

/// `contract.snapshot` params. The core must run snapshot walks one at a time: the sidecar only keeps the state of
/// the latest one, so starting another (or for another contract or indexer) evicts the previous one, whose later
/// pages get `SNAPSHOT_EXPIRED`.
#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ContractSnapshotParams {
    pub contract_address: String,
    /// No cursor: first page, at the indexer's latest block. Afterwards, the previous page's `next`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cursor: Option<SnapshotCursor>,
    /// Items per collection per page (1-10000; 1000 if omitted).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub limit: Option<u32>,
}

/// Replaced price and the block time (Unix seconds, exclusive) until which it is still accepted.
#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OldPrice {
    pub price: String,
    pub until: String,
}

/// The bono tree without its leaves: leaf count and current root (`Field`, decimal).
#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BonosSummary {
    pub leaf_count: u32,
    pub root: String,
}

#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SnapshotTotals {
    pub slot_nullifiers: u32,
    pub addresses: u32,
}

/// An `addresses` record (bytes in hex).
#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AddressEntry {
    pub addr_key: String,
    pub enc_pk: String,
    pub auth_pk: String,
    pub kind: AddressKind,
    pub name_cipher: String,
    pub slot_nul: String,
}

/// One page of the registry's public state, all at the same height. Collections are sorted by value (hex), not in
/// chain order; scalars are repeated on every page.
#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ContractSnapshot {
    pub block_height: u32,
    /// Block hash (hex) and time (Unix ms), to detect a reorg.
    pub block_hash: String,
    #[ts(type = "number")]
    pub block_timestamp: u64,
    pub price: String,
    pub old_prices: Vec<OldPrice>,
    pub bonos: BonosSummary,
    pub totals: SnapshotTotals,
    pub slot_nullifiers: Vec<String>,
    pub addresses: Vec<AddressEntry>,
    /// `null` on the last page.
    pub next: Option<SnapshotCursor>,
}

/// `contract.findBonos`: looks bono leaves up in the leaf → position index of the `bonos` tree, built from the
/// state at the indexer's latest block. Candidate leaves come from `contract.hashes` (`leaf`). Used both in normal
/// operation (has my bono been inserted?) and for restore. Nothing being searched for leaves the sidecar: the state is
/// downloaded in full and searched locally.
#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ContractFindBonosParams {
    pub contract_address: String,
    /// Between 1 and 1024 leaves (32-byte hex).
    pub leaves: Vec<String>,
    /// See `ContractProveCallParams::min_leaf_count`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub min_leaf_count: Option<u32>,
}

#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ContractFindBonosResult {
    /// Block of the state that was searched.
    pub block_height: u32,
    /// Leaves in the tree (= first free position): `leaf_count - 1 - position` is how many insertions came after a
    /// leaf (the core waits for several before spending it).
    pub leaf_count: u32,
    /// One entry per requested leaf, in order: its tree position, or `null` if absent.
    pub positions: Vec<Option<u32>>,
}

/// Membership proof witnesses: leaf `k` of bono `s`, with its plan and expiry, and the slot `j` being spent. The
/// Merkle path is not passed: the sidecar computes it against the current root on every call. The sidecar neither
/// stores nor logs these.
#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SlotWitnesses {
    #[ts(type = "string")]
    pub s: SecretHex,
    pub k: u32,
    pub plan: Plan,
    /// `u32::MAX` (no expiry) for now.
    pub valid_until: u32,
    pub j: u8,
}

/// Arguments of `registerMailbox(name, encPk, authPk, nameCipher)`.
#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RegisterMailboxArgs {
    /// Mailbox name as typed by the user: the sidecar normalises it and pads it to 64 bytes (the same normalisation
    /// as `addrKey` in `contract.hashes`; `NAME_REJECTED` if invalid).
    pub name: String,
    pub enc_pk: String,
    pub auth_pk: String,
    /// 104 bytes in hex.
    pub name_cipher: String,
}

/// Arguments of `createAlias(encPk, authPk)`.
#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CreateAliasArgs {
    pub enc_pk: String,
    pub auth_pk: String,
}

/// The call `contract.proveCall` proves: a circuit with its arguments and, if it spends a slot, its witnesses.
/// `buyBono` is not here: it needs the wallet (`wallet.buyBono`).
#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "circuit", rename_all = "camelCase")]
#[ts(export)]
pub enum ProveCall {
    RegisterMailbox { args: RegisterMailboxArgs, witnesses: SlotWitnesses },
    CreateAlias { args: CreateAliasArgs, witnesses: SlotWitnesses },
}

/// `contract.proveCall`: the sidecar reads the current state, computes the leaf's Merkle path against that state's
/// root (never stored), runs the circuit locally, proves it on the local proof server and returns the proved,
/// **unbalanced** transaction (no wallet involved, so it carries nothing of the user's).
/// - Progress: `progress` notifications (see `ProgressParams`); cancelled with `$/cancel`.
/// - If the relayer reports a node rejection over cost (gas margin) or the transaction stalls, the core requests
///   another `proveCall` (fresh path and proof), with capped attempts and random backoff. The sidecar never retries
///   on its own.
#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ContractProveCallParams {
    pub contract_address: String,
    #[serde(flatten)]
    pub call: ProveCall,
    /// The highest bono tree `leafCount` the core has seen (the tree only grows). If the indexer's state has fewer
    /// leaves: `STALE_STATE` with `behind`, i.e. a lagging indexer or one hiding leaves to spot the bono through
    /// retries.
    /// Rules for the core (the value comes from the untrusted indexer itself): store it per (network, contract);
    /// only raise it with bounded (≤ 2^20) and backed values (one of our bonos' position + 1, or the state against
    /// which one of our transactions was accepted); cap `behind` retries with random backoff; and after several
    /// `behind` with a small `ageMs`, warn and allow resetting it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub min_leaf_count: Option<u32>,
}

/// `chain.head` (1.6, no params): the time of the node's latest block, read from the node itself (`Timestamp.Now`),
/// not from the indexer, which follows finalized blocks and lags behind. The node is not trusted: the core only uses
/// it within bounds of the indexer's block time.
#[derive(Serialize, Deserialize, TS, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChainHead {
    /// Unix ms.
    #[ts(type = "number")]
    pub timestamp: u64,
}

#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ContractProveCallResult {
    /// Proved, unbalanced transaction serialised as hex: what the relayer receives
    /// (`adoptTransaction(bytes, 'Unbound')`).
    pub tx: String,
    /// Block of the state it was proved against (its root becomes public in the transaction).
    pub block_height: u32,
}

/// Which contract check failed when running the circuit locally (`CALL_REJECTED`).
#[derive(Serialize, Deserialize, TS, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
#[ts(export)]
pub enum CallProblem {
    /// The leaf of these witnesses is not in the tree (not inserted yet, or not a bono).
    NotABono,
    /// `j` exceeds the plan's quota.
    NoSlotsLeft,
    /// The slot is already spent.
    SlotAlreadyUsed,
    /// `registerMailbox`: the name already belongs to someone else.
    AddressTaken,
    /// `buyBono`: the coin is not the contract's token.
    WrongToken,
    /// `buyBono`: the amount is neither the current price nor a still accepted previous one.
    WrongAmount,
    /// `buyBono`: the amount was a previous price that has expired.
    OldPriceExpired,
    /// Any other contract check.
    Other,
}

/// `data` of the `CALL_REJECTED` error.
#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CallRejectedData {
    pub reason: CallProblem,
}

/// Why the state cannot be used (`STALE_STATE`).
#[derive(Serialize, Deserialize, TS, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
#[ts(export)]
pub enum StaleProblem {
    /// The block is older than the freshness limit (lagging indexer, or system clock running fast).
    Old,
    /// The block is ahead of the local clock by more than allowed (system clock running slow).
    Future,
    /// The bono tree has fewer leaves than `minLeafCount`.
    Behind,
}

/// `data` of the `STALE_STATE` error.
#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StaleStateData {
    pub reason: StaleProblem,
    /// Local clock minus the time of the block read, in ms (negative: the block is ahead). It mixes system clock
    /// skew with indexer lag (the indexer controls block time), so it never goes to shareable logs or the server, the
    /// UI rounds it, and with `old` it never claims "your clock is fast" (a lagging indexer is the usual cause).
    #[ts(type = "number")]
    pub age_ms: i64,
    /// Only with `behind`: leaves in the tree of the state read (public data). Tells "a few leaves behind" apart from a
    /// poisoned `minLeafCount`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub leaf_count: Option<u32>,
}

// --- Wallet (`wallet.*`, protocol 1.4) ---------------------------------------------------------
// `wallet.close`, `wallet.sync`, `wallet.balance` and `wallet.registerDust` take no params (`{}`) and
// `wallet.close` returns `{}`, so they have no type of their own.

/// `wallet.open`: the core derives the wallet seed and the state key (both 32-byte hex) from the master. While the
/// wallet is open they live in sidecar memory (the SDK needs them to sync and sign) until `wallet.close` or process
/// exit. Hidden from `Debug`.
#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WalletOpenParams {
    #[ts(type = "string")]
    pub seed: SecretHex,
    #[ts(type = "string")]
    pub state_key: SecretHex,
    /// Absolute path of the state directory (0700; the sidecar creates it).
    pub state_dir: String,
}

#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WalletOpenResult {
    pub unshielded_address: String,
    pub shielded_address: String,
    /// A saved state was restored (no sync from scratch).
    pub restored: bool,
    /// A state existed but could not be decrypted or belonged to another seed: it was set aside and syncing starts
    /// over.
    pub state_discarded: bool,
}

/// Balance of a non-NIGHT token. `color` in hex, `amount` in decimal.
#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TokenBalance {
    pub color: String,
    pub amount: String,
}

/// Result of `wallet.sync` and `wallet.balance`. Amounts as decimal strings.
#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WalletBalance {
    pub synced: bool,
    pub night: String,
    /// The part of `night` not generating DUST yet (unregistered; 1.5).
    pub unregistered_night: String,
    pub dust: String,
    pub dust_coins: u32,
    pub tokens: Vec<TokenBalance>,
}

/// `false` if there was no unregistered NIGHT.
#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WalletRegisterDustResult {
    pub registered: bool,
}

/// `wallet.faucet`: TestToken on test networks only (`mint(amount, random nonce)` to our own shielded key).
#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WalletFaucetParams {
    pub token_address: String,
    /// Decimal.
    pub amount: String,
}

#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WalletFaucetResult {
    pub tx_id: String,
}

/// `wallet.buyBono`, idempotent per `id`. `amount` is the price the user accepted (decimal); the sidecar never pays
/// a different amount.
#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WalletBuyBonoParams {
    pub contract_address: String,
    /// Bono id (32-byte hex).
    pub id: String,
    pub amount: String,
}

#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WalletBuyBonoResult {
    /// Block of the state where the leaf was seen.
    pub block_height: u32,
    /// The leaf was already in the tree: nothing was paid in this call.
    pub already_included: bool,
}

/// Why the wallet cannot proceed (`WALLET_UNAVAILABLE`).
#[derive(Serialize, Deserialize, TS, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
#[ts(export)]
pub enum WalletProblem {
    /// No wallet is open.
    NotOpen,
    /// One is already open.
    AlreadyOpen,
    /// Another process holds the lock on the state directory.
    InUse,
    /// Spending before it is synced.
    NotSynced,
}

/// `data` of the `WALLET_UNAVAILABLE` error.
#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WalletUnavailableData {
    pub reason: WalletProblem,
}

/// What the balance is short of (`INSUFFICIENT_FUNDS`).
#[derive(Serialize, Deserialize, TS, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
#[ts(export)]
pub enum FundsAsset {
    /// The payment token.
    Token,
    /// DUST for the fee.
    Dust,
}

/// `data` of the `INSUFFICIENT_FUNDS` error.
#[derive(Serialize, Deserialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct InsufficientFundsData {
    pub asset: FundsAsset,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn vectors_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/test-vectors/rpc")
    }

    #[test]
    fn error_codes_match_the_vectors() {
        let raw = std::fs::read_to_string(vectors_dir().join("error-codes.json")).expect("error-codes.json");
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let expected = [
            ("PARSE_ERROR", codes::PARSE_ERROR),
            ("INVALID_REQUEST", codes::INVALID_REQUEST),
            ("METHOD_NOT_FOUND", codes::METHOD_NOT_FOUND),
            ("INVALID_PARAMS", codes::INVALID_PARAMS),
            ("INTERNAL_ERROR", codes::INTERNAL_ERROR),
            ("APP_INTERNAL", codes::APP_INTERNAL),
            ("NOT_INITIALIZED", codes::NOT_INITIALIZED),
            ("PROTOCOL_MISMATCH", codes::PROTOCOL_MISMATCH),
            ("INVALID_CONFIG", codes::INVALID_CONFIG),
            ("CANCELLED", codes::CANCELLED),
            ("CONTRACT_NOT_FOUND", codes::CONTRACT_NOT_FOUND),
            ("UPSTREAM_UNAVAILABLE", codes::UPSTREAM_UNAVAILABLE),
            ("SNAPSHOT_EXPIRED", codes::SNAPSHOT_EXPIRED),
            ("NAME_REJECTED", codes::NAME_REJECTED),
            ("CALL_REJECTED", codes::CALL_REJECTED),
            ("STALE_STATE", codes::STALE_STATE),
            ("PROVER_UNAVAILABLE", codes::PROVER_UNAVAILABLE),
            ("CONTRACT_MISMATCH", codes::CONTRACT_MISMATCH),
            ("WALLET_UNAVAILABLE", codes::WALLET_UNAVAILABLE),
            ("INSUFFICIENT_FUNDS", codes::INSUFFICIENT_FUNDS),
            ("TX_REJECTED", codes::TX_REJECTED),
        ];
        assert_eq!(v.as_object().unwrap().len(), expected.len(), "the vectors have extra or missing codes");
        for (name, code) in expected {
            assert_eq!(v[name].as_i64(), Some(code), "{name}");
        }
    }

    #[test]
    fn sample_initialize_is_valid() {
        let raw = std::fs::read_to_string(vectors_dir().join("initialize.json")).expect("initialize.json");
        let params: InitializeParams = serde_json::from_str(&raw).expect("deserializes");
        assert_eq!(params, InitializeParams::devnet(false));
        // What the core sends is exactly the vector: no extra or missing fields.
        let vector: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(serde_json::to_value(InitializeParams::devnet(false)).expect("serializes"), vector);
    }

    /// A `{params, result}` vector; each part is read with its type and re-serialises to exactly the same JSON
    /// (no extra or missing fields).
    fn round_trip<P, R>(file: &str) -> (P, R)
    where
        P: serde::de::DeserializeOwned + Serialize,
        R: serde::de::DeserializeOwned + Serialize,
    {
        let raw = std::fs::read_to_string(vectors_dir().join(file)).expect(file);
        let v: serde_json::Value = serde_json::from_str(&raw).expect("json");
        let params: P = serde_json::from_value(v["params"].clone()).expect("params");
        let result: R = serde_json::from_value(v["result"].clone()).expect("result");
        assert_eq!(serde_json::to_value(&params).unwrap(), v["params"], "{file}: params");
        assert_eq!(serde_json::to_value(&result).unwrap(), v["result"], "{file}: result");
        (params, result)
    }

    #[test]
    fn sample_contract_hashes() {
        let (params, result): (ContractHashesParams, ContractHashesResult) = round_trip("contract-hashes.json");
        assert_eq!(params.ops.len(), result.results.len(), "one result per operation");
        assert_eq!(
            params.ops[1],
            HashOp::Leaf { id: "251036843701b78fad376cfe904f789831d07c0aee6f56abe0cc0a9b529637be".into(), plan: Plan::Free, valid_until: u32::MAX }
        );
        let json = serde_json::to_value(HashOp::SlotNul { s: SecretHex::new("00"), kind: AddressKind::Alias, j: 3, generation: 0 }).unwrap();
        assert_eq!(json, serde_json::json!({"op": "slotNul", "s": "00", "kind": "alias", "j": 3, "gen": 0}));
    }

    #[test]
    fn sample_name_rejected() {
        let raw = std::fs::read_to_string(vectors_dir().join("name-rejected.json")).expect("name-rejected.json");
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["error"]["code"].as_i64(), Some(codes::NAME_REJECTED));
        assert_eq!(v["error"]["message"], "Name rejected");
        let data: NameRejectedData = serde_json::from_value(v["error"]["data"].clone()).expect("data");
        assert_eq!(data.reason, NameProblem::AliasForm);
        let reasons: Vec<NameProblem> = serde_json::from_value(v["reasons"].clone()).expect("reasons");
        assert_eq!(reasons, [NameProblem::Invalid, NameProblem::AliasForm, NameProblem::Reserved]);
        assert_eq!(serde_json::to_value(&reasons).unwrap(), v["reasons"]);
    }

    #[test]
    fn secrets_do_not_show_in_debug() {
        let secret = "5151515151515151515151515151515151515151515151515151515151515151";
        let ops = [
            HashOp::IdK { s: SecretHex::new(secret), k: 1 },
            HashOp::SlotNul { s: SecretHex::new(secret), kind: AddressKind::Mailbox, j: 0, generation: 0 },
        ];
        for op in ops {
            let shown = format!("{op:?}");
            assert!(!shown.contains("5151"), "{shown}");
            assert!(shown.contains("redacted"));
            assert!(serde_json::to_string(&op).unwrap().contains(secret), "it is included in JSON");
        }
        assert_eq!(SecretHex::new("ab").expose(), "ab");
        assert_eq!(SecretHex::from_bytes(&[0xa5; 32]).expose(), "a5".repeat(32));
    }

    #[test]
    fn sample_contract_snapshot() {
        let (params, result): (ContractSnapshotParams, ContractSnapshot) = round_trip("contract-snapshot.json");
        assert!(params.cursor.is_some());
        assert_eq!(result.addresses[0].kind, AddressKind::Alias);
        // First page: no cursor or limit (not sent as null).
        let first = ContractSnapshotParams { contract_address: "ad".repeat(32), cursor: None, limit: None };
        assert_eq!(serde_json::to_value(&first).unwrap(), serde_json::json!({"contractAddress": "ad".repeat(32)}));
    }

    #[test]
    fn sample_contract_find_bonos() {
        let (params, result): (ContractFindBonosParams, ContractFindBonosResult) = round_trip("contract-find-bonos.json");
        assert_eq!(params.leaves.len(), result.positions.len(), "one position per leaf");
        assert_eq!(result.positions, [Some(0), None]);
    }

    #[test]
    fn sample_contract_prove_call() {
        let raw = std::fs::read_to_string(vectors_dir().join("contract-prove-call.json")).expect("contract-prove-call.json");
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let calls: Vec<ContractProveCallParams> = serde_json::from_value(v["calls"].clone()).expect("calls");
        assert_eq!(serde_json::to_value(&calls).unwrap(), v["calls"], "no extra or missing fields");
        assert!(matches!(calls[0].call, ProveCall::CreateAlias { .. }));
        assert!(matches!(calls[1].call, ProveCall::RegisterMailbox { .. }));
        let ProveCall::CreateAlias { witnesses, .. } = &calls[0].call else { unreachable!() };
        assert_eq!((witnesses.k, witnesses.plan, witnesses.valid_until, witnesses.j), (0, Plan::Free, u32::MAX, 1));
        let result: ContractProveCallResult = serde_json::from_value(v["result"].clone()).expect("result");
        assert_eq!(serde_json::to_value(&result).unwrap(), v["result"]);
        // Witnesses and salt do not show in Debug.
        let shown = format!("{calls:?}");
        assert!(!shown.contains("5151") && !shown.contains("5a5a"), "{shown}");
    }

    #[test]
    fn sample_chain_head() {
        let raw = std::fs::read_to_string(vectors_dir().join("chain-head.json")).expect("chain-head.json");
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let head: ChainHead = serde_json::from_value(v["result"].clone()).expect("result");
        assert_eq!(serde_json::to_value(head).unwrap(), v["result"]);
        // The storage bytes are the same u64, little endian.
        let storage = hex::decode(v["storage"].as_str().unwrap().trim_start_matches("0x")).unwrap();
        assert_eq!(u64::from_le_bytes(storage.try_into().unwrap()), head.timestamp);
    }

    #[test]
    fn sample_call_rejected() {
        let raw = std::fs::read_to_string(vectors_dir().join("call-rejected.json")).expect("call-rejected.json");
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["error"]["code"].as_i64(), Some(codes::CALL_REJECTED));
        assert_eq!(v["error"]["message"], "Call rejected");
        let data: CallRejectedData = serde_json::from_value(v["error"]["data"].clone()).expect("data");
        assert_eq!(data.reason, CallProblem::NoSlotsLeft);
        let reasons: Vec<CallProblem> = serde_json::from_value(v["reasons"].clone()).expect("reasons");
        assert_eq!(
            reasons,
            [
                CallProblem::NotABono,
                CallProblem::NoSlotsLeft,
                CallProblem::SlotAlreadyUsed,
                CallProblem::AddressTaken,
                CallProblem::Other,
            ]
        );
        assert_eq!(serde_json::to_value(&reasons).unwrap(), v["reasons"]);
    }

    #[test]
    fn sample_stale_state() {
        let raw = std::fs::read_to_string(vectors_dir().join("stale-state.json")).expect("stale-state.json");
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["error"]["code"].as_i64(), Some(codes::STALE_STATE));
        assert_eq!(v["error"]["message"], "Stale chain state");
        let data: StaleStateData = serde_json::from_value(v["error"]["data"].clone()).expect("data");
        assert_eq!(data, StaleStateData { reason: StaleProblem::Old, age_ms: 125_000, leaf_count: None });
        let behind: StaleStateData = serde_json::from_value(v["behind"].clone()).expect("behind");
        assert_eq!(behind, StaleStateData { reason: StaleProblem::Behind, age_ms: 4_000, leaf_count: Some(41) });
        assert_eq!(serde_json::to_value(&behind).unwrap(), v["behind"]);
        assert_eq!(serde_json::to_value(&data).unwrap(), v["error"]["data"]);
        let reasons: Vec<StaleProblem> = serde_json::from_value(v["reasons"].clone()).expect("reasons");
        assert_eq!(reasons, [StaleProblem::Old, StaleProblem::Future, StaleProblem::Behind]);
        assert_eq!(serde_json::to_value(&reasons).unwrap(), v["reasons"]);
    }

    #[test]
    fn sample_wallet_open() {
        let (params, result): (WalletOpenParams, WalletOpenResult) = round_trip("wallet-open.json");
        assert_eq!(params.seed.expose(), "51".repeat(32));
        assert!(result.restored && !result.state_discarded);
        // Neither the seed nor the state key shows in Debug.
        let shown = format!("{params:?}");
        assert!(!shown.contains("5151") && !shown.contains("5a5a"), "{shown}");
        assert!(shown.contains("redacted"));
    }

    #[test]
    fn sample_wallet_buy_bono() {
        let (params, result): (WalletBuyBonoParams, WalletBuyBonoResult) = round_trip("wallet-buy-bono.json");
        assert_eq!(params.amount, "1000000");
        assert!(!result.already_included);
    }

    #[test]
    fn sample_wallet_balance_faucet_and_dust() {
        let (_, balance): (serde_json::Value, WalletBalance) = round_trip("wallet-balance.json");
        assert_eq!((balance.tokens.len(), balance.unregistered_night.as_str()), (1, "500000"));
        let (faucet, tx): (WalletFaucetParams, WalletFaucetResult) = round_trip("wallet-faucet.json");
        assert_eq!((faucet.amount.as_str(), tx.tx_id.len()), ("5000000", 64));
        let (_, reg): (serde_json::Value, WalletRegisterDustResult) = round_trip("wallet-register-dust.json");
        assert!(reg.registered);
    }

    #[test]
    fn sample_wallet_errors() {
        let raw = std::fs::read_to_string(vectors_dir().join("wallet-errors.json")).expect("wallet-errors.json");
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let cases = [
            ("walletUnavailable", codes::WALLET_UNAVAILABLE, "Wallet unavailable"),
            ("insufficientFunds", codes::INSUFFICIENT_FUNDS, "Insufficient funds"),
            ("txRejected", codes::TX_REJECTED, "Transaction rejected"),
        ];
        for (key, code, message) in cases {
            assert_eq!(v[key]["code"].as_i64(), Some(code), "{key}");
            assert_eq!(v[key]["message"], message, "{key}");
        }
        let wallet: WalletUnavailableData = serde_json::from_value(v["walletUnavailable"]["data"].clone()).expect("data");
        assert_eq!(wallet.reason, WalletProblem::NotSynced);
        let funds: InsufficientFundsData = serde_json::from_value(v["insufficientFunds"]["data"].clone()).expect("data");
        assert_eq!(funds.asset, FundsAsset::Dust);
        assert!(v["txRejected"].get("data").is_none());
        let reasons: Vec<WalletProblem> = serde_json::from_value(v["walletReasons"].clone()).expect("reasons");
        assert_eq!(reasons, [WalletProblem::NotOpen, WalletProblem::AlreadyOpen, WalletProblem::InUse, WalletProblem::NotSynced]);
        assert_eq!(serde_json::to_value(&reasons).unwrap(), v["walletReasons"]);
        let assets: Vec<FundsAsset> = serde_json::from_value(v["assets"].clone()).expect("assets");
        assert_eq!(assets, [FundsAsset::Token, FundsAsset::Dust]);
        // An unknown reason (another minor version) does not deserialise: the core uses `.ok()`.
        assert!(serde_json::from_value::<WalletUnavailableData>(serde_json::json!({"reason": "nuevo"})).is_err());
    }

    #[test]
    fn new_call_rejected_reasons() {
        let casos = [
            (CallProblem::WrongToken, "wrong-token"),
            (CallProblem::WrongAmount, "wrong-amount"),
            (CallProblem::OldPriceExpired, "old-price-expired"),
        ];
        for (reason, text) in casos {
            assert_eq!(serde_json::to_value(CallRejectedData { reason }).unwrap(), serde_json::json!({"reason": text}));
            let back: CallRejectedData = serde_json::from_value(serde_json::json!({"reason": text})).unwrap();
            assert_eq!(back.reason, reason);
        }
    }

    #[test]
    fn version_compatible_with_same_major_and_equal_or_higher_minor() {
        assert!(compatible("1.3", "1.3"));
        assert!(compatible("1.4", "1.3"), "a newer sidecar is fine");
        assert!(!compatible("1.3", "1.4"), "a 1.3 one does not know wallet.*");
        assert!(!compatible("1.4", "1.5"), "a 1.4 one does not provide unregisteredNight");
        assert!(!compatible("1.5", "1.6"), "a 1.5 one has no chain.head and would ignore blockTime");
        assert!(!compatible("1.6", "2.0"), "a 1.x one only knows the two-step mailbox");
        assert!(!compatible("1.2", "1.3"), "an older one would ignore minLeafCount");
        assert!(!compatible("2.3", "1.3"));
        assert!(!compatible("1", "1.3"));
        assert!(compatible("1.10", "1.9"), "compared as a number, not as text");
        assert!(compatible(PROTOCOL_VERSION, PROTOCOL_VERSION));
    }

    #[test]
    fn major_version() {
        assert_eq!(major("1.0"), "1");
        assert_eq!(major("12.3"), "12");
    }
}
