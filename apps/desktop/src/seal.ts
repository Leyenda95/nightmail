// Pure rules of the sender seal: which mark a received message carries. The seal only comes from `senderVerified`
// (the signature was checked against the registry), never from `e2e` alone. SMTP mail (not e2e) carries none.
// No React or DOM, so it can be tested with `node --test`.

/** `verified`: sealed end to end and sender checked. `unverified`: sealed end to end but the sender could not be checked. */
export type SenderSeal = 'verified' | 'unverified' | 'none';

export function senderSeal({ e2e, senderVerified }: { e2e: boolean; senderVerified: boolean }): SenderSeal {
  if (!e2e) return 'none';
  return senderVerified ? 'verified' : 'unverified';
}
