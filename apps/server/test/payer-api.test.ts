// Payer local API: HTTP over a real Unix socket in a temporary directory.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, lstatSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { MAX_BODY_BYTES, PayerSocketError, startPayerApi, type PayerOps } from '../src/payer/api.ts';
import { payerClient } from '../src/payer/client.ts';
import { IssueJournal } from '../src/payer/journal.ts';
import { Payer, type Health } from '../src/payer/payer.ts';
import { InsecurePermissionsError } from '../src/wallet/storage.ts';
import { tempDir } from './temp-dir.ts';

const ID = 'ab'.repeat(32);
const HEALTH: Health = {
  ready: true, dustCoins: 5, dustBalance: 1250000000000000000000000n, queueLength: 2,
  lostFees: { count: 1, dust: 388032291803696n, byCause: { 'issue:FailFallible': { count: 1, dust: 388032291803696n } } },
  dustSpentLastHour: { relay: 7n, issue: 0n }, dustCapPerHour: { relay: 100n, issue: 50n }, issuesInFlight: 0, earlyAnswersWrong: 0, earlyAnswersUnconfirmed: 0, contract: ID,
};

/** A fake payer that records calls and answers whatever it is told. */
function fakeOps(over: Partial<PayerOps> = {}) {
  const calls: unknown[][] = [];
  const ops: PayerOps = {
    health: () => HEALTH,
    relay: async (tx) => { calls.push(['relay', tx]); return { status: 'SucceedEntirely', txHash: ID }; },
    issue: async (id, plan) => { calls.push(['issue', id, plan]); return { status: 'issued', txHash: ID }; },
    ...over,
  };
  return { ops, calls };
}

async function serve(t: TestContext, over: Partial<PayerOps> = {}, payer?: () => PayerOps | undefined) {
  const dir = tempDir(t);
  const socketPath = path.join(dir, 'payer.sock');
  const { ops, calls } = fakeOps(over);
  const warnings: string[] = [];
  const api = await startPayerApi({ socketPath, payer: payer ?? (() => ops), log: { info: () => {}, warn: (m) => { warnings.push(m); } } });
  t.after(() => api.close());
  return { dir, socketPath, calls, warnings, api, client: payerClient(socketPath) };
}

type Raw = { status: number; headers: http.IncomingHttpHeaders; body: any; text: string };

/** A raw request (for things the client would never send). */
function raw(socketPath: string, method: string, url: string, body?: string | Buffer, headers: Record<string, string> = {}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path: url, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { parsed = undefined; }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed, text });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}
const post = (socketPath: string, url: string, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  raw(socketPath, 'POST', url, typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body), headers);

// --- Socket ------------------------------------------------------------------------------------------

test('the socket is created 0600 in a 0700 directory, does not change the process umask and is removed on close', async (t) => {
  const umask = process.umask();
  const s = await serve(t);
  assert.equal(lstatSync(s.socketPath).isSocket(), true);
  assert.equal(statSync(s.socketPath).mode & 0o777, 0o600);
  assert.equal(process.umask(), umask);
  assert.equal((await s.client.health()).status, 200);
  await s.api.close();
  assert.equal(existsSync(s.socketPath), false);
  await s.api.close(); // closing twice does not fail
});

test('refuses to listen in a directory others can read', async (t) => {
  const dir = tempDir(t);
  chmodSync(dir, 0o755);
  const { ops } = fakeOps();
  await assert.rejects(startPayerApi({ socketPath: path.join(dir, 'payer.sock'), payer: () => ops, log: { info: () => {}, warn: () => {} } }),
    InsecurePermissionsError);
  assert.equal(existsSync(path.join(dir, 'payer.sock')), false);
});

/** Leaves an orphan socket in `dir` (another name for the socket of a server already closed) and returns its path. */
async function orphanSocket(dir: string): Promise<string> {
  const socketPath = path.join(dir, 'payer.sock');
  const dead = net.createServer();
  await new Promise<void>((resolve) => dead.listen(path.join(dir, 'old.sock'), resolve));
  linkSync(path.join(dir, 'old.sock'), socketPath);
  await new Promise((resolve) => dead.close(resolve));
  assert.equal(lstatSync(socketPath).isSocket(), true);
  return socketPath;
}

test('a socket that cannot be probed (no permission) is not removed: error with the reason', { skip: process.getuid?.() === 0 }, async (t) => {
  const socketPath = await orphanSocket(tempDir(t));
  chmodSync(socketPath, 0o000);
  const { ops } = fakeOps();
  await assert.rejects(startPayerApi({ socketPath, payer: () => ops, log: { info: () => {}, warn: () => {} } }),
    (e: unknown) => e instanceof PayerSocketError && /cannot be probed \(EACCES\)/.test(e.message));
  assert.equal(lstatSync(socketPath).isSocket(), true, 'still there');
});

test('a stale socket with nobody listening (previous process dead) is removed and listened on again', async (t) => {
  const socketPath = await orphanSocket(tempDir(t));
  const { ops } = fakeOps();
  const api = await startPayerApi({ socketPath, payer: () => ops, log: { info: () => {}, warn: () => {} } });
  t.after(() => api.close());
  assert.equal((await payerClient(socketPath).health()).status, 200);
  assert.equal(statSync(socketPath).mode & 0o777, 0o600);
});

test('if someone is listening on the socket, it is not taken over: error and the other one keeps working', async (t) => {
  const first = await serve(t);
  const { ops } = fakeOps();
  await assert.rejects(startPayerApi({ socketPath: first.socketPath, payer: () => ops, log: { info: () => {}, warn: () => {} } }),
    PayerSocketError);
  assert.equal((await first.client.health()).status, 200);
});

test('if the socket path is something else (a file), it is not touched', async (t) => {
  const dir = tempDir(t);
  const socketPath = path.join(dir, 'payer.sock');
  writeFileSync(socketPath, 'importante');
  const { ops } = fakeOps();
  await assert.rejects(startPayerApi({ socketPath, payer: () => ops, log: { info: () => {}, warn: () => {} } }), PayerSocketError);
  assert.equal(readFileSync(socketPath, 'utf8'), 'importante');
});

// --- Routes ------------------------------------------------------------------------------------------

test('GET /health: the payer status, with DUST amounts as decimal text', async (t) => {
  const s = await serve(t);
  const r = await raw(s.socketPath, 'GET', '/health');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type']!, /^application\/json/);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.deepEqual(r.body, {
    ready: true, dustCoins: 5, dustBalance: '1250000000000000000000000', queueLength: 2,
    lostFees: { count: 1, dust: '388032291803696', byCause: { 'issue:FailFallible': { count: 1, dust: '388032291803696' } } },
    dustSpentLastHour: { relay: '7', issue: '0' }, dustCapPerHour: { relay: '100', issue: '50' }, issuesInFlight: 0, earlyAnswersWrong: 0, earlyAnswersUnconfirmed: 0, contract: ID,
  });
  assert.deepEqual((await s.client.health()).body, r.body, 'the client gives the same');
});

test('while the wallet syncs there is no payer: /health says it is not ready and everything else answers not-ready', async (t) => {
  const s = await serve(t, {}, () => undefined);
  const health = await s.client.health();
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { ready: false });
  for (const r of [await s.client.relay('00'), await s.client.issue(ID, 'free')]) {
    assert.deepEqual([r.status, r.body], [503, { error: 'not-ready' }]);
  }
});

test('POST /relay: passes the transaction bytes (hex) and returns the result', async (t) => {
  const s = await serve(t);
  const r = await s.client.relay('00ff10');
  assert.deepEqual([r.status, r.body], [200, { status: 'SucceedEntirely', txHash: ID }]);
  assert.deepEqual(s.calls, [['relay', new Uint8Array([0x00, 0xff, 0x10])]]);
});

test('POST /issue: arguments and result', async (t) => {
  const s = await serve(t);
  assert.deepEqual((await s.client.issue(ID, 'paid')).body, { status: 'issued', txHash: ID });
  assert.deepEqual(s.calls, [['issue', ID, 'paid']]);
});

test('each payer error has its fixed HTTP code, those asking to wait carry Retry-After', async (t) => {
  const table: [object, number, string | undefined][] = [
    [{ error: 'invalid-tx' }, 422, undefined],
    [{ error: 'not-relayable', reason: 'unshielded-offer' }, 422, undefined],
    [{ error: 'id-conflict' }, 409, undefined],
    [{ error: 'no-contract' }, 503, undefined],
    [{ error: 'queue-full' }, 503, undefined],
    [{ error: 'internal' }, 500, undefined],
    [{ error: 'dust-cap', retryAfterS: 1234 }, 429, '1234'],
    [{ error: 'dust-unavailable', transient: true, retryAfterS: 60 }, 503, '60'],
    [{ error: 'fee-over-cap' }, 422, undefined],
    [{ error: 'indexer-behind', retryAfterS: 30 }, 503, '30'],
    [{ error: 'stopping' }, 503, undefined],
  ];
  let next: object = {};
  const s = await serve(t, { relay: async () => next as never });
  for (const [result, status, retryAfter] of table) {
    next = result;
    const r = await post(s.socketPath, '/relay', { tx: '00' });
    assert.deepEqual([r.status, r.body, r.headers['retry-after']], [status, result, retryAfter], JSON.stringify(result));
  }
});

test('a result (also failed, pending, rejected or unknown) is 200: the operation was handled', async (t) => {
  const results = [{ status: 'failed', reason: 'fee-lost', txHash: ID }, { status: 'pending', txHash: ID, retryAfterS: 9 }, { status: 'already-issued' }];
  let next: object = {};
  const s = await serve(t, { issue: async () => next as never });
  for (const result of results) {
    next = result;
    const r = await s.client.issue(ID, 'free');
    assert.deepEqual([r.status, r.body], [200, result]);
  }
});

test('strict JSON: a body that is not exactly the expected object → 400 bad-request, without calling the payer', async (t) => {
  const s = await serve(t);
  const bad: [string, unknown][] = [
    ['/relay', 'no es json'],
    ['/relay', ''],
    ['/relay', 'null'],
    ['/relay', '[]'],
    ['/relay', '"00"'],
    ['/relay', {}],
    ['/relay', { tx: '00', extra: 1 }],
    ['/relay', { tx: 7 }],
    ['/relay', { tx: '' }],
    ['/relay', { tx: '0' }],
    ['/relay', { tx: 'zz' }],
    ['/relay', { tx: 'AB' }],
    ['/relay', '{"tx":"00","__proto__":{}}'],
    ['/issue', { id: ID }],
    ['/issue', { plan: 'free' }],
    ['/issue', { id: ID, plan: 'gold' }],
    ['/issue', { id: ID, plan: 0 }],
    ['/issue', { id: ID.slice(2), plan: 'free' }],
    ['/issue', { id: ID.toUpperCase(), plan: 'free' }],
    ['/issue', { id: ID, plan: 'free', validUntil: 1 }],
  ];
  for (const [url, body] of bad) {
    const r = await post(s.socketPath, url, body);
    assert.deepEqual([r.status, r.body], [400, { error: 'bad-request' }], `${url} ${JSON.stringify(body)}`);
  }
  assert.deepEqual(s.calls, []);
});

test('JSON only: another Content-Type → 415', async (t) => {
  const s = await serve(t);
  const others: Record<string, string>[] = [{}, { 'content-type': 'text/plain' }, { 'content-type': 'application/x-www-form-urlencoded' }];
  for (const headers of others) {
    const r = await post(s.socketPath, '/relay', '{"tx":"00"}', headers);
    assert.deepEqual([r.status, r.body], [415, { error: 'unsupported-media-type' }]);
  }
  const ok = await post(s.socketPath, '/relay', '{"tx":"00"}', { 'content-type': 'application/json; charset=utf-8' });
  assert.equal(ok.status, 200);
  assert.equal(s.calls.length, 1);
});

test('body limit: larger → 413, declared (Content-Length) or not (chunked), exactly the limit fits', async (t) => {
  const s = await serve(t);
  const sized = (bodyBytes: number) => '{"tx":"00"}'.padEnd(bodyBytes, ' '); // valid JSON of exactly that size
  const fits = await post(s.socketPath, '/relay', sized(MAX_BODY_BYTES));
  assert.equal(fits.status, 200);
  const declared = await post(s.socketPath, '/relay', sized(MAX_BODY_BYTES + 1));
  assert.deepEqual([declared.status, declared.body], [413, { error: 'payload-too-large' }]);
  const chunked = await new Promise<Raw>((resolve, reject) => {
    const req = http.request({ socketPath: s.socketPath, method: 'POST', path: '/relay', headers: { 'content-type': 'application/json' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString()), text: '' }));
    });
    req.on('error', reject);
    req.write(sized(MAX_BODY_BYTES)); // no Content-Length: chunked transfer
    req.end(' ');
  });
  assert.deepEqual([chunked.status, chunked.body], [413, { error: 'payload-too-large' }]);
  assert.equal(s.calls.length, 1, 'only the one that fit reached the payer');
});

test('routes and methods: anything that does not exist → 404, wrong method → 405 with Allow', async (t) => {
  const s = await serve(t);
  for (const url of ['/', '/health/', '/health?x=1', '/relay/1', '/issue?id=1', '/v1/health', '/HEALTH', '/advance-round']) {
    const r = await raw(s.socketPath, 'GET', url);
    assert.deepEqual([r.status, r.body], [404, { error: 'not-found' }], url);
  }
  const wrong: [string, string, string][] = [['POST', '/health', 'GET'], ['GET', '/relay', 'POST'], ['PUT', '/issue', 'POST']];
  for (const [method, url, allow] of wrong) {
    const r = await raw(s.socketPath, method, url, undefined, { 'content-type': 'application/json' });
    assert.deepEqual([r.status, r.body, r.headers.allow], [405, { error: 'method-not-allowed' }, allow], `${method} ${url}`);
  }
  assert.deepEqual(s.calls, []);
});

test('if the payer throws, the response is 500 internal without the message (which goes to the log)', async (t) => {
  const s = await serve(t, { issue: async () => { throw new Error('seed=0000 secret'); }, health: () => { throw new TypeError('boom secret'); } });
  for (const r of [await post(s.socketPath, '/issue', { id: ID, plan: 'free' }), await raw(s.socketPath, 'GET', '/health')]) {
    assert.deepEqual([r.status, r.body], [500, { error: 'internal' }]);
    assert.doesNotMatch(r.text, /secret/);
  }
  assert.equal(s.warnings.length, 2);
  assert.doesNotMatch(s.warnings.join('\n'), /secret/, 'only the error kind goes to the log');
  assert.match(s.warnings.join('\n'), /TypeError/);
});

test('end to end with the real Payer (fake wallet and chain): relay over the socket', async (t) => {
  const dir = tempDir(t);
  const sent: Uint8Array[] = [];
  const payer = new Payer({
    ports: {
      status: () => ({ synced: true, dustCoins: 1, dustBalance: 10n }),
      screen: () => null,
      guaranteedOnly: () => false,
      estimateFee: async () => 3n,
      send: async (tx, beforeSubmit) => {
        await beforeSubmit({ txHash: ID, validUntil: new Date(Date.now() + 60_000), fee: 2n });
        sent.push(tx.bytes);
        return { ok: true, status: 'SucceedEntirely', proveMs: 0, blockMs: 1, bytes: tx.bytes.length };
      },
      registry: null,
    },
    journal: IssueJournal.open(dir),
    limits: { relayDustPerHour: 5n, issueDustPerHour: 0n, maxQueue: 4 },
    log: { info: () => {}, warn: () => {} },
  });
  const socketPath = path.join(dir, 'payer.sock');
  const api = await startPayerApi({ socketPath, payer: () => payer, log: { info: () => {}, warn: () => {} } });
  t.after(() => api.close());
  const client = payerClient(socketPath);
  assert.deepEqual((await client.relay('c0ffee')).body, { status: 'SucceedEntirely', txHash: ID });
  assert.deepEqual(sent, [new Uint8Array([0xc0, 0xff, 0xee])]);
  const capped = await client.relay('c0ffee'); // 2 spent + 3 estimated <= 5: fits
  assert.equal(capped.status, 200);
  const over = await client.relay('c0ffee'); // 4 + 3 > 5
  assert.equal(over.status, 429);
  assert.equal((over.body as { error: string }).error, 'dust-cap');
  assert.deepEqual((await client.issue(ID, 'free')).body, { error: 'no-contract' });
  const health = (await client.health()).body as { ready: boolean; dustSpentLastHour: { relay: string } };
  assert.deepEqual([health.ready, health.dustSpentLastHour.relay], [true, '4']);
});

test('the client fails with a clear error if nobody is on the socket', async (t) => {
  const dir = tempDir(t);
  await assert.rejects(payerClient(path.join(dir, 'payer.sock')).health(), /ENOENT|ECONNREFUSED/);
});
