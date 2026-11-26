# demo-mailer

Sends realistic demo emails (written in Spanish) to the local NightMail SMTP server. It has no npm runtime dependencies: a minimal SMTP client built on `node:net`, and PNG images built with `node:zlib`. Node 24.12 or later runs the TypeScript directly.

## Before you start

- **The mail server must be running.** For example, start the whole local stack with `bash tools/dev/up.sh`, or only the server with `npm run mail-server -w apps/server`.
- **Every recipient address must already exist.** It must be a NightMail address registered on the network the server uses. Create it in the app first. The server answers `550` to an address it does not know (or `451` while the server is still syncing, or after too many unknown addresses from one IP), and the tool reports it as `REJECTED`.

For the common case, `bash tools/dev/mail.sh name@nightmail.local [other@nightmail.local ...]` wraps this tool: it passes each address as `--to` with the default options.

## Examples

```sh
node tools/demo-mailer/src/cli.ts --to juan.perez@nightmail.local
node tools/demo-mailer/src/cli.ts --to juan.perez@nightmail.local --name Juan --count 6
# demo script: an HTML shop email to an alias and a personal email to the mailbox
node tools/demo-mailer/src/cli.ts --to tienda.abcdefghijkl@nightmail.local=html --to juan.perez@nightmail.local=personal --name Juan
node tools/demo-mailer/src/cli.ts --to juan.perez@nightmail.local --template long --size-kb 600
# reader tests: an inbox with 500 messages, huge hidden images, and many medium images
node tools/demo-mailer/src/cli.ts --to prueba@nightmail.local --count 500
node tools/demo-mailer/src/cli.ts --to prueba@nightmail.local --template bomb
node tools/demo-mailer/src/cli.ts --to prueba@nightmail.local --template images
```

## Options

- `--to address[=template]` (repeatable, required): with `=template`, only that template is sent to that address.
- `--count N`: emails per recipient (default 1).
- `--template name`: one template for every recipient. Without it, the six normal templates rotate.
- `--name`: the name used in greetings. Without it, greetings are neutral ("Hola,"), because an alias has no first name.
- `--size-kb N`: size of the `long` template (default 256).
- `--host` (default 127.0.0.1) and `--port` (default 2525): the SMTP server.
- `--help`: shows the usage.

## Templates

Normal templates, sent in turn: `welcome`, `invoice`, `newsletter`, `personal` (accents and emoji), `attachment` (multipart MIME with a CSV in base64) and `html` (an HTML order confirmation from a shop, with styles, a table, links and the logo as an inline `cid:` image, plus its plain-text version). The order number grows across the whole batch, not per recipient.

Test templates, sent only when you ask for them:

- `long`: tests the size tiers. It is sent as `8bit` (UTF-8 with CRLF), so its size on the wire is the size you asked for, and some lines start with "." (real dot-stuffing).
- `bomb`: one email with one image for each limit of the reader in `apps/desktop/src/images.ts`. They are small 1-bit black PNGs (tens of KB at most) that would take a lot of memory once decoded, each shown in a 64 × 64 box:
  1. Through `cid:`, a PNG that declares 16384 × 16384. It goes over the per-side limit (`MAX_SIDE`, currently 8192).
  2. The same image written inside the HTML as `data:image/png;base64,…` (the path for images embedded in the HTML).
  3. Through `cid:`, a PNG of 8000 × 8000. Each side fits, but its 64 Mpx go over the per-image limit (`MAX_PIXELS`, currently 16 Mpx).

  In the app the three boxes must say «imagen no disponible» without the app freezing. The small green square in the same email must show.
- `images`: 24 PNG images of 1280 × 960, each one a single colour, a few KB each. **It only tests the limit on images per message**: `MAX_INLINE_IMAGES` in the core (`apps/desktop/src-tauri/src/mail/parser/inline.rs`) and `MAX_IMAGES` in the reader (`apps/desktop/src/images.ts`), both currently 20. The last 4 must show as «imagen no disponible», and the message must open and scroll smoothly. **It does not test** the other limits: the images shown stay under the pixel budget per message (`MAX_TOTAL_PIXELS` in `images.ts`) and far below the byte limits of the core (`MAX_INLINE_IMAGE_BYTES` and `MAX_INLINE_TOTAL_BYTES` in `inline.rs`).

## Output

For each email it prints `ACCEPTED`, `REJECTED` (for example `550` if the address does not exist, or `552` after DATA) or `ERROR`, and carries on with the rest. At the end it prints `All delivered.` or `N failed send(s).`

If it cannot connect (it waits 3 s), it stops the batch and prints `Is the server running at <host>:<port>?`

Exit code: 0 if everything was delivered, 1 if any send failed, 2 for wrong usage.

## Tests

From `tools/demo-mailer`, run `npm test` (or `npm test -w tools/demo-mailer` from the repo root). It runs a fake SMTP server inside the test, which checks the order of the commands. HTML emails are read back with `mailparser`. `npm run typecheck` checks the types.
