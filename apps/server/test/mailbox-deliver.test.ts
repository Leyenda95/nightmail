// Anonymous delivery route of the Mailbox API: POST /v1/box/<addrKey>/deliver.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import {
  encodeAuthHeaders, envelopeLengthFor, type MailboxRequest, MAX_ENVELOPE_LENGTH, MemoryNonceStore, openMailbox, sealMailbox, signRequest,
} from '@nightmail/core-ts';
import { ResolutionIndex } from '@nightmail/midnight';
import { bodyDeadlineMs, DEFAULT_DELIVER_LIMITS, type DeliverLimits, deliverLimitsOf } from '../src/api/deliver.ts';
import { type ApiDeps, createApiServer, parseRoute } from '../src/api/mailbox-api.ts';
import { clientAddress } from '../src/issuer/client-ip.ts';
import { DEFAULT_MAILBOX_QUOTA_BYTES, MailboxStore } from '../src/mailbox/store.ts';
import { AddressDirectory } from '../src/registry/directory.ts';
import { type Database, MEMORY, openDatabase } from '../src/storage/db.ts';
import { alias, LOW_ORDER_AUTH_PK, LOW_ORDER_ENC_PK, mailbox, type TestAddress } from './mail-fixtures.ts';
import { capturingLogger } from './smtp-helpers.ts';

const HOST = 'mail.nightmail.test';
const T0 = 1_794_873_600; // seconds, a whole hour
const OTHER_IP = '127.0.0.2'; // another loopback address: a second client IP
const THIRD_IP = '127.0.0.3';

type Api = { port: number; db: Database; store: MailboxStore; logs: string[]; clock: { ms: number }; close(): Promise<void> };
type Answer = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

type Options = {
  limits?: Partial<DeliverLimits>; quotaBytes?: number; healthy?: () => boolean; override?: (deps: ApiDeps) => ApiDeps;
};

const open: Api[] = [];
afterEach(async () => {
  for (const api of open.splice(0)) await api.close();
});

async function apiWith(addresses: TestAddress[], options: Options = {}): Promise<Api> {
  const db = openDatabase(MEMORY);
  const store = new MailboxStore(db, options.quotaBytes === undefined ? {} : { quotaBytes: options.quotaBytes });
  const index = new ResolutionIndex();
  index.addBlock(1, addresses.map((a) => a.entry));
  const logs: string[] = [];
  const clock = { ms: (T0 + 1234) * 1000 };
  const deps: ApiDeps = {
    host: HOST, directory: new AddressDirectory(index), store, nonceStore: new MemoryNonceStore(T0 - 10_000), log: capturingLogger(logs),
    now: () => clock.ms,
    ...(options.limits && { deliverLimits: options.limits }),
    ...(options.healthy && { directoryHealthy: options.healthy }),
  };
  const server = createApiServer(options.override ? options.override(deps) : deps);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const api: Api = {
    port: (server.address() as AddressInfo).port, db, store, logs, clock,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
  open.push(api);
  return api;
}

const deliverPath = (address: TestAddress) => `/v1/box/${address.entry.addrKey}/deliver`;
const envelopeFor = (address: TestAddress, text: string) => Buffer.from(sealMailbox(Buffer.from(address.entry.encPk, 'hex'), Buffer.from(text)));

type Request = { path: string; method?: string; headers?: Record<string, string>; body?: Uint8Array; localAddress?: string };

/** A whole request with a standard client: headers and body sent, then the answer read. */
function request(api: Api, { path, method = 'POST', headers, body, localAddress }: Request): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const all = { 'content-type': 'application/octet-stream', ...(body && { 'content-length': String(body.length) }), ...headers };
    const req = http.request({ host: '127.0.0.1', port: api.port, path, method, headers: all, agent: false, ...(localAddress && { localAddress }) }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const deliver = (api: Api, address: TestAddress, body: Uint8Array, localAddress?: string) =>
  request(api, { path: deliverPath(address), body, ...(localAddress && { localAddress }) });

/** Parses a raw HTTP/1.1 answer (the server always sends Content-Length and closes); status 0 if there was none. */
function parse(raw: Buffer): Answer {
  if (raw.length === 0) return { status: 0, headers: {}, body: '' };
  const text = raw.toString('latin1');
  const end = text.indexOf('\r\n\r\n');
  const [statusLine, ...lines] = text.slice(0, end).split('\r\n');
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status: Number(statusLine!.split(' ')[1]), headers, body: text.slice(end + 4) };
}

/** A socket that sent the request head (and optionally the start of a body) and nothing else. */
async function rawSocket(api: Api, head: string, localAddress?: string): Promise<{ socket: net.Socket; answer: Promise<Answer> }> {
  const socket = net.connect({ port: api.port, host: '127.0.0.1', ...(localAddress && { localAddress }) });
  socket.on('error', () => {});
  const chunks: Buffer[] = [];
  socket.on('data', (chunk) => chunks.push(chunk));
  const answer = once(socket, 'close').then(() => parse(Buffer.concat(chunks)));
  await once(socket, 'connect');
  socket.write(head);
  return { socket, answer };
}

const head = (path: string, headers: Record<string, string>, method = 'POST') =>
  [`${method} ${path} HTTP/1.1`, 'Host: 127.0.0.1', ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', ''].join('\r\n');

/** The answer to a request whose head alone decides it: no body byte is ever sent. */
async function headOnly(api: Api, path: string, headers: Record<string, string>, localAddress?: string): Promise<Answer> {
  return (await rawSocket(api, head(path, headers), localAddress)).answer;
}

const octets = (length: number) => ({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(length) });
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Signing = Partial<MailboxRequest>;
function signed(address: TestAddress, path: string, overrides: Signing = {}): Record<string, string> {
  const request: MailboxRequest = {
    host: HOST, version: 1, method: 'GET', path, addrKey: address.addrKey, timestamp: T0 + 1234, nonce: new Uint8Array(randomBytes(16)), ...overrides,
  };
  return encodeAuthHeaders({ timestamp: request.timestamp, nonce: request.nonce, signature: signRequest(address.authSecretKey, request) });
}

/** What the owner's app does: signed listing, then signed download of each envelope. */
async function downloadAll(api: Api, address: TestAddress): Promise<Buffer[]> {
  const list = `/v1/box/${address.entry.addrKey}/messages?since=0`;
  const listed = await request(api, { path: list, method: 'GET', headers: signed(address, list) });
  assert.equal(listed.status, 200);
  const out: Buffer[] = [];
  for (const { id } of JSON.parse(listed.body).messages as { id: string }[]) {
    const path = `/v1/box/${address.entry.addrKey}/messages/${id}`;
    const answer = await new Promise<Buffer>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: api.port, path, headers: signed(address, path), agent: false }, (res) => {
        assert.equal(res.statusCode, 200);
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', reject);
      req.end();
    });
    out.push(answer);
  }
  return out;
}

const SMALL = envelopeLengthFor(0); // 62 + 4096
const BAD_REQUEST = '{"error":"bad_request"}';
const RATE_LIMITED = '{"error":"rate_limited"}';
const stored = (api: Api, address: TestAddress) => api.store.list(address.addrKey, 0, 100).messages.length;

test('parseRoute: the delivery route, written exactly like this', () => {
  const key = 'ab'.repeat(32);
  assert.deepEqual(parseRoute(`/v1/box/${key}/deliver`), { kind: 'deliver', addrKey: key });
  for (const url of [
    `/v1/box/${key}/deliver/`, `/v1/box/${key}/deliver?x=1`, `/v1/box/${key}/Deliver`, `/v1/box/${key.toUpperCase()}/deliver`,
    `/v1/box/${key.slice(2)}/deliver`, `/v1/box/${key}/./deliver`, `/v1/box/${key}/deliver#f`, `/v1/box/${key}/messages/deliver`,
  ]) {
    assert.equal(parseRoute(url), undefined, url);
  }
});

test('an envelope sealed by the sender is stored like SMTP mail, and the owner downloads and opens it with signed requests', async () => {
  const juan = mailbox('juan.perez');
  const nube = alias();
  const api = await apiWith([juan, nube]);
  const envelope = envelopeFor(juan, 'Hola Juan, esto lo cifró mi app.');
  const answer = await deliver(api, juan, envelope);
  assert.equal(answer.status, 200);
  assert.equal(answer.body, '{"status":"delivered"}');
  assert.equal(answer.headers['content-type'], 'application/json');
  assert.equal(answer.headers['cache-control'], 'no-store');
  assert.equal(answer.headers.connection, 'close');
  assert.deepEqual(Object.keys(answer.headers).filter((h) => h.startsWith('access-control-')), [], 'no CORS');

  const [summary] = api.store.list(juan.addrKey, 0, 10).messages;
  assert.deepEqual({ size: summary!.size, receivedAt: summary!.receivedAt }, { size: 4096, receivedAt: T0 + 1200 }, 'bucket and date rounded to the minute (T0 + 20 min 34 s)');
  const [downloaded] = await downloadAll(api, juan);
  assert.ok(downloaded!.equals(envelope), 'stored byte for byte, nothing added');
  assert.equal(Buffer.from(openMailbox(juan.encSecretKey, downloaded!)).toString(), 'Hola Juan, esto lo cifró mi app.');

  assert.equal((await deliver(api, nube, envelopeFor(nube, 'para el alias'))).status, 200, 'an alias is a box like any other');
  assert.equal(stored(api, nube), 1);
  assert.equal(stored(api, juan), 1);
  assert.deepEqual(api.logs, ['debug api: envelope delivered', 'debug api: envelope delivered']);
});

test('nothing about the sender is stored or logged: no IP, no request headers', async () => {
  const juan = mailbox('juan.perez');
  const api = await apiWith([juan]);
  const tracking = { 'User-Agent': 'rastreador/9.9', 'X-Forwarded-For': '203.0.113.77', Cookie: 'sesion=galleta-secreta', Referer: 'https://ref.example/x' };
  assert.equal((await request(api, { path: deliverPath(juan), body: envelopeFor(juan, 'uno'), headers: tracking })).status, 200);
  assert.equal((await deliver(api, juan, envelopeFor(juan, 'dos'), OTHER_IP)).status, 200);
  await deliver(api, mailbox('no.existe'), envelopeFor(juan, 'tres')); // a rejection is not logged with details either

  const columns = (api.db.prepare('PRAGMA table_info(message)').all() as { name: string }[]).map((c) => c.name);
  assert.deepEqual(columns, ['addr_key', 'seq', 'id', 'received_at', 'size', 'envelope']);
  const tables = (api.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
  const everything = tables.flatMap((t) => api.db.prepare(`SELECT * FROM "${t}"`).all()).map((row) =>
    Object.values(row as Record<string, unknown>).map((v) => (v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : String(v))).join('|')).join('\n');
  const logs = api.logs.join('\n');
  for (const trace of ['127.0.0.1', OTHER_IP, ...Object.values(tracking), 'rastreador', '203.0.113']) {
    assert.equal(everything.includes(trace), false, `database: ${trace}`);
    assert.equal(logs.includes(trace), false, `logs: ${trace}`);
  }
  assert.equal(logs.includes(juan.entry.addrKey), false, 'nor the box');
  assert.deepEqual(api.logs, ['debug api: envelope delivered', 'debug api: envelope delivered', 'debug api: delivery rejected (unknown-box)']);
});

test('a box that does not exist (or has unusable keys) gets the same 404 as the rest of the API, and past the limit everything is 429', async () => {
  const juan = mailbox('juan.perez');
  const badEnc = mailbox('cifrado.malo', { encPk: LOW_ORDER_ENC_PK });
  const badAuth = mailbox('firma.mala', { authPk: LOW_ORDER_AUTH_PK });
  const stranger = mailbox('no.registrado');
  const api = await apiWith([juan, badEnc, badAuth], { limits: { unknownBoxes: { limit: 3, windowMs: 60_000 } } });
  const notFound = await request(api, { path: '/v1/nada', method: 'GET' });
  const answers: Answer[] = [];
  for (const box of [stranger, badEnc, badAuth]) {
    const answer = await deliver(api, box, envelopeFor(juan, 'hola'));
    assert.equal(answer.status, 404, box.localPart);
    assert.equal(answer.body, notFound.body);
    answers.push(answer);
  }
  const shape = (a: Answer) => JSON.stringify(Object.keys(a.headers).filter((h) => h !== 'date').sort());
  assert.equal(new Set([notFound, ...answers].map(shape)).size, 1, 'same headers as any other 404');

  const limited = await deliver(api, juan, envelopeFor(juan, 'existe, pero ya no se contesta'));
  assert.equal(limited.status, 429, 'an IP that probed too many unknown boxes learns nothing more');
  assert.equal(limited.body, RATE_LIMITED);
  assert.equal((await deliver(api, stranger, envelopeFor(juan, 'otra vez'))).status, 429);
  assert.equal(stored(api, juan), 0);
  assert.equal((await deliver(api, juan, envelopeFor(juan, 'desde otra IP'), OTHER_IP)).status, 200, 'another IP is not affected');
  api.clock.ms += 60_000;
  assert.equal((await deliver(api, juan, envelopeFor(juan, 'más tarde'))).status, 200, 'after the window');
});

test('while the address index is stale, an unknown box gets 503 instead of a definitive 404', async () => {
  const juan = mailbox('juan.perez');
  const api = await apiWith([juan], { healthy: () => false });
  const answer = await deliver(api, mailbox('recien.creada'), envelopeFor(juan, 'hola'));
  assert.equal(answer.status, 503);
  assert.equal(answer.body, '{"error":"unavailable"}');
  assert.equal(answer.headers['retry-after'], '30');
  assert.equal((await deliver(api, juan, envelopeFor(juan, 'hola'))).status, 200, 'known boxes still receive');
});

test('malformed requests get one fixed 400 (oversized ones 413) before any body byte is read', async () => {
  const juan = mailbox('juan.perez');
  const api = await apiWith([juan]);
  const path = deliverPath(juan);
  const cases: [string, Record<string, string>][] = [
    ['no Content-Type', { 'Content-Length': String(SMALL) }],
    ['another Content-Type', { 'Content-Type': 'text/plain', 'Content-Length': String(SMALL) }],
    ['Content-Type with parameters', { 'Content-Type': 'application/octet-stream; charset=utf-8', 'Content-Length': String(SMALL) }],
    ['form', { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': String(SMALL) }],
    ['no Content-Length (chunked)', { 'Content-Type': 'application/octet-stream', 'Transfer-Encoding': 'chunked' }],
    ['empty', octets(0)],
    ['smaller than the smallest envelope', octets(SMALL - 1)],
    ['header only', octets(62)],
    ['the bucket without the header', octets(4096)],
    ['not a bucket', octets(SMALL + 1)],
    ['between two buckets', octets(envelopeLengthFor(5000) - 100)],
  ];
  for (const [why, headers] of cases) {
    const answer = await headOnly(api, path, headers);
    assert.equal(answer.status, 400, why);
    assert.equal(answer.body, BAD_REQUEST, why);
    assert.equal(answer.headers['cache-control'], 'no-store');
  }
  for (const length of [MAX_ENVELOPE_LENGTH + 1, 4 * MAX_ENVELOPE_LENGTH, 9_999_999_999]) {
    const answer = await headOnly(api, path, octets(length));
    assert.equal(answer.status, 413, String(length));
    assert.equal(answer.body, '{"error":"too_large"}');
  }
  assert.equal(stored(api, juan), 0);
  assert.ok(api.logs.every((l) => /^debug api: delivery rejected \((bad-request|bad-length|too-large)\)$/.test(l)), api.logs.join('\n'));
});

test('a configured maximum below the largest bucket is 413 above it', async () => {
  const juan = mailbox('juan.perez');
  const api = await apiWith([juan], { limits: { maxEnvelopeBytes: envelopeLengthFor(5000) } });
  assert.equal((await headOnly(api, deliverPath(juan), octets(envelopeLengthFor(10_000)))).status, 413);
  assert.equal((await deliver(api, juan, envelopeFor(juan, 'x'.repeat(5000)))).status, 200, 'right at the maximum');
});

test('an envelope whose public header is not version 1 / suite 1 is 400 and not stored', async () => {
  const juan = mailbox('juan.perez');
  const api = await apiWith([juan]);
  for (const header of [[0x02, 0x01], [0x01, 0x02], [0x00, 0x00]]) {
    const envelope = envelopeFor(juan, 'hola');
    envelope.set(header);
    const answer = await deliver(api, juan, envelope);
    assert.equal(answer.status, 400, String(header));
    assert.equal(answer.body, BAD_REQUEST);
  }
  assert.equal((await deliver(api, juan, new Uint8Array(SMALL).fill(0x01))).status, 200, 'the rest is opaque: not inspected');
  assert.equal(stored(api, juan), 1);
});

test('a wrong version or suite is refused as soon as its two bytes arrive, without waiting for the rest of the body', async () => {
  const juan = mailbox('juan.perez');
  const api = await apiWith([juan], { limits: { smallSlots: 1 } });
  const path = deliverPath(juan);
  const started = Date.now();
  const early = await rawSocket(api, head(path, octets(SMALL)) + '\x02\x01');
  const answer = await early.answer;
  assert.equal(answer.status, 400);
  assert.equal(answer.body, BAD_REQUEST);
  assert.ok(Date.now() - started < 2000, 'not after the body deadline (about 5 s)');

  const split = await rawSocket(api, head(path, octets(SMALL)) + '\x01');
  await delay(50);
  split.socket.write('\x07');
  assert.equal((await split.answer).status, 400, 'one byte at a time: refused on the second');

  const good = await rawSocket(api, head(path, octets(SMALL)) + '\x01\x01');
  await delay(100);
  assert.equal(good.socket.destroyed, false, 'a right header keeps the upload open');
  good.socket.destroy();
  await delay(50);
  assert.equal((await deliver(api, juan, envelopeFor(juan, 'bien'))).status, 200, 'and the slot is free again after each');
  assert.equal(stored(api, juan), 1);
});

test('another method on the delivery route is 405 (Allow: POST), POST elsewhere stays 405 (Allow: GET), and a CORS preflight gets no CORS', async () => {
  const juan = mailbox('juan.perez');
  const api = await apiWith([juan]);
  for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS']) {
    const answer = await request(api, { path: deliverPath(juan), method, headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
    assert.equal(answer.status, 405, method);
    assert.equal(answer.headers.allow, 'POST');
    assert.equal(answer.body, '{"error":"method_not_allowed"}');
    assert.deepEqual(Object.keys(answer.headers).filter((h) => h.startsWith('access-control-')), [], method);
  }
  for (const path of ['/v1/time', `/v1/box/${juan.entry.addrKey}/messages`]) {
    const answer = await request(api, { path, body: envelopeFor(juan, 'hola') });
    assert.equal(answer.status, 405, path);
    assert.equal(answer.headers.allow, 'GET');
  }
  assert.equal(stored(api, juan), 0);
});

test('per-IP limits: attempts and bytes, each IP on its own', async () => {
  const juan = mailbox('juan.perez');
  const ana = mailbox('ana.garcia');
  const max = envelopeLengthFor(10_000); // 62 + 16 KiB
  const api = await apiWith([juan, ana], {
    limits: { perIp: { limit: 3, windowMs: 60_000 }, bytesPerIp: { limit: max, windowMs: 60_000 }, maxEnvelopeBytes: max },
  });
  const mid = envelopeFor(juan, 'm'.repeat(5000)); // 62 + 8 KiB
  assert.equal((await deliver(api, juan, mid)).status, 200);
  const overBytes = await deliver(api, ana, envelopeFor(ana, 'm'.repeat(5000)));
  assert.equal(overBytes.status, 429, 'two of 8 KiB exceed the 16 KiB of the IP');
  assert.equal(overBytes.body, RATE_LIMITED);
  assert.equal((await deliver(api, ana, envelopeFor(ana, 'pequeño'))).status, 200, '8 KiB + 4 KiB fit');
  const overCount = await deliver(api, ana, envelopeFor(ana, 'otro'));
  assert.equal(overCount.status, 429, 'third attempt of the window');
  assert.equal(overCount.headers['retry-after'], overBytes.headers['retry-after'], 'the same answer whichever limit it is');
  assert.equal((await deliver(api, ana, envelopeFor(ana, 'otra IP'), OTHER_IP)).status, 200);
  api.clock.ms += 60_000;
  assert.equal((await deliver(api, ana, envelopeFor(ana, 'después'))).status, 200);
});

test('behind a trusted proxy the per-IP limits use the last X-Forwarded-For entry; without one the header is ignored', async () => {
  const juan = mailbox('juan.perez');
  const perIp = { limit: 1, windowMs: 60_000 };
  const proxied = await apiWith([juan], {
    limits: { perIp },
    override: (deps) => ({ ...deps, clientAddress: clientAddress(true), limits: { perIp: { limit: 3, windowMs: 60_000 } } }),
  });
  const via = (api: Api, forwarded: string, path = deliverPath(juan), method = 'POST') =>
    request(api, { path, method, headers: { 'X-Forwarded-For': forwarded }, ...(method === 'POST' && { body: envelopeFor(juan, forwarded) }) });
  assert.equal((await via(proxied, '203.0.113.1')).status, 200);
  assert.equal((await via(proxied, '6.6.6.6, 203.0.113.2')).status, 200, 'another client behind the same proxy');
  assert.equal((await via(proxied, '203.0.113.1')).body, RATE_LIMITED, 'the first client again: its own limit');
  for (let i = 0; i < 3; i++) assert.equal((await via(proxied, '198.51.100.7', '/v1/time', 'GET')).status, 200);
  assert.equal((await via(proxied, '198.51.100.7', '/v1/time', 'GET')).status, 429, 'the API-wide per-IP limit too');
  assert.equal((await via(proxied, '198.51.100.8', '/v1/time', 'GET')).status, 200);

  const direct = await apiWith([juan], { limits: { perIp } });
  assert.equal((await via(direct, '203.0.113.1')).status, 200);
  assert.equal((await via(direct, '203.0.113.2')).body, RATE_LIMITED, 'without a trusted proxy a client cannot pick its own IP');
  assert.equal(stored(direct, juan), 1);
});

test('per-box limits: count only stored envelopes, whatever the IP', async () => {
  const juan = mailbox('juan.perez');
  const ana = mailbox('ana.garcia');
  const api = await apiWith([juan, ana], { limits: { perBox: { limit: 2, windowMs: 3_600_000 } } });
  const bad = envelopeFor(juan, 'malo');
  bad[0] = 0x07;
  assert.equal((await deliver(api, juan, bad)).status, 400, 'a rejected envelope does not count');
  assert.equal((await deliver(api, juan, envelopeFor(juan, 'uno'))).status, 200);
  assert.equal((await deliver(api, juan, envelopeFor(juan, 'dos'), OTHER_IP)).status, 200);
  const limited = await deliver(api, juan, envelopeFor(juan, 'tres'), OTHER_IP);
  assert.equal(limited.status, 429);
  assert.equal(limited.body, RATE_LIMITED);
  assert.equal(limited.headers['retry-after'], '3600');
  assert.equal((await deliver(api, ana, envelopeFor(ana, 'para ana'))).status, 200, 'each box has its own');
  assert.equal(stored(api, juan), 2);
});

test('per-box byte limit', async () => {
  const juan = mailbox('juan.perez');
  const max = envelopeLengthFor(10_000);
  const api = await apiWith([juan], { limits: { bytesPerBox: { limit: max, windowMs: 60_000 }, maxEnvelopeBytes: max } });
  assert.equal((await deliver(api, juan, envelopeFor(juan, 'g'.repeat(10_000)))).status, 200);
  assert.equal((await deliver(api, juan, envelopeFor(juan, 'más'), OTHER_IP)).status, 429);
  assert.equal(stored(api, juan), 1);
});

test('a full mailbox is 507, also checked before the body is accepted', async () => {
  const juan = mailbox('juan.perez');
  const api = await apiWith([juan], { quotaBytes: 2 * SMALL });
  assert.equal((await deliver(api, juan, envelopeFor(juan, 'uno'))).status, 200);
  assert.equal((await deliver(api, juan, envelopeFor(juan, 'dos'))).status, 200);
  const full = await deliver(api, juan, envelopeFor(juan, 'tres'));
  assert.equal(full.status, 507);
  assert.equal(full.body, '{"error":"mailbox_full"}');
  assert.equal(stored(api, juan), 2);
});

/** An upload that passed every check before its body and waits with part of it sent; `finish` sends the rest. */
async function halfSent(api: Api, address: TestAddress, envelope: Buffer) {
  const upload = await rawSocket(api, head(deliverPath(address), octets(envelope.length)));
  upload.socket.write(envelope.subarray(0, 100)); // as bytes: a string would be sent as UTF-8
  await delay(50);
  return { answer: upload.answer, finish: () => upload.socket.write(envelope.subarray(100)) };
}

test('the quota is checked again when storing: a box filled during an upload gets 507 (QuotaExceeded after hasRoomFor)', async () => {
  const juan = mailbox('juan.perez');
  const api = await apiWith([juan], { quotaBytes: SMALL });
  const slow = await halfSent(api, juan, envelopeFor(juan, 'llego tarde'));
  assert.equal((await deliver(api, juan, envelopeFor(juan, 'llego antes'), OTHER_IP)).status, 200, 'this one takes the last room');
  slow.finish();
  const answer = await slow.answer;
  assert.equal(answer.status, 507);
  assert.equal(answer.body, '{"error":"mailbox_full"}');
  assert.equal(stored(api, juan), 1);
  assert.deepEqual(api.logs, ['debug api: envelope delivered', 'debug api: delivery rejected (quota)']);
});

test('the per-box limits are checked again once the body is in: what others stored meanwhile counts', async () => {
  const juan = mailbox('juan.perez');
  const api = await apiWith([juan], { limits: { perBox: { limit: 1, windowMs: 3_600_000 } } });
  const slow = await halfSent(api, juan, envelopeFor(juan, 'llego tarde'));
  assert.equal((await deliver(api, juan, envelopeFor(juan, 'llego antes'), OTHER_IP)).status, 200);
  slow.finish();
  const answer = await slow.answer;
  assert.equal(answer.status, 429);
  assert.equal(answer.body, RATE_LIMITED);
  assert.equal(stored(api, juan), 1);
  assert.deepEqual(api.logs, ['debug api: envelope delivered', 'debug api: delivery rejected (box-limit)']);
});

test('a body that does not arrive in time is cut: nothing stored, slot freed', async () => {
  const juan = mailbox('juan.perez');
  const api = await apiWith([juan], { limits: { bodyTimeoutMs: 300, smallSlots: 1 } });
  const envelope = envelopeFor(juan, 'lento');
  const slow = await rawSocket(api, head(deliverPath(juan), octets(envelope.length)) + envelope.subarray(0, 100).toString('latin1'));
  await delay(50);
  const busy = await deliver(api, juan, envelopeFor(juan, 'mientras'), OTHER_IP);
  assert.equal(busy.status, 429, 'the only slot is taken');
  assert.equal(busy.body, '{"error":"busy"}');
  await once(slow.socket, 'close'); // the server cuts it
  assert.equal((await slow.answer).status, 0, 'and sends no answer');
  assert.equal(stored(api, juan), 0);
  assert.ok(api.logs.includes('debug api: delivery rejected (incomplete-body)'));
  assert.equal((await deliver(api, juan, envelope)).status, 200, 'the slot is free again');
});

test('a busy answer does not spend the per-IP attempts or bytes of the sender', async () => {
  const juan = mailbox('juan.perez');
  const api = await apiWith([juan], {
    limits: { smallSlots: 1, perIp: { limit: 1, windowMs: 60_000 }, bytesPerIp: { limit: SMALL, windowMs: 60_000 }, maxEnvelopeBytes: SMALL },
  });
  const envelope = envelopeFor(juan, 'ocupa el hueco');
  const stalled = await rawSocket(api, head(deliverPath(juan), octets(envelope.length)) + envelope.subarray(0, 10).toString('latin1'));
  await delay(50);
  for (let i = 0; i < 3; i++) assert.equal((await deliver(api, juan, envelopeFor(juan, 'espera'), OTHER_IP)).body, '{"error":"busy"}');
  stalled.socket.destroy();
  await delay(50);
  assert.equal((await deliver(api, juan, envelopeFor(juan, 'ahora sí'), OTHER_IP)).status, 200, 'its one attempt and its bytes were still there');
  const spent = await deliver(api, juan, envelopeFor(juan, 'y ya no'), OTHER_IP);
  assert.equal(spent.body, RATE_LIMITED, 'a stored delivery does count');
});

test('a client that drops mid-body frees its slot and stores nothing', async () => {
  const juan = mailbox('juan.perez');
  const api = await apiWith([juan], { limits: { smallSlots: 1 } });
  const envelope = envelopeFor(juan, 'cortado');
  const cut = await rawSocket(api, head(deliverPath(juan), octets(envelope.length)) + envelope.subarray(0, 1000).toString('latin1'));
  await delay(50);
  cut.socket.destroy();
  await delay(50);
  assert.equal(stored(api, juan), 0);
  assert.equal((await deliver(api, juan, envelope)).status, 200);
});

test('small, general and large slots: each size takes its own; each IP has its own number in flight', async () => {
  const juan = mailbox('juan.perez');
  const medium = envelopeLengthFor(5000); // 62 + 8 KiB
  const api = await apiWith([juan], { limits: { smallEnvelopeBytes: SMALL, largeEnvelopeBytes: medium, slots: 2, largeSlots: 1, inFlightPerIp: 1 } });
  const large = envelopeFor(juan, 'g'.repeat(10_000)); // 62 + 16 KiB: above the large threshold
  const stall = (envelope: Buffer, localAddress?: string) =>
    rawSocket(api, head(deliverPath(juan), octets(envelope.length)) + envelope.subarray(0, 10).toString('latin1'), localAddress);
  const stalledLarge = await stall(large);
  await delay(50);
  assert.equal((await deliver(api, juan, envelopeFor(juan, 'g'.repeat(10_000)), OTHER_IP)).body, '{"error":"busy"}', 'no large slot left');
  assert.equal((await deliver(api, juan, envelopeFor(juan, 'g'.repeat(5000)), OTHER_IP)).status, 200, 'one general slot left (at the large threshold)');
  assert.equal((await deliver(api, juan, envelopeFor(juan, 'misma IP'))).status, 429, 'the stalled IP already has one in flight');
  const stalledMedium = await stall(envelopeFor(juan, 'g'.repeat(5000)), OTHER_IP);
  await delay(50);
  assert.equal((await deliver(api, juan, envelopeFor(juan, 'g'.repeat(5000)), THIRD_IP)).body, '{"error":"busy"}', 'both general slots taken');
  assert.equal((await deliver(api, juan, envelopeFor(juan, 'pequeño'), THIRD_IP)).status, 200, 'a small one (at the threshold) still goes through');
  stalledLarge.socket.destroy();
  stalledMedium.socket.destroy();
  await delay(50);
  assert.equal((await deliver(api, juan, large, OTHER_IP)).status, 200, 'released on the cut');
  assert.equal((await deliver(api, juan, envelopeFor(juan, 'otra vez'))).status, 200);
});

test('uploads in flight group IPv6 by /56: another /64 of the same /56 waits, another /56 does not', async () => {
  const juan = mailbox('juan.perez');
  const api = await apiWith([juan], { limits: { inFlightPerIp: 1 }, override: (deps) => ({ ...deps, clientAddress: clientAddress(true) }) });
  const envelope = envelopeFor(juan, 'despacio');
  const stalled = await rawSocket(api, head(deliverPath(juan), { ...octets(envelope.length), 'X-Forwarded-For': '2001:db8:1:201::1' }));
  await delay(50);
  const from = (forwarded: string) => request(api, { path: deliverPath(juan), body: envelopeFor(juan, forwarded), headers: { 'X-Forwarded-For': forwarded } });
  assert.equal((await from('2001:db8:1:2ff::9')).body, '{"error":"busy"}', 'another /64, same /56');
  assert.equal((await from('2001:db8:1:301::1')).status, 200, 'another /56');
  stalled.socket.destroy();
  await delay(50);
  assert.equal((await from('2001:db8:1:2ff::9')).status, 200);
});

test('the body deadline grows with the declared length: a small envelope that never comes is cut within seconds', async () => {
  const juan = mailbox('juan.perez');
  // 4 KiB per second after a 100 ms grace: about 1.1 s for the smallest envelope, about 4.1 s for 62 + 16 KiB.
  const api = await apiWith([juan], { limits: { bodyGraceMs: 100, minUploadBytesPerSecond: 4096 } });
  const small = envelopeFor(juan, 'nunca llega');
  const larger = envelopeFor(juan, 'g'.repeat(10_000));
  const started = Date.now();
  const smallStall = await rawSocket(api, head(deliverPath(juan), octets(small.length)));
  const largerStall = await rawSocket(api, head(deliverPath(juan), octets(larger.length)), OTHER_IP);
  let largerClosed = false;
  largerStall.socket.once('close', () => { largerClosed = true; });
  assert.equal((await smallStall.answer).status, 0, 'cut with no answer');
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 900 && elapsed < 3000, `cut after ${elapsed} ms`);
  assert.equal(largerClosed, false, 'the larger declared body still has time');
  largerStall.socket.destroy();
  assert.equal(stored(api, juan), 0);
});

test('404 and 507 discard the body as one of the IP uploads in flight and under the upload deadline', async () => {
  const juan = mailbox('juan.perez');
  const stranger = mailbox('no.registrado');
  const api = await apiWith([juan], { quotaBytes: SMALL - 1, limits: { bodyGraceMs: 100, minUploadBytesPerSecond: 4096, inFlightPerIp: 1 } });
  const started = Date.now();
  const stalled = await rawSocket(api, head(deliverPath(stranger), octets(SMALL)));
  await delay(50);
  // The IP has no upload left in flight: the same answers, at once, without reading the body.
  const notFound = await headOnly(api, deliverPath(stranger), octets(SMALL));
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body, '{"error":"not_found"}');
  const full = await headOnly(api, deliverPath(juan), octets(SMALL));
  assert.equal(full.status, 507);
  assert.equal(full.body, '{"error":"mailbox_full"}');
  assert.equal((await deliver(api, juan, envelopeFor(juan, 'otra IP'), OTHER_IP)).status, 507, 'another IP still reads its answer after its body');

  assert.equal((await stalled.answer).status, 0, 'the body that never comes is cut with no answer');
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 900 && elapsed < 3000, `cut after ${elapsed} ms, not after bodyTimeoutMs`);
  assert.equal((await deliver(api, stranger, envelopeFor(juan, 'ahora sí'))).status, 404, 'its turn is free again');
});

test('bodyDeadlineMs: grace plus the declared length at the slowest rate, capped', () => {
  assert.equal(bodyDeadlineMs(DEFAULT_DELIVER_LIMITS, SMALL), 5000 + Math.ceil((SMALL * 1000) / 65_536));
  assert.equal(bodyDeadlineMs(DEFAULT_DELIVER_LIMITS, envelopeLengthFor(1024 * 1024 - 4)), 5000 + Math.ceil(((62 + 1024 * 1024) * 1000) / 65_536));
  assert.equal(bodyDeadlineMs(DEFAULT_DELIVER_LIMITS, MAX_ENVELOPE_LENGTH), 120_000, 'the cap');
});

test('a request pipelined after a delivery on the same connection is not served', async () => {
  const juan = mailbox('juan.perez');
  const api = await apiWith([juan]);
  const envelope = envelopeFor(juan, 'primero');
  const socket = net.connect(api.port, '127.0.0.1');
  socket.on('error', () => {});
  await once(socket, 'connect');
  const received: Buffer[] = [];
  socket.on('data', (chunk) => received.push(chunk));
  socket.write(Buffer.concat([
    Buffer.from(head(deliverPath(juan), octets(envelope.length)), 'latin1'), envelope,
    Buffer.from(head(deliverPath(juan), octets(envelope.length)), 'latin1'), envelope,
  ]));
  await once(socket, 'close');
  const text = Buffer.concat(received).toString('latin1');
  assert.equal(text.match(/^HTTP\/1\.1 /gm)?.length, 1, 'only the first one is answered');
  assert.equal(stored(api, juan), 1);
});

test('an internal failure while storing answers 500 with a fixed body, the detail does not leak', async () => {
  const juan = mailbox('juan.perez');
  const api = await apiWith([juan], {
    override: (deps) => ({
      ...deps,
      store: {
        list: () => ({ messages: [], next: 0 }), get: () => undefined, envelopeSize: () => undefined, hasRoomFor: () => true,
        deliver: () => { throw new Error('disk on fire: /secreto'); },
      },
    }),
  });
  const answer = await deliver(api, juan, envelopeFor(juan, 'hola'));
  assert.equal(answer.status, 500);
  assert.equal(answer.body, '{"error":"internal"}');
  assert.deepEqual(api.logs, ['warn api: internal error (Error)']);
  assert.equal((await request(api, { path: '/v1/time', method: 'GET' })).status, 200, 'the server is still up');
});

test('the default delivery limits, and inconsistent ones are refused', () => {
  assert.deepEqual(DEFAULT_DELIVER_LIMITS, {
    perIp: { limit: 60, windowMs: 3_600_000 },
    bytesPerIp: { limit: 256 * 1024 * 1024, windowMs: 3_600_000 },
    perBox: { limit: 120, windowMs: 3_600_000 },
    bytesPerBox: { limit: 40 * 1024 * 1024, windowMs: 3_600_000 },
    unknownBoxes: { limit: 10, windowMs: 60_000 },
    maxEnvelopeBytes: 62 + 32 * 1024 * 1024,
    smallEnvelopeBytes: 62 + 64 * 1024,
    smallSlots: 64,
    largeEnvelopeBytes: 1024 * 1024,
    slots: 8,
    largeSlots: 2,
    inFlightPerIp: 2,
    bodyGraceMs: 5000,
    minUploadBytesPerSecond: 64 * 1024,
    bodyTimeoutMs: 120_000,
  });
  assert.equal(DEFAULT_DELIVER_LIMITS.maxEnvelopeBytes, envelopeLengthFor(25 * 1024 * 1024), 'a 25 MiB message fits, as through SMTP');
  const { bytesPerBox } = DEFAULT_DELIVER_LIMITS;
  assert.ok(bytesPerBox.limit >= envelopeLengthFor(25 * 1024 * 1024), 'a box can still get a 25 MiB message every hour');
  assert.ok(DEFAULT_MAILBOX_QUOTA_BYTES / bytesPerBox.limit >= 7, 'filling an empty box quota takes at least 7 hours');
  const { smallSlots, smallEnvelopeBytes, slots, largeSlots, largeEnvelopeBytes, maxEnvelopeBytes } = DEFAULT_DELIVER_LIMITS;
  const uploadMemory = smallSlots * smallEnvelopeBytes + (slots - largeSlots) * largeEnvelopeBytes + largeSlots * maxEnvelopeBytes;
  assert.ok(uploadMemory < 80 * 1024 * 1024, `upload memory bounded: ${uploadMemory}`);
  for (const bad of [
    { maxEnvelopeBytes: MAX_ENVELOPE_LENGTH + 1 }, { maxEnvelopeBytes: SMALL - 1 }, { maxEnvelopeBytes: 1.5 },
    { bytesPerIp: { limit: MAX_ENVELOPE_LENGTH - 1, windowMs: 1000 } }, { bytesPerBox: { limit: 1000, windowMs: 1000 } },
    { bodyTimeoutMs: 0 }, { inFlightPerIp: 0 }, { largeEnvelopeBytes: -1 },
    { slots: 0 }, { slots: 1.5 }, { largeSlots: 0 }, { smallSlots: 0 }, { slots: 1, largeSlots: 2 }, { largeSlots: 9 },
    { smallEnvelopeBytes: 0 }, { smallEnvelopeBytes: 2 * 1024 * 1024 }, { bodyGraceMs: 0 }, { minUploadBytesPerSecond: -1 },
  ] as Partial<DeliverLimits>[]) {
    assert.throws(() => deliverLimitsOf(bad), RangeError, JSON.stringify(bad));
  }
  assert.equal(deliverLimitsOf({ slots: 3 }).slots, 3);
  assert.equal(deliverLimitsOf({ slots: 2, largeSlots: 2 }).largeSlots, 2, 'all general slots may be large ones');
});
