// Prints the fingerprint of the issuer's receipt key (public), the same one the mail server logs when it starts.
// demo.ps1 uses it when that log line is no longer in the container's log:
//   docker exec nightmail-backend-server node infra/backend/receipt-key.mjs
import { readFileSync } from 'node:fs';
import { createReceiptSigner, receiptKeyFingerprint } from '../../apps/server/src/issuer/receipt.ts';

const seed = Buffer.from(readFileSync('/app/.data/operator/undeployed/issuer-receipt-key', 'utf8').trim(), 'hex');
// The public key depends on the seed only. The contract is required by the signer but does not change it.
console.log(receiptKeyFingerprint(createReceiptSigner(seed, '00'.repeat(32)).publicKey));
