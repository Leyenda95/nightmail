// The reader's link list. Inside the iframe links are inert; here they are collected to show them OUTSIDE, and
// they only open after `inspect_link` + confirmation + `open_link` (the core decides the URL).
// Pure part: tested with `node --test` (`test/links.test.ts`).
import { t } from './i18n/index.ts';

/** A link in the message: `n` is the " [n]" mark it carries inside the iframe. */
export interface MailLink {
  n: number;
  href: string;
  /** Link text, already cleaned (written by the sender, so untrusted). */
  text: string;
}

export interface LinkList {
  links: MailLink[];
  /** Distinct links beyond the cap that are not shown. */
  omitted: number;
}

export const MAX_LINKS = 200;
const MAX_TEXT = 80;

// Controls (except whitespace ones, which collapse), soft hyphen, bidi, zero width, BOM, annotation anchors and
// tags: the same ranges as `link.rs` in the core, plus the C0/C1 controls.
const HIDDEN_RANGES: [number, number][] = [
  [0x00, 0x08],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x61c, 0x61c],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
  [0xfff9, 0xfffb],
  [0xe0000, 0xe007f],
];

function isHidden(char: string): boolean {
  const cp = char.codePointAt(0) ?? 0;
  return HIDDEN_RANGES.some(([from, to]) => cp >= from && cp <= to);
}

/** Without the characters that falsify what is seen (bidi, zero width, controls...); the rest, as is. */
export function stripHidden(raw: string): string {
  return [...raw].filter((c) => !isHidden(c)).join('');
}

/** Link text without characters that falsify what is seen, with collapsed spaces and trimmed to 80. */
export function cleanLinkText(raw: string): string {
  const chars = [...stripHidden(raw).replace(/\s+/g, ' ').trim()];
  return chars.length > MAX_TEXT ? `${chars.slice(0, MAX_TEXT - 1).join('')}…` : chars.join('');
}

/** Numbers the links in order of appearance, without duplicating the same `href`, up to [`MAX_LINKS`]. */
export function createLinkCollector() {
  const numbers = new Map<string, number>();
  const links: MailLink[] = [];
  const over = new Set<string>();
  return {
    /** Number of the link, or `null` if it no longer fits in the list. */
    add(href: string, text: string): number | null {
      const known = numbers.get(href);
      if (known !== undefined) return known;
      if (links.length >= MAX_LINKS) {
        over.add(href);
        return null;
      }
      const n = links.length + 1;
      numbers.set(href, n);
      links.push({ n, href, text: cleanLinkText(text) });
      return n;
    },
    result(): LinkList {
      return { links, omitted: over.size };
    },
  };
}

// Conservative: `http(s)://` and anything that is not whitespace, quotes or `<>`; trailing punctuation is stripped afterwards.
const TEXT_URL = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const TRAILING = /[.,;:!?)\]}'"»]+$/;
const CLOSERS: Record<string, string> = { ')': '(', ']': '[' };

function count(text: string, char: string): number {
  return text.split(char).length - 1;
}

/** Strips trailing punctuation, except a `)`/`]` with a partner inside the URL (`.../Foo_(bar)`, typical of Wikipedia). */
function trimUrlEnd(match: string): string {
  let url = match;
  for (;;) {
    const last = url.at(-1) ?? '';
    const opener = CLOSERS[last];
    const unpaired = opener === undefined || count(url, last) > count(url, opener);
    if (!TRAILING.test(last) || !unpaired) return url;
    url = url.slice(0, -1);
  }
}

/** `http(s)://` links of a text-only mail (the `<pre>` does not change). */
export function extractTextLinks(text: string): LinkList {
  const collector = createLinkCollector();
  for (const [match] of text.matchAll(TEXT_URL)) {
    const href = trimUrlEnd(match);
    collector.add(href, href);
  }
  return collector.result();
}

/** Destination shown in the list: the (ASCII) host of a web link; otherwise its scheme. */
export function destinationLabel(href: string): string {
  try {
    const url = new URL(href);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.host : url.protocol;
  } catch {
    return t().format.invalidLink;
  }
}

/** Comparable host: ASCII, lowercase, without `www.` or port; `null` if it is not one. */
function comparableHost(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

// Something shaped like a domain: dot-separated labels and a final label of at least two letters.
const DOMAIN = /^(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+\p{L}{2,}$/u;

/**
 * Domain that "shows" in a word of the text (`https://x.y/z`, `www.x.y`, `someone@x.y`), or `null`. Only the leading
 * scheme before any `/?#` is stripped (`Enter:https://x.y`); then it is cut at `/?#:` so a path is not taken for a domain.
 */
function domainIn(word: string): string | null {
  const host = word
    .replace(/^[^/?#]*:\/\//, '')
    .replace(/^[^@/]*@/, '')
    .split(/[/?#:]/)[0]
    .replace(TRAILING, '');
  return DOMAIN.test(host) ? host : null;
}

// Separators between "words" of the text: spaces, parentheses, brackets, braces, `<>`, quotes, commas and `;`.
const WORD_BREAK = /[\s()[\]{}<>«»"'“”‘’,;]+/;

/** If the link text looks like a web address of another site, that domain (to warn); otherwise `null`. */
export function textHostMismatch(text: string, host: string): string | null {
  const target = comparableHost(host);
  for (const word of text.split(WORD_BREAK)) {
    const shown = domainIn(word);
    if (shown !== null && comparableHost(shown) !== target) return shown;
  }
  return null;
}

/** `[scheme://, host, rest]` to highlight the host in the confirmation; `null` if it does not fit. */
export function splitUrl(url: string, host: string): [string, string, string] | null {
  const start = url.indexOf('://') + 3;
  if (start < 3 || !url.startsWith(host, start)) return null;
  return [url.slice(0, start), host, url.slice(start + host.length)];
}
