// Relayer public API: routes, strict JSON, error codes and headers, against a test double of the service.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRelayerServer, DEFAULT_RELAYER_API_LIMITS, type RelayerApiDeps } from '../src/relayer/relayer-api.ts';
import type { SubmitResult, TicketStatus } from '../src/relayer/relayer.ts';
import { capturingLogger } from './smtp-helpers.ts';

const TICKET = '0f'.repeat(16);
type Answer = { status: number; headers: http.IncomingHttpHeaders; body: any };

async function start(t: TestContext, submit: (tx: string, key: string) => SubmitResult = () => ({ ticket: TICKET }), over: Partial<RelayerApiDeps> = {}) {
  const logs: string[] = [];
  const submitted: { tx: string; key: string }[] = [];
  const relayer = {
    submit: (tx: string, key: string) => { submitted.push({ tx, key }); return submit(tx, key); },
    status: (ticket: string): TicketStatus | undefined =>
      ticket === TICKET ? { state: 'done', outcome: 'included', txHash: 'f1' } : ticket === '11'.repeat(16) ? { state: 'queued' } : undefined,
  };
  const server = createRelayerServer({ relayer, log: capturingLogger(logs), ...over });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
  return { port: (server.address() as AddressInfo).port, logs, submitted };
}

function call(port: number, method: string, path: string, body?: string | object, headers: Record<string, string> = {}): Promise<Answer> {
  const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { ...(payload !== undefined && { 'Content-Type': 'application/json' }), ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode!, headers: res.headers, body: text ? JSON.parse(text) : undefined });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('POST /v1/relay: 202 with the ticket, the response closes the connection and is not cached', async (t) => {
  const s = await start(t);
  const a = await call(s.port, 'POST', '/v1/relay', { tx: 'aa01' });
  assert.equal(a.status, 202);
  assert.deepEqual(a.body, { ticket: TICKET });
  assert.equal(a.headers['connection'], 'close');
  assert.equal(a.headers['cache-control'], 'no-store');
  assert.equal(s.submitted[0]!.tx, 'aa01');
});

test('POST /v1/relay/status: done, queued and 404 not-found', async (t) => {
  const s = await start(t);
  const done = await call(s.port, 'POST', '/v1/relay/status', { ticket: TICKET });
  assert.deepEqual([done.status, done.body], [200, { state: 'done', outcome: 'included', txHash: 'f1' }]);
  assert.deepEqual((await call(s.port, 'POST', '/v1/relay/status', { ticket: '11'.repeat(16) })).body, { state: 'queued' });
  const missing = await call(s.port, 'POST', '/v1/relay/status', { ticket: '22'.repeat(16) });
  assert.deepEqual([missing.status, missing.body], [404, { error: 'not-found' }]);
});

test('service errors → 422 invalid-tx / not-relayable {reason}, 429 and 503 with Retry-After, 400, 409 duplicate', async (t) => {
  const results: SubmitResult[] = [
    { error: 'invalid-tx' }, { error: 'not-relayable', reason: 'wrong-circuit' },
    { error: 'rate-limited', retryAfterS: 3600 }, { error: 'busy', retryAfterS: 60 }, { error: 'bad-request' },
    { error: 'duplicate' },
  ];
  let i = 0;
  const s = await start(t, () => results[i++]!);
  const answers = [];
  for (let n = 0; n < results.length; n++) answers.push(await call(s.port, 'POST', '/v1/relay', { tx: 'aa' }));
  assert.deepEqual(answers.map((a) => a.status), [422, 422, 429, 503, 400, 409]);
  assert.deepEqual(answers[5]!.body, { error: 'duplicate' });
  assert.deepEqual(answers[0]!.body, { error: 'invalid-tx' });
  assert.deepEqual(answers[1]!.body, { error: 'not-relayable', reason: 'wrong-circuit' });
  assert.deepEqual(answers[2]!.body, { error: 'rate-limited', retryAfterS: 3600 });
  assert.equal(answers[2]!.headers['retry-after'], '3600');
  assert.equal(answers[3]!.headers['retry-after'], '60');
});

test('strict JSON: extra or missing fields, types and malformed ticket → 400, the service is not called', async (t) => {
  const s = await start(t);
  const bodies = [{}, { tx: 5 }, { tx: 'aa', extra: 1 }, { Tx: 'aa' }, [], 'nope'];
  for (const body of bodies) assert.equal((await call(s.port, 'POST', '/v1/relay', typeof body === 'string' ? body : JSON.stringify(body))).status, 400, JSON.stringify(body));
  for (const body of [{}, { ticket: 5 }, { ticket: 'XYZ' }, { ticket: TICKET, x: 1 }, { ticket: TICKET.toUpperCase() }]) {
    assert.equal((await call(s.port, 'POST', '/v1/relay/status', body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(s.submitted, []);
});

test('415 without JSON, 413 with a large body (32 KiB of hex fits), 405 and 404', async (t) => {
  const s = await start(t);
  assert.equal((await call(s.port, 'POST', '/v1/relay', 'tx=aa', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal(DEFAULT_RELAYER_API_LIMITS.maxBodyBytes, 65 * 1024);
  const big = await call(s.port, 'POST', '/v1/relay', { tx: 'aa'.repeat(32 * 1024) });
  assert.equal(big.status, 202);
  assert.equal((await call(s.port, 'POST', '/v1/relay', { tx: 'aa'.repeat(DEFAULT_RELAYER_API_LIMITS.maxBodyBytes) })).status, 413);
  const get = await call(s.port, 'GET', '/v1/relay');
  assert.equal(get.status, 405);
  assert.equal(get.headers['allow'], 'POST');
  assert.equal((await call(s.port, 'POST', '/v1/nada', {})).status, 404);
});

test('per-client request limit → 429 with Retry-After, the key comes from clientKey', async (t) => {
  const s = await start(t, undefined, { limits: { perIpAll: { limit: 2, windowMs: 60_000 } }, clientKey: () => 'cliente-x' });
  await call(s.port, 'POST', '/v1/relay', { tx: 'aa' });
  await call(s.port, 'POST', '/v1/relay/status', { ticket: TICKET });
  const third = await call(s.port, 'POST', '/v1/relay', { tx: 'aa' });
  assert.equal(third.status, 429);
  assert.equal(third.headers['retry-after'], '60');
  assert.equal(s.submitted[0]!.key, 'cliente-x');
});

test('an internal failure → fixed 500 and a warn with only the error class', async (t) => {
  const s = await start(t, () => { throw new TypeError('secreto 203.0.113.9'); });
  const a = await call(s.port, 'POST', '/v1/relay', { tx: 'aa' });
  assert.deepEqual([a.status, a.body], [500, { error: 'internal' }]);
  assert.deepEqual(s.logs, ['warn relayer-api: internal error (TypeError)']);
});

test('the default limit key is the socket IP: X-Forwarded-For is ignored (without a trusted proxy)', async (t) => {
  const s = await start(t);
  await call(s.port, 'POST', '/v1/relay', { tx: 'aa' }, { 'X-Forwarded-For': '198.51.100.7' });
  assert.match(s.submitted[0]!.key, /^(127\.0\.0\.1|::1)$/);
});

test('server maxConnections: the one from limits (also 0) or the default 256', async (t) => {
  const relayer = { submit: () => ({ ticket: TICKET }) as SubmitResult, status: () => undefined };
  assert.equal(createRelayerServer({ relayer, log: capturingLogger([]) }).maxConnections, 256);
  assert.equal(createRelayerServer({ relayer, log: capturingLogger([]), limits: { maxConnections: 7 } }).maxConnections, 7);
  assert.equal(createRelayerServer({ relayer, log: capturingLogger([]), limits: { maxConnections: 0 } }).maxConnections, 0);
  t.diagnostic('servers not listening: nothing to close');
});
