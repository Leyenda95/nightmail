//! End-to-end mail between NightMail addresses (`nightmail:e2e`, version 1). The payload is signed with the sender
//! address's auth key (Ed25519) and sealed whole, signature included, in the mailbox envelope to the recipient's
//! `encPk`. Byte layout in `packages/test-vectors/crypto/README.md` §4; the tests replay `e2e-mail.json`, which the
//! TypeScript implementation (`packages/core-ts/src/mail.ts`) generates.
//!
//! Anyone can seal to a public `encPk`, the server included, so only the signature inside says who wrote the mail.
//! It covers the recipient too: a mail signed for one address does not verify after being re-sealed to another.
//!
//! Receiving, with the sender looked up in the registry (asynchronous) between decrypting and verifying:
//!
//! ```text
//! let plaintext = crypto::open_envelope(enc_secret, envelope)?;           // not `is_e2e_mail`: a MIME message
//! let declared = e2e::declared_sender(&plaintext)?;                       // as written, not checked
//! let answer = orchestrator.resolve_sender(&declared.addr_key, &declared.address).await;
//! let resolver = directory::sender_resolver(&declared.addr_key, &declared.address, answer);
//! match e2e::open_mail(&plaintext, &me, resolver) {
//!     Ok(mail) => { /* store it with `mail.sender_verified` */ }
//!     Err(MailOpenError::SenderUnavailable) => { /* keep the envelope and try again later */ }
//!     Err(MailOpenError::Invalid) => { /* not a valid e2e mail */ }
//! }
//! ```

use std::fmt;

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use zeroize::Zeroizing;

use crate::crypto::{is_usable_auth_public_key, is_usable_mailbox_public_key, open_envelope, seal_envelope};

pub const MAGIC: &[u8; 13] = b"nightmail:e2e";
pub const VERSION: u8 = 1;
/// Distinct from the request signing domain (`nightmail:mailbox-api:v1`), which uses the same key.
const SIGNATURE_DOMAIN: &[u8] = b"nightmail:mail-sig:v1";
pub const MESSAGE_ID_LENGTH: usize = 16;
pub const MAX_SUBJECT_LENGTH: usize = 1024;
/// Largest encoded mail (payload and signature), the same 25 MiB the SMTP ingress accepts.
pub const MAX_MAIL_LENGTH: usize = 25 * 1024 * 1024;
const SIGNATURE_LENGTH: usize = 64;
/// Latest date, 9999-12-31 23:59:59 UTC: any later one cannot be shown as a normal calendar date.
pub const MAX_DATE: u64 = 253_402_300_799;
/// Payload and signature without the four variable fields.
pub(crate) const FIXED_LENGTH: usize = MAGIC.len() + 1 + MESSAGE_ID_LENGTH + 8 + 2 * (32 + 1) + 2 + 4 + SIGNATURE_LENGTH;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MailField {
    MessageId,
    Date,
    Sender,
    Recipient,
    Subject,
    Body,
}

impl MailField {
    /// The name used by the TypeScript side and the vectors.
    pub fn name(self) -> &'static str {
        match self {
            Self::MessageId => "messageId",
            Self::Date => "date",
            Self::Sender => "sender",
            Self::Recipient => "recipient",
            Self::Subject => "subject",
            Self::Body => "body",
        }
    }
}

/// A mail that cannot be built or sealed. It names the field, never its value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MailBuildError {
    Field(MailField),
    /// The recipient's `encPk` cannot receive mail (non-canonical or low order).
    RecipientKey,
}

impl fmt::Display for MailBuildError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Field(field) => write!(f, "invalid mail field: {}", field.name()),
            Self::RecipientKey => f.write_str("unusable recipient key"),
        }
    }
}

impl std::error::Error for MailBuildError {}

/// A mail that cannot be opened now. A bad signature is not an error (see [`open_mail`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MailOpenError {
    /// The envelope does not open or does not hold a valid e2e mail. It never says which check failed.
    Invalid,
    /// The sender resolver could not answer ([`SenderUnavailable`]): try again later. The mail is not marked as
    /// unverified because of a passing failure.
    SenderUnavailable,
}

impl fmt::Display for MailOpenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Invalid => "invalid mail",
            Self::SenderUnavailable => "sender check unavailable",
        })
    }
}

impl std::error::Error for MailOpenError {}

/// The answer of a sender resolver when it cannot say whether the sender is registered (the registry cannot be read,
/// or not recently enough). Unlike `Ok(None)` ("not that sender"), the mail is opened again later.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SenderUnavailable;

/// What a sender resolver answers: `Ok(Some(authPk))` for a registered sender whose address is exactly the declared
/// one, `Ok(None)` for anything else, `Err` if it cannot tell right now.
pub type SenderLookup = Result<Option<[u8; 32]>, SenderUnavailable>;

/// An address as written in a mail: its `addrKey` and its text (`name@domain`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Party<'a> {
    pub addr_key: [u8; 32],
    pub address: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Address {
    pub addr_key: [u8; 32],
    pub address: String,
}

impl From<Party<'_>> for Address {
    fn from(party: Party<'_>) -> Self {
        Self { addr_key: party.addr_key, address: party.address.to_owned() }
    }
}

pub struct OutgoingMail<'a> {
    /// 16 random bytes; the recipient keeps one mail per sender and id.
    pub message_id: [u8; MESSAGE_ID_LENGTH],
    /// Unix seconds, up to [`MAX_DATE`]. Never the raw local clock: the server time of the sending address (README
    /// §4.3, `mail::client`), since a clock offset shared by all of a user's addresses would link them.
    pub date: u64,
    pub sender: Party<'a>,
    pub recipient: Party<'a>,
    pub subject: &'a str,
    pub body: &'a str,
}

#[derive(PartialEq, Eq)]
pub struct ReceivedMail {
    pub message_id: [u8; MESSAGE_ID_LENGTH],
    /// Set by the sender and checked by nobody, even when the sender is verified: show and sort mail by the time it
    /// arrived, never by this.
    pub date: u64,
    /// As written in the mail. Only `sender_verified` says whether it is true.
    pub sender: Address,
    /// The signature is valid, by the key the chain has for `sender`, and the mail was signed for this address.
    pub sender_verified: bool,
    pub recipient: Address,
    /// Subject and body are wiped from memory when dropped: the subject is as private as the body.
    pub subject: Zeroizing<String>,
    pub body: Zeroizing<String>,
}

/// Leaves the subject and body out of logs.
impl fmt::Debug for ReceivedMail {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ReceivedMail")
            .field("message_id", &hex::encode(self.message_id))
            .field("sender", &self.sender.address)
            .field("sender_verified", &self.sender_verified)
            .finish_non_exhaustive()
    }
}

/// `local@domain` in lowercase ASCII, as `normalizeName` produces it, so comparing two addresses is comparing bytes:
/// 1–64 of `a-z 0-9 . _ -`, `@`, 1–190 of `a-z 0-9 . -`.
fn is_mail_address(address: &str) -> bool {
    let allowed = |c: u8, extra: &[u8]| c.is_ascii_lowercase() || c.is_ascii_digit() || extra.contains(&c);
    address.split_once('@').is_some_and(|(local, domain)| {
        (1..=64).contains(&local.len())
            && local.bytes().all(|c| allowed(c, b"._-"))
            && (1..=190).contains(&domain.len())
            && domain.bytes().all(|c| allowed(c, b".-"))
    })
}

/// Characters that change how a text looks without being seen (README §4.2): C1 controls; the bidirectional marks,
/// embeddings, overrides and isolates, which can show `fdp.exe` as `exe.pdf`; and the invisible spaces, joiners and
/// operators that hide text or make two different texts look the same. ZWNJ and ZWJ (U+200C, U+200D) are allowed:
/// Persian, Indic scripts and emoji sequences need them, and they neither reorder nor hide text.
fn is_deceptive(c: char) -> bool {
    matches!(
        c,
        '\u{80}'..='\u{9f}'
            | '\u{61c}'
            | '\u{200b}'
            | '\u{200e}'
            | '\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2060}'..='\u{206f}'
            | '\u{feff}'
    )
}

/// A single line: no C0 controls (line breaks included), DEL, line or paragraph separators (U+2028, U+2029) nor
/// [`is_deceptive`] characters.
fn is_subject(subject: &str) -> bool {
    subject.len() <= MAX_SUBJECT_LENGTH
        && !subject.chars().any(|c| c < ' ' || matches!(c, '\u{7f}' | '\u{2028}' | '\u{2029}') || is_deceptive(c))
}

/// Tab, line feed and carriage return are the only controls; no DEL nor [`is_deceptive`] characters, except a byte
/// order mark (U+FEFF) as the very first character, kept as is (README §4.2).
fn is_body(body: &str) -> bool {
    let text = body.strip_prefix('\u{feff}').unwrap_or(body);
    !text.chars().any(|c| (c < ' ' && !matches!(c, '\t' | '\n' | '\r')) || c == '\u{7f}' || is_deceptive(c))
}

/// Lengths of the variable fields, already checked against their limits.
struct Lengths {
    sender: u8,
    recipient: u8,
    subject: u16,
    body: u32,
    /// Of the whole mail, signature included.
    total: usize,
}

fn address_length(address: &str) -> Option<u8> {
    if is_mail_address(address) { u8::try_from(address.len()).ok() } else { None }
}

/// Same rules and order as `encodeMailPayload` in TypeScript.
fn check(mail: &OutgoingMail<'_>) -> Result<Lengths, MailBuildError> {
    let field = MailBuildError::Field;
    if mail.date > MAX_DATE {
        return Err(field(MailField::Date));
    }
    let sender = address_length(mail.sender.address).ok_or(field(MailField::Sender))?;
    let recipient = address_length(mail.recipient.address).ok_or(field(MailField::Recipient))?;
    if !is_subject(mail.subject) {
        return Err(field(MailField::Subject));
    }
    let subject = u16::try_from(mail.subject.len()).map_err(|_| field(MailField::Subject))?;
    if !is_body(mail.body) {
        return Err(field(MailField::Body));
    }
    // The body is the only field with no limit of its own.
    let total = [usize::from(sender), usize::from(recipient), usize::from(subject), mail.body.len()]
        .into_iter()
        .try_fold(FIXED_LENGTH, usize::checked_add)
        .filter(|&total| total <= MAX_MAIL_LENGTH)
        .ok_or(field(MailField::Body))?;
    let body = u32::try_from(mail.body.len()).map_err(|_| field(MailField::Body))?;
    Ok(Lengths { sender, recipient, subject, body, total })
}

/// Whether [`sign_mail`] would accept the mail, without signing it: the same checks, in the same order.
pub fn check_mail(mail: &OutgoingMail<'_>) -> Result<(), MailBuildError> {
    check(mail).map(|_| ())
}

fn write_payload(out: &mut Vec<u8>, mail: &OutgoingMail<'_>, lengths: &Lengths) {
    out.extend_from_slice(MAGIC);
    out.push(VERSION);
    out.extend_from_slice(&mail.message_id);
    out.extend_from_slice(&mail.date.to_be_bytes());
    for (party, length) in [(&mail.sender, lengths.sender), (&mail.recipient, lengths.recipient)] {
        out.extend_from_slice(&party.addr_key);
        out.push(length);
        out.extend_from_slice(party.address.as_bytes());
    }
    out.extend_from_slice(&lengths.subject.to_be_bytes());
    out.extend_from_slice(mail.subject.as_bytes());
    out.extend_from_slice(&lengths.body.to_be_bytes());
    out.extend_from_slice(mail.body.as_bytes());
}

/// `payload ‖ signature`: the plaintext that goes inside the envelope.
pub fn sign_mail(auth_seed: &[u8; 32], mail: &OutgoingMail<'_>) -> Result<Zeroizing<Vec<u8>>, MailBuildError> {
    let lengths = check(mail)?;
    // The payload is written once, after the domain, and signed in place; dropping the domain afterwards keeps the
    // capacity, so the plaintext is never copied to a buffer that would not be wiped.
    let mut buffer = Zeroizing::new(Vec::with_capacity(SIGNATURE_DOMAIN.len() + lengths.total));
    buffer.extend_from_slice(SIGNATURE_DOMAIN);
    write_payload(&mut buffer, mail, &lengths);
    let signature = SigningKey::from_bytes(auth_seed).sign(&buffer);
    buffer.drain(..SIGNATURE_DOMAIN.len());
    buffer.extend_from_slice(&signature.to_bytes());
    Ok(buffer)
}

/// Signs the mail with the sender address's auth seed and seals it to the recipient's `encPk` with a fresh
/// ephemeral key and nonce.
pub fn seal_mail(
    auth_seed: &[u8; 32],
    recipient_enc_public: &[u8; 32],
    mail: &OutgoingMail<'_>,
) -> Result<Vec<u8>, MailBuildError> {
    check(mail)?;
    if !is_usable_mailbox_public_key(recipient_enc_public) {
        return Err(MailBuildError::RecipientKey);
    }
    let plaintext = sign_mail(auth_seed, mail)?;
    seal_envelope(recipient_enc_public, &plaintext).map_err(|_| MailBuildError::RecipientKey)
}

/// Does this decrypted envelope hold an end-to-end mail (of any version) rather than a MIME message?
pub fn is_e2e_mail(plaintext: &[u8]) -> bool {
    plaintext.starts_with(MAGIC)
}

struct Reader<'a> {
    rest: &'a [u8],
}

impl<'a> Reader<'a> {
    fn take(&mut self, length: usize) -> Option<&'a [u8]> {
        let (taken, rest) = self.rest.split_at_checked(length)?;
        self.rest = rest;
        Some(taken)
    }

    fn array<const N: usize>(&mut self) -> Option<[u8; N]> {
        self.take(N)?.try_into().ok()
    }

    fn text(&mut self, length: usize) -> Option<&'a str> {
        std::str::from_utf8(self.take(length)?).ok()
    }

    fn party(&mut self) -> Option<Party<'a>> {
        let addr_key = self.array()?;
        let [length] = self.array()?;
        let address = self.text(usize::from(length)).filter(|address| is_mail_address(address))?;
        Some(Party { addr_key, address })
    }
}

struct Decoded<'a> {
    message_id: [u8; MESSAGE_ID_LENGTH],
    date: u64,
    sender: Party<'a>,
    recipient: Party<'a>,
    subject: &'a str,
    body: &'a str,
    payload: &'a [u8],
    signature: [u8; SIGNATURE_LENGTH],
}

fn decode(plaintext: &[u8]) -> Option<Decoded<'_>> {
    if plaintext.len() > MAX_MAIL_LENGTH || !is_e2e_mail(plaintext) {
        return None;
    }
    let mut reader = Reader { rest: plaintext };
    reader.take(MAGIC.len())?;
    if reader.array()? != [VERSION] {
        return None;
    }
    let message_id = reader.array()?;
    let date = Some(u64::from_be_bytes(reader.array()?)).filter(|&date| date <= MAX_DATE)?;
    let sender = reader.party()?;
    let recipient = reader.party()?;
    let subject_length = usize::from(u16::from_be_bytes(reader.array()?));
    let subject = reader.text(subject_length).filter(|subject| is_subject(subject))?;
    let body_length = usize::try_from(u32::from_be_bytes(reader.array()?)).ok()?;
    let body = reader.text(body_length).filter(|body| is_body(body))?;
    let payload = plaintext.get(..plaintext.len() - reader.rest.len())?;
    let signature = reader.array()?;
    if !reader.rest.is_empty() {
        return None;
    }
    Some(Decoded { message_id, date, sender, recipient, subject, body, payload, signature })
}

/// `verify_strict`: canonical S, R compared byte for byte, neither R nor the key of low order, no cofactor. The
/// TypeScript side adds the low-order checks to OpenSSL's (also without the cofactor), so both give the same verdicts,
/// also for a key with a small-order component (`mixedOrderKey` vectors).
fn verify(auth_public: &[u8; 32], payload: &[u8], signature: &[u8; SIGNATURE_LENGTH]) -> bool {
    if !is_usable_auth_public_key(auth_public) {
        return false;
    }
    let Ok(key) = VerifyingKey::from_bytes(auth_public) else { return false };
    let message = Zeroizing::new([SIGNATURE_DOMAIN, payload].concat());
    key.verify_strict(&message, &Signature::from_bytes(signature)).is_ok()
}

/// The sender as the decrypted mail declares it (`addrKey` and address text), without checking anything but the
/// format: what to look up in the registry before [`open_mail`], never something to show as the sender. A plaintext
/// that [`open_mail`] would refuse as [`MailOpenError::Invalid`] is refused here too.
pub fn declared_sender(plaintext: &[u8]) -> Result<Address, MailOpenError> {
    decode(plaintext).map(|mail| mail.sender.into()).ok_or(MailOpenError::Invalid)
}

/// Decodes the plaintext of an envelope ([`is_e2e_mail`]) and checks the sender. `me` is the address that received
/// it. It is not asked when the mail was signed for someone else.
///
/// `resolve_sender` gets the declared `addrKey` and address text, and must give the sender's on-chain auth key only
/// if that text resolves, with **the same resolution used to send** (`Orchestrator::resolve_recipient`), to that same
/// `addrKey`: the domain exactly the configured one, an alias-shaped local part only as an alias and by its full text,
/// any other as the mailbox `H(name)`, reserved names never; then the `addrKey` and the text compared byte for byte
/// with the ones found. A check of the local part alone would accept `name@other.domain`. The signature proves who
/// holds the key, not that the text belongs to it. `Orchestrator::resolve_sender` with
/// `mail::directory::sender_resolver` does all this.
///
/// A mail that does not decode (unknown version, truncated, a field out of its limits) is [`MailOpenError::Invalid`];
/// one that decodes but whose signature, sender or recipient do not check out comes back with
/// `sender_verified: false`. If the resolver cannot answer, [`MailOpenError::SenderUnavailable`]: open it again later.
pub fn open_mail(
    plaintext: &[u8],
    me: &Party<'_>,
    resolve_sender: impl FnOnce(&[u8; 32], &str) -> SenderLookup,
) -> Result<ReceivedMail, MailOpenError> {
    let mail = decode(plaintext).ok_or(MailOpenError::Invalid)?;
    let sender_verified = if mail.recipient == *me {
        let key = resolve_sender(&mail.sender.addr_key, mail.sender.address)
            .map_err(|SenderUnavailable| MailOpenError::SenderUnavailable)?;
        key.is_some_and(|key| verify(&key, mail.payload, &mail.signature))
    } else {
        false
    };
    Ok(ReceivedMail {
        message_id: mail.message_id,
        date: mail.date,
        sender: mail.sender.into(),
        sender_verified,
        recipient: mail.recipient.into(),
        subject: Zeroizing::new(mail.subject.to_owned()),
        body: Zeroizing::new(mail.body.to_owned()),
    })
}

/// [`open_envelope`] followed by [`open_mail`], for a resolver that can answer right away; an envelope that does not
/// open is [`MailOpenError::Invalid`] too. With the registry lookup (asynchronous), decrypt first and use
/// [`declared_sender`] (module documentation).
pub fn open_mail_envelope(
    enc_secret: &[u8; 32],
    envelope: &[u8],
    me: &Party<'_>,
    resolve_sender: impl FnOnce(&[u8; 32], &str) -> SenderLookup,
) -> Result<ReceivedMail, MailOpenError> {
    let plaintext = open_envelope(enc_secret, envelope).map_err(|_| MailOpenError::Invalid)?;
    open_mail(&plaintext, me, resolve_sender)
}

#[cfg(test)]
mod tests;
