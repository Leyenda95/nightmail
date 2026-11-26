# midnight

`@nightmail/midnight` is what the mail server (`apps/server`) and the helper process (`apps/midnight-sidecar`) share about the `NightMailRegistry` contract: the hashes, computed with the compiled contract's own pure circuits so they match the chain exactly, the mailbox name and alias rules, the indexer queries for the registry state and its decoding (the caller performs the request), the index used to resolve addresses, and helpers for private files and locks. It is a library only: it holds no wallet, builds no proofs and sends no transactions. It imports the compiled contract from `contracts/managed`, so compile the contracts first. Its tests check the hashes against `packages/test-vectors/contract/registry.json`. For setup, see the [root README](../../README.md).

**Run its tests** (from the repository root, with the contracts compiled): `npm test -w packages/midnight`. A few tests only run on Windows or only on Linux and are skipped elsewhere.
