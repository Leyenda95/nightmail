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

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use accounts::{Accounts, WindowPlace};
use app::{App, AppEvent, CoreError};
use commands::AppState;
use instance::ProfileLock;
use protocol::InitializeParams;
use supervisor::{SidecarConfig, SidecarSupervisor};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, RunEvent, WindowEvent};

/// Name of the single core-to-UI event (payload: `AppEvent`).
const EVENT: &str = "nightmail";
/// How often to check whether the payment delaying shutdown has finished.
const EXIT_POLL: Duration = Duration::from_secs(1);
/// Label of the app's only window (`tauri.conf.json`).
const MAIN_WINDOW: &str = "main";
/// How long startup keeps trying to take an account that is in use (the previous process finishing after a switch).
#[cfg_attr(not(debug_assertions), allow(dead_code))]
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
fn profile_root(app: &tauri::App) -> Option<std::path::PathBuf> {
    dev::profile_dir(app)
}

#[cfg(not(debug_assertions))]
fn profile_root(_app: &tauri::App) -> Option<std::path::PathBuf> {
    None
}

/// The app on the account opened at startup, with its folder locked (see `instance`), or the error every command will
/// return: `profileInUse` when another live instance holds the account, `badConfig` when settings are missing.
#[cfg(debug_assertions)]
fn build_app(
    app: &tauri::App,
    sidecar: Arc<SidecarSupervisor>,
    accounts: Option<&Accounts>,
) -> Result<(Arc<App>, ProfileLock), CoreError> {
    use app::EventSink;
    use transport::{Transport, TransportConfig};
    let profile = accounts.ok_or(CoreError::BadConfig)?.current_dir();
    // Lock first: while another instance owns the profile, none of its files may be touched. After switching accounts
    // the previous process may still be finishing, so it is given a moment.
    let lock = ProfileLock::acquire_waiting(&profile, LOCK_WAIT).map_err(|e| {
        log::error!("[app] could not take the profile {}: {e:?}", profile.display());
        e.core_error()
    })?;
    let config = app::AppConfig::devnet(profile, |name| std::env::var(name).ok(), dev::deployment_file().as_deref())
        .map_err(|e| {
            log::error!("[app] incomplete configuration: {e:?}");
            CoreError::BadConfig
        })?;
    let transport = Arc::new(Transport::direct(&TransportConfig::default()).map_err(|_| CoreError::BadConfig)?);
    let handle = app.handle().clone();
    let sink: EventSink = Arc::new(move |event| {
        let _ = handle.emit(EVENT, event);
    });
    Ok((Arc::new(App::new(config, sidecar, transport, sink)), lock))
}

/// Release builds: public network configuration (per-network compiled constants, never read from the environment)
/// is not defined yet, so release builds neither start the sidecar nor open the app.
#[cfg(not(debug_assertions))]
fn build_app(
    _app: &tauri::App,
    _sidecar: Arc<SidecarSupervisor>,
    _accounts: Option<&Accounts>,
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
    handle.state::<AppState>().app.as_ref().ok().filter(|core| core.wallet_busy()).cloned()
}

/// Restarts the app to open another account (`current-account` is already written). The normal exit runs first
/// (`RunEvent::Exit`: `core.shutdown()`), then Tauri starts the same executable with the same arguments, environment
/// and working directory. The window's size and position are saved so the new process opens it in the same place.
pub(crate) fn restart_for_account(handle: &AppHandle, root: &Path) {
    if let Some(window) = handle.get_webview_window(MAIN_WINDOW) {
        let place = WindowPlace {
            // Wayland does not report positions: then only the size is kept.
            position: window.outer_position().ok().map(|p| (p.x, p.y)),
            size: window.inner_size().ok().map(|s| (s.width, s.height)),
            maximized: window.is_maximized().unwrap_or(false),
        };
        if let Err(e) = accounts::save_window_place(root, place) {
            log::warn!("[accounts] could not save the window place: {e}");
        }
    }
    handle.request_restart();
}

/// Puts the window where it was before restarting for another account (only then is there a saved place).
fn restore_window_place(app: &tauri::App, root: &Path) {
    let (Some(place), Some(window)) = (accounts::take_window_place(root), app.get_webview_window(MAIN_WINDOW)) else {
        return;
    };
    // Only onto a screen that is there now (several monitors: one may have been unplugged).
    let screens: Vec<accounts::ScreenRect> = window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| ((m.position().x, m.position().y), (m.size().width, m.size().height)))
        .collect();
    let position = place.position.filter(|&p| accounts::reachable(p, &screens));
    // Maximised, the saved size is the whole screen's: moving to that screen and maximising again is enough.
    if !place.maximized
        && let Some((width, height)) = place.size
    {
        let _ = window.set_size(PhysicalSize::new(width, height));
    }
    if let Some((x, y)) = position {
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
    if place.maximized {
        let _ = window.maximize();
    }
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
            // Local devnet for now; the network (devnet/preprod) will become a core setting.
            let sidecar = Arc::new(SidecarSupervisor::new(
                SidecarConfig::resolve(),
                InitializeParams::devnet(cfg!(debug_assertions)),
            ));
            // The account to open is fixed here for the whole run (switching restarts the app).
            let accounts = profile_root(app).map(Accounts::at_startup);
            let mut show_accounts = false;
            if let Some(accounts) = &accounts {
                restore_window_place(app, accounts.root());
                show_accounts = accounts::take_show_accounts(accounts.root());
            }
            let (core, profile_lock) = match build_app(app, Arc::clone(&sidecar), accounts.as_ref()) {
                Ok((core, lock)) => (Ok(core), Some(lock)),
                Err(e) => (Err(e), None),
            };
            // If another instance owns the profile, start nothing: the UI only explains the situation.
            let warm_up = core.as_ref().err() != Some(&CoreError::ProfileInUse);
            app.manage(AppState {
                sidecar: Arc::clone(&sidecar),
                app: core,
                accounts,
                profile_lock,
                show_accounts: show_accounts.into(),
            });
            // Warm up in the background so startup does not wait for Midnight.
            if warm_up {
                tauri::async_runtime::spawn(async move {
                    let _ = sidecar.client().await;
                });
            }
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
            commands::create_seed,
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
            let (sidecar, core) = (Arc::clone(&state.sidecar), state.app.as_ref().ok().cloned());
            tauri::async_runtime::block_on(async move {
                match core {
                    Some(core) => core.shutdown().await,
                    None => sidecar.shutdown().await,
                }
            });
        }
        _ => {}
    });
}
