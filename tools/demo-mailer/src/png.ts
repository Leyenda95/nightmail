// Minimal PNG encoder for the images in the test emails.
import { crc32, deflateSync } from "node:zlib";

export interface PngFormat {
  /** Bits per sample: 1 (1-bit grayscale) or 8. */
  bitDepth: 1 | 8;
  /** 0 = grayscale, 2 = RGB. */
  colorType: 0 | 2;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const body = Buffer.concat([head.subarray(4), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head.subarray(0, 4), body, crc]);
}

/** `width` × `height` PNG whose rows (each prefixed with its filter byte) are `raw`. */
export function encodePng(width: number, height: number, format: PngFormat, raw: Uint8Array): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([format.bitDepth, format.colorType, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array()),
  ]);
}

/** Single-color RGB PNG: compresses very well even when large. */
export function solidPng(width: number, height: number, rgb: readonly [number, number, number]): Uint8Array {
  const row = Buffer.alloc(1 + width * 3).fill(Buffer.from(rgb), 1); // filter byte 0, then the color repeated
  return encodePng(width, height, { bitDepth: 8, colorType: 2 }, Buffer.concat(Array<Buffer>(height).fill(row)));
}

/**
 * Decompression bomb: black `side` × `side` 1-bit grayscale PNG. A few KB on disk, but decoded to RGBA it would take
 * `side² × 4` bytes (16384 -> 1 GiB).
 */
export function bombPng(side: number): Uint8Array {
  return encodePng(side, side, { bitDepth: 1, colorType: 0 }, Buffer.alloc(side * (1 + Math.ceil(side / 8))));
}
