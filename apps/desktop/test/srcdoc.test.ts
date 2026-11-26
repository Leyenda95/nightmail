// The document painted in the reader's iframe: the CSP in front, the own base sheet and, behind, the already
// sanitised mail. With a real DOM (jsdom), to test the sanitiser + `buildSrcDoc` composition end to end.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createSanitizer } from '../src/sanitize.ts';
import { buildSrcDoc, isRiskyCss, PAPER_SHEET, READER_CSP } from '../src/srcdoc.ts';
import { dataUrl, pngBytes } from './image-bytes.ts';

const sanitizeMail = createSanitizer(new JSDOM('').window as unknown as Window & typeof globalThis);
/** The mail as the iframe will parse it: sanitised, with the CSP and the base sheet in front. */
const paperWindow = (mail: string) => new JSDOM(buildSrcDoc(sanitizeMail(mail).html)).window;
const paper = (mail: string) => paperWindow(mail).document;

const cspMetas = (doc: Document) => [...doc.querySelectorAll('meta')].filter((m) => /content-security-policy/i.test(m.httpEquiv));

test('the document starts with the CSP, then the base stylesheet and, after it, the mail', () => {
  assert.equal(
    buildSrcDoc('<p>hola</p>'),
    `<meta http-equiv="Content-Security-Policy" content="${READER_CSP}">` +
      `<meta http-equiv="x-dns-prefetch-control" content="off"><style>${PAPER_SHEET}</style><p>hola</p>`,
  );
  const doc = paper('<style>p{color:red}</style><p>hola</p>');
  const [csp, prefetch, base] = doc.head.children;
  assert.equal(csp?.getAttribute('http-equiv'), 'Content-Security-Policy');
  assert.equal(csp?.getAttribute('content'), READER_CSP);
  assert.equal(prefetch?.getAttribute('http-equiv'), 'x-dns-prefetch-control');
  assert.equal(base?.localName, 'style');
  assert.equal(base?.textContent, PAPER_SHEET);
  assert.equal(doc.body.textContent, 'hola');
});

test('the paper CSP does not change: nothing remote, no scripts, only data:/cid: images and inline styles', () => {
  // Fixed letter by letter: loosening it requires touching this test.
  assert.equal(READER_CSP, "default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'");
});

test('the base stylesheet meets the sender styles condition: it cannot load anything nor escape its <style>', () => {
  assert.equal(isRiskyCss(PAPER_SHEET), false);
  assert.doesNotMatch(PAPER_SHEET, /[<>@\\]|https?:|\/\//);
});

test("the base stylesheet colours are the brand's (there are no tokens inside the sandbox: they are written out)", () => {
  const tokens = readFileSync(new URL('../../../design/brand/tokens.css', import.meta.url), 'utf8');
  const colors = PAPER_SHEET.match(/#[0-9a-f]+/gi) ?? [];
  assert.ok(colors.length >= 4, 'the colours were not read');
  for (const color of colors) {
    assert.match(color, /^#[0-9a-f]{6}$/, color);
    assert.ok(tokens.includes(`: ${color};`), `${color} is not in tokens.css`);
  }
});

test('the paper is light also with the app in dark mode, and the mail does not overflow horizontally', () => {
  assert.match(PAPER_SHEET, /html\{color-scheme:light\}/);
  assert.match(PAPER_SHEET, /body\{[^}]*background:#ffffff/);
  assert.match(PAPER_SHEET, /img\{max-width:100%;height:auto\}/);
  assert.match(PAPER_SHEET, /table\{max-width:100%\}/);
});

test('the sender styles go after the base stylesheet: they override it, they do not remove it', () => {
  const doc = paper('<html><head><style>body{background:#000}</style></head><body><p style="color:#fff">noche</p></body></html>');
  const styles = [...doc.querySelectorAll('style')];
  assert.equal(styles.length, 2);
  assert.equal(styles[0]?.textContent, PAPER_SHEET);
  assert.equal(styles[1]?.textContent, 'body{background:#000}');
});

// Mail that tries to get ahead of the CSP, close the base sheet or sneak in something active or remote.
const HOSTILE = [
  `<meta http-equiv="Content-Security-Policy" content="default-src *; script-src * 'unsafe-inline'"><p>a</p>`,
  '</style><script>alert(1)</script><p>b</p>',
  '<head><base href="https://x/"><link rel=stylesheet href="https://x/s.css"></head><p>c</p>',
  '<html><head><style>*{background:url(https://x/p)}</style></head><body onload=alert(1)><img src="https://x/p.gif"><p>d</p></body></html>',
  '<!--><script>alert(1)</script>--><p>e</p>',
  '<style></style><meta http-equiv=refresh content="0;url=https://x"><p>f</p>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe><p>g</p>',
  '<svg><style><img src=https://x/a onerror=alert(1)></style></svg><p>h</p>',
  '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=alert(1)&gt;"><p>i</p>',
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript><p>j</p>',
  '<style>html{color-scheme:dark}</style><style>@import "https://x/i.css";</style><p>k</p>',
  '<form action="https://x"><input name=clave><button>Entrar</button></form><p>l</p>',
  '<a href="javascript:alert(1)">m</a><a href="https://x/m" target="_top">m</a>',
  '<img src="cid:no-entregada" srcset="https://x/n 2x"><object data="https://x/o"></object><embed src="https://x/e"><p>n</p>',
];

test('a hostile mail does not get ahead of the CSP, does not add another and does not touch the base stylesheet', () => {
  for (const mail of HOSTILE) {
    const doc = paper(mail);
    const metas = cspMetas(doc);
    assert.equal(metas.length, 1, mail);
    assert.equal(metas[0], doc.head.firstElementChild, mail);
    assert.equal(metas[0]?.getAttribute('content'), READER_CSP, mail);
    assert.equal(doc.querySelector('style')?.textContent, PAPER_SHEET, mail);
  }
});

test('a hostile mail leaves nothing active, remote or navigable on the paper', () => {
  for (const mail of HOSTILE) {
    const doc = paper(mail);
    assert.equal(doc.querySelectorAll('script, iframe, object, embed, link, base, form, input, button, meta[http-equiv=refresh]').length, 0, mail);
    for (const node of doc.querySelectorAll('*')) {
      for (const attr of node.attributes) {
        assert.doesNotMatch(attr.name, /^on|^(href|xlink:href|srcset|action|formaction|background|poster|ping|target)$/i, `${attr.name} en ${mail}`);
        // `title` carries the link's URL on purpose (it is text, it loads nothing); `content` is that of our metas.
        if (attr.name !== 'title' && attr.name !== 'content') assert.doesNotMatch(attr.value, /https?:|javascript:|\/\//i, `${attr.name} en ${mail}`);
      }
    }
    for (const style of doc.querySelectorAll('style')) assert.equal(isRiskyCss(style.textContent ?? ''), false, mail);
    for (const img of doc.querySelectorAll('img[src]')) assert.match(img.getAttribute('src') ?? '', /^data:image\/(png|jpeg|gif|webp);base64,/, mail);
  }
});

test('a blocked image without text leaves no gap (tracking pixel), with text the text is shown', () => {
  const win = paperWindow(
    '<img src="https://x/pixel.gif" width="1" height="1"><img src="https://x/vacia.gif" alt="">' +
      `<img src="https://x/mapa.png" alt="Mapa del envío"><img src="${dataUrl(pngBytes(1, 1))}" alt="logo">`,
  );
  const display = [...win.document.querySelectorAll('img')].map((img) => win.getComputedStyle(img).display);
  assert.deepEqual(display.slice(0, 3), ['none', 'none', 'inline-block']);
  assert.notEqual(display[3], 'none');
  assert.equal(display.length, 4);
});
