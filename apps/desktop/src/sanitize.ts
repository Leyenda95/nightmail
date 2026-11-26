// Sanitising of a mail's HTML with DOMPurify, plus building the `srcdoc`.
// The factory receives the `window` so it can be tested with jsdom (`test/sanitize.test.ts`).
import DOMPurify, { type Config } from 'dompurify';
import { base64Bytes, bytesBase64, createImageBudget, imageType } from './images.ts';
import { t } from './i18n/index.ts';
import { createLinkCollector, type LinkList, stripHidden } from './links.ts';
import { buildSrcDoc, cidImage, type InlineImage, isAllowedImageSrc, isCidSrc, isRiskyCss } from './srcdoc.ts';

/** Attributes that load or navigate to an external resource: always removed. */
const URL_ATTRS = ['poster', 'background', 'action', 'formaction', 'ping', 'srcset', 'href', 'xlink:href'];

/** Does it go to the link list? Only http(s) and mailto (the core decides afterwards whether it opens: `mailto:` does not). */
function isShowableUrl(value: string): boolean {
  return /^\s*(https?:|mailto:)/i.test(value);
}

type Win = Parameters<typeof DOMPurify>[0];

/** Clean HTML, the links it had (to show them outside the iframe) and how many remote images were removed. */
export interface SanitizedMail extends LinkList {
  html: string;
  /** `<img>` that were going to load from the network (remote `src` or `srcset`): left unloaded; only counted. */
  remoteImages: number;
}

/** Sanitises a mail; `inline` are the `cid:` images the core delivered when opening it. */
export type Sanitizer = (html: string, inline?: readonly InlineImage[]) => SanitizedMail;

interface FoundLink {
  node: Element;
  href: string;
}

const EMPTY: SanitizedMail = { html: '', links: [], omitted: 0, remoteImages: 0 };

/**
 * Would this URL request something from the network? `http(s):` (also without slashes: `https:host` resolves to
 * `https://host/`) or `//...`. The URL parser strips leading C0 controls and spaces, and tabs and newlines inside,
 * and reads `\` as `/`. It only serves to COUNT what is blocked: what protects is removing the attribute
 * ([`stripUrlAttrs`]) and the `srcdoc` CSP, which do not depend on this.
 */
function isRemoteUrl(value: string): boolean {
  const url = value.replace(/[\t\n\r]/g, '');
  let start = 0;
  while (start < url.length && url.charCodeAt(start) <= 0x20) start += 1; // same as /^[\x00-\x20]*/ (C0 controls and space)
  return /^(https?:|[/\\]{2})/i.test(url.slice(start));
}

/** Is it an `<img>` that was going to load from the network? (remote `src` or any remote candidate in `srcset`) */
function isRemoteImage(node: Element): boolean {
  if (node.localName !== 'img') return false;
  const src = node.getAttribute('src');
  if (src !== null && isRemoteUrl(src)) return true;
  return (node.getAttribute('srcset') ?? '').split(',').some(isRemoteUrl);
}

/** Loose form controls (visual spoofing: "contraseña"...): removed, keeping their text. */
const FORM_CONTROLS = ['input', 'button', 'select', 'textarea', 'option', 'optgroup', 'datalist', 'fieldset', 'legend', 'output', 'meter', 'progress'];

const CONFIG: Config & { RETURN_DOM: true } = {
  USE_PROFILES: { html: true },
  // `template`: its content is not walked by `scrubCss` (and it would be shadow DOM if `shadowrootmode` were ever
  // allowed); DOMPurify removes it with its content (it is in its `FORBID_CONTENTS`).
  FORBID_TAGS: ['link', 'meta', 'base', 'form', 'iframe', 'object', 'embed', 'template', ...FORM_CONTROLS],
  // Without this, the `<style>` of the `<head>` and those at the start of the body are lost.
  FORCE_BODY: true,
  RETURN_DOM: true,
};

/** Removes WHOLE `<style>` elements and `style` attributes with CSS that could load something ([`isRiskyCss`]). */
function scrubCss(body: Element): void {
  body.querySelectorAll('style').forEach((style) => {
    if (isRiskyCss(style.textContent ?? '')) style.remove();
  });
  body.querySelectorAll('[style]').forEach((node) => {
    if (isRiskyCss(node.getAttribute('style') ?? '')) node.removeAttribute('style');
  });
}

function isElement(node: Node): node is Element {
  return node.nodeType === 1;
}

/** Removes everything that loads or navigates; keeps only the `src` set by the image gate ([`createImageGate`]). */
function stripUrlAttrs(node: Element, gate: ImageGate): void {
  for (const name of URL_ATTRS) {
    if (node.hasAttribute(name)) node.removeAttribute(name);
  }
  if (node.hasAttribute('src') && !gate.passed.has(node)) node.removeAttribute('src');
}

/**
 * Cap on `data:` characters that can go into ONE message's paper (about 5 MiB of base64 images plus margin),
 * counting every time one is cited. Without it, an image cited a thousand times would be copied a thousand times and bring the reader down.
 */
export const MAX_INLINE_CHARS = 8 * 1024 * 1024;

interface ImageGate {
  /** Sets the `src` of an `<img>` with a `cid:` or `data:` image: the measured one, or none and the fixed `alt`. */
  check: (node: Element) => void;
  /** The nodes whose `src` was set by `check`: the only `src` that survives. */
  passed: WeakSet<Element>;
}

/**
 * Per-message gate for EVERY image that is painted, whether it comes by `cid:` (delivered by the core) or written in the HTML
 * (`data:`): its bytes are read, the header must fit the limits and the message's shared budget
 * ([`createImageBudget`]; the same image cited again does not count twice) and the `src` is REWRITTEN with those same
 * bytes and the type from their signature, so the browser decodes exactly what was measured. What does not pass
 * (unreadable, over the limit, over budget, base64 that `atob` rejects, `%` or `#` in the URL) is left without `src` and with a fixed `alt`.
 */
function createImageGate(images: readonly InlineImage[]): ImageGate {
  const fits = createImageBudget();
  const measured = new Map<InlineImage | string, string | null>(); // per delivered image or per direct `src`
  const passed = new WeakSet<Element>();
  let chars = MAX_INLINE_CHARS;

  const measure = (data: string): string | null => {
    const bytes = base64Bytes(data);
    const type = bytes === null ? null : imageType(bytes);
    return bytes === null || type === null || !fits(bytes) ? null : `data:${type};base64,${bytesBase64(bytes)}`;
  };

  const check = (node: Element) => {
    const src = node.getAttribute('src');
    if (node.localName !== 'img' || src === null) return;
    let key: InlineImage | string | null;
    let data: string;
    if (isCidSrc(src)) {
      key = cidImage(src, images);
      data = key?.data ?? '';
    } else if (isAllowedImageSrc(src)) {
      key = src;
      data = src.slice(src.indexOf(',') + 1);
    } else {
      return; // neither `cid:` nor an image `data:`: `stripUrlAttrs` removes it
    }
    if (key !== null && !measured.has(key)) measured.set(key, measure(data));
    const url = key === null ? null : (measured.get(key) ?? null);
    if (url !== null && url.length <= chars) {
      chars -= url.length;
      node.setAttribute('src', url);
      passed.add(node);
    } else {
      node.removeAttribute('src');
      node.setAttribute('alt', t().mail.imageUnavailable);
    }
  };
  return { check, passed };
}

/** Numbers the links left in the clean HTML: `title` with the URL and, on `<a>`, the " [n]" mark. */
function markLinks(body: Element, found: FoundLink[]): LinkList {
  const collector = createLinkCollector();
  for (const { node, href } of found) {
    if (!body.contains(node)) continue;
    const n = collector.add(href, node.textContent ?? '');
    node.setAttribute('title', stripHidden(href)); // the tooltip must not read backwards (bidi)
    if (n !== null && node.localName === 'a') node.appendChild(node.ownerDocument.createTextNode(` [${n}]`));
  }
  return collector.result();
}

/**
 * Creates the sanitiser. Links become INERT (no `href`; a click on an `<a href>` would navigate the iframe even if it is
 * `sandbox=""`): they carry the " [n]" mark and the URL in `title`, and open from the list outside, after confirming.
 * `<style>` and inline styles are kept: the `srcdoc` CSP (`default-src 'none'`) stops `url()` or `@import` from
 * loading anything.
 */
export function createSanitizer(win: Win): Sanitizer {
  const purifier = DOMPurify(win);
  let found: FoundLink[] = [];
  let gate = createImageGate([]);
  let remote: Element[] = [];

  // Recorded BEFORE DOMPurify touches the attributes (so they are seen as they came) and only those still in the
  // document count at the end: DOMPurify also walks what it later removes whole (the content of `<template>`).
  // `<img>` that came with a `data:` image (`DATA:` in uppercase too: DOMPurify removes it silently). If the gate does
  // not paint it in the end, they carry the same fixed `alt` as any other rejected image.
  let inlineData = new WeakSet<Element>();
  purifier.addHook('beforeSanitizeAttributes', (node) => {
    if (isRemoteImage(node)) remote.push(node);
    if (node.localName === 'img' && isAllowedImageSrc(node.getAttribute('src') ?? '')) inlineData.add(node);
  });
  purifier.addHook('afterSanitizeAttributes', (node) => {
    const href = node.getAttribute('href') ?? node.getAttribute('xlink:href');
    if (href !== null && isShowableUrl(href)) found.push({ node, href: href.trim() });
    gate.check(node);
    stripUrlAttrs(node, gate);
    if (inlineData.has(node) && !gate.passed.has(node)) node.setAttribute('alt', t().mail.imageUnavailable);
  });

  return (html, inline = []) => {
    found = [];
    remote = [];
    inlineData = new WeakSet();
    gate = createImageGate(inline);
    const body: Node | null = purifier.sanitize(html, CONFIG);
    const kept = remote;
    remote = [];
    // With `RETURN_DOM` DOMPurify returns its `<body>`; anything else: nothing to show (fails closed).
    if (body === null || !isElement(body)) return EMPTY;
    scrubCss(body);
    const links = markLinks(body, found); // before serialising: it sets the marks
    found = [];
    gate = createImageGate([]); // do not retain the message's images
    const remoteImages = kept.filter((node) => body.contains(node)).length;
    return { html: body.innerHTML, ...links, remoteImages };
  };
}

let sanitize: Sanitizer | null = null;

/** Unsanitised HTML (+ the core's `cid:` images) to clean HTML and its links. */
export function sanitizeHtml(html: string, inline: readonly InlineImage[] = []): SanitizedMail {
  sanitize ??= createSanitizer(window);
  return sanitize(html, inline);
}

/** Clean HTML to a `srcdoc` ready for an `iframe sandbox=""`. */
export function cleanToSrcDoc(clean: string): string {
  return buildSrcDoc(clean);
}
