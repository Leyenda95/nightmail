use super::*;

/// multipart/mixed: quoted-printable text, base64 HTML and a PDF attachment; UTF-8 headers.
pub(crate) const MULTIPART: &str = "From: =?UTF-8?B?Sm9zw6kgUMOpcmV6?= <jose@example.org>\r\n\
To: alias1@nightmail.local, \"Ana\" <ana@nightmail.local>\r\n\
Subject: =?UTF-8?Q?Reuni=C3=B3n_del_mi=C3=A9rcoles?=\r\n\
Date: Wed, 18 Nov 2026 10:30:00 +0100\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/mixed; boundary=\"b1\"\r\n\
\r\n\
--b1\r\n\
Content-Type: multipart/alternative; boundary=\"b2\"\r\n\
\r\n\
--b2\r\n\
Content-Type: text/plain; charset=utf-8\r\n\
Content-Transfer-Encoding: quoted-printable\r\n\
\r\n\
Hola,\r\n\
\r\n\
=C2=BFqu=C3=A9 tal?   Nos vemos a las 10 en el caf=C3=A9.\r\n\
--b2\r\n\
Content-Type: text/html; charset=utf-8\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
PHA+SG9sYSwgPGI+wr9xdcOpIHRhbD88L2I+PC9wPg==\r\n\
--b2--\r\n\
--b1\r\n\
Content-Type: application/pdf; name=\"informe.pdf\"\r\n\
Content-Disposition: attachment; filename=\"informe.pdf\"\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
JVBERi0xLjQKJcOkw7zDtsOfCg==\r\n\
--b1--\r\n";

pub(crate) fn plain(subject: &str, body: &str) -> String {
    format!("From: a@example.org\r\nSubject: {subject}\r\n\r\n{body}\r\n")
}

/// Multipart with `count` parts, each with its own `Content-Type` line (plus the root's).
pub(super) fn multipart(count: usize) -> String {
    let parts = (0..count).map(|i| format!("--z\r\nContent-Type: text/plain\r\n\r\n{i}\r\n")).collect::<String>();
    format!("Subject: partes\r\nContent-Type: multipart/mixed; boundary=z\r\n\r\n{parts}--z--\r\n")
}

/// `depth` unencoded `message/rfc822` messages nested inside each other.
fn nested_messages(depth: usize) -> String {
    "Subject: anidado\r\nContent-Type: message/rfc822\r\n\r\n".repeat(depth) + "Subject: dentro\r\n\r\nfin\r\n"
}

/// `depth` nested multiparts.
pub(super) fn nested_multiparts(depth: usize) -> String {
    let open: String =
        (0..depth).map(|i| format!("Content-Type: multipart/mixed; boundary=b{i}\r\n\r\n--b{i}\r\n")).collect();
    let close: String = (0..depth).rev().map(|i| format!("--b{i}--\r\n")).collect();
    format!("Subject: anidado\r\n{open}\r\nfin\r\n{close}")
}

/// Runs on a thread with `spawn_blocking`'s stack size (2 MiB): an overflow would abort the test.
pub(super) fn on_small_stack<T: Send + 'static>(job: impl FnOnce() -> T + Send + 'static) -> T {
    std::thread::Builder::new().stack_size(2 << 20).spawn(job).unwrap().join().unwrap()
}

fn parse_on_small_stack(raw: String) -> Result<ParsedMessage, ParseError> {
    on_small_stack(move || parse(raw.as_bytes()))
}

#[test]
fn multipart_message_fields() {
    let parsed = parse(MULTIPART.as_bytes()).unwrap();
    assert_eq!(parsed.from.as_deref(), Some("José Pérez <jose@example.org>"));
    assert_eq!(parsed.to, ["<alias1@nightmail.local>", "Ana <ana@nightmail.local>"]);
    assert_eq!(parsed.subject.as_deref(), Some("Reunión del miércoles"));
    assert_eq!(parsed.date, Some(1_794_994_200));
    assert_eq!(parsed.text.as_deref(), Some("Hola,\r\n\r\n¿qué tal?   Nos vemos a las 10 en el café."));
    assert_eq!(parsed.html.as_deref(), Some("<p>Hola, <b>¿qué tal?</b></p>"));
    assert_eq!(parsed.preview, "Hola, ¿qué tal? Nos vemos a las 10 en el café.");
    let pdf = AttachmentInfo { name: Some("informe.pdf".into()), content_type: "application/pdf".into(), size: 19 };
    assert!(parsed.attachments == [pdf] && !parsed.truncated);
}

#[test]
fn fields_for_the_store() {
    let fields = parse(MULTIPART.as_bytes()).unwrap().fields();
    assert_eq!(fields.from_addr.as_deref(), Some("José Pérez <jose@example.org>"));
    assert_eq!(fields.subject.as_deref(), Some("Reunión del miércoles"));
    assert_eq!(fields.sent_at, Some(1_794_994_200));
    assert_eq!(fields.preview.as_deref(), Some("Hola, ¿qué tal? Nos vemos a las 10 en el café."));
    assert_eq!(parse(plain("x", "").as_bytes()).unwrap().fields().preview, None);
}

#[test]
fn non_latin_charsets_are_decoded() {
    let mut raw = b"Subject: =?ISO-2022-JP?B?GyRCJDMkcyRLJEEkTxsoQg==?=\r\n".to_vec();
    raw.extend_from_slice(b"Content-Type: text/plain; charset=shift_jis\r\n\r\n\x82\xb1\x82\xf1\r\n");
    let parsed = parse(&raw).unwrap();
    assert_eq!(parsed.subject.as_deref(), Some("こんにちは"));
    assert_eq!(parsed.preview, "こん");
}

#[test]
fn html_only_message_gets_text_and_preview_from_html() {
    let raw = "From: <b@example.org>\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Hola <i>mundo</i></p>\r\n";
    let ParsedMessage { html, preview, from, .. } = parse(raw.as_bytes()).unwrap();
    let expected = (Some("<p>Hola <i>mundo</i></p>\r\n"), "Hola mundo", Some("<b@example.org>"));
    assert_eq!((html.as_deref(), preview.as_str(), from.as_deref()), expected);
}

#[test]
fn text_only_message_has_no_html_nor_recipients() {
    let parsed = parse(plain("hola", "solo texto").as_bytes()).unwrap();
    assert_eq!(parsed.html, None);
    assert!(parsed.to.is_empty() && parsed.attachments.is_empty());
    assert_eq!(parsed.date, None);
}

#[test]
fn group_name_without_address() {
    let parsed = parse(b"From: Solo Nombre\r\nTo: undisclosed-recipients:;\r\n\r\nx").unwrap();
    assert_eq!(parsed.from.as_deref(), Some("Solo Nombre <>"));
    assert!(parsed.to.is_empty());
}

#[test]
fn control_and_bidi_characters_are_removed_from_fields() {
    let raw = "From: =?UTF-8?B?4oCuTWFsbw==?= <m@example.org>\r\nSubject: =?UTF-8?Q?a=E2=80=8Fb=07c?=\r\n\r\nuno\u{202e}\tdos\r\n";
    let parsed = parse(raw.as_bytes()).unwrap();
    assert_eq!(parsed.from.as_deref(), Some("Malo <m@example.org>"));
    assert_eq!(parsed.subject.as_deref(), Some("abc"));
    assert_eq!(parsed.preview, "uno dos");
}

#[test]
fn long_fields_and_preview_are_clipped() {
    let parsed = parse(plain(&"á".repeat(3000), &"palabra ".repeat(100)).as_bytes()).unwrap();
    assert_eq!(parsed.subject.unwrap().chars().count(), MAX_FIELD_CHARS);
    assert_eq!(parsed.preview.chars().count(), PREVIEW_CHARS);
}

#[test]
fn recipients_and_attachments_are_capped() {
    let to = (0..MAX_RECIPIENTS + 5).map(|i| format!("u{i}@example.org")).collect::<Vec<_>>().join(", ");
    let parts = (0..MAX_ATTACHMENTS + 5).map(|i| attachment_part(i, None)).collect::<String>();
    let raw = format!("To: {to}\r\nContent-Type: multipart/mixed; boundary=z\r\n\r\n{parts}--z--\r\n");
    let parsed = parse(raw.as_bytes()).unwrap();
    assert_eq!(parsed.to.len(), MAX_RECIPIENTS);
    assert_eq!(parsed.attachments.len(), MAX_ATTACHMENTS);
}

fn attachment_part(i: usize, content_type: Option<&str>) -> String {
    let ct = content_type.map(|ct| format!("Content-Type: {ct}\r\n")).unwrap_or_default();
    format!("--z\r\n{ct}Content-Disposition: attachment; filename=f{i}.bin\r\n\r\nxyz\r\n")
}

#[test]
fn attachment_content_types() {
    let parts = [Some("IMAGE/PNG"), Some("application"), None].map(|ct| attachment_part(0, ct)).concat();
    let raw = format!("Content-Type: multipart/mixed; boundary=z\r\n\r\n{parts}--z--\r\n");
    let types: Vec<_> = parse(raw.as_bytes()).unwrap().attachments.into_iter().map(|a| a.content_type).collect();
    assert_eq!(types, ["image/png", "application/octet-stream", "application/octet-stream"]);
}

/// The patched library bounds parts (1000 across all levels, root included): past that it cuts and reports
/// `truncated`, keeping what was read.
#[test]
fn exact_part_limit_is_parsed_and_one_more_is_cut() {
    let at_limit = parse(multipart(999).as_bytes()).unwrap();
    assert!(!at_limit.truncated && at_limit.text.is_some());
    let over = parse(multipart(1000).as_bytes()).unwrap();
    assert!(over.truncated);
    assert_eq!(over.subject.as_deref(), Some("partes"));
}

#[test]
fn deep_nesting_at_the_limit_fits_in_a_blocking_thread_stack() {
    // Deeper than 32 levels: the library cuts (truncated) without overflowing.
    assert!(parse_on_small_stack(nested_messages(500)).unwrap().truncated);
    assert!(parse_on_small_stack(nested_multiparts(500)).unwrap().truncated);
}

#[test]
fn huge_nesting_is_cut_without_overflowing_the_stack() {
    let parsed = parse_on_small_stack(nested_messages(200_000)).unwrap();
    assert!(parsed.truncated);
    assert_eq!(parsed.subject.as_deref(), Some("anidado"));
}

/// Inputs with millions of `--` lines are now stopped by the library limits.
#[test]
fn megabytes_of_boundary_lines_are_cut_quickly() {
    let raw = format!("Subject: z\r\nContent-Type: multipart/mixed; boundary=z\r\n\r\n{}", "--z\r\n".repeat(5 << 20));
    let started = std::time::Instant::now();
    assert!(parse_on_small_stack(raw).unwrap().truncated);
    assert!(started.elapsed() < std::time::Duration::from_secs(10));
}

#[test]
fn a_panic_inside_the_library_is_an_unparseable_message() {
    assert_eq!(guarded(|| panic!("simulated library failure")), Err(ParseError::Unparseable));
}

#[test]
fn empty_input_is_unparseable() {
    assert_eq!(parse(b""), Err(ParseError::Unparseable));
    assert_eq!(headers_only(b""), Err(ParseError::Unparseable));
}

#[test]
fn debug_output_carries_no_content() {
    let shown = format!("{:?}", parse(MULTIPART.as_bytes()).unwrap());
    for secret in ["José", "Reunión", "Hola", "informe", "nightmail.local"] {
        assert!(!shown.contains(secret), "{shown}");
    }
}

#[test]
fn errors_have_fixed_messages() {
    assert_eq!(ParseError::Unparseable.to_string(), "unreadable message");
}

fn temp_store() -> (tempfile::TempDir, LocalStore) {
    let dir = tempfile::TempDir::new().unwrap();
    let scope = crate::store::StoreScope { network: "devnet".into(), contract: "c1".into() };
    let store = LocalStore::open(&dir.path().join("db"), &[5; 32], &scope).unwrap();
    (dir, store)
}

#[test]
fn breaker_poisons_a_message_that_killed_the_analyzer() {
    let (_dir, store) = temp_store();
    let parsed = parse_once(&store, Breaker::Sync, b"id-1", MULTIPART.as_bytes()).unwrap();
    assert_eq!(parsed.unwrap().subject.as_deref(), Some("Reunión del miércoles"));
    assert_eq!(store.get_meta("mail.parsing.sync").unwrap().as_deref(), Some(&b""[..]));
    // The process died parsing id-2 on the read path:
    store.set_meta("mail.parsing.read", b"id-2").unwrap();
    assert!(parse_once(&store, Breaker::Read, b"id-3", MULTIPART.as_bytes()).unwrap().is_some(), "another one is parsed");
    for _ in 0..2 {
        assert_eq!(parse_once(&store, Breaker::Read, b"id-2", MULTIPART.as_bytes()).unwrap(), None, "never again");
    }
    assert!(parse_once(&store, Breaker::Sync, b"id-2", MULTIPART.as_bytes()).unwrap().is_some(), "each path separately");
}

#[test]
fn poisoned_list_is_bounded() {
    let (_dir, store) = temp_store();
    for i in 0..MAX_POISONED + 3 {
        store.set_meta("mail.parsing.sync", format!("id-{i}").as_bytes()).unwrap();
        parse_once(&store, Breaker::Sync, b"otro", MULTIPART.as_bytes()).unwrap();
    }
    let poisoned = load_ids(&store, "mail.poisoned.sync").unwrap();
    assert_eq!(poisoned.len(), MAX_POISONED);
    assert_eq!(poisoned[0], b"id-3");
    assert!(
        parse_once(&store, Breaker::Sync, b"id-0", MULTIPART.as_bytes()).unwrap().is_some(),
        "the oldest is forgotten"
    );
}
#[test]
fn invisible_characters_are_removed_from_fields() {
    let subject = "a\u{200B}b\u{2028}c\u{00AD}d\u{E0041}e\u{FEFF}f";
    let parsed = parse(plain(subject, "x").as_bytes()).unwrap();
    assert_eq!(parsed.subject.as_deref(), Some("abcdef"));
}

#[test]
fn huge_header_block_is_headers_only_and_bounded() {
    let to = (0..40_000).map(|i| format!("u{i}@example.org")).collect::<Vec<_>>().join(", ");
    let parsed = parse(format!("Subject: s\r\nTo: {to}\r\n\r\ncuerpo\r\n").as_bytes()).unwrap();
    assert!(parsed.truncated && parsed.to.len() == MAX_RECIPIENTS);
    assert_eq!(header_length(b"A: b\nC: d\n\nresto"), 10);
    assert_eq!(header_length(b"A: b\r\n\r\nresto"), 6);
    assert_eq!(header_length(b"A: b"), 4);
}

#[test]
fn attached_message_size_is_its_own() {
    let inner = "Subject: dentro\r\n\r\nhola\r\n";
    let raw = format!(
        "Subject: fuera\r\nContent-Type: multipart/mixed; boundary=z\r\n\r\n--z\r\nContent-Type: text/plain\r\n\r\n{}\r\n--z\r\nContent-Type: message/rfc822\r\n\r\n{inner}--z--\r\n",
        "relleno ".repeat(1000)
    );
    let parsed = parse(raw.as_bytes()).unwrap();
    let message = parsed.attachments.iter().find(|a| a.content_type == "message/rfc822").unwrap();
    assert!(message.size <= inner.len() + 2, "{}", message.size);
}

#[test]
fn inline_images_are_extracted_only_when_reading() {
    let raw = "Subject: logo\r\nContent-Type: multipart/related; boundary=r\r\n\r\n\
               --r\r\nContent-Type: text/html\r\n\r\n<img src=\"cid:a@x\">\r\n\
               --r\r\nContent-Type: image/png\r\nContent-ID: <a@x>\r\n\r\npng\r\n--r--\r\n";
    let (_dir, store) = temp_store();
    // Sync only stores the fields; it does not copy the images just to throw them away.
    let synced = parse_once(&store, Breaker::Sync, b"id-1", raw.as_bytes()).unwrap().unwrap();
    assert!(synced.inline.images.is_empty());
    assert_eq!(synced.html.as_deref().map(str::trim), Some("<img src=\"cid:a@x\">"));
    let read = parse_once(&store, Breaker::Read, b"id-1", raw.as_bytes()).unwrap().unwrap();
    assert_eq!(read.inline.images.len(), 1);
    assert_eq!(parse(raw.as_bytes()).unwrap().inline.images.len(), 1, "parse() still returns them");
}

/// A text with over 1000 lines starting with `--` (SQL dump, git patch, table) is read in full rather than reported
/// as an incomplete message with no body.
#[test]
fn many_dash_lines_in_a_plain_body_are_not_truncated() {
    let parsed = parse(plain("s", &"-- x\r\n".repeat(1001)).as_bytes()).unwrap();
    assert!(!parsed.truncated, "{parsed:?}");
    assert_eq!(parsed.text.map(|text| text.matches("-- x").count()), Some(1001));
}
