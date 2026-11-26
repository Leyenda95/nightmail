// Internals for tests and test vectors. Never use them in the server: deterministic sealing reuses
// whatever ephemeral key and nonce it is given, which breaks the encryption if they repeat.
export { deriveMailboxKey, sealMailboxDeterministic, sealPadded } from './mailbox.ts';
export type { SealRandomness } from './mailbox.ts';
export { sealMailDeterministic } from './mail.ts';
export { pad, unpad } from './padding.ts';
export { ed25519Sign } from './request-auth.ts';
