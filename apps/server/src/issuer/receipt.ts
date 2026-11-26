// Signed Issuer receipt: Ed25519 over (registry contract, id, plan, period, insert-by deadline). If the
// operator charges and never inserts, the user proves it with this receipt (anyone who knows the id can check
// inclusion). The contract is signed so a receipt can't be replayed against another registry (other network or
// deployment). Uses node:crypto because core-ts doesn't expose raw signing.
// Test vector for other implementations (the Rust core): packages/test-vectors/issuer/receipt-v2.json.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import type { IssuePlan } from './payer-client.ts';

/** Fixed DER prefixes for a 32-byte Ed25519 key (PKCS8 private, SPKI public). */
export const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
export const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export type ReceiptPeriod = 'none' | 'monthly' | 'annual';

export type ReceiptFields = { contract: string; id: string; plan: IssuePlan; period: ReceiptPeriod; insertBy: bigint };

const DOMAIN = Buffer.from('nightmail/bono-receipt/v2\0', 'utf8');
const PLAN_BYTE: Record<IssuePlan, number> = { free: 0, paid: 1 };
const PERIOD_BYTE: Record<ReceiptPeriod, number> = { none: 0, monthly: 1, annual: 2 };
const SEED_LENGTH = 32;
const HEX32 = /^[0-9a-f]{64}$/;

/** Signed message: domain + contract (32) + id (32) + plan byte + period byte + deadline (Unix s, u64 BE). */
export function receiptMessage({ contract, id, plan, period, insertBy }: ReceiptFields): Buffer {
  const tail = Buffer.alloc(10);
  tail[0] = PLAN_BYTE[plan];
  tail[1] = PERIOD_BYTE[period];
  tail.writeBigUInt64BE(insertBy, 2);
  return Buffer.concat([DOMAIN, Buffer.from(contract, 'hex'), Buffer.from(id, 'hex'), tail]);
}

export type ReceiptSigner = {
  /** Ed25519 public key (32 bytes), published so anyone can verify. */
  publicKey: Buffer;
  /** Registry contract address (32-byte hex) included in every receipt. */
  contract: string;
  sign(fields: Omit<ReceiptFields, 'contract'>): Buffer;
};

export function createReceiptSigner(seed: Uint8Array, contract: string): ReceiptSigner {
  if (seed.length !== SEED_LENGTH) throw new RangeError('receipt key: expected 32 bytes');
  if (!HEX32.test(contract)) throw new RangeError('receipt contract: expected 32 bytes in lowercase hex');
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length);
  return { publicKey, contract, sign: (fields) => sign(null, receiptMessage({ ...fields, contract }), key) };
}

/** Public key fingerprint (hex SHA-256 of the 32 bytes), for publishing out of band. */
export function receiptKeyFingerprint(publicKey: Buffer): string {
  return `sha256:${createHash('sha256').update(publicKey).digest('hex')}`;
}
