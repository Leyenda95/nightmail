//! Shared enums. The SQL texts (`'free'`, `'reserving'`…) live only here and in `schema.rs` (a test checks they
//! match).

use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSql, ToSqlOutput, ValueRef};
use serde::{Deserialize, Serialize};

/// 32-byte hash or key (`addrKey`, `slotNul`, bono `id`).
pub type Bytes32 = [u8; 32];

sql_enum!(
    /// Plan of a bono leaf.
    Plan { Free => "free", Paid => "paid" }
);

sql_enum!(
    /// Slot / address kind.
    SlotKind { Mailbox => "mailbox", Alias => "alias" }
);

sql_enum!(
    /// State of a requested bono leaf.
    BonoStatus { Requested => "requested", Included => "included" }
);

sql_enum!(
    /// State of a touched slot (free slots have no row). `reserving`: being registered (mailbox or alias, one
    /// transaction each). The `reserved` and `revealing` texts of the old two-step mailbox no longer exist (migration
    /// v5).
    SlotStatus {
        Reserving => "reserving",
        Used => "used",
        Burned => "burned",
    }
);

sql_enum!(
    /// Why a server message is given up on.
    SkipReason {
        Undecryptable => "undecryptable",
        TooLarge => "too-large",
        NotFound => "not-found",
        Unparseable => "unparseable",
        Failed => "failed",
    }
);

sql_enum!(
    /// Delivery state of a sent message (column `status`). The failure reason lives in its own column; the API
    /// joins both in [`SentState`](super::SentState).
    SentStatus { Queued => "queued", Sent => "sent", Failed => "failed" }
);

sql_enum!(
    /// Why a delivery failed, as a fixed code (never server text).
    SendFailure {
        // The address is not in the registry (`404`).
        NoRecipient => "no-recipient",
        // The recipient's keys cannot receive mail.
        RecipientKey => "recipient-key",
        // The recipient's mailbox is full (`507`).
        MailboxFull => "mailbox-full",
        // Too many messages sent (`429`).
        RateLimited => "rate-limited",
        // Over the size limit (`413`).
        TooLarge => "too-large",
        // The server could not be reached.
        Network => "network",
        // The chain state could not be read to check the recipient.
        ChainUnavailable => "chain-unavailable",
        // Anything else.
        Failed => "failed",
    }
);

impl SlotStatus {
    /// `used` and `burned` have no way out.
    pub fn is_final(self) -> bool {
        matches!(self, Self::Used | Self::Burned)
    }

    /// Normal flow transitions (mailbox and alias alike, one transaction each): `reserving → used | burned`.
    pub fn can_become(self, to: SlotStatus) -> bool {
        matches!((self, to), (Self::Reserving, Self::Used | Self::Burned))
    }

    /// `Recovery` transitions, which read the truth from the chain: from any non-final state to `used`/`burned`, and
    /// `burned → used` (believed burned, but the chain says used). `used → *` does not exist.
    pub fn reconcile_ok(self, to: SlotStatus) -> bool {
        self == to || (matches!(to, Self::Used | Self::Burned) && !self.is_final()) || (self == Self::Burned && to == Self::Used)
    }
}
