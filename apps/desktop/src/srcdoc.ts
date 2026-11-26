// Builds the reader's `srcdoc`. Pure part (no DOM) so it can be tested with `node --test`.
// Contract: the header of `mail/parser.rs`.

/** CSP of the mail document: nothing remote; only `data:`/`cid:` images and inline styles. */
export const READER_CSP = "default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'";

/**
 * Base sheet of the "paper": mail is always read on a light background, even with the app in dark mode (it is
 * designed for white and is not rewritten), with its own font and margin and without overflowing sideways. A
 * blocked image (no `src`) shows its text in a box; with no text (a tracking pixel) it leaves no gap.
 *
 * It is fixed text, with nothing from the message, and meets the same condition as the sender's styles ([`isRiskyCss`]):
 * it cannot load anything. There are no brand tokens inside the sandbox: the colours (Noche, Alba, Añil) are written out, and
 * a test checks they still match `design/brand/tokens.css`.
 */
export const PAPER_SHEET =
  'html{color-scheme:light}' +
  "body{margin:16px;font:15px/1.55 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#0a1828;background:#ffffff;overflow-wrap:break-word}" +
  'img{max-width:100%;height:auto}' +
  'img:not([src]){display:inline-block;border:1px dashed #b8b2a3;border-radius:6px;padding:2px 8px;font-size:12px;color:#5a687b}' +
  "img:not([src]):not([alt]),img[alt='']:not([src]){display:none}" +
  'a{color:#1c4a7a;text-decoration:underline}' +
  'table{max-width:100%}' +
  'pre{white-space:pre-wrap}' +
  // Own scrollbar: WebKitGTK's native one (Adwaita) repaints endlessly without a GPU (~90 % of a core; see app.css).
  '::-webkit-scrollbar{width:10px;height:10px}' +
  '::-webkit-scrollbar-thumb{background:#b8b2a3;border:2px solid transparent;border-radius:5px;background-clip:padding-box}';

/**
 * The reader iframe's document: the CSP meta comes FIRST (it governs everything after it, our sheet included), then
 * the base sheet and, last, the already sanitised HTML: the sender's styles come after and may override the base
 * sheet, but nothing from the mail sits before the CSP.
 */
export function buildSrcDoc(cleanHtml: string): string {
  return (
    `<meta http-equiv="Content-Security-Policy" content="${READER_CSP}">` +
    `<meta http-equiv="x-dns-prefetch-control" content="off">` +
    `<style>${PAPER_SHEET}</style>${cleanHtml}`
  );
}

/** CSS functions or rules that can load something, and escapes (`\75rl(` = `url(`). */
const RISKY_CSS = /\\|url\(|@import|image-set\(|src\(|expression\(/i;

/**
 * Can this CSS load something? Defence in depth (the `srcdoc` CSP already prevents it): any `url(`,
 * `@import`, `image-set(`, `src(`, `expression(` or `\` counts, in the CSS as is OR without comments. Both must be
 * checked: a "/*" inside a string is not a comment (removing it would hide what follows), and a comment
 * can split a word (`@im/**\/port`). Crude on purpose: when in doubt, the whole attribute or `<style>` is
 * removed (even if only a comment says `url(`).
 */
export function isRiskyCss(css: string): boolean {
  return RISKY_CSS.test(css) || RISKY_CSS.test(css.replace(/\/\*[\s\S]*?(\*\/|$)/g, ''));
}

/** Inline image delivered by the core (same shape as `InlineImageView`). */
export interface InlineImage {
  cid: string;
  mime: string;
  data: string;
}

/** The types the core delivers (`mail/parser/inline.rs`); any other is not painted. */
const INLINE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Is it a `cid:...` `src`? */
export function isCidSrc(value: string): boolean {
  return /^\s*cid:/i.test(value);
}

/**
 * `cid:X` to the image delivered by the core if X (without `<>`, exact comparison) is among them, with a type from its
 * list and clean base64; otherwise `null` (the image is left without `src`).
 */
export function cidImage(src: string, images: readonly InlineImage[]): InlineImage | null {
  if (!isCidSrc(src)) return null;
  const cid = src.trim().slice(4).replace(/^</, '').replace(/>$/, '');
  const image = images.find((i) => i.cid === cid);
  return image && INLINE_TYPES.includes(image.mime) && BASE64.test(image.data) ? image : null;
}

/**
 * Is it an allowed image `src` value? Only base64 `data:` of the same types the core delivers
 * ([`INLINE_TYPES`]); never SVG or anything remote. It is not enough to paint it: the sanitiser runs it through its image gate
 * (limits and budget) and rewrites the `src` with the measured bytes.
 */
export function isAllowedImageSrc(value: string): boolean {
  return /^\s*data:image\/(png|jpeg|gif|webp);base64,/i.test(value);
}
