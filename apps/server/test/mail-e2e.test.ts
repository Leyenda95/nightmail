// End to end without a devnet: the whole server (sync against a fake chain, real SMTP, on-disk mailboxes
// and the real API), demo-mailer as the client and an "app" that signs and decrypts.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import { canonicalHost, encodeAuthHeaders, type MailboxRequest, openMailbox, sealMailbox, signRequest } from '@nightmail/core-ts';
import type { RegistryAddress, RegistryAt } from '@nightmail/midnight';
import { run } from '../../../tools/demo-mailer/src/run.ts';
import { type ChainAccess, type RunningMailServer, startMailServer } from '../src/mail-server.ts';
import type { ActionNotice } from '../src/registry/sync.ts';
import { RegistryStore, WrongContract } from '../src/registry/store.ts';
import { DatabaseInUse, openDatabase } from '../src/storage/db.ts';
import { alias, blockHashOf as hashOf, mailbox, registryAt, type TestAddress } from './mail-fixtures.ts';
import { capturingLogger } from './smtp-helpers.ts';

const REGISTRY = '0a'.repeat(32);
const API_URL = 'https://mail.nightmail.test';
const DOMAIN = 'nightmail.local';

/** A fake chain that accepts new blocks with addresses while the server runs. */
function fakeChain() {
  const blocks = new Map<number, RegistryAddress[]>();
  const notices: ActionNotice[] = [];
  const waiting = new Set<() => void>();
  let head = 10;
  const stateAt = (height: number): RegistryAt =>
    registryAt(height, [...blocks].filter(([h]) => h <= height).flatMap(([, entries]) => entries));
  const chain: ChainAccess = {
    fetchAt: async (height) => stateAt(height ?? head),
    source: async function* (fromHeight, signal) {
      let sent = 0;
      while (!signal.aborted) {
        for (; sent < notices.length; sent++) if (notices[sent]!.height >= fromHeight) yield notices[sent]!;
        await new Promise<void>((resolve) => {
          waiting.add(resolve);
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
    },
  };
  return {
    chain,
    /** A new block containing those addresses (via the `entryPoint` action). */
    addBlock(entries: TestAddress[], entryPoint = 'createAlias'): number {
      head += 1;
      blocks.set(head, entries.map((e) => e.entry));
      notices.push({ height: head, hash: hashOf(head), entryPoint });
      for (const wake of waiting) wake();
      waiting.clear();
      return head;
    },
  };
}

const dir = mkdtempSync(path.join(tmpdir(), 'nightmail-e2e-'));
const databaseFile = path.join(dir, 'server', `${REGISTRY}.sqlite`);
const juan = mailbox('juan.perez');
const nube = alias();
const net = fakeChain();
const logs: string[] = [];
let server: RunningMailServer;

const options = () => ({
  registryAddress: REGISTRY, mailDomain: DOMAIN, listenHost: '127.0.0.1', smtpPort: 0, apiPort: 0, apiBaseUrl: API_URL,
  databaseFile, chain: net.chain, log: capturingLogger(logs), syncBackoff: { initialMs: 5, maxMs: 20 },
});

before(async () => {
  net.addBlock([juan], 'registerMailbox');
  net.addBlock([nube]);
  server = await startMailServer(options());
});
after(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

const mail = (...args: string[]) => {
  const out: string[] = [];
  return run(['--port', String(server.smtpPort), ...args], (line) => out.push(line)).then((code) => ({ code, out }));
};

/** What the app does: ask the server for the time, then sign with it and the address key. */
async function api(address: TestAddress, path: string): Promise<Response> {
  const base = `http://127.0.0.1:${server.apiPort}`;
  const { time } = (await (await fetch(`${base}/v1/time`)).json()) as { time: number };
  const request: MailboxRequest = {
    host: canonicalHost(API_URL), version: 1, method: 'GET', path, addrKey: address.addrKey, timestamp: time,
    nonce: new Uint8Array(randomBytes(16)),
  };
  const signature = signRequest(address.authSecretKey, request);
  return fetch(`${base}${path}`, { headers: encodeAuthHeaders({ timestamp: time, nonce: request.nonce, signature }) });
}

async function download(address: TestAddress, since = 0): Promise<{ raw: Buffer; size: number }[]> {
  const list = await api(address, `/v1/box/${address.entry.addrKey}/messages?since=${since}`);
  assert.equal(list.status, 200);
  const { messages } = (await list.json()) as { messages: { id: string; size: number }[] };
  const out: { raw: Buffer; size: number }[] = [];
  for (const { id, size } of messages) {
    const response = await api(address, `/v1/box/${address.entry.addrKey}/messages/${id}`);
    assert.equal(response.status, 200);
    const envelope = new Uint8Array(await response.arrayBuffer());
    assert.equal(envelope.length, size + 62, 'the announced size is the envelope bucket');
    out.push({ raw: Buffer.from(openMailbox(address.encSecretKey, envelope)), size });
  }
  return out;
}

test('the server starts once it knows the addresses on chain', () => {
  assert.deepEqual(server.sync.status, { cursor: 12, fetched: 12, addresses: 2, healthy: true });
  assert.ok(logs.some((l) => /SMTP on 127\.0\.0\.1:\d+ for @nightmail\.local; mailbox API on 127\.0\.0\.1:\d+ \(signed host mail\.nightmail\.test\)/.test(l)));
});

test('the demo-mailer delivers the normal templates to a mailbox and the app downloads, decrypts and parses them', async () => {
  const { code, out } = await mail('--to', `juan.perez@${DOMAIN}`, '--count', '5', '--name', 'Juan');
  assert.equal(code, 0, out.join('\n'));
  assert.equal(out.filter((line) => line.startsWith('ACCEPTED')).length, 5);
  const stored = server.mailboxes.list(juan.addrKey, 0, 100).messages;
  assert.equal(stored.length, 5);
  const parsed = await Promise.all(stored.map(async (m) =>
    simpleParser(Buffer.from(openMailbox(juan.encSecretKey, server.mailboxes.get(juan.addrKey, m.id)!)))));
  assert.deepEqual(parsed.map((p) => p.subject), [
    '¡Bienvenido a Tienda Luna, Juan!',
    'Factura F-2026-48201 de Suministros Aurora',
    'El Faro Digital · Lo más leído de la semana',
    '¡Cena el sábado! 🎉 ¿Te apuntas?',
    'Tu pedido #48204 está en camino 📦',
  ]);
  for (const p of parsed) assert.equal(p.to && !Array.isArray(p.to) ? p.to.value[0]!.address : '', `juan.perez@${DOMAIN}`);
  assert.equal(parsed[0]!.from!.value[0]!.address, 'pedidos@tiendaluna.example');
  assert.match(parsed[0]!.text!, /usa el código LUNA10 y tendrás un 10 % de descuento/);
  assert.match(parsed[1]!.text!, /Tóner negro\s+1\s+58,90 €/);
  assert.match(parsed[3]!.text!, /Habrá paella 🥘, tortilla de patatas/);
  const [attachment] = parsed[4]!.attachments;
  assert.equal(attachment!.filename, 'resumen-pedido.csv');
  assert.match(attachment!.content.toString('utf8'), /T-220,Tóner negro,1,58\.90/);
});

test('the long template (8-bit, without BODY=8BITMIME) reaches an alias intact, a nonexistent recipient gets 550', async () => {
  const { code, out } = await mail(
    '--to', `${nube.localPart}@${DOMAIN}=long`, '--to', `no.existe@${DOMAIN}`, '--to', `${nube.localPart.toUpperCase()}@${DOMAIN}=personal`,
    '--size-kb', '300',
  );
  assert.equal(code, 1, 'there was a rejection');
  assert.match(out[0]!, /^ACCEPTED {2}\[long\] /);
  assert.match(out[1]!, /^REJECTED {2}\[\w+\] no\.existe@nightmail\.local: 550 5\.1\.1 No such mailbox here$/);
  assert.match(out[2]!, /^ACCEPTED {2}\[personal\] /);
  assert.equal(out[3], '1 failed send(s).');

  const stored = server.mailboxes.list(nube.addrKey, 0, 10).messages;
  assert.deepEqual(stored.map((m) => m.size), [524_288, 4096], 'buckets: 512 KiB for ~300 KiB and 4 KiB');
  const long = Buffer.from(openMailbox(nube.encSecretKey, server.mailboxes.get(nube.addrKey, stored[0]!.id)!));
  const parsed = await simpleParser(long);
  assert.equal(parsed.subject, 'Informe largo de prueba (300 KiB)');
  const lines = parsed.text!.trimEnd().split('\n');
  assert.ok(long.length >= 300 * 1024 && long.length < 310 * 1024, `${long.length} bytes`);
  assert.ok(lines.length > 1000);
  lines.forEach((line, i) => {
    const n = i + 1;
    assert.ok(line.startsWith(`${n % 25 === 0 ? '.' : ''}Línea ${n}. Este párrafo de relleno`), `line ${n}: ${line.slice(0, 40)}`);
    assert.ok(line.endsWith('¿qué tal? o ¡hasta pronto! para comprobar que la codificación se mantiene íntegra de principio a fin.'));
  });
  assert.match(long.toString('latin1'), /Content-Transfer-Encoding: 8bit/i);
});

test('an address created while the server runs starts receiving as soon as its block arrives', async () => {
  const nueva = mailbox('recien.llegada');
  const before = await mail('--to', `recien.llegada@${DOMAIN}`, '--template', 'welcome');
  assert.equal(before.code, 1);
  net.addBlock([nueva], 'registerMailbox');
  for (let i = 0; i < 100 && server.sync.status.addresses < 3; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  const afterwards = await mail('--to', `recien.llegada@${DOMAIN}`, '--template', 'welcome');
  assert.equal(afterwards.code, 0, afterwards.out.join('\n'));
  assert.equal(server.mailboxes.list(nueva.addrKey, 0, 10).messages.length, 1);
});

test('right after start, the API rejects signed requests (it does not remember earlier nonces)', async () => {
  const response = await api(juan, `/v1/box/${juan.entry.addrKey}/messages?since=0`);
  assert.equal(response.status, 401);
  assert.ok(response.headers.get('date'));
});

test('after restart: keeps boxes and index, does not reread the chain from the start and the app downloads with signed requests', async () => {
  await server.close();
  const fetched: (number | undefined)[] = [];
  const subscribedFrom: number[] = [];
  let clock = Date.now();
  server = await startMailServer({
    ...options(),
    now: () => clock,
    chain: {
      fetchAt: async (height) => {
        fetched.push(height);
        return net.chain.fetchAt(height);
      },
      source: (fromHeight, signal, alive) => { subscribedFrom.push(fromHeight); return net.chain.source(fromHeight, signal, alive); },
    },
  });
  assert.deepEqual(fetched, [undefined], 'only the current state, to check it is up to date');
  assert.deepEqual(subscribedFrom, [13], 'resumes from the last processed block');
  assert.equal(server.sync.status.addresses, 3);

  clock += 61_000; // outside the nonce startup window
  const forJuan = await download(juan);
  assert.equal(forJuan.length, 5);
  assert.equal((await simpleParser(forJuan[0]!.raw)).subject, '¡Bienvenido a Tienda Luna, Juan!');
  const forAlias = await download(nube);
  assert.deepEqual(forAlias.map((m) => m.size), [524_288, 4096]);
  assert.equal((await simpleParser(forAlias[1]!.raw)).subject, '¡Cena el sábado! 🎉 ¿Te apuntas?');
  assert.equal((await download(juan, 3)).length, 2, 'since = cursor: only what comes after');

  // Another address's key does not open this mailbox, and its signature cannot request it either.
  const stolen = await api({ ...nube, addrKey: juan.addrKey, entry: juan.entry }, `/v1/box/${juan.entry.addrKey}/messages?since=0`);
  assert.equal(stolen.status, 401);
});

test('one contract database is not opened with another, a base URL that cannot be signed does not start', async () => {
  await server.close();
  await assert.rejects(startMailServer({ ...options(), registryAddress: '0b'.repeat(32) }), WrongContract);
  await assert.rejects(startMailServer({ ...options(), apiBaseUrl: 'http://mail_server:8080' }), /host/);
  const db = openDatabase(databaseFile); // the failed attempts closed the database without damaging it
  assert.equal(new RegistryStore(db, REGISTRY).load().index.size, 3);
  db.close();
  server = await startMailServer(options());
});

test('assembly: a second server does not open the same database, the database is compacted at start and periodically, and without a healthy sync unknown recipients get 451', async () => {
  await assert.rejects(startMailServer(options()), DatabaseInUse);
  await server.close();
  const compactions = () => logs.filter((l) => l === 'info storage: database compacted').length;
  const before = compactions();
  server = await startMailServer({ ...options(), compactEveryMs: 20, syncStaleAfterMs: 0 });
  const atStart = compactions();
  assert.equal(atStart, before + 1, 'at start, before opening the ports');
  for (let i = 0; i < 200 && compactions() === atStart; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(compactions() > atStart, 'and afterwards, every compactEveryMs');
  await new Promise((resolve) => setTimeout(resolve, 5)); // with a 0 ms margin it is no longer healthy
  const { code, out } = await mail('--to', `no.existe@${DOMAIN}`, '--to', `juan.perez@${DOMAIN}`, '--template', 'welcome');
  assert.equal(code, 1);
  assert.match(out[0]!, /: 451 4\.3\.0 Recipient not verifiable now, try again later$/);
  assert.match(out[1]!, /^ACCEPTED /);
  await server.close();
  server = await startMailServer(options());
});

test('an app delivers an envelope it sealed itself, the owner downloads and opens it, and the database keeps no trace of the sender', async () => {
  await server.close();
  let shift = 0;
  server = await startMailServer({ ...options(), now: () => Date.now() + shift });
  shift = 61_000; // outside the nonce startup window
  const base = `http://127.0.0.1:${server.apiPort}`;
  const message = 'Subject: Cifrado en origen\r\n\r\nEste correo lo cifró la app del remitente.\r\n';
  const envelope = new Uint8Array(sealMailbox(Buffer.from(juan.entry.encPk, 'hex'), Buffer.from(message)));
  const post = (addrKeyHex: string) => fetch(`${base}/v1/box/${addrKeyHex}/deliver`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', 'user-agent': 'remitente-oculto/1.0' }, body: envelope,
  });
  const answer = await post(juan.entry.addrKey);
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { status: 'delivered' });
  const missing = await post('ab'.repeat(32));
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'not_found' });

  const received = await download(juan);
  const last = received.at(-1)!;
  assert.equal(last.size, 4096);
  assert.equal(last.raw.toString(), message);
  assert.equal((await simpleParser(last.raw)).subject, 'Cifrado en origen');

  for (const file of [databaseFile, `${databaseFile}-wal`]) {
    if (!existsSync(file)) continue;
    const bytes = readFileSync(file).toString('latin1');
    for (const trace of ['127.0.0.1', 'remitente-oculto']) assert.equal(bytes.includes(trace), false, `${path.basename(file)}: ${trace}`);
  }
});

test('shortly after a relayed inclusion (settling), unknown recipients get temporary errors, known ones are served as usual', async () => {
  await server.close();
  let settling = true;
  server = await startMailServer({ ...options(), settling: () => settling });
  const { code, out } = await mail('--to', `recien.creada@${DOMAIN}`, '--to', `juan.perez@${DOMAIN}`, '--template', 'welcome');
  assert.equal(code, 1);
  assert.match(out[0]!, /: 451 4\.3\.0 Recipient not verifiable now, try again later$/, 'SMTP: try later, not 550');
  assert.match(out[1]!, /^ACCEPTED /);
  const post = () => fetch(`http://127.0.0.1:${server.apiPort}/v1/box/${'ab'.repeat(32)}/deliver`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array(sealMailbox(Buffer.from(juan.entry.encPk, 'hex'), Buffer.from('hola'))),
  });
  const pending = await post();
  assert.equal(pending.status, 503, 'delivery: unavailable (retry), not 404');
  assert.equal(pending.headers.get('retry-after'), '30');

  settling = false;
  const settled = await mail('--to', `recien.creada@${DOMAIN}`, '--template', 'welcome');
  assert.match(settled.out[0]!, /: 550 5\.1\.1 No such mailbox here$/, 'once settled, an unknown address does not exist');
  assert.equal((await post()).status, 404);
  await server.close();
  server = await startMailServer(options());
});

test('if there is no registry at the configured address, it does not start (and leaves nothing open)', async () => {
  const empty = path.join(dir, 'server', 'sin-registro.sqlite');
  const chain: ChainAccess = { fetchAt: async () => null, source: async function* () { /* empty */ } };
  await assert.rejects(startMailServer({ ...options(), databaseFile: empty, chain }), /no registry contract/);
});

test('neither the content nor the addresses appear in the server logs', () => {
  const all = logs.join('\n');
  for (const secret of ['juan', 'Tienda Luna', 'LUNA10', nube.localPart, 'recien', 'no.existe', juan.entry.addrKey]) {
    assert.equal(all.includes(secret), false, secret);
  }
  assert.ok(logs.some((l) => l === 'debug smtp: message stored in 1 mailbox(es)'));
});
