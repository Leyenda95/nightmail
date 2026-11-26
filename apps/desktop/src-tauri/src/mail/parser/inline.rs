//! Inline images (`<img src="cid:…">`). Only PNG, JPEG, GIF and WebP (never SVG, which is a document with scripts
//! and links), with a `Content-ID` and within the caps. Anything over a cap is not delivered, only counted in
//! `omitted`. They reach the UI only when a message is opened (`MessageDetail`), never in the list.

use std::fmt;

use mail_parser::{Message, MessagePart, MimeHeaders};

pub const MAX_INLINE_IMAGES: usize = 20;
pub const MAX_INLINE_IMAGE_BYTES: usize = 2 << 20;
pub const MAX_INLINE_TOTAL_BYTES: usize = 5 << 20;
/// A longer `Content-ID` is ignored (not an inline image).
pub const MAX_CID_CHARS: usize = 256;

/// Delivered types; the `mime` the UI sees comes only from this list.
const IMAGE_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

#[derive(Clone, PartialEq, Eq)]
pub struct InlineImage {
    /// `Content-ID` without `<>`.
    pub cid: String,
    pub mime: &'static str,
    pub bytes: Vec<u8>,
}

/// No content: `Debug` output may end up in a log.
impl fmt::Debug for InlineImage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("InlineImage").field("mime", &self.mime).field("bytes", &self.bytes.len()).finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InlineImages {
    pub images: Vec<InlineImage>,
    /// Valid images not delivered because of the caps (or a repeated `Content-ID`).
    pub omitted: usize,
}

/// `Content-ID` without `<>`, visible ASCII only, no longer than [`MAX_CID_CHARS`].
fn content_id(part: &MessagePart<'_>) -> Option<String> {
    let cid = part.content_id()?.trim().trim_start_matches('<').trim_end_matches('>');
    let valid = !cid.is_empty() && cid.len() <= MAX_CID_CHARS && cid.bytes().all(|b| b.is_ascii_graphic());
    valid.then(|| cid.to_owned())
}

/// Declared type, if it is on the list.
fn image_type(part: &MessagePart<'_>) -> Option<&'static str> {
    let ct = part.content_type()?;
    let declared = format!("{}/{}", ct.ctype(), ct.subtype()?).to_ascii_lowercase();
    IMAGE_TYPES.into_iter().find(|t| *t == declared)
}

impl InlineImages {
    /// Whether one more image of `len` bytes with this `cid` fits.
    fn fits(&self, cid: &str, len: usize, total: usize) -> bool {
        self.images.len() < MAX_INLINE_IMAGES
            && len <= MAX_INLINE_IMAGE_BYTES
            && total + len <= MAX_INLINE_TOTAL_BYTES
            && !self.images.iter().any(|i| i.cid == cid)
    }
}

/// The message's inline images, in order, within the caps.
pub fn collect(message: &Message<'_>) -> InlineImages {
    let mut out = InlineImages::default();
    let mut total = 0;
    for part in &message.parts {
        let (Some(cid), Some(mime)) = (content_id(part), image_type(part)) else { continue };
        let bytes = part.contents();
        if !out.fits(&cid, bytes.len(), total) {
            out.omitted += 1;
            continue;
        }
        total += bytes.len();
        out.images.push(InlineImage { cid, mime, bytes: bytes.to_vec() });
    }
    out
}

#[cfg(test)]
mod tests {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use mail_parser::MessageParser;

    use super::*;

    /// `multipart/related` with an HTML part and one part per image: `(Content-ID header or "", type, bytes)`.
    fn related(parts: &[(&str, &str, &[u8])]) -> String {
        let images: String = parts
            .iter()
            .map(|(cid, ctype, bytes)| {
                let id = if cid.is_empty() { String::new() } else { format!("Content-ID: {cid}\r\n") };
                format!("--r\r\nContent-Type: {ctype}\r\n{id}Content-Transfer-Encoding: base64\r\n\r\n{}\r\n", STANDARD.encode(bytes))
            })
            .collect();
        format!(
            "Subject: imagenes\r\nContent-Type: multipart/related; boundary=r\r\n\r\n\
             --r\r\nContent-Type: text/html\r\n\r\n<img src=\"cid:a@x\">\r\n{images}--r--\r\n"
        )
    }

    fn inline(parts: &[(&str, &str, &[u8])]) -> InlineImages {
        let raw = related(parts);
        collect(&MessageParser::default().parse(raw.as_bytes()).unwrap())
    }

    #[test]
    fn delivers_the_four_allowed_types_with_their_bytes() {
        let got = inline(&[
            ("<a@x>", "image/png", b"png"),
            ("<b@x>", "IMAGE/JPEG", b"jpg"),
            ("c@x", "image/gif; name=c.gif", b"gif"),
            (" <d@x> ", "image/webp", b"webp"),
        ]);
        let summary: Vec<_> = got.images.iter().map(|i| (i.cid.as_str(), i.mime, i.bytes.as_slice())).collect();
        assert_eq!(
            summary,
            [
                ("a@x", "image/png", &b"png"[..]),
                ("b@x", "image/jpeg", &b"jpg"[..]),
                ("c@x", "image/gif", &b"gif"[..]),
                ("d@x", "image/webp", &b"webp"[..]),
            ]
        );
        assert_eq!(got.omitted, 0);
    }

    #[test]
    fn never_svg_nor_other_types_nor_parts_without_a_valid_content_id() {
        let long = format!("<{}>", "a".repeat(MAX_CID_CHARS + 1));
        let got = inline(&[
            ("<svg@x>", "image/svg+xml", b"<svg/>"),
            ("<html@x>", "text/html", b"<p>"),
            ("<bin@x>", "application/octet-stream", b"bin"),
            ("<bmp@x>", "image/bmp", b"bmp"),
            ("", "image/png", b"sin cid"),
            ("<>", "image/png", b"cid vacio"),
            ("<a b@x>", "image/png", b"espacio"),
            ("<\u{e9}@x>", "image/png", b"no ascii"),
            (&long, "image/png", b"largo"),
        ]);
        assert!(got.images.is_empty(), "{:?}", got.images);
        assert_eq!(got.omitted, 0);
    }

    #[test]
    fn at_most_twenty_images() {
        let cids: Vec<String> = (0..MAX_INLINE_IMAGES + 2).map(|i| format!("<i{i}@x>")).collect();
        let parts: Vec<(&str, &str, &[u8])> = cids.iter().map(|c| (c.as_str(), "image/png", &b"p"[..])).collect();
        let got = inline(&parts);
        assert_eq!(got.images.len(), MAX_INLINE_IMAGES);
        assert_eq!(got.images.last().unwrap().cid, format!("i{}@x", MAX_INLINE_IMAGES - 1));
        assert_eq!(got.omitted, 2);
    }

    #[test]
    fn size_caps_per_image_and_in_total() {
        let big = vec![7u8; MAX_INLINE_IMAGE_BYTES + 1];
        let max = vec![1u8; MAX_INLINE_IMAGE_BYTES];
        let got = inline(&[
            ("<big@x>", "image/png", &big),
            ("<m1@x>", "image/png", &max),
            ("<m2@x>", "image/png", &max),
            ("<m3@x>", "image/png", &max),
            ("<small@x>", "image/png", &[1u8; 1000]),
        ]);
        let cids: Vec<_> = got.images.iter().map(|i| i.cid.as_str()).collect();
        // 2 + 2 MiB fit; a third 2 MiB one would exceed 5 MiB; the small one fits.
        assert_eq!(cids, ["m1@x", "m2@x", "small@x"]);
        assert_eq!(got.omitted, 2);
        assert!(got.images.iter().map(|i| i.bytes.len()).sum::<usize>() <= MAX_INLINE_TOTAL_BYTES);
    }

    #[test]
    fn a_repeated_content_id_keeps_the_first() {
        let got = inline(&[("<a@x>", "image/png", b"uno"), ("<a@x>", "image/gif", b"dos")]);
        assert_eq!(got.images.len(), 1);
        assert_eq!(got.images[0].bytes, b"uno");
        assert_eq!(got.omitted, 1);
    }

    #[test]
    fn the_parser_delivers_them_with_the_message() {
        let raw = related(&[("<a@x>", "image/png", b"png"), ("<s@x>", "image/svg+xml", b"<svg/>")]);
        let parsed = crate::mail::parser::parse(raw.as_bytes()).unwrap();
        assert_eq!(parsed.inline.images.len(), 1);
        assert_eq!(parsed.inline.images[0].cid, "a@x");
        assert_eq!(parsed.html.as_deref(), Some("<img src=\"cid:a@x\">"));
    }

    #[test]
    fn debug_output_carries_no_content() {
        let got = inline(&[("<secreto@x>", "image/png", b"bytes secretos")]);
        let debug = format!("{got:?}");
        assert!(!debug.contains("secreto"), "{debug}");
        assert!(debug.contains("image/png"));
    }
}
