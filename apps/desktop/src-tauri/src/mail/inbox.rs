//! Received end-to-end mail (`nightmail:e2e`, [`super::e2e`]): what sync does with a decrypted envelope that holds one.
//!
//! An envelope gives no sign of who sealed it: the server seals what arrives by SMTP, a NightMail client seals its own
//! mail, and both look the same. So the plaintext decides:
//! - it decodes as an e2e mail ([`e2e::declared_sender`]): its declared sender is looked up in the registry
//!   ([`SenderDirectory`]) and the mail opened with that answer ([`settle`]). Verified or not, it is stored with that
//!   verdict. If the registry could not answer, it waits in the store (`e2e_pending`) and sync tries again later: a
//!   passing failure never marks a mail unverified for good.
//! - a plaintext that starts with the e2e marker but does not decode is either an SMTP message that happens to begin
//!   with those bytes (anyone can send that by SMTP), or an e2e mail this app cannot read (a newer version, or
//!   damaged). Only the first can be a MIME message: after the marker a MIME header line goes on with text, while the
//!   e2e format puts its version byte, a control character. So with a control character there
//!   ([`is_unreadable_e2e`]) it is set aside as `unparseable` without trying it as MIME (the MIME parser would make an
//!   empty message out of anything); otherwise it takes the MIME path, and is set aside the same way if the parser
//!   cannot read it either. `unparseable` is not final: each app session relists it, so an app that can read it
//!   later will.
//! - anything else takes the MIME path exactly as before e2e mail existed.
//!
//! An e2e mail is stored as a minimal MIME message ([`synthesize_mime`]) so the list and the reader treat it like any
//! other: `From` is the declared sender (whether it is true is only what `sender_verified` says), `To` the address of
//! ours that received it, `Date` the arrival time on the server. The date the sender wrote is never shown: it is
//! unverified, and a shared clock offset could link a sender's addresses. Deduplication is the store's
//! (`store::inbox`).

use std::future::Future;
use std::pin::Pin;
use std::time::{Duration, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use zeroize::{Zeroize, Zeroizing};

use super::directory::{DirectoryError, sender_resolver};
use super::e2e::{self, Address, MAX_DATE, MailOpenError, Party, ReceivedMail};
use super::parser::{self, Breaker};
use crate::store::{E2eInsert, E2eMeta, LocalStore, NewMessage};

/// What a sender lookup answers: the sender's `authPk` if the declared address resolves to the declared `addrKey`,
/// `None` if not, an error if the registry cannot tell right now.
pub type SenderAnswer = Result<Option<[u8; 32]>, DirectoryError>;
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Looks up the sender of a received e2e mail in the registry. In the app, `Orchestrator::resolve_sender`, which
/// applies the same resolution as sending.
pub trait SenderDirectory: Send + Sync {
    fn resolve_sender<'a>(&'a self, addr_key: &'a [u8; 32], address: &'a str) -> BoxFuture<'a, SenderAnswer>;
}

/// Where a mail arrived: one of our addresses (`address` as `local@domain`, lowercase) and the server's listing.
#[derive(Clone)]
pub struct Arrival {
    pub addr_key: [u8; 32],
    pub address: String,
    pub server_id: String,
    /// Unix seconds, from the server.
    pub received_at: i64,
    pub size_bucket: u32,
}

/// Leaves the address out of logs.
impl std::fmt::Debug for Arrival {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Arrival").field("received_at", &self.received_at).finish_non_exhaustive()
    }
}

/// What became of an e2e mail.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Settled {
    Stored(E2eInsert),
    /// The registry could not answer: keep it and try again later.
    SenderUnavailable,
    /// Not an e2e mail after all.
    NotE2e,
}

/// The sender an e2e mail declares, if the plaintext decodes as one; `None` sends it down the MIME path.
pub fn declared_sender(plaintext: &[u8]) -> Option<Address> {
    e2e::declared_sender(plaintext).ok()
}

/// The e2e marker followed by a control character other than tab, CR or LF, which no MIME header line has there: an
/// e2e mail of some version (the byte after the marker), never a MIME message. Only meaningful for a plaintext that
/// [`declared_sender`] does not decode.
pub fn is_unreadable_e2e(plaintext: &[u8]) -> bool {
    e2e::is_e2e_mail(plaintext)
        && plaintext.get(e2e::MAGIC.len()).is_some_and(|&b| (b < b' ' && !b"\t\r\n".contains(&b)) || b == 0x7f)
}

/// Opens the e2e mail in `plaintext` with the registry's `answer` about its declared sender and stores it (store
/// rules for duplicates). Runs on a blocking thread.
pub fn settle(
    store: &LocalStore,
    arrival: &Arrival,
    plaintext: &[u8],
    declared: &Address,
    answer: SenderAnswer,
) -> crate::store::Result<Settled> {
    let me = Party { addr_key: arrival.addr_key, address: &arrival.address };
    let resolver = sender_resolver(&declared.addr_key, &declared.address, answer);
    match e2e::open_mail(plaintext, &me, resolver) {
        Ok(mail) => store_mail(store, arrival, &mail).map(Settled::Stored),
        Err(MailOpenError::SenderUnavailable) => Ok(Settled::SenderUnavailable),
        Err(MailOpenError::Invalid) => Ok(Settled::NotE2e),
    }
}

fn store_mail(store: &LocalStore, arrival: &Arrival, mail: &ReceivedMail) -> crate::store::Result<E2eInsert> {
    let mut raw = synthesize_mime(mail, &arrival.address, arrival.received_at);
    // Through the sync circuit breaker like any other message, so the list shows what the reader will.
    let marker = [&arrival.addr_key[..], arrival.server_id.as_bytes()].concat();
    let parsed = parser::parse_once(store, Breaker::Sync, &marker, &raw)?;
    let mut message = NewMessage {
        addr_key: arrival.addr_key,
        server_id: arrival.server_id.clone(),
        received_at: arrival.received_at,
        size_bucket: arrival.size_bucket,
        raw: std::mem::take(&mut *raw),
        parsed: parsed.map(|message| message.fields()).unwrap_or_default(),
    };
    let meta = E2eMeta {
        sender_addr_key: mail.sender.addr_key,
        sender_message_id: mail.message_id,
        sender_date: mail.date,
        sender_verified: mail.sender_verified,
    };
    let inserted = store.insert_e2e_message(&message, &meta);
    message.raw.zeroize();
    inserted
}

/// Bytes of subject per RFC 2047 encoded word: 60 characters of base64, 72 with the `=?utf-8?b?…?=` around them, within
/// the 75 the RFC allows.
const ENCODED_WORD_BYTES: usize = 45;
/// Body bytes per line: 76 characters of base64, the most RFC 2045 allows.
const BODY_LINE_BYTES: usize = 57;
/// Room for every header but the subject: fixed text, the date, two addresses of up to 255 bytes, a domain and the id.
const HEADER_ROOM: usize = 2048;

/// `Date` header value, `Tue, 24 Nov 2026 10:00:00 +0000`. Outside `0..=9999-12-31` it is clamped.
fn mime_date(seconds: i64) -> String {
    let seconds = u64::try_from(seconds).unwrap_or(0).min(MAX_DATE);
    let text = httpdate::fmt_http_date(UNIX_EPOCH + Duration::from_secs(seconds));
    format!("{}+0000", text.strip_suffix("GMT").unwrap_or(&text))
}

/// Appends `bytes` in base64, through a buffer that is wiped afterwards (`N` must fit the encoding).
fn push_base64<const N: usize>(out: &mut Vec<u8>, bytes: &[u8]) {
    let mut encoded = Zeroizing::new([0u8; N]);
    if let Ok(length) = STANDARD.encode_slice(bytes, &mut encoded[..]) {
        out.extend_from_slice(&encoded[..length]);
    }
}

/// `Subject:` as RFC 2047 encoded words, split on character boundaries and folded.
fn push_subject(out: &mut Vec<u8>, subject: &str) {
    out.extend_from_slice(b"Subject: ");
    let mut start = 0;
    while start < subject.len() {
        let mut end = (start + ENCODED_WORD_BYTES).min(subject.len());
        while !subject.is_char_boundary(end) {
            end -= 1;
        }
        if start > 0 {
            out.extend_from_slice(b"\r\n ");
        }
        out.extend_from_slice(b"=?utf-8?b?");
        push_base64::<60>(out, &subject.as_bytes()[start..end]);
        out.extend_from_slice(b"?=");
        start = end;
    }
    out.extend_from_slice(b"\r\n");
}

/// The MIME message an e2e mail is stored as: plain text in UTF-8, body in base64 (so any line break, a lone CR or a
/// leading byte order mark survive as they are), headers from fields the e2e format already restricts (addresses of
/// `[a-z0-9._-]`, a one-line subject). `me` is the address of ours that received it; `received_at` the arrival time.
/// Subject and body only go through buffers that are wiped.
pub fn synthesize_mime(mail: &ReceivedMail, me: &str, received_at: i64) -> Zeroizing<Vec<u8>> {
    let lines = mail.body.len().div_ceil(BODY_LINE_BYTES);
    let capacity = HEADER_ROOM + 2 * mail.subject.len() + lines * (4 * BODY_LINE_BYTES / 3 + 2);
    let mut out = Zeroizing::new(Vec::with_capacity(capacity));
    let domain = mail.sender.address.rsplit_once('@').map_or("", |(_, domain)| domain);
    let head = format!(
        "From: <{}>\r\nTo: <{me}>\r\nDate: {}\r\nMessage-ID: <{}@{domain}>\r\n",
        mail.sender.address,
        mime_date(received_at),
        hex::encode(mail.message_id),
    );
    out.extend_from_slice(head.as_bytes());
    if !mail.subject.is_empty() {
        push_subject(&mut out, &mail.subject);
    }
    out.extend_from_slice(b"MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n");
    out.extend_from_slice(b"Content-Transfer-Encoding: base64\r\n\r\n");
    for line in mail.body.as_bytes().chunks(BODY_LINE_BYTES) {
        push_base64::<76>(&mut out, line);
        out.extend_from_slice(b"\r\n");
    }
    out
}

#[cfg(test)]
pub(crate) mod tests;
