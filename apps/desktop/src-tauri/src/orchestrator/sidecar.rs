//! The `Chain` port over the real sidecar (`SidecarSupervisor` + `RpcClient`).

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::json;

use super::ports::Chain;
use crate::protocol::{
    ContractFindBonosParams, ContractFindBonosResult, ContractHashesParams, ContractHashesResult,
    ContractProveCallParams, ContractProveCallResult, ContractSnapshot, ContractSnapshotParams, InitializeResult,
    WalletBalance, WalletBuyBonoParams, WalletBuyBonoResult, WalletFaucetParams, WalletFaucetResult, WalletOpenParams,
    WalletOpenResult, WalletRegisterDustResult,
};
use crate::rpc::{RpcClient, RpcError};
use crate::supervisor::{SidecarError, SidecarSupervisor};

/// Per-method deadlines. `wallet.buyBono` can take 30 min or more (waiting for inclusion) and
/// `wallet.registerDust` waits for DUST to be generated (~15 min on the devnet).
const SHORT: Duration = Duration::from_secs(60);
const FIND: Duration = Duration::from_secs(180);
const PROVE: Duration = Duration::from_secs(600);
const WALLET_LONG: Duration = Duration::from_secs(45 * 60);

/// Where the JSON-RPC client comes from: the supervisor (the app) or an already connected client (tests, tools).
enum Source {
    Supervisor(Arc<SidecarSupervisor>),
    Client(Arc<RpcClient>, InitializeResult),
}

pub struct SidecarChain {
    source: Source,
}

impl SidecarChain {
    pub fn new(supervisor: Arc<SidecarSupervisor>) -> Self {
        Self { source: Source::Supervisor(supervisor) }
    }

    /// On an already connected client that has completed the handshake (its `initialize` returned `init`).
    pub fn with_client(client: Arc<RpcClient>, init: InitializeResult) -> Self {
        Self { source: Source::Client(client, init) }
    }

    async fn client(&self) -> Result<Arc<RpcClient>, RpcError> {
        match &self.source {
            Source::Supervisor(supervisor) => supervisor.client().await.map_err(sidecar_error),
            Source::Client(client, _) => Ok(client.clone()),
        }
    }

    async fn call<P, T>(&self, method: &str, params: &P, timeout: Duration) -> Result<T, RpcError>
    where
        P: Serialize + Sync + ?Sized,
        T: DeserializeOwned,
    {
        let client = self.client().await?;
        client.call(method, params, timeout).await
    }
}

/// To the orchestrator, a sidecar that will not start or is restarting is a closed (transient) channel.
fn sidecar_error(error: SidecarError) -> RpcError {
    match error {
        SidecarError::Rpc(e) => e,
        _ => RpcError::Closed,
    }
}

impl Chain for SidecarChain {
    async fn handshake(&self) -> Result<InitializeResult, RpcError> {
        match &self.source {
            Source::Supervisor(supervisor) => supervisor.handshake().await.map_err(sidecar_error),
            Source::Client(_, init) => Ok(init.clone()),
        }
    }

    async fn hashes(&self, p: &ContractHashesParams) -> Result<ContractHashesResult, RpcError> {
        self.call("contract.hashes", p, SHORT).await
    }

    async fn snapshot(&self, p: &ContractSnapshotParams) -> Result<ContractSnapshot, RpcError> {
        self.call("contract.snapshot", p, SHORT).await
    }

    async fn find_bonos(&self, p: &ContractFindBonosParams) -> Result<ContractFindBonosResult, RpcError> {
        self.call("contract.findBonos", p, FIND).await
    }

    async fn prove_call(&self, p: &ContractProveCallParams) -> Result<ContractProveCallResult, RpcError> {
        self.call("contract.proveCall", p, PROVE).await
    }

    async fn wallet_open(&self, p: &WalletOpenParams) -> Result<WalletOpenResult, RpcError> {
        self.call("wallet.open", p, SHORT).await
    }

    async fn wallet_close(&self) -> Result<(), RpcError> {
        self.call::<_, serde_json::Value>("wallet.close", &json!({}), SHORT).await.map(drop)
    }

    async fn wallet_sync(&self) -> Result<WalletBalance, RpcError> {
        self.call("wallet.sync", &json!({}), WALLET_LONG).await
    }

    async fn wallet_register_dust(&self) -> Result<WalletRegisterDustResult, RpcError> {
        self.call("wallet.registerDust", &json!({}), WALLET_LONG).await
    }

    async fn wallet_faucet(&self, p: &WalletFaucetParams) -> Result<WalletFaucetResult, RpcError> {
        self.call("wallet.faucet", p, PROVE).await
    }

    async fn wallet_buy_bono(&self, p: &WalletBuyBonoParams) -> Result<WalletBuyBonoResult, RpcError> {
        self.call("wallet.buyBono", p, WALLET_LONG).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{HashOp, ProveCall, SecretHex, SlotWitnesses, codes};
    use crate::rpc::RpcOptions;
    use serde_json::Value;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, duplex};

    /// A "sidecar" over a pipe pair that answers every method with a protocol-shaped result.
    fn result_for(method: &str) -> Value {
        match method {
            "contract.hashes" => json!({ "ctx": "c", "results": ["aa"] }),
            "contract.findBonos" => json!({ "blockHeight": 1, "leafCount": 2, "positions": [1] }),
            "contract.proveCall" => json!({ "tx": "ff", "blockHeight": 3 }),
            "wallet.sync" => json!({ "synced": true, "night": "0", "unregisteredNight": "0", "dust": "0", "dustCoins": 1, "tokens": [] }),
            "wallet.registerDust" => json!({ "registered": true }),
            "wallet.faucet" => json!({ "txId": "00" }),
            "wallet.buyBono" => json!({ "blockHeight": 4, "alreadyIncluded": false }),
            "wallet.open" => {
                json!({ "unshieldedAddress": "u", "shieldedAddress": "s", "restored": false, "stateDiscarded": false })
            }
            "wallet.close" => json!({}),
            _ => Value::Null,
        }
    }

    fn chain() -> (SidecarChain, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        let (client_out, peer_in) = duplex(1 << 16);
        let (mut peer_out, client_in) = duplex(1 << 16);
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(peer_in).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let request: Value = serde_json::from_str(&line).unwrap();
                let method = request["method"].as_str().unwrap().to_owned();
                log.lock().unwrap().push(method.clone());
                let reply = if method == "contract.snapshot" {
                    json!({ "jsonrpc": "2.0", "id": request["id"], "error": { "code": codes::SNAPSHOT_EXPIRED, "message": "Snapshot expired" } })
                } else {
                    json!({ "jsonrpc": "2.0", "id": request["id"], "result": result_for(&method) })
                };
                peer_out.write_all(format!("{reply}\n").as_bytes()).await.unwrap();
            }
        });
        let client = Arc::new(RpcClient::new(client_in, client_out, RpcOptions::default()));
        let init = InitializeResult { protocol_version: "1.4".into(), sidecar_version: "t".into(), methods: vec![] };
        (SidecarChain::with_client(client, init), seen)
    }

    #[tokio::test]
    async fn every_port_method_goes_to_its_rpc_method() {
        let (chain, seen) = chain();
        assert_eq!(chain.handshake().await.unwrap().protocol_version, "1.4");
        let hashes = ContractHashesParams {
            contract_address: "c".into(),
            ops: vec![HashOp::NormalizeName { name: "a".into() }],
        };
        assert_eq!(chain.hashes(&hashes).await.unwrap().results, ["aa"]);
        let find = ContractFindBonosParams {
            contract_address: "c".into(),
            leaves: vec!["aa".into()],
            min_leaf_count: Some(1),
        };
        assert_eq!(chain.find_bonos(&find).await.unwrap().positions, [Some(1)]);
        let witnesses =
            SlotWitnesses { s: SecretHex::new("00"), k: 0, plan: crate::protocol::Plan::Free, valid_until: 1, j: 0 };
        let args = crate::protocol::CreateAliasArgs { enc_pk: "a".into(), auth_pk: "b".into() };
        let prove = ContractProveCallParams {
            contract_address: "c".into(),
            call: ProveCall::CreateAlias { args, witnesses },
            min_leaf_count: None,
        };
        assert_eq!(chain.prove_call(&prove).await.unwrap().tx, "ff");
        let snapshot = ContractSnapshotParams { contract_address: "c".into(), cursor: None, limit: Some(1) };
        let expired = chain.snapshot(&snapshot).await.unwrap_err();
        assert!(matches!(expired, RpcError::Remote { code: codes::SNAPSHOT_EXPIRED, .. }));
        let open =
            WalletOpenParams { seed: SecretHex::new("01"), state_key: SecretHex::new("02"), state_dir: "/x".into() };
        assert!(!chain.wallet_open(&open).await.unwrap().state_discarded);
        assert_eq!(chain.wallet_sync().await.unwrap().dust_coins, 1);
        assert!(chain.wallet_register_dust().await.unwrap().registered);
        let faucet = WalletFaucetParams { token_address: "t".into(), amount: "1".into() };
        assert_eq!(chain.wallet_faucet(&faucet).await.unwrap().tx_id, "00");
        let buy = WalletBuyBonoParams { contract_address: "c".into(), id: "aa".into(), amount: "1".into() };
        assert!(!chain.wallet_buy_bono(&buy).await.unwrap().already_included);
        chain.wallet_close().await.unwrap();
        let methods = seen.lock().unwrap().clone();
        let expected = [
            "contract.hashes",
            "contract.findBonos",
            "contract.proveCall",
            "contract.snapshot",
            "wallet.open",
            "wallet.sync",
            "wallet.registerDust",
            "wallet.faucet",
            "wallet.buyBono",
            "wallet.close",
        ];
        assert_eq!(methods, expected);
    }

    #[test]
    fn a_sidecar_that_cannot_start_is_a_closed_channel() {
        assert_eq!(sidecar_error(SidecarError::NotAvailable("x".into())), RpcError::Closed);
        assert_eq!(sidecar_error(SidecarError::Rpc(RpcError::Timeout)), RpcError::Timeout);
    }
}
