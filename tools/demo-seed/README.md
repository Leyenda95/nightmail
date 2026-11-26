# demo-seed

Prepares the demo network (local devnet or preprod) through the payer's local API (its routes are in `apps/server/src/payer/api.ts`). It has no npm runtime dependencies: it uses the payer client from `apps/server`.

A *bono* is the voucher for a plan (free or paid) that the operator records in the `NightMailRegistry` contract. The app spends its slots to create addresses. This tool works with bonos and with the registry round.

**What you need running first:** the payer for the same network (`npm run operator-wallet -w apps/server`), with the registry already deployed on that network.

```sh
NIGHTMAIL_NETWORK=undeployed node tools/demo-seed/src/cli.ts bonos                      # 600 free + 600 paid
NIGHTMAIL_NETWORK=undeployed node tools/demo-seed/src/cli.ts bonos --hasta 1500         # top up to 1,500 in total
NIGHTMAIL_NETWORK=undeployed node tools/demo-seed/src/cli.ts bonos --free 100 --paid 0
NIGHTMAIL_NETWORK=undeployed node tools/demo-seed/src/cli.ts avanzar-ronda
```

`NIGHTMAIL_NETWORK` is `undeployed` (local devnet) or `preprod`. The default is `preprod`, as on the server. Run `node tools/demo-seed/src/cli.ts --help` for the full usage.

## `bonos`: filler bonos

Issues bonos that nobody can spend, so the demo does not run on a nearly empty bono tree.
**Privacy: they make the tree look bigger, they do not protect anyone, and they are disclosed.** Filler bonos make the tree *look* larger, but they do not grow the real anonymity set. They are easy to spot: many `issueBono` calls in a row from the operator, before any user exists. That is why the demo discloses them as filler.

- Each bono is one `POST /issue` with an id derived from a key. The key is `<operator data>/demo-seed.key`: 32 bytes, created on first use with permissions 0600 and synced to disk. Use `--key-file` for another one. The key lets you **resume without duplicates**. It does not hide anything. If the file has wider permissions than 0600 (checked on Linux and macOS) or a different size, it is not used.
- **You can stop it and run it again.** The same number always gives the same id, and the payer answers `already-issued` without spending anything. If you lose the key, a new run issues new bonos (it does not repeat the old ones).
- **How many:** by default 600 of each plan (1,200 in total). `--hasta N` asks for N in total instead of `--free` and `--paid` (half of each plan, the odd one goes to the free plan). Bonos already issued with the same key show up as `ALREADY` and cost nothing, so you can use it to **top up** to a given size. `--hasta` cannot be combined with `--free` or `--paid`.
- **It is slow.** Every bono goes through the payer's single queue and its hourly DUST cap for issuances (`NIGHTMAIL_PAYER_ISSUE_DUST_PER_HOUR`).
- **Run it before the demo, not during it.** It shares that queue and that cap with the free plans of real users.
- When the payer hits the hourly cap, the indexer is behind or the queue is full, the tool waits as long as the payer says and retries the same bono (it gives up at the 10th wait in a row). It stops at once if there is no spendable DUST, if no registry is deployed, if the payer is stopping, or after 3 failures in a row (each one may cost DUST).

### Output

First it prints `Payer ready (network …, socket …): registry …, N DUST coins.`, so you can see which network you are talking to. Then one line per bono:

| Label | Meaning |
|---|---|
| `ISSUED` | The bono was issued now. |
| `ALREADY` | The bono already existed. Nothing was spent. |
| `PENDING` | An issuance was sent with no known outcome yet. Run the command again after the time shown. |
| `FAILED` | The bono was not issued (it may have cost DUST). Run the command again later. |
| `WAITING` | The tool is waiting before retrying the same bono, with the reason. |

It ends with a summary: `Done: N issued, N already there, N pending, N failed.`

Exit code: 0 if every bono exists. 1 if some are pending or failed (run the command again) or if it stopped. 2 for wrong usage.

### Current limitations

- **It only grows the bono tree.** `issueBono` only adds to `bonos`. The other collections (`slotNullifiers`, `addresses` and `pendingNames`) stay nearly empty, and filling `bonos` does not change them. Those are the collections where the node's random rejections come from, so filling `bonos` does not prevent them.
- **It does not fill the other collections** with filler entries.
- **It does not reset the devnet.**

## `avanzar-ronda`: advance the round

Sends one `POST /advance-round`, which advances the registry round once (the demo's "button"). It prints the new round. If it cannot connect (no socket, or nothing listening), it says so: the round has **not** advanced. If the outcome is unknown (connection lost halfway, an HTTP 5xx error, or a transaction sent with no known outcome), the round may have advanced anyway: check it before you repeat the command. It does not accept the `bonos` options.

## Common options

- `--socket`: the payer socket (default `<operator data>/payer.sock`). The operator data folder depends on `NIGHTMAIL_NETWORK`, as on the server.
- `--help`: shows the usage.
- An unknown option, or one that does not apply to the command (for example `avanzar-ronda --free 3`), is a usage error.

## Tests

From `tools/demo-seed`, run `npm test` (or `npm test -w tools/demo-seed` from the repo root). It runs the real payer API (`apps/server/src/payer/api.ts`) on a temporary Unix socket with a fake payer behind it, so a change in the API contract breaks these tests. `npm run typecheck` checks the types.
