//! Supervisor for the `midnight-sidecar` process.
//!
//! - Lazy start: the app works without Midnight (reading downloaded mail); the sidecar is spawned on the first call
//!   that needs it.
//! - Clean environment (`env_clear` plus an allowlist): no `NODE_OPTIONS`, `--inspect`, `--require` or endpoints from
//!   environment variables. The core sends the endpoints in `initialize`.
//! - `initialize` handshake with a protocol version and its own startup timeout.
//! - Restart with growing backoff if the process dies or the channel closes. Restarting is cheap because the sidecar
//!   holds no secrets.
//! - stderr is captured and only logged in debug builds.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio::time::Instant;
use ts_rs::TS;

use crate::protocol::{self, InitializeParams, InitializeResult};
use crate::rpc::{RpcClient, RpcError, RpcOptions};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
/// Time for the sidecar to close the wallet and release its state, so a payment is not cut off.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(15);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
const STDERR_LINE_MAX: usize = 8 * 1024;

/// Environment variables passed to the sidecar; everything else is dropped.
// Never HTTP(S)_PROXY, NODE_USE_ENV_PROXY or NODE_OPTIONS: they would divert requests to the local proof server,
// which carry the witnesses, to the outside (a test enforces this).
const ENV_ALLOWLIST: &[&str] = &["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SystemRoot", "TEMP", "USERPROFILE"];

/// How to launch the sidecar.
#[derive(Debug, Clone)]
pub struct SidecarConfig {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub working_dir: PathBuf,
}

impl SidecarConfig {
    /// Development: `node src/index.ts` in `apps/midnight-sidecar` (Node ≥ 24 runs TS directly).
    /// `NIGHTMAIL_NODE` and `NIGHTMAIL_SIDECAR_DIR` are only honoured in debug builds.
    #[cfg(debug_assertions)]
    pub fn dev() -> Self {
        let program = std::env::var_os("NIGHTMAIL_NODE").map(PathBuf::from).unwrap_or_else(|| "node".into());
        let working_dir = std::env::var_os("NIGHTMAIL_SIDECAR_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../midnight-sidecar"));
        Self { program, args: vec!["src/index.ts".into()], working_dir }
    }

    /// Configuration for the current build type.
    pub fn resolve() -> Result<Self, String> {
        #[cfg(debug_assertions)]
        {
            Ok(Self::dev())
        }
        #[cfg(not(debug_assertions))]
        {
            // Not implemented yet: bundled Node plus the sidecar in the app resources, with absolute paths. Until
            // then release builds start no sidecar.
            Err("sidecar packaging not implemented yet".into())
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SidecarError {
    /// There is no way to launch the sidecar in this build.
    NotAvailable(String),
    /// The process could not be spawned.
    Spawn(String),
    /// Incompatible protocol version.
    ProtocolMismatch { ours: String, theirs: String },
    /// Must wait before retrying.
    Backoff { retry_in: Duration },
    Rpc(RpcError),
}

impl std::fmt::Display for SidecarError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SidecarError::NotAvailable(e) => write!(f, "sidecar not available: {e}"),
            SidecarError::Spawn(e) => write!(f, "cannot spawn sidecar: {e}"),
            SidecarError::ProtocolMismatch { ours, theirs } => write!(f, "protocol mismatch: core {ours}, sidecar {theirs}"),
            SidecarError::Backoff { retry_in } => write!(f, "sidecar restarting, retry in {retry_in:?}"),
            SidecarError::Rpc(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for SidecarError {}

impl From<RpcError> for SidecarError {
    fn from(e: RpcError) -> Self {
        SidecarError::Rpc(e)
    }
}

/// State visible to the UI.
#[derive(Serialize, TS, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "state")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub enum SidecarStatus {
    NotStarted,
    // The enum's `rename_all` only renames variants; fields are renamed one by one.
    Ready {
        #[serde(rename = "sidecarVersion")]
        sidecar_version: String,
    },
    Down {
        failures: u32,
    },
    Unavailable,
}

struct Running {
    client: Arc<RpcClient>,
    child: Child,
    sidecar_version: String,
    // Full handshake (version and methods): the orchestrator requires `wallet.*` at startup.
    init: InitializeResult,
}

#[derive(Default)]
struct Inner {
    running: Option<Running>,
    failures: u32,
    last_attempt: Option<Instant>,
    /// After `shutdown` nothing is relaunched (a command in flight at exit must not start another sidecar).
    shut_down: bool,
}

pub struct SidecarSupervisor {
    launch: Result<SidecarConfig, String>,
    init: InitializeParams,
    inner: Mutex<Inner>,
}

fn backoff(failures: u32) -> Duration {
    if failures == 0 {
        return Duration::ZERO;
    }
    let secs = 1u64 << (failures - 1).min(5); // 1, 2, 4, 8, 16, 32…
    Duration::from_secs(secs).min(MAX_BACKOFF)
}

impl SidecarSupervisor {
    pub fn new(launch: Result<SidecarConfig, String>, init: InitializeParams) -> Self {
        Self { launch, init, inner: Mutex::new(Inner::default()) }
    }

    /// Client ready to use; spawns or respawns the sidecar if needed.
    pub async fn client(&self) -> Result<Arc<RpcClient>, SidecarError> {
        let mut inner = self.inner.lock().await;
        if inner.shut_down {
            return Err(SidecarError::NotAvailable("shut down".into()));
        }

        if let Some(running) = inner.running.as_mut() {
            let alive = matches!(running.child.try_wait(), Ok(None));
            if alive && !running.client.is_closed() {
                return Ok(running.client.clone());
            }
            log::warn!("[sidecar] process down or channel closed: restarting");
            running.client.close();
            let _ = running.child.start_kill();
            inner.running = None;
        }

        if let Some(last) = inner.last_attempt {
            let wait = backoff(inner.failures);
            let elapsed = last.elapsed();
            if elapsed < wait {
                return Err(SidecarError::Backoff { retry_in: wait - elapsed });
            }
        }
        inner.last_attempt = Some(Instant::now());

        match self.start().await {
            Ok(running) => {
                inner.failures = 0;
                let client = running.client.clone();
                inner.running = Some(running);
                Ok(client)
            }
            Err(e) => {
                inner.failures = inner.failures.saturating_add(1);
                log::warn!("[sidecar] start failed ({} in a row): {e}", inner.failures);
                Err(e)
            }
        }
    }

    async fn start(&self) -> Result<Running, SidecarError> {
        let cfg = self.launch.as_ref().map_err(|e| SidecarError::NotAvailable(e.clone()))?;

        let mut cmd = Command::new(&cfg.program);
        cmd.args(&cfg.args)
            .current_dir(&cfg.working_dir)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for key in ENV_ALLOWLIST {
            if let Some(val) = std::env::var_os(key) {
                cmd.env(key, val);
            }
        }
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd.spawn().map_err(|e| SidecarError::Spawn(e.to_string()))?;
        let stdin = child.stdin.take().ok_or_else(|| SidecarError::Spawn("no stdin".into()))?;
        let stdout = child.stdout.take().ok_or_else(|| SidecarError::Spawn("no stdout".into()))?;
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(drain_stderr(stderr));
        }

        let client = Arc::new(RpcClient::new(stdout, stdin, RpcOptions::default()));
        let result: InitializeResult = match client.call("initialize", &self.init, STARTUP_TIMEOUT).await {
            Ok(r) => r,
            Err(e) => {
                client.close();
                let _ = child.start_kill();
                return Err(e.into());
            }
        };
        if !protocol::compatible(&result.protocol_version, protocol::PROTOCOL_VERSION) {
            client.close();
            let _ = child.start_kill();
            return Err(SidecarError::ProtocolMismatch {
                ours: protocol::PROTOCOL_VERSION.into(),
                theirs: result.protocol_version,
            });
        }
        log::info!("[sidecar] ready (v{}, protocol {})", result.sidecar_version, result.protocol_version);
        Ok(Running { client, child, sidecar_version: result.sidecar_version.clone(), init: result })
    }

    /// `initialize` handshake of the running sidecar (spawned if needed): protocol version and methods.
    pub async fn handshake(&self) -> Result<InitializeResult, SidecarError> {
        self.client().await?;
        let inner = self.inner.lock().await;
        inner.running.as_ref().map(|r| r.init.clone()).ok_or(SidecarError::Rpc(RpcError::Closed))
    }

    pub async fn status(&self) -> SidecarStatus {
        if self.launch.is_err() {
            return SidecarStatus::Unavailable;
        }
        let mut inner = self.inner.lock().await;
        let failures = inner.failures;
        match inner.running.as_mut() {
            Some(r) => {
                let alive = matches!(r.child.try_wait(), Ok(None)) && !r.client.is_closed();
                if alive {
                    SidecarStatus::Ready { sidecar_version: r.sidecar_version.clone() }
                } else {
                    SidecarStatus::Down { failures }
                }
            }
            None if failures > 0 => SidecarStatus::Down { failures },
            None => SidecarStatus::NotStarted,
        }
    }

    /// Orderly shutdown: EOF on stdin, a short wait, then kill if it has not exited.
    pub async fn shutdown(&self) {
        let running = {
            let mut inner = self.inner.lock().await;
            inner.shut_down = true;
            inner.running.take()
        };
        if let Some(mut r) = running {
            r.client.close();
            match tokio::time::timeout(SHUTDOWN_GRACE, r.child.wait()).await {
                Ok(_) => log::info!("[sidecar] closed"),
                Err(_) => {
                    log::warn!("[sidecar] did not exit within {SHUTDOWN_GRACE:?}: killing it");
                    let _ = r.child.kill().await;
                }
            }
        }
    }
}

/// Reads the sidecar's stderr. Logged (truncated) in debug builds; discarded in release, since it may contain
/// library error details.
async fn drain_stderr(mut stderr: tokio::process::ChildStderr) {
    let mut buf = vec![0u8; 4096];
    let mut line: Vec<u8> = Vec::new();
    loop {
        match stderr.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if !cfg!(debug_assertions) {
                    continue;
                }
                for &b in &buf[..n] {
                    if b == b'\n' {
                        log::info!("[sidecar stderr] {}", String::from_utf8_lossy(&line));
                        line.clear();
                    } else if line.len() < STDERR_LINE_MAX {
                        line.push(b);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{InitializeParams, PingResult};

    fn supervisor() -> SidecarSupervisor {
        // Endpoints on closed ports: tests do not depend on the devnet.
        let mut init = InitializeParams::devnet(false);
        init.endpoints.proof_server = "http://127.0.0.1:9".into();
        init.endpoints.indexer = "http://127.0.0.1:9/graphql".into();
        SidecarSupervisor::new(Ok(SidecarConfig::dev()), init)
    }

    #[tokio::test]
    async fn starts_greets_and_answers_ping() {
        let sup = supervisor();
        assert_eq!(sup.status().await, SidecarStatus::NotStarted);
        let client = sup.client().await.expect("client");
        let ping: PingResult = client.call("ping", &serde_json::Value::Null, Duration::from_secs(10)).await.unwrap();
        assert!(ping.pong);
        assert!(!ping.proof_server, "port 9 is closed");
        assert!(matches!(sup.status().await, SidecarStatus::Ready { .. }));
        sup.shutdown().await;
    }

    #[tokio::test]
    async fn restarts_if_the_process_dies() {
        let sup = supervisor();
        let first = sup.client().await.unwrap();
        // Kill the process forcibly.
        sup.inner.lock().await.running.as_mut().unwrap().child.kill().await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(first.is_closed());
        let second = sup.client().await.expect("restarted");
        assert!(!Arc::ptr_eq(&first, &second));
        let ping: PingResult = second.call("ping", &serde_json::Value::Null, Duration::from_secs(10)).await.unwrap();
        assert!(ping.pong);
        sup.shutdown().await;
    }

    #[tokio::test]
    async fn missing_program_errors_and_waits_before_retrying() {
        let cfg = SidecarConfig { program: "/no/existe/node".into(), args: vec![], working_dir: std::env::temp_dir() };
        let sup = SidecarSupervisor::new(Ok(cfg), InitializeParams::devnet(false));
        assert!(matches!(sup.client().await, Err(SidecarError::Spawn(_))));
        assert!(matches!(sup.client().await, Err(SidecarError::Backoff { .. })));
        assert_eq!(sup.status().await, SidecarStatus::Down { failures: 1 });
    }

    #[tokio::test]
    async fn no_config_means_no_sidecar() {
        let sup = SidecarSupervisor::new(Err("no".into()), InitializeParams::devnet(false));
        assert_eq!(sup.status().await, SidecarStatus::Unavailable);
        assert!(matches!(sup.client().await, Err(SidecarError::NotAvailable(_))));
    }

    #[tokio::test]
    async fn different_major_version_is_rejected() {
        let mut init = InitializeParams::devnet(false);
        init.protocol_version = "99.0".into();
        let sup = SidecarSupervisor::new(Ok(SidecarConfig::dev()), init);
        // The sidecar rejects the version in initialize: remote PROTOCOL_MISMATCH error.
        match sup.client().await {
            Err(SidecarError::Rpc(RpcError::Remote { code, .. })) => assert_eq!(code, protocol::codes::PROTOCOL_MISMATCH),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[tokio::test]
    async fn the_environment_is_not_inherited() {
        // With a poisoned NODE_OPTIONS the sidecar would start with --require; env_clear prevents it.
        // SAFETY: the test only modifies a variable of its own process.
        unsafe { std::env::set_var("NODE_OPTIONS", "--require /no/existe.js") };
        let sup = supervisor();
        let res = sup.client().await;
        unsafe { std::env::remove_var("NODE_OPTIONS") };
        assert!(res.is_ok(), "{res:?}");
        sup.shutdown().await;
    }

    /// The sidecar sends witnesses to the local proof server with `fetch`. With NODE_USE_ENV_PROXY, Node would route
    /// those requests through HTTP(S)_PROXY, so none of those variables may be on the allowlist (nor NODE_OPTIONS,
    /// which allows the same).
    #[test]
    fn the_allowlist_lets_no_proxies_through() {
        let forbidden = ["NODE_USE_ENV_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS"];
        for key in ENV_ALLOWLIST {
            assert!(!forbidden.iter().any(|f| f.eq_ignore_ascii_case(key)), "{key} must not be in the allowlist");
        }
    }

    #[tokio::test]
    async fn environment_proxies_do_not_reach_the_sidecar() {
        // The sidecar refuses to initialise if it sees NODE_USE_ENV_PROXY (net.ts): if it starts, env_clear and the
        // allowlist kept it out.
        // SAFETY: the test only modifies variables of its own process.
        unsafe {
            std::env::set_var("NODE_USE_ENV_PROXY", "1");
            std::env::set_var("HTTP_PROXY", "http://127.0.0.1:9");
            std::env::set_var("HTTPS_PROXY", "http://127.0.0.1:9");
        }
        let sup = supervisor();
        let res = sup.client().await;
        unsafe {
            std::env::remove_var("NODE_USE_ENV_PROXY");
            std::env::remove_var("HTTP_PROXY");
            std::env::remove_var("HTTPS_PROXY");
        }
        assert!(res.is_ok(), "{res:?}");
        sup.shutdown().await;
    }

    #[test]
    fn growing_wait() {
        assert_eq!(backoff(0), Duration::ZERO);
        assert_eq!(backoff(1), Duration::from_secs(1));
        assert_eq!(backoff(3), Duration::from_secs(4));
        assert_eq!(backoff(20), MAX_BACKOFF);
    }
}
