//! Core settings. For now only the local devnet, and only in debug builds (see `lib.rs`): environment variables
//! with devnet defaults. How preprod/production will be configured (app file, per-network compiled values…) is open.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::mail::sync::SyncConfig;
use crate::orchestrator::Pacing;
use crate::orchestrator::http::parse_fingerprint;
use crate::transport::BaseUrl;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigError {
    /// The registry address is missing (`NIGHTMAIL_REGISTRY_ADDRESS` or the deployment's `contracts.json`).
    MissingContract,
    /// `NIGHTMAIL_REGISTRY_ADDRESS` is set but is not an address (32-byte hex).
    BadContract,
    /// The receipt key fingerprint is missing or invalid (`NIGHTMAIL_ISSUER_RECEIPT_KEY=sha256:…`).
    IssuerKey,
    /// Invalid URL (only `https` or loopback).
    BadUrl,
}

#[derive(Debug, Clone)]
pub struct AppConfig {
    /// Profile directory: the seed and, per network and contract, the database and the wallet.
    pub profile_dir: PathBuf,
    pub network: String,
    /// Registry address in lowercase hex.
    pub contract: String,
    pub mail_domain: String,
    pub mail_api: BaseUrl,
    pub issuer: BaseUrl,
    pub relayer: BaseUrl,
    pub issuer_key: [u8; 32],
    pub captcha_token: String,
    pub card_token: String,
    pub pacing: Pacing,
    pub sync: SyncConfig,
    /// Pause between two sync rounds.
    pub sync_interval: Duration,
    /// TestToken of a test network (faucet and balance); `None` means no faucet.
    pub test_token: Option<TestToken>,
}

/// A test network's payment token: its contract (for the faucet) and its colour (for the balance), in lowercase hex.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TestToken {
    pub address: String,
    pub color: String,
}

fn hex32_at(value: &serde_json::Value, object: &str, field: &str) -> Option<String> {
    let text = value.get(object)?.get(field)?.as_str()?;
    is_hex32(text).then(|| text.to_ascii_lowercase())
}

/// `registry.address` from a deployment `contracts.json`.
pub fn contract_from_deployment(json: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    hex32_at(&value, "registry", "address")
}

/// `token` from a `contracts.json`, only if that deployment belongs to registry `contract` (another registry charges
/// in another token).
pub fn token_from_deployment(json: &str, contract: &str) -> Option<TestToken> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    if hex32_at(&value, "registry", "address")? != contract {
        return None;
    }
    Some(TestToken { address: hex32_at(&value, "token", "address")?, color: hex32_at(&value, "token", "color")? })
}

fn is_hex32(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_hexdigit())
}

fn url(text: Option<String>, default: &str) -> Result<BaseUrl, ConfigError> {
    BaseUrl::parse(text.as_deref().unwrap_or(default)).map_err(|_| ConfigError::BadUrl)
}

impl AppConfig {
    /// Local devnet. `env` reads a variable; `deployment` is the `contracts.json` text, if any.
    pub fn devnet(
        profile_dir: PathBuf,
        env: impl Fn(&str) -> Option<String>,
        deployment: Option<&str>,
    ) -> Result<Self, ConfigError> {
        let contract = match env("NIGHTMAIL_REGISTRY_ADDRESS") {
            Some(a) if is_hex32(&a) => a.to_ascii_lowercase(),
            Some(_) => return Err(ConfigError::BadContract),
            None => deployment.and_then(contract_from_deployment).ok_or(ConfigError::MissingContract)?,
        };
        let issuer_key = env("NIGHTMAIL_ISSUER_RECEIPT_KEY")
            .and_then(|k| parse_fingerprint(&k))
            .ok_or(ConfigError::IssuerKey)?;
        let test_token = deployment.and_then(|json| token_from_deployment(json, &contract));
        Ok(Self {
            profile_dir,
            network: "undeployed".into(),
            contract,
            mail_domain: env("NIGHTMAIL_MAIL_DOMAIN").unwrap_or_else(|| "nightmail.local".into()),
            mail_api: url(env("NIGHTMAIL_API_URL"), "http://127.0.0.1:8787")?,
            issuer: url(env("NIGHTMAIL_ISSUER_URL"), "http://127.0.0.1:8788")?,
            relayer: url(env("NIGHTMAIL_RELAYER_URL"), "http://127.0.0.1:8789")?,
            issuer_key,
            captcha_token: env("NIGHTMAIL_ISSUER_CAPTCHA_TOKEN").unwrap_or_else(|| "nightmail-demo-captcha".into()),
            card_token: env("NIGHTMAIL_ISSUER_CARD_TOKEN").unwrap_or_else(|| "tok_nightmail_demo".into()),
            pacing: Pacing::default(),
            // Short pauses between addresses on the devnet so demos do not wait.
            sync: SyncConfig { pause_min: Duration::ZERO, pause_max: Duration::from_secs(1), ..SyncConfig::default() },
            sync_interval: Duration::from_secs(10),
            test_token,
        })
    }

    /// Directory for the network and contract, so another deployment's database and wallet never mix.
    pub fn scope_dir(&self) -> PathBuf {
        self.profile_dir.join(crate::accounts::NETWORKS_DIR).join(&self.network).join(&self.contract)
    }

    pub fn store_path(&self) -> PathBuf {
        self.scope_dir().join("mail.db")
    }

    pub fn wallet_dir(&self) -> PathBuf {
        self.scope_dir().join("wallet")
    }

    pub fn seed_dir(&self) -> &Path {
        &self.profile_dir
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const R: &str = "0a739f66e79db0e112edf84dd6569ad674f2c60f6f116d72d2de37f14bf41587";
    const KEY: &str = "sha256:2fbf047edf2f486015d47830036fdf78399dee92327208228329e63403590892";

    fn env_of(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |name| pairs.iter().find(|(k, _)| *k == name).map(|(_, v)| v.to_string())
    }

    #[test]
    fn reads_the_contract_from_the_deployment_file() {
        let json = format!(r#"{{"network":"undeployed","registry":{{"address":"{}"}}}}"#, R.to_uppercase());
        assert_eq!(contract_from_deployment(&json).as_deref(), Some(R));
        assert_eq!(contract_from_deployment(r#"{"registry":{"address":"0a"}}"#), None);
        assert_eq!(contract_from_deployment("no es json"), None);
    }

    #[test]
    fn the_test_token_comes_only_with_its_own_registry() {
        const T: &str = "1a652961d6e647ee5577e1d7418e7f7b807921877c3075818dd3f8e192ea1e26";
        const C: &str = "0358e4093215dd04e251882f4385a7eecfc34675dd5ae4c073f0a525d6cd0906";
        let json = format!(r#"{{"token":{{"address":"{}","color":"{C}"}},"registry":{{"address":"{R}"}}}}"#, T.to_uppercase());
        let token = TestToken { address: T.into(), color: C.into() };
        assert_eq!(token_from_deployment(&json, R), Some(token.clone()));
        assert_eq!(token_from_deployment(&json, &"0".repeat(64)), None, "another registry: no faucet");
        assert_eq!(token_from_deployment(&format!(r#"{{"registry":{{"address":"{R}"}}}}"#), R), None);
        let bad_color = format!(r#"{{"token":{{"address":"{T}","color":"0a"}},"registry":{{"address":"{R}"}}}}"#);
        assert_eq!(token_from_deployment(&bad_color, R), None);
        assert_eq!(token_from_deployment("no es json", R), None);
        let key = env_of(&[("NIGHTMAIL_ISSUER_RECEIPT_KEY", KEY)]);
        assert_eq!(AppConfig::devnet("/p".into(), key, Some(&json)).unwrap().test_token, Some(token));
        let other = env_of(&[("NIGHTMAIL_ISSUER_RECEIPT_KEY", KEY), ("NIGHTMAIL_REGISTRY_ADDRESS", C)]);
        assert_eq!(AppConfig::devnet("/p".into(), other, Some(&json)).unwrap().test_token, None);
    }

    #[test]
    fn devnet_defaults_and_overrides() {
        let config = AppConfig::devnet("/p".into(), env_of(&[("NIGHTMAIL_ISSUER_RECEIPT_KEY", KEY)]), Some(
            &format!(r#"{{"registry":{{"address":"{R}"}}}}"#),
        ))
        .unwrap();
        assert_eq!(config.contract, R);
        assert_eq!(config.issuer.host(), "127.0.0.1:8788");
        assert_eq!(config.store_path(), PathBuf::from(format!("/p/networks/undeployed/{R}/mail.db")));
        assert_eq!(config.wallet_dir(), PathBuf::from(format!("/p/networks/undeployed/{R}/wallet")));
        let env = env_of(&[("NIGHTMAIL_ISSUER_RECEIPT_KEY", KEY), ("NIGHTMAIL_REGISTRY_ADDRESS", R)]);
        assert_eq!(AppConfig::devnet("/p".into(), env, None).unwrap().contract, R);
    }

    #[test]
    fn missing_or_bad_settings_are_errors() {
        let only_key = env_of(&[("NIGHTMAIL_ISSUER_RECEIPT_KEY", KEY)]);
        assert_eq!(AppConfig::devnet("/p".into(), only_key, None).unwrap_err(), ConfigError::MissingContract);
        let bad_key = env_of(&[("NIGHTMAIL_ISSUER_RECEIPT_KEY", "sha256:00"), ("NIGHTMAIL_REGISTRY_ADDRESS", R)]);
        assert_eq!(AppConfig::devnet("/p".into(), bad_key, None).unwrap_err(), ConfigError::IssuerKey);
        let bad_contract = env_of(&[("NIGHTMAIL_ISSUER_RECEIPT_KEY", KEY), ("NIGHTMAIL_REGISTRY_ADDRESS", "0a")]);
        let deployment = format!(r#"{{"registry":{{"address":"{R}"}}}}"#);
        let err = AppConfig::devnet("/p".into(), bad_contract, Some(&deployment)).unwrap_err();
        assert_eq!(err, ConfigError::BadContract, "does not silently fall back to contracts.json");
        let bad_url = env_of(&[
            ("NIGHTMAIL_ISSUER_RECEIPT_KEY", KEY),
            ("NIGHTMAIL_REGISTRY_ADDRESS", R),
            ("NIGHTMAIL_API_URL", "http://example.com"),
        ]);
        assert_eq!(AppConfig::devnet("/p".into(), bad_url, None).unwrap_err(), ConfigError::BadUrl);
    }
}
