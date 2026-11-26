// RFC 5322 / MIME message building.
import { randomBytes, randomUUID } from "node:crypto";

export interface Mailbox {
  name?: string;
  address: string;
}

export interface Attachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
}

/** Image referenced from the HTML as `<img src="cid:…">`. */
export interface InlineImage extends Attachment {
  /** `Content-ID` without `<>`. */
  cid: string;
}

export interface MessageSpec {
  from: Mailbox;
  to: Mailbox[];
  subject: string;
  text: string;
  /** Text body encoding: base64 (default) or 8bit (raw UTF-8 with CRLF). */
  encoding?: "base64" | "8bit";
  /** HTML version (alternative to the text). */
  html?: string;
  /** Inline images used by the HTML. */
  inline?: InlineImage[];
  attachment?: Attachment;
  date?: Date;
  messageId?: string;
  /** Message-ID domain (defaults to the sender's). */
  domain?: string;
}

const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;
const MAX_LINE = 76;
const CRLF = /\r\n|\r|\n/g;

/** Text bytes that fit in an encoded word of `width` columns ("=?utf-8?B?" + base64 + "?=" adds 12 fixed). */
function wordBytes(width: number): number {
  return Math.max(3, Math.floor((width - 12) / 4) * 3);
}

/**
 * RFC 2047-encodes a header value if it has non-ASCII characters.
 * `offset` is the width already taken by the header name ("Subject: " = 9), so no line exceeds 76 characters.
 */
export function encodeHeaderValue(value: string, offset = 0): string {
  if (ASCII_PRINTABLE.test(value)) return value;
  const words: string[] = [];
  let current = "";
  let bytes = 0;
  let limit = wordBytes(MAX_LINE - offset);
  for (const char of value) {
    const size = Buffer.byteLength(char);
    if (bytes + size > limit) {
      words.push(current);
      current = "";
      bytes = 0;
      limit = wordBytes(MAX_LINE - 1); // continuation lines start with a space
    }
    current += char;
    bytes += size;
  }
  words.push(current);
  return words.map((w) => `=?utf-8?B?${Buffer.from(w).toString("base64")}?=`).join("\r\n ");
}

export function formatMailbox({ name, address }: Mailbox, offset = 0): string {
  if (!name) return address;
  const encoded = ASCII_PRINTABLE.test(name) ? `"${name.replace(/(["\\])/g, "\\$1")}"` : encodeHeaderValue(name, offset);
  return `${encoded} <${address}>`;
}

/** RFC 5322 date with a numeric zone. */
export function formatDate(date: Date): string {
  return date.toUTCString().replace("GMT", "+0000");
}

/** Base64 in 76-character lines separated by CRLF. */
export function base64Lines(content: Uint8Array | string): string {
  const b64 = Buffer.from(content).toString("base64");
  return (b64.match(/.{1,76}/g) ?? []).join("\r\n");
}

/** MIME parameter: `name="value"` (escaped), or RFC 2231 (`name*=UTF-8''%C3%A9`) when not ASCII. */
export function mimeParameter(name: string, value: string): string {
  if (ASCII_PRINTABLE.test(value)) return `${name}="${value.replace(/(["\\])/g, "\\$1")}"`;
  const encoded = [...Buffer.from(value)]
    .map((b) => {
      const c = String.fromCharCode(b);
      return /[A-Za-z0-9!#$&+.^_`|~-]/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
  return `${name}*=UTF-8''${encoded}`;
}

const toCrlf = (text: string): string => text.replace(CRLF, "\r\n");

function textPart(text: string, encoding: "base64" | "8bit"): string[] {
  const body = toCrlf(text);
  return [
    "Content-Type: text/plain; charset=utf-8",
    `Content-Transfer-Encoding: ${encoding}`,
    "",
    encoding === "base64" ? base64Lines(body) : body,
  ];
}

function htmlPart(html: string): string[] {
  return ["Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "", base64Lines(toCrlf(html))];
}

function filePart(a: Attachment, disposition: "attachment" | "inline", extra: string[] = []): string[] {
  return [
    `Content-Type: ${a.contentType};\r\n ${mimeParameter("name", a.filename)}`,
    "Content-Transfer-Encoding: base64",
    ...extra,
    `Content-Disposition: ${disposition};\r\n ${mimeParameter("filename", a.filename)}`,
    "",
    base64Lines(a.content),
  ];
}

/**
 * A MIME part (headers, blank line, body) made of other parts. `related` declares its root, which here is always the
 * first part and always HTML (`type` is mandatory per RFC 2387).
 */
function multipart(subtype: "mixed" | "alternative" | "related", parts: string[][]): string[] {
  const boundary = `=_nightmail_${randomUUID()}`;
  const type = subtype === "related" ? ' type="text/html";' : "";
  return [
    `Content-Type: multipart/${subtype};${type}\r\n boundary="${boundary}"`,
    "",
    ...parts.flatMap((part) => [`--${boundary}`, ...part]),
    `--${boundary}--`,
  ];
}

/** MIME tree: text (or text + HTML with its inline images) plus the attachment, if any, alongside. */
function bodyPart(spec: MessageSpec): string[] {
  const text = textPart(spec.text, spec.encoding ?? "base64");
  const images = (spec.inline ?? []).map((i) => filePart(i, "inline", [`Content-ID: <${i.cid}>`]));
  const html = spec.html === undefined ? undefined : htmlPart(spec.html);
  const rich = html && (images.length ? multipart("related", [html, ...images]) : html);
  const readable = rich ? multipart("alternative", [text, rich]) : text;
  return spec.attachment ? multipart("mixed", [readable, filePart(spec.attachment, "attachment")]) : readable;
}

/** Full message with CRLF line endings. */
export function buildMessage(spec: MessageSpec): string {
  const domain = spec.domain ?? spec.from.address.split("@")[1] ?? "nightmail.local";
  const headers = [
    `Date: ${formatDate(spec.date ?? new Date())}`,
    `Message-ID: ${spec.messageId ?? `<${randomBytes(8).toString("hex")}@${domain}>`}`,
    `From: ${formatMailbox(spec.from, "From: ".length)}`,
    `To: ${spec.to.map((m) => formatMailbox(m, "To: ".length)).join(", ")}`,
    `Subject: ${encodeHeaderValue(spec.subject, "Subject: ".length)}`,
    "MIME-Version: 1.0",
  ];
  return [...headers, ...bodyPart(spec)].join("\r\n") + "\r\n";
}
