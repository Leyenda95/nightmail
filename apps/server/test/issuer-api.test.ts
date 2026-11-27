import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPublicKey, verify } from 'node:crypto';
import { createIssuerServer, DEFAULT_ISSUER_LIMITS, type IssuerApiDeps } from '../src/issuer/issuer-api.ts';
import { Issuer } from '../src/issuer/issuer.ts';
import type { IssueOutcome, PayerClient } from '../src/issuer/payer-client.ts';
import { createReceiptSigner, receiptMessage, SPKI_PREFIX } from '../src/issuer/receipt.ts';
import { IssuerStore } from '../src/issuer/store.ts';
import { MEMORY, openDatabase } from '../src/storage/db.ts';
import { capturingLogger } from './smtp-helpers.ts';

const ID = '1a'.repeat(32);
const CONTRACT = 'c0'.repeat(32);
const CAPTCHA = 'captcha-secret-token';
const CARD = 'tok_secret_card';

type Answer = { status: number; headers: http.IncomingHttpHeaders; body: any };

/** Short waits (backoff) resolve immediately; long ones (an hour-long retryAfterS) wait until shutdown. */
const quickSleep = async (ms: number, signal: AbortSignal) => {
  if (ms >= 2_000_000) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
};

async function start(t: TestContext, over: Partial<IssuerApiDeps> = {}, outcomes: IssueOutcome[] = [{ status: 'issued' }]) {
  const logs: string[] = [];
  const log = capturingLogger(logs);
  const signer = createReceiptSigner(Buffer.alloc(32, 9), CONTRACT);
  const calls: string[] = [];
  const payer: PayerClient = {
    issue: async (id) => {
      calls.push(id);
      return outcomes[Math.min(calls.length - 1, outcomes.length - 1)]!;
    },
  };
  const issuer = new Issuer({ store: new IssuerStore(openDatabase(MEMORY)), payer, signer, log, delayMs: () => 0, sleep: quickSleep });
  const checks = { captcha: vi(CAPTCHA), card: vi(CARD) };
  const server = createIssuerServer({ issuer, signer, checks, log, ...over });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    await issuer.close();
  });
  return { port: (server.address() as AddressInfo).port, logs, issuer, signer, calls, checks, server };
}

function vi(expected: string) {
  const seen: string[] = [];
  return Object.assign((token: string) => { seen.push(token); return token === expected; }, { seen });
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

const free = (id = ID, captchaToken = CAPTCHA) => ({ id, captchaToken });
const fiat = (id = ID, cardToken = CARD) => ({ id, cardToken });
const status = (port: number, id = ID) => call(port, 'POST', '/v1/bono/status', { id });
const ids = (n: number) => Array.from({ length: n }, (_, i) => (i + 1).toString(16).padStart(2, '0').repeat(32));

test('POST free: returns the signed v2 receipt (contract and period included), which verifies, status returns the same and ends up issued', async (t) => {
  const s = await start(t);
  const a = await call(s.port, 'POST', '/v1/bono/free', free());
  assert.equal(a.status, 200);
  assert.equal(a.headers['connection'], 'close');
  assert.equal(a.headers['cache-control'], 'no-store');
  const { receipt } = a.body;
  assert.equal(a.body.id, ID);
  assert.equal(a.body.plan, 'free');
  assert.equal(receipt.contract, CONTRACT);
  assert.equal(receipt.period, 'none');
  const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(receipt.publicKey, 'hex')]), format: 'der', type: 'spki' });
  const message = receiptMessage({ contract: receipt.contract, id: ID, plan: 'free', period: receipt.period, insertBy: BigInt(receipt.insertBy) });
  assert.equal(verify(null, message, key, Buffer.from(receipt.signature, 'hex')), true);
  const g = await status(s.port);
  assert.equal(g.status, 200);
  assert.deepEqual(g.body.receipt, receipt);
  await s.issuer.idle();
  assert.equal((await status(s.port)).body.state, 'issued');
});

test('repeated POST with the same id: same receipt, no CAPTCHA or limit', async (t) => {
  const s = await start(t);
  const first = await call(s.port, 'POST', '/v1/bono/free', free());
  for (let i = 0; i < 6; i++) {
    const again = await call(s.port, 'POST', '/v1/bono/free', free(ID, 'ya-no-importa'));
    assert.equal(again.status, 200);
    assert.deepEqual(again.body.receipt, first.body.receipt);
  }
  assert.deepEqual(s.checks.captcha.seen, [CAPTCHA]);
  await s.issuer.idle();
  assert.equal(s.calls.length, 1);
});

test('wrong CAPTCHA or card: 403 / 402, nothing is created, no quota is spent, and the tokens are not logged', async (t) => {
  const s = await start(t, { limits: { freePerIp: { limit: 1, windowMs: 60_000 } } });
  for (let i = 0; i < 3; i++) {
    const r = await call(s.port, 'POST', '/v1/bono/free', free(ID, 'malo'));
    assert.deepEqual([r.status, r.body], [403, { error: 'captcha_failed' }]);
  }
  const card = await call(s.port, 'POST', '/v1/bono/fiat', fiat(ID, 'malo'));
  assert.deepEqual([card.status, card.body], [402, { error: 'payment_failed' }]);
  assert.equal(s.issuer.lookup(ID), undefined);
  assert.equal((await call(s.port, 'POST', '/v1/bono/free', free())).status, 200, 'the rejections did not spend the quota');
  const text = s.logs.join('\n');
  assert.ok(!text.includes('malo') && !text.includes('127.0.0.1') && !text.includes(CAPTCHA));
});

test('POST fiat: issues the paid plan (Night Plus) without a period, the receipt carries none', async (t) => {
  const s = await start(t);
  const r = await call(s.port, 'POST', '/v1/bono/fiat', fiat());
  assert.equal(r.status, 200);
  assert.equal(r.body.plan, 'paid');
  assert.equal(r.body.receipt.period, 'none');
  assert.equal(s.issuer.lookup(ID)?.period, null);
});

test('POST fiat from an older client: its period is accepted and ignored', async (t) => {
  const s = await start(t);
  const r = await call(s.port, 'POST', '/v1/bono/fiat', { ...fiat(), period: 'annual' });
  assert.equal(r.status, 200);
  assert.equal(r.body.receipt.period, 'none');
  assert.equal(s.issuer.lookup(ID)?.period, null);
});

test('the same id with the other plan is 409 id_conflict', async (t) => {
  const s = await start(t);
  await call(s.port, 'POST', '/v1/bono/free', free());
  const r = await call(s.port, 'POST', '/v1/bono/fiat', fiat());
  assert.deepEqual([r.status, r.body], [409, { error: 'id_conflict' }]);
});

test('invalid bodies: 400 with the fixed error', async (t) => {
  const s = await start(t);
  const bad: Array<[string, unknown]> = [
    ['/v1/bono/free', { id: ID }],
    ['/v1/bono/free', { ...free(), extra: 'x' }],
    ['/v1/bono/free', { id: ID.toUpperCase(), captchaToken: CAPTCHA }],
    ['/v1/bono/free', { id: ID.slice(2), captchaToken: CAPTCHA }],
    ['/v1/bono/free', { id: ID, captchaToken: 5 }],
    ['/v1/bono/fiat', { ...fiat(), period: 'weekly' }],
    ['/v1/bono/fiat', { ...fiat(), period: 5 }],
    ['/v1/bono/fiat', { id: ID, period: 'monthly' }],
    ['/v1/bono/free', '[]'],
    ['/v1/bono/free', 'null'],
    ['/v1/bono/free', '{no es json'],
    ['/v1/bono/status', {}],
    ['/v1/bono/status', { id: ID, extra: 'x' }],
    ['/v1/bono/status', { id: ID.toUpperCase() }],
    ['/v1/bono/status', { id: 7 }],
  ];
  for (const [path, body] of bad) {
    const r = await call(s.port, 'POST', path, body as string | object);
    assert.deepEqual([r.status, r.body], [400, { error: 'bad_request' }], JSON.stringify(body));
  }
  assert.equal(s.checks.captcha.seen.length, 0);
});

test('Content-Type other than JSON: 415, body over 4 KiB: 413', async (t) => {
  const s = await start(t);
  const wrong = await call(s.port, 'POST', '/v1/bono/free', 'x', { 'Content-Type': 'text/plain' });
  assert.equal(wrong.status, 415);
  const big = await call(s.port, 'POST', '/v1/bono/free', JSON.stringify({ id: ID, captchaToken: 'a'.repeat(5000) }));
  assert.deepEqual([big.status, big.body], [413, { error: 'payload_too_large' }]);
});

test('routes: the id is no longer in the URL, 404 for anything not exact, 405 (Allow: POST) for another method', async (t) => {
  const s = await start(t);
  for (const p of ['/', '/v1/bono', '/v1/bono/free/', '/v1/bono/free?x=1', `/v1/bono/${ID}`, '/v1/bono/status/', `/v1/bono/status?id=${ID}`]) {
    const r = await call(s.port, 'GET', p);
    assert.deepEqual([r.status, r.body], [404, { error: 'not_found' }], p);
  }
  for (const [method, p] of [['GET', '/v1/bono/free'], ['GET', '/v1/bono/status'], ['DELETE', '/v1/bono/fiat']]) {
    const r = await call(s.port, method!, p!);
    assert.deepEqual([r.status, r.headers['allow']], [405, 'POST'], `${method} ${p}`);
  }
});

test('status of an unknown id: 404', async (t) => {
  const s = await start(t);
  const r = await status(s.port);
  assert.deepEqual([r.status, r.body], [404, { error: 'not_found' }]);
});

test('default limits: global 100/h, per IP 3/day on free and a separate 3/day on paid, 100 pending', () => {
  assert.deepEqual(DEFAULT_ISSUER_LIMITS.global, { limit: 100, windowMs: 3_600_000 });
  assert.deepEqual(DEFAULT_ISSUER_LIMITS.freePerIp, { limit: 3, windowMs: 86_400_000 });
  assert.deepEqual(DEFAULT_ISSUER_LIMITS.paidPerIp, { limit: 3, windowMs: 86_400_000 });
  assert.equal(DEFAULT_ISSUER_LIMITS.maxPending, 100);
  assert.equal(DEFAULT_ISSUER_LIMITS.maxConnections, 256);
});

test('the server caps simultaneous connections', async (t) => {
  const s = await start(t, { limits: { maxConnections: 7 } });
  assert.equal(s.server.maxConnections, 7);
});

test('free plan limit per IP: the next one is 429 with Retry-After, paid has its own counter', async (t) => {
  const s = await start(t, { limits: { freePerIp: { limit: 3, windowMs: 86_400_000 } } });
  const [a, b, c, d, e] = ids(5);
  for (const id of [a, b, c]) assert.equal((await call(s.port, 'POST', '/v1/bono/free', free(id))).status, 200);
  const r = await call(s.port, 'POST', '/v1/bono/free', free(d));
  assert.deepEqual([r.status, r.body, r.headers['retry-after']], [429, { error: 'rate_limited' }, '86400']);
  assert.equal(s.issuer.lookup(d!), undefined);
  assert.equal((await call(s.port, 'POST', '/v1/bono/fiat', fiat(e))).status, 200);
});

test('paid plan limit per IP (the demo token is public): 429, free is not affected', async (t) => {
  const s = await start(t, { limits: { paidPerIp: { limit: 2, windowMs: 86_400_000 } } });
  const [a, b, c, d] = ids(4);
  for (const id of [a, b]) assert.equal((await call(s.port, 'POST', '/v1/bono/fiat', fiat(id))).status, 200);
  const r = await call(s.port, 'POST', '/v1/bono/fiat', fiat(c));
  assert.deepEqual([r.status, r.body, r.headers['retry-after']], [429, { error: 'rate_limited' }, '86400']);
  assert.equal(s.issuer.lookup(c!), undefined);
  assert.equal((await call(s.port, 'POST', '/v1/bono/free', free(d))).status, 200);
});

test('global limit: counts paid and free, and a global rejection does not spend the IP quota', async (t) => {
  const s = await start(t, { limits: { global: { limit: 2, windowMs: 60_000 }, freePerIp: { limit: 2, windowMs: 60_000 } } });
  const [a, b, c] = ids(3);
  assert.equal((await call(s.port, 'POST', '/v1/bono/free', free(a))).status, 200);
  assert.equal((await call(s.port, 'POST', '/v1/bono/fiat', fiat(b))).status, 200);
  assert.equal((await call(s.port, 'POST', '/v1/bono/free', free(c))).status, 429);
});

test('too many pending: 503 busy with retryAfterS BEFORE signing a receipt, charging or spending quota, an already known id still sees its own', async (t) => {
  const s = await start(t, { limits: { maxPending: 2, busyRetryAfterS: 120 } }, [{ status: 'pending', retryAfterS: 3600 }]);
  const [a, b, c] = ids(3);
  assert.equal((await call(s.port, 'POST', '/v1/bono/free', free(a))).status, 200);
  assert.equal((await call(s.port, 'POST', '/v1/bono/fiat', fiat(b))).status, 200);
  for (const [path, body] of [['/v1/bono/free', free(c)], ['/v1/bono/fiat', fiat(c)]] as const) {
    const r = await call(s.port, 'POST', path, body);
    assert.deepEqual([r.status, r.body, r.headers['retry-after']], [503, { error: 'busy', retryAfterS: 120 }, '120'], path);
  }
  assert.equal(s.issuer.lookup(c!), undefined);
  assert.deepEqual([s.checks.captcha.seen.length, s.checks.card.seen.length], [1, 1], 'neither CAPTCHA nor charge');
  assert.equal((await call(s.port, 'POST', '/v1/bono/free', free(a, 'x'))).status, 200);
  assert.equal((await status(s.port, a)).status, 200);
});

test('general per-IP limit: also applies to status', async (t) => {
  const s = await start(t, { limits: { perIpAll: { limit: 2, windowMs: 60_000 } } });
  assert.equal((await status(s.port)).status, 404);
  assert.equal((await status(s.port)).status, 404);
  assert.equal((await status(s.port)).status, 429);
});

test('the per-client limit key can be injected (trusted proxy)', async (t) => {
  const s = await start(t, { limits: { freePerIp: { limit: 1, windowMs: 60_000 } }, clientKey: (req) => String(req.headers['x-test-client']) });
  const [a, b, c] = ids(3);
  assert.equal((await call(s.port, 'POST', '/v1/bono/free', free(a), { 'X-Test-Client': 'uno' })).status, 200);
  assert.equal((await call(s.port, 'POST', '/v1/bono/free', free(b), { 'X-Test-Client': 'dos' })).status, 200);
  assert.equal((await call(s.port, 'POST', '/v1/bono/free', free(c), { 'X-Test-Client': 'uno' })).status, 429);
});

test('a request that used up its retries is requeued with another POST, which goes through CAPTCHA and limit again', async (t) => {
  const lost: IssueOutcome = { status: 'failed', reason: 'fee-lost' };
  const s = await start(t, {}, [lost, lost, { status: 'issued' }]);
  await call(s.port, 'POST', '/v1/bono/free', free());
  await s.issuer.idle();
  assert.equal((await status(s.port)).body.state, 'failed');
  assert.equal((await call(s.port, 'POST', '/v1/bono/free', free(ID, 'malo'))).status, 403);
  assert.equal((await call(s.port, 'POST', '/v1/bono/free', free())).status, 200);
  await s.issuer.idle();
  assert.equal((await status(s.port)).body.state, 'issued');
});

test('an internal failure is 500 with a fixed body and the log only carries the error kind', async (t) => {
  const s = await start(t);
  s.issuer.submit = () => { throw new Error('boom /secret/path'); };
  const r = await call(s.port, 'POST', '/v1/bono/free', free());
  assert.deepEqual([r.status, r.body], [500, { error: 'internal' }]);
  assert.ok(s.logs.some((l) => l.startsWith('warn ')));
  assert.ok(!s.logs.join('\n').includes('/secret/path'));
});

test('by default the per-client limit uses the socket IP and ignores X-Forwarded-For', async (t) => {
  const s = await start(t, { limits: { freePerIp: { limit: 1, windowMs: 60_000 } } });
  const [a, b] = ids(2);
  assert.equal((await call(s.port, 'POST', '/v1/bono/free', free(a), { 'X-Forwarded-For': '203.0.113.1' })).status, 200);
  assert.equal((await call(s.port, 'POST', '/v1/bono/free', free(b), { 'X-Forwarded-For': '203.0.113.2' })).status, 429);
});

test('maxConnections 0 (no cap in Node) is respected, it does not fall back to the default', async (t) => {
  const s = await start(t, { limits: { maxConnections: 0 } });
  assert.equal(s.server.maxConnections, 0);
});
