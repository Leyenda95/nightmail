// Remote images blocked (they are counted, never loaded) and inline images that do not decode (treated as not
// delivered). With jsdom for the sanitiser and a fake decoder for the pure part.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import {
  base64Bytes,
  citedImages,
  decodableImages,
  decodeInBrowser,
  type ImageDecoder,
  imageSize,
  imageType,
  MAX_GIF_FRAMES,
  MAX_IMAGES,
  MAX_JPEG_SCANS,
  MAX_PIXELS,
  MAX_SIDE,
  MAX_TOTAL_PIXELS,
  remoteImagesNote,
} from '../src/images.ts';
import { createSanitizer } from '../src/sanitize.ts';
import { buildSrcDoc } from '../src/srcdoc.ts';
import { asc, be32, dataUrl, type Frame, gifBytes, hex, img, jpegBytes, le16, pngBytes, riff, vp8, vp8l, vp8x } from './image-bytes.ts';

const sanitizeMail = createSanitizer(new JSDOM('').window as unknown as Window & typeof globalThis);
/** A 1 x 1 PNG written as is in the HTML. */
const TINY = dataUrl(pngBytes(1, 1));

/** Attributes of all the clean HTML that could request something from the network. */
function remoteAttrs(html: string): string[] {
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  return [...doc.querySelectorAll('*')].flatMap((node) =>
    [...node.attributes].filter((a) => a.name !== 'title' && /https?:|\/\/|\\\\/i.test(a.value)).map((a) => `${node.localName}[${a.name}=${a.value}]`),
  );
}

// ---------------------------------------------------------------- remote: counted and removed

test('remote images are counted and none is left with something to load', () => {
  const mail =
    '<img src="https://x/a.png"><img src="http://x/b.gif" alt="b"><img src="//x/c.png">' +
    `<img srcset="https://x/d 1x, https://x/d2 2x"><img src="${TINY}" srcset="https://x/e 2x">` +
    '<img src="ht\ttps://x/f.png"><img src="HTTPS://X/G.PNG"><img src="\\\\x\\h.png">';
  const { html, remoteImages } = sanitizeMail(mail);
  assert.equal(remoteImages, 8);
  assert.deepEqual(remoteAttrs(html), []);
  // They stay in the document, without a remote `src` (the base sheet hides those that carry no text).
  const imgs = [...new JSDOM(`<body>${html}</body>`).window.document.querySelectorAll('img')];
  assert.equal(imgs.length, 8);
  assert.deepEqual(
    imgs.map((i) => i.getAttribute('src')),
    [null, null, null, null, TINY, null, null, null],
  );
});

test('https:host without slashes and URLs with leading C0 controls or spaces also count', () => {
  const { html, remoteImages } = sanitizeMail('<img src="https:x/a.png"><img src="\x01https://x/b.png"><img src="\x1f //x/c.png"><img src="http:x">');
  assert.equal(remoteImages, 4);
  assert.deepEqual(remoteAttrs(html), []);
  assert.equal(sanitizeMail('<img src="\x01data:image/png;base64,AAAA"><img src="x/https://y">').remoteImages, 0);
});

test('not counted as remote: data:, cid:, relative paths, other tags or what is removed entirely', () => {
  const images = [{ cid: 'logo@x', mime: 'image/png', data: 'cG5n' }];
  const { remoteImages } = sanitizeMail(
    '<img src="data:image/png;base64,AAAA"><img src="cid:logo@x"><img src="cid:falta@x"><img src="foto.png"><img>' +
      '<video poster="https://x/p"></video><p style="background:url(https://x/bg)">f</p><a href="https://x/l">l</a>' +
      '<template><img src="https://x/t.gif"></template><audio src="https://x/a.mp3"></audio>',
    images,
  );
  assert.equal(remoteImages, 0);
});

test('the count is per message: it does not carry over the previous one', () => {
  assert.equal(sanitizeMail('<img src="https://x/1"><img src="https://x/2">').remoteImages, 2);
  assert.equal(sanitizeMail('<p>nada</p>').remoteImages, 0);
  assert.equal(sanitizeMail('<img src="https://x/3">').remoteImages, 1);
});

test('the paper of a mail with remote images requests nothing from the network (counting them does not let them through)', () => {
  const { html, remoteImages } = sanitizeMail('<img src="https://x/pixel.gif" width=1 height=1><img src="https://x/mapa.png" alt="Mapa">');
  assert.equal(remoteImages, 2);
  const doc = new JSDOM(buildSrcDoc(html)).window.document;
  assert.equal(doc.querySelectorAll('img[src], img[srcset]').length, 0);
  assert.doesNotMatch(doc.body.innerHTML, /https?:/);
});

test('the notice: nothing if there are none, singular and plural with the approved text (§4)', () => {
  assert.equal(remoteImagesNote(0), null);
  assert.equal(remoteImagesNote(-1), null);
  assert.equal(remoteImagesNote(1), '1 imagen remota bloqueada. El remitente no sabe que has abierto este mensaje.');
  assert.equal(remoteImagesNote(2), '2 imágenes remotas bloqueadas. El remitente no sabe que has abierto este mensaje.');
});

// ---------------------------------------------------------------- inline: only those that decode

const PNG = img('ok@x', pngBytes(64, 32));
const BAD = img('rota@x', pngBytes(64, 32, 0xee));

/** Fake decoder: it "decodes" everything except what ends in 0xEE (corrupt). */
const fakeDecode: ImageDecoder = async (bytes) => bytes[bytes.length - 1] !== 0xee;

test('base64 → bytes, anything not base64 gives null', () => {
  assert.deepEqual([...(base64Bytes('iVBORw0K') ?? [])], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  assert.equal(base64Bytes('¡no!'), null);
});

test('imageSize reads the declared size of PNG, GIF, WebP (VP8, VP8L, VP8X) and JPEG (SOF0 and SOF2), without decoding', () => {
  const u8 = (bytes: number[]) => Uint8Array.from(bytes);
  assert.deepEqual(imageSize(u8(pngBytes(640, 480))), { width: 640, height: 480 });
  assert.deepEqual(imageSize(u8(gifBytes(300, 200))), { width: 300, height: 200 });
  assert.deepEqual(imageSize(u8(vp8(1024, 768))), { width: 1024, height: 768 });
  assert.deepEqual(imageSize(u8(vp8l(16384, 3))), { width: 16384, height: 3 });
  assert.deepEqual(imageSize(u8(vp8x(20000, 20000))), { width: 20000, height: 20000 });
  assert.deepEqual(imageSize(u8(jpegBytes(1920, 1080))), { width: 1920, height: 1080 });
  assert.deepEqual(imageSize(u8(jpegBytes(65535, 65535, 0xc2))), { width: 65535, height: 65535 });
});

test('imageSize: truncated, unreadable, other-format or zero header → null', () => {
  const u8 = (bytes: number[]) => Uint8Array.from(bytes);
  for (const bytes of [
    pngBytes(64, 32).slice(0, 20), // truncated IHDR
    [0x89, ...asc('PNG\r\n\x1a\n'), 0, 0, 0, 13, ...asc('IDAT'), ...be32(1), ...be32(1)], // no IHDR
    pngBytes(0, 32),
    gifBytes(10, 10).slice(0, 8),
    gifBytes(10, 0),
    vp8(10, 10).slice(0, 26),
    riff('VP8 ', [0, 0, 0, 0, 0, 0, ...le16(10), ...le16(10)]), // no frame signature
    riff('ALPH', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    jpegBytes(10, 10).slice(0, 30), // cut at the SOF
    [0xff, 0xd8, 0xff, 0xda, 0, 2], // data before the size
    [0xff, 0xd8, 0xff, 0xe0, 0, 1], // impossible length
    [0xff, 0xd8, 0x00, 0x00, 0, 0],
    asc('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    [],
  ]) {
    assert.equal(imageSize(u8(bytes)), null, JSON.stringify(bytes.slice(0, 16)));
  }
});

test('GIF: the size is the largest of the screen and ALL frames', () => {
  const u8 = (bytes: number[]) => Uint8Array.from(bytes);
  assert.deepEqual(imageSize(u8(gifBytes(1, 1, [[0, 0, 100, 100]]))), { width: 100, height: 100 });
  assert.deepEqual(imageSize(u8(gifBytes(1, 1, [[0, 0, 20000, 20000]]))), { width: 20000, height: 20000 });
  // The large one is not the first, and carries a local colour table; the offset counts.
  const late = gifBytes(10, 10, [[0, 0, 10, 10], [0, 0, 10, 10, 0x80], [500, 7, 30000, 3, 0x80]]);
  assert.deepEqual(imageSize(u8(late)), { width: 30500, height: 10 });
  // A normal animation: several frames inside the screen.
  const anim = gifBytes(200, 100, [[0, 0, 200, 100], [10, 10, 50, 50], [150, 50, 50, 50, 0x80]]);
  assert.deepEqual(imageSize(u8(anim)), { width: 200, height: 100 });
});

test('GIF: truncated, no frames, odd blocks or too many frames → null', () => {
  const u8 = (bytes: number[]) => Uint8Array.from(bytes);
  const ok = gifBytes(10, 10, [[0, 0, 10, 10], [0, 0, 10, 10]]);
  for (let cut = 0; cut < ok.length; cut += 1) {
    assert.equal(imageSize(u8(ok.slice(0, cut))), null, `cut at ${cut}`);
  }
  assert.equal(imageSize(u8(gifBytes(10, 10, []))), null); // no descriptor
  assert.equal(imageSize(u8([...ok.slice(0, -1), 0x00, 0x3b])), null); // unknown block
  assert.equal(imageSize(u8([...asc('GIF89a'), 1, 0, 1, 0, 0, 0, 0, 0x2c, 0, 0, 0, 0, 0x20, 0x4e, 0x20, 0x4e])), null); // truncated descriptor
  assert.equal(imageSize(u8([...asc('GIF89a'), 1, 0, 1, 0, 0, 0, 0, 0x21, 0xfe, 200, 1, 2, 0x3b])), null); // truncated sub-block
  const many = Array.from({ length: MAX_GIF_FRAMES + 1 }, (): Frame => [0, 0, 1, 1]);
  assert.equal(imageSize(u8(gifBytes(1, 1, many))), null);
  assert.deepEqual(imageSize(u8(gifBytes(1, 1, many.slice(1)))), { width: 1, height: 1 });
});

test('JPEG: walks the scans (FF 00, RST, padding) up to EOI, more than 100 scans or no EOI → null (R2)', () => {
  const u8 = (bytes: number[]) => Uint8Array.from(bytes);
  assert.deepEqual(imageSize(u8(jpegBytes(800, 600, 0xc2, 10))), { width: 800, height: 600 }); // normal progressive
  assert.deepEqual(imageSize(u8(jpegBytes(800, 600, 0xc2, MAX_JPEG_SCANS))), { width: 800, height: 600 });
  assert.equal(imageSize(u8(jpegBytes(800, 600, 0xc2, MAX_JPEG_SCANS + 1))), null);
  assert.equal(imageSize(u8(jpegBytes(800, 600, 0xc2, 5000))), null);
  assert.equal(imageSize(u8(jpegBytes(800, 600).slice(0, -2))), null); // no EOI
  assert.equal(imageSize(u8([...jpegBytes(800, 600).slice(0, -2), 0x12, 0xff, 0xd9])), null); // after the scan, "FF 12" with an impossible length
});

// Samples measured in WebKitGTK: `imageSize` read 1x1 and WebKit decodes a 12000x12000 frame.
const GIF_HEAD = '47 49 46 38 39 61 | 01 00 01 00 00 00 00';
const GIF_TAIL = '02 4C 01 00 | 2C 00 00 00 00 01 00 01 00 00 02 02 4C 01 00 | 3B';
const NETSCAPE = '21 FF 0B 4E 45 54 53 43 41 50 45 32 2E 30';
const DESYNC = {
  gifShortControl: hex(`${GIF_HEAD} | 21 F9 00 | 21 FE 0D 00 00 2C 00 00 00 00 E0 2E E0 2E 00 02 | ${GIF_TAIL}`),
  gifShortNetscape: hex(`${GIF_HEAD} | ${NETSCAPE} | 01 01 | 0D 00 00 2C 00 00 00 00 E0 2E E0 2E 00 02 | ${GIF_TAIL}`),
  jpegFf00: hex(
    'FF D8 | FF 00 00 19 | FF C0 00 11 08 2E E0 2E E0 03 01 22 00 02 11 01 03 11 01 | FF EC 00 15 |' +
      'FF C0 00 11 08 00 01 00 01 03 01 22 00 02 11 01 03 11 01 | FF DA 00 0C 03 01 00 02 11 03 11 00 3F 00 | 12 34 | FF D9',
  ),
};

test('GIF and JPEG are read like WebKit: anything hiding a large frame → null', async () => {
  const u8 = (bytes: number[]) => Uint8Array.from(bytes);
  for (const [name, bytes] of Object.entries(DESYNC)) assert.equal(imageSize(u8(bytes)), null, name);
  // A marker with no length that libjpeg does not accept ("FF 02") does not either.
  const ff02 = 'FF D8 | FF 02 00 02 | FF C0 00 11 08 00 01 00 01 03 01 22 00 02 11 01 03 11 01 | FF DA 00 0C 03 01 00 02 11 03 11 00 3F 00 | 12 34 | FF D9';
  assert.equal(imageSize(u8(hex(ff02))), null);
  // The normal ones still give a size: graphic control of 4, NETSCAPE with a 3-byte sub-block and XMP with sub-blocks of 1 and 2.
  const tail = '2C 00 00 00 00 01 00 01 00 00 02 02 4C 01 00 | 3B';
  for (const ok of [
    `${GIF_HEAD} | 21 F9 04 00 00 00 00 00 | ${tail}`,
    `${GIF_HEAD} | ${NETSCAPE} 03 01 00 00 00 | ${tail}`,
    `${GIF_HEAD} | 21 FF 0B 58 4D 50 20 44 61 74 61 58 4D 50 01 41 02 41 42 00 | ${tail}`,
  ]) {
    assert.deepEqual(imageSize(u8(hex(ok))), { width: 1, height: 1 }, ok);
  }
  // And they do not reach the decoder.
  let calls = 0;
  const spy: ImageDecoder = async () => (calls += 1) > 0;
  const mimes = ['image/gif', 'image/gif', 'image/jpeg'];
  const bombs = Object.values(DESYNC).map((bytes, i) => img(`d${i}`, bytes, mimes[i]));
  assert.deepEqual(await decodableImages(bombs, spy), []);
  assert.equal(calls, 0);
});

test('size caps: 16 Mpx per image and 32 Mpx per message', () => {
  assert.equal(MAX_PIXELS, 16_000_000);
  assert.equal(MAX_TOTAL_PIXELS, 32_000_000);
});

test('imageType: the type from the byte signature, not from what the mail says', () => {
  const u8 = (bytes: number[]) => Uint8Array.from(bytes);
  assert.equal(imageType(u8(pngBytes(1, 1))), 'image/png');
  assert.equal(imageType(u8(gifBytes(1, 1))), 'image/gif');
  assert.equal(imageType(u8(vp8(1, 1))), 'image/webp');
  assert.equal(imageType(u8(jpegBytes(1, 1))), 'image/jpeg');
  assert.equal(imageType(u8(asc('<svg/>'))), null);
});

test('structural bombs: a GIF with a large frame and a JPEG with thousands of scans do not reach the decoder, normal ones do', async () => {
  const seen: string[] = [];
  const spy: ImageDecoder = async (bytes, mime) => {
    seen.push(mime);
    return fakeDecode(bytes, mime);
  };
  const bombs = [
    img('a', gifBytes(1, 1, [[0, 0, 20000, 20000]]), 'image/gif'),
    img('b', gifBytes(1, 1, [[0, 0, 1, 1], [0, 0, 12000, 12000]]), 'image/gif'),
    img('c', gifBytes(1, 1, [[0, 0, 1, 1]]).slice(0, -3), 'image/gif'),
    img('d', gifBytes(1, 1, []), 'image/gif'),
    img('e', jpegBytes(100, 100, 0xc2, MAX_JPEG_SCANS + 1), 'image/jpeg'),
  ];
  assert.deepEqual(await decodableImages(bombs, spy), []);
  assert.deepEqual(seen, []);
  const normal = [
    img('f', gifBytes(200, 100, [[0, 0, 200, 100], [10, 10, 50, 50], [150, 50, 50, 50, 0x80]]), 'image/gif'),
    img('g', jpegBytes(1024, 768, 0xc2, 10), 'image/jpeg'),
  ];
  assert.deepEqual(await decodableImages(normal, spy), normal);
  assert.deepEqual(seen, ['image/gif', 'image/jpeg']);
});

test('only those that decode remain, in their order, the decoder gets the bytes and the type', async () => {
  const seen: string[] = [];
  const decode: ImageDecoder = async (bytes, mime) => {
    seen.push(`${mime}:${bytes.length}`);
    return fakeDecode(bytes, mime);
  };
  const second = img('ok2@x', gifBytes(10, 10), 'image/gif');
  assert.deepEqual(await decodableImages([PNG, BAD, second], decode), [PNG, second]);
  assert.deepEqual(seen, ['image/png:30', 'image/png:30', 'image/gif:62']);
});

test('decompression bomb: with absurd dimensions or an unreadable header decoding is never reached', async () => {
  const seen: string[] = [];
  const spy: ImageDecoder = async (bytes, mime) => {
    seen.push(mime);
    return fakeDecode(bytes, mime);
  };
  const bombs = [
    img('a', pngBytes(20000, 20000)),
    img('b', pngBytes(MAX_SIDE + 1, 1)),
    img('c', pngBytes(1, MAX_SIDE + 1)),
    img('d', pngBytes(MAX_SIDE, MAX_SIDE)), // 67 Mpx: each side fits, the total does not
    img('e', gifBytes(65535, 65535), 'image/gif'),
    img('f', vp8x(16384, 16384), 'image/webp'),
    img('g', jpegBytes(30000, 30000), 'image/jpeg'),
    img('h', pngBytes(64, 32).slice(0, 20)),
    img('i', [1, 2, 3, 4]),
  ];
  assert.deepEqual(await decodableImages(bombs, spy), []);
  assert.deepEqual(seen, []);
  // At the limit it passes (8192 x 1953, about 15.99 Mpx).
  const edge = img('j', pngBytes(MAX_SIDE, 1953));
  assert.deepEqual(await decodableImages([edge], spy), [edge]);
  assert.ok(MAX_SIDE * 1953 <= MAX_PIXELS);
});

test('each format with a normal size reaches the decoder', async () => {
  const all = [
    img('p', pngBytes(10, 10)),
    img('g', gifBytes(10, 10), 'image/gif'),
    img('w1', vp8(10, 10), 'image/webp'),
    img('w2', vp8l(10, 10), 'image/webp'),
    img('w3', vp8x(10, 10), 'image/webp'),
    img('j', jpegBytes(10, 10), 'image/jpeg'),
  ];
  assert.deepEqual(await decodableImages(all, fakeDecode), all);
});

test(`in series and capped: at most ${MAX_IMAGES} decodes and ${MAX_TOTAL_PIXELS} pixels per message`, async () => {
  let running = 0;
  let most = 0;
  let calls = 0;
  const slow: ImageDecoder = async () => {
    calls += 1;
    running += 1;
    most = Math.max(most, running);
    await new Promise((r) => setTimeout(r, 1));
    running -= 1;
    return true;
  };
  const many = Array.from({ length: MAX_IMAGES + 5 }, (_, i) => img(`n${i}`, pngBytes(10, 10)));
  assert.deepEqual(await decodableImages(many, slow), many.slice(0, MAX_IMAGES));
  assert.equal(calls, MAX_IMAGES);
  assert.equal(most, 1);
  // Pixel budget: three of 16 Mpx do not fit in 32; the small one behind them does.
  calls = 0;
  const big = (id: string) => img(id, pngBytes(MAX_SIDE, 1953));
  const mixed = [big('b1'), big('b2'), big('b3'), img('s', pngBytes(10, 10))];
  assert.deepEqual(await decodableImages(mixed, slow), [mixed[0], mixed[1], mixed[3]]);
  assert.equal(calls, 3);
});

test('only those cited by the HTML are checked', () => {
  const other = img('otra@x', pngBytes(1, 1));
  assert.deepEqual(citedImages('<img src="cid:ok@x">', [PNG, other]), [PNG]);
  assert.deepEqual(citedImages('<p>sin imágenes</p>', [PNG]), []);
  assert.deepEqual(citedImages('<img src="cid:">', [{ ...PNG, cid: '' }]), []);
});

test('also removed if the decoder throws, rejects, returns something other than true, takes too long or the base64 is bad', async () => {
  const throws: ImageDecoder = () => {
    throw new Error('x');
  };
  const rejects: ImageDecoder = () => Promise.reject(new Error('x'));
  const truthy = (async () => 1) as unknown as ImageDecoder;
  const never: ImageDecoder = () => new Promise(() => {});
  for (const decode of [throws, rejects, truthy]) assert.deepEqual(await decodableImages([PNG], decode), []);
  assert.deepEqual(await decodableImages([PNG], never, 20), []);
  assert.deepEqual(await decodableImages([{ ...PNG, data: '%%%' }], fakeDecode), []);
  assert.deepEqual(await decodableImages([], fakeDecode), []);
});

test('an image that does not decode is painted as not delivered: no src and the fixed text, in its box', async () => {
  const ok = await decodableImages([PNG, BAD], fakeDecode);
  const { html } = sanitizeMail('<img src="cid:ok@x" alt="Logo"><img src="cid:rota@x">', ok);
  const win = new JSDOM(buildSrcDoc(html)).window;
  const imgs = [...win.document.querySelectorAll('img')];
  assert.deepEqual(
    imgs.map((i) => [i.getAttribute('src'), i.getAttribute('alt')]),
    [
      [`data:image/png;base64,${PNG.data}`, 'Logo'],
      [null, 'imagen no disponible'],
    ],
  );
  assert.equal(win.getComputedStyle(imgs[1] as Element).display, 'inline-block');
});

test('decodeInBrowser: uses createImageBitmap with the bytes and their type and releases it, if it fails the image is removed', async () => {
  const g = globalThis as { createImageBitmap?: unknown };
  const saved = g.createImageBitmap;
  try {
    let closed = 0;
    let got: Blob | null = null;
    g.createImageBitmap = async (blob: Blob) => {
      got = blob;
      return { close: () => (closed += 1) };
    };
    assert.deepEqual(await decodableImages([PNG], decodeInBrowser), [PNG]);
    assert.equal(closed, 1);
    assert.equal((got as Blob | null)?.type, 'image/png');
    assert.equal((got as Blob | null)?.size, 30);
    g.createImageBitmap = () => Promise.reject(new DOMException('rota', 'InvalidStateError'));
    assert.deepEqual(await decodableImages([PNG], decodeInBrowser), []);
    // Without `createImageBitmap` nothing can be checked: it is let through, as before.
    delete g.createImageBitmap;
    assert.deepEqual(await decodableImages([PNG], decodeInBrowser), [PNG]);
  } finally {
    if (saved === undefined) delete g.createImageBitmap;
    else g.createImageBitmap = saved;
  }
});

// ---------------------------------------------------------------- guards in the sources

function sources(dir = new URL('../src/', import.meta.url), prefix = ''): [name: string, text: string][] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return entry.name === 'bindings' ? [] : sources(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`);
    return /\.tsx?$/.test(entry.name) ? [[prefix + entry.name, readFileSync(new URL(entry.name, dir), 'utf8')] as [string, string]] : [];
  });
}

test("the reader sanitizes with the already checked images, never with the core's as is", () => {
  const reader = sources().find(([name]) => name === 'screens/Reader.tsx')?.[1] ?? '';
  assert.match(reader, /const images = useDecodableImages\(detail\?\.html \?\? null, detail\?\.inlineImages \?\? null\);/);
  assert.match(reader, /useHtmlView\(html, images \?\? NO_IMAGES\)/);
  assert.match(reader, /sanitizeHtml\(html, images\)/);
  // `inlineImages` only appears in the call to the check.
  assert.equal(reader.match(/inlineImages/g)?.length, 1);
  // Without HTML nothing is checked; with HTML, only the cited ones.
  assert.match(reader, /html == null \? NO_IMAGES : citedImages\(html, inline\)/);
  assert.match(reader, /decodableImages\(wanted, decodeInBrowser\)/);
});

test('checking the images does not put them in the app DOM nor create URLs the mail can reach', () => {
  const offenders = sources()
    .filter(([, text]) => /new Image\(|createObjectURL|\.decode\(\)|new OffscreenCanvas|getContext\(/.test(text))
    .map(([name]) => name);
  assert.deepEqual(offenders, []);
  const images = sources().find(([name]) => name === 'images.ts')?.[1] ?? '';
  assert.doesNotMatch(images, /document\.|createElement|innerHTML|\.src\s*=/);
});

test('there is no way to load remote images from the reader: no button nor anything that changes the CSP', () => {
  const reader = sources().find(([name]) => name === 'screens/Reader.tsx')?.[1] ?? '';
  const note = reader.match(/function RemoteImagesNote[\s\S]*?\n}\n/)?.[0] ?? '';
  assert.ok(note.length > 0, 'RemoteImagesNote not found');
  assert.doesNotMatch(note, /onClick|<button|setState|useState/);
  assert.doesNotMatch(reader, /READER_CSP|buildSrcDoc\(/);
});
