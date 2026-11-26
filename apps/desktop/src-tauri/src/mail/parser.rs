//! MailParser: from decrypted MIME (`raw`) to the fields the UI sees.
//!
//! - The UI never receives `raw`: [`ParsedMessage`] does not carry it, and attachments only expose name, type and
//!   size. Exception: the bytes of inline `cid:` PNG/JPEG/GIF/WebP images, with caps ([`inline`]), and only when a
//!   message is opened.
//! - **MIME tree limits** come from the patched mail-parser 0.11.9 (`vendor/mail-parser-0.11.9`: depth ≤ 32,
//!   parts ≤ 1000 across all levels, encoded `message/rfc822` left unparsed, each inner part's headers ≤ 256 KiB and
//!   all parts' headers ≤ 1 MiB, ≤ 8 failed boundary searches, RFC 2047 encoded words ≤ 1024 bytes). Unbounded
//!   nested MIME overflowed the stack when dropping the tree, which aborts the process and cannot be caught. The
//!   top-level header is bounded here ([`MAX_HEADER_BYTES`]); beyond that only those headers are read
//!   (`truncated`). Library panics are caught (`catch_unwind`).
//! - **Circuit breaker** ([`parse_once`]): before parsing, the message being parsed is recorded in the store and
//!   cleared afterwards. If the mark is still there on the next start (the process died parsing it), that message
//!   goes on a persistent poisoned list and is never parsed again; it is stored and shown without fields. A message
//!   that crashes the parser therefore cannot crash it in a loop.
//! - Sender, recipients, subject and attachment names are stripped of control characters, bidi controls and
//!   invisibles (zero width, line separators, soft hyphen, tags), and trimmed.
//!
//! **Contract for the UI:**
//! - `html` is returned as received, unsanitised. It may only be rendered in a sandboxed `iframe` (no
//!   `allow-scripts` or `allow-same-origin`), after DOMPurify, under a CSP that allows nothing remote (no images,
//!   styles or fonts), and with no links that open by themselves.
//! - The sender name is set by the sender and can impersonate someone else: the UI always shows the address next to
//!   the name, never the name alone.
//! - The read path (opening a stored message) parses with [`parse_once`] and [`Breaker::Read`], one at a time (one
//!   lock per path). If a message was stored without fields (sync breaker, possibly a false positive) and reading
//!   parses it fine, the fields are saved with `LocalStore::set_parsed`.
//! - On mail-parser's `Message`: never call `into_owned()` or `MessagePart::len()` on a part that is itself a
//!   message (it copies the whole parent); use `raw_end_offset − raw_body_offset` for its size.
//! - `truncated` means the message exceeded the limits (or was broken) and the UI says so. It is not stored
//!   (`ParsedFields` has no such field); the UI gets it when opening the message with [`parse_once`] and
//!   [`Breaker::Read`].
//! - Deleting a message is the store's `deleted` mark; if rows are ever really deleted, a tombstone must remain or
//!   [`super::sync`] relisting will download the message again.
//! - `ParsedMessage` is deliberately not `Serialize`: the command layer defines its own output type.

use std::fmt;
use std::panic::{AssertUnwindSafe, catch_unwind};

use mail_parser::{Addr, Message, MessageParser, MessagePart, MimeHeaders};

use crate::store::{LocalStore, ParsedFields};

/// Maximum top-level header block; beyond it only those first bytes are read.
pub const MAX_HEADER_BYTES: usize = 256 * 1024;
pub const MAX_RECIPIENTS: usize = 100;
pub const MAX_ATTACHMENTS: usize = 100;
/// Subject, sender, each recipient, attachment name and type.
pub const MAX_FIELD_CHARS: usize = 1000;
/// Text and HTML, each.
pub const MAX_BODY_CHARS: usize = 2_000_000;
pub const PREVIEW_CHARS: usize = 160;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParseError {
    /// Not a message, or the library failed.
    Unparseable,
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("unreadable message")
    }
}

impl std::error::Error for ParseError {}

#[derive(Clone, PartialEq, Eq)]
pub struct AttachmentInfo {
    pub name: Option<String>,
    pub content_type: String,
    /// Decoded size in bytes.
    pub size: usize,
}

#[derive(Clone, Default, PartialEq, Eq)]
pub struct ParsedMessage {
    /// `Name <address>` or just the address.
    pub from: Option<String>,
    pub to: Vec<String>,
    pub subject: Option<String>,
    /// `Date` header in Unix seconds.
    pub date: Option<i64>,
    pub text: Option<String>,
    /// Only if the message has an HTML part (never synthesised from the text). Unsanitised: see the module docs.
    pub html: Option<String>,
    pub attachments: Vec<AttachmentInfo>,
    /// Start of the text, on one line.
    pub preview: String,
    /// The message exceeded the limits (or was broken) and something is missing. With an oversized top-level header
    /// there are only headers; with a library limit, whatever was read up to the cut (text included, if reached).
    pub truncated: bool,
    /// `cid:` images the reader can render; empty when only headers were read.
    pub inline: InlineImages,
}

/// No content: `Debug` output may end up in a log.
impl fmt::Debug for ParsedMessage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ParsedMessage")
            .field("to", &self.to.len())
            .field("has_text", &self.text.is_some())
            .field("has_html", &self.html.is_some())
            .field("attachments", &self.attachments.len())
            .field("truncated", &self.truncated)
            .finish_non_exhaustive()
    }
}

impl fmt::Debug for AttachmentInfo {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AttachmentInfo").field("size", &self.size).finish_non_exhaustive()
    }
}

impl ParsedMessage {
    /// What is stored in `LocalStore` for the message list.
    pub fn fields(&self) -> ParsedFields {
        ParsedFields {
            from_addr: self.from.clone(),
            subject: self.subject.clone(),
            sent_at: self.date,
            preview: Some(self.preview.clone()).filter(|p| !p.is_empty()),
        }
    }
}

/// Bidirectional controls (LRM, RLM, ALM, embeddings, isolates).
fn is_bidi_control(c: char) -> bool {
    matches!(c, '\u{061C}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// Invisibles that can disguise text: zero width, line and paragraph separators, soft hyphen, Mongolian vowel
/// separator, BOM and Unicode tags.
fn is_invisible(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200D}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{2060}'..='\u{2064}'
            | '\u{FEFF}'
            | '\u{E0000}'..='\u{E007F}'
    )
}

fn is_visible(c: char) -> bool {
    !c.is_control() && !is_bidi_control(c) && !is_invisible(c)
}

/// Single-line field: no controls or invisibles, at most `MAX_FIELD_CHARS` characters.
fn clean(text: &str) -> String {
    text.chars().filter(|&c| is_visible(c)).take(MAX_FIELD_CHARS).collect()
}

fn clip(text: &str, max_chars: usize) -> String {
    text.chars().take(max_chars).collect()
}

/// Collapses whitespace runs (newlines included), drops controls, stops at `PREVIEW_CHARS` without scanning the rest.
fn one_line(text: &str) -> String {
    let words = text.split_whitespace().flat_map(|word| std::iter::once(' ').chain(word.chars()));
    words.skip(1).filter(|&c| is_visible(c)).take(PREVIEW_CHARS).collect()
}

/// An address that can be shown inside `<…>`: has an `@` and no spaces, `<` or `>`.
fn plausible_address(address: &str) -> bool {
    address.bytes().filter(|&b| b == b'@').count() == 1
        && !address.chars().any(|c| c.is_whitespace() || c == '<' || c == '>')
}

/// Always `Name <address>`, `<address>` or `Name <>`: the address is always inside `<…>` (empty if missing or
/// implausible), so a name is never shown as if it were the address.
fn show_addr(addr: &Addr<'_>) -> Option<String> {
    let address = addr.address().map(clean).filter(|a| plausible_address(a)).unwrap_or_default();
    let name = addr.name().map(clean).filter(|n| !n.is_empty());
    if name.is_none() && address.is_empty() {
        return None;
    }
    Some(match name {
        Some(name) => format!("{name} <{address}>"),
        None => format!("<{address}>"),
    })
}

fn recipients(message: &Message<'_>) -> Vec<String> {
    let Some(to) = message.to() else { return Vec::new() };
    to.iter().filter_map(show_addr).take(MAX_RECIPIENTS).collect()
}

fn content_type(part: &MessagePart<'_>) -> String {
    let shown = match part.content_type() {
        Some(ct) => format!("{}/{}", ct.ctype(), ct.subtype().unwrap_or("octet-stream")),
        None => "application/octet-stream".to_owned(),
    };
    clean(&shown.to_ascii_lowercase())
}

/// Attachment size. An unencoded `message/rfc822` is a whole message: its size is that of its body in the original
/// (mail-parser would report the whole parent message).
fn attachment_size(part: &MessagePart<'_>) -> usize {
    if part.is_message() { part.raw_end_offset().saturating_sub(part.raw_body_offset()) as usize } else { part.len() }
}

fn attachment(part: &MessagePart<'_>) -> AttachmentInfo {
    AttachmentInfo {
        name: part.attachment_name().map(clean),
        content_type: content_type(part),
        size: attachment_size(part),
    }
}

/// HTML only if the first HTML part really is HTML (mail-parser would convert the text).
fn html(message: &Message<'_>) -> Option<String> {
    let part = message.html_part(0).filter(|part| part.is_text_html())?;
    part.text_contents().map(|html| clip(html, MAX_BODY_CHARS))
}

/// Length of the top-level header block (up to the first empty line, or everything).
fn header_length(raw: &[u8]) -> usize {
    let mut length = 0;
    for line in raw.split(|&b| b == b'\n') {
        if line.is_empty() || line == b"\r" {
            return length;
        }
        length += line.len() + 1;
    }
    raw.len()
}

/// Whether the message fits the limits. Only the top-level header is checked: it is the one limit the patched library
/// does not enforce (it bounds parts, depth and inner headers). Counting `--` and `Content-Type` lines over the whole
/// message is redundant with the patch and wrongly emptied legitimate bodies with over 1000 `--` lines (SQL dumps,
/// git patches).
fn within_limits(raw: &[u8]) -> bool {
    header_length(raw) <= MAX_HEADER_BYTES
}

fn headers(message: &Message<'_>) -> ParsedMessage {
    ParsedMessage {
        from: message.from().and_then(|from| from.first()).and_then(show_addr),
        to: recipients(message),
        subject: message.subject().map(clean),
        date: message.date().map(|date| date.to_timestamp()),
        ..ParsedMessage::default()
    }
}

/// Full parse; inline images only if `with_inline` (read path).
fn full(raw: &[u8], with_inline: bool) -> Result<ParsedMessage, ParseError> {
    let message = MessageParser::default().parse(raw).ok_or(ParseError::Unparseable)?;
    let text = message.body_text(0).map(|text| clip(&text, MAX_BODY_CHARS));
    Ok(ParsedMessage {
        preview: one_line(text.as_deref().unwrap_or_default()),
        html: html(&message),
        attachments: message.attachments().take(MAX_ATTACHMENTS).map(attachment).collect(),
        text,
        // The vendored patch signals this way that a limit cut the parse short (or the MIME was broken).
        truncated: message.parts.first().is_some_and(|part| part.is_encoding_problem),
        inline: if with_inline { inline::collect(&message) } else { InlineImages::default() },
        ..headers(&message)
    })
}

/// Top-level headers only, from at most the first [`MAX_HEADER_BYTES`] bytes.
fn headers_only(raw: &[u8]) -> Result<ParsedMessage, ParseError> {
    let head = &raw[..raw.len().min(MAX_HEADER_BYTES)];
    let message = MessageParser::default().parse_headers(head).ok_or(ParseError::Unparseable)?;
    Ok(ParsedMessage { truncated: true, ..headers(&message) })
}

/// A library panic means an unreadable message, not a crashed core.
fn guarded(analyze: impl FnOnce() -> Result<ParsedMessage, ParseError>) -> Result<ParsedMessage, ParseError> {
    catch_unwind(AssertUnwindSafe(analyze)).unwrap_or(Err(ParseError::Unparseable))
}

/// Parses without the circuit breaker (for callers that already have one, or tests), including inline images.
pub fn parse(raw: &[u8]) -> Result<ParsedMessage, ParseError> {
    analyze(raw, true)
}

fn analyze(raw: &[u8], with_inline: bool) -> Result<ParsedMessage, ParseError> {
    guarded(|| if within_limits(raw) { full(raw, with_inline) } else { headers_only(raw) })
}

/// Path doing the parsing: each has its own mark and its own poisoned list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Breaker {
    /// Sync, when storing a new message.
    Sync,
    /// The UI, when opening a stored message.
    Read,
}

/// Poisoned ids remembered per path (the oldest are forgotten).
pub const MAX_POISONED: usize = 64;

impl Breaker {
    fn key(self, list: &str) -> String {
        let path = if self == Self::Sync { "sync" } else { "read" };
        format!("mail.{list}.{path}")
    }

    fn in_flight_key(self) -> String {
        self.key("parsing")
    }

    fn poisoned_key(self) -> String {
        self.key("poisoned")
    }

    /// One parse at a time per path (if two overlapped, one could poison the other).
    fn exclusive(self) -> std::sync::MutexGuard<'static, ()> {
        static SYNC: std::sync::Mutex<()> = std::sync::Mutex::new(());
        static READ: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let lock = if self == Self::Sync { &SYNC } else { &READ };
        lock.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// List of ids in `meta`: hex, one per line.
fn load_ids(store: &LocalStore, key: &str) -> crate::store::Result<Vec<Vec<u8>>> {
    let text = store.get_meta(key)?.unwrap_or_default();
    Ok(text.split(|&b| b == b'\n').filter_map(|line| hex::decode(line).ok()).filter(|id| !id.is_empty()).collect())
}

fn save_ids(store: &LocalStore, key: &str, ids: &[Vec<u8>]) -> crate::store::Result<()> {
    store.set_meta(key, ids.iter().map(hex::encode).collect::<Vec<_>>().join("\n").as_bytes())
}

/// If a previous parse on this path did not finish, its id goes on the poisoned list. Returns the list.
fn collect_poisoned(store: &LocalStore, breaker: Breaker) -> crate::store::Result<Vec<Vec<u8>>> {
    let mut poisoned = load_ids(store, &breaker.poisoned_key())?;
    let in_flight = store.get_meta(&breaker.in_flight_key())?.unwrap_or_default();
    let was_in_flight = !in_flight.is_empty();
    if !in_flight.is_empty() && !poisoned.contains(&in_flight) {
        log::warn!("mail: a message crashed the parser; it will not be parsed again");
        poisoned.push(in_flight);
        let excess = poisoned.len().saturating_sub(MAX_POISONED);
        poisoned.drain(..excess);
        save_ids(store, &breaker.poisoned_key(), &poisoned)?;
    }
    if was_in_flight {
        store.set_meta(&breaker.in_flight_key(), b"")?;
    }
    Ok(poisoned)
}

/// Parses with the circuit breaker. `id` identifies the message (e.g. `addr_key ‖ server_id`, or the local id).
/// Before parsing `id` is recorded as in progress and cleared afterwards; if another one was still recorded at start
/// (the process died parsing it), that one goes on a persistent, bounded, per-path poisoned list. A poisoned id is
/// never parsed again: `None`, same as an unreadable message.
///
/// Each path parses one message at a time (enforced by a per-path lock).
pub fn parse_once(
    store: &LocalStore,
    breaker: Breaker,
    id: &[u8],
    raw: &[u8],
) -> crate::store::Result<Option<ParsedMessage>> {
    let _exclusive = breaker.exclusive();
    if collect_poisoned(store, breaker)?.iter().any(|poisoned| poisoned == id) {
        return Ok(None);
    }
    store.set_meta(&breaker.in_flight_key(), id)?;
    // Inline images are only needed when opening the message; sync does not copy them just to throw them away.
    let parsed = analyze(raw, breaker == Breaker::Read).ok();
    store.set_meta(&breaker.in_flight_key(), b"")?;
    Ok(parsed)
}
pub mod inline;
pub use inline::InlineImages;

#[cfg(test)]
mod library_tests;
#[cfg(test)]
pub(crate) mod tests;
