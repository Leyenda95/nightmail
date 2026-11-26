//! Looking addresses up through the orchestrator, against the doubles in `fakes.rs` (fake hashes: an alias's text is
//! `nube.verde.` plus the first 12 hex characters of its `addrKey`).

use std::sync::atomic::Ordering;

use ed25519_dalek::SigningKey;
use x25519_dalek::{PublicKey, StaticSecret};

use super::super::fakes::*;
use crate::crypto::open_envelope;
use crate::crypto::test_vectors::{array, bytes, items, load, text};
use crate::mail::directory::{DirectoryError, Recipient, sender_resolver};
use crate::mail::e2e::{MailOpenError, Party, ReceivedMail, declared_sender, open_mail, open_mail_envelope};
use crate::orchestrator::addresses::alias_form;
use crate::protocol::{AddressEntry, AddressKind, HashOp, codes};

const ALIAS: &str = "nube.verde.a1a1a1a1a1a1@nightmail.local";

fn enc_pk(seed: u8) -> [u8; 32] {
    PublicKey::from(&StaticSecret::from([seed; 32])).to_bytes()
}

fn auth_pk(seed: u8) -> [u8; 32] {
    SigningKey::from_bytes(&[seed; 32]).verifying_key().to_bytes()
}

fn entry(addr_key: &str, kind: AddressKind, seed: u8) -> AddressEntry {
    AddressEntry {
        addr_key: addr_key.into(),
        enc_pk: hex::encode(enc_pk(seed)),
        auth_pk: hex::encode(auth_pk(seed)),
        kind,
        name_cipher: "00".repeat(104),
        slot_nul: hex::encode([seed; 32]),
    }
}

fn set(h: &Harness, f: impl FnOnce(&mut World)) {
    f(&mut h.world.lock().unwrap());
}

/// Seconds since the harness started; the registry's block is at its start time.
fn advance(h: &Harness, seconds: i64) {
    h.env.now.fetch_add(seconds, Ordering::SeqCst);
}

async fn mailbox_key(h: &Harness, name: &str) -> String {
    h.orch.hash(HashOp::AddrKey { name: name.into() }).await.unwrap()
}

/// A registry read now (block time = the fake clock) with the mailbox `juan` (seed 1) and the alias 0xa1 (seed 2).
async fn setup() -> Harness {
    let h = harness().await;
    let juan = mailbox_key(&h, "juan").await;
    set(&h, |w| {
        w.block_time_ms = START * 1000;
        w.addresses.push(entry(&juan, AddressKind::Mailbox, 1));
        w.addresses.push(entry(&"a1".repeat(32), AddressKind::Alias, 2));
    });
    h
}

fn walks(h: &Harness) -> usize {
    h.calls("contract.snapshot")
}

#[tokio::test]
async fn a_mailbox_and_an_alias_are_found_with_their_keys() {
    let h = setup().await;
    let juan = mailbox_key(&h, "juan").await;
    let expected = Recipient {
        address: "juan@nightmail.local".into(),
        addr_key: crate::orchestrator::bytes32(&juan).unwrap(),
        enc_pk: enc_pk(1),
        auth_pk: auth_pk(1),
    };
    assert_eq!(h.orch.resolve_recipient("juan@nightmail.local").await, Ok(expected.clone()));
    assert_eq!(h.orch.resolve_recipient("  Juan@NightMail.Local\n").await, Ok(expected), "case and spaces");
    let alias = h.orch.resolve_recipient(&ALIAS.to_uppercase()).await.unwrap();
    assert_eq!((alias.address.as_str(), alias.addr_key, alias.enc_pk), (ALIAS, [0xa1; 32], enc_pk(2)));
}

#[tokio::test]
async fn addresses_that_are_not_registered_or_not_nightmail_are_refused() {
    let h = setup().await;
    for (text, error) in [
        ("juan@gmail.com", DirectoryError::ForeignDomain),
        ("juan", DirectoryError::InvalidAddress),
        ("ju an@nightmail.local", DirectoryError::InvalidAddress),
    ] {
        assert_eq!(h.orch.resolve_recipient(text).await, Err(error), "{text}");
    }
    assert_eq!((walks(&h), h.calls("contract.hashes")), (0, 1), "decided before asking the sidecar");
    for (text, error) in [
        ("nadie@nightmail.local", DirectoryError::NotFound),
        // Rejected by the sidecar's name rules.
        ("ju..an@nightmail.local", DirectoryError::InvalidAddress),
        // Reserved: nobody receives mail as `admin`.
        ("admin@nightmail.local", DirectoryError::NotFound),
        // Other words with the alias's suffix, and an alias-shaped text no alias has.
        ("otra.nube.a1a1a1a1a1a1@nightmail.local", DirectoryError::NotFound),
        ("juan.b1b1b1b1b1b1@nightmail.local", DirectoryError::NotFound),
    ] {
        assert_eq!(h.orch.resolve_recipient(text).await, Err(error), "{text}");
    }
}

#[tokio::test]
async fn an_address_with_an_unusable_key_cannot_be_written_to() {
    let h = setup().await;
    let eva = mailbox_key(&h, "eva").await;
    set(&h, |w| w.addresses.push(AddressEntry { enc_pk: "00".repeat(32), ..entry(&eva, AddressKind::Mailbox, 3) }));
    assert_eq!(h.orch.resolve_recipient("eva@nightmail.local").await, Err(DirectoryError::Unusable));
}

#[tokio::test]
async fn an_old_registry_is_not_used() {
    let h = setup().await;
    set(&h, |w| w.block_time_ms = (START - 121) * 1000);
    assert_eq!(h.orch.resolve_recipient("juan@nightmail.local").await, Err(DirectoryError::RegistryStale));
    set(&h, |w| w.block_time_ms = (START + 61) * 1000);
    assert_eq!(h.orch.resolve_recipient("juan@nightmail.local").await, Err(DirectoryError::Clock));
    set(&h, |w| w.block_time_ms = START * 1000);
    assert!(h.orch.resolve_recipient("juan@nightmail.local").await.is_ok());
    // The cached read gets old too: it is read again, and the new one is just as old.
    advance(&h, 121);
    assert_eq!(h.orch.resolve_recipient("juan@nightmail.local").await, Err(DirectoryError::RegistryStale));
}

#[tokio::test]
async fn an_indexer_that_goes_back_is_stale() {
    let h = setup().await;
    set(&h, |w| w.block = 10);
    assert!(h.orch.resolve_recipient("juan@nightmail.local").await.is_ok());
    advance(&h, 31);
    set(&h, |w| {
        w.block = 0;
        w.block_time_ms = (START + 31) * 1000;
    });
    assert_eq!(h.orch.resolve_recipient("juan@nightmail.local").await, Err(DirectoryError::RegistryStale));
}

#[tokio::test]
async fn an_unreachable_registry_is_unavailable() {
    let h = setup().await;
    let unavailable = || remote(codes::UPSTREAM_UNAVAILABLE, serde_json::Value::Null);
    set(&h, |w| w.script_snapshot.extend(std::iter::repeat_with(unavailable).take(10)));
    assert_eq!(h.orch.resolve_recipient(ALIAS).await, Err(DirectoryError::RegistryUnavailable));
}

#[tokio::test]
async fn the_registry_is_cached_for_a_while() {
    let h = setup().await;
    h.orch.resolve_recipient("juan@nightmail.local").await.unwrap();
    let one_read = walks(&h);
    assert!(one_read > 0);
    h.orch.resolve_recipient(ALIAS).await.unwrap();
    advance(&h, 30);
    h.orch.resolve_recipient("juan@nightmail.local").await.unwrap();
    assert_eq!(walks(&h), one_read, "within 30 s, no new read");
    advance(&h, 1);
    h.orch.resolve_recipient("juan@nightmail.local").await.unwrap();
    assert_eq!(walks(&h), 2 * one_read);
}

#[tokio::test]
async fn an_address_not_found_is_looked_up_again_in_a_newer_read() {
    let h = setup().await;
    assert_eq!(h.orch.resolve_recipient("eva@nightmail.local").await, Err(DirectoryError::NotFound));
    let eva = mailbox_key(&h, "eva").await;
    set(&h, |w| w.addresses.push(entry(&eva, AddressKind::Mailbox, 3)));
    let reads = walks(&h);
    assert_eq!(h.orch.resolve_recipient("eva@nightmail.local").await, Err(DirectoryError::NotFound));
    assert_eq!(walks(&h), reads, "a read from under 5 s ago is not repeated");
    advance(&h, 6);
    assert_eq!(h.orch.resolve_recipient("eva@nightmail.local").await.map(|r| r.enc_pk), Ok(enc_pk(3)));
}

#[tokio::test]
async fn a_sender_is_resolved_only_with_its_own_address() {
    let h = setup().await;
    let juan = crate::orchestrator::bytes32(&mailbox_key(&h, "juan").await).unwrap();
    let alias = [0xa1; 32];
    let sender = |addr_key: [u8; 32], address: &'static str| {
        let orch = &h.orch;
        async move { orch.resolve_sender(&addr_key, address).await }
    };
    assert_eq!(sender(juan, "juan@nightmail.local").await, Ok(Some(auth_pk(1))));
    assert_eq!(sender(alias, ALIAS).await, Ok(Some(auth_pk(2))));
    // Registered keys with someone else's text, or a text written differently from the registered one.
    assert_eq!(sender(juan, ALIAS).await, Ok(None));
    assert_eq!(sender(alias, "juan@nightmail.local").await, Ok(None));
    assert_eq!(sender(juan, "Juan@nightmail.local").await, Ok(None));
    assert_eq!(sender(juan, " juan@nightmail.local").await, Ok(None));
    assert_eq!(sender(alias, "otra.nube.a1a1a1a1a1a1@nightmail.local").await, Ok(None));
    // Not registered, another domain, not an address.
    assert_eq!(sender([0xc1; 32], "nadie@nightmail.local").await, Ok(None));
    assert_eq!(sender(juan, "juan@gmail.com").await, Ok(None));
    assert_eq!(sender(juan, "juan").await, Ok(None));
    // A registry that cannot answer is an error, not "unverified".
    advance(&h, 121);
    assert_eq!(sender(juan, "juan@nightmail.local").await, Err(DirectoryError::RegistryStale));
}

/// The receiving flow: decrypt, read the declared sender, look it up (asynchronous), verify with that answer.
async fn open_as_the_app_does(h: &Harness, plaintext: &[u8], me: &Party<'_>) -> Result<ReceivedMail, MailOpenError> {
    let declared = declared_sender(plaintext)?;
    let answer = h.orch.resolve_sender(&declared.addr_key, &declared.address).await;
    open_mail(plaintext, me, sender_resolver(&declared.addr_key, &declared.address, answer))
}

/// `e2e-mail.json`: its directory registered (aliases by their text, mailboxes by their name's `addrKey`), the
/// sender resolved through the orchestrator verifies the example mail and none of the unverified ones; a registry
/// that cannot answer leaves the mail to be opened again later.
#[tokio::test]
async fn the_resolved_sender_verifies_the_vector_mail() {
    let vectors = load("e2e-mail.json");
    let h = harness().await;
    set(&h, |w| {
        w.block_time_ms = START * 1000;
        for (seed, e) in (1..).zip(items(&vectors["directory"])) {
            let addr_key = text(&e["addrKey"]).to_owned();
            let Some((local, "nightmail.local")) = text(&e["address"]).split_once('@') else { continue };
            let kind = if alias_form(local) {
                w.alias_texts.insert(addr_key.clone(), local.into());
                AddressKind::Alias
            } else {
                w.name_keys.insert(local.into(), addr_key.clone());
                AddressKind::Mailbox
            };
            let auth_pk = text(&e["authPublicKey"]).to_owned();
            w.addresses.push(AddressEntry { auth_pk, ..entry(&addr_key, kind, seed) });
        }
    });
    let recipient = &vectors["recipient"];
    let me = Party { addr_key: array(&recipient["addrKey"]), address: text(&recipient["address"]) };
    let enc_secret = array(&recipient["encSecretKey"]);

    let envelope = bytes(&vectors["valid"][0]["envelope"]);
    let plaintext = open_envelope(&enc_secret, &envelope).unwrap();
    let declared = declared_sender(&plaintext).unwrap();
    let key = h.orch.resolve_sender(&declared.addr_key, &declared.address).await;
    assert_eq!(key, Ok(Some(array(&vectors["sender"]["authPublicKey"]))));
    assert!(open_as_the_app_does(&h, &plaintext, &me).await.unwrap().sender_verified);
    let resolver = sender_resolver(&declared.addr_key, &declared.address, key);
    assert!(open_mail_envelope(&enc_secret, &envelope, &me, resolver).unwrap().sender_verified);

    let mut foreign = 0;
    for v in items(&vectors["unverified"]) {
        let plaintext = bytes(&v["plaintext"]);
        let declared = declared_sender(&plaintext).unwrap();
        if !declared.address.ends_with("@nightmail.local") {
            // Its own addrKey and alias text, in another domain: not the address a reply would go to.
            let key = h.orch.resolve_sender(&declared.addr_key, &declared.address).await;
            assert_eq!(key, Ok(None), "{}", v["name"]);
            foreign += 1;
        }
        assert!(!open_as_the_app_does(&h, &plaintext, &me).await.unwrap().sender_verified, "{}", v["name"]);
    }
    assert!(foreign > 0, "a vector with a sender in another domain");
    for v in items(&vectors["mixedOrderKey"]) {
        let received = open_as_the_app_does(&h, &bytes(&v["plaintext"]), &me).await.unwrap();
        assert_eq!(Some(received.sender_verified), v["senderVerified"].as_bool(), "{}", v["name"]);
    }

    // The registry cannot answer: the mail is not "unverified", it is opened again later and then verifies.
    advance(&h, 121);
    let retry = open_as_the_app_does(&h, &plaintext, &me).await;
    assert_eq!(retry.err(), Some(MailOpenError::SenderUnavailable));
    set(&h, |w| w.block_time_ms = (START + 121) * 1000);
    assert!(open_as_the_app_does(&h, &plaintext, &me).await.unwrap().sender_verified);
}
