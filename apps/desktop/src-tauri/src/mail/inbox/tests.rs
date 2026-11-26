use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};

use ed25519_dalek::SigningKey;
use tempfile::TempDir;

use super::*;
use crate::crypto::random_bytes;
use crate::mail::e2e::{MESSAGE_ID_LENGTH, OutgoingMail, sign_mail};
use crate::store::{Address as StoredAddress, MessageFilter, SlotKind, StoreScope};

/// A registry that never answers.
pub(crate) struct NoRegistry;

impl SenderDirectory for NoRegistry {
    fn resolve_sender<'a>(&'a self, _: &'a [u8; 32], _: &'a str) -> BoxFuture<'a, SenderAnswer> {
        Box::pin(async { Err(DirectoryError::RegistryUnavailable) })
    }
}

/// (`addrKey`, address) → `authPk`.
type RegisteredKeys = HashMap<([u8; 32], String), [u8; 32]>;

/// A registry for tests: the `authPk` of each registered (`addrKey`, address). While `outages` lasts, each lookup
/// takes one and answers that the registry is unavailable.
#[derive(Default)]
pub(crate) struct FakeDirectory {
    keys: Mutex<RegisteredKeys>,
    outages: AtomicU32,
    lookups: AtomicU32,
}

impl FakeDirectory {
    pub fn register(&self, addr_key: [u8; 32], address: &str, auth_public: [u8; 32]) {
        self.keys.lock().unwrap().insert((addr_key, address.to_owned()), auth_public);
    }

    /// The next `count` lookups find the registry unavailable.
    pub fn fail_next(&self, count: u32) {
        self.outages.store(count, Ordering::SeqCst);
    }

    pub fn lookups(&self) -> u32 {
        self.lookups.load(Ordering::SeqCst)
    }
}

impl SenderDirectory for FakeDirectory {
    fn resolve_sender<'a>(&'a self, addr_key: &'a [u8; 32], address: &'a str) -> BoxFuture<'a, SenderAnswer> {
        self.lookups.fetch_add(1, Ordering::SeqCst);
        let out = self.outages.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1)).is_ok();
        let answer = if out {
            Err(DirectoryError::RegistryUnavailable)
        } else {
            Ok(self.keys.lock().unwrap().get(&(*addr_key, address.to_owned())).copied())
        };
        Box::pin(async move { answer })
    }
}

/// A NightMail address that writes to us.
pub(crate) struct TestSender {
    pub seed: [u8; 32],
    pub addr_key: [u8; 32],
    pub address: String,
}

impl TestSender {
    pub fn new(tag: u8, address: &str) -> Self {
        Self { seed: random_bytes(), addr_key: [tag; 32], address: address.to_owned() }
    }

    pub fn auth_public(&self) -> [u8; 32] {
        SigningKey::from_bytes(&self.seed).verifying_key().to_bytes()
    }

    /// Registers this sender, with its own key, in `directory`.
    pub fn register(&self, directory: &FakeDirectory) {
        directory.register(self.addr_key, &self.address, self.auth_public());
    }

    /// A mail signed by this sender for `to` (`addrKey` and address).
    pub fn sign(&self, id: [u8; MESSAGE_ID_LENGTH], to: ([u8; 32], &str), subject: &str, body: &str) -> Vec<u8> {
        let mail = OutgoingMail {
            message_id: id,
            date: 1_794_873_600,
            sender: Party { addr_key: self.addr_key, address: &self.address },
            recipient: Party { addr_key: to.0, address: to.1 },
            subject,
            body,
        };
        sign_mail(&self.seed, &mail).unwrap().to_vec()
    }
}

const ME: &str = "juan@nightmail.local";
const ME_KEY: [u8; 32] = [1; 32];

fn received(subject: &str, body: &str, verified: bool) -> ReceivedMail {
    ReceivedMail {
        message_id: [0xab; 16],
        date: 99,
        sender: Address { addr_key: [2; 32], address: "nube.verde.k7m2q9xa4b3c@nightmail.local".into() },
        sender_verified: verified,
        recipient: Address { addr_key: ME_KEY, address: ME.into() },
        subject: Zeroizing::new(subject.into()),
        body: Zeroizing::new(body.into()),
    }
}

fn reparse(mail: &ReceivedMail, received_at: i64) -> parser::ParsedMessage {
    parser::parse(&synthesize_mime(mail, ME, received_at)).unwrap()
}

#[test]
fn the_synthesised_mime_reads_back_with_the_arrival_date() {
    let mail = received("Reunión del martes", "Hola Juan,\r\n\r\nNos vemos el martes.\r\n", true);
    let parsed = reparse(&mail, 1_795_000_000);
    assert_eq!(parsed.from.as_deref(), Some("<nube.verde.k7m2q9xa4b3c@nightmail.local>"));
    assert_eq!(parsed.to, ["<juan@nightmail.local>"]);
    assert_eq!(parsed.subject.as_deref(), Some("Reunión del martes"));
    assert_eq!(parsed.date, Some(1_795_000_000), "the arrival time, never the sender's date (99)");
    assert_eq!(parsed.text.as_deref(), Some("Hola Juan,\r\n\r\nNos vemos el martes.\r\n"));
    assert_eq!(parsed.preview, "Hola Juan, Nos vemos el martes.");
    assert!(parsed.html.is_none() && parsed.attachments.is_empty() && !parsed.truncated);
    let raw = synthesize_mime(&mail, ME, 0);
    let text = String::from_utf8(raw.to_vec()).unwrap();
    assert!(text.contains(&format!("Message-ID: <{}@nightmail.local>\r\n", "ab".repeat(16))));
    assert!(text.contains("Date: Thu, 01 Jan 1970 00:00:00 +0000\r\n"));
    assert!(text.lines().all(|line| line.len() <= 76), "every line within the MIME limits");
}

#[test]
fn long_and_unusual_subjects_and_bodies_survive_unchanged() {
    // The longest subject (1024 bytes, 512 × ñ), emoji across encoded words, a body with tabs, a lone CR, joiners.
    // (The parser drops joiners from any subject it shows, so the subjects here have none.)
    for subject in ["ñ".repeat(512), "Saludos 👋🏽 y ñandú ".repeat(30), "x".repeat(1000)] {
        let body = "línea\tcon tab\rCR suelto\nLF\r\n👨‍👩‍👧 فارسی\u{200c}ها\r\n";
        let parsed = reparse(&received(&subject, body, false), 5);
        assert_eq!(parsed.subject.as_deref(), Some(subject.as_str()));
        assert_eq!(parsed.text.as_deref(), Some(body));
    }
}

#[test]
fn an_empty_subject_and_body_give_an_empty_message() {
    let parsed = reparse(&received("", "", true), 5);
    assert_eq!(parsed.subject, None);
    assert_eq!(parsed.text.as_deref().unwrap_or_default(), "");
    assert_eq!(parsed.from.as_deref(), Some("<nube.verde.k7m2q9xa4b3c@nightmail.local>"));
}

#[test]
fn arrival_dates_outside_the_calendar_are_clamped() {
    assert_eq!(reparse(&received("a", "b", true), -50).date, Some(0));
    assert_eq!(reparse(&received("a", "b", true), i64::MAX).date, Some(MAX_DATE as i64));
}

fn store_with_me() -> (TempDir, LocalStore) {
    let dir = TempDir::new().unwrap();
    let scope = StoreScope { network: "devnet".into(), contract: "c1".into() };
    let store = LocalStore::open(&dir.path().join("db"), &[3; 32], &scope).unwrap();
    let me = StoredAddress {
        addr_key: ME_KEY,
        kind: SlotKind::Mailbox,
        n: 0,
        j: 0,
        display: ME.into(),
        name: Some("juan".into()),
        created_at: 1,
    };
    store.insert_address(&me).unwrap();
    (dir, store)
}

fn arrival(server_id: &str) -> Arrival {
    Arrival { addr_key: ME_KEY, address: ME.into(), server_id: server_id.into(), received_at: 7200, size_bucket: 4096 }
}

/// Settles `plaintext` (an e2e mail) with what `directory` answers about its declared sender.
fn settle_with(store: &LocalStore, server_id: &str, plaintext: &[u8], directory: &FakeDirectory) -> Settled {
    let declared = declared_sender(plaintext).unwrap();
    let answer = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(directory.resolve_sender(&declared.addr_key, &declared.address));
    settle(store, &arrival(server_id), plaintext, &declared, answer).unwrap()
}

fn stored(store: &LocalStore) -> Vec<crate::store::MessageSummary> {
    store.list_messages(&MessageFilter::default()).unwrap()
}

#[test]
fn a_mail_from_a_registered_sender_is_stored_verified() {
    let (_dir, store) = store_with_me();
    let (sender, directory) = (TestSender::new(2, "ana@nightmail.local"), FakeDirectory::default());
    sender.register(&directory);
    let plaintext = sender.sign([7; 16], (ME_KEY, ME), "Hola", "Qué tal");
    let Settled::Stored(E2eInsert::Stored { id, replaced: 0 }) = settle_with(&store, "s1", &plaintext, &directory)
    else {
        panic!("not stored")
    };
    let message = store.get_message(id).unwrap().unwrap();
    let summary = &message.summary;
    assert!(summary.e2e && summary.sender_verified);
    assert_eq!((summary.received_at, summary.parsed.sent_at), (7200, Some(7200)));
    assert_eq!(summary.parsed.from_addr.as_deref(), Some("<ana@nightmail.local>"));
    assert_eq!(summary.parsed.subject.as_deref(), Some("Hola"));
    assert_eq!(summary.parsed.preview.as_deref(), Some("Qué tal"));
    assert_eq!(parser::parse(&message.raw).unwrap().text.as_deref(), Some("Qué tal"));
}

#[test]
fn a_mail_that_does_not_check_out_is_stored_unverified() {
    let (_dir, store) = store_with_me();
    let (sender, directory) = (TestSender::new(2, "ana@nightmail.local"), FakeDirectory::default());
    // Not registered at all.
    let unknown = TestSender::new(5, "nadie@nightmail.local").sign([1; 16], (ME_KEY, ME), "a", "b");
    // Registered with another key: a bad signature.
    let impostor = TestSender::new(3, "eva@nightmail.local");
    directory.register(impostor.addr_key, &impostor.address, sender.auth_public());
    let forged = impostor.sign([2; 16], (ME_KEY, ME), "a", "b");
    // From another domain (a registry answers no for it).
    let foreign = TestSender::new(4, "ana@gmail.com").sign([3; 16], (ME_KEY, ME), "a", "b");
    // Signed for another of our addresses.
    sender.register(&directory);
    let elsewhere = sender.sign([4; 16], ([9; 32], "otra@nightmail.local"), "a", "b");
    for (i, plaintext) in [unknown, forged, foreign, elsewhere].iter().enumerate() {
        let settled = settle_with(&store, &format!("s{i}"), plaintext, &directory);
        assert!(matches!(settled, Settled::Stored(E2eInsert::Stored { .. })), "{i}: {settled:?}");
    }
    let all = stored(&store);
    assert_eq!(all.len(), 4);
    assert!(all.iter().all(|m| m.e2e && !m.sender_verified));
}

#[test]
fn without_a_registry_answer_nothing_is_stored() {
    let (_dir, store) = store_with_me();
    let (sender, directory) = (TestSender::new(2, "ana@nightmail.local"), FakeDirectory::default());
    sender.register(&directory);
    directory.fail_next(1);
    let plaintext = sender.sign([7; 16], (ME_KEY, ME), "Hola", "Qué tal");
    assert_eq!(settle_with(&store, "s1", &plaintext, &directory), Settled::SenderUnavailable);
    assert!(stored(&store).is_empty());
}

#[test]
fn only_a_decodable_e2e_mail_takes_the_e2e_path() {
    let sender = TestSender::new(2, "ana@nightmail.local");
    let mut plaintext = sender.sign([7; 16], (ME_KEY, ME), "Hola", "Qué tal");
    assert!(declared_sender(&plaintext).is_some());
    assert!(declared_sender(b"From: a@b\r\n\r\nhola").is_none());
    assert!(declared_sender(b"nightmail:e2e header\r\nSubject: x\r\n\r\nbody").is_none());
    plaintext[13] = 2;
    assert!(declared_sender(&plaintext).is_none(), "a version this app does not know");
    // Which marked plaintexts can still be MIME: only those that go on as a header line would.
    assert!(is_unreadable_e2e(&plaintext));
    for (text, unreadable) in [
        (&b"nightmail:e2e\x01"[..], true),
        (b"nightmail:e2e\x00rest", true),
        (b"nightmail:e2e\x7f", true),
        (b"nightmail:e2e header\r\nSubject: x\r\n\r\nbody", false),
        (b"nightmail:e2e\r\nSubject: x\r\n\r\nbody", false),
        (b"nightmail:e2e\tx", false),
        ("nightmail:e2eñ".as_bytes(), false),
        (b"nightmail:e2e", false),
        (b"From: a@b\r\n\r\nnightmail:e2e\x01", false),
    ] {
        assert_eq!(is_unreadable_e2e(text), unreadable, "{text:?}");
    }
}
