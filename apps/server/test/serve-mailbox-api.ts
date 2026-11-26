// The real Mailbox API on 127.0.0.1, for the desktop core's end-to-end send test (`mail::send` in
// apps/desktop/src-tauri): an in-memory mailbox store and an address index holding only the boxes given, with no
// chain and no SMTP. Not a test itself (`npm test` runs `*.test.ts` only).
//
//   node apps/server/test/serve-mailbox-api.ts '[{"addrKey":"<hex>","encPk":"<hex>","authPk":"<hex>"}]'
//
// Prints its base URL on the first line of stdout and serves until stdin closes.
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { canonicalHost, MemoryNonceStore } from '@nightmail/core-ts';
import { Kind, type RegistryAddress, ResolutionIndex } from '@nightmail/midnight';
import { createApiServer } from '../src/api/mailbox-api.ts';
import { silentLogger } from '../src/log.ts';
import { MailboxStore } from '../src/mailbox/store.ts';
import { AddressDirectory } from '../src/registry/directory.ts';
import { MEMORY, openDatabase } from '../src/storage/db.ts';

type Box = { addrKey: string; encPk: string; authPk: string };

/** A free port on the loopback (the signed host must be known before the server starts). */
async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

const boxes = JSON.parse(process.argv[2] ?? '[]') as Box[];
const entries: RegistryAddress[] = boxes.map((box) => ({
  ...box, kind: Kind.mailbox, nameCipher: '00'.repeat(104), slotNul: randomBytes(32).toString('hex'),
}));
const index = new ResolutionIndex();
index.addBlock(1, entries);

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = createApiServer({
  host: canonicalHost(base),
  directory: new AddressDirectory(index),
  store: new MailboxStore(openDatabase(MEMORY)),
  // Started an hour back: a real server refuses signed requests in its first minute (their nonces may have been seen
  // before a restart), but this one has never run before, so the test does not have to wait.
  nonceStore: new MemoryNonceStore(Math.floor(Date.now() / 1000) - 3600),
  log: silentLogger,
});
await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
process.stdout.write(`${base}\n`);

process.stdin.resume();
process.stdin.on('end', () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
});
