//! Directory of NightMail addresses, for writing to one and for checking who wrote: an address text is looked up in
//! the registry's public state on this device, so nobody is asked which address we are after. The state is read whole
//! through the sidecar (`contract.snapshot`) and mailbox names are hashed by the sidecar locally (`contract.hashes`);
//! fetching, caching and freshness are in `orchestrator::directory`. This part is pure: parsing an address and looking
//! it up in one snapshot.
//!
//! The rules are the server's (`packages/midnight/src/resolution.ts`, `apps/server/src/registry/directory.ts`):
//! - an alias-shaped local part resolves only as an alias, by its full text (words and suffix), never through
//!   `H(name)`, since the contract accepts a mailbox named like someone's alias;
//! - any other local part is a mailbox: `addrKey = H(name)`, and only if that record is a mailbox; reserved names
//!   never resolve (the sidecar refuses to hash them);
//! - an address whose `encPk` or `authPk` is unusable cannot be written to, and its signatures are never accepted.
//!
//! One difference: the server gives a suffix to the first alias in chain order, but the snapshot is not in chain
//! order, so a suffix held by two aliases resolves to neither here (fail closed). The app refuses to create such an
//! alias (`check_suffix_free`) and a collision needs about 2^60 work.

use std::collections::{HashMap, HashSet};
use std::fmt;

use serde::Serialize;

use crate::crypto::{is_usable_auth_public_key, is_usable_mailbox_public_key};
use crate::mail::e2e::{SenderLookup, SenderUnavailable};
use crate::orchestrator::addresses::alias_form;
use crate::protocol::{AddressEntry, AddressKind};

/// Oldest registry state accepted (its block time against the local clock), the same limit the sidecar puts on the
/// state it proves against (`MAX_STATE_AGE_MS`): the indexer follows finalized blocks, about 20 s behind the head.
pub const MAX_STATE_AGE_MS: i64 = 120_000;
/// How far ahead of the local clock the block may be (`MAX_CLOCK_BEHIND_MS` in the sidecar).
pub const MAX_CLOCK_BEHIND_MS: i64 = 60_000;
/// Longest local part (`NAME_BYTES`).
const MAX_LOCAL_LENGTH: usize = 64;
/// Characters of an alias suffix (`SUFFIX_CHARS`).
const SUFFIX_LENGTH: usize = 12;

/// Why an address cannot be used. Fixed codes for the UI, never the address or any key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum DirectoryError {
    /// Not an address (no `@`, spaces inside, characters a name cannot have).
    InvalidAddress,
    /// An address, but not in the NightMail domain.
    ForeignDomain,
    /// A NightMail address that is not in the registry (or a reserved name, which never receives mail).
    NotFound,
    /// In the registry, but it cannot receive mail: an unusable key, or an alias suffix held by two aliases.
    Unusable,
    /// The registry cannot be read right now (sidecar or indexer not answering, malformed state).
    RegistryUnavailable,
    /// The registry read is older than [`MAX_STATE_AGE_MS`], or behind one already seen: it may miss addresses or
    /// keys, so it is not used.
    RegistryStale,
    /// The registry's last block is ahead of the system clock: check the time.
    Clock,
}

impl DirectoryError {
    /// The registry could not answer (as opposed to an answer about the address).
    pub fn is_registry(self) -> bool {
        matches!(self, Self::RegistryUnavailable | Self::RegistryStale | Self::Clock)
    }
}

impl fmt::Display for DirectoryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "directory error: {self:?}")
    }
}

impl std::error::Error for DirectoryError {}

/// The local part of a NightMail address, in lowercase, and how it resolves.
#[derive(Clone, PartialEq, Eq)]
pub enum LocalPart {
    Alias(String),
    Mailbox(String),
}

/// Leaves the name out of logs.
impl fmt::Debug for LocalPart {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Alias(_) => "Alias(..)",
            Self::Mailbox(_) => "Mailbox(..)",
        })
    }
}

/// The local part of `text` if it is an address in `domain`. Surrounding whitespace is ignored and ASCII letters are
/// lowercased; anything that is not printable ASCII is invalid (before lowercasing, as `normalizeName` does).
pub fn parse_address(text: &str, domain: &str) -> Result<LocalPart, DirectoryError> {
    let text = text.trim();
    if !text.bytes().all(|c| c.is_ascii_graphic()) {
        return Err(DirectoryError::InvalidAddress);
    }
    let lower = text.to_ascii_lowercase();
    let (local, host) = lower.split_once('@').ok_or(DirectoryError::InvalidAddress)?;
    if local.is_empty() || host.is_empty() || host.contains('@') {
        return Err(DirectoryError::InvalidAddress);
    }
    if host != domain.to_ascii_lowercase() {
        return Err(DirectoryError::ForeignDomain);
    }
    // The characters a mailbox name or an alias text can have; the sidecar checks the rest of a mailbox name.
    let name_char = |c: u8| c.is_ascii_lowercase() || c.is_ascii_digit() || b"._-".contains(&c);
    if local.len() > MAX_LOCAL_LENGTH || !local.bytes().all(name_char) {
        return Err(DirectoryError::InvalidAddress);
    }
    Ok(if alias_form(local) { LocalPart::Alias(local.to_owned()) } else { LocalPart::Mailbox(local.to_owned()) })
}

/// What to look up: an alias by its text, or a mailbox by the `addrKey` of its name.
#[derive(Clone, Copy)]
pub enum Target<'a> {
    Alias(&'a str),
    Mailbox(&'a [u8; 32]),
}

/// The keys of a registered address, checked usable.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Found {
    pub addr_key: [u8; 32],
    /// To seal mail to it.
    pub enc_pk: [u8; 32],
    /// To check what it signs.
    pub auth_pk: [u8; 32],
}

/// Leaves the keys out of logs.
impl fmt::Debug for Found {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Found(..)")
    }
}

#[derive(Clone, Copy)]
struct Record {
    kind: AddressKind,
    enc_pk: [u8; 32],
    auth_pk: [u8; 32],
}

/// The registry's addresses at one block, indexed for lookup.
pub struct Registry {
    pub block_height: u32,
    /// Unix ms.
    pub block_timestamp: u64,
    records: HashMap<[u8; 32], Record>,
    /// Alias text (local part) → `addrKey`, for suffixes held by a single alias.
    aliases: HashMap<String, [u8; 32]>,
    /// Texts of aliases whose suffix another alias also has.
    shared_suffix: HashSet<String>,
}

impl fmt::Debug for Registry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Registry")
            .field("block_height", &self.block_height)
            .field("addresses", &self.records.len())
            .finish_non_exhaustive()
    }
}

fn hex32(text: &str) -> Option<[u8; 32]> {
    let mut out = [0u8; 32];
    hex::decode_to_slice(text, &mut out).ok()?;
    Some(out)
}

fn suffix(alias_text: &str) -> &str {
    alias_text.get(alias_text.len().saturating_sub(SUFFIX_LENGTH)..).unwrap_or(alias_text)
}

impl Registry {
    /// `alias_text` gives each alias's text (`contract.hashes` `aliasAddress`, keyed by `addrKey` in hex). `None` if
    /// any entry is malformed or an alias has no text: the sidecar never produces that, so the state is not used.
    pub fn new<'a>(
        block_height: u32,
        block_timestamp: u64,
        entries: &[AddressEntry],
        alias_text: impl Fn(&str) -> Option<&'a str>,
    ) -> Option<Self> {
        let mut records = HashMap::with_capacity(entries.len());
        let mut by_suffix: HashMap<String, Vec<(String, [u8; 32])>> = HashMap::new();
        for entry in entries {
            let addr_key = hex32(&entry.addr_key)?;
            let record = Record { kind: entry.kind, enc_pk: hex32(&entry.enc_pk)?, auth_pk: hex32(&entry.auth_pk)? };
            if records.insert(addr_key, record).is_some() {
                return None;
            }
            if entry.kind == AddressKind::Alias {
                let text = alias_text(&entry.addr_key).filter(|text| alias_form(text))?;
                by_suffix.entry(suffix(text).to_owned()).or_default().push((text.to_owned(), addr_key));
            }
        }
        let (mut aliases, mut shared_suffix) = (HashMap::new(), HashSet::new());
        for group in by_suffix.into_values() {
            if let [(text, addr_key)] = group.as_slice() {
                aliases.insert(text.clone(), *addr_key);
            } else {
                shared_suffix.extend(group.into_iter().map(|(text, _)| text));
            }
        }
        Some(Self { block_height, block_timestamp, records, aliases, shared_suffix })
    }

    /// Is this state recent enough to trust a "not found" or a key from it, at `now_ms` (Unix ms)?
    pub fn check_age(&self, now_ms: i64) -> Result<(), DirectoryError> {
        let age = i128::from(now_ms) - i128::from(self.block_timestamp);
        if age > i128::from(MAX_STATE_AGE_MS) {
            Err(DirectoryError::RegistryStale)
        } else if age < -i128::from(MAX_CLOCK_BEHIND_MS) {
            Err(DirectoryError::Clock)
        } else {
            Ok(())
        }
    }

    /// The address `target` resolves to, if it can receive mail.
    pub fn lookup(&self, target: Target<'_>) -> Result<Found, DirectoryError> {
        let addr_key = match target {
            Target::Alias(text) if self.shared_suffix.contains(text) => return Err(DirectoryError::Unusable),
            Target::Alias(text) => *self.aliases.get(text).ok_or(DirectoryError::NotFound)?,
            Target::Mailbox(addr_key) => *addr_key,
        };
        let record = self.records.get(&addr_key).ok_or(DirectoryError::NotFound)?;
        let wanted = match target {
            Target::Alias(_) => AddressKind::Alias,
            Target::Mailbox(_) => AddressKind::Mailbox,
        };
        if record.kind != wanted {
            return Err(DirectoryError::NotFound);
        }
        if !is_usable_mailbox_public_key(&record.enc_pk) || !is_usable_auth_public_key(&record.auth_pk) {
            return Err(DirectoryError::Unusable);
        }
        Ok(Found { addr_key, enc_pk: record.enc_pk, auth_pk: record.auth_pk })
    }
}

/// A recipient found in the registry: its address as it must go in the mail (`local@domain`, lowercase) and its keys.
#[derive(Clone, PartialEq, Eq)]
pub struct Recipient {
    pub address: String,
    pub addr_key: [u8; 32],
    pub enc_pk: [u8; 32],
    pub auth_pk: [u8; 32],
}

/// Leaves the address and keys out of logs.
impl fmt::Debug for Recipient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Recipient(..)")
    }
}

/// The `resolve_sender` argument of `e2e::open_mail` / `open_mail_envelope`, from the answer of
/// `Orchestrator::resolve_sender` for the sender that the mail declares (`e2e::declared_sender`): the key only if it is
/// asked about exactly that `addr_key` and `address`, and [`SenderUnavailable`] if the registry could not answer, so
/// the mail is opened again later instead of being marked unverified.
pub fn sender_resolver<'a>(
    addr_key: &'a [u8; 32],
    address: &'a str,
    answer: Result<Option<[u8; 32]>, DirectoryError>,
) -> impl FnOnce(&[u8; 32], &str) -> SenderLookup + 'a {
    move |asked_key, asked_address| {
        if asked_key != addr_key || asked_address != address {
            return Ok(None);
        }
        answer.map_err(|_| SenderUnavailable)
    }
}

#[cfg(test)]
mod tests;
