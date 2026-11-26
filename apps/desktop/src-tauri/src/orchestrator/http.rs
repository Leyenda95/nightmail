//! HTTP clients for the Issuer and the relayer on top of `transport.rs` (the core's only HTTP exit), and verification
//! of the Issuer's signed receipt.
//!
//! - Issuer (`apps/server/src/issuer/issuer-api.ts`): `POST /v1/bono/free {id, captchaToken}`,
//!   `POST /v1/bono/fiat {id, cardToken, period}`, `POST /v1/bono/status {id}`. The `id` never goes in the URL.
//! - Relayer (`apps/server/src/relayer/relayer-api.ts`): `POST /v1/relay {tx}` → 202 `{ticket}` | 503 busy |
//!   422 `{reason}`; `POST /v1/relay/status {ticket}`.

use std::sync::Arc;

use ed25519_dalek::{Signature, VerifyingKey};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::ports::{IssueReply, IssueRequest, Issuer, IssuerError, RelayError, RelayOutcome, Relayer, Submitted};
use super::ports::{Receipt, TicketState};
use crate::protocol::Plan;
use crate::transport::{BaseUrl, HttpResponse, Transport, TransportError};

/// Cap on an Issuer or relayer response (small JSON documents).
const MAX_REPLY: usize = 64 * 1024;
/// `Retry-After` when the server does not send one.
const DEFAULT_RETRY_S: u64 = 60;
/// Cap on a server `retryAfterS` (an absurd value must not leave the app waiting for days).
const MAX_RETRY_S: u64 = 3600;
/// Deadline for [`Relayer::reachable`]: a `GET /v1/relay` (answers 405) that only checks a response arrives.
const REACH_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

/// Why there is no complete response.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NoReply {
    /// The server never answered: connection refused, network failure or deadline before the headers.
    Unanswered,
    /// It answered partially: body cut off, too large, or not fully received in time.
    Partial,
    /// The configured URL is invalid: waiting will not fix it.
    BadUrl,
}

/// JSON body → `HttpResponse`, or why there is none (the caller maps it to its own error).
async fn post(transport: &Transport, base: &BaseUrl, path: &str, body: &Value) -> Result<HttpResponse, NoReply> {
    transport.post_json(base, path, body.to_string().into_bytes(), MAX_REPLY).await.map_err(no_reply)
}

fn no_reply(error: TransportError) -> NoReply {
    match error {
        TransportError::Network | TransportError::Timeout => NoReply::Unanswered,
        TransportError::Interrupted | TransportError::TooLarge => NoReply::Partial,
        TransportError::BadUrl => NoReply::BadUrl,
    }
}

fn body_json(response: &HttpResponse) -> Value {
    serde_json::from_slice(&response.body).unwrap_or(Value::Null)
}

/// Seconds to wait: `retryAfterS` from the body, else the header, else the default.
fn retry_after(response: &HttpResponse) -> u64 {
    body_json(response)["retryAfterS"].as_u64().or(response.retry_after).unwrap_or(DEFAULT_RETRY_S).min(MAX_RETRY_S)
}

// --- Issuer -----------------------------------------------------------------------------------------------

pub struct HttpIssuer {
    transport: Arc<Transport>,
    base: BaseUrl,
}

impl HttpIssuer {
    pub fn new(transport: Arc<Transport>, base: BaseUrl) -> Self {
        Self { transport, base }
    }

    async fn send(&self, path: &str, body: Value) -> Result<IssueReply, IssuerError> {
        let response = post(&self.transport, &self.base, path, &body)
            .await
            .map_err(|e| match e {
                NoReply::Unanswered => IssuerError::Unreachable,
                NoReply::Partial => IssuerError::Unavailable,
                NoReply::BadUrl => IssuerError::BadConfig,
            })?;
        issuer_reply(&response)
    }
}

fn issuer_reply(response: &HttpResponse) -> Result<IssueReply, IssuerError> {
    match response.status {
        200 => serde_json::from_slice(&response.body).map_err(|_| IssuerError::BadResponse),
        402 => Err(IssuerError::PaymentFailed),
        403 => Err(IssuerError::CaptchaFailed),
        404 => Err(IssuerError::NotFound),
        409 => Err(IssuerError::IdConflict),
        429 => Err(IssuerError::RateLimited { retry_after_s: retry_after(response) }),
        503 => Err(IssuerError::Busy { retry_after_s: retry_after(response) }),
        500..=599 => Err(IssuerError::Unavailable),
        _ => Err(IssuerError::BadResponse),
    }
}

impl Issuer for HttpIssuer {
    async fn request(&self, id: &str, request: &IssueRequest<'_>) -> Result<IssueReply, IssuerError> {
        match *request {
            IssueRequest::Free { captcha_token } => {
                self.send("/v1/bono/free", json!({ "id": id, "captchaToken": captcha_token })).await
            }
            IssueRequest::Fiat { card_token, period } => {
                let body = json!({ "id": id, "cardToken": card_token, "period": period });
                self.send("/v1/bono/fiat", body).await
            }
        }
    }

    async fn status(&self, id: &str) -> Result<IssueReply, IssuerError> {
        self.send("/v1/bono/status", json!({ "id": id })).await
    }
}

// --- Receipt ---------------------------------------------------------------------------------------------

const RECEIPT_DOMAIN: &[u8] = b"nightmail/bono-receipt/v2";

/// What the receipt for one of our requests must say.
pub struct ExpectedReceipt<'a> {
    pub contract: &'a str,
    pub id: &'a str,
    pub plan: Plan,
    pub period: &'a str,
    /// SHA-256 of the published public key (`sha256:<hex>` fingerprint).
    pub key_fingerprint: &'a [u8; 32],
}

/// `sha256:<64 hex>` → the 32 fingerprint bytes.
pub fn parse_fingerprint(text: &str) -> Option<[u8; 32]> {
    bytes32(text.strip_prefix("sha256:")?)
}

fn bytes32(text: &str) -> Option<[u8; 32]> {
    super::bytes32(text).ok()
}

fn period_byte(period: &str) -> Option<u8> {
    ["none", "monthly", "annual"].iter().position(|p| *p == period).map(|i| i as u8)
}

/// Signed message (layout of `receipt-v2.json`).
pub fn receipt_message(contract: &[u8; 32], id: &[u8; 32], plan: Plan, period: u8, insert_by: u64) -> Vec<u8> {
    let plan_byte = u8::from(plan == Plan::Paid);
    [RECEIPT_DOMAIN, &[0], contract, id, &[plan_byte, period], &insert_by.to_be_bytes()].concat()
}

fn signature_ok(receipt: &Receipt, message: &[u8], fingerprint: &[u8; 32]) -> Option<()> {
    let public = bytes32(&receipt.public_key)?;
    (Sha256::digest(public).as_slice() == fingerprint).then_some(())?;
    let mut signature = [0u8; 64];
    hex::decode_to_slice(&receipt.signature, &mut signature).ok()?;
    let key = VerifyingKey::from_bytes(&public).ok()?;
    key.verify_strict(message, &Signature::from_bytes(&signature)).ok()
}

/// Is this the receipt for that request, for this contract, signed by the published key?
pub fn verify_receipt(reply: &IssueReply, expected: &ExpectedReceipt<'_>) -> bool {
    let receipt = &reply.receipt;
    let same = reply.id == expected.id
        && reply.plan == expected.plan
        && receipt.contract == expected.contract
        && receipt.period == expected.period;
    let parts = (bytes32(expected.contract), bytes32(expected.id), period_byte(expected.period));
    let (Some(contract), Some(id), Some(period)) = parts else { return false };
    let message = receipt_message(&contract, &id, expected.plan, period, receipt.insert_by);
    same && signature_ok(receipt, &message, expected.key_fingerprint).is_some()
}

// --- Relayer ---------------------------------------------------------------------------------------------

pub struct HttpRelayer {
    transport: Arc<Transport>,
    base: BaseUrl,
}

impl HttpRelayer {
    pub fn new(transport: Arc<Transport>, base: BaseUrl) -> Self {
        Self { transport, base }
    }

    async fn send(&self, path: &str, body: Value) -> Result<HttpResponse, RelayError> {
        post(&self.transport, &self.base, path, &body)
            .await
            .map_err(|e| match e {
                NoReply::Unanswered => RelayError::Unreachable,
                NoReply::Partial => RelayError::Unavailable,
                NoReply::BadUrl => RelayError::BadConfig,
            })
    }
}

#[derive(Deserialize)]
struct TicketBody {
    ticket: String,
}

/// A relayer ticket: 32 lowercase hex characters (sent in the `status` body).
fn is_ticket(text: &str) -> bool {
    text.len() == 32 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn submit_reply(response: &HttpResponse) -> Result<Submitted, RelayError> {
    let body = body_json(response);
    match response.status {
        202 => serde_json::from_value::<TicketBody>(body)
            .ok()
            .filter(|t| is_ticket(&t.ticket))
            .map(|t| Submitted::Ticket(t.ticket))
            .ok_or(RelayError::BadResponse),
        503 => Ok(Submitted::Busy { retry_after_s: retry_after(response) }),
        422 if body["reason"] == "bad-ttl" => Ok(Submitted::BadTtl),
        400 | 409 | 413 | 422 => Err(RelayError::NotRelayable),
        429 => Err(RelayError::RateLimited { retry_after_s: retry_after(response) }),
        500..=599 => Err(RelayError::Unavailable),
        _ => Err(RelayError::BadResponse),
    }
}

fn outcome(body: &Value) -> Option<RelayOutcome> {
    Some(match body["outcome"].as_str()? {
        "included" => RelayOutcome::Included,
        "rejected" => RelayOutcome::Rejected,
        "unknown" => RelayOutcome::Unknown,
        "failed" => RelayOutcome::Failed,
        "refused" => RelayOutcome::Refused,
        "busy" => RelayOutcome::Busy {
            retry_after_s: body["retryAfterS"].as_u64().unwrap_or(DEFAULT_RETRY_S).min(MAX_RETRY_S),
        },
        "expired" => RelayOutcome::Expired,
        _ => return None,
    })
}

fn status_reply(response: &HttpResponse) -> Result<TicketState, RelayError> {
    let body = body_json(response);
    match (response.status, body["state"].as_str()) {
        (200, Some("queued")) => Ok(TicketState::Queued),
        (200, Some("done")) => outcome(&body).map(TicketState::Done).ok_or(RelayError::BadResponse),
        (404, _) => Err(RelayError::NotFound),
        (429, _) => Err(RelayError::RateLimited { retry_after_s: retry_after(response) }),
        (500..=599, _) => Err(RelayError::Unavailable),
        _ => Err(RelayError::BadResponse),
    }
}

impl Relayer for HttpRelayer {
    async fn reachable(&self) -> bool {
        self.transport.answers(&self.base, "/v1/relay", REACH_WAIT).await
    }

    async fn submit(&self, tx: &str) -> Result<Submitted, RelayError> {
        submit_reply(&self.send("/v1/relay", json!({ "tx": tx })).await?)
    }

    async fn status(&self, ticket: &str) -> Result<TicketState, RelayError> {
        status_reply(&self.send("/v1/relay/status", json!({ "ticket": ticket })).await?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mail::test_server::{Reply, TestServer};
    use crate::transport::TransportConfig;

    fn response(status: u16, body: &str) -> HttpResponse {
        HttpResponse { status, date: None, retry_after: None, body: body.as_bytes().to_vec() }
    }

    fn transport() -> Arc<Transport> {
        Arc::new(Transport::direct(&TransportConfig::default()).unwrap())
    }

    fn vector_reply(entry: &Value, public_key: &str) -> IssueReply {
        let plan = if entry["plan"] == "free" { Plan::Free } else { Plan::Paid };
        IssueReply {
            id: entry["id"].as_str().unwrap().into(),
            plan,
            state: super::super::ports::IssueState::Issued,
            receipt: Receipt {
                contract: entry["contract"].as_str().unwrap().into(),
                period: entry["period"].as_str().unwrap().into(),
                insert_by: entry["insertBy"].as_str().unwrap().parse().unwrap(),
                signature: entry["signature"].as_str().unwrap().into(),
                public_key: public_key.into(),
            },
        }
    }

    fn receipt_vectors() -> Value {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../packages/test-vectors/issuer/receipt-v2.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn receipt_vectors_verify_and_tampering_fails() {
        let v = receipt_vectors();
        let public_key = v["publicKey"].as_str().unwrap();
        let fingerprint: [u8; 32] = Sha256::digest(hex::decode(public_key).unwrap()).into();
        for entry in v["valid"].as_array().unwrap() {
            let reply = vector_reply(entry, public_key);
            let expected = ExpectedReceipt {
                contract: entry["contract"].as_str().unwrap(),
                id: entry["id"].as_str().unwrap(),
                plan: reply.plan,
                period: entry["period"].as_str().unwrap(),
                key_fingerprint: &fingerprint,
            };
            let message = receipt_message(
                &bytes32(expected.contract).unwrap(),
                &bytes32(expected.id).unwrap(),
                expected.plan,
                period_byte(expected.period).unwrap(),
                reply.receipt.insert_by,
            );
            assert_eq!(hex::encode(message), entry["message"].as_str().unwrap());
            assert!(verify_receipt(&reply, &expected));
            let mut later = reply.clone();
            later.receipt.insert_by ^= 1;
            assert!(!verify_receipt(&later, &expected), "tampered deadline");
            assert!(!verify_receipt(&reply, &ExpectedReceipt { key_fingerprint: &[0; 32], ..expected }), "another key");
            assert!(!verify_receipt(&reply, &ExpectedReceipt { id: &"00".repeat(32), ..expected }), "another id");
            assert!(!verify_receipt(&reply, &ExpectedReceipt { period: "x", ..expected }), "odd period");
        }
    }

    #[test]
    fn fingerprint_parsing() {
        let hex_text = "ab".repeat(32);
        assert_eq!(parse_fingerprint(&format!("sha256:{hex_text}")), Some([0xab; 32]));
        assert_eq!(parse_fingerprint(&hex_text), None);
        assert_eq!(parse_fingerprint("sha256:abc"), None);
    }

    #[test]
    fn issuer_status_codes() {
        let cases = [
            (402, IssuerError::PaymentFailed),
            (403, IssuerError::CaptchaFailed),
            (404, IssuerError::NotFound),
            (409, IssuerError::IdConflict),
            (429, IssuerError::RateLimited { retry_after_s: 7 }),
            (503, IssuerError::Busy { retry_after_s: 7 }),
            (502, IssuerError::Unavailable),
            (418, IssuerError::BadResponse),
            (200, IssuerError::BadResponse),
        ];
        for (status, expected) in cases {
            assert_eq!(issuer_reply(&response(status, r#"{"retryAfterS":7}"#)), Err(expected), "{status}");
        }
        let header_only = HttpResponse { retry_after: Some(9), ..response(503, "") };
        assert_eq!(issuer_reply(&header_only), Err(IssuerError::Busy { retry_after_s: 9 }));
        assert_eq!(retry_after(&response(503, "")), DEFAULT_RETRY_S);
    }

    #[test]
    fn relayer_submit_and_status_replies() {
        assert_eq!(
            submit_reply(&response(202, r#"{"ticket":"00000000000000000000000000000000"}"#)),
            Ok(Submitted::Ticket("00000000000000000000000000000000".into()))
        );
        assert_eq!(submit_reply(&response(202, r#"{"ticket":"AB"}"#)), Err(RelayError::BadResponse));
        assert_eq!(retry_after(&response(503, r#"{"retryAfterS":99999999}"#)), MAX_RETRY_S);
        assert_eq!(submit_reply(&response(202, "{}")), Err(RelayError::BadResponse));
        assert_eq!(submit_reply(&response(503, r#"{"retryAfterS":3}"#)), Ok(Submitted::Busy { retry_after_s: 3 }));
        assert_eq!(submit_reply(&response(422, r#"{"reason":"bad-ttl"}"#)), Ok(Submitted::BadTtl));
        assert_eq!(submit_reply(&response(422, r#"{"reason":"wrong-circuit"}"#)), Err(RelayError::NotRelayable));
        assert_eq!(submit_reply(&response(429, "{}")), Err(RelayError::RateLimited { retry_after_s: 60 }));
        assert_eq!(submit_reply(&response(500, "")), Err(RelayError::Unavailable));
        assert_eq!(submit_reply(&response(301, "")), Err(RelayError::BadResponse));

        assert_eq!(status_reply(&response(200, r#"{"state":"queued"}"#)), Ok(TicketState::Queued));
        let outcomes = [
            ("included", RelayOutcome::Included),
            ("rejected", RelayOutcome::Rejected),
            ("unknown", RelayOutcome::Unknown),
            ("failed", RelayOutcome::Failed),
            ("refused", RelayOutcome::Refused),
            ("expired", RelayOutcome::Expired),
        ];
        for (text, expected) in outcomes {
            let body = format!(r#"{{"state":"done","outcome":"{text}"}}"#);
            assert_eq!(status_reply(&response(200, &body)), Ok(TicketState::Done(expected)), "{text}");
        }
        let busy = r#"{"state":"done","outcome":"busy","retryAfterS":4}"#;
        assert_eq!(status_reply(&response(200, busy)), Ok(TicketState::Done(RelayOutcome::Busy { retry_after_s: 4 })));
        assert_eq!(status_reply(&response(200, r#"{"state":"done","outcome":"x"}"#)), Err(RelayError::BadResponse));
        assert_eq!(status_reply(&response(404, "{}")), Err(RelayError::NotFound));
        assert_eq!(status_reply(&response(429, "{}")), Err(RelayError::RateLimited { retry_after_s: 60 }));
        assert_eq!(status_reply(&response(503, "")), Err(RelayError::Unavailable));
        assert_eq!(status_reply(&response(200, "{}")), Err(RelayError::BadResponse));
    }

    #[tokio::test]
    async fn clients_post_to_the_right_routes() {
        let v = receipt_vectors();
        let entry = v["valid"][0].clone();
        let reply_body = json!({
            "id": entry["id"], "plan": "free", "state": "pending",
            "receipt": {"contract": entry["contract"], "period": "none", "insertBy": 1_800_003_960u64,
                        "signature": entry["signature"], "publicKey": v["publicKey"]},
        })
        .to_string();
        let server = TestServer::start(move |r| match r.target.as_str() {
            "/v1/relay" => Reply::new(202).body(r#"{"ticket":"00000000000000000000000000000000"}"#),
            "/v1/relay/status" => Reply::new(200).body(r#"{"state":"queued"}"#),
            _ => Reply::new(200).body(reply_body.clone()),
        })
        .await;
        let issuer = HttpIssuer::new(transport(), server.base.clone());
        let free = issuer.request("aa", &IssueRequest::Free { captcha_token: "t" }).await.unwrap();
        assert_eq!(free.receipt.insert_by, 1_800_003_960);
        let fiat = IssueRequest::Fiat { card_token: "c", period: super::super::ports::BonoPeriod::Annual };
        assert!(issuer.request("aa", &fiat).await.is_ok());
        assert!(issuer.status("aa").await.is_ok());
        let relayer = HttpRelayer::new(transport(), server.base.clone());
        assert_eq!(relayer.submit("ab").await, Ok(Submitted::Ticket("00000000000000000000000000000000".into())));
        assert_eq!(relayer.status("00").await, Ok(TicketState::Queued));
        let targets: Vec<String> = server.requests().into_iter().map(|r| r.target).collect();
        assert_eq!(targets, ["/v1/bono/free", "/v1/bono/fiat", "/v1/bono/status", "/v1/relay", "/v1/relay/status"]);
        assert!(server.requests().iter().all(|r| r.header("content-type") == Some("application/json")));
        assert!(relayer.reachable().await);
        let probe = server.requests().pop().unwrap();
        assert_eq!((probe.method.as_str(), probe.target.as_str(), probe.body.len()), ("GET", "/v1/relay", 0));
    }

    #[test]
    fn only_a_missing_reply_is_unanswered_and_a_bad_url_is_config() {
        assert_eq!(no_reply(TransportError::Network), NoReply::Unanswered);
        assert_eq!(no_reply(TransportError::Timeout), NoReply::Unanswered);
        assert_eq!(no_reply(TransportError::Interrupted), NoReply::Partial, "the headers arrived");
        assert_eq!(no_reply(TransportError::TooLarge), NoReply::Partial);
        assert_eq!(no_reply(TransportError::BadUrl), NoReply::BadUrl);
    }

    #[tokio::test]
    async fn network_failure_is_unreachable() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = BaseUrl::parse(&format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port())).unwrap();
        drop(listener);
        assert_eq!(HttpIssuer::new(transport(), base.clone()).status("aa").await, Err(IssuerError::Unreachable));
        assert!(!HttpRelayer::new(transport(), base.clone()).reachable().await);
        assert_eq!(HttpRelayer::new(transport(), base).submit("aa").await, Err(RelayError::Unreachable));
    }
}
