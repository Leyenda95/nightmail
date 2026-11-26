import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import {
  encodeAuthHeaders, envelopeLengthFor, type MailboxRequest, MemoryNonceStore, openMailbox, sealMailbox, signRequest,
} from '@nightmail/core-ts';
import { ResolutionIndex } from '@nightmail/midnight';
import { type ApiDeps, type ApiLimits, createApiServer, DEFAULT_API_LIMITS, parseRoute } from '../src/api/mailbox-api.ts';
import { MailboxStore } from '../src/mailbox/store.ts';
import { AddressDirectory } from '../src/registry/directory.ts';
import { MEMORY, openDatabase } from '../src/storage/db.ts';
import { alias, LOW_ORDER_AUTH_PK, LOW_ORDER_ENC_PK, mailbox, type TestAddress } from './mail-fixtures.ts';
import { capturingLogger } from './smtp-helpers.ts';

/** Host of the configured base URL: different from the one the client connects to (127.0.0.1:port). */
const HOST = 'mail.nightmail.test';
const T0 = 1_794_873_600; // seconds

type Api = {
  port: number; store: MailboxStore; logs: string[]; clock: { ms: number }; nonces: MemoryNonceStore; close(): Promise<void>;
};
type Answer = { status: number; headers: http.IncomingHttpHeaders; body: Buffer; json(): any };

const open: Api[] = [];
afterEach(async () => {
  for (const api of open.splice(0)) await api.close();
});

async function apiWith(addresses: TestAddress[], options: { limits?: Partial<ApiLimits>; startedAt?: number; override?: (deps: ApiDeps) => ApiDeps } = {}): Promise<Api> {
  const store = new MailboxStore(openDatabase(MEMORY));
  const index = new ResolutionIndex();
  index.addBlock(1, addresses.map((a) => a.entry));
  const logs: string[] = [];
  const clock = { ms: T0 * 1000 + 500 };
  const nonces = new MemoryNonceStore(options.startedAt ?? T0 - 10_000);
  const deps: ApiDeps = {
    host: HOST, directory: new AddressDirectory(index), store, nonceStore: nonces, log: capturingLogger(logs), now: () => clock.ms,
    ...(options.limits && { limits: options.limits }),
  };
  const server = createApiServer(options.override ? options.override(deps) : deps);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const api: Api = {
    port: (server.address() as AddressInfo).port, store, logs, clock, nonces,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
  open.push(api);
  return api;
}

function call(api: Api, path: string, headers: Record<string, string | string[]> = {}, method = 'GET'): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: api.port, path, method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode!, headers: res.headers, body, json: () => JSON.parse(body.toString('utf8')) });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

type Signing = Partial<MailboxRequest> & { secretKey?: Uint8Array };

/** Headers of a request signed by the holder of `address` (with any `overrides` applied). */
function signed(address: TestAddress, path: string, overrides: Signing = {}): Record<string, string> {
  const { secretKey = address.authSecretKey, ...fields } = overrides;
  const request: MailboxRequest = {
    host: HOST, version: 1, method: 'GET', path, addrKey: address.addrKey, timestamp: T0, nonce: new Uint8Array(randomBytes(16)), ...fields,
  };
  return encodeAuthHeaders({ timestamp: request.timestamp, nonce: request.nonce, signature: signRequest(secretKey, request) });
}

const listPath = (address: TestAddress, query = '') => `/v1/box/${address.entry.addrKey}/messages${query}`;
const messagePath = (address: TestAddress, id: string) => `/v1/box/${address.entry.addrKey}/messages/${id}`;

function deliver(api: Api, address: TestAddress, text: string): void {
  api.store.deliver([{ addrKey: address.addrKey, envelope: sealMailbox(Buffer.from(address.entry.encPk, 'hex'), Buffer.from(text)) }], T0);
}

const UNAUTHORIZED_BODY = '{"error":"unauthorized"}';

function assertUnauthorized(answer: Answer, why: string): void {
  assert.equal(answer.status, 401, why);
  assert.equal(answer.body.toString(), UNAUTHORIZED_BODY, why);
  assert.equal(answer.headers['cache-control'], 'no-store', why);
  assert.equal(answer.headers['www-authenticate'], 'NightMail-Signature', why);
  assert.ok(!Number.isNaN(Date.parse(answer.headers.date!)), `${why}: has Date`);
}

test('parseRoute: only the three routes, written exactly like this', () => {
  const key = 'ab'.repeat(32);
  const id = 'cd'.repeat(16);
  assert.deepEqual(parseRoute('/v1/time'), { kind: 'time' });
  assert.deepEqual(parseRoute(`/v1/box/${key}/messages`), { kind: 'list', addrKey: key, since: 0 });
  assert.deepEqual(parseRoute(`/v1/box/${key}/messages?since=0`), { kind: 'list', addrKey: key, since: 0 });
  assert.deepEqual(parseRoute(`/v1/box/${key}/messages?since=120`), { kind: 'list', addrKey: key, since: 120 });
  assert.deepEqual(parseRoute(`/v1/box/${key}/messages?since=${'9'.repeat(15)}`), { kind: 'list', addrKey: key, since: 999_999_999_999_999 });
  assert.deepEqual(parseRoute(`/v1/box/${key}/messages/${id}`), { kind: 'message', addrKey: key, id });
  const notRoutes = [
    undefined, '', '/', '/v1/time/', '/v1/time?x=1', '/V1/time', '/v2/time', 'http://host/v1/time', '//v1/time',
    `/v1/box/${key}`, `/v1/box/${key}/`, `/v1/box/${key}/messages/`, `/v1/box/${key}/messages?`,
    `/v1/box/${key}/messages?since=`, `/v1/box/${key}/messages?since=01`, `/v1/box/${key}/messages?since=-1`,
    `/v1/box/${key}/messages?since=1.5`, `/v1/box/${key}/messages?since=${'9'.repeat(16)}`,
    `/v1/box/${key}/messages?since=1&x=2`, `/v1/box/${key}/messages?x=2`, `/v1/box/${key}/messages#f`,
    `/v1/box/${key.toUpperCase()}/messages`, `/v1/box/${key.slice(2)}/messages`, `/v1/box/${key}00/messages`,
    `/v1/box/${key}/./messages`, `/v1/box/x/../${key}/messages`, `/v1/box/${key}/messages%2f${id}`,
    `/v1/box/${key}/messages/${id.toUpperCase()}`, `/v1/box/${key}/messages/${id}0`, `/v1/box/${key}/messages/${id}/`,
    `/v1/box/${key}/messages/${id}?since=0`, `x/v1/box/${key}/messages`, `/v1/box/${key}/messages\n`,
  ];
  for (const url of notRoutes) assert.equal(parseRoute(url), undefined, String(url));
});

test('GET /v1/time: the server time in seconds, unsigned and uncached', async () => {
  const api = await apiWith([]);
  const answer = await call(api, '/v1/time');
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.json(), { time: T0 });
  assert.equal(answer.headers['cache-control'], 'no-store');
  assert.equal(answer.headers['content-type'], 'application/json');
  api.clock.ms = (T0 + 1) * 1000 - 1;
  assert.deepEqual((await call(api, '/v1/time')).json(), { time: T0 }, 'rounded down, never up to the next second');
  api.clock.ms += 1;
  assert.deepEqual((await call(api, '/v1/time')).json(), { time: T0 + 1 });
});

test('a request signed by the owner lists its messages and downloads the encrypted envelope', async () => {
  const juan = mailbox('juan.perez');
  const nube = alias();
  const api = await apiWith([juan, nube]);
  deliver(api, juan, 'primero');
  deliver(api, juan, 'x'.repeat(5000));
  deliver(api, nube, 'para el alias');

  const list = await call(api, listPath(juan, '?since=0'), signed(juan, listPath(juan, '?since=0')));
  assert.equal(list.status, 200);
  assert.equal(list.headers['cache-control'], 'no-store');
  assert.equal(list.headers['content-type'], 'application/json');
  const { messages, next } = list.json();
  assert.equal(next, 2);
  assert.deepEqual(messages.map((m: any) => [m.size, m.receivedAt]), [[4096, T0], [8192, T0]]);
  assert.deepEqual(Object.keys(messages[0]).sort(), ['id', 'receivedAt', 'size']);

  const path = messagePath(juan, messages[0].id);
  const download = await call(api, path, signed(juan, path));
  assert.equal(download.status, 200);
  assert.equal(download.headers['content-type'], 'application/octet-stream');
  assert.equal(download.headers['cache-control'], 'no-store');
  assert.equal(download.headers['x-content-type-options'], 'nosniff');
  assert.equal(download.body.length, envelopeLengthFor(7));
  assert.equal(Number(download.headers['content-length']), envelopeLengthFor(7));
  assert.equal(Buffer.from(openMailbox(juan.encSecretKey, download.body)).toString(), 'primero');

  const forAlias = await call(api, listPath(nube), signed(nube, listPath(nube)));
  assert.equal(forAlias.json().messages.length, 1, 'an alias is a box like any other');
});

test('since pages by cursor and the page has a maximum size', async () => {
  const juan = mailbox('juan.perez');
  const api = await apiWith([juan], { limits: { pageSize: 2 } });
  for (let i = 0; i < 5; i++) deliver(api, juan, `mensaje ${i}`);
  const seen: string[] = [];
  let since = 0;
  for (let page = 0; page < 4; page++) {
    const path = listPath(juan, `?since=${since}`);
    const { messages, next } = (await call(api, path, signed(juan, path))).json();
    assert.ok(messages.length <= 2);
    seen.push(...messages.map((m: any) => m.id));
    since = next;
  }
  assert.equal(new Set(seen).size, 5);
  assert.equal(since, 5);
  assert.equal(DEFAULT_API_LIMITS.pageSize, 500);
});

test('every authentication rejection is the same 401, with Date', async () => {
  const juan = mailbox('juan.perez');
  const ana = mailbox('ana.garcia');
  const badAuth = mailbox('firma.mala', { authPk: LOW_ORDER_AUTH_PK });
  const badEnc = mailbox('cifrado.malo', { encPk: LOW_ORDER_ENC_PK });
  const stranger = mailbox('no.registrado');
  const api = await apiWith([juan, ana, badAuth, badEnc]);
  deliver(api, juan, 'secreto');
  const { messages } = (await call(api, listPath(juan), signed(juan, listPath(juan)))).json();
  const path = listPath(juan);
  const good = signed(juan, path);

  const cases: [string, string, Record<string, string | string[]>][] = [
    ['no headers', path, {}],
    ['no signature', path, { ...good, 'nightmail-signature': '' }],
    ['timestamp with leading zeros', path, { ...good, 'nightmail-timestamp': `0${T0}` }],
    ['uppercase nonce', path, { ...good, 'nightmail-nonce': good['nightmail-nonce']!.toUpperCase() }],
    ['repeated header', path, { ...good, 'nightmail-nonce': [good['nightmail-nonce']!, good['nightmail-nonce']!] }],
    ['tampered signature', path, { ...good, 'nightmail-signature': good['nightmail-signature']!.replace(/^../, (b) => (b === '00' ? '01' : '00')) }],
    ['signed with another key', path, signed(juan, path, { secretKey: ana.authSecretKey })],
    ['signed for another address', path, signed(ana, path)],
    ['signed by the owner of another address for her own', path, signed(juan, path, { addrKey: ana.addrKey, secretKey: ana.authSecretKey })],
    ['signed for another server', path, signed(juan, path, { host: 'otro.servidor.test' })],
    ['signed for the connection host instead of the configured one', path, signed(juan, path, { host: `127.0.0.1:${api.port}` })],
    ['signed for another method', path, signed(juan, path, { method: 'POST' })],
    ['signed for another version', path, signed(juan, path, { version: 2 })],
    ['signed for another route (another query)', listPath(juan, '?since=1'), signed(juan, listPath(juan, '?since=0'))],
    ['the signed list is not valid for a message', messagePath(juan, messages[0].id), signed(juan, path)],
    ['61 s in the past', path, signed(juan, path, { timestamp: T0 - 61 })],
    ['61 s in the future', path, signed(juan, path, { timestamp: T0 + 61 })],
    ['unregistered address', listPath(stranger), signed(stranger, listPath(stranger))],
    ['address with a low-order signing key', listPath(badAuth), signed(badAuth, listPath(badAuth))],
    ['address with an unusable encryption key', listPath(badEnc), signed(badEnc, listPath(badEnc))],
    ['message of an unregistered address', messagePath(stranger, messages[0].id), signed(stranger, messagePath(stranger, messages[0].id))],
  ];
  const answers: Answer[] = [];
  for (const [why, target, headers] of cases) {
    const answer = await call(api, target, headers);
    assertUnauthorized(answer, why);
    answers.push(answer);
  }
  const shape = (a: Answer) => JSON.stringify(Object.keys(a.headers).sort());
  assert.equal(new Set(answers.map(shape)).size, 1, 'same headers in all of them');
  assert.deepEqual([...new Set(api.logs)].sort(), [
    'debug api: unauthorized (bad-headers)', 'debug api: unauthorized (bad-signature)', 'debug api: unauthorized (stale)',
    'debug api: unauthorized (unknown-address)',
  ], 'the reason only goes to the debug log');
});

test('the time window is ±60 s, bounds included', async () => {
  const juan = mailbox('juan.perez');
  const api = await apiWith([juan]);
  const path = listPath(juan);
  for (const timestamp of [T0 - 60, T0 + 60]) {
    assert.equal((await call(api, path, signed(juan, path, { timestamp }))).status, 200, String(timestamp));
  }
});

test('a repeated request is rejected even while still inside the window, a new nonce is valid', async () => {
  const juan = mailbox('juan.perez');
  const api = await apiWith([juan]);
  const path = listPath(juan);
  const headers = signed(juan, path, { timestamp: T0 + 60 });
  assert.equal((await call(api, path, headers)).status, 200);
  assertUnauthorized(await call(api, path, headers), 'immediate replay');
  api.clock.ms += 119_000; // T0 + 119: the request (T0 + 60) is still inside the window, so its nonce is remembered
  assertUnauthorized(await call(api, path, headers), 'late replay');
  assert.ok(api.logs.includes('debug api: unauthorized (replay)'));
  assert.equal((await call(api, path, signed(juan, path, { timestamp: T0 + 100 }))).status, 200);
});

test('order window → signature → nonce: a badly signed request does not consume any nonce', async () => {
  const juan = mailbox('juan.perez');
  const ana = mailbox('ana.garcia');
  const api = await apiWith([juan, ana]);
  const path = listPath(juan);
  const nonce = new Uint8Array(randomBytes(16));
  assertUnauthorized(await call(api, path, signed(juan, path, { nonce, secretKey: ana.authSecretKey })), 'signature from another key');
  assertUnauthorized(await call(api, path, signed(juan, path, { nonce, timestamp: T0 - 61 })), 'old, correctly signed');
  assert.equal(api.nonces.size, 0, 'nothing stored yet');
  assert.equal((await call(api, path, signed(juan, path, { nonce }))).status, 200, 'the same nonce, now with the right signature');
  assert.equal(api.nonces.size, 1);
});

test('after a start, anything that could have been seen before is rejected (timestamp ≤ start + 60)', async () => {
  const juan = mailbox('juan.perez');
  const api = await apiWith([juan], { startedAt: T0 - 30 });
  const path = listPath(juan);
  assertUnauthorized(await call(api, path, signed(juan, path, { timestamp: T0 + 30 })), 'right at the limit');
  assert.equal((await call(api, path, signed(juan, path, { timestamp: T0 + 31 }))).status, 200);
});

test('the signed host is the configured one: the Host header plays no part', async () => {
  const juan = mailbox('juan.perez');
  const api = await apiWith([juan]);
  const path = listPath(juan);
  for (const hostHeader of ['evil.example', HOST, `127.0.0.1:${api.port}`]) {
    assert.equal((await call(api, path, { ...signed(juan, path), Host: hostHeader })).status, 200, hostHeader);
  }
  assertUnauthorized(await call(api, path, { ...signed(juan, path, { host: 'evil.example' }), Host: 'evil.example' }), 'signed for the Host header');
});

test('a route that is not exactly one of the three is 404, signed or not, another method is 405', async () => {
  const juan = mailbox('juan.perez');
  const api = await apiWith([juan]);
  const variants = [
    `/v1/box/${juan.entry.addrKey}/./messages`, `/v1/box/${juan.entry.addrKey}/messages?since=0&x=1`,
    `/v1/box/${juan.entry.addrKey.toUpperCase()}/messages`, `/v1/box/${juan.entry.addrKey}/messages/`, '/v1/nada', '/',
  ];
  for (const path of variants) {
    for (const headers of [{}, signed(juan, listPath(juan))]) {
      const answer = await call(api, path, headers);
      assert.equal(answer.status, 404, path);
      assert.equal(answer.body.toString(), '{"error":"not_found"}');
      assert.equal(answer.headers['cache-control'], 'no-store');
    }
  }
  for (const [path, headers] of [['/v1/time', {}], [listPath(juan), signed(juan, listPath(juan), { method: 'POST' })]] as const) {
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
      const answer = await call(api, path, headers, method);
      assert.equal(answer.status, 405, `${method} ${path}`);
      assert.equal(answer.headers.allow, 'GET');
      assert.equal(answer.headers['cache-control'], 'no-store');
      if (method !== 'HEAD') assert.equal(answer.body.toString(), '{"error":"method_not_allowed"}');
    }
  }
});

test('a message that does not exist, or belongs to another box, is 404 only for an authenticated caller', async () => {
  const juan = mailbox('juan.perez');
  const ana = mailbox('ana.garcia');
  const api = await apiWith([juan, ana]);
  deliver(api, ana, 'de ana');
  const anaPath = listPath(ana);
  const [{ id }] = (await call(api, anaPath, signed(ana, anaPath))).json().messages;
  const foreign = messagePath(juan, id);
  const unknown = messagePath(juan, 'ab'.repeat(16));
  for (const path of [foreign, unknown]) {
    const answer = await call(api, path, signed(juan, path));
    assert.equal(answer.status, 404, path);
    assert.equal(answer.body.toString(), '{"error":"not_found"}');
    assertUnauthorized(await call(api, path), 'without authentication it does not tell whether it exists');
  }
  assert.equal((await call(api, messagePath(ana, id), signed(ana, messagePath(ana, id)))).status, 200);
});

test('per-address limit: counts only authenticated requests, so nobody else can exhaust it', async () => {
  const juan = mailbox('juan.perez');
  const ana = mailbox('ana.garcia');
  const api = await apiWith([juan, ana], { limits: { perAddress: { limit: 3, windowMs: 60_000 } } });
  const path = listPath(juan);
  for (let i = 0; i < 20; i++) assertUnauthorized(await call(api, path), 'a stranger insisting');
  for (let i = 0; i < 3; i++) assert.equal((await call(api, path, signed(juan, path))).status, 200, 'the owner still gets in');
  const limited = await call(api, path, signed(juan, path));
  assert.equal(limited.status, 429);
  assert.equal(limited.body.toString(), '{"error":"rate_limited"}');
  assert.equal(limited.headers['retry-after'], '60');
  assert.equal(limited.headers['cache-control'], 'no-store');
  assert.equal((await call(api, listPath(ana), signed(ana, listPath(ana)))).status, 200, 'each address has its own limit');
  api.clock.ms += 60_000;
  assert.equal((await call(api, path, signed(juan, path, { timestamp: T0 + 60 }))).status, 200, 'after the window, it gets in again');
});

test('per-IP limit: applied before authentication, also to /v1/time', async () => {
  const juan = mailbox('juan.perez');
  const api = await apiWith([juan], { limits: { perIp: { limit: 4, windowMs: 30_000 } } });
  const path = listPath(juan);
  assert.equal((await call(api, '/v1/time')).status, 200);
  assert.equal((await call(api, path, signed(juan, path))).status, 200);
  assertUnauthorized(await call(api, path), 'no signature');
  assert.equal((await call(api, '/v1/nada')).status, 404);
  for (const [target, headers] of [['/v1/time', {}], [path, signed(juan, path)], ['/v1/nada', {}]] as const) {
    const answer = await call(api, target, headers);
    assert.equal(answer.status, 429, target);
    assert.equal(answer.headers['retry-after'], '30');
  }
});

test('an internal failure answers 500 with a fixed body, the detail does not leak', async () => {
  const juan = mailbox('juan.perez');
  const api = await apiWith([juan], {
    override: (deps) => ({
      ...deps,
      store: {
        list: () => { throw new Error('disk on fire: /secreto'); }, get: () => undefined, envelopeSize: () => undefined,
        deliver: () => {}, hasRoomFor: () => true,
      },
    }),
  });
  const path = listPath(juan);
  const answer = await call(api, path, signed(juan, path));
  assert.equal(answer.status, 500);
  assert.equal(answer.body.toString(), '{"error":"internal"}');
  assert.equal(answer.headers['cache-control'], 'no-store');
  assert.deepEqual(api.logs, ['warn api: internal error (Error)']);
  assert.equal((await call(api, '/v1/time')).status, 200, 'the server is still up');
});

test('the logs carry no addresses, signatures or nonces', async () => {
  const juan = mailbox('juan.perez');
  const api = await apiWith([juan]);
  const path = listPath(juan);
  const headers = signed(juan, path);
  await call(api, path, headers);
  await call(api, path, headers);
  await call(api, path, { ...headers, 'nightmail-signature': 'ab'.repeat(64) });
  const logs = api.logs.join('\n');
  for (const secret of [juan.entry.addrKey, headers['nightmail-nonce']!, headers['nightmail-signature']!, 'ab'.repeat(64)]) {
    assert.equal(logs.includes(secret), false);
  }
  assert.ok(api.logs.length >= 2);
});

test('a request body is ignored', async () => {
  const juan = mailbox('juan.perez');
  const api = await apiWith([juan]);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const once = () => new Promise<number>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: api.port, path: '/v1/time', method: 'GET', agent, headers: { 'content-length': 5 } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode!));
    });
    req.on('error', reject);
    req.end('hola!');
  });
  assert.deepEqual([await once(), await once()], [200, 200]);
  agent.destroy();
});

/** A client that requests an envelope and never reads the response (paused socket: the server keeps writing). */
async function stalledDownload(api: Api, path: string, headers: Record<string, string>): Promise<net.Socket> {
  const socket = net.connect(api.port, '127.0.0.1');
  socket.pause();
  socket.on('error', () => {});
  await once(socket, 'connect');
  socket.write([`GET ${path} HTTP/1.1`, 'Host: 127.0.0.1', ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', ''].join('\r\n'));
  await new Promise((resolve) => setTimeout(resolve, 150));
  return socket;
}

test('each response closes the connection: two addresses cannot share one', async () => {
  const juan = mailbox('juan.perez');
  const api = await apiWith([juan]);
  const path = listPath(juan);
  for (const answer of [await call(api, '/v1/time'), await call(api, path, signed(juan, path)), await call(api, '/v1/nada')]) {
    assert.equal(answer.headers.connection, 'close');
  }
});

test('a large envelope takes a slot while it is sent: with no slot 429, small ones do not need one, on a cut it is released', async () => {
  const juan = mailbox('juan.perez');
  const api = await apiWith([juan], { limits: { largeDownloadBytes: envelopeLengthFor(0), largeDownloadSlots: 1 } }); // the small one is exactly at the threshold
  deliver(api, juan, 'g'.repeat(20 * 1024 * 1024));
  deliver(api, juan, 'pequeño');
  const [big, small] = api.store.list(juan.addrKey, 0, 10).messages;
  const bigPath = messagePath(juan, big!.id);
  const stalled = await stalledDownload(api, bigPath, signed(juan, bigPath));

  const busy = await call(api, bigPath, signed(juan, bigPath));
  assert.equal(busy.status, 429);
  assert.equal(busy.body.toString(), '{"error":"busy"}');
  assert.equal(busy.headers['retry-after'], '1');
  const smallPath = messagePath(juan, small!.id);
  assert.equal((await call(api, smallPath, signed(juan, smallPath))).status, 200, 'a small one does not need a slot');

  stalled.destroy();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const answer = await call(api, bigPath, signed(juan, bigPath));
  assert.equal(answer.status, 200);
  assert.equal(answer.body.length, envelopeLengthFor(20 * 1024 * 1024));
  assert.equal((await call(api, bigPath, signed(juan, bigPath))).status, 200, 'and after a complete download it is free too');
});

test('a response that does not finish sending in time is cut and releases the slot', async () => {
  const juan = mailbox('juan.perez');
  const api = await apiWith([juan], { limits: { largeDownloadBytes: 1024 * 1024, largeDownloadSlots: 1, responseTimeoutMs: 400 } });
  deliver(api, juan, 'g'.repeat(20 * 1024 * 1024));
  const [big] = api.store.list(juan.addrKey, 0, 10).messages;
  const bigPath = messagePath(juan, big!.id);
  const stalled = await stalledDownload(api, bigPath, signed(juan, bigPath));
  assert.equal((await call(api, bigPath, signed(juan, bigPath))).status, 429);
  await new Promise((resolve) => setTimeout(resolve, 600)); // the server cuts off the client that does not read
  assert.equal((await call(api, bigPath, signed(juan, bigPath))).status, 200);
  stalled.destroy();
});

test('the default large download limit: 4 slots from 1 MiB, and 2 min to send', () => {
  assert.equal(DEFAULT_API_LIMITS.largeDownloadBytes, 1024 * 1024);
  assert.equal(DEFAULT_API_LIMITS.largeDownloadSlots, 4);
  assert.equal(DEFAULT_API_LIMITS.responseTimeoutMs, 120_000);
});

test('past maxConnections open connections, a new one is dropped at once; 512 by default', async () => {
  assert.equal(DEFAULT_API_LIMITS.maxConnections, 512);
  for (const maxConnections of [0, -1, 1.5]) {
    assert.throws(() => createApiServer({ ...({} as ApiDeps), limits: { maxConnections } }), RangeError, String(maxConnections));
  }
  const api = await apiWith([], { limits: { maxConnections: 2 } });
  const idle = async () => {
    const socket = net.connect(api.port, '127.0.0.1');
    socket.on('error', () => {});
    await once(socket, 'connect');
    return socket;
  };
  const held = [await idle(), await idle()];
  await new Promise((resolve) => setTimeout(resolve, 50));
  const third = await idle();
  await once(third, 'close'); // dropped by the server without an answer
  for (const socket of held) socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await call(api, '/v1/time')).status, 200, 'room again once they close');
});

test('a request chained after another on the same connection (pipelining) is neither served nor holds a slot', async () => {
  const juan = mailbox('juan.perez');
  const api = await apiWith([juan], { limits: { largeDownloadBytes: 1024 * 1024, largeDownloadSlots: 1, responseTimeoutMs: 200 } });
  deliver(api, juan, 'g'.repeat(2 * 1024 * 1024));
  const [big] = api.store.list(juan.addrKey, 0, 10).messages;
  const bigPath = messagePath(juan, big!.id);
  for (let i = 0; i < 3; i++) {
    const socket = net.connect(api.port, '127.0.0.1');
    socket.on('error', () => {});
    await once(socket, 'connect');
    const request = (path: string, headers: Record<string, string>) =>
      [`GET ${path} HTTP/1.1`, 'Host: 127.0.0.1', ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', ''].join('\r\n');
    const received: Buffer[] = [];
    socket.on('data', (chunk) => received.push(chunk));
    socket.write(request('/v1/time', {}) + request(bigPath, signed(juan, bigPath)));
    await once(socket, 'close');
    const text = Buffer.concat(received).toString('latin1');
    assert.equal(text.match(/^HTTP\/1\.1 /gm)?.length, 1, 'only the first one is answered');
  }
  await new Promise((resolve) => setTimeout(resolve, 300)); // past the deadline of any response
  assert.equal((await call(api, bigPath, signed(juan, bigPath))).status, 200, 'the slot is still free');
});
