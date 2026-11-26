# core-ts

`@nightmail/core-ts` is the TypeScript side of NightMail's cryptography: sealing and opening mailbox envelopes (padded to a few fixed sizes), the format, signature and encryption of mail between NightMail addresses, and the signing and checking of mailbox API requests. The mail server (`apps/server`) uses it to seal incoming mail and to authenticate requests. It is a library only: it does no networking, stores nothing and does not touch Midnight. The desktop app does not import it; its Rust core has its own implementation, and both must produce the same bytes. That is checked with the known-answer vectors in `packages/test-vectors/crypto`, which this package writes with `npm run vectors -w packages/core-ts`; the byte-level spec is in [`packages/test-vectors/crypto/README.md`](../test-vectors/crypto/README.md). For setup, see the [root README](../../README.md).

**Run its tests** (from the repository root): `npm test -w packages/core-ts`.
