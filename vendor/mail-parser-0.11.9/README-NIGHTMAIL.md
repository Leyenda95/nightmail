# mail-parser 0.11.9, patched for NightMail

A copy of `mail-parser` 0.11.9 from crates.io, without `tests/`, `resources/` or `examples/`. `apps/desktop/src-tauri` uses it through `[patch.crates-io]`.

The exact changes against the original crate are in [`nightmail.patch`](nightmail.patch), a unified diff. To check it, copy the original 0.11.9 sources and run `patch -p1 < nightmail.patch` in that copy: the result matches this folder.

## Motivation

A hostile email could bring down the core while it was being parsed:

- Unencoded `message/rfc822` parts nested without limit. The tree is built with its own stack, but dropping the `Message` is recursive and overflows the thread stack (2 MiB in `spawn_blocking`). The process aborts, and it happens again on every sync. Spaces in the header name (`Content -Type`, ` Content-Type`) got past NightMail's own linear pass.
- Encoded (base64) `message/rfc822` parts. They are parsed with `parse_` on the decoded bytes. `MAX_NESTED_ENCODED` only counts encoded levels. Each level copies its `raw_message` (N × size: 300 × 24 MiB ≈ 7 GB), and `into_owned` is recursive.
- `--b` boundaries in the middle of a line, and `multipart/digest` (whose parts are `message/rfc822` by default): millions of parts.

Also, the headers of an inner part had no limit. Joining `n*1=…` continuations is quadratic (2.3 s in release with 2 MiB, minutes with more), and a repeated `a:` gives millions of headers (×40 in memory). A multipart boundary that does not exist was searched up to the end once per part (1000 × the size of the message).

Finally, an RFC 2047 encoded word (`=?cs?q?…`) that is never closed was read up to the end of the field. It failed, and the parser tried again at the next `=?`: (bytes in the field)² / 16 steps, even within the header limits. Measured (test profile, library at opt-level 3): a `Subject:` with `=?aa?q?x` × 32,000 (250 KiB) took 7.0 s, and 4 inner parts with such a `Content-Description:` (about 1 MiB) took 27.6 s per message. With the limit: 55 ms and 220 ms.

## Changes

In `src/parsers/message.rs`, the encoded-word decoders in `src/decoders/` and the manifest:

- `MAX_DEPTH = 32`: a multipart or unencoded `message/rfc822` deeper than this is read as an opaque (binary) part.
- `MAX_PARTS = 1000`, counting every level: past it, parsing stops and what was read is kept.
- An encoded `message/rfc822` is no longer parsed: it stays as a binary attachment (`PartType::Binary`).
- `MAX_PART_HEADER_BYTES = 256 KiB`: before reading the headers of an inner part, the parser looks for their end (an empty line) in the next 256 KiB. If it is not there, parsing stops.
- `MAX_FAILED_SEEKS = 8`: after 8 boundaries searched for in vain, any further multipart is read as an opaque part.
- `MAX_TOTAL_HEADER_BYTES = 1 MiB`: a limit on header bytes across all parts (128 parts × 256 KiB of `a:` would be about 1 GB). Past it, parsing stops. The search for the end of the headers is a single pass, from line break to line break.
- If any limit cut the parsing short, part 0 gets `is_encoding_problem = true` (NightMail shows it as an incomplete message).
- `MAX_ENCODED_WORD = 1024` (`decoders/encoded_word.rs`): `decode_quoted_printable_word` and `decode_base64_word` stop reading an encoded word after 1024 bytes of INPUT from its start (not of output: `\r` and the spaces of a folded line move forward without writing anything) and treat it as invalid. The text stays as it is. The standard says ≤ 75. Cost: ≤ 1024 × attempts (linear).
- `Cargo.toml`: the `[[example]]` and `[[test]]` entries are removed (their files are not copied).

Checked with a probe that feeds the same input to the original crate and to this copy. The original aborts (stack overflow) or produces 10⁵ to 10⁶ parts, millions of headers, a 300 MB peak or seconds of CPU. This copy does none of that.

This is a temporary fix. The planned alternative is mail-parser 1.0.x (`max_depth`, `max_parts`…) once the project uses rustc 1.98 or later, after checking that it does not copy N × size.
