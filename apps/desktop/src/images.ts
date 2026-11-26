// Mail images: which inline images can really be painted, and the notice for blocked remote ones. The pure part
// receives the decoder so it can be tested with `node --test`.
import { t } from './i18n/index.ts';
import type { InlineImage } from './srcdoc.ts';

/** Can these bytes be decoded as an image? A rejected promise counts as "no". */
export type ImageDecoder = (bytes: Uint8Array<ArrayBuffer>, mime: string) => Promise<boolean>;

/**
 * Wait limit per image: one that never finishes does not keep the message from opening; it is treated as not
 * delivered. This only stops WAITING, it does not cut decoding (in WebKitGTK `createImageBitmap` decodes on the main
 * thread and runs to the end). What really protects against the cost are the size limits below, applied before decoding.
 */
export const DECODE_TIMEOUT_MS = 3000;

/**
 * Limits before decoding (a 32 KB PNG declaring 16384 x 16384 froze the app for almost 1 s and grew memory by 1.3 GB).
 * Per side and per image; and per message, a maximum number of distinct images (the core delivers at most 20) and a
 * total pixel budget (two images at the cap). Anything over any of them shows "imagen no disponible".
 * What fits costs about 10 bytes of memory per declared pixel: 16 and 32 Mpx keep the peak at about 350 MB; a 12 Mpx
 * phone photo still fits.
 */
export const MAX_SIDE = 8192;
export const MAX_PIXELS = 16_000_000;
export const MAX_IMAGES = 20;
export const MAX_TOTAL_PIXELS = 32_000_000;

/**
 * Limits on structure. A GIF with a 1x1 screen and a 12000x12000 frame is decoded by WebKit at 12000x12000 (it grows
 * the canvas to the frame), so its size is taken from ALL frames and the walk is bounded. A progressive JPEG with
 * thousands of scans walks every block in each one (a CPU bomb): at most 100.
 */
export const MAX_GIF_FRAMES = 2000;
export const MAX_GIF_BLOCKS = 8000;
export const MAX_JPEG_SCANS = 100;

export interface ImageSize {
  width: number;
  height: number;
}

/** Base64 to bytes, or `null` if it is not valid base64. */
export function base64Bytes(data: string): Uint8Array<ArrayBuffer> | null {
  try {
    return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Bytes to base64 (in chunks: `String.fromCharCode` does not accept millions of arguments). */
export function bytesBase64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

const u16be = (b: Uint8Array, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const u16le = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, i: number) => u16le(b, i) | ((b[i + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, i: number) => u16be(b, i) * 0x10000 + u16be(b, i + 2);
const ascii = (b: Uint8Array, i: number, text: string) => [...text].every((c, k) => b[i + k] === c.charCodeAt(0));

function pngSize(b: Uint8Array): ImageSize | null {
  if (b.length < 24 || !ascii(b, 12, 'IHDR')) return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

/** Bytes of the colour table announced by a GIF flags byte (screen or frame); 0 if none. */
const gifColorTable = (flags: number) => (flags & 0x80 ? 3 << ((flags & 7) + 1) : 0);

/**
 * Skips a chain of GIF sub-blocks (length + data, up to a 0): the index after it, or -1 if it is cut off or if a
 * sub-block is shorter than `min` (WebKit reads at least that many bytes: reading it differently would hide a frame).
 */
function skipGifSubBlocks(b: Uint8Array, start: number, min = 1): number {
  let i = start;
  while (i < b.length) {
    const length = b[i] ?? 0;
    if (length === 0) return i + 1;
    if (length < min) return -1;
    i += 1 + length;
  }
  return -1;
}

/**
 * Logical screen and ALL frames (left + width, top + height): the largest of each side. Walks the blocks to the end
 * (0x3B); truncated, odd, with no frame at all or with too many blocks or frames: unreadable.
 */
function gifSize(b: Uint8Array): ImageSize | null {
  if (b.length < 13) return null;
  let width = u16le(b, 6);
  let height = u16le(b, 8);
  let frames = 0;
  let i = 13 + gifColorTable(b[10] ?? 0);
  for (let blocks = 0; blocks < MAX_GIF_BLOCKS && i >= 0; blocks += 1) {
    const kind = b[i];
    if (kind === 0x3b) return frames > 0 ? { width, height } : null;
    if (kind === 0x21) {
      // Like WebKit: a graphic control block (F9) always reads 4 bytes; NETSCAPE/ANIMEXTS, 3 per sub-block.
      const label = b[i + 1];
      const first = b[i + 2] ?? 0;
      if (label === 0xf9 && first < 4) return null;
      const netscape = label === 0xff && first === 11 && (ascii(b, i + 3, 'NETSCAPE2.0') || ascii(b, i + 3, 'ANIMEXTS1.0'));
      i = skipGifSubBlocks(b, i + 2, netscape ? 3 : 1); // introducer, label, sub-blocks
    } else if (kind === 0x2c) {
      frames += 1;
      if (frames > MAX_GIF_FRAMES || i + 10 > b.length) return null;
      width = Math.max(width, u16le(b, i + 1) + u16le(b, i + 5));
      height = Math.max(height, u16le(b, i + 3) + u16le(b, i + 7));
      i = skipGifSubBlocks(b, i + 10 + gifColorTable(b[i + 9] ?? 0) + 1); // descriptor, local table, LZW size, data
    } else {
      return null;
    }
  }
  return null;
}

function webpSize(b: Uint8Array): ImageSize | null {
  if (ascii(b, 12, 'VP8 ') && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (ascii(b, 12, 'VP8L') && b.length >= 25 && b[20] === 0x2f) {
    const bits = ((b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (ascii(b, 12, 'VP8X') && b.length >= 30) return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  return null;
}

/** SOF0-SOF15 except DHT (C4), JPG (C8) and DAC (CC): those that carry the frame size. */
const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

const isRst = (m: number) => m >= 0xd0 && m <= 0xd7;

/** Markers with a length that libjpeg accepts (SOFn/DHT/DAC, SOS-DRI-DHP, APPn, COM); any other: unreadable. */
const hasLength = (m: number) => (m >= 0xc0 && m <= 0xcf) || (m >= 0xda && m <= 0xdd) || (m >= 0xe0 && m <= 0xef) || m === 0xfe;

/**
 * Skips a scan's data up to the next marker: inside it, `FF 00` is a data FF, `FF FF` is padding and
 * RSTn stay inside the scan. Index of its FF, or the end if there are no more.
 */
function skipJpegScan(b: Uint8Array, start: number): number {
  let i = b.indexOf(0xff, start);
  while (i >= 0 && i + 1 < b.length) {
    const next = b[i + 1] ?? 0;
    if (next !== 0x00 && next !== 0xff && !isRst(next)) return i;
    i = b.indexOf(0xff, next === 0xff ? i + 1 : i + 2);
  }
  return b.length;
}

/**
 * Walks the markers (and each scan's data) to EOI and returns the size of the first SOFn. Anything odd,
 * a scan before the size, more than {@link MAX_JPEG_SCANS} scans or ending without EOI: unreadable.
 */
function jpegSize(b: Uint8Array): ImageSize | null {
  let size: ImageSize | null = null;
  let scans = 0;
  let i = 2;
  while (i + 1 < b.length) {
    const marker = b[i + 1] ?? 0;
    if (b[i] !== 0xff) return null;
    if (marker === 0xd9) return size;
    if (marker === 0xff) {
      i += 1; // padding
      continue;
    }
    if (marker === 0x01 || isRst(marker)) {
      i += 2; // no length
      continue;
    }
    if (!hasLength(marker)) return null;
    const length = u16be(b, i + 2);
    if (i + 3 >= b.length || length < 2) return null;
    if (isSof(marker) && size === null) {
      if (i + 8 >= b.length) return null;
      size = { width: u16be(b, i + 7), height: u16be(b, i + 5) };
    }
    i += 2 + length;
    if (marker === 0xda) {
      scans += 1;
      if (size === null || scans > MAX_JPEG_SCANS) return null;
      i = skipJpegScan(b, i);
    }
  }
  return null;
}

/** Size reader for each type that is painted (the same ones the core delivers). */
const SIZE_READERS = { 'image/png': pngSize, 'image/gif': gifSize, 'image/webp': webpSize, 'image/jpeg': jpegSize };

export type ImageType = keyof typeof SIZE_READERS;

/** The type by the bytes' SIGNATURE (not by what the mail says); `null` if not PNG, GIF, WebP or JPEG. */
export function imageType(b: Uint8Array): ImageType | null {
  if (b[0] === 0x89 && ascii(b, 1, 'PNG\r\n\x1a\n')) return 'image/png';
  if (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a')) return 'image/gif';
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return 'image/webp';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  return null;
}

/**
 * Width and height DECLARED by the header (PNG, GIF, WebP, JPEG; format by signature, not by `mime`), without
 * decoding anything; for GIF, the largest of the screen and all frames. `null` if it is none of the four, if it is
 * truncated, if its structure cannot be walked or if it declares 0.
 */
export function imageSize(b: Uint8Array): ImageSize | null {
  const type = imageType(b);
  const size = type === null ? null : SIZE_READERS[type](b);
  return size !== null && size.width > 0 && size.height > 0 ? size : null;
}

/** Does it fit within the per-image limits? */
export function withinLimits({ width, height }: ImageSize): boolean {
  return width <= MAX_SIDE && height <= MAX_SIDE && width * height <= MAX_PIXELS;
}

/** `true` only if the decoder says yes before the wait limit; any failure, rejection or overlong wait: `false`. */
async function decodesInTime(bytes: Uint8Array<ArrayBuffer>, mime: string, decode: ImageDecoder, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return (await Promise.race([decode(bytes, mime), late])) === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The images the HTML cites (its `cid` appears verbatim); the rest are not painted, so they are not even checked. A
 * `cid` written with entities in the HTML is not recognised: that image shows "no disponible" (it fails towards not decoding).
 */
export function citedImages<T extends InlineImage>(html: string, images: readonly T[]): T[] {
  return images.filter((image) => image.cid !== '' && html.includes(image.cid));
}

/** Does this image fit in the message's budget? If it does, it is already deducted. */
export type ImageBudget = (bytes: Uint8Array) => boolean;

/**
 * Budget for ONE message: an image fits if its header can be read, it is within the per-image limits and there is
 * still room under {@link MAX_IMAGES} images and {@link MAX_TOTAL_PIXELS} pixels; one that does not fit deducts
 * nothing (a small one after it can still fit).
 */
export function createImageBudget(): ImageBudget {
  let images = 0;
  let pixels = 0;
  return (bytes) => {
    const size = imageSize(bytes);
    if (size === null || !withinLimits(size) || images >= MAX_IMAGES) return false;
    const area = size.width * size.height;
    if (pixels + area > MAX_TOTAL_PIXELS) return false;
    images += 1;
    pixels += area;
    return true;
  };
}

/**
 * The inline images that can be decoded, in the same order. One by one (serially: never several decodings at once)
 * and only if they fit in the message's budget ([`createImageBudget`]); the rest (corrupt, truncated, huge, surplus)
 * are removed from the list and the sanitiser treats them as not delivered ("imagen no disponible").
 */
export async function decodableImages<T extends InlineImage>(
  images: readonly T[],
  decode: ImageDecoder,
  timeoutMs = DECODE_TIMEOUT_MS,
): Promise<T[]> {
  const ok: T[] = [];
  const fits = createImageBudget();
  for (const image of images) {
    const bytes = base64Bytes(image.data);
    if (bytes === null || !fits(bytes)) continue;
    if (await decodesInTime(bytes, image.mime, decode, timeoutMs)) ok.push(image);
  }
  return ok;
}

/**
 * The app's decoder: `createImageBitmap` on the bytes, outside the iframe and without touching the DOM (no `<img>` or
 * object URL: nothing the mail can reach). If the engine lacks it, nothing can be checked and the image is let
 * through (the size limits have been applied regardless).
 */
export const decodeInBrowser: ImageDecoder = async (bytes, mime) => {
  if (typeof createImageBitmap !== 'function') return true;
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
  bitmap.close();
  return true;
};

/** Reader notice if the mail carried remote images; `null` if it carried none. */
export function remoteImagesNote(count: number): string | null {
  if (count <= 0) return null;
  return t().format.remoteImages(count);
}
