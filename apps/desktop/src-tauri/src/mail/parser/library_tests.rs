//! Limits of the patched mail-parser (`vendor/mail-parser-0.11.9`), tested by calling the library directly, without
//! NightMail's own checks, on a 2 MiB thread (like `spawn_blocking`) that also drops the tree there.
//!
//! Every test fails against the upstream library (checked with a separate probe that builds both the crates.io and the
//! patched versions and feeds them the same inputs): it either aborts with a stack overflow, takes far more time or
//! memory, or yields more parts/headers than the limit. Each test notes what upstream does.

use std::time::{Duration, Instant};

use mail_parser::{Message, MessageParser, PartType};

use super::tests::{multipart, nested_multiparts, on_small_stack};

/// What matters of the tree the library builds.
#[derive(Debug)]
struct Shape {
    parts: usize,
    max_headers: usize,
    /// Levels of `message/rfc822` opened inside each other (following the first one at each level).
    nesting: usize,
    /// The patch signals a cut with `is_encoding_problem` on part 0.
    cut: bool,
    elapsed: Duration,
}

fn nesting(message: &Message<'_>) -> usize {
    message.attachments().find_map(|part| part.message()).map_or(0, |inner| 1 + nesting(inner))
}

fn shape(raw: String) -> Shape {
    on_small_stack(move || {
        let started = Instant::now();
        let message = MessageParser::default().parse(raw.as_bytes()).expect("message");
        let shape = Shape {
            parts: message.parts.len(),
            max_headers: message.parts.iter().map(|p| p.headers.len()).max().unwrap_or(0),
            nesting: nesting(&message),
            cut: message.parts[0].is_encoding_problem,
            elapsed: Duration::ZERO,
        };
        drop(message);
        Shape { elapsed: started.elapsed(), ..shape }
    })
}

/// `depth` unencoded messages of type `ctype`, with the header (spelled as `header`) first at each level.
fn nested(header: &str, ctype: &str, depth: usize) -> String {
    format!("{header}: {ctype}\r\nSubject: anidado\r\n\r\n").repeat(depth) + "Subject: dentro\r\n\r\nfin\r\n"
}

/// Test base64 (76-character lines).
fn base64(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for (i, chunk) in data.chunks(3).enumerate() {
        let n = chunk.iter().enumerate().fold(0u32, |acc, (k, &b)| acc | (u32::from(b) << (16 - 8 * k)));
        for k in 0..4 {
            out.push(if k <= chunk.len() { ALPHABET[(n >> (18 - 6 * k) & 63) as usize] as char } else { '=' });
        }
        if i % 19 == 18 {
            out.push_str("\r\n");
        }
    }
    out
}

/// A `message/rfc822` attachment encoded with `cte`, containing `inner`.
fn encoded(inner: &str, cte: &str) -> String {
    let body = if cte == "base64" { base64(inner.as_bytes()) } else { inner.to_owned() };
    let part = format!("Content-Type: message/rfc822\r\nContent-Transfer-Encoding: {cte}\r\n\r\n{body}");
    format!("Subject: f\r\nContent-Type: multipart/mixed; boundary=z\r\n\r\n--z\r\n{part}\r\n--z--\r\n")
}

/// An inner part with `headers` as its headers.
fn inner_part(headers: &str) -> String {
    format!("Subject: s\r\nContent-Type: multipart/mixed; boundary=z\r\n\r\n--z\r\n{headers}\r\n\r\nx\r\n--z--\r\n")
}

#[test]
fn base64_helper() {
    assert_eq!(base64(b"Man"), "TWFu");
    assert_eq!(base64(b"Ma"), "TWE=");
    assert_eq!(base64(b"M"), "TQ==");
}

/// Upstream: aborts (stack overflow dropping 200 000 levels) with all four spellings.
#[test]
fn header_spellings_cannot_bypass_the_depth_limit() {
    for header in ["Content-Type", "Content -Type", " Content-Type", "\tContent-Type"] {
        assert!(shape(nested(header, "message/rfc822", 200_000)).nesting <= 32, "{header:?}");
    }
}

/// Upstream: aborts.
#[test]
fn message_global_is_bounded_too() {
    assert!(shape(nested("Content-Type", "message/global", 200_000)).nesting <= 32);
}

/// Upstream: aborts (parses the decoded content and `into_owned` is recursive).
#[test]
fn encoded_messages_are_not_opened() {
    let inner = nested("Content-Type", "message/rfc822", 200_000);
    for cte in ["base64", "quoted-printable"] {
        let shape = shape(encoded(&inner, cte));
        assert_eq!((shape.nesting, shape.parts), (0, 2), "{cte}");
    }
}

/// Upstream: opens the attachment and copies the message at each level (317 MB peak with 300 × 1 MiB; ≈ 7 GB with
/// 24 MiB).
#[test]
fn encoded_nesting_with_padding_is_not_opened() {
    let padding = format!("{}\r\n", "x".repeat(70)).repeat((1 << 20) / 72);
    let shape = shape(encoded(&format!("{}{padding}", nested("Content-Type", "message/rfc822", 300)), "base64"));
    assert_eq!(shape.nesting, 0);
}

/// Upstream: 1 000 000 parts (184 MB peak).
#[test]
fn separators_in_the_middle_of_lines_are_capped() {
    let raw =
        format!("Subject: z\r\nContent-Type: multipart/mixed; boundary=z\r\n\r\n{}", "\r\n\r\na--z".repeat(1_000_000));
    let shape = shape(raw);
    assert!(shape.parts <= 1000 && shape.cut, "{shape:?}");
}

/// Upstream: 100 001 parts and 100 000 opened messages.
#[test]
fn digest_parts_are_capped() {
    let raw = format!(
        "Subject: d\r\nContent-Type: multipart/digest; boundary=z\r\n\r\n{}--z--\r\n",
        "--z\r\n\r\nx\r\n".repeat(200_000)
    );
    assert!(shape(raw).parts <= 1001);
}

/// Upstream: no depth limit.
#[test]
fn depth_limit_is_exactly_32() {
    let at = shape(nested("Content-Type", "message/rfc822", 32));
    assert_eq!((at.nesting, at.cut), (32, false));
    let over = shape(nested("Content-Type", "message/rfc822", 33));
    assert_eq!((over.nesting, over.cut), (32, true));
    assert!(shape(nested_multiparts(5000)).parts <= 1001);
}

/// Upstream: no part limit.
#[test]
fn part_limit_is_exactly_1000() {
    let at = shape(multipart(999));
    assert_eq!((at.parts, at.cut), (1000, false));
    let over = shape(multipart(1000));
    assert_eq!((over.parts, over.cut), (1000, true));
}

/// Upstream: joins continuations in quadratic time (2.0 s in release with 2 MiB; four times that with 4 MiB) and
/// parses the part (2 parts).
#[test]
fn endless_inner_headers_stop_the_analysis_quickly() {
    let raw = inner_part(&format!("Content-Type: text/plain;\r\n{}", " n*1=xxxxx;\r\n".repeat((4 << 20) / 13)));
    let shape = shape(raw);
    assert!(shape.parts == 1 && shape.cut, "{shape:?}");
    assert!(shape.elapsed < Duration::from_secs(30), "guard (the original takes 12.8 s in release)");
}

/// Upstream: 2 359 296 headers in one part (296 MB peak; 40× the input).
#[test]
fn millions_of_inner_headers_are_not_built() {
    let shape = shape(inner_part(&"a:\r\n".repeat((9 << 20) / 4)));
    assert!(shape.max_headers <= 100 && shape.cut, "{shape:?}");
}

/// No clock. Upstream: all 20 multiparts with a lost boundary are searched (20 searches to the end) and read as text.
/// Patched: the first 8 are searched in vain (text) and the next 12 are not searched at all (binary).
#[test]
fn lost_boundaries_are_searched_a_bounded_number_of_times() {
    let parts = "--z\r\nContent-Type: multipart/mixed; boundary=nunca\r\n\r\nx\r\n".repeat(20);
    let raw = format!(
        "Subject: s\r\nContent-Type: multipart/mixed; boundary=z\r\n\r\n{parts}{}\r\n--z--\r\n",
        "y".repeat(1024)
    );
    let (texts, binaries, cut, elapsed) = on_small_stack(move || {
        let started = Instant::now();
        let message = MessageParser::default().parse(raw.as_bytes()).expect("message");
        let count =
            |text: bool| message.parts[1..].iter().filter(|p| matches!(p.body, PartType::Text(_)) == text).count();
        (count(true), count(false), message.parts[0].is_encoding_problem, started.elapsed())
    });
    assert_eq!((texts, binaries, cut), (8, 12, true));
    assert!(elapsed < Duration::from_secs(30), "guard");
}

/// Upstream: no total cap (128 parts × 256 KiB of `a:` ≈ 1 GB). Patched: parsing stops past 1 MiB of headers.
#[test]
fn total_header_bytes_are_capped() {
    let part = format!("--z\r\n{}\r\nx\r\n", "a:\r\n".repeat(250 * 1024 / 4));
    let raw = format!("Subject: s\r\nContent-Type: multipart/mixed; boundary=z\r\n\r\n{}--z--\r\n", part.repeat(40));
    let shape = shape(raw);
    assert!(shape.cut && shape.parts <= 5, "{shape:?}");
}

/// The header window does not cut normal messages with large attachments (CRLF and LF).
#[test]
fn large_attachments_are_not_cut() {
    for eol in ["\r\n", "\n"] {
        let raw = format!(
            "Subject: s{eol}Content-Type: multipart/mixed; boundary=z{eol}{eol}--z{eol}Content-Type: application/octet-stream{eol}{eol}{}{eol}--z{eol}Content-Type: text/plain{eol}{eol}hola{eol}--z--{eol}",
            "q".repeat(1 << 20)
        );
        let shape = shape(raw);
        assert!(!shape.cut && shape.parts == 3, "{eol:?} {shape:?}");
    }
}

#[test]
fn ordinary_messages_are_not_marked_as_cut() {
    let shape = shape(super::tests::MULTIPART.to_owned());
    assert!(!shape.cut && shape.parts > 1);
}

/// `=?aa?q?x` repeated up to `bytes`: encoded words that never close. Upstream scans each to the end of the field and
/// retries at the next `=?` (quadratic); `prefix` goes before each one (` ` for `To:`).
fn open_words(prefix: &str, bytes: usize) -> String {
    format!("{prefix}=?aa?q?x").repeat(bytes / (prefix.len() + 8))
}

/// Unclosed encoded words at top level (`Subject:` and `To:`), through the library alone and through `parse()`.
#[test]
fn unclosed_encoded_words_in_top_level_headers_are_linear() {
    let mut slowest = Duration::ZERO;
    for (header, prefix) in [("Subject", ""), ("To", " ")] {
        let raw = format!("{header}: {}\r\n\r\nx\r\n", open_words(prefix, 250 * 1024));
        let started = Instant::now();
        assert!(super::parse(raw.as_bytes()).is_ok());
        let by_parse = started.elapsed();
        let shape = shape(raw);
        eprintln!("{header}: library {:?}, parse() {by_parse:?}", shape.elapsed);
        slowest = slowest.max(shape.elapsed).max(by_parse);
    }
    assert!(slowest < Duration::from_secs(2), "{slowest:?}");
}

/// Unclosed encoded words in 4 inner parts with `Content-Description:` (the most the header caps allow: ~1 MiB total).
#[test]
fn unclosed_encoded_words_in_inner_parts_are_linear() {
    let part = format!("--z\r\nContent-Description: {}\r\n\r\nx\r\n", open_words("", 250 * 1024));
    let raw = format!("Subject: s\r\nContent-Type: multipart/mixed; boundary=z\r\n\r\n{}--z--\r\n", part.repeat(4));
    let shape = shape(raw);
    eprintln!("4 parts: {:?} ({shape:?})", shape.elapsed);
    assert!(!shape.cut && shape.parts == 5, "{shape:?}");
    assert!(shape.elapsed < Duration::from_secs(2), "{shape:?}");
}

/// `merge_continuations` looks each continuation up among all attributes (quadratic with distinct names). An inner
/// part with as many `aN*1=x;` as fit in 250 KiB. Generous threshold (quadratic cost: 0.3 s measured, ×30) so it does
/// not fail on a loaded machine.
#[test]
fn many_distinct_continuations_are_fast_enough() {
    let mut attributes = String::new();
    for i in 0.. {
        let next = format!("a{i}*1=x;");
        if attributes.len() + next.len() > 250 * 1024 {
            break;
        }
        attributes.push_str(&next);
    }
    let shape = shape(inner_part(&format!("Content-Type: text/plain; {attributes}")));
    eprintln!("continuations: {:?} ({shape:?})", shape.elapsed);
    assert!(!shape.cut && shape.elapsed < Duration::from_secs(10), "{shape:?}");
}

/// No clock: a legitimate encoded word (the RFC says ≤ 75; longer ones tolerated up to ~1 KiB) is decoded; one over
/// 1024 bytes is not (the patch stops scanning it and the text is left as is).
#[test]
fn encoded_words_are_decoded_up_to_1024_bytes() {
    let subject = |encoding: &str, text: &str| {
        let raw = format!("Subject: =?utf-8?{encoding}?{text}?=\r\n\r\nx\r\n");
        MessageParser::default().parse(raw.as_bytes()).expect("message").subject().expect("subject").to_owned()
    };
    assert_eq!(subject("q", "caf=C3=A9_con_leche"), "café con leche");
    assert_eq!(subject("B", "Y2Fmw6k="), "café");
    assert_eq!(subject("q", &"a".repeat(1000)), "a".repeat(1000));
    assert_eq!(subject("b", &base64(&[b'b'; 750]).replace("\r\n", "")), "b".repeat(750));
    let too_long = "a".repeat(2000);
    assert!(subject("q", &too_long).starts_with("=?utf-8?q?aaa"));
    assert!(subject("b", &base64(&[b'b'; 1500]).replace("\r\n", "")).starts_with("=?utf-8?b?"));
}

/// With `name*=x'x'x'…` every `'` used to copy and compare the whole name (RFC 2231, `add_attribute_parameter`):
/// quadratic within a single part's header cap.
#[test]
fn long_rfc2231_names_with_many_quotes_are_fast_enough() {
    let header = format!("Content-Type: text/plain; {}*={}", "n".repeat(125 * 1024), "x'".repeat(125 * 1024 / 2));
    let shape = shape(inner_part(&header));
    eprintln!("R1 RFC 2231: {:?} ({shape:?})", shape.elapsed);
    assert!(!shape.cut && shape.elapsed < Duration::from_secs(10), "{shape:?}");
}
