//! Mailbox API client (test-vectors README §2.2-§2.4).
//!
//! - **Time per address and round** ([`Session`]): each session fetches its own `GET /v1/time` and signs with
//!   `server time + elapsed time` from a monotonic clock. Never the local clock, and never an offset shared between
//!   addresses (it would be a common identifier the server could choose).
//! - A `401` is retried once, with the time from its `Date` header (or `/v1/time` if missing) and a fresh nonce; it
//!   only corrects that address's session. Backoff after a second failure is handled by [`super::sync`].
//! - **Pacing** per session: at least `pace` plus jitter between two signed requests (the server allows 120 per
//!   minute and address). The client follows the current server limit.
//! - A `429` with a short `Retry-After` (`busy`) is waited out and retried a few times; a long one (`rate_limited`)
//!   is returned as [`MailError::Busy`] so sync postpones the address.
//! - Bounded responses: the list (≤ 1000 entries, ≤ 128 KiB, valid size buckets and dates) and each envelope (at
//!   most its bucket size).

use std::fmt;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;

use super::random_between;
use crate::crypto::{MAX_ENVELOPE_LENGTH, MailboxRequest, random_bytes, sign_request};
use crate::transport::{BaseUrl, HttpResponse, Transport, TransportError};

const TIME_PATH: &str = "/v1/time";
const API_VERSION: u8 = 1;
const TIME_BODY_LIMIT: usize = 1024;
/// The delivery answers are short fixed JSON bodies.
const DELIVER_BODY_LIMIT: usize = 1024;
/// Envelope header: what it takes on top of its bucket size.
const ENVELOPE_PREFIX_LENGTH: usize = 62;
const MIN_BUCKET: u32 = 4096;
const MAX_BUCKET: u32 = 1 << 25;
/// Largest signable timestamp (README §2.2).
const MAX_TIMESTAMP: u64 = (1 << 53) - 1;
/// The server sends 500 per page; this is the accepted maximum.
pub const MAX_PAGE_ENTRIES: usize = 1000;
pub const LIST_BODY_LIMIT: usize = 128 * 1024;
/// The server accepts `since` values of up to 15 digits.
pub const MAX_CURSOR: u64 = 999_999_999_999_999;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MailError {
    Transport(TransportError),
    /// Signature rejected after the retry.
    Unauthorized,
    /// `429`: wait `retry_after` seconds.
    Busy {
        retry_after: u64,
    },
    NotFound,
    /// Response that does not follow the API.
    Protocol,
    /// Local store error.
    Store,
}

impl fmt::Display for MailError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Transport(error) => error.fmt(f),
            Self::Unauthorized => f.write_str("the mailbox server rejected the request"),
            Self::Busy { .. } => f.write_str("the mailbox server is busy"),
            Self::NotFound => f.write_str("message not found"),
            Self::Protocol => f.write_str("invalid mailbox server response"),
            Self::Store => f.write_str("local store error"),
        }
    }
}

impl std::error::Error for MailError {}

impl From<TransportError> for MailError {
    fn from(error: TransportError) -> Self {
        Self::Transport(error)
    }
}

/// Provisional defaults.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClientConfig {
    /// Retries on a short `429`.
    pub busy_retries: u32,
    /// A longer `Retry-After` is not waited out here.
    pub busy_max_wait: Duration,
    /// Minimum gap between two signed requests of the same session, plus jitter of up to `pace_jitter`.
    pub pace: Duration,
    pub pace_jitter: Duration,
}

impl Default for ClientConfig {
    fn default() -> Self {
        Self {
            busy_retries: 3,
            busy_max_wait: Duration::from_secs(5),
            pace: Duration::from_millis(600),
            pace_jitter: Duration::from_millis(300),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedMessage {
    pub id: String,
    /// Envelope size bucket.
    pub size: u32,
    /// Receipt time, rounded by the server.
    pub received_at: i64,
}

impl ListedMessage {
    /// Exact length of its envelope.
    pub fn envelope_length(&self) -> usize {
        (self.size as usize + ENVELOPE_PREFIX_LENGTH).min(MAX_ENVELOPE_LENGTH)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct MessagePage {
    pub messages: Vec<ListedMessage>,
    /// Cursor for the next request.
    pub next: u64,
}

#[derive(Deserialize)]
struct TimeReply {
    time: u64,
}

/// Local clock Unix seconds: only for local dates (store), never for signing.
pub(crate) fn local_now() -> i64 {
    let since_epoch = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    i64::try_from(since_epoch.as_secs()).unwrap_or(i64::MAX)
}

/// Server time anchored to a monotonic clock instant.
#[derive(Debug, Clone, Copy)]
struct Clock {
    server_time: u64,
    anchor: Instant,
}

impl Clock {
    fn at(server_time: u64) -> Self {
        Self { server_time, anchor: Instant::now() }
    }

    fn now(&self) -> u64 {
        self.server_time.saturating_add(self.anchor.elapsed().as_secs())
    }
}

/// Requests of one address in one round: its own server time and its own pace.
pub struct Session<'a> {
    addr_key: &'a [u8; 32],
    auth_seed: &'a [u8; 32],
    clock: Clock,
    last_request: Option<Instant>,
}

impl Session<'_> {
    pub fn addr_key(&self) -> &[u8; 32] {
        self.addr_key
    }

    /// This address's server time now (Unix seconds): the date of a mail it sends (README §4.3).
    pub fn now(&self) -> u64 {
        self.clock.now()
    }
}

/// 32 lowercase hex digits: the only thing ever put in a path.
pub fn is_message_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn list_path(addr_key: &[u8; 32], since: u64) -> String {
    format!("/v1/box/{}/messages?since={since}", hex::encode(addr_key))
}

fn message_path(addr_key: &[u8; 32], id: &str) -> String {
    format!("/v1/box/{}/messages/{id}", hex::encode(addr_key))
}

pub(crate) fn deliver_path(addr_key: &[u8; 32]) -> String {
    format!("/v1/box/{}/deliver", hex::encode(addr_key))
}

/// Same rule as the server: with no messages `next` = `since`; with messages it advances (without passing the max).
fn cursor_ok(page: &MessagePage, since: u64) -> bool {
    if page.messages.is_empty() { page.next == since } else { page.next > since && page.next <= MAX_CURSOR }
}

/// Valid id, bucket from the table (power of two from 4 KiB to 32 MiB) and date in range.
fn entry_ok(entry: &ListedMessage) -> bool {
    let bucket_ok = entry.size.is_power_of_two() && (MIN_BUCKET..=MAX_BUCKET).contains(&entry.size);
    let date_ok = u64::try_from(entry.received_at).is_ok_and(|at| at <= MAX_TIMESTAMP);
    is_message_id(&entry.id) && bucket_ok && date_ok
}

/// Well-formed page: consistent cursor, at most [`MAX_PAGE_ENTRIES`] and valid entries.
fn parse_page(body: &[u8], since: u64) -> Result<MessagePage, MailError> {
    let page: MessagePage = serde_json::from_slice(body).map_err(|_| MailError::Protocol)?;
    let valid = page.messages.len() <= MAX_PAGE_ENTRIES && cursor_ok(&page, since);
    if valid && page.messages.iter().all(entry_ok) { Ok(page) } else { Err(MailError::Protocol) }
}

fn into_body(response: HttpResponse) -> Result<Vec<u8>, MailError> {
    match response.status {
        200 => Ok(response.body),
        401 => Err(MailError::Unauthorized),
        404 => Err(MailError::NotFound),
        429 => Err(MailError::Busy { retry_after: response.retry_after.unwrap_or(1) }),
        _ => Err(MailError::Protocol),
    }
}

pub struct MailboxClient {
    transport: Arc<Transport>,
    base: BaseUrl,
    config: ClientConfig,
}

impl MailboxClient {
    pub fn new(transport: Arc<Transport>, base: BaseUrl, config: ClientConfig) -> Self {
        Self { transport, base, config }
    }

    /// `GET /v1/time` (unsigned): server time, within the signable range.
    pub async fn server_time(&self) -> Result<u64, MailError> {
        let response = self.transport.get(&self.base, TIME_PATH, &[], TIME_BODY_LIMIT).await?;
        let reply: TimeReply = serde_json::from_slice(&into_body(response)?).map_err(|_| MailError::Protocol)?;
        if reply.time <= MAX_TIMESTAMP { Ok(reply.time) } else { Err(MailError::Protocol) }
    }

    /// `POST /v1/box/<addrKey>/deliver`: hands an envelope already sealed to the recipient's `encPk` to its box.
    /// Anonymous: no session, no signature and nothing else that says who sends ([`Transport::post_bytes`]), on a
    /// connection of its own. The answer is returned as is (`mail::send` reads it); a `429` is not waited out here.
    pub async fn deliver(&self, recipient: &[u8; 32], envelope: Vec<u8>) -> Result<HttpResponse, TransportError> {
        self.transport.post_bytes(&self.base, &deliver_path(recipient), envelope, DELIVER_BODY_LIMIT).await
    }

    /// Opens an address's session for this round (fetches its own server time).
    pub async fn open_session<'a>(
        &self,
        addr_key: &'a [u8; 32],
        auth_seed: &'a [u8; 32],
    ) -> Result<Session<'a>, MailError> {
        let clock = Clock::at(self.server_time().await?);
        Ok(Session { addr_key, auth_seed, clock, last_request: None })
    }

    /// Messages after cursor `since`.
    pub async fn list(&self, session: &mut Session<'_>, since: u64) -> Result<MessagePage, MailError> {
        if since > MAX_CURSOR {
            return Err(MailError::Protocol);
        }
        let body = self.signed_get(session, &list_path(session.addr_key, since), LIST_BODY_LIMIT).await?;
        parse_page(&body, since)
    }

    /// The encrypted envelope of a listed message; at most its bucket length.
    pub async fn download(&self, session: &mut Session<'_>, listed: &ListedMessage) -> Result<Vec<u8>, MailError> {
        if !is_message_id(&listed.id) {
            return Err(MailError::Protocol);
        }
        let path = message_path(session.addr_key, &listed.id);
        self.signed_get(session, &path, listed.envelope_length()).await
    }

    async fn signed_get(&self, session: &mut Session<'_>, path: &str, limit: usize) -> Result<Vec<u8>, MailError> {
        let mut retries = 0;
        loop {
            match self.authorized_get(session, path, limit).await {
                Err(MailError::Busy { retry_after }) if self.waits_for(retries, retry_after) => {
                    retries += 1;
                    tokio::time::sleep(Duration::from_secs(retry_after)).await;
                }
                other => return other,
            }
        }
    }

    fn waits_for(&self, retries: u32, retry_after: u64) -> bool {
        retries < self.config.busy_retries && Duration::from_secs(retry_after) <= self.config.busy_max_wait
    }

    /// Signed request; on `401`, a single retry with corrected time and a fresh nonce.
    async fn authorized_get(&self, session: &mut Session<'_>, path: &str, limit: usize) -> Result<Vec<u8>, MailError> {
        let first = self.send_signed(session, path, limit).await?;
        if first.status != 401 {
            return into_body(first);
        }
        let corrected = match first.date.filter(|&date| date <= MAX_TIMESTAMP) {
            Some(date) => date,
            None => self.server_time().await?,
        };
        session.clock = Clock::at(corrected);
        into_body(self.send_signed(session, path, limit).await?)
    }

    /// Waits as long as needed to respect the session's pace.
    async fn keep_pace(&self, session: &mut Session<'_>) {
        if let Some(last) = session.last_request {
            let gap = random_between(self.config.pace, self.config.pace + self.config.pace_jitter);
            tokio::time::sleep_until((last + gap).into()).await;
        }
        session.last_request = Some(Instant::now());
    }

    async fn send_signed(
        &self,
        session: &mut Session<'_>,
        path: &str,
        limit: usize,
    ) -> Result<HttpResponse, MailError> {
        self.keep_pace(session).await;
        let request = MailboxRequest {
            host: self.base.host(),
            version: API_VERSION,
            method: "GET",
            path,
            addr_key: *session.addr_key,
            timestamp: session.clock.now(),
            nonce: random_bytes(),
        };
        let auth = sign_request(session.auth_seed, &request).map_err(|_| MailError::Protocol)?;
        Ok(self.transport.get(&self.base, path, &auth.pairs(), limit).await?)
    }
}

#[cfg(test)]
mod tests;
