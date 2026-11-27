//! Types crossing the core ↔ UI boundary. The UI never receives `raw`, keys or leaf positions. ts-rs generates them
//! into `apps/desktop/src/bindings/` when `cargo test` runs.

use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;
use zeroize::{Zeroize, Zeroizing};

use crate::keys::KeyError;
use crate::mail::parser::ParsedMessage;
use crate::mail::parser::inline::InlineImage;
use crate::mail::sync::SyncReport;
use super::config::TestToken;
use crate::orchestrator::{DustSetup, OrchError, ProgressEvent, ResumeReport, WalletSnapshot, slot_limit};
use crate::store::{Address, BonoLeaf, BonoStatus, MessageFilter, MessageFlags, MessageSummary, Plan, SlotKind};

/// Application layer errors (orchestrator errors pass through as is, with their own `code`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "code", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub enum CoreError {
    /// No seed in this profile.
    NoSeed,
    /// This profile already has a seed (it is never overwritten).
    SeedExists,
    /// Wrong password or damaged seed file (indistinguishable).
    WrongPassword,
    /// Too many consecutive failures (unlock, reveal phrase or change password): wait `wait_secs` seconds. From the
    /// 5th failure on; if a wait was already pending, the password was not even checked.
    TooManyAttempts {
        wait_secs: u32,
    },
    InvalidPhrase,
    EmptyPassword,
    /// The seed file or directory is not private.
    InsecureFiles,
    OutOfMemory,
    /// Unlock first.
    NotUnlocked,
    AlreadyUnlocked,
    /// Core settings are missing (registry, receipt key or URLs).
    BadConfig,
    /// Another live app instance has this profile open (`crate::instance`), so this one does not start the core.
    ProfileInUse,
    /// The local database could not be opened or used.
    Storage,
    NotFound,
    /// Invalid argument (too long or malformed).
    InvalidInput,
    /// Lock requested with an operation or payment in flight: wait for it to finish.
    SessionBusy,
    /// Another profile was opened in this window while the open one was being deleted: nothing was deleted.
    ProfileChanged,
    /// The restore has not finished: `recover` must complete before asking for the plan or addresses.
    RecoveryPending,
    /// This network has no test token, so there is no faucet.
    NoTestToken,
    Internal,
}

/// A command error: from the application layer, the orchestrator, a link (`link`) or sending a mail (`mail::send`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(untagged)]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub enum AppError {
    Core(CoreError),
    Orch(OrchError),
    Link(crate::link::LinkError),
    Send(crate::mail::send::SendError),
}

impl From<crate::mail::send::SendError> for AppError {
    fn from(e: crate::mail::send::SendError) -> Self {
        AppError::Send(e)
    }
}

impl From<crate::link::LinkError> for AppError {
    fn from(e: crate::link::LinkError) -> Self {
        AppError::Link(e)
    }
}

impl From<CoreError> for AppError {
    fn from(e: CoreError) -> Self {
        AppError::Core(e)
    }
}

impl From<OrchError> for AppError {
    fn from(e: OrchError) -> Self {
        AppError::Orch(e)
    }
}

impl From<crate::store::StoreError> for AppError {
    fn from(_: crate::store::StoreError) -> Self {
        AppError::Core(CoreError::Storage)
    }
}

impl From<KeyError> for CoreError {
    fn from(e: KeyError) -> Self {
        match e {
            KeyError::Locked => CoreError::WrongPassword,
            KeyError::Missing => CoreError::NoSeed,
            KeyError::Exists => CoreError::SeedExists,
            KeyError::InvalidPhrase => CoreError::InvalidPhrase,
            KeyError::EmptyPassword => CoreError::EmptyPassword,
            KeyError::Permissions => CoreError::InsecureFiles,
            KeyError::Memory => CoreError::OutOfMemory,
            KeyError::Io => CoreError::Storage,
            KeyError::TooManyAttempts { wait_secs } => CoreError::TooManyAttempts { wait_secs },
        }
    }
}

impl From<KeyError> for AppError {
    fn from(e: KeyError) -> Self {
        AppError::Core(e.into())
    }
}

/// Password or phrase coming from the UI; this copy is wiped on drop. It is not the only one: Tauri deserialises it
/// from a `Value`, and both the IPC body and that `Value` are freed without wiping (unavoidable with Tauri's IPC).
#[derive(Default)]
pub struct Secret(pub Zeroizing<String>);

impl<'de> Deserialize<'de> for Secret {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        String::deserialize(d).map(|s| Secret(Zeroizing::new(s)))
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(..)")
    }
}

/// The recovery phrase, shown once. Wiped on drop (the copy in the IPC response is not).
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub struct SeedPhrase {
    pub phrase: String,
}

impl Drop for SeedPhrase {
    fn drop(&mut self) {
        self.phrase.zeroize();
    }
}

impl std::fmt::Debug for SeedPhrase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SeedPhrase(..)")
    }
}

/// The words of a new profile, shown before its password is chosen. Not saved anywhere: the core keeps them in
/// memory until `create_seed` (with this `id` and the password) or `discard_seed_draft`. The `id` is not secret: it
/// only ties the save to the words that were shown. Wiped on drop (the copy in the IPC response is not).
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub struct SeedDraft {
    pub id: u32,
    pub phrase: String,
}

impl Drop for SeedDraft {
    fn drop(&mut self) {
        self.phrase.zeroize();
    }
}

impl std::fmt::Debug for SeedDraft {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SeedDraft({}, ..)", self.id)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub struct AppStatus {
    pub has_seed: bool,
    pub unlocked: bool,
}

/// Whether the NightMail server services used by the app answer (Midnight health is separate).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub struct ServerHealth {
    /// The Mailbox API (mail).
    pub mailbox: bool,
    /// The relayer (carries operations to Midnight).
    pub relayer: bool,
    /// The Issuer (issues bonos).
    pub issuer: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub struct Quota {
    pub used: u32,
    pub limit: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub struct BonoView {
    pub n: u32,
    pub k: u32,
    pub paid: bool,
    /// Already in the contract's tree.
    pub included: bool,
    #[ts(type = "number | null")]
    pub usable_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub struct PlanView {
    pub bonos: Vec<BonoView>,
    pub mailboxes: Quota,
    pub aliases: Quota,
    /// Abandoned mailboxes; already counted in `mailboxes.used` (their slot is not freed).
    pub mailboxes_abandoned: u32,
    /// Abandoned aliases; already counted in `aliases.used`.
    pub aliases_abandoned: u32,
}

impl PlanView {
    /// Quota: for each included bono, that of its best leaf (the paid one if any). Used: addresses that exist,
    /// including abandoned ones (their key is never freed).
    pub fn build(bonos: &[BonoLeaf], addresses: &[Address], abandoned: &[Address]) -> Self {
        let mut best: std::collections::BTreeMap<u32, Plan> = Default::default();
        for b in bonos.iter().filter(|b| b.status == BonoStatus::Included) {
            let plan = best.entry(b.n).or_insert(b.plan);
            if b.plan == Plan::Paid {
                *plan = Plan::Paid;
            }
        }
        let limit = |kind| best.values().map(|&plan| slot_limit(plan, kind)).sum();
        let count = |list: &[Address], kind| list.iter().filter(|a| a.kind == kind).count() as u32;
        let used = |kind| count(addresses, kind) + count(abandoned, kind);
        Self {
            bonos: bonos
                .iter()
                .map(|b| BonoView {
                    n: b.n,
                    k: b.k,
                    paid: b.plan == Plan::Paid,
                    included: b.status == BonoStatus::Included,
                    usable_at: b.usable_at,
                })
                .collect(),
            mailboxes: Quota { used: used(SlotKind::Mailbox), limit: limit(SlotKind::Mailbox) },
            aliases: Quota { used: used(SlotKind::Alias), limit: limit(SlotKind::Alias) },
            mailboxes_abandoned: count(abandoned, SlotKind::Mailbox),
            aliases_abandoned: count(abandoned, SlotKind::Alias),
        }
    }
}

/// The embedded payment wallet, for the UI. Amounts in base units as decimal strings (they do not fit in a
/// `number`). `Debug` omits the address.
#[derive(Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub struct WalletView {
    /// Unshielded address (Bech32m) to send NIGHT to; `null` if it cannot be known right now.
    pub unshielded_address: Option<String>,
    pub night: String,
    /// DUST balance in Specks (1 DUST = 10^15 Specks), computed when reading the wallet since DUST accrues
    /// continuously.
    pub dust: String,
    /// There are DUST coins to pay fees with.
    pub dust_ready: bool,
    /// Payment token balance (`"0"` with no test token or no balance).
    pub token: String,
    /// This network has a TestToken faucet.
    pub faucet: bool,
    /// The background registration of NIGHT for DUST generation that the app does on its own.
    pub dust_setup: DustSetup,
}

impl std::fmt::Debug for WalletView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WalletView")
            .field("night", &self.night)
            .field("dust", &self.dust)
            .field("dust_ready", &self.dust_ready)
            .field("token", &self.token)
            .field("faucet", &self.faucet)
            .field("dust_setup", &self.dust_setup)
            .finish_non_exhaustive()
    }
}

impl WalletView {
    pub fn build(snapshot: WalletSnapshot, token: Option<&TestToken>) -> Self {
        let balance = snapshot.balance;
        let amount = token.and_then(|t| balance.tokens.iter().find(|b| b.color.eq_ignore_ascii_case(&t.color)));
        Self {
            unshielded_address: snapshot.unshielded_address,
            night: balance.night,
            dust: balance.dust,
            dust_ready: balance.dust_coins > 0,
            token: amount.map_or_else(|| "0".into(), |b| b.amount.clone()),
            faucet: token.is_some(),
            dust_setup: snapshot.dust_setup,
        }
    }
}

/// Message list filter.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub struct MessageQuery {
    /// Only those of this address (`addrKey` in hex).
    #[ts(optional)]
    pub addr_key: Option<String>,
    /// `true` archived only, `false` non-archived only; unset, both.
    #[ts(optional)]
    pub archived: Option<bool>,
    pub include_deleted: bool,
    #[ts(optional)]
    pub limit: Option<u32>,
    pub offset: u32,
}

/// Maximum messages per page.
pub const MAX_PAGE: u32 = 500;

impl MessageQuery {
    pub fn filter(&self) -> Result<MessageFilter, CoreError> {
        let addr_key = match &self.addr_key {
            Some(text) => {
                let mut key = [0u8; 32];
                hex::decode_to_slice(text, &mut key).map_err(|_| CoreError::InvalidInput)?;
                Some(key)
            }
            None => None,
        };
        Ok(MessageFilter {
            addr_key,
            include_deleted: self.include_deleted,
            archived: self.archived,
            limit: Some(self.limit.unwrap_or(MAX_PAGE).min(MAX_PAGE)),
            offset: self.offset,
        })
    }
}

/// A message in the list (no body).
#[derive(Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub struct MessageView {
    #[ts(type = "number")]
    pub id: i64,
    pub addr_key: String,
    #[ts(type = "number")]
    pub received_at: i64,
    /// `Name <address>` or just the address; the UI always shows the address.
    pub from: Option<String>,
    pub subject: Option<String>,
    #[ts(type = "number | null")]
    pub sent_at: Option<i64>,
    pub preview: Option<String>,
    pub is_read: bool,
    pub starred: bool,
    pub archived: bool,
    pub deleted: bool,
    /// Sealed end to end by another NightMail address (not by the server on arrival).
    pub e2e: bool,
    /// Only with `e2e`: the signature, by the key the registry has for the `from` address, checked out for this
    /// address. Without it, `from` is only what the mail claims.
    pub sender_verified: bool,
}

impl std::fmt::Debug for MessageView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MessageView").field("id", &self.id).finish_non_exhaustive()
    }
}

impl From<&MessageSummary> for MessageView {
    fn from(m: &MessageSummary) -> Self {
        Self {
            id: m.id,
            addr_key: hex::encode(m.addr_key),
            received_at: m.received_at,
            from: m.parsed.from_addr.clone(),
            subject: m.parsed.subject.clone(),
            sent_at: m.parsed.sent_at,
            preview: m.parsed.preview.clone(),
            is_read: m.is_read,
            starred: m.starred,
            archived: m.archived,
            deleted: m.deleted,
            e2e: m.e2e,
            sender_verified: m.sender_verified,
        }
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub struct AttachmentView {
    pub name: Option<String>,
    pub content_type: String,
    #[ts(type = "number")]
    pub size: usize,
}

/// Inline (`cid:`) image of an opened message: PNG, JPEG, GIF or WebP (`mail::parser::inline`).
#[derive(Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub struct InlineImageView {
    /// `Content-ID` without `<>`.
    pub cid: String,
    /// One from the core's list; the UI uses it as is in `data:<mime>;base64,…`.
    pub mime: String,
    /// Bytes in base64.
    pub data: String,
}

impl std::fmt::Debug for InlineImageView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InlineImageView").field("mime", &self.mime).finish_non_exhaustive()
    }
}

impl From<InlineImage> for InlineImageView {
    fn from(image: InlineImage) -> Self {
        use base64::{Engine as _, engine::general_purpose::STANDARD};
        Self { cid: image.cid, mime: image.mime.to_owned(), data: STANDARD.encode(image.bytes) }
    }
}

/// An opened message. `html` is unsanitised: the UI only renders it in an `iframe` with an empty `sandbox`, after
/// DOMPurify and under a CSP that loads nothing remote (see the `mail::parser` contract).
#[derive(Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub struct MessageDetail {
    pub summary: MessageView,
    pub to: Vec<String>,
    pub text: Option<String>,
    pub html: Option<String>,
    pub attachments: Vec<AttachmentView>,
    /// The message exceeded the limits or was broken: only headers are available ("incomplete message").
    pub truncated: bool,
    /// It could not be read (unreadable, or set aside by the circuit breaker).
    pub unreadable: bool,
    /// `cid:` images the reader can render (only here, when opened; never in the list).
    pub inline_images: Vec<InlineImageView>,
    /// Inline images not delivered because of the caps.
    #[ts(type = "number")]
    pub inline_omitted: usize,
}

impl std::fmt::Debug for MessageDetail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MessageDetail").field("summary", &self.summary).finish_non_exhaustive()
    }
}

impl MessageDetail {
    pub fn build(summary: &MessageSummary, parsed: Option<ParsedMessage>) -> Self {
        let mut view = MessageView::from(summary);
        let Some(p) = parsed else {
            return Self {
                summary: view,
                to: vec![],
                text: None,
                html: None,
                attachments: vec![],
                truncated: false,
                unreadable: true,
                inline_images: vec![],
                inline_omitted: 0,
            };
        };
        // Freshly parsed data wins over stored data (it may have been stored without fields).
        view.from = p.from.clone().or(view.from);
        view.subject = p.subject.clone().or(view.subject);
        view.sent_at = p.date.or(view.sent_at);
        Self {
            summary: view,
            to: p.to,
            text: p.text,
            html: p.html,
            attachments: p
                .attachments
                .into_iter()
                .map(|a| AttachmentView { name: a.name, content_type: a.content_type, size: a.size })
                .collect(),
            truncated: p.truncated,
            unreadable: false,
            inline_images: p.inline.images.into_iter().map(InlineImageView::from).collect(),
            inline_omitted: p.inline.omitted,
        }
    }
}

/// Flag changes; an absent field is left unchanged.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub struct FlagsInput {
    #[ts(optional)]
    pub is_read: Option<bool>,
    #[ts(optional)]
    pub starred: Option<bool>,
    #[ts(optional)]
    pub archived: Option<bool>,
    #[ts(optional)]
    pub deleted: Option<bool>,
}

impl From<FlagsInput> for MessageFlags {
    fn from(f: FlagsInput) -> Self {
        Self { is_read: f.is_read, starred: f.starred, archived: f.archived, deleted: f.deleted }
    }
}

/// Summary of a sync round (without saying which addresses).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub struct SyncView {
    #[ts(type = "number")]
    pub stored: usize,
    #[ts(type = "number")]
    pub skipped: usize,
    #[ts(type = "number")]
    pub failed: usize,
    #[ts(type = "number")]
    pub deferred: usize,
    /// The new mail within `stored` (arrived at an address that was already caught up): drives the new-mail notice.
    #[ts(type = "number")]
    pub fresh: usize,
}

impl From<SyncReport> for SyncView {
    fn from(r: SyncReport) -> Self {
        Self { stored: r.stored, skipped: r.skipped, failed: r.failed, deferred: r.deferred, fresh: r.fresh }
    }
}

/// Core-to-UI event (a single Tauri event channel, `nightmail`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub enum AppEvent {
    Progress { event: ProgressEvent },
    /// A mail sync round finished.
    Synced { report: SyncView },
    /// A turn resuming unfinished work starts. It is always followed by its result (`Resumed` or `ResumeFailed`)
    /// before another one starts.
    ResumeStarted,
    /// Resuming the work left unfinished at unlock has finished.
    Resumed { report: ResumeReport },
    ResumeFailed { error: OrchError },
    /// The pending restore (resumed at unlock) has finished.
    Recovered { report: crate::recovery::RecoveryReport },
    RecoverFailed { error: OrchError },
    /// Exit was requested during a payment: the app will close by itself when it finishes.
    ExitDeferred,
    /// An unfinished slot started or stopped running: re-read the list.
    PendingChanged,
    /// The address list changed (one was abandoned): re-read addresses, plan and messages.
    AddressesChanged,
    /// The background NIGHT-for-DUST registration finished: the wallet on screen is stale.
    WalletChanged,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{TokenBalance, WalletBalance};
    use crate::store::ParsedFields;

    #[test]
    fn wallet_view_takes_the_payment_token_balance() {
        let token = TestToken { address: "aa".into(), color: "c0".into() };
        let tokens = vec![
            TokenBalance { color: "ff".into(), amount: "7".into() },
            TokenBalance { color: "C0".into(), amount: "100".into() },
        ];
        let balance = WalletBalance {
            synced: true,
            night: "5000000000".into(),
            unregistered_night: "5000000000".into(),
            dust: "9".into(),
            dust_coins: 1,
            tokens,
        };
        let snapshot =
            WalletSnapshot { unshielded_address: Some("mn_addr".into()), balance, dust_setup: DustSetup::Activating };
        let view = WalletView::build(snapshot.clone(), Some(&token));
        let expected = WalletView {
            unshielded_address: Some("mn_addr".into()),
            night: "5000000000".into(),
            dust: "9".into(),
            dust_ready: true,
            token: "100".into(),
            faucet: true,
            dust_setup: DustSetup::Activating,
        };
        assert_eq!(view, expected);
        let without = WalletView::build(snapshot.clone(), None);
        assert_eq!((without.token.as_str(), without.faucet), ("0", false));
        let mut empty = snapshot;
        empty.balance.dust_coins = 0;
        empty.balance.tokens.clear();
        let view = WalletView::build(empty, Some(&token));
        assert_eq!((view.token.as_str(), view.dust_ready), ("0", false));
    }

    fn leaf(n: u32, k: u32, plan: Plan, status: BonoStatus) -> BonoLeaf {
        BonoLeaf { n, k, plan, id: [0; 32], status, position: None, requested_at: 0, usable_at: None }
    }

    fn address(kind: SlotKind, j: u32) -> Address {
        Address { addr_key: [j as u8; 32], kind, n: 0, j, display: String::new(), name: None, created_at: 0 }
    }

    #[test]
    fn plan_quota_uses_the_best_included_leaf_of_each_bono() {
        let free_only = PlanView::build(&[leaf(0, 0, Plan::Free, BonoStatus::Included)], &[], &[]);
        assert_eq!((free_only.mailboxes.limit, free_only.aliases.limit), (1, 2));
        let upgraded = PlanView::build(
            &[leaf(0, 0, Plan::Free, BonoStatus::Included), leaf(0, 1, Plan::Paid, BonoStatus::Included)],
            &[address(SlotKind::Mailbox, 0), address(SlotKind::Alias, 0), address(SlotKind::Alias, 1)],
            &[],
        );
        assert_eq!((upgraded.mailboxes, upgraded.aliases), (Quota { used: 1, limit: 5 }, Quota { used: 2, limit: 20 }));
        assert_eq!((upgraded.mailboxes_abandoned, upgraded.aliases_abandoned), (0, 0));
        // Abandoned addresses count as used and are reported separately.
        let abandoned = PlanView::build(
            &[leaf(0, 0, Plan::Free, BonoStatus::Included)],
            &[address(SlotKind::Alias, 0)],
            &[address(SlotKind::Mailbox, 1), address(SlotKind::Alias, 2), address(SlotKind::Alias, 3)],
        );
        assert_eq!((abandoned.mailboxes, abandoned.aliases), (Quota { used: 1, limit: 1 }, Quota { used: 3, limit: 2 }));
        assert_eq!((abandoned.mailboxes_abandoned, abandoned.aliases_abandoned), (1, 2));
        let pending = PlanView::build(&[leaf(1, 0, Plan::Paid, BonoStatus::Requested)], &[], &[]);
        assert_eq!((pending.mailboxes.limit, pending.bonos[0].included), (0, false));
    }

    #[test]
    fn errors_serialize_with_a_flat_code() {
        let core = serde_json::to_value(AppError::from(CoreError::WrongPassword)).unwrap();
        assert_eq!(core, serde_json::json!({ "code": "wrongPassword" }));
        let orch = serde_json::to_value(AppError::from(OrchError::NameTaken)).unwrap();
        assert_eq!(orch, serde_json::json!({ "code": "nameTaken" }));
        assert_eq!(CoreError::from(KeyError::Locked), CoreError::WrongPassword);
        assert_eq!(CoreError::from(KeyError::Io), CoreError::Storage);
        let wait = AppError::from(KeyError::TooManyAttempts { wait_secs: 30 });
        assert_eq!(serde_json::to_value(wait).unwrap(), serde_json::json!({ "code": "tooManyAttempts", "waitSecs": 30 }));
    }

    #[test]
    fn secrets_deserialize_and_hide_from_debug() {
        let secret: Secret = serde_json::from_str("\"clave\"").unwrap();
        assert_eq!(secret.0.as_str(), "clave");
        assert_eq!(format!("{secret:?}"), "Secret(..)");
        assert_eq!(format!("{:?}", SeedPhrase { phrase: "a b".into() }), "SeedPhrase(..)");
        assert_eq!(format!("{:?}", SeedDraft { id: 3, phrase: "a b".into() }), "SeedDraft(3, ..)");
    }

    #[test]
    fn message_query_is_bounded_and_checks_the_address() {
        let q: MessageQuery = serde_json::from_str(r#"{"limit": 100000}"#).unwrap();
        assert_eq!(q.filter().unwrap().limit, Some(MAX_PAGE));
        let bad = MessageQuery { addr_key: Some("zz".into()), ..Default::default() };
        assert_eq!(bad.filter().unwrap_err(), CoreError::InvalidInput);
        let ok = MessageQuery { addr_key: Some("11".repeat(32)), ..Default::default() };
        assert_eq!(ok.filter().unwrap().addr_key, Some([0x11; 32]));
    }

    fn summary() -> MessageSummary {
        MessageSummary {
            id: 7,
            addr_key: [1; 32],
            server_id: "s".into(),
            received_at: 10,
            size_bucket: 1,
            parsed: ParsedFields { from_addr: Some("a@b".into()), subject: None, sent_at: None, preview: None },
            is_read: false,
            starred: false,
            archived: false,
            deleted: false,
            e2e: false,
            sender_verified: false,
        }
    }

    #[test]
    fn message_view_carries_the_end_to_end_verdict() {
        let plain = serde_json::to_value(MessageView::from(&summary())).unwrap();
        assert_eq!((&plain["e2e"], &plain["senderVerified"]), (&false.into(), &false.into()));
        let checked = MessageSummary { e2e: true, sender_verified: true, ..summary() };
        let detail = MessageDetail::build(&checked, None);
        let json = serde_json::to_value(&detail).unwrap();
        assert_eq!((&json["summary"]["e2e"], &json["summary"]["senderVerified"]), (&true.into(), &true.into()));
    }

    #[test]
    fn message_detail_prefers_fresh_fields_and_flags_unreadable() {
        let unreadable = MessageDetail::build(&summary(), None);
        assert!(unreadable.unreadable && unreadable.text.is_none());
        let parsed = ParsedMessage { subject: Some("Hola".into()), text: Some("cuerpo".into()), ..Default::default() };
        let detail = MessageDetail::build(&summary(), Some(parsed));
        assert_eq!(detail.summary.subject.as_deref(), Some("Hola"));
        assert_eq!(detail.summary.from.as_deref(), Some("a@b"));
        assert!(!detail.unreadable);
        assert_eq!(format!("{detail:?}"), "MessageDetail { summary: MessageView { id: 7, .. }, .. }");
    }

    #[test]
    fn message_detail_carries_inline_images_as_base64() {
        use crate::mail::parser::inline::{InlineImage, InlineImages};
        let image = InlineImage { cid: "logo@x".into(), mime: "image/png", bytes: b"png".to_vec() };
        let parsed = ParsedMessage { inline: InlineImages { images: vec![image], omitted: 3 }, ..Default::default() };
        let detail = MessageDetail::build(&summary(), Some(parsed));
        assert_eq!(
            detail.inline_images,
            [InlineImageView { cid: "logo@x".into(), mime: "image/png".into(), data: "cG5n".into() }]
        );
        assert_eq!(detail.inline_omitted, 3);
        let json = serde_json::to_value(&detail).unwrap();
        assert_eq!(json["inlineImages"][0]["data"], "cG5n");
        assert_eq!(json["inlineOmitted"], 3);
        let unreadable = MessageDetail::build(&summary(), None);
        assert!(unreadable.inline_images.is_empty() && unreadable.inline_omitted == 0);
    }

    #[test]
    fn flags_input_maps_one_to_one() {
        let f: FlagsInput = serde_json::from_str(r#"{"isRead": true}"#).unwrap();
        assert_eq!(MessageFlags::from(f), MessageFlags { is_read: Some(true), ..Default::default() });
    }
}
