//! Sending mail to NightMail addresses and the «Sent» folder, behind the Tauri commands. `mail::send::Outbox` does
//! the work; here the session gives it our keys and the registry, and the results become views for the UI.
//!
//! - `send_mail` answers an error (fixed code, [`SendError`]) only when nothing was stored or sent. Once stored, a
//!   refused delivery is the message's state (`failed` and its reason), to retry with `retry_sent`.
//! - Views carry the addresses, subject and body only to the UI; their `Debug` shows none of it.

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use zeroize::{Zeroize, Zeroizing};

use super::{AppError, CoreError, MAX_PAGE, Result, Secret, Session, check_len};
use crate::mail::directory::{DirectoryError, Recipient};
use crate::mail::e2e::{MAX_MAIL_LENGTH, MAX_SUBJECT_LENGTH};
use crate::mail::send::{OutboxError, SendContext, SendError};
use crate::orchestrator::sync_target;
use crate::store::{Address, SendFailure, SentFilter, SentState, SentSummary};

/// Longest recipient text accepted from the UI: an address takes at most 255 bytes, plus spaces around it.
const MAX_RECIPIENT_TEXT: usize = 512;

/// Delivery state of a sent message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub enum SentStatusView {
    /// Saved, not yet confirmed by the server (in flight, or left so by an app that closed: retry it).
    Queued,
    /// The server took it.
    Sent,
    /// Not delivered: see `failure`. It can be retried.
    Failed,
}

/// Why a delivery failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub enum SentFailureView {
    /// The address is not (or no longer) in the registry.
    NoRecipient,
    /// The recipient's keys cannot receive mail.
    RecipientKey,
    /// The recipient's mailbox is full.
    MailboxFull,
    /// Too many messages sent: wait until `retryAt`.
    RateLimited,
    /// Over the size the server accepts.
    TooLarge,
    /// The server could not be reached or did not answer in full.
    Network,
    /// The registry could not be read to check the recipient (here or on the server).
    ChainUnavailable,
    /// Anything else.
    Failed,
}

impl From<SendFailure> for SentFailureView {
    fn from(failure: SendFailure) -> Self {
        match failure {
            SendFailure::NoRecipient => Self::NoRecipient,
            SendFailure::RecipientKey => Self::RecipientKey,
            SendFailure::MailboxFull => Self::MailboxFull,
            SendFailure::RateLimited => Self::RateLimited,
            SendFailure::TooLarge => Self::TooLarge,
            SendFailure::Network => Self::Network,
            SendFailure::ChainUnavailable => Self::ChainUnavailable,
            SendFailure::Failed => Self::Failed,
        }
    }
}

/// A sent message in the list (no body).
#[derive(Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub struct SentView {
    #[ts(type = "number")]
    pub id: i64,
    /// The address it was sent from (`addrKey` in hex, as in `AddressView`).
    pub addr_key: String,
    pub from: String,
    pub to: String,
    pub subject: String,
    /// The date written in the mail (Unix seconds): the server's time when it was first sent.
    #[ts(type = "number")]
    pub sent_at: i64,
    pub status: SentStatusView,
    /// Set exactly when `status` is `failed`.
    pub failure: Option<SentFailureView>,
    /// While the server asked to wait (`rateLimited`, `chainUnavailable`): Unix seconds before which a retry does not
    /// go out. Kept only while the app is unlocked.
    #[ts(type = "number | null")]
    pub retry_at: Option<i64>,
}

impl SentView {
    fn new(summary: &SentSummary, retry_at: Option<i64>) -> Self {
        let (status, failure) = match summary.state {
            SentState::Queued => (SentStatusView::Queued, None),
            SentState::Sent => (SentStatusView::Sent, None),
            SentState::Failed(reason) => (SentStatusView::Failed, Some(reason.into())),
        };
        Self {
            id: summary.id,
            addr_key: hex::encode(summary.addr_key),
            from: summary.from_addr.clone(),
            to: summary.to_addr.clone(),
            subject: summary.subject.clone(),
            sent_at: summary.sent_at,
            status,
            failure,
            retry_at,
        }
    }
}

/// Leaves the addresses and the subject out of logs.
impl std::fmt::Debug for SentView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SentView")
            .field("id", &self.id)
            .field("status", &self.status)
            .field("failure", &self.failure)
            .finish_non_exhaustive()
    }
}

/// A sent message with its body. This copy of the body is wiped on drop (the one in the IPC response is not).
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub struct SentDetail {
    pub summary: SentView,
    pub body: String,
}

impl Drop for SentDetail {
    fn drop(&mut self) {
        self.body.zeroize();
    }
}

impl std::fmt::Debug for SentDetail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SentDetail").field("summary", &self.summary).finish_non_exhaustive()
    }
}

/// Which sent messages to list, newest first.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../../desktop/src/bindings/")]
pub struct SentQuery {
    /// Only those sent from this address (`addrKey` in hex).
    #[ts(optional)]
    pub addr_key: Option<String>,
    #[ts(optional)]
    pub limit: Option<u32>,
    pub offset: u32,
}

/// One of our `addrKey`s as the UI gives it (64 hex digits).
fn addr_key(text: &str) -> std::result::Result<[u8; 32], CoreError> {
    check_len(text, 2 * 32).map_err(|_| CoreError::InvalidInput)?;
    let mut key = [0u8; 32];
    hex::decode_to_slice(text, &mut key).map_err(|_| CoreError::InvalidInput)?;
    Ok(key)
}

impl SentQuery {
    pub fn filter(&self) -> std::result::Result<SentFilter, CoreError> {
        Ok(SentFilter {
            addr_key: self.addr_key.as_deref().map(addr_key).transpose()?,
            limit: Some(self.limit.unwrap_or(MAX_PAGE).min(MAX_PAGE)),
            offset: self.offset,
        })
    }
}

impl From<OutboxError> for AppError {
    fn from(error: OutboxError) -> Self {
        match error {
            OutboxError::Send(error) => AppError::Send(error),
            OutboxError::NotFound => AppError::Core(CoreError::NotFound),
            OutboxError::Store => AppError::Core(CoreError::Storage),
        }
    }
}

impl SendContext for Session {
    fn auth_seed(&self, address: &Address) -> Option<Zeroizing<[u8; 32]>> {
        sync_target(&self.keys, address).ok().map(|target| target.keys.auth_seed)
    }

    async fn resolve_recipient(&self, text: &str) -> std::result::Result<Recipient, DirectoryError> {
        let orchestrator = self.orchestrator().await.map_err(|_| DirectoryError::RegistryUnavailable)?;
        orchestrator.resolve_recipient(text).await
    }
}

impl Session {
    /// Sends a mail from our address `from_addr_key` (hex) to the NightMail address in `to_text`, and returns it as
    /// stored (`sent`, or `failed` with the reason). Errors only when nothing was stored or sent.
    pub async fn send_mail(
        &self,
        from_addr_key: String,
        to_text: String,
        subject: String,
        body: Secret,
    ) -> Result<SentView> {
        let from = addr_key(&from_addr_key)?;
        if to_text.len() > MAX_RECIPIENT_TEXT {
            return Err(SendError::RecipientInvalid.into());
        }
        if subject.len() > MAX_SUBJECT_LENGTH {
            return Err(SendError::SubjectInvalid.into());
        }
        if body.0.len() > MAX_MAIL_LENGTH {
            return Err(SendError::MessageTooLarge.into());
        }
        let _op = self.enter()?;
        let id = self.outbox.send(self, &from, &to_text, &subject, body.0).await?;
        self.sent_view(id).await
    }

    /// Delivers a message that is not `sent` again (same Message-ID and date) and returns its new state. Already
    /// sent, or the server asked to wait (`retryAt`): nothing goes out.
    pub async fn retry_sent(&self, id: i64) -> Result<SentView> {
        let _op = self.enter()?;
        self.outbox.retry(self, id).await?;
        self.sent_view(id).await
    }

    pub async fn list_sent(&self, query: SentQuery) -> Result<Vec<SentView>> {
        let filter = query.filter()?;
        let _op = self.enter()?;
        let list = self.store.with(move |s| s.list_sent(&filter)).await?;
        Ok(list.iter().map(|summary| SentView::new(summary, self.outbox.retry_at(summary.id))).collect())
    }

    /// How many are listed for that address (`addrKey` in hex), or for all.
    pub async fn count_sent(&self, addr_key_hex: Option<String>) -> Result<u64> {
        let key = addr_key_hex.as_deref().map(addr_key).transpose()?;
        let _op = self.enter()?;
        Ok(self.store.with(move |s| s.count_sent(key.as_ref())).await?)
    }

    pub async fn get_sent(&self, id: i64) -> Result<SentDetail> {
        let _op = self.enter()?;
        let message = self.store.with(move |s| s.get_sent(id)).await?.ok_or(CoreError::NotFound)?;
        let summary = SentView::new(&message.summary, self.outbox.retry_at(id));
        Ok(SentDetail { summary, body: message.body.as_str().to_owned() })
    }

    /// Deletes a sent message from this device for good.
    pub async fn delete_sent(&self, id: i64) -> Result<()> {
        let _op = self.enter()?;
        Ok(self.outbox.delete(id).await?)
    }

    async fn sent_view(&self, id: i64) -> Result<SentView> {
        let message = self.store.with(move |s| s.get_sent(id)).await?.ok_or(CoreError::NotFound)?;
        Ok(SentView::new(&message.summary, self.outbox.retry_at(id)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(state: SentState) -> SentSummary {
        SentSummary {
            id: 4,
            message_id: [9; 16],
            addr_key: [0xab; 32],
            from_addr: "alice@nightmail.local".into(),
            to_addr: "bob@nightmail.local".into(),
            subject: "Hola".into(),
            sent_at: 1_900_000_000,
            state,
        }
    }

    #[test]
    fn views_carry_state_and_reason_but_log_nothing_personal() {
        let failed = SentView::new(&summary(SentState::Failed(SendFailure::RateLimited)), Some(77));
        let json = serde_json::to_value(&failed).unwrap();
        assert_eq!(json["status"], "failed");
        assert_eq!(json["failure"], "rateLimited");
        assert_eq!(json["retryAt"], 77);
        assert_eq!(json["addrKey"], "ab".repeat(32));
        assert_eq!(json["sentAt"], 1_900_000_000);
        let sent = serde_json::to_value(SentView::new(&summary(SentState::Sent), None)).unwrap();
        assert_eq!((sent["status"].as_str(), sent["failure"].is_null()), (Some("sent"), true));

        let detail = SentDetail { summary: failed, body: "secreto".into() };
        let logged = format!("{detail:?}");
        assert!(!logged.contains("alice") && !logged.contains("bob") && !logged.contains("Hola"), "{logged}");
        assert!(!logged.contains("secreto"));
    }

    #[test]
    fn queries_are_checked_and_capped() {
        let all = SentQuery { limit: Some(10_000), ..Default::default() }.filter().unwrap();
        assert_eq!((all.addr_key, all.limit), (None, Some(MAX_PAGE)));
        let one = SentQuery { addr_key: Some("11".repeat(32)), ..Default::default() }.filter().unwrap();
        assert_eq!(one.addr_key, Some([0x11; 32]));
        for bad in ["zz".repeat(32), "11".repeat(31), "11".repeat(33)] {
            let query = SentQuery { addr_key: Some(bad), ..Default::default() };
            assert_eq!(query.filter().unwrap_err(), CoreError::InvalidInput);
        }
    }

    #[test]
    fn send_errors_reach_the_ui_as_their_own_codes() {
        let error = AppError::from(OutboxError::Send(SendError::RecipientForeignDomain));
        assert_eq!(serde_json::to_string(&error).unwrap(), r#"{"code":"recipientForeignDomain"}"#);
        assert_eq!(AppError::from(OutboxError::NotFound), AppError::Core(CoreError::NotFound));
        assert_eq!(AppError::from(OutboxError::Store), AppError::Core(CoreError::Storage));
    }
}
