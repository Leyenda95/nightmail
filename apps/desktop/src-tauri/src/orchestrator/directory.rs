//! NightMail addresses looked up in the registry on this device (`mail::directory`): the recipient of a mail and the
//! sender of one received. The registry is the full contract state from the sidecar (`chain_view`, the same read as
//! `check_name`), kept in memory for a short while and never used once it is too old.

use std::collections::HashMap;
use std::sync::Arc;

use super::ports::{Chain, Issuer, Relayer};
use super::{OrchError, Orchestrator, bytes32};
use crate::mail::directory::{DirectoryError, LocalPart, Recipient, Registry, Target, parse_address};
use crate::protocol::{AddressKind, NameProblem};

/// A registry read is reused for this long (seconds) while it is still recent enough.
const CACHE_TTL_S: i64 = 30;
/// An address not found in a read older than this (seconds) is looked up again in a new one, so an address
/// registered a moment ago is found, without a full read for every unknown sender.
const RECHECK_AFTER_S: i64 = 5;

/// The last registry read and when it was made (Unix seconds).
pub(crate) struct CachedRegistry {
    registry: Arc<Registry>,
    fetched_at: i64,
}

/// An orchestrator error while reading the registry, as the UI sees it.
fn registry_error(error: OrchError) -> DirectoryError {
    match error {
        OrchError::StaleState => DirectoryError::RegistryStale,
        OrchError::Clock => DirectoryError::Clock,
        _ => DirectoryError::RegistryUnavailable,
    }
}

impl<C: Chain, I: Issuer, R: Relayer> Orchestrator<C, I, R> {
    /// The NightMail address in `text` and the keys to write to it, from the registry. Case and surrounding spaces do
    /// not matter; the address returned is the one to put in the mail.
    pub async fn resolve_recipient(&self, text: &str) -> Result<Recipient, DirectoryError> {
        let domain = self.d.config.mail_domain.to_ascii_lowercase();
        let (local, mailbox_key) = match parse_address(text, &domain)? {
            LocalPart::Alias(text) => (text, None),
            LocalPart::Mailbox(name) => {
                let (normalized, addr_key) = self.mailbox_key(&name).await?;
                (normalized, Some(addr_key))
            }
        };
        let target = match &mailbox_key {
            Some(addr_key) => Target::Mailbox(addr_key),
            None => Target::Alias(&local),
        };
        let registry = self.registry(CACHE_TTL_S).await?;
        let found = match registry.lookup(target) {
            Err(DirectoryError::NotFound) => self.registry(RECHECK_AFTER_S).await?.lookup(target),
            other => other,
        }?;
        Ok(Recipient {
            address: format!("{local}@{domain}"),
            addr_key: found.addr_key,
            enc_pk: found.enc_pk,
            auth_pk: found.auth_pk,
        })
    }

    /// The `authPk` of the sender of a received mail (`e2e::declared_sender`), only if `address` resolves exactly as
    /// [`Self::resolve_recipient`] would resolve it to send (domain exactly the configured one, alias by its full
    /// text, mailbox by `H(name)`, reserved names never), to this same `addr_key`, written byte for byte as the
    /// resolved address, and can receive mail: the address a reply would go to. `Ok(None)` if not (another domain
    /// included); an error only if the registry cannot answer (try again later rather than marking the mail
    /// unverified). With [`crate::mail::directory::sender_resolver`] it becomes the argument of `e2e::open_mail`.
    pub async fn resolve_sender(&self, addr_key: &[u8; 32], address: &str) -> Result<Option<[u8; 32]>, DirectoryError> {
        match self.resolve_recipient(address).await {
            Ok(found) => Ok((found.addr_key == *addr_key && found.address == address).then_some(found.auth_pk)),
            Err(error) if error.is_registry() => Err(error),
            Err(_) => Ok(None),
        }
    }

    /// Normalised mailbox name and its `addrKey`, hashed by the sidecar (as `check_name` does). A reserved name is
    /// nobody's address.
    async fn mailbox_key(&self, name: &str) -> Result<(String, [u8; 32]), DirectoryError> {
        match self.normalize(name).await {
            Ok((normalized, addr_key)) => {
                Ok((normalized, bytes32(&addr_key).map_err(|_| DirectoryError::RegistryUnavailable)?))
            }
            Err(OrchError::NameRejected { reason: NameProblem::Invalid }) => Err(DirectoryError::InvalidAddress),
            Err(OrchError::NameRejected { .. }) => Err(DirectoryError::NotFound),
            Err(error) => Err(registry_error(error)),
        }
    }

    /// The cached registry if it was read at most `max_age_s` seconds ago and is still recent; otherwise a new read.
    /// A read older than [`crate::mail::directory::MAX_STATE_AGE_MS`], or at a lower height than the cached one (the
    /// indexer went back), is not used: `RegistryStale`.
    async fn registry(&self, max_age_s: i64) -> Result<Arc<Registry>, DirectoryError> {
        // Held across the read: one registry read at a time (the sidecar keeps only the latest snapshot walk).
        let mut cache = self.directory.lock().await;
        let now = self.now();
        if let Some(cached) = cache.as_ref()
            && now.saturating_sub(cached.fetched_at) <= max_age_s
            && cached.registry.check_age(now.saturating_mul(1000)).is_ok()
        {
            return Ok(cached.registry.clone());
        }
        let view = self.chain_view().await.map_err(registry_error)?;
        let aliases: Vec<String> =
            view.addresses.iter().filter(|a| a.kind == AddressKind::Alias).map(|a| a.addr_key.clone()).collect();
        let texts = self.alias_texts(aliases.clone()).await.map_err(registry_error)?;
        let texts: HashMap<String, String> = aliases.into_iter().zip(texts).collect();
        let registry = Registry::new(view.block_height, view.block_timestamp, &view.addresses, |addr_key| {
            texts.get(addr_key).map(String::as_str)
        })
        .ok_or(DirectoryError::RegistryUnavailable)?;
        registry.check_age(self.now().saturating_mul(1000))?;
        if cache.as_ref().is_some_and(|cached| registry.block_height < cached.registry.block_height) {
            return Err(DirectoryError::RegistryStale);
        }
        let registry = Arc::new(registry);
        *cache = Some(CachedRegistry { registry: registry.clone(), fetched_at: now });
        Ok(registry)
    }
}

#[cfg(test)]
mod tests;
