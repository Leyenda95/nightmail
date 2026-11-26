//! Sealing and opening mailbox envelopes, signing mailbox requests, and `nameCipher`.
//!
//! The exact byte layout is specified in `packages/test-vectors/crypto/README.md` §1 (envelope), §2 (signature) and
//! §3.4 (`nameCipher`); the tests replay the vectors in that directory.
#![allow(dead_code)]

use std::fmt;

use aes_gcm::aead::{AeadInPlace, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce, Tag};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use hkdf::Hkdf;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

/// Fills the buffer in place with OS randomness, for secrets, so they are not copied around the stack on return.
/// A failing OS generator cannot be recovered from, so this aborts.
pub(crate) fn fill_random(buffer: &mut [u8]) {
    getrandom::fill(buffer).expect("system random generator");
}

/// Random bytes by value, for non-secrets (nonces, salts, temp file names).
pub(crate) fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    fill_random(&mut bytes);
    bytes
}

/// A single usage or format error with a fixed message and no library detail.
macro_rules! opaque_error {
    ($name:ident, $message:literal) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub struct $name;

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str($message)
            }
        }

        impl std::error::Error for $name {}
    };
}

// ---------- Mailbox envelope (README §1) ----------

opaque_error!(EnvelopeError, "invalid envelope");

const MAILBOX_DOMAIN: &[u8] = b"nightmail:mailbox:v1";
/// `version` ‖ `suite`; also the AAD.
const ENVELOPE_HEADER: [u8; 2] = [0x01, 0x01];
const ENVELOPE_PREFIX_LENGTH: usize = 62;
const MIN_BUCKET: usize = 4096;
const MAX_BUCKET: usize = 33_554_432;
/// Largest message that fits in the last bucket, after its 4-byte length.
pub const MAX_PLAINTEXT_LENGTH: usize = MAX_BUCKET - 4;
/// Longest accepted envelope (62 bytes + 32 MiB). Checked before allocating; the transport must also check it
/// before reading the whole body.
pub const MAX_ENVELOPE_LENGTH: usize = ENVELOPE_PREFIX_LENGTH + MAX_BUCKET;

/// `key` = HKDF-SHA256(shared, empty salt, "nightmail:mailbox:v1" ‖ ephemeral pk ‖ recipient pk, 32).
fn mailbox_key(shared: &[u8; 32], ephemeral: &[u8; 32], recipient: &[u8; 32]) -> Zeroizing<[u8; 32]> {
    let info = [MAILBOX_DOMAIN, ephemeral, recipient].concat();
    let mut key = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(None, shared).expand(&info, key.as_mut()).expect("32 bytes fit in HKDF-SHA256");
    key
}

/// Fields of an envelope with a known header and a length within bounds.
struct EnvelopeParts<'a> {
    ephemeral: [u8; 32],
    nonce: &'a [u8],
    tag: &'a [u8],
    ciphertext: &'a [u8],
}

impl<'a> EnvelopeParts<'a> {
    fn parse(envelope: &'a [u8]) -> Option<Self> {
        let length_ok = (ENVELOPE_PREFIX_LENGTH..=MAX_ENVELOPE_LENGTH).contains(&envelope.len());
        if !length_ok || envelope[..2] != ENVELOPE_HEADER {
            return None;
        }
        Some(Self {
            ephemeral: envelope[2..34].try_into().ok()?,
            nonce: &envelope[34..46],
            tag: &envelope[46..62],
            ciphertext: &envelope[ENVELOPE_PREFIX_LENGTH..],
        })
    }
}

/// `u32be(len) ‖ message ‖ padding`: padding is ignored and need not match a bucket size.
fn unpad(padded: &[u8]) -> Option<&[u8]> {
    let (prefix, rest) = padded.split_first_chunk::<4>()?;
    let length = usize::try_from(u32::from_be_bytes(*prefix)).ok()?;
    rest.get(..length)
}

/// Opens a mailbox envelope with the address's X25519 key (README §1.5). Every rejection is the same error. The
/// decrypted padded buffer is wiped on return.
pub fn open_envelope(recipient_secret: &[u8; 32], envelope: &[u8]) -> Result<Zeroizing<Vec<u8>>, EnvelopeError> {
    let parts = EnvelopeParts::parse(envelope).ok_or(EnvelopeError)?;
    let secret = StaticSecret::from(*recipient_secret);
    let shared = secret.diffie_hellman(&PublicKey::from(parts.ephemeral));
    if !shared.was_contributory() {
        return Err(EnvelopeError);
    }
    let key = mailbox_key(shared.as_bytes(), &parts.ephemeral, PublicKey::from(&secret).as_bytes());
    let mut padded = Zeroizing::new(parts.ciphertext.to_vec());
    Aes256Gcm::new_from_slice(key.as_ref())
        .expect("32-byte key")
        .decrypt_in_place_detached(
            Nonce::from_slice(parts.nonce),
            &ENVELOPE_HEADER,
            padded.as_mut_slice(),
            Tag::from_slice(parts.tag),
        )
        .map_err(|_| EnvelopeError)?;
    unpad(&padded).map(|message| Zeroizing::new(message.to_vec())).ok_or(EnvelopeError)
}

// ---------- Sealing (README §1.4) ----------

opaque_error!(SealError, "cannot seal envelope");

/// Do the low 255 bits encode a value below p = 2^255 − 19? Only p .. 2^255 − 1 do not: first byte ≥ 0xed, the next
/// 30 bytes 0xff and the last (without bit 255) 0x7f.
fn is_canonical_field_element(bytes: &[u8; 32]) -> bool {
    !(bytes[0] >= 0xed && bytes[31] & 0x7f == 0x7f && bytes[1..31].iter().all(|&b| b == 0xff))
}

/// Bit 255 clear and u < p (README §1.2). `info` carries the key bytes verbatim, so the key holder could not open an
/// envelope sealed to a non-canonical encoding of their key.
fn is_canonical_x25519(public: &[u8; 32]) -> bool {
    public[31] & 0x80 == 0 && is_canonical_field_element(public)
}

/// Can mail be sealed to this X25519 key? Canonical and not low order: the server's `isUsableMailboxPublicKey`.
pub fn is_usable_mailbox_public_key(public: &[u8; 32]) -> bool {
    // Any secret detects a low-order point: with one, the shared secret is always zero.
    is_canonical_x25519(public)
        && StaticSecret::from([0x42; 32]).diffie_hellman(&PublicKey::from(*public)).was_contributory()
}

/// The smallest bucket (a power of 2 between 4 KiB and 32 MiB) holding the message and its 4-byte length.
fn bucket_for(length: usize) -> usize {
    (length + 4).next_power_of_two().max(MIN_BUCKET)
}

/// `u32be(len) ‖ message ‖ zeros up to the bucket` (README §1.3).
fn pad(message: &[u8]) -> Result<Zeroizing<Vec<u8>>, SealError> {
    if message.len() > MAX_PLAINTEXT_LENGTH {
        return Err(SealError);
    }
    let length = u32::try_from(message.len()).map_err(|_| SealError)?;
    let mut padded = Zeroizing::new(vec![0u8; bucket_for(message.len())]);
    padded[..4].copy_from_slice(&length.to_be_bytes());
    padded[4..4 + message.len()].copy_from_slice(message);
    Ok(padded)
}

/// Seals an already padded buffer with the given ephemeral key and nonce, which must never repeat. Outside the vector
/// tests, only [`seal_envelope`] calls it, with fresh ones.
fn seal_padded(
    recipient: &[u8; 32],
    mut padded: Zeroizing<Vec<u8>>,
    ephemeral: &[u8; 32],
    nonce: &[u8; 12],
) -> Result<Vec<u8>, SealError> {
    if !is_canonical_x25519(recipient) {
        return Err(SealError);
    }
    let secret = StaticSecret::from(*ephemeral);
    let ephemeral_public = PublicKey::from(&secret);
    let shared = secret.diffie_hellman(&PublicKey::from(*recipient));
    if !shared.was_contributory() {
        return Err(SealError);
    }
    let key = mailbox_key(shared.as_bytes(), ephemeral_public.as_bytes(), recipient);
    let tag = Aes256Gcm::new_from_slice(key.as_ref())
        .map_err(|_| SealError)?
        .encrypt_in_place_detached(Nonce::from_slice(nonce), &ENVELOPE_HEADER, padded.as_mut_slice())
        .map_err(|_| SealError)?;
    let mut envelope = Vec::with_capacity(ENVELOPE_PREFIX_LENGTH + padded.len());
    envelope.extend_from_slice(&ENVELOPE_HEADER);
    envelope.extend_from_slice(ephemeral_public.as_bytes());
    envelope.extend_from_slice(nonce);
    envelope.extend_from_slice(&tag);
    envelope.extend_from_slice(&padded);
    Ok(envelope)
}

/// [`seal_envelope`] with a given ephemeral key and nonce, which must never repeat. Private: outside the tests only
/// [`seal_envelope`] calls it, with fresh ones.
fn seal_envelope_with(
    recipient: &[u8; 32],
    message: &[u8],
    ephemeral: &[u8; 32],
    nonce: &[u8; 12],
) -> Result<Vec<u8>, SealError> {
    seal_padded(recipient, pad(message)?, ephemeral, nonce)
}

/// [`seal_envelope_with`] for the tests that reproduce the vectors (`mail::e2e`); not built into the app.
#[cfg(test)]
pub(crate) fn seal_envelope_for_vectors(
    recipient: &[u8; 32],
    message: &[u8],
    ephemeral: &[u8; 32],
    nonce: &[u8; 12],
) -> Result<Vec<u8>, SealError> {
    seal_envelope_with(recipient, message, ephemeral, nonce)
}

/// Encrypts `message` to an address's X25519 public key with a fresh ephemeral key and nonce (README §1.4). Fails for a
/// key [`is_usable_mailbox_public_key`] rejects and for a message over [`MAX_PLAINTEXT_LENGTH`] bytes.
pub fn seal_envelope(recipient: &[u8; 32], message: &[u8]) -> Result<Vec<u8>, SealError> {
    let mut ephemeral = Zeroizing::new([0u8; 32]);
    fill_random(ephemeral.as_mut());
    seal_envelope_with(recipient, message, &ephemeral, &random_bytes())
}

// ---------- Mailbox request signing (README §2) ----------

opaque_error!(RequestError, "unsignable mailbox request");

pub const TIMESTAMP_HEADER: &str = "NightMail-Timestamp";
pub const NONCE_HEADER: &str = "NightMail-Nonce";
pub const SIGNATURE_HEADER: &str = "NightMail-Signature";

const API_DOMAIN: &[u8] = b"nightmail:mailbox-api:v1";
/// The (TypeScript) server rejects larger timestamps.
const MAX_TIMESTAMP: u64 = (1 << 53) - 1;

/// The signed parts of a request (README §2, in this order).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailboxRequest<'a> {
    /// Authority of the configured base URL ([`canonical_host`]), never the `Host` header.
    pub host: &'a str,
    /// Taken from the path: `/v1/…` is 1.
    pub version: u8,
    pub method: &'a str,
    /// Request target as sent, including the query, not normalised.
    pub path: &'a str,
    pub addr_key: [u8; 32],
    /// Unix seconds on the server clock (README §2.4), never the raw local clock.
    pub timestamp: u64,
    /// Fresh for every request ([`random_bytes`]).
    pub nonce: [u8; 16],
}

/// Values of the three authentication headers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthHeaders {
    pub timestamp: String,
    pub nonce: String,
    pub signature: String,
}

impl AuthHeaders {
    pub fn pairs(&self) -> [(&'static str, &str); 3] {
        [(TIMESTAMP_HEADER, &self.timestamp), (NONCE_HEADER, &self.nonce), (SIGNATURE_HEADER, &self.signature)]
    }
}

/// 1–255 characters from `a-z 0-9 . - : [ ]`.
fn is_signable_host(host: &str) -> bool {
    (1..=255).contains(&host.len())
        && host.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b".-:[]".contains(&c))
}

/// 1–16 letters `A-Z`.
fn is_signable_method(method: &str) -> bool {
    (1..=16).contains(&method.len()) && method.bytes().all(|c| c.is_ascii_uppercase())
}

/// Any `.` or `..` segment before `?`, including ones written as `%2e` or `%2E`.
fn has_dot_segment(path: &str) -> bool {
    let pathname = path.split('?').next().unwrap_or_default();
    pathname.split('/').any(|segment| {
        let dots = segment.to_ascii_lowercase().replace("%2e", ".");
        dots == "." || dots == ".."
    })
}

/// Starts with `/`; 1–2048 characters from `A-Z a-z 0-9 / . _ ~ % ? = & -`; no dot segments.
fn is_signable_path(path: &str) -> bool {
    (1..=2048).contains(&path.len())
        && path.starts_with('/')
        && path.bytes().all(|c| c.is_ascii_alphanumeric() || b"/._~%?=&-".contains(&c))
        && !has_dot_segment(path)
}

fn push_text(out: &mut Vec<u8>, text: &str) {
    let length = u16::try_from(text.len()).expect("length already checked");
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(text.as_bytes());
}

/// Canonical encoding (README §2). Anything breaking the rules is neither signed nor normalised.
pub fn encode_request(request: &MailboxRequest<'_>) -> Result<Vec<u8>, RequestError> {
    let valid = is_signable_host(request.host)
        && is_signable_method(request.method)
        && is_signable_path(request.path)
        && request.timestamp <= MAX_TIMESTAMP;
    if !valid {
        return Err(RequestError);
    }
    let mut out = API_DOMAIN.to_vec();
    push_text(&mut out, request.host);
    out.push(request.version);
    push_text(&mut out, request.method);
    push_text(&mut out, request.path);
    out.extend_from_slice(&request.addr_key);
    out.extend_from_slice(&request.timestamp.to_be_bytes());
    out.extend_from_slice(&request.nonce);
    Ok(out)
}

/// Ed25519 (RFC 8032) signature of the request with the address seed, ready for the headers.
pub fn sign_request(auth_seed: &[u8; 32], request: &MailboxRequest<'_>) -> Result<AuthHeaders, RequestError> {
    let message = encode_request(request)?;
    let signature = SigningKey::from_bytes(auth_seed).sign(&message);
    Ok(AuthHeaders {
        timestamp: request.timestamp.to_string(),
        nonce: hex::encode(request.nonce),
        signature: hex::encode(signature.to_bytes()),
    })
}

/// Can this Ed25519 key sign for an address? Canonical `y` and not low order (README §2.1), like the server's
/// `isUsableAuthPublicKey`, but stricter: a `y` that is not on the curve is refused here, while the server accepts
/// it. No signature verifies under such a key on either side, so the verdict on a signature is the same; in the app's
/// directory an address registered with one is `Unusable`.
pub fn is_usable_auth_public_key(public: &[u8; 32]) -> bool {
    let mut y = *public;
    y[31] &= 0x7f;
    is_canonical_field_element(&y) && VerifyingKey::from_bytes(public).is_ok_and(|key| !key.is_weak())
}

/// Signable `host` of an http(s) base URL: lowercase name, plus `:port` only when it is not the scheme default
/// (README §2.2). A URL whose authority breaks the `host` rule is rejected.
pub fn canonical_host(base_url: &str) -> Result<String, RequestError> {
    let url = url::Url::parse(base_url).map_err(|_| RequestError)?;
    let host = match url.scheme() {
        "http" | "https" => url.host_str().ok_or(RequestError)?,
        _ => return Err(RequestError),
    };
    let authority = match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    };
    if is_signable_host(&authority) { Ok(authority) } else { Err(RequestError) }
}

// ---------- nameCipher (README §3.4) ----------

opaque_error!(NameCipherError, "invalid encrypted name");

const NAME_DOMAIN: &[u8] = b"nightmail:name-cipher:v1";
const NAME_NONCE_LENGTH: usize = 24;
const NAME_PADDED_LENGTH: usize = 64;
pub const NAME_CIPHER_LENGTH: usize = NAME_NONCE_LENGTH + NAME_PADDED_LENGTH + 16;
/// The `nameCipher` of an alias.
pub const ALIAS_NAME_CIPHER: [u8; NAME_CIPHER_LENGTH] = [0; NAME_CIPHER_LENGTH];

fn name_aad(slot_nul: &[u8; 32]) -> Vec<u8> {
    [NAME_DOMAIN, slot_nul].concat()
}

fn name_cipher(key: &[u8; 32]) -> XChaCha20Poly1305 {
    XChaCha20Poly1305::new_from_slice(key).expect("32-byte key")
}

/// 1–64 bytes of UTF-8 without NUL: the only names that fit and round-trip unambiguously.
fn is_storable_name(bytes: &[u8]) -> bool {
    (1..=NAME_PADDED_LENGTH).contains(&bytes.len()) && !bytes.contains(&0) && std::str::from_utf8(bytes).is_ok()
}

/// Encrypts a mailbox's normalised name with a fresh random nonce.
pub fn seal_name(key: &[u8; 32], slot_nul: &[u8; 32], name: &str) -> Result<[u8; NAME_CIPHER_LENGTH], NameCipherError> {
    seal_name_with_nonce(key, slot_nul, name, random_bytes())
}

fn seal_name_with_nonce(
    key: &[u8; 32],
    slot_nul: &[u8; 32],
    name: &str,
    nonce: [u8; NAME_NONCE_LENGTH],
) -> Result<[u8; NAME_CIPHER_LENGTH], NameCipherError> {
    if !is_storable_name(name.as_bytes()) {
        return Err(NameCipherError);
    }
    let mut padded = Zeroizing::new([0u8; NAME_PADDED_LENGTH]);
    padded[..name.len()].copy_from_slice(name.as_bytes());
    let tag = name_cipher(key)
        .encrypt_in_place_detached(XNonce::from_slice(&nonce), &name_aad(slot_nul), padded.as_mut())
        .map_err(|_| NameCipherError)?;
    let mut out = [0u8; NAME_CIPHER_LENGTH];
    out[..NAME_NONCE_LENGTH].copy_from_slice(&nonce);
    out[NAME_NONCE_LENGTH..NAME_NONCE_LENGTH + NAME_PADDED_LENGTH].copy_from_slice(padded.as_ref());
    out[NAME_NONCE_LENGTH + NAME_PADDED_LENGTH..].copy_from_slice(&tag);
    Ok(out)
}

/// Decrypts a `nameCipher`: strips trailing zeros and requires valid UTF-8 without NUL. An alias (104 zeros), a
/// different key or a different `slotNul` all give the same error.
pub fn open_name(
    key: &[u8; 32],
    slot_nul: &[u8; 32],
    sealed: &[u8; NAME_CIPHER_LENGTH],
) -> Result<String, NameCipherError> {
    let (nonce, rest) = sealed.split_at(NAME_NONCE_LENGTH);
    let (body, tag) = rest.split_at(NAME_PADDED_LENGTH);
    let mut padded = Zeroizing::new([0u8; NAME_PADDED_LENGTH]);
    padded.copy_from_slice(body);
    name_cipher(key)
        .decrypt_in_place_detached(XNonce::from_slice(nonce), &name_aad(slot_nul), padded.as_mut(), tag.into())
        .map_err(|_| NameCipherError)?;
    let end = padded.iter().rposition(|&b| b != 0).map_or(0, |last| last + 1);
    let name = &padded[..end];
    if !is_storable_name(name) {
        return Err(NameCipherError);
    }
    String::from_utf8(name.to_vec()).map_err(|_| NameCipherError)
}

// ---------- Tests ----------

/// Reads the vectors in `packages/test-vectors/crypto` (also used by the `keys` tests).
#[cfg(test)]
pub(crate) mod test_vectors {
    use serde_json::Value;

    pub fn load(name: &str) -> Value {
        let path = format!("{}/../../../packages/test-vectors/crypto/{name}", env!("CARGO_MANIFEST_DIR"));
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
        serde_json::from_str(&text).expect("vector JSON")
    }

    pub fn bytes(value: &Value) -> Vec<u8> {
        hex::decode(value.as_str().expect("hex string")).expect("valid hex")
    }

    pub fn array<const N: usize>(value: &Value) -> [u8; N] {
        bytes(value).try_into().expect("length")
    }

    pub fn number(value: &Value) -> usize {
        usize::try_from(value.as_u64().expect("number")).expect("fits in usize")
    }

    pub fn text(value: &Value) -> &str {
        value.as_str().expect("string")
    }

    pub fn items(value: &Value) -> &Vec<Value> {
        value.as_array().expect("list")
    }
}

// `pub(crate)` so the `mail` tests can seal real envelopes with `seal`.
#[cfg(test)]
pub(crate) mod tests {
    use super::test_vectors::{array, bytes, items, load, number, text};
    use super::*;
    use serde_json::Value;
    use sha2::{Digest, Sha256};

    // --- Sealing with a given ephemeral key and nonce, to reproduce `seal` (README §1.4) ---

    pub(crate) struct Sealed {
        pub(crate) envelope: Vec<u8>,
        shared: [u8; 32],
        key: [u8; 32],
    }

    /// The production sealing plus its intermediate values, which the vectors also carry.
    fn seal_padded_with_secrets(
        recipient: [u8; 32],
        padded: Vec<u8>,
        ephemeral: [u8; 32],
        nonce: &[u8],
    ) -> Option<Sealed> {
        let envelope = seal_padded(&recipient, Zeroizing::new(padded), &ephemeral, nonce.try_into().ok()?).ok()?;
        let secret = StaticSecret::from(ephemeral);
        let shared = secret.diffie_hellman(&PublicKey::from(recipient));
        let key = mailbox_key(shared.as_bytes(), PublicKey::from(&secret).as_bytes(), &recipient);
        Some(Sealed { envelope, shared: *shared.as_bytes(), key: *key })
    }

    pub(crate) fn seal(recipient: [u8; 32], message: &[u8], ephemeral: [u8; 32], nonce: &[u8]) -> Option<Sealed> {
        seal_padded_with_secrets(recipient, pad(message).ok()?.to_vec(), ephemeral, nonce)
    }

    fn open(secret: &Value, envelope: &[u8]) -> Option<Vec<u8>> {
        open_envelope(&array(secret), envelope).ok().map(|m| m.to_vec())
    }

    /// `plaintext` in hex, or `plaintextLength` bytes where byte `i` is `i mod 251`.
    fn seal_message(v: &Value) -> Vec<u8> {
        match v.get("plaintext") {
            Some(p) => bytes(p),
            None => (0..number(&v["plaintextLength"])).map(|i| u8::try_from(i % 251).unwrap()).collect(),
        }
    }

    // --- mailbox.json ---

    #[test]
    fn mailbox_constants_match() {
        let c = &load("mailbox.json")["constants"];
        assert_eq!(number(&c["maxEnvelopeLength"]), MAX_ENVELOPE_LENGTH);
        assert_eq!(number(&c["maxPlaintextLength"]), MAX_BUCKET - 4);
        assert_eq!(number(&c["headerLength"]), ENVELOPE_PREFIX_LENGTH);
        assert_eq!(text(&c["domain"]).as_bytes(), MAILBOX_DOMAIN);
    }

    #[test]
    fn mailbox_kdf_vectors() {
        for v in items(&load("mailbox.json")["kdf"]) {
            let (eph, rcpt) = (array(&v["ephemeralPublicKey"]), array(&v["recipientPublicKey"]));
            assert_eq!([MAILBOX_DOMAIN, &eph, &rcpt].concat(), bytes(&v["info"]));
            assert_eq!(mailbox_key(&array(&v["sharedSecret"]), &eph, &rcpt).to_vec(), bytes(&v["key"]));
        }
    }

    #[test]
    fn mailbox_padding_vectors() {
        for v in items(&load("mailbox.json")["padding"]) {
            let bucket = bucket_for(number(&v["plaintextLength"]));
            assert_eq!(bucket, number(&v["bucket"]));
            assert_eq!(bucket + ENVELOPE_PREFIX_LENGTH, number(&v["envelopeLength"]));
        }
    }

    fn check_seal_vector(v: &Value, recipient: &Value) {
        let name = text(&v["name"]);
        let message = seal_message(v);
        let sealed =
            seal(array(&recipient["publicKey"]), &message, array(&v["ephemeralSecretKey"]), &bytes(&v["nonce"]))
                .unwrap_or_else(|| panic!("{name}: does not seal"));
        let envelope = &sealed.envelope;
        assert_eq!(sealed.shared.to_vec(), bytes(&v["sharedSecret"]), "{name}");
        assert_eq!(sealed.key.to_vec(), bytes(&v["key"]), "{name}");
        assert_eq!(envelope[2..34].to_vec(), bytes(&v["ephemeralPublicKey"]), "{name}");
        assert_eq!(envelope.len(), number(&v["envelopeLength"]), "{name}");
        assert_eq!(Sha256::digest(envelope).to_vec(), bytes(&v["envelopeSha256"]), "{name}");
        if let Some(expected) = v.get("envelope") {
            assert_eq!(*envelope, bytes(expected), "{name}");
        }
        assert_eq!(open(&recipient["secretKey"], envelope), Some(message), "{name}: open");
    }

    #[test]
    fn mailbox_seal_vectors_and_open_them() {
        let vectors = load("mailbox.json");
        let recipient = &vectors["recipient"];
        let secret = StaticSecret::from(array::<32>(&recipient["secretKey"]));
        assert_eq!(PublicKey::from(&secret).as_bytes(), &array::<32>(&recipient["publicKey"]));
        for v in items(&vectors["seal"]) {
            check_seal_vector(v, recipient);
        }
    }

    #[test]
    fn mailbox_open_vectors() {
        for v in items(&load("mailbox.json")["open"]) {
            assert_eq!(
                open(&v["recipientSecretKey"], &bytes(&v["envelope"])),
                Some(bytes(&v["plaintext"])),
                "{}",
                v["name"]
            );
        }
    }

    #[test]
    fn mailbox_open_failures_are_one_error() {
        for v in items(&load("mailbox.json")["openFailures"]) {
            let result = open_envelope(&array(&v["recipientSecretKey"]), &bytes(&v["envelope"]));
            assert_eq!(result.err(), Some(EnvelopeError), "{}", v["name"]);
        }
    }

    /// Low-order envelopes with a valid tag are only stopped by the shared-secret check: with the key derived from
    /// an all-zero secret, the tag verifies.
    #[test]
    fn mailbox_low_order_with_valid_tag_is_rejected_by_the_zero_check() {
        let vectors = load("mailbox.json");
        let recipient = array(&vectors["recipient"]["publicKey"]);
        let low_order: Vec<[u8; 32]> =
            items(&vectors["sealFailures"]["lowOrderRecipientPublicKeys"]).iter().map(array).collect();
        // Selected by content, not by name: low-order ephemeral key and a tag valid under the all-zero secret.
        let tag_valid_with_zero_secret = |envelope: &[u8]| {
            let Some(parts) = EnvelopeParts::parse(envelope) else { return false };
            let key = mailbox_key(&[0; 32], &parts.ephemeral, &recipient);
            let mut padded = parts.ciphertext.to_vec();
            let cipher = Aes256Gcm::new_from_slice(key.as_ref()).unwrap();
            let (nonce, tag) = (Nonce::from_slice(parts.nonce), Tag::from_slice(parts.tag));
            low_order.contains(&parts.ephemeral)
                && cipher.decrypt_in_place_detached(nonce, &ENVELOPE_HEADER, &mut padded, tag).is_ok()
        };
        let forged: Vec<_> = items(&vectors["openFailures"])
            .iter()
            .filter(|v| tag_valid_with_zero_secret(&bytes(&v["envelope"])))
            .collect();
        assert_eq!(forged.len(), low_order.len());
        for v in forged {
            assert_eq!(
                open_envelope(&array(&v["recipientSecretKey"]), &bytes(&v["envelope"])).err(),
                Some(EnvelopeError)
            );
        }
    }

    #[test]
    fn mailbox_oversized_envelope_is_rejected_by_length() {
        let vectors = load("mailbox.json");
        let v = &vectors["openFailureOversized"];
        let padded = vec![0u8; number(&v["paddedLength"])];
        let recipient = array(&vectors["recipient"]["publicKey"]);
        let sealed =
            seal_padded_with_secrets(recipient, padded, array(&v["ephemeralSecretKey"]), &bytes(&v["nonce"])).unwrap();
        assert_eq!(sealed.envelope.len(), MAX_ENVELOPE_LENGTH + 1);
        assert_eq!(Sha256::digest(&sealed.envelope).to_vec(), bytes(&v["envelopeSha256"]));
        assert_eq!(open(&v["recipientSecretKey"], &sealed.envelope), None);
    }

    #[test]
    fn mailbox_seal_failures() {
        let vectors = load("mailbox.json");
        let failures = &vectors["sealFailures"];
        let recipient = array(&vectors["recipient"]["publicKey"]);
        let too_large = vec![0u8; number(&failures["plaintextLengthTooLarge"])];
        assert!(seal(recipient, &too_large, [7; 32], &[0; 12]).is_none());
        let keys = items(&failures["lowOrderRecipientPublicKeys"])
            .iter()
            .chain(items(&failures["nonCanonicalRecipientPublicKeys"]));
        for k in keys {
            assert!(seal(array(k), b"x", [7; 32], &[0; 12]).is_none(), "{k}");
            assert_eq!(seal_envelope(&array(k), b"x"), Err(SealError), "{k}");
            assert!(!is_usable_mailbox_public_key(&array(k)), "{k}");
        }
        assert!(is_usable_mailbox_public_key(&recipient));
        assert_eq!(seal_envelope(&recipient, &too_large), Err(SealError));
    }

    #[test]
    fn seal_envelope_uses_fresh_randomness_and_opens() {
        let vectors = load("mailbox.json");
        let recipient = &vectors["recipient"];
        let public = array(&recipient["publicKey"]);
        let (a, b) = (seal_envelope(&public, b"hola").unwrap(), seal_envelope(&public, b"hola").unwrap());
        assert_ne!(a[2..46], b[2..46], "ephemeral key and nonce");
        assert_eq!(a.len(), ENVELOPE_PREFIX_LENGTH + MIN_BUCKET);
        assert_eq!(open(&recipient["secretKey"], &a), Some(b"hola".to_vec()));
        assert_eq!(open(&recipient["secretKey"], &b), Some(b"hola".to_vec()));
    }

    #[test]
    fn usable_auth_keys_match_the_server_rule() {
        let vectors = load("request-auth.json");
        assert!(is_usable_auth_public_key(&array(&vectors["auth"]["publicKey"])));
        for k in items(&vectors["lowOrderPublicKeys"]) {
            assert!(!is_usable_auth_public_key(&array(k)), "{k}");
        }
        // y = p (non-canonical) and y = 2^255 − 1, with and without the sign bit.
        let mut p = [0xff; 32];
        p[0] = 0xed;
        p[31] = 0x7f;
        for key in [p, [0xff; 32]] {
            let mut negative = key;
            negative[31] |= 0x80;
            assert!(!is_usable_auth_public_key(&key) && !is_usable_auth_public_key(&negative));
        }
    }

    #[test]
    fn mailbox_short_envelopes_are_rejected() {
        let secret = [1u8; 32];
        for length in [0, 1, 2, 61] {
            assert_eq!(open_envelope(&secret, &vec![1u8; length]).err(), Some(EnvelopeError), "{length}");
        }
    }

    #[test]
    fn unpad_rejects_short_or_inconsistent_padding() {
        assert_eq!(unpad(&[0, 0, 0]), None);
        assert_eq!(unpad(&[0, 0, 0, 2, 9]), None);
        assert_eq!(unpad(&[0, 0, 0, 1, 9, 0]), Some(&[9u8][..]));
        assert_eq!(unpad(&[0, 0, 0, 0]), Some(&[][..]));
    }

    // --- request-auth.json ---

    /// A request from the JSON, or `None` if it cannot be represented by the types (version 256, lengths…).
    fn request_from(v: &Value) -> Option<MailboxRequest<'_>> {
        Some(MailboxRequest {
            host: v["host"].as_str()?,
            version: u8::try_from(v["version"].as_u64()?).ok()?,
            method: v["method"].as_str()?,
            path: v["path"].as_str()?,
            addr_key: hex::decode(v["addrKey"].as_str()?).ok()?.try_into().ok()?,
            timestamp: v["timestamp"].as_u64()?,
            nonce: hex::decode(v["nonce"].as_str()?).ok()?.try_into().ok()?,
        })
    }

    /// Header names are case-insensitive; the JSON uses lowercase.
    fn check_valid_request(v: &Value, seed: &[u8; 32]) {
        let name = &v["name"];
        let request = request_from(&v["request"]).unwrap();
        assert_eq!(encode_request(&request).unwrap(), bytes(&v["message"]), "{name}: message");
        let headers = sign_request(seed, &request).unwrap();
        assert_eq!(headers.signature, text(&v["signature"]), "{name}: signature");
        for (header, value) in headers.pairs() {
            assert_eq!(value, text(&v["headers"][header.to_ascii_lowercase()]), "{name}: {header}");
        }
    }

    #[test]
    fn request_valid_vectors_message_signature_and_headers() {
        let vectors = load("request-auth.json");
        let seed = array(&vectors["auth"]["secretKey"]);
        let c = &vectors["constants"];
        let names = [TIMESTAMP_HEADER, NONCE_HEADER, SIGNATURE_HEADER].map(str::to_ascii_lowercase);
        assert_eq!(
            names,
            [&c["timestampHeader"], &c["nonceHeader"], &c["signatureHeader"]].map(|n| text(n).to_owned())
        );
        assert_eq!(
            SigningKey::from_bytes(&seed).verifying_key().to_bytes(),
            array::<32>(&vectors["auth"]["publicKey"])
        );
        for v in items(&vectors["valid"]) {
            check_valid_request(v, &seed);
        }
    }

    #[test]
    fn request_rejected_vectors_are_not_signed() {
        let vectors = load("request-auth.json");
        for v in items(&vectors["rejectedRequests"]) {
            let rejected = request_from(&v["request"]).is_none_or(|r| sign_request(&[1; 32], &r).is_err());
            assert!(rejected, "{}", v["name"]);
            // The reason names the offending field: putting that field back from a valid request makes it signable.
            let mut repaired = v["request"].clone();
            let field = text(&v["field"]);
            repaired[field] = vectors["valid"][0]["request"][field].clone();
            let signable = request_from(&repaired).is_some_and(|r| sign_request(&[1; 32], &r).is_ok());
            assert!(signable, "{}: the rejection is not due to `{field}`", v["name"]);
        }
    }

    #[test]
    fn request_timestamp_above_2_pow_53_is_not_signed() {
        let vectors = load("request-auth.json");
        let mut request = request_from(&vectors["valid"][0]["request"]).unwrap();
        request.timestamp = MAX_TIMESTAMP;
        assert!(encode_request(&request).is_ok());
        request.timestamp = MAX_TIMESTAMP + 1;
        assert_eq!(encode_request(&request), Err(RequestError));
    }

    #[test]
    fn request_hosts_from_base_url() {
        let vectors = load("request-auth.json");
        for v in items(&vectors["hosts"]) {
            assert_eq!(canonical_host(text(&v["baseUrl"])).as_deref(), Ok(text(&v["host"])), "{}", v["baseUrl"]);
        }
        for v in items(&vectors["rejectedBaseUrls"]) {
            assert_eq!(canonical_host(text(v)), Err(RequestError), "{v}");
        }
        assert_eq!(canonical_host("ftp://nightmail.local"), Err(RequestError));
        assert_eq!(canonical_host("no es una url"), Err(RequestError));
    }

    // --- name-cipher.json ---

    #[test]
    fn name_cipher_vectors_seal_and_open() {
        let vectors = load("name-cipher.json");
        let (key, slot) = (array(&vectors["key"]), array(&vectors["slotNul"]));
        assert_eq!(number(&vectors["constants"]["length"]), NAME_CIPHER_LENGTH);
        for v in items(&vectors["names"]) {
            let sealed = seal_name_with_nonce(&key, &slot, text(&v["name"]), array(&v["nonce"])).unwrap();
            assert_eq!(sealed.to_vec(), bytes(&v["nameCipher"]), "{}", v["name"]);
            assert_eq!(open_name(&key, &slot, &sealed).as_deref(), Ok(text(&v["name"])));
        }
    }

    #[test]
    fn name_cipher_open_failures_are_one_error() {
        let vectors = load("name-cipher.json");
        let key = array(&vectors["key"]);
        for v in items(&vectors["openFailures"]) {
            let result = open_name(&key, &array(&v["slotNul"]), &array(&v["nameCipher"]));
            assert_eq!(result, Err(NameCipherError), "{}", v["name"]);
        }
        assert_eq!(open_name(&key, &[0; 32], &ALIAS_NAME_CIPHER), Err(NameCipherError));
    }

    #[test]
    fn name_cipher_with_another_key_is_the_same_error() {
        let vectors = load("name-cipher.json");
        let mut other_key = array::<32>(&vectors["key"]);
        other_key[0] ^= 1;
        let sealed = array(&vectors["names"][0]["nameCipher"]);
        assert_eq!(open_name(&other_key, &array(&vectors["slotNul"]), &sealed), Err(NameCipherError));
    }

    #[test]
    fn name_cipher_seal_failures() {
        let f = &load("name-cipher.json")["sealFailures"];
        for name in [text(&f["tooLong"]), text(&f["empty"]), text(&f["withNul"])] {
            assert_eq!(seal_name(&[1; 32], &[2; 32], name), Err(NameCipherError), "{name:?}");
        }
    }

    #[test]
    fn name_cipher_uses_a_fresh_nonce() {
        let (a, b) = (seal_name(&[1; 32], &[2; 32], "alice").unwrap(), seal_name(&[1; 32], &[2; 32], "alice").unwrap());
        assert_ne!(a[..NAME_NONCE_LENGTH], b[..NAME_NONCE_LENGTH]);
        assert_eq!(open_name(&[1; 32], &[2; 32], &a).as_deref(), Ok("alice"));
    }

    #[test]
    fn errors_have_fixed_messages() {
        assert_eq!(EnvelopeError.to_string(), "invalid envelope");
        assert_eq!(RequestError.to_string(), "unsignable mailbox request");
        assert_eq!(NameCipherError.to_string(), "invalid encrypted name");
        assert_eq!(SealError.to_string(), "cannot seal envelope");
    }
}
