//! Fake mailbox server for tests. Mirrors `apps/server/src/api/mailbox-api.ts` and `mailbox/store.ts` (routes, list
//! format, `since`, 401 with `Date`, 429 with `Retry-After`, per-address rate limit) and verifies signatures for real
//! (`encode_request` + `verify_strict`, ±60 s window and single-use nonces).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, UNIX_EPOCH};

use ed25519_dalek::{Signature, SigningKey, VerifyingKey};
use serde_json::json;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

use super::client::local_now;
use super::test_server::{Reply, Request, TestServer};
use crate::crypto::tests::seal;
use crate::crypto::{MailboxRequest, encode_request, random_bytes};
use crate::keys::AddressKeys;

/// Keys of a test address; `addr_key` is `tag` repeated 32 times.
pub struct TestBox {
    pub addr_key: [u8; 32],
    pub enc_secret: [u8; 32],
    pub auth_seed: [u8; 32],
}

impl TestBox {
    pub fn new(tag: u8) -> Self {
        Self { addr_key: [tag; 32], enc_secret: random_bytes(), auth_seed: random_bytes() }
    }

    pub fn enc_public(&self) -> [u8; 32] {
        PublicKey::from(&StaticSecret::from(self.enc_secret)).to_bytes()
    }

    pub fn auth_public(&self) -> [u8; 32] {
        SigningKey::from_bytes(&self.auth_seed).verifying_key().to_bytes()
    }

    pub fn keys(&self) -> AddressKeys {
        AddressKeys {
            enc_secret: Zeroizing::new(self.enc_secret),
            enc_public: self.enc_public(),
            auth_seed: Zeroizing::new(self.auth_seed),
            auth_public: self.auth_public(),
        }
    }
}

/// Behaviour tests can tweak; the `*_next` counters are consumed one at a time.
pub struct State {
    /// Offset `/v1/time` lies by, relative to the time used for verification.
    pub time_lie: i64,
    /// Reject (401) the next signed requests even if valid.
    pub reject_next: u32,
    /// 401 without a `Date` header.
    pub omit_date: bool,
    pub busy_next: u32,
    pub retry_after: u64,
    /// Answer 500.
    pub fail_next: u32,
    pub page_size: usize,
    /// Like the server: at most `limit` authenticated requests per address within `window` (429 with
    /// `Retry-After` = `retry_after`).
    pub rate_limit: Option<(usize, Duration)>,
    /// Downloading that id always returns that HTTP status.
    pub broken: HashMap<String, u16>,
    /// Size bucket advertised in the list for that id (to lie).
    pub listed_size: HashMap<String, u32>,
    boxes: HashMap<String, (VerifyingKey, Vec<(String, i64)>)>,
    envelopes: HashMap<String, Vec<u8>>,
    nonces: HashSet<String>,
    windows: HashMap<String, (Instant, usize)>,
}

pub struct FakeMailbox {
    /// Server time = local clock + `skew`.
    skew: i64,
    host: OnceLock<String>,
    state: Mutex<State>,
}

fn take(counter: &mut u32) -> bool {
    let active = *counter > 0;
    *counter = counter.saturating_sub(1);
    active
}

fn http_date(seconds: i64) -> String {
    httpdate::fmt_http_date(UNIX_EPOCH + Duration::from_secs(u64::try_from(seconds).unwrap()))
}

/// `/v1/box/<addrKey>/messages…` → (hex addrKey, the rest after `/messages`).
fn split_box(target: &str) -> Option<(&str, &str)> {
    let (addr, rest) = target.strip_prefix("/v1/box/")?.split_at_checked(64)?;
    Some((addr, rest.strip_prefix("/messages")?))
}

struct Credentials {
    timestamp: u64,
    nonce: [u8; 16],
    signature: Signature,
}

fn credentials(request: &Request) -> Option<Credentials> {
    let decode = |name| hex::decode(request.header(name)?).ok();
    let signature: [u8; 64] = decode("nightmail-signature")?.try_into().ok()?;
    Some(Credentials {
        timestamp: request.header("nightmail-timestamp")?.parse().ok()?,
        nonce: decode("nightmail-nonce")?.try_into().ok()?,
        signature: Signature::from_bytes(&signature),
    })
}

/// Envelope bucket as computed when sealing (power of two from 4 KiB).
fn bucket_of(envelope: &[u8]) -> u32 {
    u32::try_from(envelope.len().saturating_sub(62).next_power_of_two().max(4096)).unwrap()
}

impl FakeMailbox {
    pub async fn serve(skew: i64) -> (Arc<Self>, TestServer) {
        let state = State {
            time_lie: 0,
            reject_next: 0,
            omit_date: false,
            busy_next: 0,
            retry_after: 1,
            fail_next: 0,
            page_size: 500,
            rate_limit: None,
            broken: HashMap::new(),
            listed_size: HashMap::new(),
            boxes: HashMap::new(),
            envelopes: HashMap::new(),
            nonces: HashSet::new(),
            windows: HashMap::new(),
        };
        let fake = Arc::new(Self { skew, host: OnceLock::new(), state: Mutex::new(state) });
        let handler = fake.clone();
        let server = TestServer::start(move |request| handler.handle(request)).await;
        fake.host.set(server.base.host().to_owned()).unwrap();
        (fake, server)
    }

    /// Mailbox with one address already registered.
    pub async fn with_box(skew: i64) -> (Arc<Self>, TestServer, TestBox) {
        let (fake, server) = Self::serve(skew).await;
        let tb = TestBox::new(1);
        fake.add_box(&tb);
        (fake, server, tb)
    }

    pub fn set(&self, change: impl FnOnce(&mut State)) {
        change(&mut self.state.lock().unwrap());
    }

    pub fn add_box(&self, tb: &TestBox) {
        let key = VerifyingKey::from_bytes(&tb.auth_public()).unwrap();
        self.set(|s| drop(s.boxes.insert(hex::encode(tb.addr_key), (key, Vec::new()))));
    }

    /// Seals `message` for the address and delivers it; returns the id.
    pub fn deliver(&self, tb: &TestBox, message: &[u8]) -> String {
        let sealed = seal(tb.enc_public(), message, random_bytes(), &random_bytes::<12>()).unwrap();
        self.deliver_envelope(tb, sealed.envelope)
    }

    /// Delivers an envelope as is (including a corrupt one).
    pub fn deliver_envelope(&self, tb: &TestBox, envelope: Vec<u8>) -> String {
        let id = hex::encode(random_bytes::<16>());
        let mut state = self.state.lock().unwrap();
        state.envelopes.insert(id.clone(), envelope);
        let messages = &mut state.boxes.get_mut(&hex::encode(tb.addr_key)).unwrap().1;
        messages.push((id.clone(), 7200 * messages.len() as i64));
        id
    }

    pub fn envelope(&self, id: &str) -> Vec<u8> {
        self.state.lock().unwrap().envelopes[id].clone()
    }

    fn now(&self) -> i64 {
        local_now() + self.skew
    }

    fn handle(&self, request: &Request) -> Reply {
        let now = self.now();
        let mut state = self.state.lock().unwrap();
        if request.target == "/v1/time" {
            return json_reply(json!({ "time": now + state.time_lie }));
        }
        let Some((addr, rest)) = split_box(&request.target) else { return Reply::new(404) };
        if !self.authentic(&mut state, request, addr, now) || take(&mut state.reject_next) {
            return unauthorized(now, state.omit_date);
        }
        let limited = !within_rate(&mut state, addr);
        if limited || take(&mut state.busy_next) {
            return Reply::new(429).header("Retry-After", &state.retry_after.to_string()).body("{\"error\":\"busy\"}");
        }
        if take(&mut state.fail_next) {
            return Reply::new(500);
        }
        serve_box(&state, addr, rest).unwrap_or_else(|| Reply::new(404))
    }

    /// Valid signature from the address in the path, within ±60 s and with an unused nonce.
    fn authentic(&self, state: &mut State, request: &Request, addr: &str, now: i64) -> bool {
        let (Some(c), Some((key, _))) = (credentials(request), state.boxes.get(addr)) else { return false };
        let signed = MailboxRequest {
            host: self.host.get().unwrap(),
            version: 1,
            method: "GET",
            path: &request.target,
            addr_key: hex::decode(addr).unwrap().try_into().unwrap(),
            timestamp: c.timestamp,
            nonce: c.nonce,
        };
        let message = encode_request(&signed).unwrap();
        let fresh = (now - c.timestamp as i64).abs() <= 60;
        key.verify_strict(&message, &c.signature).is_ok() && fresh && state.nonces.insert(hex::encode(c.nonce))
    }
}

/// Like the server's `RateLimiter` (`apps/server/src/limits.ts`): a fixed window starting at the first event; a
/// rejected event is not counted.
fn within_rate(state: &mut State, addr: &str) -> bool {
    let Some((limit, window)) = state.rate_limit else { return true };
    let (start, count) = state.windows.entry(addr.to_owned()).or_insert((Instant::now(), 0));
    if start.elapsed() >= window {
        (*start, *count) = (Instant::now(), 0);
    }
    let allowed = *count < limit;
    *count += usize::from(allowed);
    allowed
}

fn json_reply(value: serde_json::Value) -> Reply {
    Reply::new(200).header("Content-Type", "application/json").body(value.to_string())
}

fn unauthorized(now: i64, omit_date: bool) -> Reply {
    let reply = Reply::new(401).body("{\"error\":\"unauthorized\"}");
    if omit_date { reply } else { reply.header("Date", &http_date(now)) }
}

fn download(state: &State, messages: &[(String, i64)], id: &str) -> Option<Reply> {
    messages.iter().any(|(m, _)| m == id).then_some(())?;
    Some(match state.broken.get(id) {
        Some(&status) => Reply::new(status),
        None => Reply::new(200).body(state.envelopes[id].clone()),
    })
}

/// List from `since` (cursor = position 1, 2, 3… in the mailbox) or the envelope of an id.
fn serve_box(state: &State, addr: &str, rest: &str) -> Option<Reply> {
    let messages = &state.boxes.get(addr)?.1;
    if let Some(id) = rest.strip_prefix('/') {
        return download(state, messages, id);
    }
    let since: usize = rest.strip_prefix("?since=")?.parse().ok()?;
    let page: Vec<_> = messages.iter().skip(since).take(state.page_size).collect();
    let listed: Vec<_> = page
        .iter()
        .map(|(id, at)| {
            let size = state.listed_size.get(id).copied().unwrap_or_else(|| bucket_of(&state.envelopes[id]));
            json!({ "id": id, "size": size, "receivedAt": at })
        })
        .collect();
    Some(json_reply(json!({ "messages": listed, "next": since + page.len() })))
}
