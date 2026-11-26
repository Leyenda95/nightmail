// Input encoding and validation. Bytes are lowercase hex without `0x` (as in the sidecar protocol).
// Nothing is silently corrected; invalid input is rejected.

/** Malformed input. The message is fixed and never echoes the value, which may be a secret. */
export class InvalidInput extends Error {}

const HEX = /^(?:[0-9a-f]{2})*$/;

export const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/**
 * Lowercase hex of exactly `length` bytes. Decodes straight into a dedicated Uint8Array: for small sizes
 * `Buffer.from(hex)` would use Node's shared pool, leaving a copy of the value (possibly a secret) there
 * even after the caller wipes its own.
 */
export function fromHex(hex: unknown, length: number, what: string): Uint8Array {
  if (typeof hex !== 'string' || hex.length !== length * 2 || !HEX.test(hex)) {
    throw new InvalidInput(`${what}: expected ${length} bytes as lowercase hex`);
  }
  const bytes = new Uint8Array(length);
  Buffer.from(bytes.buffer, bytes.byteOffset, length).write(hex, 'hex');
  return bytes;
}

/** Unsigned `bits`-bit integer (the contract's Uint<bits>). */
export function uint(value: unknown, bits: number, what: string): bigint {
  const ok = (typeof value === 'number' && Number.isSafeInteger(value)) || typeof value === 'bigint';
  if (!ok || BigInt(value) < 0n || BigInt(value) >= 1n << BigInt(bits)) {
    throw new InvalidInput(`${what}: expected an unsigned ${bits}-bit integer`);
  }
  return BigInt(value);
}
