//! Tauri commands (core ↔ UI). Thin wrappers: all logic lives in `crate::app`.
//!
//! Errors reaching the UI are enums with fixed codes ([`AppError`], [`CommandError`]); sidecar and library messages
//! are never forwarded. Long operations take an `op` chosen by the UI, which their progress events carry (Tauri
//! event `nightmail`, type `AppEvent`).

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use ts_rs::TS;

use crate::accounts::{AccountId, AccountView, Accounts, DeleteError};
use crate::app::{
    App, AppError, AppStatus, CoreError, FlagsInput, MessageDetail, MessageQuery, MessageView, PeriodInput, PlanView, Secret,
    SeedDraft, SeedPhrase, SentDetail, SentQuery, SentView, ServerHealth, WalletView,
};
use crate::instance::ProfileLock;
use crate::keys;
use crate::link::LinkInfo;
use crate::orchestrator::{AddressView, BonoInfo, NameCheck, PendingSlot, SlotId};
use crate::protocol::PingResult;
use crate::recovery::RecoveryReport;
use crate::rpc::RpcError;
use crate::supervisor::{SidecarError, SidecarStatus, SidecarSupervisor};

pub struct AppState {
    pub sidecar: Arc<SidecarSupervisor>,
    /// The core, or why it did not open (every command answers with that code): `badConfig` when settings are
    /// missing, `profileInUse` when another instance holds the profile.
    pub app: Result<Arc<App>, CoreError>,
    /// The accounts of this installation and the one opened at startup (`crate::accounts`). `None` without a profile
    /// folder (release builds for now).
    pub accounts: Option<Accounts>,
    /// Single-instance profile lock (`crate::instance`), kept here so it lives as long as the app. `Some` exactly when
    /// the core opened the account (it is the open account's lock).
    pub profile_lock: Option<ProfileLock>,
    /// The previous run deleted its open account and asked to show the profile list first (`take_show_accounts`).
    pub show_accounts: std::sync::atomic::AtomicBool,
}

impl AppState {
    fn app(&self) -> Reply<&Arc<App>> {
        self.app.as_ref().map_err(|e| AppError::Core(*e))
    }

    fn accounts(&self) -> Reply<&Accounts> {
        self.accounts.as_ref().ok_or(AppError::Core(CoreError::BadConfig))
    }

    /// Accounts are only switched with the session locked, so never with a payment in flight. Without a core (account
    /// in use by another window, incomplete settings) there is no session either.
    async fn ensure_locked(&self) -> Reply<()> {
        if let Ok(core) = &self.app
            && (core.wallet_busy() || core.status().await.unlocked)
        {
            return Err(AppError::Core(CoreError::SessionBusy));
        }
        Ok(())
    }
}

type State<'a> = tauri::State<'a, AppState>;
type Reply<T> = Result<T, AppError>;

#[derive(Serialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "code")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub enum CommandError {
    /// Midnight is not available in this build or could not be started.
    MidnightUnavailable,
    /// Midnight is restarting; retry in a few seconds.
    MidnightRestarting,
    /// Midnight did not answer in time.
    MidnightTimeout,
    /// Midnight error with its JSON-RPC code (no message).
    MidnightError {
        #[serde(rename = "rpcCode")]
        rpc_code: i32,
    },
    Internal,
}

impl From<SidecarError> for CommandError {
    fn from(e: SidecarError) -> Self {
        log::warn!("[command] {e}");
        match e {
            SidecarError::NotAvailable(_) | SidecarError::Spawn(_) | SidecarError::ProtocolMismatch { .. } => {
                CommandError::MidnightUnavailable
            }
            SidecarError::Backoff { .. } => CommandError::MidnightRestarting,
            SidecarError::Rpc(rpc) => rpc.into(),
        }
    }
}

impl From<RpcError> for CommandError {
    fn from(e: RpcError) -> Self {
        match e {
            RpcError::Timeout => CommandError::MidnightTimeout,
            RpcError::Closed => CommandError::MidnightRestarting,
            RpcError::Remote { code, .. } => {
                CommandError::MidnightError { rpc_code: i32::try_from(code).unwrap_or(i32::MIN) }
            }
            RpcError::BadResponse(_) | RpcError::Encode(_) => CommandError::Internal,
        }
    }
}

/// Health of the Midnight connection, for the UI.
#[derive(Serialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub struct MidnightHealth {
    pub sidecar_version: String,
    pub node_version: String,
    pub proof_server: bool,
    pub indexer: bool,
}

#[tauri::command]
pub async fn sidecar_status(state: State<'_>) -> Result<SidecarStatus, CommandError> {
    Ok(state.sidecar.status().await)
}

#[tauri::command]
pub async fn sidecar_ping(state: State<'_>) -> Result<MidnightHealth, CommandError> {
    // If another instance owns the profile, this one never starts the sidecar (not even when the UI asks): Midnight
    // is simply unavailable here.
    if state.app.as_ref().err() == Some(&CoreError::ProfileInUse) {
        return Err(CommandError::MidnightUnavailable);
    }
    let client = state.sidecar.client().await?;
    let ping: PingResult = client.call("ping", &serde_json::Value::Null, Duration::from_secs(10)).await?;
    Ok(MidnightHealth {
        sidecar_version: ping.sidecar_version,
        node_version: ping.node,
        proof_server: ping.proof_server,
        indexer: ping.indexer,
    })
}

/// Whether the NightMail server (mail, relayer and Issuer) answers. Needs no session.
#[tauri::command]
pub async fn server_ping(state: State<'_>) -> Reply<ServerHealth> {
    Ok(state.app()?.server_health().await)
}

// ---------- Seed and session ----------

#[tauri::command]
pub async fn app_status(state: State<'_>) -> Reply<AppStatus> {
    Ok(state.app()?.status().await)
}

/// Creating a profile, step 1: the new words, kept only in the core's memory until `create_seed` or
/// `discard_seed_draft`.
#[tauri::command]
pub async fn draft_seed(state: State<'_>) -> Reply<SeedDraft> {
    state.app()?.draft_seed().await
}

/// Creating a profile, step 2: saves the words of `draft` sealed with the password and opens the session.
#[tauri::command]
pub async fn create_seed(state: State<'_>, draft: u32, password: Secret) -> Reply<()> {
    state.app()?.create_seed(draft, password).await
}

/// Back from the words: they are dropped from memory, nothing was saved.
#[tauri::command]
pub async fn discard_seed_draft(state: State<'_>, draft: u32) -> Reply<()> {
    state.app()?.discard_seed_draft(draft);
    Ok(())
}

#[tauri::command]
pub async fn unlock(state: State<'_>, password: Secret) -> Reply<()> {
    state.app()?.unlock(password).await
}

#[tauri::command]
pub async fn lock(state: State<'_>) -> Reply<()> {
    state.app()?.lock().await
}

#[tauri::command]
pub async fn restore_seed(state: State<'_>, phrase: Secret, password: Secret) -> Reply<()> {
    state.app()?.restore_seed(phrase, password).await
}

#[tauri::command]
pub async fn recover(state: State<'_>, op: u64) -> Reply<RecoveryReport> {
    state.app()?.recover(op).await
}

#[tauri::command]
pub async fn reveal_seed(state: State<'_>, password: Secret) -> Reply<SeedPhrase> {
    state.app()?.reveal_seed(password).await
}

#[tauri::command]
pub async fn change_password(state: State<'_>, current: Secret, new: Secret) -> Reply<()> {
    state.app()?.change_password(current, new).await
}

// ---------- Plan ----------

#[tauri::command]
pub async fn get_plan(state: State<'_>) -> Reply<PlanView> {
    state.app()?.session().await?.plan().await
}

#[tauri::command]
pub async fn get_price(state: State<'_>) -> Reply<String> {
    state.app()?.session().await?.price().await
}

#[tauri::command]
pub async fn get_free_plan(state: State<'_>, op: u64) -> Reply<BonoInfo> {
    let session = state.app()?.session().await?;
    let result = session.free_plan(op).await;
    session.retry_later_if_payment_pending(&result).await;
    result
}

#[tauri::command]
pub async fn pay_fiat(state: State<'_>, period: PeriodInput, op: u64) -> Reply<BonoInfo> {
    let session = state.app()?.session().await?;
    let result = session.pay_fiat(period, op).await;
    session.retry_later_if_payment_pending(&result).await;
    result
}

#[tauri::command]
pub async fn pay_shielded(state: State<'_>, amount: String, op: u64) -> Reply<BonoInfo> {
    let session = state.app()?.session().await?;
    let result = session.pay_shielded(amount, op).await;
    session.retry_later_if_payment_pending(&result).await;
    result
}

#[tauri::command]
pub async fn wallet_info(state: State<'_>, op: u64) -> Reply<WalletView> {
    state.app()?.session().await?.wallet(op).await
}

#[tauri::command]
pub async fn faucet(state: State<'_>, op: u64) -> Reply<()> {
    state.app()?.session().await?.faucet(op).await
}

// ---------- Addresses ----------

#[tauri::command]
pub async fn list_addresses(state: State<'_>) -> Reply<Vec<AddressView>> {
    state.app()?.session().await?.addresses().await
}

#[tauri::command]
pub async fn check_name(state: State<'_>, name: String) -> Reply<NameCheck> {
    state.app()?.session().await?.check_name(name).await
}

#[tauri::command]
pub async fn create_mailbox(state: State<'_>, name: String, op: u64) -> Reply<AddressView> {
    let session = state.app()?.session().await?;
    let result = session.create_mailbox(name, op).await;
    session.retry_later_if_needed(&result);
    result
}

#[tauri::command]
pub async fn create_alias(state: State<'_>, op: u64) -> Reply<AddressView> {
    let session = state.app()?.session().await?;
    let result = session.create_alias(op).await;
    session.retry_later_if_needed(&result);
    result
}

#[tauri::command]
pub async fn provide_name(state: State<'_>, slot: SlotId, name: String, op: u64) -> Reply<AddressView> {
    let session = state.app()?.session().await?;
    let result = session.provide_name(slot, name, op).await;
    session.retry_later_if_needed(&result);
    result
}

/// Abandons one of our addresses (`addr_key` in hex): a local, irreversible mark that does not touch the chain.
#[tauri::command]
pub async fn abandon_address(state: State<'_>, addr_key: String) -> Reply<()> {
    state.app()?.session().await?.abandon_address(addr_key).await
}

// ---------- Mail ----------

#[tauri::command]
pub async fn list_messages(state: State<'_>, query: MessageQuery) -> Reply<Vec<MessageView>> {
    state.app()?.session().await?.messages(query).await
}

#[tauri::command]
pub async fn get_message(state: State<'_>, id: i64) -> Reply<MessageDetail> {
    state.app()?.session().await?.message(id).await
}

#[tauri::command]
pub async fn set_flags(state: State<'_>, id: i64, flags: FlagsInput) -> Reply<()> {
    state.app()?.session().await?.set_flags(id, flags).await
}

/// Applies the same flags to several messages in one transaction (Inbox or Archive selection).
#[tauri::command]
pub async fn set_flags_many(state: State<'_>, ids: Vec<i64>, flags: FlagsInput) -> Reply<()> {
    state.app()?.session().await?.set_flags_many(ids, flags).await
}

// ---------- Sending and «Sent» ----------

/// Sends a mail from one of our addresses (`fromAddrKey`, hex) to a NightMail address. An error (`SendError`, or
/// `invalidInput`) means nothing was stored or sent; otherwise the message as stored: `sent`, or `failed` with its
/// reason (retry it with `retry_sent`). The body is wiped from the core's memory once sent.
#[tauri::command]
pub async fn send_mail(
    state: State<'_>,
    from_addr_key: String,
    to_text: String,
    subject: String,
    body: Secret,
) -> Reply<SentView> {
    state.app()?.session().await?.send_mail(from_addr_key, to_text, subject, body).await
}

/// Delivers a sent message that is not `sent` again: the same mail (Message-ID and date), so the recipient keeps one.
#[tauri::command]
pub async fn retry_sent(state: State<'_>, id: i64) -> Reply<SentView> {
    state.app()?.session().await?.retry_sent(id).await
}

#[tauri::command]
pub async fn list_sent(state: State<'_>, query: SentQuery) -> Reply<Vec<SentView>> {
    state.app()?.session().await?.list_sent(query).await
}

#[tauri::command]
pub async fn get_sent(state: State<'_>, id: i64) -> Reply<SentDetail> {
    state.app()?.session().await?.get_sent(id).await
}

/// Deletes a sent message from this device for good (it was never stored anywhere else).
#[tauri::command]
pub async fn delete_sent(state: State<'_>, id: i64) -> Reply<()> {
    state.app()?.session().await?.delete_sent(id).await
}

/// How many sent messages there are, from one of our addresses (`addrKey` in hex) or from all.
#[tauri::command]
pub async fn count_sent(state: State<'_>, addr_key: Option<String>) -> Reply<u64> {
    state.app()?.session().await?.count_sent(addr_key).await
}

#[tauri::command]
pub async fn sync_now(state: State<'_>) -> Reply<()> {
    state.app()?.session().await?.sync_now();
    Ok(())
}

#[tauri::command]
pub async fn retry_stale(state: State<'_>) -> Reply<()> {
    state.app()?.session().await?.retry_stale().await
}

#[tauri::command]
pub async fn resume_paused_slot(state: State<'_>, slot: SlotId, op: u64) -> Reply<AddressView> {
    let session = state.app()?.session().await?;
    let result = session.resume_paused_slot(slot, op).await;
    session.retry_later_if_needed(&result);
    result
}

#[tauri::command]
pub async fn abandon_slot(state: State<'_>, slot: SlotId) -> Reply<()> {
    state.app()?.session().await?.abandon_slot(slot).await
}

#[tauri::command]
pub async fn forget_pending_bono(state: State<'_>, n: u32, k: u32) -> Reply<()> {
    state.app()?.session().await?.forget_pending_bono(n, k).await
}

#[tauri::command]
pub async fn list_pending_slots(state: State<'_>) -> Reply<Vec<PendingSlot>> {
    state.app()?.session().await?.pending_slots().await
}

/// Resumes unfinished work now; the result arrives as an event (`resumed`/`resumeFailed`).
#[tauri::command]
pub async fn resume_now(state: State<'_>) -> Reply<()> {
    state.app()?.session().await?.resume_now();
    Ok(())
}

// ---------- Links ----------

/// Validates a link from an email and returns what the confirmation should show (the URL that will be opened).
#[tauri::command]
pub async fn inspect_link(state: State<'_>, url: String) -> Reply<LinkInfo> {
    state.app()?.session().await?;
    Ok(crate::link::inspect_link(&url)?)
}

/// After confirmation: validates again and opens exactly the normalised URL in the system browser, using the `open`
/// crate from the core (no plugin: the webview has no command or permission to open anything).
#[tauri::command]
pub async fn open_link(state: State<'_>, url: String) -> Reply<()> {
    state.app()?.session().await?;
    Ok(crate::link::open_checked(&url, |checked| open::that_detached(checked))?)
}

// ---------- Taskbar badge ----------

/// Badge on NightMail's Windows taskbar button (`crate::badge`): Inbox unread count ("99+" from 100), nothing for 0,
/// or the padlock if `locked`. `show_count = false` hides the number while unlocked. Applies only to the calling
/// window, so the UI gets no window API. No-op outside Windows. Also called on lock, after the session is gone.
///
/// The core session decides, not the UI ([`crate::badge::decide`]): without a session the padlock is shown (or
/// nothing if never unlocked since startup) even if `locked: false` arrives with a number. Returns whether the padlock
/// is shown, so the UI knows what is actually visible. Decision and update happen under the session lock
/// ([`crate::app::App::with_session_now`]), so a number decided while open is queued before the padlock of a
/// concurrent lock.
#[tauri::command]
pub async fn set_taskbar_badge(
    state: State<'_>,
    window: tauri::Window,
    unread: u32,
    locked: bool,
    show_count: bool,
) -> Result<bool, CommandError> {
    use crate::badge::{Badge, SessionNow, apply, decide};
    // Outside the session lock: this blocks on the main thread.
    let scale = window.scale_factor().unwrap_or(1.0);
    let show = |session: SessionNow| {
        let badge = decide(unread, locked, show_count, session);
        apply(&window, badge, scale).map(|()| badge == Some(Badge::Locked))
    };
    let shown = match state.app.as_ref() {
        Ok(app) => app.with_session_now(show).await,
        Err(_) => show(SessionNow::NeverOpened),
    };
    shown.map_err(|e| {
        log::warn!("[badge] {e}");
        CommandError::Internal
    })
}

// ---------- New-mail sound ----------

/// Plays the new-mail sound from the system (`crate::chime`), outside the webview, so it is heard with the window
/// minimised or behind others. Only with NightMail unlocked: locked, nothing is announced. Returns whether it played;
/// `false` outside Windows, and the UI then plays it with Web Audio.
#[tauri::command]
pub async fn play_chime(state: State<'_>) -> Reply<bool> {
    state.app()?.session().await?;
    Ok(crate::chime::play())
}

// ---------- Accounts ----------
// They work without a core too (account open in another window, incomplete settings): they only touch the profile
// folder's account list, never an account's files.

/// What switching did: the app is restarting into the chosen account, or that account is already the open one (nothing
/// restarts and the UI returns to its front screen).
#[derive(Serialize, TS, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub enum SwitchOutcome {
    Restarting,
    AlreadyOpen,
}

fn account_error(e: std::io::Error) -> AppError {
    log::warn!("[accounts] {e}");
    AppError::Core(match e.kind() {
        _ if crate::fsutil::is_insecure(&e) => CoreError::InsecureFiles,
        std::io::ErrorKind::NotFound => CoreError::NotFound,
        std::io::ErrorKind::InvalidInput => CoreError::InvalidInput,
        _ => CoreError::Storage,
    })
}

/// The accounts saved on this device (with a seed), account 1 first.
#[tauri::command]
pub async fn list_accounts(state: State<'_>) -> Reply<Vec<AccountView>> {
    state.accounts()?.list().map_err(account_error)
}

/// Opens another account: saves the choice and restarts the app. `id` is one from `list_accounts`; anything else is
/// refused. Only with the session locked.
#[tauri::command]
pub async fn switch_account(handle: tauri::AppHandle, state: State<'_>, id: String) -> Reply<SwitchOutcome> {
    let accounts = state.accounts()?;
    let id = AccountId::parse(&id).ok_or(AppError::Core(CoreError::InvalidInput))?;
    if &id == accounts.current() {
        return Ok(SwitchOutcome::AlreadyOpen);
    }
    state.ensure_locked().await?;
    accounts.choose(&id).map_err(account_error)?;
    crate::restart_for_account(&handle, accounts.root());
    Ok(SwitchOutcome::Restarting)
}

/// "Crear o restaurar otra cuenta": prepares an empty account and restarts the app into it, where the front screen
/// offers to create or restore. If the open account is itself still empty, that is the one to use: nothing restarts.
#[tauri::command]
pub async fn new_account(handle: tauri::AppHandle, state: State<'_>) -> Reply<SwitchOutcome> {
    let accounts = state.accounts()?;
    if !accounts.has_seed(accounts.current()) {
        return Ok(SwitchOutcome::AlreadyOpen);
    }
    state.ensure_locked().await?;
    accounts.create().map_err(account_error)?;
    crate::restart_for_account(&handle, accounts.root());
    Ok(SwitchOutcome::Restarting)
}

/// Names the open account, right after creating or restoring it or later from Settings (`crate::accounts`: stored
/// unencrypted in its folder, shown in the list before unlocking). Empty: the automatic name, keeping its number. Only
/// with the session open, so only whoever knows the password can name it. Too long (after cleaning): `invalidInput`.
/// Returns the account as listed now.
#[tauri::command]
pub async fn set_account_name(state: State<'_>, name: String) -> Reply<AccountView> {
    state.app()?.session().await?;
    let accounts = state.accounts()?;
    accounts.set_name(accounts.current(), &name).map_err(account_error)
}

/// What deleting did: the account is gone and this window goes on (another account than the open one), or the open
/// account was deleted and the app is restarting (into the profile list, or the welcome screen if none is left).
#[derive(Serialize, TS, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub enum DeleteOutcome {
    Deleted,
    Restarting,
}

fn delete_error(e: DeleteError) -> AppError {
    match e {
        DeleteError::InUse => AppError::Core(CoreError::ProfileInUse),
        DeleteError::NotFound => AppError::Core(CoreError::NotFound),
        DeleteError::Key(e) => e.into(),
        DeleteError::Io(e) => account_error(e),
    }
}

/// "Eliminar perfil de este ordenador": deletes an account's files on this device (`crate::accounts`), nothing on the
/// chain. `id` is one from `list_accounts`; anything else is refused. The account's password is checked as unlocking
/// does (same failed-attempt counter and waits): wrong, nothing is deleted. Open in another window: `profileInUse`.
///
/// The open account (from Settings, or from the list on the front screen): its session is closed as "Cerrar sesión"
/// does (`sessionBusy` with an operation or payment in flight, and then nothing is deleted) and Midnight is stopped
/// before removing anything, then the app restarts into another account with the profile list in front, or into the
/// welcome screen if none is left. If removing fails midway, the account is still there (the seed goes last) and the
/// deletion can be repeated; Midnight stays stopped until the app restarts.
#[tauri::command]
pub async fn delete_account(
    handle: tauri::AppHandle,
    state: State<'_>,
    id: String,
    password: Secret,
) -> Reply<DeleteOutcome> {
    let accounts = state.accounts()?;
    let id = AccountId::parse(&id).ok_or(AppError::Core(CoreError::InvalidInput))?;
    let open = &id == accounts.current();
    // This process holds the open account's lock only if its core started; otherwise it is taken like any other.
    let deletion = accounts.prepare_delete(&id, open && state.profile_lock.is_some()).map_err(delete_error)?;
    let dir = deletion.dir().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || keys::check_password(&dir, &password.0))
        .await
        .map_err(|_| AppError::Core(CoreError::Internal))?
        .map_err(|e| delete_error(DeleteError::Key(e)))?;
    if open && let Ok(core) = &state.app {
        // As "Cerrar sesión", then Midnight stops: nothing may write the account's files while they are removed.
        core.lock().await?;
        core.shutdown().await;
    }
    let remover = accounts.clone();
    tauri::async_runtime::spawn_blocking(move || remover.delete(deletion))
        .await
        .map_err(|_| AppError::Core(CoreError::Internal))?
        .map_err(account_error)?;
    if !open {
        return Ok(DeleteOutcome::Deleted);
    }
    if let Err(e) = accounts.choose_after_delete() {
        // `current-account` no longer names the deleted account (`Accounts::delete`): account 1 opens next.
        log::warn!("[accounts] could not choose the next account: {e}");
    }
    crate::restart_for_account(&handle, accounts.root());
    Ok(DeleteOutcome::Restarting)
}

/// Whether to show the profile list first, once: the previous run deleted its open account.
#[tauri::command]
pub async fn take_show_accounts(state: State<'_>) -> Reply<bool> {
    Ok(state.show_accounts.swap(false, std::sync::atomic::Ordering::Relaxed))
}

/// Names of all commands (the same ones `build.rs` declares for capabilities).
#[cfg(test)]
pub const COMMANDS: &[&str] = &[
    "sidecar_status",
    "sidecar_ping",
    "server_ping",
    "app_status",
    "draft_seed",
    "create_seed",
    "discard_seed_draft",
    "unlock",
    "lock",
    "restore_seed",
    "recover",
    "reveal_seed",
    "change_password",
    "get_plan",
    "get_price",
    "get_free_plan",
    "pay_fiat",
    "pay_shielded",
    "wallet_info",
    "faucet",
    "list_addresses",
    "check_name",
    "create_mailbox",
    "create_alias",
    "provide_name",
    "abandon_address",
    "list_messages",
    "get_message",
    "set_flags",
    "set_flags_many",
    "send_mail",
    "retry_sent",
    "list_sent",
    "get_sent",
    "delete_sent",
    "count_sent",
    "sync_now",
    "retry_stale",
    "resume_paused_slot",
    "abandon_slot",
    "forget_pending_bono",
    "list_pending_slots",
    "resume_now",
    "inspect_link",
    "open_link",
    "set_taskbar_badge",
    "play_chime",
    "list_accounts",
    "switch_account",
    "new_account",
    "set_account_name",
    "delete_account",
    "take_show_accounts",
];

#[cfg(test)]
mod tests {
    use super::*;

    /// `build.rs` and the capability declare exactly the commands in [`COMMANDS`].
    #[test]
    fn build_script_and_capability_list_every_command() {
        let build = include_str!("../build.rs");
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let allowed: Vec<&str> = capability["permissions"].as_array().unwrap().iter().filter_map(|p| p.as_str()).collect();
        for command in COMMANDS {
            assert!(build.contains(&format!("\"{command}\"")), "build.rs lacks {command}");
            assert!(allowed.contains(&format!("allow-{}", command.replace('_', "-")).as_str()), "capability lacks {command}");
        }
        // Nothing but the commands and listening to core events.
        let extra: Vec<&&str> = allowed.iter().filter(|p| !p.starts_with("allow-")).collect();
        assert_eq!(extra, [&"core:event:allow-listen", &"core:event:allow-unlisten"]);
        assert_eq!(allowed.len(), COMMANDS.len() + 2);
    }

    /// `lib.rs` registers every command in [`COMMANDS`] with `generate_handler!`.
    #[test]
    fn every_command_is_registered() {
        let lib = include_str!("lib.rs");
        for command in COMMANDS {
            assert!(lib.contains(&format!("commands::{command},")), "generate_handler! lacks {command}");
        }
    }

    #[test]
    fn rpc_codes_out_of_range_do_not_wrap() {
        let e = CommandError::from(RpcError::Remote { code: i64::MAX, message: String::new(), data: None });
        assert_eq!(e, CommandError::MidnightError { rpc_code: i32::MIN });
    }
}
