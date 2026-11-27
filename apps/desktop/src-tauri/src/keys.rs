//! KeyManager: BIP39 phrase, `master`, labelled HKDF derivation and the encrypted seed file.
//!
//! Exact specification in `packages/test-vectors/crypto/README.md` §3; vectors in `keys.json`.
//! - `master` = BIP39 seed (empty passphrase), 64 bytes.
//! - `derive(label)` = HKDF-SHA256(empty salt, `master`, `"nightmail/v1/" ‖ label`, 32). Labels only come from
//!   [`Label`], so callers cannot request arbitrary ones.
//! - `seed.v1`: the entropy (not the words) encrypted with AES-256-GCM under an Argon2id key from the password.
//! - `attempts.v1`: the failed password counter and the wait it imposes (see "Failed attempts" below).
//!
//! Known limit (README §3.6): the crates make internal copies that are not wiped (bip39's PBKDF2, hkdf's HMAC, NFKD
//! normalisation) and memory is not locked (`mlock`). Everything owned by this module is wiped.
//! Argon2id is slow (64 MiB, t = 3): async callers must use `spawn_blocking`.
#![allow(dead_code)]

use std::fmt;
use std::fs;
use std::io::{self, Read, Write};
use std::path::Path;
use std::time::{Duration, SystemTime};

use aes_gcm::aead::{AeadInPlace, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Block, Params, Version};
use bip39::{Language, Mnemonic};
use ed25519_dalek::SigningKey;
use hkdf::Hkdf;
use serde::Deserialize;
use sha2::Sha256;
use unicode_normalization::UnicodeNormalization;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::{Zeroize, Zeroizing};

use crate::crypto::{fill_random, random_bytes};
use crate::fsutil;
use crate::protocol::AddressKind;

pub const SEED_FILE_NAME: &str = "seed.v1";
const LABEL_PREFIX: &str = "nightmail/v1/";
const SEED_FILE_DOMAIN: &str = "nightmail:seed-file:v1";
const WORD_COUNT: usize = 24;
/// English words have at most 8 letters, so with spaces the phrase fits without reallocating.
const PHRASE_CAPACITY: usize = WORD_COUNT * 9;
/// A canonical `seed.v1` is a little over 250 bytes; anything larger is not read in full.
const MAX_SEED_FILE_LENGTH: usize = 1024;
/// A temp file older than this comes from an interrupted write; swept on create, password change and unlock.
const STALE_TEMPORARY_AGE: Duration = Duration::from_secs(60);

// ---------- Errors ----------

/// [`KeyManager`] errors with fixed messages. `Locked` covers wrong password, tampered or malformed file and
/// out-of-bounds parameters: the caller cannot tell them apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyError {
    Locked,
    Missing,
    Exists,
    InvalidPhrase,
    EmptyPassword,
    /// The file is a symlink or more open than 0600.
    Permissions,
    /// Not enough memory for Argon2id.
    Memory,
    Io,
    /// Too many consecutive failures: wait `wait_secs` before the next attempt (see "Failed attempts").
    TooManyAttempts { wait_secs: u32 },
}

impl fmt::Display for KeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Locked => "wrong password or damaged seed file",
            Self::Missing => "no seed file",
            Self::Exists => "a seed file already exists",
            Self::InvalidPhrase => "the recovery phrase is not valid",
            Self::EmptyPassword => "the password is empty",
            Self::Permissions => "the seed file or folder is not private",
            Self::Memory => "not enough memory to open the seed",
            Self::Io => "could not read or write the seed file",
            Self::TooManyAttempts { .. } => "too many failed attempts: wait before retrying",
        })
    }
}

impl std::error::Error for KeyError {}

/// Insecure permissions (as flagged by `fsutil`) map to `Permissions`, the `expected` kind to its error, and
/// everything else (including any other `PermissionDenied`) to I/O.
fn io_error(error: &io::Error, expected: io::ErrorKind, as_error: KeyError) -> KeyError {
    if fsutil::is_insecure(error) {
        KeyError::Permissions
    } else if error.kind() == expected {
        as_error
    } else {
        KeyError::Io
    }
}

fn read_error(error: io::Error) -> KeyError {
    io_error(&error, io::ErrorKind::NotFound, KeyError::Missing)
}

/// When writing, `NotFound` (directory removed midway) is not "no seed" but an I/O failure.
fn write_error(error: io::Error) -> KeyError {
    io_error(&error, io::ErrorKind::AlreadyExists, KeyError::Exists)
}

// ---------- Labels and derivation ----------

/// `derive` labels (README §3.2). n = bono, j = slot.
enum Label {
    Bono(u32),
    AddressEnc(u32, AddressKind, u8),
    AddressAuth(u32, AddressKind, u8),
    Names,
    Wallet,
    WalletState,
    Db,
}

fn kind_text(kind: AddressKind) -> &'static str {
    match kind {
        AddressKind::Mailbox => "mailbox",
        AddressKind::Alias => "alias",
    }
}

impl Label {
    fn text(&self) -> String {
        match self {
            Self::Bono(n) => format!("bono/{n}"),
            Self::AddressEnc(n, kind, j) => format!("addr/{n}/{}/{j}/enc", kind_text(*kind)),
            Self::AddressAuth(n, kind, j) => format!("addr/{n}/{}/{j}/auth", kind_text(*kind)),
            Self::Names => "names".into(),
            Self::Wallet => "wallet".into(),
            Self::WalletState => "wallet-state".into(),
            Self::Db => "db".into(),
        }
    }
}

/// Keys of the address in slot (n, kind, j): X25519 for the mailbox and Ed25519 for signing requests.
pub struct AddressKeys {
    pub enc_secret: Zeroizing<[u8; 32]>,
    pub enc_public: [u8; 32],
    pub auth_seed: Zeroizing<[u8; 32]>,
    pub auth_public: [u8; 32],
}

impl fmt::Debug for AddressKeys {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AddressKeys")
            .field("enc_public", &hex::encode(self.enc_public))
            .field("auth_public", &hex::encode(self.auth_public))
            .finish_non_exhaustive()
    }
}

/// Owns the `master`. Only created by opening, creating or restoring the seed file. The `master` lives on the heap
/// so moving the `KeyManager` leaves no copies on the stack.
pub struct KeyManager {
    master: Box<Zeroizing<[u8; 64]>>,
}

impl fmt::Debug for KeyManager {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("KeyManager(<redacted>)")
    }
}

impl KeyManager {
    fn from_mnemonic(mnemonic: &Mnemonic) -> Self {
        let mut master = Box::new(Zeroizing::new([0u8; 64]));
        let mut seed = mnemonic.to_seed_normalized("");
        master.copy_from_slice(&seed);
        seed.zeroize();
        Self { master }
    }

    fn derive(&self, label: &Label) -> Zeroizing<[u8; 32]> {
        let info = format!("{LABEL_PREFIX}{}", label.text());
        let mut out = Zeroizing::new([0u8; 32]);
        Hkdf::<Sha256>::new(None, &self.master[..])
            .expand(info.as_bytes(), out.as_mut())
            .expect("32 bytes fit in HKDF-SHA256");
        out
    }

    /// `s` of bono n.
    pub fn bono_secret(&self, n: u32) -> Zeroizing<[u8; 32]> {
        self.derive(&Label::Bono(n))
    }

    pub fn address_keys(&self, n: u32, kind: AddressKind, j: u8) -> AddressKeys {
        let enc_secret = self.derive(&Label::AddressEnc(n, kind, j));
        let auth_seed = self.derive(&Label::AddressAuth(n, kind, j));
        let enc_public = PublicKey::from(&StaticSecret::from(*enc_secret)).to_bytes();
        let auth_public = SigningKey::from_bytes(&auth_seed).verifying_key().to_bytes();
        AddressKeys { enc_secret, enc_public, auth_seed, auth_public }
    }

    /// XChaCha20-Poly1305 key for `nameCipher`.
    pub fn names_key(&self) -> Zeroizing<[u8; 32]> {
        self.derive(&Label::Names)
    }

    /// Seed of the embedded wallet (`wallet.open.seed`).
    pub fn wallet_seed(&self) -> Zeroizing<[u8; 32]> {
        self.derive(&Label::Wallet)
    }

    /// `stateKey` of the wallet's encrypted state (`wallet.open.stateKey`).
    pub fn wallet_state_key(&self) -> Zeroizing<[u8; 32]> {
        self.derive(&Label::WalletState)
    }

    /// SQLCipher key.
    pub fn db_key(&self) -> Zeroizing<[u8; 32]> {
        self.derive(&Label::Db)
    }
}

// ---------- BIP39 phrase ----------

/// 24 English words with a valid checksum. Uppercase is accepted (provisional choice): it is lowered to ASCII
/// lowercase in a copy that is wiped.
fn parse_phrase(phrase: &str) -> Result<Mnemonic, KeyError> {
    let mut lower = Zeroizing::new(String::with_capacity(phrase.len()));
    lower.extend(phrase.chars().map(|c| c.to_ascii_lowercase()));
    let mnemonic = Mnemonic::parse_in(Language::English, lower.as_str()).map_err(|_| KeyError::InvalidPhrase)?;
    if mnemonic.word_count() == WORD_COUNT { Ok(mnemonic) } else { Err(KeyError::InvalidPhrase) }
}

/// Validates a recovery phrase without touching any file (for the UI).
pub fn validate_phrase(phrase: &str) -> Result<(), KeyError> {
    parse_phrase(phrase).map(drop)
}

fn mnemonic_from(entropy: &[u8; 32]) -> Mnemonic {
    Mnemonic::from_entropy_in(Language::English, entropy).expect("32 bytes are valid BIP39 entropy")
}

fn entropy_of(mnemonic: &Mnemonic) -> Zeroizing<[u8; 32]> {
    let (mut array, length) = mnemonic.to_entropy_array();
    let mut entropy = Zeroizing::new([0u8; 32]);
    entropy.copy_from_slice(&array[..length]);
    array.zeroize();
    entropy
}

/// The phrase in a buffer allocated once, so no prefixes are left behind in reallocated buffers.
fn phrase_of(mnemonic: &Mnemonic) -> Zeroizing<String> {
    let mut phrase = Zeroizing::new(String::with_capacity(PHRASE_CAPACITY));
    for (i, word) in mnemonic.words().enumerate() {
        if i > 0 {
            phrase.push(' ');
        }
        phrase.push_str(word);
    }
    phrase
}

// ---------- Argon2id ----------

/// Argon2id parameters: memory in KiB, passes and threads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct KdfParams {
    m: u32,
    t: u32,
    p: u32,
}

/// Parameters used for writing and accepted when opening. Tests use a fast policy.
#[derive(Debug, Clone, Copy)]
pub(crate) struct KdfPolicy {
    write: KdfParams,
    minimum: KdfParams,
}

/// Writes m = 64 MiB, t = 3, p = 1; refuses to open with less than 19 MiB or fewer than 2 passes.
pub(crate) const PRODUCTION: KdfPolicy =
    KdfPolicy { write: KdfParams { m: 65536, t: 3, p: 1 }, minimum: KdfParams { m: 19456, t: 2, p: 1 } };
/// Sanity cap when opening: 256 MiB of memory, 16 passes and 16 threads.
const MAXIMUM: KdfParams = KdfParams { m: 262_144, t: 16, p: 16 };

impl KdfPolicy {
    fn accepts(&self, kdf: KdfParams) -> bool {
        let within = |value: u32, min: u32, max: u32| (min..=max).contains(&value);
        within(kdf.m, self.minimum.m, MAXIMUM.m)
            && within(kdf.t, self.minimum.t, MAXIMUM.t)
            && within(kdf.p, self.minimum.p, MAXIMUM.p)
    }
}

/// The password in NFC (provisional choice), so the same password typed in another Unicode form still opens.
/// NFC grows at most ×3 in UTF-8, so the buffer is never reallocated.
fn normalized_password(password: &str) -> Zeroizing<String> {
    let mut normalized = Zeroizing::new(String::with_capacity(password.len() * 3));
    normalized.extend(password.nfc());
    normalized
}

/// Argon2id working memory: fallible allocation (failure is `Memory`), wiped on drop.
fn argon2_memory(params: &Params) -> Result<Zeroizing<Vec<Block>>, KeyError> {
    let mut memory = Zeroizing::new(Vec::new());
    memory.try_reserve_exact(params.block_count()).map_err(|_| KeyError::Memory)?;
    memory.resize(params.block_count(), Block::default());
    Ok(memory)
}

fn argon2_key(password: &str, salt: &[u8; 16], kdf: KdfParams) -> Result<Zeroizing<[u8; 32]>, KeyError> {
    let params = Params::new(kdf.m, kdf.t, kdf.p, Some(32)).map_err(|_| KeyError::Locked)?;
    let mut memory = argon2_memory(&params)?;
    let password = normalized_password(password);
    let mut key = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into_with_memory(password.as_bytes(), salt, key.as_mut(), memory.as_mut_slice())
        .map_err(|_| KeyError::Locked)?;
    Ok(key)
}

fn aes_key(key: &[u8; 32]) -> Aes256Gcm {
    Aes256Gcm::new_from_slice(key).expect("32-byte key")
}

// ---------- Seed file (seed.v1) ----------

/// Canonical JSON of the parameters (no spaces, this order); it goes into the AAD.
fn canonical_params(kdf: KdfParams, salt: &[u8; 16], nonce: &[u8; 12]) -> String {
    format!(
        r#"{{"version":1,"kdf":"argon2id","m":{},"t":{},"p":{},"salt":"{}","nonce":"{}"}}"#,
        kdf.m,
        kdf.t,
        kdf.p,
        hex::encode(salt),
        hex::encode(nonce)
    )
}

/// The whole file in canonical form: parameters plus `ciphertext`. Written only this way and opened only this way.
fn canonical_file(kdf: KdfParams, salt: &[u8; 16], nonce: &[u8; 12], ciphertext: &[u8]) -> String {
    let params = canonical_params(kdf, salt, nonce);
    let open = params.strip_suffix('}').expect("JSON object");
    format!(r#"{open},"ciphertext":"{}"}}"#, hex::encode(ciphertext))
}

fn seed_file_aad(kdf: KdfParams, salt: &[u8; 16], nonce: &[u8; 12]) -> Vec<u8> {
    [SEED_FILE_DOMAIN.as_bytes(), canonical_params(kdf, salt, nonce).as_bytes()].concat()
}

/// File text: `ciphertext` = entropy (32) ‖ tag (16).
fn seal_entropy(
    entropy: &[u8; 32],
    password: &str,
    kdf: KdfParams,
    salt: [u8; 16],
    nonce: [u8; 12],
) -> Result<String, KeyError> {
    let key = argon2_key(password, &salt, kdf)?;
    let mut buffer = Zeroizing::new(Vec::with_capacity(48));
    buffer.extend_from_slice(entropy);
    aes_key(&key)
        .encrypt_in_place(Nonce::from_slice(&nonce), &seed_file_aad(kdf, &salt, &nonce), &mut *buffer)
        .map_err(|_| KeyError::Io)?;
    Ok(canonical_file(kdf, &salt, &nonce, &buffer))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SeedFile {
    version: u32,
    kdf: String,
    m: u32,
    t: u32,
    p: u32,
    salt: String,
    nonce: String,
    ciphertext: String,
}

/// Already validated fields of a seed file.
struct SealedSeed {
    kdf: KdfParams,
    salt: [u8; 16],
    nonce: [u8; 12],
    ciphertext: [u8; 48],
}

fn hex_array<const N: usize>(text: &str) -> Option<[u8; N]> {
    hex::decode(text).ok()?.try_into().ok()
}

impl SeedFile {
    fn check(self, policy: &KdfPolicy) -> Option<SealedSeed> {
        let kdf = KdfParams { m: self.m, t: self.t, p: self.p };
        if self.version != 1 || self.kdf != "argon2id" || !policy.accepts(kdf) {
            return None;
        }
        Some(SealedSeed {
            kdf,
            salt: hex_array(&self.salt)?,
            nonce: hex_array(&self.nonce)?,
            ciphertext: hex_array(&self.ciphertext)?,
        })
    }
}

/// File fields, only if it is exactly canonical (no spaces, fixed order, lowercase hex, no repeated or extra
/// fields).
fn parse_seed_file(text: &str, policy: &KdfPolicy) -> Option<SealedSeed> {
    let sealed = serde_json::from_str::<SeedFile>(text).ok()?.check(policy)?;
    let canonical = canonical_file(sealed.kdf, &sealed.salt, &sealed.nonce, &sealed.ciphertext);
    (canonical == text).then_some(sealed)
}

fn open_entropy(text: &str, password: &str, policy: &KdfPolicy) -> Result<Zeroizing<[u8; 32]>, KeyError> {
    let sealed = parse_seed_file(text, policy).ok_or(KeyError::Locked)?;
    let key = argon2_key(password, &sealed.salt, sealed.kdf)?;
    let aad = seed_file_aad(sealed.kdf, &sealed.salt, &sealed.nonce);
    let mut buffer = Zeroizing::new(sealed.ciphertext.to_vec());
    aes_key(&key)
        .decrypt_in_place(Nonce::from_slice(&sealed.nonce), &aad, &mut *buffer)
        .map_err(|_| KeyError::Locked)?;
    let mut entropy = Zeroizing::new([0u8; 32]);
    entropy.copy_from_slice(&buffer);
    Ok(entropy)
}

// ---------- Disk ----------

/// Reads `seed.v1` under the `fsutil` policy (no symlink, nothing looser than 0600) with a size cap. A file that is
/// too large or not UTF-8 counts as damaged (`Locked`).
fn read_seed_file(path: &Path) -> Result<String, KeyError> {
    let file = fsutil::open_private_file(path).map_err(read_error)?;
    let mut bytes = Vec::new();
    let limit = u64::try_from(MAX_SEED_FILE_LENGTH + 1).expect("fits in u64");
    file.take(limit).read_to_end(&mut bytes).map_err(read_error)?;
    if bytes.len() > MAX_SEED_FILE_LENGTH {
        return Err(KeyError::Locked);
    }
    String::from_utf8(bytes).map_err(|_| KeyError::Locked)
}

fn create_new_private(path: &Path) -> io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path)
}

#[cfg(unix)]
fn sync_dir(dir: &Path) -> io::Result<()> {
    fs::File::open(dir)?.sync_all()
}

#[cfg(not(unix))]
fn sync_dir(_dir: &Path) -> io::Result<()> {
    Ok(())
}

fn write_temporary(path: &Path, contents: &[u8]) -> io::Result<()> {
    let mut file = create_new_private(path)?;
    file.write_all(contents)?;
    file.sync_all()
}

fn is_temporary_name(name: &str) -> bool {
    [SEED_FILE_NAME, ATTEMPTS_FILE_NAME].iter().any(|base| name.starts_with(&format!("{base}."))) && name.ends_with(".tmp")
}

fn is_stale(entry: &fs::DirEntry) -> bool {
    let modified = entry.metadata().and_then(|meta| meta.modified());
    modified.is_ok_and(|time| SystemTime::now().duration_since(time).is_ok_and(|age| age > STALE_TEMPORARY_AGE))
}

/// Deletes temp files left by interrupted writes. Only old ones: a recent one may belong to a write in progress.
/// Failures here do not matter.
fn sweep_stale_temporaries(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if entry.file_name().to_str().is_some_and(is_temporary_name) && is_stale(&entry) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn write_seed_file(dir: &Path, contents: &str) -> io::Result<()> {
    write_seed_file_with(dir, contents, sync_dir)
}

/// 0600 temp file + fsync, then `hard_link` rather than `rename`: equally atomic, but it fails if the target exists
/// (exclusive creation, never overwrites a seed). Once linked the seed is complete and synced, so removing the temp
/// file and syncing the directory are attempted but their failures are neither undone nor returned (a leftover temp
/// file is swept on the next create).
fn write_seed_file_with(dir: &Path, contents: &str, sync: fn(&Path) -> io::Result<()>) -> io::Result<()> {
    fsutil::ensure_private_dir(dir)?;
    sweep_stale_temporaries(dir);
    let temporary = dir.join(format!("{SEED_FILE_NAME}.{}.tmp", hex::encode(random_bytes::<8>())));
    let linked = write_temporary(&temporary, contents.as_bytes())
        .and_then(|()| fs::hard_link(&temporary, dir.join(SEED_FILE_NAME)));
    let _ = fs::remove_file(&temporary);
    linked?;
    let _ = sync(dir);
    Ok(())
}

/// Steps of [`replace_seed_file_with`] that tests replace to simulate crashes and failures.
struct ReplaceSteps {
    rename: fn(&Path, &Path) -> io::Result<()>,
    sync: fn(&Path) -> io::Result<()>,
}

fn rename_file(from: &Path, to: &Path) -> io::Result<()> {
    fs::rename(from, to)
}

const REPLACE_STEPS: ReplaceSteps = ReplaceSteps { rename: rename_file, sync: sync_dir };

/// The only path that replaces an existing `seed.v1` (password change); create and restore never overwrite.
/// 0600 temp file in the same directory + fsync; `check` re-reads and opens it before anything is touched; then an
/// atomic `rename` over `seed.v1` and a directory fsync. A crash at any point leaves either the old or the new file,
/// complete (an orphaned temp file is swept by the next unlock or write). No descriptor is open during the rename
/// (on Windows, renaming over an open file fails). If `check` or `rename` fail, the temp file is removed and
/// `seed.v1` is untouched. The directory fsync after the rename is attempted but not returned, as on create: the new
/// file is already in place and reporting "not changed" would be false.
fn replace_seed_file_with(
    dir: &Path,
    contents: &str,
    check: impl FnOnce(&Path) -> Result<(), KeyError>,
    steps: &ReplaceSteps,
) -> Result<(), KeyError> {
    fsutil::ensure_private_dir(dir).map_err(write_error)?;
    sweep_stale_temporaries(dir);
    let temporary = dir.join(format!("{SEED_FILE_NAME}.{}.tmp", hex::encode(random_bytes::<8>())));
    let replaced = write_temporary(&temporary, contents.as_bytes())
        .map_err(write_error)
        .and_then(|()| check(&temporary))
        .and_then(|()| (steps.rename)(&temporary, &dir.join(SEED_FILE_NAME)).map_err(write_error));
    if replaced.is_err() {
        let _ = fs::remove_file(&temporary);
        return replaced;
    }
    let _ = (steps.sync)(dir);
    Ok(())
}

// ---------- Failed attempts ----------
//
// Unlocking, revealing the phrase and changing the password share one counter of consecutive failures (wrong
// password or damaged file: `Locked`). The first 4 cost nothing; from the 5th on there is a wait before the next
// attempt: 30 s, doubling with each further failure, capped at 15 min. A success resets the counter. While a wait is
// pending, attempts are rejected without looking at the password (no Argon2id, no file read) and do not count.
//
// Stored in `attempts.v1` next to `seed.v1` (0600, temp file + fsync + `rename`) so restarting the app does not
// reset it. It holds the failure count and the Unix time (s) until which attempts are refused.
//
// Clock: the remaining wait never exceeds the full wait for that failure count. If the system clock goes backwards,
// the full wait restarts from now (and is stored that way): it never opens early, and never stays locked for the
// whole jump. Moving the clock forward does shorten the wait, but whoever can change the system time can also delete
// this file or copy `seed.v1` and guess offline. This only slows manual guessing in the app; Argon2id is what
// protects the seed against an attack on the file.

pub const ATTEMPTS_FILE_NAME: &str = "attempts.v1";
/// Consecutive failures that cost no wait.
const FREE_FAILURES: u32 = 4;
const FIRST_WAIT_SECS: u32 = 30;
const MAX_WAIT_SECS: u32 = 15 * 60;
/// One attempt at a time across the process, so two concurrent ones (unlock and reveal) cannot bypass the counter.
/// Also keeps an in-memory copy per directory: if `attempts.v1` could not be saved, the wait still applies for this
/// session (the stricter of memory and file is used).
static ATTEMPTS: std::sync::Mutex<std::collections::BTreeMap<std::path::PathBuf, Attempts>> =
    std::sync::Mutex::new(std::collections::BTreeMap::new());

fn attempts_memory() -> std::sync::MutexGuard<'static, std::collections::BTreeMap<std::path::PathBuf, Attempts>> {
    ATTEMPTS.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
struct Attempts {
    failures: u32,
    /// Unix time (s) until which every attempt is refused.
    until: u64,
}

/// Wait after `failures` consecutive failures: 0 up to 4; 30 s at 5; doubling with each more; capped at 15 min.
fn wait_after(failures: u32) -> u32 {
    if failures <= FREE_FAILURES {
        return 0;
    }
    let doublings = (failures - FREE_FAILURES - 1).min(16);
    (FIRST_WAIT_SECS << doublings).min(MAX_WAIT_SECS)
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// Format: `failures N\nuntil S\n`. Missing, unreadable or malformed counts as zero: whoever can corrupt it can also
/// delete it, and locking the user out over a broken file protects nothing.
fn read_attempts(path: &Path) -> Attempts {
    let mut text = String::new();
    let read = fsutil::open_private_file(path).and_then(|file| file.take(256).read_to_string(&mut text));
    if read.is_err() {
        return Attempts::default();
    }
    let mut lines = text.lines();
    let mut field = |name: &str| lines.next()?.strip_prefix(name)?.strip_prefix(' ')?.parse::<u64>().ok();
    match (field("failures"), field("until")) {
        (Some(failures), Some(until)) => Attempts { failures: u32::try_from(failures).unwrap_or(u32::MAX), until },
        _ => Attempts::default(),
    }
}

fn write_attempts(dir: &Path, attempts: Attempts) -> io::Result<()> {
    let temporary = dir.join(format!("{ATTEMPTS_FILE_NAME}.{}.tmp", hex::encode(random_bytes::<8>())));
    let text = format!("failures {}\nuntil {}\n", attempts.failures, attempts.until);
    let written = write_temporary(&temporary, text.as_bytes())
        .and_then(|()| fs::rename(&temporary, dir.join(ATTEMPTS_FILE_NAME)));
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
        return written;
    }
    let _ = sync_dir(dir);
    Ok(())
}

impl Attempts {
    /// The stricter of two copies (memory and file).
    fn stricter(self, other: Self) -> Self {
        Self { failures: self.failures.max(other.failures), until: self.until.max(other.until) }
    }
}

/// Saves to memory (`memory`, under the already held lock) and to `attempts.v1`.
fn save_attempts(
    memory: &mut std::collections::BTreeMap<std::path::PathBuf, Attempts>,
    dir: &Path,
    attempts: Attempts,
) {
    if attempts == Attempts::default() {
        memory.remove(dir);
    } else {
        memory.insert(dir.to_path_buf(), attempts);
    }
    // If it cannot be saved, the in-memory copy stays until the app closes.
    let saved = if attempts == Attempts::default() {
        match fs::remove_file(dir.join(ATTEMPTS_FILE_NAME)) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            other => other,
        }
    } else {
        write_attempts(dir, attempts)
    };
    if let Err(e) = saved {
        log::warn!("[keys] could not save the attempt counter: {e}");
    }
}

/// Runs `attempt` (which checks the password) unless a wait is pending, and keeps count. `now` returns Unix seconds.
/// Failures 1-4 return `Locked`; from the 5th on, `TooManyAttempts` with the new wait (which also means the password
/// was wrong). Other errors (no seed, memory, I/O) do not count.
fn throttled<T>(
    dir: &Path,
    now: &dyn Fn() -> u64,
    attempt: impl FnOnce() -> Result<T, KeyError>,
) -> Result<T, KeyError> {
    let mut memory = attempts_memory();
    let remembered = memory.get(dir).copied().unwrap_or_default();
    let mut state = read_attempts(&dir.join(ATTEMPTS_FILE_NAME)).stricter(remembered);
    let start = now();
    let full = u64::from(wait_after(state.failures));
    if state.until > start.saturating_add(full) {
        // The clock went backwards: the full wait restarts from now.
        state.until = start + full;
        save_attempts(&mut memory, dir, state);
    }
    let remaining = state.until.saturating_sub(start);
    if remaining > 0 {
        return Err(KeyError::TooManyAttempts { wait_secs: u32::try_from(remaining).unwrap_or(MAX_WAIT_SECS) });
    }
    let result = attempt();
    match &result {
        Ok(_) if state != Attempts::default() => save_attempts(&mut memory, dir, Attempts::default()),
        Err(KeyError::Locked) => {
            state.failures = state.failures.saturating_add(1);
            let wait = wait_after(state.failures);
            // Time taken after Argon2id: the wait counts from the response.
            state.until = now() + u64::from(wait);
            save_attempts(&mut memory, dir, state);
            if wait > 0 {
                return Err(KeyError::TooManyAttempts { wait_secs: wait });
            }
        }
        _ => {}
    }
    result
}

/// A new seed (create or restore) starts with no failures; those of a previous seed in the same directory do not
/// carry over.
fn reset_attempts(dir: &Path) {
    save_attempts(&mut attempts_memory(), dir, Attempts::default());
}

// ---------- Operations ----------

/// A new phrase not saved yet (creating a profile shows the words first and asks for the password afterwards). Only
/// its entropy, in memory: never written to disk until [`create`] seals it under the password. Wiped on drop.
pub struct Draft {
    entropy: Zeroizing<[u8; 32]>,
}

impl Draft {
    /// 24 new random words.
    pub fn new() -> Self {
        let mut entropy = Zeroizing::new([0u8; 32]);
        fill_random(entropy.as_mut());
        Self { entropy }
    }

    /// The words to show (each call builds a new wiped buffer).
    pub fn phrase(&self) -> Zeroizing<String> {
        phrase_of(&mnemonic_from(&self.entropy))
    }

    /// The same draft (the app keeps it until the password arrives and hands a copy to the blocking thread).
    pub fn duplicate(&self) -> Self {
        Self { entropy: self.entropy.clone() }
    }
}

impl Default for Draft {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for Draft {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Draft(..)")
    }
}

/// Result of the test shortcut [`create_with`]: a new seed already saved and its phrase.
#[cfg(test)]
pub struct Created {
    pub keys: KeyManager,
    pub phrase: Zeroizing<String>,
}

fn require_password(password: &str) -> Result<(), KeyError> {
    if password.is_empty() { Err(KeyError::EmptyPassword) } else { Ok(()) }
}

fn store(dir: &Path, mnemonic: &Mnemonic, password: &str, policy: &KdfPolicy) -> Result<KeyManager, KeyError> {
    require_password(password)?;
    if dir.join(SEED_FILE_NAME).exists() {
        return Err(KeyError::Exists);
    }
    let text = seal_entropy(&entropy_of(mnemonic), password, policy.write, random_bytes(), random_bytes())?;
    write_seed_file(dir, &text).map_err(write_error)?;
    reset_attempts(dir);
    Ok(KeyManager::from_mnemonic(mnemonic))
}

fn load(dir: &Path, password: &str, policy: &KdfPolicy) -> Result<Mnemonic, KeyError> {
    let text = read_seed_file(&dir.join(SEED_FILE_NAME))?;
    Ok(mnemonic_from(&*open_entropy(&text, password, policy)?))
}

pub(crate) fn create_from_draft_with(
    dir: &Path,
    draft: &Draft,
    password: &str,
    policy: &KdfPolicy,
) -> Result<KeyManager, KeyError> {
    store(dir, &mnemonic_from(&draft.entropy), password, policy)
}

/// Test shortcut: a new draft saved at once.
#[cfg(test)]
pub(crate) fn create_with(dir: &Path, password: &str, policy: &KdfPolicy) -> Result<Created, KeyError> {
    let draft = Draft::new();
    let keys = create_from_draft_with(dir, &draft, password, policy)?;
    Ok(Created { keys, phrase: draft.phrase() })
}

pub(crate) fn restore_with(
    dir: &Path,
    phrase: &str,
    password: &str,
    policy: &KdfPolicy,
) -> Result<KeyManager, KeyError> {
    store(dir, &parse_phrase(phrase)?, password, policy)
}

/// After opening, sweeps old temp files. One left by a crash during a password change is another sealed copy of the
/// same seed, under a password that may never have taken effect, so it must not linger until the next write (which
/// may never come). Only after opening: `seed.v1` has just proved valid, so whatever is removed is surely redundant.
pub(crate) fn unlock_with(dir: &Path, password: &str, policy: &KdfPolicy) -> Result<KeyManager, KeyError> {
    let mnemonic = throttled(dir, &unix_now, || load(dir, password, policy))?;
    let keys = KeyManager::from_mnemonic(&mnemonic);
    sweep_stale_temporaries(dir);
    Ok(keys)
}

/// Changes the password: opens `seed.v1` with the current one (checked against the file itself, not anything in
/// memory), seals the same entropy with the new one (fresh salt and nonce, the policy's write parameters) and swaps
/// the file atomically after checking the temp file opens with the new password to the same entropy. Nothing else
/// depends on the password: the mail database and the wallet use keys derived from the phrase.
fn change_password_steps(
    dir: &Path,
    current: &str,
    new: &str,
    policy: &KdfPolicy,
    steps: &ReplaceSteps,
) -> Result<(), KeyError> {
    require_password(new)?;
    let entropy = open_entropy(&read_seed_file(&dir.join(SEED_FILE_NAME))?, current, policy)?;
    let text = seal_entropy(&entropy, new, policy.write, random_bytes(), random_bytes())?;
    // A temp file that cannot be re-read or opened is a write failure, never "wrong password".
    let check = |temporary: &Path| match read_seed_file(temporary).and_then(|t| open_entropy(&t, new, policy)) {
        Ok(reopened) if *reopened == *entropy => Ok(()),
        Err(KeyError::Memory) => Err(KeyError::Memory),
        _ => Err(KeyError::Io),
    };
    replace_seed_file_with(dir, &text, check, steps)
}

pub(crate) fn change_password_with(dir: &Path, current: &str, new: &str, policy: &KdfPolicy) -> Result<(), KeyError> {
    throttled(dir, &unix_now, || change_password_steps(dir, current, new, policy, &REPLACE_STEPS))
}

pub(crate) fn reveal_phrase_with(
    dir: &Path,
    password: &str,
    policy: &KdfPolicy,
) -> Result<Zeroizing<String>, KeyError> {
    throttled(dir, &unix_now, || load(dir, password, policy)).map(|mnemonic| phrase_of(&mnemonic))
}

/// Only checks the password against `dir/seed.v1` (deleting a profile): the same check, counter and waits as unlocking,
/// but nothing stays open.
pub(crate) fn check_password_with(dir: &Path, password: &str, policy: &KdfPolicy) -> Result<(), KeyError> {
    throttled(dir, &unix_now, || load(dir, password, policy)).map(drop)
}

/// Checks the password of `dir/seed.v1` without opening a session (see [`check_password_with`]).
pub fn check_password(dir: &Path, password: &str) -> Result<(), KeyError> {
    check_password_with(dir, password, &PRODUCTION)
}

/// Forgets the failed attempts of `dir` (its `attempts.v1` and the in-memory copy): its seed has just been deleted.
pub fn forget_attempts(dir: &Path) {
    reset_attempts(dir);
}

/// Low Argon2id parameters for other modules' tests (the real minimums are tested here).
#[cfg(test)]
pub(crate) const TEST_POLICY: KdfPolicy =
    KdfPolicy { write: KdfParams { m: 8, t: 1, p: 1 }, minimum: KdfParams { m: 8, t: 1, p: 1 } };

/// Saves the phrase of `draft` as `dir/seed.v1`, sealed with the password (never overwrites an existing one).
pub fn create(dir: &Path, draft: &Draft, password: &str) -> Result<KeyManager, KeyError> {
    create_from_draft_with(dir, draft, password, &PRODUCTION)
}

/// Saves `dir/seed.v1` from a recovery phrase (never overwrites an existing one).
pub fn restore(dir: &Path, phrase: &str, password: &str) -> Result<KeyManager, KeyError> {
    restore_with(dir, phrase, password, &PRODUCTION)
}

/// Opens `dir/seed.v1` with the password.
pub fn unlock(dir: &Path, password: &str) -> Result<KeyManager, KeyError> {
    unlock_with(dir, password, &PRODUCTION)
}

/// Shows the phrase again (asks for the password again).
pub fn reveal_phrase(dir: &Path, password: &str) -> Result<Zeroizing<String>, KeyError> {
    reveal_phrase_with(dir, password, &PRODUCTION)
}

/// Changes the password of `dir/seed.v1` (asks for the current one). Wrong current password or damaged file:
/// `Locked`, with the file untouched.
pub fn change_password(dir: &Path, current: &str, new: &str) -> Result<(), KeyError> {
    change_password_with(dir, current, new, &PRODUCTION)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::test_vectors::{array, bytes, items, load as vectors, number, text};
    use serde_json::Value;

    /// Argon2id with low parameters so tests are fast (the real minimums are tested separately).
    const FAST: KdfPolicy =
        KdfPolicy { write: KdfParams { m: 8, t: 1, p: 1 }, minimum: KdfParams { m: 8, t: 1, p: 1 } };
    const PASSWORD: &str = "una contraseña";

    fn manager_for(phrase: &str) -> KeyManager {
        KeyManager::from_mnemonic(&parse_phrase(phrase).unwrap())
    }

    fn kind_from(value: &Value) -> AddressKind {
        match text(value) {
            "mailbox" => AddressKind::Mailbox,
            "alias" => AddressKind::Alias,
            other => panic!("kind {other}"),
        }
    }

    fn u32_of(value: &Value) -> u32 {
        u32::try_from(number(value)).unwrap()
    }

    fn u8_of(value: &Value) -> u8 {
        u8::try_from(number(value)).unwrap()
    }

    /// The output matches and the label is the vector's.
    fn assert_output(got: &[u8; 32], label: &Label, v: &Value) {
        assert_eq!(label.text(), text(&v["label"]));
        assert_eq!(format!("{LABEL_PREFIX}{}", label.text()).as_bytes(), bytes(&v["info"]));
        assert_eq!(got.to_vec(), bytes(&v["okm"]), "{}", v["label"]);
    }

    fn seed_path(dir: &tempfile::TempDir) -> std::path::PathBuf {
        dir.path().join(SEED_FILE_NAME)
    }

    // --- keys.json ---

    #[test]
    fn constants_match() {
        let c = &vectors("keys.json")["constants"];
        assert_eq!(text(&c["labelPrefix"]), LABEL_PREFIX);
        assert_eq!(text(&c["seedFileDomain"]), SEED_FILE_DOMAIN);
        assert_eq!(
            (u32_of(&c["minimumKdf"]["m"]), u32_of(&c["minimumKdf"]["t"])),
            (PRODUCTION.minimum.m, PRODUCTION.minimum.t)
        );
        let max = &c["maximumKdf"];
        assert_eq!(KdfParams { m: u32_of(&max["m"]), t: u32_of(&max["t"]), p: u32_of(&max["p"]) }, MAXIMUM);
        assert_eq!(number(&c["maxSeedFileLength"]), MAX_SEED_FILE_LENGTH);
    }

    #[test]
    fn phrases_entropy_and_master() {
        for v in items(&vectors("keys.json")["phrases"]) {
            let mnemonic = mnemonic_from(&array(&v["entropy"]));
            assert_eq!(phrase_of(&mnemonic).as_str(), text(&v["phrase"]));
            assert_eq!(entropy_of(&parse_phrase(text(&v["phrase"])).unwrap()).to_vec(), bytes(&v["entropy"]));
            assert_eq!(manager_for(text(&v["phrase"])).master.to_vec(), bytes(&v["seed"]));
        }
    }

    #[test]
    fn phrase_buffer_is_never_reallocated() {
        let phrase = phrase_of(&mnemonic_from(&[0xff; 32]));
        assert!(phrase.len() <= PHRASE_CAPACITY);
        assert_eq!(phrase.capacity(), PHRASE_CAPACITY);
    }

    #[test]
    fn derivation_bono_and_fixed_labels() {
        let d = &vectors("keys.json")["derivation"];
        let keys = manager_for(text(&d["phrase"]));
        assert_eq!(keys.master.to_vec(), bytes(&d["master"]));
        for v in items(&d["bono"]) {
            assert_output(&keys.bono_secret(u32_of(&v["n"])), &Label::Bono(u32_of(&v["n"])), v);
        }
        let f = &d["fixed"];
        assert_output(&keys.names_key(), &Label::Names, &f["names"]);
        assert_output(&keys.wallet_seed(), &Label::Wallet, &f["wallet"]);
        assert_output(&keys.wallet_state_key(), &Label::WalletState, &f["walletState"]);
        assert_output(&keys.db_key(), &Label::Db, &f["db"]);
    }

    #[test]
    fn derivation_address_keys_and_public_keys() {
        let d = &vectors("keys.json")["derivation"];
        let keys = manager_for(text(&d["phrase"]));
        for v in items(&d["addresses"]) {
            let (n, kind, j) = (u32_of(&v["n"]), kind_from(&v["kind"]), u8_of(&v["j"]));
            let address = keys.address_keys(n, kind, j);
            assert_output(&address.enc_secret, &Label::AddressEnc(n, kind, j), &v["enc"]);
            assert_output(&address.auth_seed, &Label::AddressAuth(n, kind, j), &v["auth"]);
            assert_eq!(address.enc_public, array::<32>(&v["enc"]["publicKey"]));
            assert_eq!(address.auth_public, array::<32>(&v["auth"]["publicKey"]));
        }
    }

    fn write_private(path: &Path, contents: &[u8]) {
        let mut file = create_new_private(path).unwrap();
        file.write_all(contents).unwrap();
    }

    fn write_vector_file(v: &Value) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        write_private(&seed_path(&dir), text(&v["file"]).as_bytes());
        dir
    }

    /// The vectors use the real minimums: they open under the production policy, also with equivalent Unicode forms
    /// of the password (NFC before Argon2id).
    #[test]
    fn seed_file_vectors_open_with_production_policy() {
        for v in items(&vectors("keys.json")["seedFiles"]) {
            let dir = write_vector_file(v);
            let passwords = std::iter::once(&v["password"]).chain(items(&v["equivalentPasswords"]));
            for password in passwords {
                let phrase = reveal_phrase_with(dir.path(), text(password), &PRODUCTION).unwrap();
                assert_eq!(phrase.as_str(), text(&v["phrase"]), "{password}");
            }
        }
    }

    /// NFC, not NFKC: `ª` is not turned into `a`, so the NFKC form of the password does not open.
    #[test]
    fn seed_file_vector_nfkc_password_does_not_open() {
        let files = vectors("keys.json")["seedFiles"].clone();
        let others: Vec<_> = items(&files)
            .iter()
            .flat_map(|v| items(&v["nonEquivalentPasswords"]).iter().map(move |p| (v, p)))
            .collect();
        assert!(!others.is_empty());
        for (v, password) in others {
            let dir = write_vector_file(v);
            assert_eq!(
                unlock_with(dir.path(), text(password), &PRODUCTION).err(),
                Some(KeyError::Locked),
                "{password}"
            );
        }
    }

    #[test]
    fn seed_file_vectors_are_reproduced_byte_for_byte() {
        for v in items(&vectors("keys.json")["seedFiles"]) {
            let file: SeedFile = serde_json::from_str(text(&v["file"])).unwrap();
            let kdf = KdfParams { m: file.m, t: file.t, p: file.p };
            let (salt, nonce) = (hex_array(&file.salt).unwrap(), hex_array(&file.nonce).unwrap());
            assert_eq!(argon2_key(text(&v["password"]), &salt, kdf).unwrap().to_vec(), bytes(&v["key"]));
            assert_eq!(seed_file_aad(kdf, &salt, &nonce), bytes(&v["aad"]));
            let sealed = seal_entropy(&array(&v["entropy"]), text(&v["password"]), kdf, salt, nonce);
            assert_eq!(sealed.unwrap(), text(&v["file"]));
        }
    }

    #[test]
    fn seed_file_vector_with_wrong_password_is_locked() {
        let dir = write_vector_file(&vectors("keys.json")["seedFiles"][0]);
        assert_eq!(unlock_with(dir.path(), "otra", &PRODUCTION).err(), Some(KeyError::Locked));
    }

    // --- Argon2id policy ---

    #[test]
    fn production_policy_writes_the_brief_parameters() {
        assert_eq!(PRODUCTION.write, KdfParams { m: 65536, t: 3, p: 1 });
        assert!(PRODUCTION.accepts(PRODUCTION.write));
    }

    #[test]
    fn production_policy_rejects_weak_or_absurd_parameters() {
        let ok = KdfParams { m: 19456, t: 2, p: 1 };
        assert!(PRODUCTION.accepts(ok));
        assert!(PRODUCTION.accepts(MAXIMUM));
        for bad in [
            KdfParams { m: 19455, ..ok },
            KdfParams { t: 1, ..ok },
            KdfParams { p: 0, ..ok },
            KdfParams { m: MAXIMUM.m + 1, ..ok },
            KdfParams { t: MAXIMUM.t + 1, ..ok },
            KdfParams { p: MAXIMUM.p + 1, ..ok },
        ] {
            assert!(!PRODUCTION.accepts(bad), "{bad:?}");
        }
    }

    // --- Create, open, restore ---

    #[test]
    fn create_then_unlock_and_reveal() {
        let dir = tempfile::tempdir().unwrap();
        let created = create_with(dir.path(), PASSWORD, &FAST).unwrap();
        assert_eq!(created.phrase.split(' ').count(), WORD_COUNT);
        let unlocked = unlock_with(dir.path(), PASSWORD, &FAST).unwrap();
        assert_eq!(unlocked.master, created.keys.master);
        assert_eq!(reveal_phrase_with(dir.path(), PASSWORD, &FAST).unwrap(), created.phrase);
        assert_eq!(manager_for(&created.phrase).master, created.keys.master);
    }

    /// The words are shown before the password exists: the draft writes nothing, always shows the same words, a failed
    /// save leaves no file and the draft usable, and the saved seed is exactly the words that were shown.
    #[test]
    fn a_draft_writes_nothing_until_saved_and_saves_the_words_shown() {
        let dir = tempfile::tempdir().unwrap();
        let draft = Draft::new();
        let shown = draft.phrase();
        assert_eq!(shown.split(' ').count(), WORD_COUNT);
        assert_eq!(draft.phrase(), shown);
        assert_eq!(draft.duplicate().phrase(), shown);
        assert_ne!(Draft::new().phrase(), shown);
        assert_eq!(format!("{draft:?}"), "Draft(..)");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0, "nothing on disk before the password");

        assert_eq!(create_from_draft_with(dir.path(), &draft, "", &FAST).err(), Some(KeyError::EmptyPassword));
        assert!(!seed_path(&dir).exists());

        let keys = create_from_draft_with(dir.path(), &draft, PASSWORD, &FAST).unwrap();
        assert_eq!(keys.master, manager_for(&shown).master);
        assert_eq!(reveal_phrase_with(dir.path(), PASSWORD, &FAST).unwrap(), shown);
        assert_eq!(create_from_draft_with(dir.path(), &draft, PASSWORD, &FAST).err(), Some(KeyError::Exists));
    }

    #[test]
    fn create_writes_policy_parameters_and_no_temporary_files() {
        let dir = tempfile::tempdir().unwrap();
        create_with(dir.path(), PASSWORD, &FAST).unwrap();
        let file: SeedFile = serde_json::from_str(&fs::read_to_string(seed_path(&dir)).unwrap()).unwrap();
        assert_eq!((file.version, file.kdf.as_str(), file.m, file.t, file.p), (1, "argon2id", 8, 1, 1));
        assert_eq!((file.salt.len(), file.nonce.len(), file.ciphertext.len()), (32, 24, 96));
        let names: Vec<_> = fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, [SEED_FILE_NAME]);
    }

    #[cfg(unix)]
    #[test]
    fn create_sets_private_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let parent = tempfile::tempdir().unwrap();
        let dir = parent.path().join("perfil");
        create_with(&dir, PASSWORD, &FAST).unwrap();
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&dir.join(SEED_FILE_NAME)), 0o600);
    }

    #[test]
    fn create_and_restore_never_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        create_with(dir.path(), PASSWORD, &FAST).unwrap();
        let before = fs::read(seed_path(&dir)).unwrap();
        let phrase = text(&vectors("keys.json")["phrases"][0]["phrase"]).to_owned();
        assert_eq!(create_with(dir.path(), PASSWORD, &FAST).err(), Some(KeyError::Exists));
        assert_eq!(restore_with(dir.path(), &phrase, PASSWORD, &FAST).err(), Some(KeyError::Exists));
        assert_eq!(fs::read(seed_path(&dir)).unwrap(), before);
    }

    /// N threads write at once (barrier right before): all pass the pre-check and race on `hard_link`. One wins; the
    /// rest get `Exists` and the file is the winner's.
    #[test]
    fn concurrent_writers_race_on_the_link_and_one_wins() {
        const WRITERS: usize = 8;
        let dir = tempfile::tempdir().unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(WRITERS));
        let handles: Vec<_> = (0..WRITERS)
            .map(|i| {
                let (path, barrier) = (dir.path().to_owned(), barrier.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    write_seed_file(&path, &format!("escritor {i}")).map_err(write_error).map(|()| i)
                })
            })
            .collect();
        let results: Vec<_> = handles.into_iter().map(|handle| handle.join().unwrap()).collect();
        let winners: Vec<_> = results.iter().filter_map(|r| r.as_ref().ok()).collect();
        assert_eq!(winners.len(), 1, "{results:?}");
        assert!(results.iter().filter(|r| r.is_err()).all(|r| r == &Err(KeyError::Exists)), "{results:?}");
        assert_eq!(fs::read_to_string(seed_path(&dir)).unwrap(), format!("escritor {}", winners[0]));
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1, "no temporary files are left");
    }

    #[cfg(unix)]
    #[test]
    fn create_refuses_a_directory_writable_by_others() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o770)).unwrap();
        assert_eq!(create_with(dir.path(), PASSWORD, &FAST).err(), Some(KeyError::Permissions));
        assert!(!seed_path(&dir).exists());
    }

    #[test]
    fn exclusive_write_fails_if_the_file_appears_meanwhile() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(seed_path(&dir), "otro").unwrap();
        assert_eq!(write_seed_file(dir.path(), "nuevo").map_err(write_error), Err(KeyError::Exists));
        assert_eq!(fs::read_to_string(seed_path(&dir)).unwrap(), "otro");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1, "the temporary file is removed");
    }

    #[test]
    fn failed_directory_sync_after_the_link_still_counts_as_written() {
        let dir = tempfile::tempdir().unwrap();
        let result = write_seed_file_with(dir.path(), "semilla", |_| Err(io::Error::other("fsync")));
        assert!(result.is_ok());
        assert_eq!(fs::read_to_string(seed_path(&dir)).unwrap(), "semilla");
    }

    #[test]
    fn stale_temporaries_are_swept_and_recent_ones_kept() {
        let dir = tempfile::tempdir().unwrap();
        let (stale, recent) = (dir.path().join("seed.v1.aaaa.tmp"), dir.path().join("seed.v1.bbbb.tmp"));
        fs::write(&stale, "x").unwrap();
        fs::write(&recent, "x").unwrap();
        let old = SystemTime::now() - STALE_TEMPORARY_AGE * 2;
        fs::File::options().write(true).open(&stale).unwrap().set_modified(old).unwrap();
        create_with(dir.path(), PASSWORD, &FAST).unwrap();
        assert!(!stale.exists());
        assert!(recent.exists());
    }

    // --- Change password ---

    const NEW_PASSWORD: &str = "otra contraseña nueva";

    fn dir_names(dir: &tempfile::TempDir) -> Vec<String> {
        let mut names: Vec<_> =
            fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        names.sort();
        names
    }

    fn steps(rename: fn(&Path, &Path) -> io::Result<()>, sync: fn(&Path) -> io::Result<()>) -> ReplaceSteps {
        ReplaceSteps { rename, sync }
    }

    #[test]
    fn change_password_old_fails_new_opens_the_same_seed() {
        let (dir, before) = created_file();
        let master = unlock_with(dir.path(), PASSWORD, &FAST).unwrap().master;
        change_password_with(dir.path(), PASSWORD, NEW_PASSWORD, &FAST).unwrap();
        assert_eq!(unlock_with(dir.path(), PASSWORD, &FAST).err(), Some(KeyError::Locked));
        assert_eq!(unlock_with(dir.path(), NEW_PASSWORD, &FAST).unwrap().master, master);
        // New salt and nonce; same write parameters; no temp files or copies.
        let (old, new): (SeedFile, SeedFile) = (
            serde_json::from_str(&before).unwrap(),
            serde_json::from_str(&fs::read_to_string(seed_path(&dir)).unwrap()).unwrap(),
        );
        assert_ne!(old.salt, new.salt);
        assert_ne!(old.nonce, new.nonce);
        assert_eq!((new.version, new.kdf.as_str(), new.m, new.t, new.p), (1, "argon2id", 8, 1, 1));
        assert_eq!(dir_names(&dir), [SEED_FILE_NAME]);
        // And it can be changed again (the current one is now the new one).
        change_password_with(dir.path(), NEW_PASSWORD, PASSWORD, &FAST).unwrap();
        assert_eq!(unlock_with(dir.path(), PASSWORD, &FAST).unwrap().master, master);
    }

    #[test]
    fn change_password_writes_the_policy_parameters_not_the_old_file_ones() {
        let dir = tempfile::tempdir().unwrap();
        let file = seal_entropy(&[7; 32], PASSWORD, KdfParams { m: 16, t: 2, p: 1 }, [1; 16], [2; 12]).unwrap();
        write_private(&seed_path(&dir), file.as_bytes());
        change_password_with(dir.path(), PASSWORD, NEW_PASSWORD, &FAST).unwrap();
        let new: SeedFile = serde_json::from_str(&fs::read_to_string(seed_path(&dir)).unwrap()).unwrap();
        assert_eq!((new.m, new.t, new.p), (8, 1, 1));
        assert_eq!(*open_entropy(&fs::read_to_string(seed_path(&dir)).unwrap(), NEW_PASSWORD, &FAST).unwrap(), [7; 32]);
    }

    #[test]
    fn change_password_with_wrong_current_or_empty_new_leaves_the_file_untouched() {
        let (dir, before) = created_file();
        assert_eq!(change_password_with(dir.path(), "mala", NEW_PASSWORD, &FAST).err(), Some(KeyError::Locked));
        assert_eq!(change_password_with(dir.path(), PASSWORD, "", &FAST).err(), Some(KeyError::EmptyPassword));
        assert_eq!(fs::read_to_string(seed_path(&dir)).unwrap(), before);
        // No temp files; the failure counter remains (an empty new password neither counts nor resets it).
        assert_eq!(dir_names(&dir), [ATTEMPTS_FILE_NAME, SEED_FILE_NAME]);
        assert!(unlock_with(dir.path(), PASSWORD, &FAST).is_ok());
    }

    #[test]
    fn change_password_without_a_seed_file_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(change_password_with(dir.path(), PASSWORD, NEW_PASSWORD, &FAST).err(), Some(KeyError::Missing));
        assert!(dir_names(&dir).is_empty());
    }

    /// Crash (process dies) right before `rename`: the old file is intact and opens with the old password. The
    /// orphaned temp file is complete and verified; the next write sweeps it.
    #[test]
    fn crash_before_the_rename_leaves_the_old_file_valid() {
        let (dir, before) = created_file();
        let crash = steps(|_, _| panic!("crash before the rename"), sync_dir);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            change_password_steps(dir.path(), PASSWORD, NEW_PASSWORD, &FAST, &crash)
        }));
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(seed_path(&dir)).unwrap(), before);
        assert!(unlock_with(dir.path(), PASSWORD, &FAST).is_ok());
        assert_eq!(unlock_with(dir.path(), NEW_PASSWORD, &FAST).err(), Some(KeyError::Locked));
        let orphans: Vec<_> = dir_names(&dir).into_iter().filter(|n| is_temporary_name(n)).collect();
        assert_eq!(orphans.len(), 1, "the temporary file stays: the crash prevents cleanup");
        // The orphan does not get in the way: the change can be repeated.
        change_password_with(dir.path(), PASSWORD, NEW_PASSWORD, &FAST).unwrap();
        assert!(unlock_with(dir.path(), NEW_PASSWORD, &FAST).is_ok());
    }

    /// A crash orphan opens with the new password while `seed.v1` still has the old one: a second copy of the seed.
    /// The next unlock sweeps it, but only if `seed.v1` opens (a failed unlock deletes nothing).
    #[test]
    fn unlock_sweeps_the_orphan_of_an_interrupted_change_only_after_opening() {
        let (dir, _) = created_file();
        let crash = steps(|_, _| panic!("crash before the rename"), sync_dir);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            change_password_steps(dir.path(), PASSWORD, NEW_PASSWORD, &FAST, &crash)
        }));
        assert!(result.is_err());
        let orphan = dir_names(&dir).into_iter().find(|n| is_temporary_name(n)).map(|n| dir.path().join(n)).unwrap();
        assert!(open_entropy(&fs::read_to_string(&orphan).unwrap(), NEW_PASSWORD, &FAST).is_ok());

        // Recent: it may belong to a write in progress and is left alone.
        unlock_with(dir.path(), PASSWORD, &FAST).unwrap();
        assert!(orphan.exists());
        let old = SystemTime::now() - STALE_TEMPORARY_AGE * 2;
        fs::File::options().write(true).open(&orphan).unwrap().set_modified(old).unwrap();
        assert_eq!(unlock_with(dir.path(), NEW_PASSWORD, &FAST).err(), Some(KeyError::Locked));
        assert!(orphan.exists(), "nothing is removed without opening");
        // Revealing the phrase does not clean up either: it only reads.
        reveal_phrase_with(dir.path(), PASSWORD, &FAST).unwrap();
        assert!(orphan.exists());
        unlock_with(dir.path(), PASSWORD, &FAST).unwrap();
        assert_eq!(dir_names(&dir), [SEED_FILE_NAME]);
    }

    /// `rename` fails (e.g. Windows with the file held open by someone else): I/O error, the temp file is removed and
    /// the old password still works.
    #[test]
    fn failed_rename_keeps_the_old_file_and_removes_the_temporary() {
        let (dir, before) = created_file();
        let failing = steps(|_, _| Err(io::Error::other("rename")), sync_dir);
        let result = change_password_steps(dir.path(), PASSWORD, NEW_PASSWORD, &FAST, &failing);
        assert_eq!(result.err(), Some(KeyError::Io));
        assert_eq!(fs::read_to_string(seed_path(&dir)).unwrap(), before);
        assert_eq!(dir_names(&dir), [SEED_FILE_NAME]);
        assert!(unlock_with(dir.path(), PASSWORD, &FAST).is_ok());
    }

    /// The temp file fails the re-read: nothing is renamed and the error is I/O (not "wrong password").
    #[test]
    fn failed_check_of_the_temporary_never_reaches_the_rename() {
        let (dir, before) = created_file();
        let never = steps(|_, _| panic!("must not rename"), sync_dir);
        let result = replace_seed_file_with(dir.path(), "dañado", |_| Err(KeyError::Io), &never);
        assert_eq!(result.err(), Some(KeyError::Io));
        assert_eq!(fs::read_to_string(seed_path(&dir)).unwrap(), before);
        assert_eq!(dir_names(&dir), [SEED_FILE_NAME]);
    }

    /// `check` receives the temp file fully written (and synced), before the `rename`.
    #[test]
    fn the_check_sees_the_complete_temporary_before_the_rename() {
        let (dir, _) = created_file();
        let seen = std::cell::Cell::new(false);
        let result = replace_seed_file_with(
            dir.path(),
            "contenido",
            |temporary| {
                assert_eq!(fs::read_to_string(temporary).unwrap(), "contenido");
                seen.set(true);
                Ok(())
            },
            &steps(|_, _| Ok(()), sync_dir),
        );
        assert!(result.is_ok() && seen.get());
    }

    #[test]
    fn failed_directory_sync_after_the_rename_still_counts_as_changed() {
        let (dir, _) = created_file();
        let failing = steps(rename_file, |_| Err(io::Error::other("fsync")));
        change_password_steps(dir.path(), PASSWORD, NEW_PASSWORD, &FAST, &failing).unwrap();
        assert!(unlock_with(dir.path(), NEW_PASSWORD, &FAST).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn change_password_keeps_private_permissions_and_refuses_an_open_file() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, before) = created_file();
        change_password_with(dir.path(), PASSWORD, NEW_PASSWORD, &FAST).unwrap();
        assert_eq!(fs::metadata(seed_path(&dir)).unwrap().permissions().mode() & 0o777, 0o600);
        let changed = fs::read_to_string(seed_path(&dir)).unwrap();
        assert_ne!(changed, before);
        fs::set_permissions(seed_path(&dir), fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            change_password_with(dir.path(), NEW_PASSWORD, PASSWORD, &FAST).err(),
            Some(KeyError::Permissions)
        );
        assert_eq!(fs::read_to_string(seed_path(&dir)).unwrap(), changed);
        assert_eq!(dir_names(&dir), [SEED_FILE_NAME]);
    }

    #[test]
    fn restore_then_unlock_gives_the_phrase_master() {
        let dir = tempfile::tempdir().unwrap();
        let v = &vectors("keys.json")["phrases"][1];
        restore_with(dir.path(), text(&v["phrase"]), PASSWORD, &FAST).unwrap();
        assert_eq!(unlock_with(dir.path(), PASSWORD, &FAST).unwrap().master.to_vec(), bytes(&v["seed"]));
    }

    #[test]
    fn phrase_in_capitals_is_accepted() {
        let v = &vectors("keys.json")["phrases"][1];
        let shouted = text(&v["phrase"]).to_uppercase();
        assert_eq!(manager_for(&shouted).master.to_vec(), bytes(&v["seed"]));
    }

    #[test]
    fn invalid_phrases_are_rejected() {
        let twelve = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let bad_checksum = "abandon ".repeat(24);
        let unknown_word = format!("{}nightmail", "abandon ".repeat(23));
        for phrase in [twelve, bad_checksum.trim(), unknown_word.as_str(), ""] {
            assert_eq!(validate_phrase(phrase), Err(KeyError::InvalidPhrase), "{phrase}");
        }
        assert_eq!(validate_phrase(text(&vectors("keys.json")["phrases"][0]["phrase"])), Ok(()));
    }

    #[test]
    fn empty_password_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(create_with(dir.path(), "", &FAST).err(), Some(KeyError::EmptyPassword));
        assert!(!seed_path(&dir).exists());
    }

    #[test]
    fn missing_file_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(unlock_with(dir.path(), PASSWORD, &FAST).err(), Some(KeyError::Missing));
    }

    // --- Tampered or non-canonical files: all give `Locked` ---

    fn created_file() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        create_with(dir.path(), PASSWORD, &FAST).unwrap();
        let file = fs::read_to_string(seed_path(&dir)).unwrap();
        (dir, file)
    }

    /// Flips the last hex digit of `"field":"…"`.
    fn flip_hex_field(file: &str, field: &str) -> String {
        let start = file.find(&format!(r#""{field}":""#)).unwrap() + field.len() + 4;
        let end = start + file[start..].find('"').unwrap() - 1;
        let flipped = if &file[end..=end] == "0" { "1" } else { "0" };
        format!("{}{flipped}{}", &file[..end], &file[end + 1..])
    }

    fn assert_locked(dir: &tempfile::TempDir, contents: &[u8]) {
        // Each tampered file is a separate case, without the failure count of the previous ones.
        reset_attempts(dir.path());
        fs::remove_file(seed_path(dir)).unwrap();
        write_private(&seed_path(dir), contents);
        let shown = String::from_utf8_lossy(contents);
        assert_eq!(unlock_with(dir.path(), PASSWORD, &FAST).err(), Some(KeyError::Locked), "{shown}");
    }

    #[test]
    fn altered_files_are_locked() {
        let (dir, file) = created_file();
        let altered = [
            flip_hex_field(&file, "ciphertext"),
            flip_hex_field(&file, "salt"),
            flip_hex_field(&file, "nonce"),
            file.replace(r#""t":1"#, r#""t":2"#),
            file.replace(r#""version":1"#, r#""version":2"#),
            file.replace("argon2id", "argon2i"),
            file.replace(r#""m":8"#, r#""m":8,"extra":0"#),
            file.replace(r#""nonce":""#, r#""nonce":"00"#),
            "no es json".to_owned(),
        ];
        for text in altered {
            assert_locked(&dir, text.as_bytes());
        }
    }

    /// The canonical form does open (control for the test below).
    fn assert_canonical_opens(dir: &tempfile::TempDir, file: &str) {
        fs::remove_file(seed_path(dir)).unwrap();
        write_private(&seed_path(dir), file.as_bytes());
        assert!(unlock_with(dir.path(), PASSWORD, &FAST).is_ok());
    }

    #[test]
    fn non_canonical_files_are_locked() {
        let (dir, _) = created_file();
        // Fixed salt with hex letters, so uppercasing it always changes the file.
        let file = seal_entropy(&[7; 32], PASSWORD, FAST.write, [0xab; 16], [1; 12]).unwrap();
        assert_canonical_opens(&dir, &file);
        let upper_salt = file.replace(&"ab".repeat(16), &"AB".repeat(16));
        let non_canonical = [
            file.replace(',', ", "),
            format!("{file}\n"),
            file.replace(r#""m":8"#, r#""m":8,"m":8"#),
            file.replace(r#"{"version":1,"kdf":"argon2id""#, r#"{"kdf":"argon2id","version":1"#),
            upper_salt,
        ];
        for text in non_canonical {
            assert_ne!(text, file);
            assert_locked(&dir, text.as_bytes());
        }
    }

    #[test]
    fn non_utf8_or_oversized_files_are_locked() {
        let (dir, file) = created_file();
        assert_locked(&dir, &[0xff, 0xfe, b'{']);
        assert_locked(&dir, format!("{file}{}", " ".repeat(MAX_SEED_FILE_LENGTH)).as_bytes());
    }

    #[cfg(unix)]
    #[test]
    fn open_or_linked_seed_files_are_refused() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, file) = created_file();
        fs::set_permissions(seed_path(&dir), fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(unlock_with(dir.path(), PASSWORD, &FAST).err(), Some(KeyError::Permissions));
        let other = tempfile::tempdir().unwrap();
        write_private(&other.path().join("real"), file.as_bytes());
        std::os::unix::fs::symlink(other.path().join("real"), other.path().join(SEED_FILE_NAME)).unwrap();
        assert_eq!(unlock_with(other.path(), PASSWORD, &FAST).err(), Some(KeyError::Permissions));
    }

    #[test]
    fn weak_parameters_are_locked_under_production_policy() {
        let (dir, _) = created_file();
        assert_eq!(unlock_with(dir.path(), PASSWORD, &PRODUCTION).err(), Some(KeyError::Locked));
    }

    // --- Nothing secret in Debug or in errors ---

    #[test]
    fn debug_hides_secrets() {
        let keys = manager_for(text(&vectors("keys.json")["phrases"][1]["phrase"]));
        assert_eq!(format!("{keys:?}"), "KeyManager(<redacted>)");
        let address = keys.address_keys(0, AddressKind::Alias, 1);
        let shown = format!("{address:?}");
        assert!(shown.contains(&hex::encode(address.enc_public)));
        assert!(
            !shown.contains(&hex::encode(*address.enc_secret)) && !shown.contains(&hex::encode(*address.auth_seed))
        );
    }

    #[test]
    fn errors_have_fixed_messages_and_io_kinds_map_by_direction() {
        let all = [
            KeyError::Locked,
            KeyError::Missing,
            KeyError::Exists,
            KeyError::InvalidPhrase,
            KeyError::EmptyPassword,
            KeyError::Permissions,
            KeyError::Memory,
            KeyError::Io,
            KeyError::TooManyAttempts { wait_secs: 30 },
        ];
        let messages: std::collections::HashSet<_> = all.iter().map(ToString::to_string).collect();
        assert_eq!(messages.len(), all.len());
        let kind = io::Error::from;
        assert_eq!(read_error(kind(io::ErrorKind::NotFound)), KeyError::Missing);
        assert_eq!(
            read_error(kind(io::ErrorKind::PermissionDenied)),
            KeyError::Io,
            "only the fsutil ones are Permissions"
        );
        assert_eq!(
            read_error(io::Error::new(io::ErrorKind::PermissionDenied, fsutil::InsecurePermissions("x"))),
            KeyError::Permissions
        );
        assert_eq!(read_error(kind(io::ErrorKind::Interrupted)), KeyError::Io);
        assert_eq!(write_error(kind(io::ErrorKind::NotFound)), KeyError::Io);
        assert_eq!(write_error(kind(io::ErrorKind::AlreadyExists)), KeyError::Exists);
    }

    // --- Failed attempts ---

    const WRONG: &str = "otra contraseña";

    /// Fake clock for `throttled`: Unix time is set by hand.
    struct Clock(std::cell::Cell<u64>);

    impl Clock {
        fn at(secs: u64) -> Self {
            Self(std::cell::Cell::new(secs))
        }
        fn now(&self) -> u64 {
            self.0.get()
        }
        fn pass(&self, secs: u64) {
            self.0.set(self.0.get() + secs);
        }
        fn set(&self, secs: u64) {
            self.0.set(secs);
        }
    }

    /// One `throttled` attempt whose result is `outcome`; returns the result and whether it was actually attempted.
    fn try_with(dir: &tempfile::TempDir, clock: &Clock, outcome: Result<(), KeyError>) -> (Result<(), KeyError>, bool) {
        let called = std::cell::Cell::new(false);
        let result = throttled(dir.path(), &|| clock.now(), || {
            called.set(true);
            outcome
        });
        (result, called.get())
    }

    fn stored(dir: &tempfile::TempDir) -> Attempts {
        read_attempts(&dir.path().join(ATTEMPTS_FILE_NAME))
    }

    fn too_many(wait_secs: u32) -> Result<(), KeyError> {
        Err(KeyError::TooManyAttempts { wait_secs })
    }

    #[test]
    fn the_wait_starts_at_the_fifth_failure_doubles_and_stops_at_fifteen_minutes() {
        let waits: Vec<u32> = (0..=11).map(wait_after).collect();
        assert_eq!(waits, [0, 0, 0, 0, 0, 30, 60, 120, 240, 480, 900, 900]);
        assert_eq!(wait_after(40), 900);
        assert_eq!(wait_after(u32::MAX), 900);
    }

    #[test]
    fn four_failures_pass_then_each_one_more_waits_longer() {
        let dir = tempfile::tempdir().unwrap();
        let clock = Clock::at(1_000_000);
        for _ in 0..4 {
            assert_eq!(try_with(&dir, &clock, Err(KeyError::Locked)), (Err(KeyError::Locked), true));
        }
        assert_eq!(try_with(&dir, &clock, Err(KeyError::Locked)), (too_many(30), true), "the 5th already warns");
        // While a wait is pending nothing is attempted (the password is not checked) and it does not count.
        assert_eq!(try_with(&dir, &clock, Ok(())), (too_many(30), false));
        clock.pass(12);
        assert_eq!(try_with(&dir, &clock, Ok(())), (too_many(18), false));
        assert_eq!(stored(&dir).failures, 5);
        clock.pass(18);
        assert_eq!(try_with(&dir, &clock, Err(KeyError::Locked)), (too_many(60), true));
        clock.pass(60);
        assert_eq!(try_with(&dir, &clock, Err(KeyError::Locked)), (too_many(120), true));
        assert_eq!(stored(&dir), Attempts { failures: 7, until: 1_000_000 + 30 + 60 + 120 });
    }

    #[test]
    fn a_success_resets_the_counter_and_removes_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let clock = Clock::at(500);
        for _ in 0..5 {
            let _ = try_with(&dir, &clock, Err(KeyError::Locked));
        }
        clock.pass(30);
        assert_eq!(try_with(&dir, &clock, Ok(())), (Ok(()), true));
        assert_eq!(stored(&dir), Attempts::default());
        assert!(!dir.path().join(ATTEMPTS_FILE_NAME).exists());
        for _ in 0..4 {
            assert_eq!(try_with(&dir, &clock, Err(KeyError::Locked)).0, Err(KeyError::Locked), "vuelve a empezar");
        }
    }

    #[test]
    fn other_errors_do_not_count() {
        let dir = tempfile::tempdir().unwrap();
        let clock = Clock::at(500);
        for error in [KeyError::Io, KeyError::Memory, KeyError::Missing, KeyError::EmptyPassword, KeyError::Permissions] {
            for _ in 0..5 {
                assert_eq!(try_with(&dir, &clock, Err(error)), (Err(error), true));
            }
        }
        assert!(!dir.path().join(ATTEMPTS_FILE_NAME).exists());
    }

    /// The count lives in the file: another process (app restarted) reads the same.
    #[test]
    fn the_counter_survives_a_restart_in_a_private_file() {
        let dir = tempfile::tempdir().unwrap();
        let clock = Clock::at(10_000);
        for _ in 0..5 {
            let _ = try_with(&dir, &clock, Err(KeyError::Locked));
        }
        let path = dir.path().join(ATTEMPTS_FILE_NAME);
        assert_eq!(fs::read_to_string(&path).unwrap(), "failures 5\nuntil 10030\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert_eq!(dir_names(&dir), [ATTEMPTS_FILE_NAME], "no temporary files");
        clock.pass(10);
        assert_eq!(try_with(&dir, &clock, Ok(())), (too_many(20), false));
    }

    /// The clock goes back a year: the full wait restarts, neither opening early nor staying locked for a year.
    #[test]
    fn a_clock_going_back_restarts_the_full_wait_once() {
        let dir = tempfile::tempdir().unwrap();
        let clock = Clock::at(40_000_000);
        for _ in 0..5 {
            let _ = try_with(&dir, &clock, Err(KeyError::Locked));
        }
        clock.pass(30);
        assert_eq!(try_with(&dir, &clock, Err(KeyError::Locked)), (too_many(60), true));
        clock.pass(10);
        assert_eq!(try_with(&dir, &clock, Ok(())), (too_many(50), false));
        clock.set(40_000_000 - 365 * 86_400);
        assert_eq!(try_with(&dir, &clock, Ok(())), (too_many(60), false), "the full wait, not a year");
        clock.pass(59);
        assert_eq!(try_with(&dir, &clock, Ok(())), (too_many(1), false), "and it does not restart again");
        clock.pass(1);
        assert_eq!(try_with(&dir, &clock, Ok(())), (Ok(()), true));
    }

    #[test]
    fn a_damaged_counter_file_counts_as_zero() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ATTEMPTS_FILE_NAME);
        for text in ["", "basura", "failures 9\n", "failures x\nuntil 1\n", "until 1\nfailures 9\n"] {
            let _ = fs::remove_file(&path);
            write_private(&path, text.as_bytes());
            assert_eq!(stored(&dir), Attempts::default(), "{text:?}");
        }
        let _ = fs::remove_file(&path);
        write_private(&path, b"failures 6\nuntil 77\n");
        assert_eq!(stored(&dir), Attempts { failures: 6, until: 77 });
    }

    /// Unlock, reveal and password change share the counter; while a wait is pending even the right password fails.
    #[test]
    fn unlock_reveal_and_change_share_the_counter() {
        let (dir, before) = created_file();
        assert_eq!(unlock_with(dir.path(), WRONG, &FAST).err(), Some(KeyError::Locked));
        assert_eq!(reveal_phrase_with(dir.path(), WRONG, &FAST).err(), Some(KeyError::Locked));
        assert_eq!(change_password_with(dir.path(), WRONG, NEW_PASSWORD, &FAST).err(), Some(KeyError::Locked));
        assert_eq!(unlock_with(dir.path(), WRONG, &FAST).err(), Some(KeyError::Locked));
        let fifth = reveal_phrase_with(dir.path(), WRONG, &FAST).err();
        assert!(matches!(fifth, Some(KeyError::TooManyAttempts { wait_secs: 30 })), "{fifth:?}");
        let waiting = |e: Option<KeyError>| matches!(e, Some(KeyError::TooManyAttempts { wait_secs: 1..=30 }));
        assert!(waiting(unlock_with(dir.path(), PASSWORD, &FAST).err()));
        assert!(waiting(reveal_phrase_with(dir.path(), PASSWORD, &FAST).err()));
        assert!(waiting(change_password_with(dir.path(), PASSWORD, NEW_PASSWORD, &FAST).err()));
        assert_eq!(fs::read_to_string(seed_path(&dir)).unwrap(), before, "nothing changed");
        assert_eq!(stored(&dir).failures, 5);
    }

    /// `attempts.v1` cannot be saved (a directory sits in its place): the in-memory copy keeps the wait.
    #[test]
    fn the_wait_holds_in_memory_when_the_file_cannot_be_saved() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(ATTEMPTS_FILE_NAME)).unwrap();
        let clock = Clock::at(7_000);
        for _ in 0..4 {
            assert_eq!(try_with(&dir, &clock, Err(KeyError::Locked)).0, Err(KeyError::Locked));
        }
        assert_eq!(try_with(&dir, &clock, Err(KeyError::Locked)), (too_many(30), true));
        assert_eq!(stored(&dir), Attempts::default(), "the file holds nothing");
        clock.pass(10);
        assert_eq!(try_with(&dir, &clock, Ok(())), (too_many(20), false));
        clock.pass(20);
        assert_eq!(try_with(&dir, &clock, Ok(())), (Ok(()), true));
        assert_eq!(attempts_memory().get(dir.path()), None, "a success also clears it from memory");
    }

    /// Creating or restoring a seed in a directory with a previous seed's failures starts without them.
    #[test]
    fn create_and_restore_start_without_failures() {
        let v = &vectors("keys.json")["phrases"][1];
        for restore in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let clock = Clock::at(unix_now());
            for _ in 0..6 {
                let _ = try_with(&dir, &clock, Err(KeyError::Locked));
            }
            assert!(dir.path().join(ATTEMPTS_FILE_NAME).exists());
            if restore {
                restore_with(dir.path(), text(&v["phrase"]), PASSWORD, &FAST).unwrap();
            } else {
                create_with(dir.path(), PASSWORD, &FAST).unwrap();
            }
            assert_eq!(dir_names(&dir), [SEED_FILE_NAME], "restore={restore}");
            assert_eq!(attempts_memory().get(dir.path()), None);
            assert_eq!(unlock_with(dir.path(), WRONG, &FAST).err(), Some(KeyError::Locked), "restore={restore}");
        }
    }

    #[test]
    fn a_right_password_before_the_fifth_failure_resets() {
        let (dir, _) = created_file();
        for _ in 0..4 {
            assert_eq!(unlock_with(dir.path(), WRONG, &FAST).err(), Some(KeyError::Locked));
        }
        assert!(unlock_with(dir.path(), PASSWORD, &FAST).is_ok());
        assert_eq!(dir_names(&dir), [SEED_FILE_NAME]);
        assert_eq!(unlock_with(dir.path(), WRONG, &FAST).err(), Some(KeyError::Locked));
    }

    #[test]
    fn labels_are_distinct_per_slot() {
        let keys = manager_for(text(&vectors("keys.json")["phrases"][0]["phrase"]));
        let a = keys.address_keys(0, AddressKind::Mailbox, 0);
        let b = keys.address_keys(0, AddressKind::Alias, 0);
        assert_ne!(a.enc_public, b.enc_public);
        assert_ne!(*keys.bono_secret(0), *keys.names_key());
    }
}
