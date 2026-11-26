//! NightMail core.

// Release builds have no profile folder yet (see `build_app`), so there are no accounts to list or switch.
#[cfg_attr(not(debug_assertions), allow(dead_code))]
mod accounts;
// Release builds do not configure the app yet (see `build_app`), so all of `app` is unused there. The dead-code
// warning for `app::config` also crashes rustc 1.94 while rendering it (ICE in annotate_snippets).
#[cfg_attr(not(debug_assertions), allow(dead_code))]
mod app;
// Outside Windows only `decide` is used (by the rendering tests).
#[cfg_attr(not(windows), allow(dead_code))]
mod badge;
// Outside Windows only the WAV tests use it.
#[cfg_attr(not(windows), allow(dead_code))]
mod chime;
mod commands;
mod crypto;
// Some helpers are only used by tests.
#[allow(dead_code)]
mod fsutil;
// Release builds have no profile yet (see `build_app`); the lock is only taken in debug builds.
#[cfg_attr(not(debug_assertions), allow(dead_code))]
mod instance;
mod keys;
mod link;
mod mail;
mod nav_guard;
// `faucet` and a few read paths are not wired to the UI yet.
#[allow(dead_code)]
mod orchestrator;
mod protocol;
mod recovery;
mod rpc;
// Part of the store API is only used by tests.
#[allow(dead_code)]
mod store;
mod supervisor;
mod transport;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use accounts::Accounts;
use app::{App, AppEvent, CoreError};
use commands::{AppState, Profile};
use instance::ProfileLock;
use protocol::InitializeParams;
use supervisor::{SidecarConfig, SidecarSupervisor};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};

/// Name of the single core-to-UI event (payload: `AppEvent`).
const EVENT: &str = "nightmail";
/// How often to check whether the payment delaying shutdown has finished.
const EXIT_POLL: Duration = Duration::from_secs(1);
/// How long startup keeps trying to take an account that is in use (the previous run of the app may still be
/// finishing).
const LOCK_WAIT: Duration = Duration::from_secs(3);

/// Debug builds (devnet): profile, configuration and deployment come from the environment and the repository.
#[cfg(debug_assertions)]
mod dev {
    use std::path::PathBuf;

    /// Profile directory: `NIGHTMAIL_PROFILE_DIR` (relative paths are made absolute; handy for testing restore on a
    /// clean profile) or the app data directory.
    pub fn profile_dir(app: &tauri::App) -> Option<PathBuf> {
        use tauri::Manager;
        match std::env::var_os("NIGHTMAIL_PROFILE_DIR") {
            Some(dir) => std::path::absolute(PathBuf::from(dir)).ok(),
            None => app.path().app_data_dir().ok(),
        }
    }

    /// Devnet deployment `contracts.json`: the repository one, or `NIGHTMAIL_CONTRACTS_FILE`.
    pub fn deployment_file() -> Option<String> {
        let path = std::env::var_os("NIGHTMAIL_CONTRACTS_FILE").map(PathBuf::from).unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../.data/operator/undeployed/contracts.json")
        });
        std::fs::read_to_string(path).ok()
    }
}

/// The profile folder that holds the accounts (`accounts`). Release builds have none yet.
#[cfg(debug_assertions)]
fn profile_root(app: &tauri::App) -> Option<PathBuf> {
    dev::profile_dir(app)
}

#[cfg(not(debug_assertions))]
fn profile_root(_app: &tauri::App) -> Option<PathBuf> {
    None
}

/// The app on the open account, with its folder locked (see `instance`), or the error every command will return:
/// `profileInUse` when another live instance holds the account, `badConfig` when settings are missing. `lock_wait`: how
/// long to keep trying while the account is in use.
#[cfg(debug_assertions)]
fn build_app(
    handle: &AppHandle,
    sidecar: Arc<SidecarSupervisor>,
    accounts: Option<&Accounts>,
    lock_wait: Duration,
) -> Result<(Arc<App>, ProfileLock), CoreError> {
    use app::EventSink;
    use transport::{Transport, TransportConfig};
    let profile = accounts.ok_or(CoreError::BadConfig)?.current_dir();
    // Lock first: while another instance owns the profile, none of its files may be touched.
    let lock = ProfileLock::acquire_waiting(&profile, lock_wait).map_err(|e| {
        log::error!("[app] could not take the profile {}: {e:?}", profile.display());
        e.core_error()
    })?;
    let config = app::AppConfig::devnet(profile, |name| std::env::var(name).ok(), dev::deployment_file().as_deref())
        .map_err(|e| {
            log::error!("[app] incomplete configuration: {e:?}");
            CoreError::BadConfig
        })?;
    let transport = Arc::new(Transport::direct(&TransportConfig::default()).map_err(|_| CoreError::BadConfig)?);
    let handle = handle.clone();
    let sink: EventSink = Arc::new(move |event| {
        let _ = handle.emit(EVENT, event);
    });
    Ok((Arc::new(App::new(config, sidecar, transport, sink)), lock))
}

/// Release builds: public network configuration (per-network compiled constants, never read from the environment)
/// is not defined yet, so release builds neither start the sidecar nor open the app.
#[cfg(not(debug_assertions))]
fn build_app(
    _handle: &AppHandle,
    _sidecar: Arc<SidecarSupervisor>,
    _accounts: Option<&Accounts>,
    _lock_wait: Duration,
) -> Result<(Arc<App>, ProfileLock), CoreError> {
    log::error!("[app] release configuration pending");
    Err(CoreError::BadConfig)
}

/// Shutdown waits while a wallet payment is in flight: the UI is notified and the app exits once it finishes.
fn exit_when_idle(handle: &AppHandle, core: Arc<App>, finish: impl FnOnce() + Send + 'static) {
    let _ = handle.emit(EVENT, AppEvent::ExitDeferred);
    tauri::async_runtime::spawn(async move {
        while core.wallet_busy() {
            tokio::time::sleep(EXIT_POLL).await;
        }
        finish();
    });
}

fn busy_core(handle: &AppHandle) -> Option<Arc<App>> {
    handle.state::<AppState>().busy_core()
}

/// Opens the account that `current-account` names under `root` (release builds have no profile folder yet): the
/// accounts as they are now, a Midnight of its own (started lazily, warmed up in the background) and the app on that
/// account, with its folder locked. At startup and each time another account opens in the same window
/// (`commands::reopen`). Also returns whether the profile list goes first (`accounts::take_show_accounts`).
pub(crate) fn open_profile(handle: &AppHandle, root: Option<PathBuf>, lock_wait: Duration) -> (Profile, bool) {
    // Local devnet for now; the network (devnet/preprod) will become a core setting.
    let sidecar = Arc::new(SidecarSupervisor::new(
        SidecarConfig::resolve(),
        InitializeParams::devnet(cfg!(debug_assertions)),
    ));
    let accounts = root.map(Accounts::at_startup);
    let show_accounts = accounts.as_ref().is_some_and(|a| accounts::take_show_accounts(a.root()));
    let (app, profile_lock) = match build_app(handle, Arc::clone(&sidecar), accounts.as_ref(), lock_wait) {
        Ok((core, lock)) => (Ok(core), Some(lock)),
        Err(e) => (Err(e), None),
    };
    // If another instance owns the profile, start nothing: the UI only explains the situation. Otherwise warm up in the
    // background so the front screen does not wait for Midnight.
    if app.as_ref().err() != Some(&CoreError::ProfileInUse) {
        let warm = Arc::clone(&sidecar);
        tauri::async_runtime::spawn(async move {
            let _ = warm.client().await;
        });
    }
    (Profile { sidecar, app, accounts, profile_lock }, show_accounts)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // The window may only navigate within the app origin.
        .plugin(nav_guard::plugin())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle()
                    .plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())?;
            }
            // Another account opens in this same window later (`commands::switch_account`), never by restarting.
            let (profile, show_accounts) = open_profile(app.handle(), profile_root(app), LOCK_WAIT);
            // On a cold start the profile list always goes first when there is a profile to choose. Only here: opening
            // another profile from the list in this window lands on its front screen.
            let show_accounts = show_accounts || profile.accounts.as_ref().is_some_and(Accounts::list_first_at_startup);
            app.manage(AppState::new(profile, show_accounts));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event
                && let Some(core) = busy_core(window.app_handle())
            {
                api.prevent_close();
                let (handle, window) = (window.app_handle().clone(), window.clone());
                exit_when_idle(&handle, core, move || {
                    let _ = window.close();
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::sidecar_status,
            commands::sidecar_ping,
            commands::server_ping,
            commands::app_status,
            commands::draft_seed,
            commands::create_seed,
            commands::discard_seed_draft,
            commands::unlock,
            commands::lock,
            commands::restore_seed,
            commands::recover,
            commands::reveal_seed,
            commands::change_password,
            commands::get_plan,
            commands::get_price,
            commands::get_free_plan,
            commands::pay_fiat,
            commands::pay_shielded,
            commands::wallet_info,
            commands::faucet,
            commands::list_addresses,
            commands::check_name,
            commands::create_mailbox,
            commands::create_alias,
            commands::provide_name,
            commands::abandon_address,
            commands::list_messages,
            commands::get_message,
            commands::set_flags,
            commands::set_flags_many,
            commands::send_mail,
            commands::retry_sent,
            commands::list_sent,
            commands::get_sent,
            commands::delete_sent,
            commands::count_sent,
            commands::sync_now,
            commands::retry_stale,
            commands::resume_paused_slot,
            commands::abandon_slot,
            commands::forget_pending_bono,
            commands::list_pending_slots,
            commands::resume_now,
            commands::inspect_link,
            commands::open_link,
            commands::set_taskbar_badge,
            commands::play_chime,
            commands::list_accounts,
            commands::switch_account,
            commands::new_account,
            commands::set_account_name,
            commands::delete_account,
            commands::take_show_accounts,
        ])
        .build(tauri::generate_context!())
        .expect("error while building NightMail");

    app.run(|handle, event| match event {
        RunEvent::ExitRequested { api, code, .. } => {
            if let Some(core) = busy_core(handle) {
                api.prevent_exit();
                let exit = handle.clone();
                exit_when_idle(handle, core, move || exit.exit(code.unwrap_or(0)));
            }
        }
        RunEvent::Exit => {
            let state = handle.state::<AppState>();
            tauri::async_runtime::block_on(state.shutdown());
        }
        _ => {}
    });
}
