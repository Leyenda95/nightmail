//! Sending a mail to a NightMail address (`nightmail:e2e`, README §4.3) and keeping it in the local «Sent» store.
//!
//! [`Outbox::send`]:
//! 1. The sending address must be one of ours and not abandoned; subject and body within the format's limits.
//! 2. The recipient is looked up in the registry on this device ([`SendContext::resolve_recipient`], that is
//!    `Orchestrator::resolve_recipient`): nobody is asked which address we are after.
//! 3. The date is the sending address's server time (`GET /v1/time` in a session of its own, `mail::client`), never
//!    the local clock: a clock offset shared by all of a user's addresses would link them. Without it nothing is sent.
//! 4. The mail is signed with the sending address's auth key and sealed to the recipient's `encPk`
//!    (`e2e::seal_mail`), with a random Message-ID.
//! 5. It is saved as `queued` before anything goes out for delivery.
//! 6. Delivery is anonymous (`MailboxClient::deliver`): no signature, no header that says who sends, the app's only
//!    HTTP path (`Transport`: fixed `User-Agent`, no cookies, no redirects, deadlines, one connection per request).
//! 7. The answer becomes the stored state ([`outcome`]). Only a `200` makes it `sent`.
//!
//! [`Outbox::retry`] signs and seals the same Message-ID and date again (a new envelope: fresh ephemeral key and
//! nonce) and delivers it; the recipient keeps one mail per sender and Message-ID, so a mail delivered twice shows
//! once. A message is delivered by one call at a time.
//!
//! Errors are fixed codes ([`SendError`]): never an address, a subject, a body or server text, and nothing is logged.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use ts_rs::TS;
use zeroize::Zeroizing;

use super::client::{MailboxClient, local_now};
use super::directory::{DirectoryError, Recipient};
use super::e2e::{
    self, FIXED_LENGTH, MAX_DATE, MAX_MAIL_LENGTH, MESSAGE_ID_LENGTH, MailBuildError, MailField, OutgoingMail, Party,
};
use crate::crypto::random_bytes;
use crate::store::{
    Address, LocalStore, NewSentMessage, SendFailure, SentInsert, SentMessage, SentState, StoreError,
};
use crate::transport::{HttpResponse, TransportError};

/// Why a mail was not sent. Nothing was stored and nothing went out for delivery. Fixed codes for the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "code", rename_all = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub enum SendError {
    /// The sending address is not one of ours, has been abandoned, or has no full address yet (a restored mailbox
    /// still without its name).
    SenderUnavailable,
    /// The subject is too long or has a character a subject cannot have (a line break, a hidden character).
    SubjectInvalid,
    /// The body has a character a body cannot have (a control or hidden character).
    BodyInvalid,
    /// The mail is larger than 25 MiB.
    MessageTooLarge,
    /// The recipient is not an address.
    RecipientInvalid,
    /// An address outside NightMail: for now only NightMail addresses can be written to.
    RecipientForeignDomain,
    /// No such NightMail address.
    RecipientNotFound,
    /// The address exists but cannot receive mail.
    RecipientUnusable,
    /// The registry cannot be read right now (Midnight, the indexer or the sidecar not answering).
    RegistryUnavailable,
    /// The registry read is too old to trust.
    RegistryStale,
    /// The registry is ahead of the system clock: check the time.
    RegistryClock,
    /// The server's time could not be obtained, and a mail is never dated with the local clock.
    ServerTimeUnavailable,
}

impl std::fmt::Display for SendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "send error: {self:?}")
    }
}

impl std::error::Error for SendError {}

impl From<DirectoryError> for SendError {
    fn from(error: DirectoryError) -> Self {
        match error {
            DirectoryError::InvalidAddress => Self::RecipientInvalid,
            DirectoryError::ForeignDomain => Self::RecipientForeignDomain,
            DirectoryError::NotFound => Self::RecipientNotFound,
            DirectoryError::Unusable => Self::RecipientUnusable,
            DirectoryError::RegistryUnavailable => Self::RegistryUnavailable,
            DirectoryError::RegistryStale => Self::RegistryStale,
            DirectoryError::Clock => Self::RegistryClock,
        }
    }
}

/// An [`Outbox`] call that failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutboxError {
    Send(SendError),
    /// No such sent message (or it belongs to an abandoned address).
    NotFound,
    Store,
}

impl From<SendError> for OutboxError {
    fn from(error: SendError) -> Self {
        Self::Send(error)
    }
}

impl From<StoreError> for OutboxError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::NotFound => Self::NotFound,
            _ => Self::Store,
        }
    }
}

type Result<T> = std::result::Result<T, OutboxError>;

/// A recipient looked up in the registry.
pub type Lookup = std::result::Result<Recipient, DirectoryError>;

/// What sending needs from the session: our keys and the registry.
pub trait SendContext: Sync {
    /// The auth seed of one of our addresses (derived from the seed phrase).
    fn auth_seed(&self, address: &Address) -> Option<Zeroizing<[u8; 32]>>;

    /// `Orchestrator::resolve_recipient`. If the registry cannot be read at all (Midnight not started),
    /// `RegistryUnavailable`.
    fn resolve_recipient(&self, text: &str) -> impl Future<Output = Lookup> + Send;
}

/// The stored state a delivery answer leads to, and the `Retry-After` (seconds) of a refusal that gives one.
///
/// | Answer | State |
/// |---|---|
/// | `200` | `sent` |
/// | `404` | `failed` `no-recipient` |
/// | `429` | `failed` `rate-limited` (with `Retry-After`) |
/// | `507` | `failed` `mailbox-full` |
/// | `413` | `failed` `too-large` |
/// | `503` | `failed` `chain-unavailable` (with `Retry-After`): the server cannot check the box now |
/// | `502`, `504` (a proxy without the server behind) | `failed` `network` |
/// | `400`, a redirect, anything else | `failed` `failed` |
/// | no answer, deadline, answer cut short | `failed` `network` |
///
/// Every failure can be retried ([`Outbox::retry`]); `network` is the one expected to go away by itself. A `200` whose
/// body is cut short stays `network`: the mail may have arrived, and a retry is harmless (same Message-ID).
pub fn outcome(answer: std::result::Result<HttpResponse, TransportError>) -> (SentState, Option<u64>) {
    let response = match answer {
        Ok(response) => response,
        Err(TransportError::BadUrl) => return (SentState::Failed(SendFailure::Failed), None),
        Err(_) => return (SentState::Failed(SendFailure::Network), None),
    };
    let reason = match response.status {
        200 => return (SentState::Sent, None),
        404 => SendFailure::NoRecipient,
        429 => SendFailure::RateLimited,
        507 => SendFailure::MailboxFull,
        413 => SendFailure::TooLarge,
        503 => SendFailure::ChainUnavailable,
        502 | 504 => SendFailure::Network,
        _ => SendFailure::Failed,
    };
    let waits = matches!(reason, SendFailure::RateLimited | SendFailure::ChainUnavailable);
    (SentState::Failed(reason), response.retry_after.filter(|_| waits))
}

/// The failure a retry stores when the recipient cannot be looked up again.
fn lookup_failure(error: DirectoryError) -> SendFailure {
    match error {
        DirectoryError::InvalidAddress | DirectoryError::ForeignDomain | DirectoryError::NotFound => {
            SendFailure::NoRecipient
        }
        DirectoryError::Unusable => SendFailure::RecipientKey,
        DirectoryError::RegistryUnavailable | DirectoryError::RegistryStale | DirectoryError::Clock => {
            SendFailure::ChainUnavailable
        }
    }
}

/// A mail the format refuses, as the user sees it. The body is the only field without a limit of its own, so a body
/// refusal is "too large" when the whole mail would be over [`MAX_MAIL_LENGTH`].
fn build_error(error: MailBuildError, mail: &OutgoingMail<'_>) -> SendError {
    match error {
        MailBuildError::Field(MailField::Sender) => SendError::SenderUnavailable,
        MailBuildError::Field(MailField::Recipient) => SendError::RecipientInvalid,
        MailBuildError::Field(MailField::Subject) => SendError::SubjectInvalid,
        MailBuildError::Field(MailField::Body) => {
            let length = [mail.sender.address.len(), mail.recipient.address.len(), mail.subject.len(), mail.body.len()]
                .into_iter()
                .fold(FIXED_LENGTH, usize::saturating_add);
            if length > MAX_MAIL_LENGTH { SendError::MessageTooLarge } else { SendError::BodyInvalid }
        }
        MailBuildError::Field(MailField::Date | MailField::MessageId) => SendError::ServerTimeUnavailable,
        MailBuildError::RecipientKey => SendError::RecipientUnusable,
    }
}

/// One delivery per Message-ID at a time: a second call for the same message waits for the first, then sees what it
/// left (a `sent` message is not delivered again).
#[derive(Default)]
struct MessageLocks(Mutex<HashMap<[u8; MESSAGE_ID_LENGTH], Arc<tokio::sync::Mutex<()>>>>);

struct MessageGuard<'a> {
    locks: &'a MessageLocks,
    key: [u8; MESSAGE_ID_LENGTH],
    lock: Arc<tokio::sync::Mutex<()>>,
    guard: Option<tokio::sync::OwnedMutexGuard<()>>,
}

impl MessageLocks {
    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<[u8; MESSAGE_ID_LENGTH], Arc<tokio::sync::Mutex<()>>>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    async fn lock(&self, key: [u8; MESSAGE_ID_LENGTH]) -> MessageGuard<'_> {
        let lock = Arc::clone(self.map().entry(key).or_default());
        let guard = Arc::clone(&lock).lock_owned().await;
        MessageGuard { locks: self, key, lock, guard: Some(guard) }
    }
}

impl Drop for MessageGuard<'_> {
    fn drop(&mut self) {
        self.guard.take();
        let mut map = self.locks.map();
        // Only the map and this guard hold it: nobody is waiting, so the entry goes.
        if Arc::strong_count(&self.lock) == 2 {
            map.remove(&self.key);
        }
    }
}

/// Sends mail and keeps the «Sent» store's delivery states.
pub struct Outbox {
    client: MailboxClient,
    store: Arc<LocalStore>,
    in_flight: MessageLocks,
    /// When a refused message may go out again (local Unix seconds), from the refusal's `Retry-After`. In memory
    /// only: the sent store has no column for it, so it does not outlive the session.
    retry_at: Mutex<HashMap<i64, i64>>,
}

impl Outbox {
    pub fn new(client: MailboxClient, store: Arc<LocalStore>) -> Self {
        Self { client, store, in_flight: MessageLocks::default(), retry_at: Mutex::default() }
    }

    fn retry_map(&self) -> std::sync::MutexGuard<'_, HashMap<i64, i64>> {
        self.retry_at.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Until when (local Unix seconds) a retry of this message is not sent, after a refusal that said so.
    pub fn retry_at(&self, id: i64) -> Option<i64> {
        let mut map = self.retry_map();
        match map.get(&id) {
            Some(&at) if at > local_now() => Some(at),
            Some(_) => {
                map.remove(&id);
                None
            }
            None => None,
        }
    }

    /// Sends a mail from our address `from` (its `addrKey`) to the address written in `to`, and returns the id of the
    /// stored message. An `Err` means that nothing was stored or delivered; once stored, a refused delivery is not an
    /// error but the message's state (`failed` and its reason), to retry with [`Self::retry`].
    pub async fn send(
        &self,
        ctx: &impl SendContext,
        from: &[u8; 32],
        to: &str,
        subject: &str,
        body: Zeroizing<String>,
    ) -> Result<i64> {
        let (sender, auth_seed) = self.sender(ctx, from).await?;
        let draft = OutgoingMail {
            message_id: [0; MESSAGE_ID_LENGTH],
            date: 0,
            sender: Party { addr_key: *from, address: &sender.display },
            // A stand-in until the recipient is known: the format checks it again with the real one.
            recipient: Party { addr_key: *from, address: &sender.display },
            subject,
            body: &body,
        };
        e2e::check_mail(&draft).map_err(|error| build_error(error, &draft))?;

        let recipient = ctx.resolve_recipient(to).await.map_err(SendError::from)?;
        let date = self.server_time(from, &auth_seed).await?;
        let message_id: [u8; MESSAGE_ID_LENGTH] = random_bytes();
        let mail = OutgoingMail {
            message_id,
            date,
            sender: Party { addr_key: *from, address: &sender.display },
            recipient: Party { addr_key: recipient.addr_key, address: &recipient.address },
            subject,
            body: &body,
        };
        let envelope =
            e2e::seal_mail(&auth_seed, &recipient.enc_pk, &mail).map_err(|error| build_error(error, &mail))?;

        let _delivering = self.in_flight.lock(message_id).await;
        let new = NewSentMessage {
            message_id,
            addr_key: *from,
            from_addr: sender.display.clone(),
            to_addr: recipient.address.clone(),
            subject: subject.to_owned(),
            body,
            sent_at: i64::try_from(date).map_err(|_| SendError::ServerTimeUnavailable)?,
        };
        let id = match self.store.with(move |s| s.insert_sent(&new)).await {
            Ok(SentInsert::New(id)) => id,
            // The address was abandoned a moment ago.
            Err(StoreError::NotFound) => return Err(SendError::SenderUnavailable.into()),
            // A fresh random Message-ID is never already there.
            Ok(SentInsert::Existing(_)) | Err(_) => return Err(OutboxError::Store),
        };
        self.deliver(id, &recipient.addr_key, envelope).await?;
        Ok(id)
    }

    /// Delivers a stored message that is not `sent` again: the same Message-ID, date, subject and body, signed and
    /// sealed anew to the recipient's key, looked up again. Already `sent`, or refused with a `Retry-After` that has
    /// not run out ([`Self::retry_at`]): nothing goes out. If the recipient cannot be looked up now, the message stays
    /// `failed` with the reason. `NotFound` if there is no such message.
    pub async fn retry(&self, ctx: &impl SendContext, id: i64) -> Result<()> {
        let message_id = self.message_id(id).await?;
        let _delivering = self.in_flight.lock(message_id).await;
        // Read again under the lock: another call may have delivered it meanwhile.
        let sent = self.store.with(move |s| s.get_sent(id)).await?.ok_or(OutboxError::NotFound)?;
        if sent.summary.state == SentState::Sent || self.retry_at(id).is_some() {
            return Ok(());
        }
        let (_, auth_seed) = self.sender(ctx, &sent.summary.addr_key).await?;
        let recipient = match ctx.resolve_recipient(&sent.summary.to_addr).await {
            Ok(recipient) if recipient.address == sent.summary.to_addr => recipient,
            Ok(_) => return self.set_state(id, SentState::Failed(SendFailure::NoRecipient)).await,
            Err(error) => return self.set_state(id, SentState::Failed(lookup_failure(error))).await,
        };
        let envelope = match seal_again(&sent, &auth_seed, &recipient) {
            Ok(envelope) => envelope,
            Err(reason) => return self.set_state(id, SentState::Failed(reason)).await,
        };
        self.set_state(id, SentState::Queued).await?;
        self.deliver(id, &recipient.addr_key, envelope).await
    }

    /// Deletes a sent message from this device, after any delivery of it in flight. `NotFound` if there is none.
    pub async fn delete(&self, id: i64) -> Result<()> {
        let message_id = self.message_id(id).await?;
        let _delivering = self.in_flight.lock(message_id).await;
        self.store.with(move |s| s.delete_sent(id)).await?;
        self.retry_map().remove(&id);
        Ok(())
    }

    async fn message_id(&self, id: i64) -> Result<[u8; MESSAGE_ID_LENGTH]> {
        let summary = self.store.with(move |s| s.get_sent(id)).await?.ok_or(OutboxError::NotFound)?;
        Ok(summary.summary.message_id)
    }

    /// Our address `addr_key`, if it is not abandoned, with its auth seed.
    async fn sender(&self, ctx: &impl SendContext, addr_key: &[u8; 32]) -> Result<(Address, Zeroizing<[u8; 32]>)> {
        let key = *addr_key;
        let address = self
            .store
            .with(move |s| match s.get_address(&key)? {
                Some(address) if !s.is_address_abandoned(&key)? => Ok(Some(address)),
                _ => Ok(None),
            })
            .await?
            .ok_or(SendError::SenderUnavailable)?;
        let auth_seed = ctx.auth_seed(&address).ok_or(SendError::SenderUnavailable)?;
        Ok((address, auth_seed))
    }

    /// The sending address's server time, from a session of its own (README §4.3).
    async fn server_time(&self, addr_key: &[u8; 32], auth_seed: &[u8; 32]) -> Result<u64> {
        let session =
            self.client.open_session(addr_key, auth_seed).await.map_err(|_| SendError::ServerTimeUnavailable)?;
        Some(session.now()).filter(|&now| now <= MAX_DATE).ok_or(OutboxError::Send(SendError::ServerTimeUnavailable))
    }

    async fn set_state(&self, id: i64, state: SentState) -> Result<()> {
        Ok(self.store.with(move |s| s.set_sent_state(id, state)).await?)
    }

    /// Hands the envelope to the server and stores what it answered.
    async fn deliver(&self, id: i64, recipient: &[u8; 32], envelope: Vec<u8>) -> Result<()> {
        let (state, retry_after) = outcome(self.client.deliver(recipient, envelope).await);
        self.set_state(id, state).await?;
        let mut retry = self.retry_map();
        match retry_after {
            Some(seconds) => retry.insert(id, local_now().saturating_add_unsigned(seconds)),
            None => retry.remove(&id),
        };
        Ok(())
    }
}

/// The stored message as the same mail again (Message-ID, date, sender text as first sent), sealed to `recipient`;
/// the failure to store if the format refuses it now.
fn seal_again(
    sent: &SentMessage,
    auth_seed: &[u8; 32],
    recipient: &Recipient,
) -> std::result::Result<Vec<u8>, SendFailure> {
    let summary = &sent.summary;
    let mail = OutgoingMail {
        message_id: summary.message_id,
        date: u64::try_from(summary.sent_at).map_err(|_| SendFailure::Failed)?,
        sender: Party { addr_key: summary.addr_key, address: &summary.from_addr },
        recipient: Party { addr_key: recipient.addr_key, address: &recipient.address },
        subject: &summary.subject,
        body: &sent.body,
    };
    e2e::seal_mail(auth_seed, &recipient.enc_pk, &mail).map_err(|error| match error {
        MailBuildError::RecipientKey => SendFailure::RecipientKey,
        MailBuildError::Field(_) => SendFailure::Failed,
    })
}

#[cfg(test)]
mod tests;
