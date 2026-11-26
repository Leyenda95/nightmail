// Sanitising tested with a real DOM (jsdom): no vector can leave a remote URL or a handler.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { MAX_IMAGES } from '../src/images.ts';
import { createSanitizer, MAX_INLINE_CHARS } from '../src/sanitize.ts';
import { b64, dataUrl, gifBytes, jpegBytes, pngBytes } from './image-bytes.ts';

const sanitizeMail = createSanitizer(new JSDOM('').window as unknown as Window & typeof globalThis);
const sanitize = (html: string): string => sanitizeMail(html).html;

const VECTORS = [
  '<a href=https://x/t?u=1 style="position:fixed;inset:0">enlace</a>',
  '<img src=https://x/p.gif>',
  '<img srcset="https://x/a 1x">',
  '<svg><image href=https://x/i/></svg>',
  '<svg><a xlink:href=https://x/s><text>t</text></a></svg>',
  '<video poster=https://x/p></video>',
  '<table background=https://x/b><tr><td>c</td></tr></table>',
  '<form action=https://x><button formaction=https://x>b</button></form>',
  '<a ping=https://x>p</a>',
  '<base href=https://x/>',
  '<link rel=stylesheet href=https://x/s.css>',
  '<meta http-equiv=refresh content="0;url=https://x">',
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<iframe src=https://x></iframe>',
  '<object data=https://x></object>',
  // Cases found by exploration that stay as permanent vectors.
  '<area href=https://x/a>',
  '<audio src=https://x/a.mp3></audio>',
  '<video><source src=https://x/v.mp4><track src=https://x/t.vtt></video>',
  '<embed src=https://x/e>',
  '<a href=https://x target=_blank>t</a>',
  '<p style="background:url(https://x/bg.png)">fondo</p>',
  '<p style="background:URL( \'https://x/bg.png\' )">fondo</p>',
  '<p style="background-image:image-set(\'https://x/a.png\' 1x)">set</p>',
  '<p style="background:u\\72l(https://x/esc.png)">escape</p>',
  '<p style="width:expression(alert(1))">ie</p>',
  '<style>p{background:url(https://x/s.png)}</style><p>s</p>',
  '<style>@import "https://x/i.css";</style><p>i</p>',
  '<style>@im/**/port "https://x/c.css";</style><p>c</p>',
  '<style>@font-face{font-family:f;src:url(https://x/f.woff)}</style><p>f</p>',
  '<style>p{background:\\75rl(https://x/e.png)}</style><p>e</p>',
  '<noscript><img src=https://x/n.gif></noscript>',
  '<template><img src=https://x/t.gif></template>',
  '<math><mi xlink:href=https://x/m>m</mi></math>',
  '<body background=https://x/b.png>cuerpo</body>',
  '<input type=image src=https://x/i.png>',
  '<button formaction=https://x>b</button>',
  '<isindex action=https://x>',
  '<portal src=https://x></portal>',
  '<frameset><frame src=https://x></frameset>',
  // A "/*" inside a CSS string is not a comment.
  `<p style='content:"/*";background:url(https://x/a);color:"*/"'>a</p>`,
  '<style>p::before{content:"/*"} div{background:url(https://x/d)}</style><div>d</div>',
  '<style>@font-face{font-family:f;src:local("/*"),url(https://x/f.woff)}</style><p>e</p>',
  '<style>a{content:"/*"} @import "https://x/i.css"; b{content:"*/"}</style><p>f</p>',
  // `<template>` (and declarative shadow DOM) removed with its content.
  '<div><template shadowrootmode="open"><style>:host{background:url(https://x/dsd)}</style></template></div>',
];

/** Text of all the `<style>` elements that remain. */
function styleText(clean: string): string {
  const doc = new JSDOM(`<body>${clean}</body>`).window.document;
  return [...doc.querySelectorAll('style')].map((s) => s.textContent).join('\n');
}

/** Walks the sanitised HTML: attribute values (except `title`) and text nodes. */
function inspect(clean: string): { attrs: string[]; names: string[]; texts: string[]; tags: string[] } {
  const doc = new JSDOM(`<body>${clean}</body>`).window.document;
  const attrs: string[] = [];
  const names: string[] = [];
  const tags: string[] = [];
  for (const el of doc.body.querySelectorAll('*')) {
    tags.push(el.localName);
    for (const a of el.attributes) {
      names.push(a.name);
      if (a.name !== 'title') attrs.push(a.value);
    }
  }
  return { attrs, names, texts: [doc.body.textContent ?? ''], tags };
}

test('no vector leaves a remote URL in attributes', () => {
  for (const v of VECTORS) {
    const clean = sanitize(v);
    const { attrs } = inspect(clean);
    for (const value of attrs) {
      assert.doesNotMatch(value, /https?:|\/\//i, `${v} → ${clean}`);
    }
  }
});

test('no vector leaves scripts, handlers or loading tags', () => {
  for (const v of VECTORS) {
    const clean = sanitize(v);
    const { names, tags } = inspect(clean);
    assert.ok(!names.some((n) => n.startsWith('on')), `${v} → ${clean}`);
    for (const t of ['script', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'svg']) {
      assert.ok(!tags.includes(t), `${t} en ${v} → ${clean}`);
    }
    for (const n of ['href', 'xlink:href', 'src', 'srcset', 'poster', 'background', 'action', 'formaction', 'ping']) {
      assert.ok(!names.includes(n), `${n} en ${v} → ${clean}`);
    }
  }
});

test('links are left without href, with the [n] mark and the URL in title, the list goes apart', () => {
  const { html, links, omitted } = sanitizeMail(
    '<a href=" https://x/t?u=1 ">pulsa</a><a href="mailto:a@b.c">mail</a><a href="javascript:alert(1)">js</a>' +
      '<a href="https://x/t?u=1">otra vez</a><a href="tel:+34600">tel</a>',
  );
  assert.doesNotMatch(html, /href/i);
  assert.match(html, /pulsa \[1\]/);
  assert.match(html, /otra vez \[1\]/);
  assert.match(html, /title="https:\/\/x\/t\?u=1"/);
  assert.match(html, /mail \[2\]/);
  assert.doesNotMatch(html, /javascript/i);
  assert.doesNotMatch(html, /\[https?:/);
  assert.deepEqual(links, [
    { n: 1, href: 'https://x/t?u=1', text: 'pulsa' },
    { n: 2, href: 'mailto:a@b.c', text: 'mail' },
  ]);
  assert.equal(omitted, 0);
});

test('the link text in the list is what remains after sanitizing, without bidi', () => {
  const { links } = sanitizeMail('<a href="https://malo.example/"><script>oculto</script>banco\u{202E}.example<img src=x></a>');
  assert.deepEqual(links, [{ n: 1, href: 'https://malo.example/', text: 'banco.example' }]);
});

test('<area> goes into the list (without a text mark) and is left without href', () => {
  const { html, links } = sanitizeMail('<map name=m><area href="https://x/a" alt="zona"></map>');
  assert.doesNotMatch(html, /href/i);
  assert.match(html, /<area[^>]+title="https:\/\/x\/a"/);
  assert.deepEqual(links, [{ n: 1, href: 'https://x/a', text: '' }]);
});

test('more than 200 distinct links: the rest are counted and carry no mark', () => {
  const html = Array.from({ length: 205 }, (_, i) => `<a href="https://x/${i}">e${i}</a>`).join(' ');
  const out = sanitizeMail(html);
  assert.equal(out.links.length, 200);
  assert.equal(out.omitted, 5);
  assert.match(out.html, /e199 \[200\]/);
  assert.match(out.html, /<a title="https:\/\/x\/200">e200<\/a>/);
});

test('empty input or no tags', () => {
  assert.deepEqual(sanitizeMail(''), { html: '', links: [], omitted: 0, remoteImages: 0 });
  assert.equal(sanitizeMail('solo texto').html, 'solo texto');
});

test('cid: images delivered → data:, the rest without src and with a fixed alt', () => {
  const images = [{ cid: 'logo@x', mime: 'image/png', data: b64(pngBytes(2, 2)) }];
  const LOGO = dataUrl(pngBytes(2, 2));
  const { html } = sanitizeMail(
    '<img src="cid:logo@x" alt="Logo"><img src="cid:<logo@x>"><img src="cid:falta@x" alt="engaño">' +
      '<video src="cid:logo@x"></video><img src="cid:logo@x" srcset="https://x/a 1x">',
    images,
  );
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  const imgs = [...doc.querySelectorAll('img')];
  assert.deepEqual(
    imgs.map((i) => [i.getAttribute('src'), i.getAttribute('alt')]),
    [
      [LOGO, 'Logo'],
      [LOGO, null],
      [null, 'imagen no disponible'],
      [LOGO, null],
    ],
  );
  assert.equal(doc.querySelector('video')?.hasAttribute('src'), false);
  assert.doesNotMatch(html, /cid:|https?:/);
  // Without delivered images (or without passing the list): none resolves.
  assert.match(sanitize('<img src="cid:logo@x">'), /<img alt="imagen no disponible">/);
});

test('a data: image survives', () => {
  const clean = sanitize(`<img src="${dataUrl(pngBytes(1, 1))}" alt="a">`);
  assert.ok(clean.includes(`src="${dataUrl(pngBytes(1, 1))}"`), clean);
});

test('no vector leaves CSS that loads something in a <style>', () => {
  for (const v of VECTORS) {
    const clean = sanitize(v);
    assert.doesNotMatch(styleText(clean), /url\(|@import|https?:|\\/i, `${v} → ${clean}`);
  }
});

test('<style> in the <head> and at the start of the body are kept (FORCE_BODY)', () => {
  const head = sanitize('<html><head><style>p{color:red}</style></head><body><p>hola</p></body></html>');
  assert.match(head, /<style>p\{color:red\}<\/style>/);
  assert.match(head, /<p>hola<\/p>/);
  const start = sanitize('<style>h1{font-size:2em}</style><h1>t</h1>');
  assert.match(start, /<style>h1\{font-size:2em\}<\/style><h1>t<\/h1>/);
});

test('CSS with url(), @import, image-set(), src(), expression() or escapes: removed ENTIRELY', () => {
  const clean = sanitize(
    '<p style="color:red">ok</p><p style="color:blue;background:url(x)">fuera</p>' +
      '<style>p{color:green}</style><style>p{color:red}/* url( */</style><style>@import "a.css";</style>' +
      '<style>a{b:src(x)}</style><style>a{content:"\\2014"}</style>',
  );
  assert.match(clean, /<p style="color:red">ok<\/p>/);
  assert.match(clean, /<p>fuera<\/p>/);
  assert.match(clean, /<style>p\{color:green\}<\/style>/);
  // Crude on purpose: it is also removed if only the comment says `url(`.
  assert.doesNotMatch(clean, /p\{color:red\}\/\*/);
  assert.equal((clean.match(/<style>/g) ?? []).length, 1);
});

test('<template> removed, with all its content', () => {
  const clean = sanitize('<div><template><style>p{color:red}</style><b>oculto</b></template>visible</div>');
  assert.equal(clean, '<div>visible</div>');
});

test('a link title carries no bidi or invisible characters', () => {
  const { html } = sanitizeMail('<a href="https://evil.example/\u{202E}moc.elpmaxe\u{200B}">x</a>');
  const title = new JSDOM(`<body>${html}</body>`).window.document.querySelector('a')?.getAttribute('title');
  assert.equal(title, 'https://evil.example/moc.elpmaxe');
});

test('src data: only png/jpeg/gif/webp in base64 and only on <img> (never SVG)', () => {
  const GIF = dataUrl(gifBytes(1, 1), 'image/gif');
  const html = sanitize(
    '<img src="data:image/svg+xml;base64,PHN2Zy8+" alt="svg"><img src="data:text/html;base64,PGI+" alt="html">' +
      `<img src="${GIF}" alt="gif"><audio src="data:audio/mpeg;base64,AAAA"></audio>` +
      `<video><source src="${dataUrl(pngBytes(1, 1))}"></video>`,
  );
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  assert.deepEqual(
    [...doc.querySelectorAll('img')].map((i) => [i.getAttribute('alt'), i.getAttribute('src')]),
    [
      ['svg', null],
      ['html', null],
      ['gif', GIF],
    ],
  );
  assert.equal(doc.querySelectorAll('[src]').length, 1);
});

test('images with a per-message character budget: anything over 8 MiB is left without src', () => {
  const big = [...pngBytes(1, 1), ...new Array<number>(9 * 256 * 1024).fill(0)]; // 2.25 MiB to 3 MiB of base64
  const images = [{ cid: 'a@x', mime: 'image/png', data: b64(big) }];
  const html = '<img src="cid:a@x" alt="x">'.repeat(4);
  for (let round = 0; round < 2; round++) {
    // It is restored on each message: the second pass gives the same.
    const out = sanitizeMail(html, images).html;
    const doc = new JSDOM(`<body>${out}</body>`).window.document;
    const imgs = [...doc.querySelectorAll('img')];
    assert.deepEqual(
      imgs.map((i) => [i.hasAttribute('src'), i.getAttribute('alt')]),
      [
        [true, 'x'],
        [true, 'x'],
        [false, 'imagen no disponible'],
        [false, 'imagen no disponible'],
      ],
    );
    assert.ok(out.length < MAX_INLINE_CHARS, `${out.length}`);
  }
});

// ---------------------------------------------------------------- a single gate for every image

/** The `src` of each `<img>` in the clean HTML. */
const shown = (html: string) => [...new JSDOM(`<body>${html}</body>`).window.document.querySelectorAll('img')].map((i) => i.getAttribute('src'));
/** Almost 16 Mpx (the per-image cap): two fit in the message and there is still room for a small one. */
const big = (tail: number) => dataUrl(pngBytes(4000, 3999, tail));
const TINY = dataUrl(pngBytes(1, 1));

test('data: written in the HTML with absurd dimensions or an unreadable header: no src and the fixed text', () => {
  for (const bomb of [
    dataUrl(pngBytes(16384, 16384)),
    dataUrl(gifBytes(1, 1, [[0, 0, 12000, 12000]]), 'image/gif'),
    dataUrl(jpegBytes(30000, 30000), 'image/jpeg'),
    'data:image/png;base64,AAAA',
    // DOMPurify silently removes the `src` with uppercase `DATA:`: it also carries the fixed text.
    dataUrl(pngBytes(1, 1)).replace('data:', 'DATA:'),
    dataUrl(pngBytes(1, 1)).replace('data:', ' Data:'),
  ]) {
    assert.equal(sanitize(`<img src="${bomb}" alt="bomba">`), '<img alt="imagen no disponible">', bomb.slice(0, 40));
  }
});

test('shared per-message budget: cid: and direct data: count together, and it resets for each message', () => {
  for (let round = 0; round < 2; round++) {
    assert.deepEqual(shown(sanitize(`<img src="${big(1)}"><img src="${big(2)}"><img src="${big(3)}"><img src="${TINY}">`)), [
      big(1),
      big(2),
      null,
      TINY,
    ]);
    const images = [{ cid: 'a@x', mime: 'image/png', data: big(1).split(',')[1] ?? '' }];
    assert.deepEqual(shown(sanitizeMail(`<img src="${big(2)}"><img src="cid:a@x"><img src="${big(3)}">`, images).html), [big(2), big(1), null]);
  }
});

test(`the same repeated image counts once, at most ${MAX_IMAGES} distinct ones per message`, () => {
  assert.deepEqual(shown(sanitize(`<img src="${big(1)}">`.repeat(50) + `<img src="${big(2)}">`)), [...new Array(50).fill(big(1)), big(2)]);
  const many = Array.from({ length: MAX_IMAGES + 3 }, (_, i) => dataUrl(pngBytes(1, 1, i)));
  assert.deepEqual(shown(sanitize(many.map((u) => `<img src="${u}">`).join(''))), [...many.slice(0, MAX_IMAGES), null, null, null]);
});

test('what is painted is what was measured: src rewritten with those bytes and the type of its signature', () => {
  const gif = dataUrl(gifBytes(3, 3), 'image/gif');
  const data = gif.split(',')[1] ?? '';
  const spaced = `data:image/PNG;base64, ${data.slice(0, 8)}\n${data.slice(8)}`; // fake type, uppercase, spaces
  const jpeg = dataUrl(jpegBytes(5, 5), 'image/jpeg');
  assert.deepEqual(shown(sanitize(`<img src="${spaced}"><img src=" ${gif} "><img src="${jpeg.replace('jpeg', 'webp')}">`)), [gif, gif, jpeg]);
  // What the browser would read differently (`%` escapes, fragment) or is not a clean `data:` image: out.
  for (const bad of [`${gif}#x`, gif.replace(',', ',%2B'), `\x01${TINY}`]) {
    assert.deepEqual(shown(sanitize(`<img src="${bad}">`)), [null], JSON.stringify(bad.slice(0, 40)));
  }
});

test('loose form controls: removed, keeping their text', () => {
  const clean = sanitize(
    '<fieldset><legend>Acceso</legend><input placeholder="contraseña"><button>Entrar</button>' +
      '<textarea>nota</textarea><select><optgroup label=g><option>uno</option></optgroup></select>' +
      '<datalist><option value=v>dos</option></datalist><output>tres</output><meter value=1>cuatro</meter>' +
      '<progress value=1>cinco</progress></fieldset>',
  );
  for (const tag of ['input', 'button', 'select', 'textarea', 'option', 'optgroup', 'datalist', 'fieldset', 'legend', 'output', 'meter', 'progress']) {
    assert.doesNotMatch(clean, new RegExp(`<${tag}\\b`, 'i'), tag);
  }
  assert.doesNotMatch(clean, /contraseña/);
  for (const text of ['Acceso', 'Entrar', 'nota', 'uno', 'dos', 'tres', 'cuatro', 'cinco']) assert.match(clean, new RegExp(text));
});
