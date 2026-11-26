// Byte helpers: lowercase hex without `0x` (the repo convention) and big-endian integers.
// Errors never echo the input value, since it may be a secret.

const HEX = /^(?:[0-9a-f]{2})*$/;

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex');
}

/** Accepts only pairs of lowercase hex digits (`Buffer.from` silently truncates at anything it cannot parse). */
export function fromHex(hex: string): Uint8Array {
  if (!HEX.test(hex)) throw new TypeError('invalid hex');
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Unsigned big-endian integer of `byteLength` bytes. */
export function uintBE(value: number, byteLength: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** (8 * byteLength)) {
    throw new RangeError('integer out of range');
  }
  const out = new Uint8Array(byteLength);
  let rest = BigInt(value);
  for (let i = byteLength - 1; i >= 0; i--) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

/** Reads a big-endian u32 from the first four bytes. */
export function readUint32BE(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
}

/**
 * Runs `use` and zeroes `secret` afterwards, even if `use` throws. In JavaScript this is best
 * effort (the GC may have left copies), but it keeps the key from lingering in plain sight.
 */
export function withWiped<T>(secret: Uint8Array, use: () => T): T {
  try {
    return use();
  } finally {
    secret.fill(0);
  }
}

/** Constant time with respect to the content: does not return at the first non-zero byte. */
export function isAllZero(bytes: Uint8Array): boolean {
  let acc = 0;
  for (const byte of bytes) acc |= byte;
  return acc === 0;
}
