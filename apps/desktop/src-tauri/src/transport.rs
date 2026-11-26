//! The only path for the core's outgoing HTTP traffic.
//!
//! - Only to base URLs set by the core configuration ([`BaseUrl`]); callers supply just the path.
//! - One connection per request, so two addresses never share a connection. HTTP/1.1 only, with no redirects,
//!   cookies, `Referer`, environment proxies or decompression.
//! - TLS 1.2 and 1.3 with the platform verifier and no session resumption (a reused ticket or session id would link
//!   connections made for different addresses). ALPN is `http/1.1` only.
//! - A total deadline per request, including the body, and a body cap checked before reading (`Content-Length`) and
//!   while reading (missing or lying length).
//! - A fixed `User-Agent`, identical across installs and versions.
//! - Known gap: the platform verifier's revocation check may reach the network outside `Transport`; it will need to
//!   be disabled or routed once Tor is added.

use std::fmt;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use reqwest::header::{CONTENT_TYPE, DATE, HeaderMap, HeaderName, RETRY_AFTER};
use rustls_platform_verifier::BuilderVerifierExt;
use url::{Host, Position, Url};

use crate::crypto::canonical_host;

/// Fixed, generic value: it carries neither the app version nor the OS.
pub const USER_AGENT: &str = "Mozilla/5.0";
/// A larger `Retry-After` is clamped to this many seconds so a server cannot demand absurd waits.
pub const MAX_RETRY_AFTER: u64 = 3600;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportError {
    /// Base URL or path not allowed.
    BadUrl,
    /// No response: connection, TLS or malformed HTTP headers.
    Network,
    /// The total deadline expired before the response headers arrived.
    Timeout,
    /// The body exceeds the request's cap.
    TooLarge,
    /// The response started but the body was cut off (e.g. the server hit its own timeout) or did not finish
    /// within the total deadline. The server did answer.
    Interrupted,
}

impl fmt::Display for TransportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::BadUrl => "server address not allowed",
            Self::Network => "network error",
            Self::Timeout => "the server did not answer in time",
            Self::TooLarge => "response too large",
            Self::Interrupted => "response cut short",
        })
    }
}

impl std::error::Error for TransportError {}

/// Base URL of an operator service: `https://`, or `http://` only to the local machine (devnet). No user, path, query
/// or fragment, and an authority that can be signed (it is the `host` of signed requests).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BaseUrl {
    origin: String,
    host: String,
}

/// Only literal loopback IPs (`127.0.0.0/8`, `::1`). The name `localhost` is resolved by the OS (`hosts`, DNS) and
/// could send signed requests over the network without TLS.
fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Ipv4(ip)) => IpAddr::V4(ip).is_loopback(),
        Some(Host::Ipv6(ip)) => IpAddr::V6(ip).is_loopback(),
        Some(Host::Domain(_)) | None => false,
    }
}

fn is_bare(url: &Url) -> bool {
    url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none()
}

impl BaseUrl {
    pub fn parse(text: &str) -> Result<Self, TransportError> {
        let url = Url::parse(text).map_err(|_| TransportError::BadUrl)?;
        let host = canonical_host(text).map_err(|_| TransportError::BadUrl)?;
        let secure_enough = url.scheme() == "https" || is_loopback(&url);
        if !(secure_enough && is_bare(&url)) {
            return Err(TransportError::BadUrl);
        }
        Ok(Self { origin: format!("{}://{host}", url.scheme()), host })
    }

    /// Signable authority (the `host` in the signed message).
    pub fn host(&self) -> &str {
        &self.host
    }

    /// URL for a path, sent exactly as written: no normalisation, since this is what gets signed.
    fn join(&self, path: &str) -> Result<Url, TransportError> {
        let url = Url::parse(&format!("{}{path}", self.origin)).map_err(|_| TransportError::BadUrl)?;
        if path.starts_with('/') && url.fragment().is_none() && &url[Position::BeforePath..] == path {
            Ok(url)
        } else {
            Err(TransportError::BadUrl)
        }
    }
}

/// Per-request deadlines.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransportConfig {
    /// From sending until the last byte is read. The server gives up at 120 s.
    pub total_timeout: Duration,
    pub connect_timeout: Duration,
}

impl Default for TransportConfig {
    fn default() -> Self {
        Self { total_timeout: Duration::from_secs(150), connect_timeout: Duration::from_secs(15) }
    }
}

/// A response read in full (within the cap).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    /// `Date` header, in Unix seconds.
    pub date: Option<u64>,
    /// `Retry-After` in seconds, at most [`MAX_RETRY_AFTER`] (the HTTP-date form is not used).
    pub retry_after: Option<u64>,
    pub body: Vec<u8>,
}

/// Direct connection. The HTTP client never leaves this module.
pub struct Direct {
    client: reqwest::Client,
}

/// How traffic goes out. A `Tor` variant (arti, one circuit per function and address) is planned.
pub enum Transport {
    Direct(Direct),
}

/// rustls with `ring`, TLS 1.2/1.3, platform verifier, no resumption and ALPN `http/1.1`.
fn tls_config() -> Result<rustls::ClientConfig, TransportError> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = rustls::ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
        .and_then(|builder| builder.with_platform_verifier())
        .map_err(|_| TransportError::Network)?
        .with_no_client_auth();
    config.resumption = rustls::client::Resumption::disabled();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(config)
}

impl Transport {
    pub fn direct(config: &TransportConfig) -> Result<Self, TransportError> {
        let client = reqwest::Client::builder()
            .tls_backend_preconfigured(tls_config()?)
            .user_agent(USER_AGENT)
            .redirect(reqwest::redirect::Policy::none())
            .referer(false)
            .no_proxy()
            .http1_only()
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .no_zstd()
            .pool_max_idle_per_host(0)
            .timeout(config.total_timeout)
            .connect_timeout(config.connect_timeout)
            .build()
            .map_err(|_| TransportError::Network)?;
        Ok(Self::Direct(Direct { client }))
    }

    fn client(&self) -> &reqwest::Client {
        match self {
            Self::Direct(direct) => &direct.client,
        }
    }

    /// `GET base ‖ path` with these headers; the body may not exceed `max_body` bytes.
    pub async fn get(
        &self,
        base: &BaseUrl,
        path: &str,
        headers: &[(&str, &str)],
        max_body: usize,
    ) -> Result<HttpResponse, TransportError> {
        let request = headers.iter().fold(self.client().get(base.join(path)?), |r, (k, v)| r.header(*k, *v));
        send(request, max_body).await
    }

    /// `POST base ‖ path` with an already serialised JSON body (Issuer and relayer); the response may not exceed
    /// `max_body` bytes.
    pub async fn post_json(
        &self,
        base: &BaseUrl,
        path: &str,
        body: Vec<u8>,
        max_body: usize,
    ) -> Result<HttpResponse, TransportError> {
        let request = self.client().post(base.join(path)?).header(CONTENT_TYPE, "application/json").body(body);
        send(request, max_body).await
    }

    /// `POST base ‖ path` with a binary body (`application/octet-stream`) and no header from the caller: the request
    /// carries only what every request of every install carries (the fixed `User-Agent`, `Accept`, `Host` and the
    /// length). For an anonymous delivery. The response may not exceed `max_body` bytes.
    pub async fn post_bytes(
        &self,
        base: &BaseUrl,
        path: &str,
        body: Vec<u8>,
        max_body: usize,
    ) -> Result<HttpResponse, TransportError> {
        let request =
            self.client().post(base.join(path)?).header(CONTENT_TYPE, "application/octet-stream").body(body);
        send(request, max_body).await
    }

    /// Whether the server answers `GET base ‖ path` within `within`. Any status below 500 counts (404, 405 and 429
    /// too). A 5xx does not: a proxy in front of a dead service answers 502 or 503. The body is not read.
    pub async fn answers(&self, base: &BaseUrl, path: &str, within: Duration) -> bool {
        let Ok(url) = base.join(path) else { return false };
        self.client().get(url).timeout(within).send().await.is_ok_and(|r| r.status().as_u16() < 500)
    }
}

async fn send(request: reqwest::RequestBuilder, max_body: usize) -> Result<HttpResponse, TransportError> {
    let response = request.send().await.map_err(|e| classify(&e))?;
    read_response(response, max_body).await
}

/// Before headers arrive: deadline expired or network failure.
fn classify(error: &reqwest::Error) -> TransportError {
    if error.is_timeout() { TransportError::Timeout } else { TransportError::Network }
}

fn header_text<'a>(headers: &'a HeaderMap, name: &HeaderName) -> Option<&'a str> {
    headers.get(name)?.to_str().ok()
}

fn header_date(headers: &HeaderMap) -> Option<u64> {
    let time = httpdate::parse_http_date(header_text(headers, &DATE)?).ok()?;
    time.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs())
}

/// `Retry-After` seconds; a huge value is clamped to [`MAX_RETRY_AFTER`].
fn header_retry_after(headers: &HeaderMap) -> Option<u64> {
    let text = header_text(headers, &RETRY_AFTER)?;
    let all_digits = !text.is_empty() && text.bytes().all(|c| c.is_ascii_digit());
    all_digits.then(|| text.parse().unwrap_or(u64::MAX).min(MAX_RETRY_AFTER))
}

async fn read_response(mut response: reqwest::Response, max_body: usize) -> Result<HttpResponse, TransportError> {
    if response.content_length().is_some_and(|n| n > max_body as u64) {
        return Err(TransportError::TooLarge);
    }
    let (date, retry_after) = (header_date(response.headers()), header_retry_after(response.headers()));
    let status = response.status().as_u16();
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| TransportError::Interrupted)? {
        if chunk.len() > max_body - body.len() {
            return Err(TransportError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(HttpResponse { status, date, retry_after, body })
}

#[cfg(test)]
mod tests;
