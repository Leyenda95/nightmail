// Bucketed mail padding, so the stored size does not reveal the exact size.
//
//   padded = length (u32 big-endian) ‖ message ‖ zeros up to the bucket
//
// Padding goes inside the authenticated encryption, so the real length is encrypted and
// authenticated. Buckets are powers of 2 from 4 KiB to 32 MiB. Writers pad with zeros; readers
// ignore the padding content and do not require the total to be a bucket from the table, so the
// table can change without bumping the envelope version.
import { readUint32BE, uintBE } from './bytes.ts';

export const LENGTH_PREFIX_BYTES = 4;
export const MIN_BUCKET = 4096;
export const MAX_BUCKET = 33_554_432;

/** Largest message that fits in the last bucket. */
export const MAX_PLAINTEXT_LENGTH = MAX_BUCKET - LENGTH_PREFIX_BYTES;

function buildBuckets(): number[] {
  const buckets: number[] = [];
  for (let bucket = MIN_BUCKET; bucket <= MAX_BUCKET; bucket *= 2) buckets.push(bucket);
  return buckets;
}

export const BUCKETS: readonly number[] = Object.freeze(buildBuckets());

/** Padded size (and ciphertext size) for a message of `plaintextLength` bytes. */
export function bucketFor(plaintextLength: number): number {
  if (!Number.isSafeInteger(plaintextLength) || plaintextLength < 0 || plaintextLength > MAX_PLAINTEXT_LENGTH) {
    throw new RangeError('message length out of range');
  }
  let bucket = MIN_BUCKET;
  while (bucket < plaintextLength + LENGTH_PREFIX_BYTES) bucket *= 2;
  return bucket;
}

export function pad(plaintext: Uint8Array): Uint8Array {
  const padded = new Uint8Array(bucketFor(plaintext.length));
  padded.set(uintBE(plaintext.length, LENGTH_PREFIX_BYTES));
  padded.set(plaintext, LENGTH_PREFIX_BYTES);
  return padded;
}

/** Returns the message (a view into `padded`), or `null` if the padding is malformed. */
export function unpad(padded: Uint8Array): Uint8Array | null {
  if (padded.length < LENGTH_PREFIX_BYTES) return null;
  const length = readUint32BE(padded);
  if (length > padded.length - LENGTH_PREFIX_BYTES) return null;
  return padded.subarray(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + length);
}
