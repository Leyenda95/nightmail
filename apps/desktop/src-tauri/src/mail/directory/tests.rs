use ed25519_dalek::SigningKey;
use x25519_dalek::{PublicKey, StaticSecret};

use super::*;

const DOMAIN: &str = "nightmail.local";
/// Block time of the test registries (Unix ms).
const BLOCK_MS: u64 = 1_800_000_000_000;

fn enc_pk(seed: u8) -> [u8; 32] {
    PublicKey::from(&StaticSecret::from([seed; 32])).to_bytes()
}

fn auth_pk(seed: u8) -> [u8; 32] {
    SigningKey::from_bytes(&[seed; 32]).verifying_key().to_bytes()
}

fn key(byte: u8) -> [u8; 32] {
    [byte; 32]
}

fn entry(addr_key: [u8; 32], kind: AddressKind, enc: [u8; 32], auth: [u8; 32]) -> AddressEntry {
    AddressEntry {
        addr_key: hex::encode(addr_key),
        enc_pk: hex::encode(enc),
        auth_pk: hex::encode(auth),
        kind,
        name_cipher: "00".repeat(104),
        slot_nul: hex::encode(addr_key),
    }
}

fn usable(addr_key: [u8; 32], kind: AddressKind) -> AddressEntry {
    entry(addr_key, kind, enc_pk(addr_key[0]), auth_pk(addr_key[0]))
}

/// Aliases 0xa1 (`nube.verde.k7m2q9xa4b3c`), 0xa2 and 0xa3 (both ending in `zzzzzzzzzzzz`); mailboxes 0xb1, 0xb2
/// (unusable `encPk`) and 0xb3 (unusable `authPk`).
fn registry() -> Registry {
    let entries = [
        usable(key(0xa1), AddressKind::Alias),
        usable(key(0xa2), AddressKind::Alias),
        usable(key(0xa3), AddressKind::Alias),
        usable(key(0xb1), AddressKind::Mailbox),
        entry(key(0xb2), AddressKind::Mailbox, [0; 32], auth_pk(0xb2)),
        entry(key(0xb3), AddressKind::Mailbox, enc_pk(0xb3), [0; 32]),
    ];
    let texts = HashMap::from([
        (hex::encode(key(0xa1)), "nube.verde.k7m2q9xa4b3c"),
        (hex::encode(key(0xa2)), "sol.luna.zzzzzzzzzzzz"),
        (hex::encode(key(0xa3)), "mar.rio.zzzzzzzzzzzz"),
    ]);
    Registry::new(7, BLOCK_MS, &entries, |k| texts.get(k).copied()).unwrap()
}

fn found(addr_key: [u8; 32]) -> Found {
    Found { addr_key, enc_pk: enc_pk(addr_key[0]), auth_pk: auth_pk(addr_key[0]) }
}

#[test]
fn addresses_are_parsed_case_and_spaces_aside() {
    let mailbox = |name: &str| Ok(LocalPart::Mailbox(name.into()));
    assert_eq!(parse_address("juan@nightmail.local", DOMAIN), mailbox("juan"));
    assert_eq!(parse_address("  Juan.Perez@NightMail.LOCAL \t\n", DOMAIN), mailbox("juan.perez"));
    assert_eq!(parse_address("juan@nightmail.local", "NightMail.Local"), mailbox("juan"));
    assert_eq!(
        parse_address("Nube.Verde.K7M2Q9XA4B3C@nightmail.local", DOMAIN),
        Ok(LocalPart::Alias("nube.verde.k7m2q9xa4b3c".into()))
    );
    // Alias-shaped, even if no alias has that text: it is never looked up as a mailbox.
    let alias_shaped = parse_address("juan.abcdefghijkl@nightmail.local", DOMAIN);
    assert_eq!(alias_shaped, Ok(LocalPart::Alias("juan.abcdefghijkl".into())));
    assert_eq!(parse_address(&format!("{}@nightmail.local", "a".repeat(64)), DOMAIN), mailbox(&"a".repeat(64)));
}

#[test]
fn malformed_addresses_are_invalid() {
    for text in [
        "",
        "   ",
        "juan",
        "juan@",
        "@nightmail.local",
        "juan@@nightmail.local",
        "juan@nightmail.local@nightmail.local",
        "ju an@nightmail.local",
        "juan+news@nightmail.local",
        "juán@nightmail.local",
        // The Kelvin sign is not an ASCII k, before or after lowercasing.
        "\u{212a}im@nightmail.local",
        "juan\u{0}@nightmail.local",
        "\"juan\"@nightmail.local",
    ] {
        assert_eq!(parse_address(text, DOMAIN), Err(DirectoryError::InvalidAddress), "{text:?}");
    }
    let too_long = format!("{}@nightmail.local", "a".repeat(65));
    assert_eq!(parse_address(&too_long, DOMAIN), Err(DirectoryError::InvalidAddress));
}

#[test]
fn other_domains_are_foreign() {
    for text in ["juan@gmail.com", "juan@nightmail.local.evil", "juan@sub.nightmail.local", "juan@nightmail"] {
        assert_eq!(parse_address(text, DOMAIN), Err(DirectoryError::ForeignDomain), "{text}");
    }
}

#[test]
fn an_alias_resolves_by_its_full_text_only() {
    let r = registry();
    assert_eq!(r.lookup(Target::Alias("nube.verde.k7m2q9xa4b3c")), Ok(found(key(0xa1))));
    // Same suffix, other words: not that alias.
    assert_eq!(r.lookup(Target::Alias("cielo.azul.k7m2q9xa4b3c")), Err(DirectoryError::NotFound));
    assert_eq!(r.lookup(Target::Alias("nube.verde.k7m2q9xa4b3d")), Err(DirectoryError::NotFound));
    // An alias's addrKey looked up as a mailbox is not a mailbox.
    assert_eq!(r.lookup(Target::Mailbox(&key(0xa1))), Err(DirectoryError::NotFound));
}

#[test]
fn a_suffix_shared_by_two_aliases_resolves_to_neither() {
    let r = registry();
    assert_eq!(r.lookup(Target::Alias("sol.luna.zzzzzzzzzzzz")), Err(DirectoryError::Unusable));
    assert_eq!(r.lookup(Target::Alias("mar.rio.zzzzzzzzzzzz")), Err(DirectoryError::Unusable));
    assert_eq!(r.lookup(Target::Alias("otro.mas.zzzzzzzzzzzz")), Err(DirectoryError::NotFound));
}

#[test]
fn a_mailbox_resolves_by_its_addr_key() {
    let r = registry();
    assert_eq!(r.lookup(Target::Mailbox(&key(0xb1))), Ok(found(key(0xb1))));
    assert_eq!(r.lookup(Target::Mailbox(&key(0xc1))), Err(DirectoryError::NotFound));
}

#[test]
fn unusable_keys_cannot_be_written_to() {
    let r = registry();
    assert_eq!(r.lookup(Target::Mailbox(&key(0xb2))), Err(DirectoryError::Unusable), "low-order encPk");
    assert_eq!(r.lookup(Target::Mailbox(&key(0xb3))), Err(DirectoryError::Unusable), "low-order authPk");
}

#[test]
fn a_malformed_state_is_not_used() {
    let texts = |_: &str| Some("nube.verde.k7m2q9xa4b3c");
    let good = usable(key(0xa1), AddressKind::Alias);
    let bad_hex = AddressEntry { enc_pk: "zz".repeat(32), ..good.clone() };
    let short = AddressEntry { addr_key: "a1".repeat(31), ..good.clone() };
    for entries in [vec![bad_hex], vec![short], vec![good.clone(), good.clone()]] {
        assert!(Registry::new(1, BLOCK_MS, &entries, texts).is_none());
    }
    assert!(Registry::new(1, BLOCK_MS, std::slice::from_ref(&good), |_| None).is_none(), "an alias with no text");
    assert!(Registry::new(1, BLOCK_MS, &[good], |_| Some("juan")).is_none(), "an alias text not alias-shaped");
    assert!(Registry::new(1, BLOCK_MS, &[], texts).is_some());
}

#[test]
fn an_old_state_or_one_from_the_future_is_refused() {
    let r = registry();
    let now = i64::try_from(BLOCK_MS).unwrap();
    assert_eq!(r.check_age(now), Ok(()));
    assert_eq!(r.check_age(now + MAX_STATE_AGE_MS), Ok(()));
    assert_eq!(r.check_age(now + MAX_STATE_AGE_MS + 1), Err(DirectoryError::RegistryStale));
    assert_eq!(r.check_age(now - MAX_CLOCK_BEHIND_MS), Ok(()));
    assert_eq!(r.check_age(now - MAX_CLOCK_BEHIND_MS - 1), Err(DirectoryError::Clock));
    assert_eq!(r.check_age(i64::MAX), Err(DirectoryError::RegistryStale));
    assert_eq!(r.check_age(i64::MIN), Err(DirectoryError::Clock));
}

#[test]
fn the_sender_resolver_answers_only_for_that_sender() {
    let (addr_key, auth) = (key(0xa1), auth_pk(0xa1));
    let address = "nube.verde.k7m2q9xa4b3c@nightmail.local";
    let found = || Ok(Some(auth));
    assert_eq!(sender_resolver(&addr_key, address, found())(&addr_key, address), Ok(Some(auth)));
    assert_eq!(sender_resolver(&addr_key, address, found())(&key(0xa2), address), Ok(None));
    assert_eq!(sender_resolver(&addr_key, address, found())(&addr_key, "juan@nightmail.local"), Ok(None));
    assert_eq!(sender_resolver(&addr_key, address, Ok(None))(&addr_key, address), Ok(None));
    // A registry that could not answer: try again later, for that sender only.
    let stale = || Err(DirectoryError::RegistryStale);
    assert_eq!(sender_resolver(&addr_key, address, stale())(&addr_key, address), Err(SenderUnavailable));
    assert_eq!(sender_resolver(&addr_key, address, stale())(&key(0xa2), address), Ok(None));
}

#[test]
fn errors_and_lookups_keep_addresses_and_keys_out_of_logs() {
    let r = registry();
    let recipient = Recipient {
        address: "juan@nightmail.local".into(),
        addr_key: key(0xb1),
        enc_pk: enc_pk(0xb1),
        auth_pk: auth_pk(0xb1),
    };
    let logged = format!(
        "{recipient:?} {:?} {r:?} {:?}",
        r.lookup(Target::Mailbox(&key(0xb1))),
        parse_address("juan@nightmail.local", DOMAIN)
    );
    assert!(!logged.contains("juan") && !logged.contains(&hex::encode(key(0xb1))), "{logged}");
    assert!(!logged.contains(&hex::encode(enc_pk(0xb1))) && !logged.contains(&hex::encode(auth_pk(0xb1))));
    let codes = serde_json::to_string(&[DirectoryError::NotFound, DirectoryError::RegistryStale]).unwrap();
    assert_eq!(codes, r#"[{"code":"notFound"},{"code":"registryStale"}]"#);
    assert!(DirectoryError::Clock.is_registry() && !DirectoryError::Unusable.is_registry());
}
