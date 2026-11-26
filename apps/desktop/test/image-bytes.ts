// Minimal headers of each format for the tests (only what `imageSize` reads), shared by images, sanitize and
// srcdoc; `tail` marks the image as "corrupt" for the fake decoder.
export const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
export const le16 = (n: number) => [n & 255, (n >>> 8) & 255];
export const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
export const asc = (s: string) => [...s].map((c) => c.charCodeAt(0));
export const pngBytes = (w: number, h: number, tail = 0) => [0x89, ...asc('PNG\r\n\x1a\n'), 0, 0, 0, 13, ...asc('IHDR'), ...be32(w), ...be32(h), 8, 6, 0, 0, 0, tail];
/** A GIF frame: graphic control, descriptor (with `flags` 0x80 it carries a 2-colour local table) and minimal data. */
const gifFrame = (left: number, top: number, w: number, h: number, flags = 0) => [
  0x21, 0xf9, 4, 0, 0, 0, 0, 0,
  0x2c, ...le16(left), ...le16(top), ...le16(w), ...le16(h), flags, ...(flags & 0x80 ? [0, 0, 0, 255, 255, 255] : []),
  2, 2, 0x4c, 0x01, 0,
];
export type Frame = [left: number, top: number, w: number, h: number, flags?: number];
/** GIF with screen `w` x `h` (and a 2-colour global table) and its frames; by default, one that fills it. */
export const gifBytes = (w: number, h: number, frames: Frame[] = [[0, 0, w, h]]) => [
  ...asc('GIF89a'), ...le16(w), ...le16(h), 0x80, 0, 0, 0, 0, 0, 255, 255, 255,
  0x21, 0xff, 11, ...asc('NETSCAPE2.0'), 3, 1, 0, 0, 0, // application extension (loop)
  ...frames.flatMap(([l, t, fw, fh, flags]) => gifFrame(l, t, fw, fh, flags)),
  0x3b,
];
export const riff = (chunk: string, body: number[]) => [...asc('RIFF'), 0, 0, 0, 0, ...asc('WEBP'), ...asc(chunk), 0, 0, 0, 0, ...body];
export const vp8 = (w: number, h: number) => riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h)]);
export const vp8l = (w: number, h: number) => {
  const bits = ((w - 1) | ((h - 1) << 14)) >>> 0;
  return riff('VP8L', [0x2f, bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255]);
};
export const vp8x = (w: number, h: number) => riff('VP8X', [0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]);
/** A scan: SOS and data with a data FF (`FF 00`), an RST and padding (`FF FF`) before the next marker. */
export const jpegScan = [0xff, 0xda, 0, 12, 3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0, 0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xff];
export const jpegBytes = (w: number, h: number, sof = 0xc0, scans = 1) => [
  0xff, 0xd8, 0xff, 0xe0, 0, 16, ...asc('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0,
  0xff, 0xff, // padding
  0xff, 0xdb, 0, 4, 0, 0, // short DQT
  0xff, sof, 0, 17, 8, ...le16(h).reverse(), ...le16(w).reverse(), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
  ...Array.from({ length: scans }, () => [0xff, 0xc4, 0, 2, ...jpegScan]).flat(), // short DHT + scan
  0xff, 0xd9,
];
export const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64');
export const img = (cid: string, bytes: number[], mime = 'image/png') => ({ cid, mime, data: b64(bytes) });
/** `<img src>` directly with those bytes. */
export const dataUrl = (bytes: number[], mime = 'image/png') => `data:${mime};base64,${b64(bytes)}`;
/** Bytes written in hexadecimal (`|` and spaces separate). */
export const hex = (s: string) => s.replace(/[|\s]+/g, ' ').trim().split(' ').map((x) => parseInt(x, 16));
