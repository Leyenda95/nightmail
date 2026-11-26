//! Mail: mailbox API client ([`client`]), synchronisation ([`sync`]), MIME parsing ([`parser`]), end-to-end mail
//! between NightMail addresses ([`e2e`]) and what sync does with it ([`inbox`]), and looking those addresses up in the
//! registry ([`directory`]).
// `parser::parse` and `client::…::addr_key` are only used by tests; `directory` until sending is wired.
#![allow(dead_code)]

use std::time::Duration;

use crate::crypto::random_bytes;

pub mod client;
pub mod directory;
pub mod e2e;
pub mod inbox;
pub mod parser;
pub mod send;
pub mod sync;

#[cfg(test)]
pub(crate) mod fake_mailbox;
#[cfg(test)]
pub(crate) mod test_server;

/// Uniform random integer in `[0, bound)` (`bound` > 0; modulo bias is negligible).
pub(crate) fn random_below(bound: u64) -> u64 {
    u64::from_le_bytes(random_bytes()) % bound
}

/// Random duration in `[min, max]`, at millisecond resolution.
pub(crate) fn random_between(min: Duration, max: Duration) -> Duration {
    let spread = u64::try_from(max.saturating_sub(min).as_millis()).unwrap_or(u64::MAX);
    min + Duration::from_millis(random_below(spread.saturating_add(1)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_durations_stay_within_bounds() {
        let (min, max) = (Duration::from_millis(100), Duration::from_millis(300));
        for _ in 0..200 {
            assert!((min..=max).contains(&random_between(min, max)));
        }
        assert_eq!(random_between(Duration::ZERO, Duration::ZERO), Duration::ZERO);
        assert_eq!(random_between(max, min), max);
    }
}
