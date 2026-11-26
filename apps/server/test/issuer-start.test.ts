import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';
import { loadIssuerConfig, startIssuer, type IssuerConfig, type StartIssuerOptions } from '../src/issuer/start.ts';
import type { IssueOutcome, PayerClient } from '../src/issuer/payer-client.ts';
import { IssuerStore } from '../src/issuer/store.ts';
import { openDatabase } from '../src/storage/db.ts';
import { capturingLogger } from './smtp-helpers.ts';
import { tempDir } from './temp-dir.ts';

const ID = '1a'.repeat(32);
const CONTRACT = 'c0'.repeat(32);
const CONFIG: IssuerConfig = {
  port: 0, captchaToken: 'cap', cardToken: 'card', trustedProxy: false, globalPerHour: 100, maxPending: 100, maxAdvancesPerHour: 60,
};

test('loadIssuerConfig: demo defaults', () => {
  assert.deepEqual(loadIssuerConfig({}), {
    port: 8788, captchaToken: 'nightmail-demo-captcha', cardToken: 'tok_nightmail_demo',
    trustedProxy: false, globalPerHour: 100, maxPending: 100, maxAdvancesPerHour: 60,
  });
});

test('loadIssuerConfig: everything can be changed through the environment', () => {
  const env = {
    NIGHTMAIL_ISSUER_PORT: '9000', NIGHTMAIL_ISSUER_CAPTCHA_TOKEN: 'a', NIGHTMAIL_ISSUER_CARD_TOKEN: 'b', NIGHTMAIL_ISSUER_TRUSTED_PROXY: '1',
    NIGHTMAIL_ISSUER_GLOBAL_PER_HOUR: '40', NIGHTMAIL_ISSUER_MAX_PENDING: '30', NIGHTMAIL_ISSUER_MAX_ADVANCES_PER_HOUR: '12',
  };
  assert.deepEqual(loadIssuerConfig(env), {
    port: 9000, captchaToken: 'a', cardToken: 'b', trustedProxy: true, globalPerHour: 40, maxPending: 30, maxAdvancesPerHour: 12,
  });
  assert.equal(loadIssuerConfig({ NIGHTMAIL_ISSUER_TRUSTED_PROXY: '0' }).trustedProxy, false);
});

test('loadIssuerConfig: invalid values throw with the variable name', () => {
  for (const port of ['0', '65536', 'abc', '80.5', '']) assert.throws(() => loadIssuerConfig({ NIGHTMAIL_ISSUER_PORT: port }), /NIGHTMAIL_ISSUER_PORT/, port);
  for (const name of ['NIGHTMAIL_ISSUER_GLOBAL_PER_HOUR', 'NIGHTMAIL_ISSUER_MAX_PENDING', 'NIGHTMAIL_ISSUER_MAX_ADVANCES_PER_HOUR']) {
    for (const value of ['0', '-1', '1.5', 'x', '']) assert.throws(() => loadIssuerConfig({ [name]: value }), new RegExp(name), `${name}=${value}`);
  }
  for (const value of ['', 'yes', 'true', '2']) assert.throws(() => loadIssuerConfig({ NIGHTMAIL_ISSUER_TRUSTED_PROXY: value }), /NIGHTMAIL_ISSUER_TRUSTED_PROXY/, value);
  assert.throws(() => loadIssuerConfig({ NIGHTMAIL_ISSUER_CAPTCHA_TOKEN: '' }), /token/);
});

function payerOf(outcomes: IssueOutcome[]) {
  const calls: string[] = [];
  const payer: PayerClient = {
    issue: async (id) => { calls.push(id); return outcomes[Math.min(calls.length - 1, outcomes.length - 1)]!; },
    advanceRound: async () => ({ status: 'failed' }),
  };
  return { payer, calls };
}

async function post(port: number, path: string, body: object, headers: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
}

const options = (dataDir: string, logs: string[], over: Partial<StartIssuerOptions> = {}): StartIssuerOptions => ({
  dataDir, contract: CONTRACT, payer: payerOf([{ status: 'issued' }]).payer, log: capturingLogger(logs), config: CONFIG,
  issuerOptions: { delayMs: () => 0 }, ...over,
});

test('startIssuer: serves the API, checks the tokens and creates the receipt key (0600) and the database', async (t) => {
  const dataDir = tempDir(t);
  const logs: string[] = [];
  const issuer = await startIssuer(options(dataDir, logs));
  t.after(() => issuer.close());
  assert.equal((await post(issuer.port, '/v1/bono/free', { id: ID, captchaToken: 'mal' })).status, 403);
  const ok = await post(issuer.port, '/v1/bono/free', { id: ID, captchaToken: 'cap' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.receipt.contract, CONTRACT);
  assert.equal(statSync(path.join(dataDir, 'issuer-receipt-key')).mode & 0o777, 0o600);
  assert.equal(statSync(path.join(dataDir, 'issuer.sqlite')).mode & 0o777, 0o600);
  assert.equal((await post(issuer.port, '/v1/bono/fiat', { id: 'bb'.repeat(32), cardToken: 'card', period: 'annual' })).status, 200);
  assert.ok(!logs.join('\n').includes('cap'), 'the tokens are not logged');
});

test('startIssuer: the startup line publishes the fingerprint of the receipt public key', async (t) => {
  const logs: string[] = [];
  const issuer = await startIssuer(options(tempDir(t), logs));
  t.after(() => issuer.close());
  const { publicKey } = (await post(issuer.port, '/v1/bono/free', { id: ID, captchaToken: 'cap' })).body.receipt;
  const fingerprint = createHash('sha256').update(Buffer.from(publicKey, 'hex')).digest('hex');
  assert.ok(logs.some((l) => l.startsWith('info ') && l.includes('listening') && l.includes(`sha256:${fingerprint}`)), logs.join('\n'));
});

test('startIssuer: the registry contract must be 32-byte hex', async (t) => {
  await assert.rejects(startIssuer(options(tempDir(t), [], { contract: 'C0'.repeat(32) })), RangeError);
});

test('startIssuer: warns if the demo tokens are used', async (t) => {
  const logs: string[] = [];
  const issuer = await startIssuer(options(tempDir(t), logs, { config: { ...loadIssuerConfig({}), port: 0 } }));
  t.after(() => issuer.close());
  assert.ok(logs.some((l) => l.startsWith('warn ') && l.includes('demo')));
});

test('startIssuer: on loopback without a trusted proxy it warns that per-IP limits will see the proxy', async (t) => {
  const logs: string[] = [];
  const a = await startIssuer(options(tempDir(t), logs));
  t.after(() => a.close());
  assert.equal(logs.filter((l) => l.startsWith('warn ') && l.includes('NIGHTMAIL_ISSUER_TRUSTED_PROXY')).length, 1);
  const quiet: string[] = [];
  const b = await startIssuer(options(tempDir(t), quiet, { config: { ...CONFIG, trustedProxy: true } }));
  t.after(() => b.close());
  assert.ok(!quiet.some((l) => l.includes('TRUSTED_PROXY')));
});

test('startIssuer: with a trusted proxy the per-IP limit uses the last X-Forwarded-For entry', async (t) => {
  const issuer = await startIssuer(options(tempDir(t), [], {
    config: { ...CONFIG, trustedProxy: true }, apiOptions: { limits: { freePerIp: { limit: 1, windowMs: 60_000 } } },
  }));
  t.after(() => issuer.close());
  const signup = (id: string, xff: string) => post(issuer.port, '/v1/bono/free', { id, captchaToken: 'cap' }, { 'X-Forwarded-For': xff });
  assert.equal((await signup('01'.repeat(32), '6.6.6.6, 203.0.113.1')).status, 200);
  assert.equal((await signup('02'.repeat(32), '6.6.6.6, 203.0.113.2')).status, 200);
  assert.equal((await signup('03'.repeat(32), '7.7.7.7, 203.0.113.1')).status, 429);
});

test('startIssuer: the global and pending limits come from the configuration', async (t) => {
  const issuer = await startIssuer(options(tempDir(t), [], { config: { ...CONFIG, globalPerHour: 1 } }));
  t.after(() => issuer.close());
  assert.equal((await post(issuer.port, '/v1/bono/free', { id: '01'.repeat(32), captchaToken: 'cap' })).status, 200);
  assert.equal((await post(issuer.port, '/v1/bono/fiat', { id: '02'.repeat(32), cardToken: 'card', period: 'annual' })).status, 429);
});

test('startIssuer: if listen fails (port in use), it throws and closes the database', async (t) => {
  const first = await startIssuer(options(tempDir(t), []));
  t.after(() => first.close());
  const dbFile = path.join(tempDir(t), 'issuer.sqlite');
  await assert.rejects(startIssuer(options(tempDir(t), [], { dbFile, config: { ...CONFIG, port: first.port } })));
  openDatabase(dbFile).close();
});

test('startIssuer: on start it purges issued requests older than 7 days', async (t) => {
  const dataDir = tempDir(t);
  const dbFile = path.join(dataDir, 'issuer.sqlite');
  const db = openDatabase(dbFile);
  const old = { plan: 'free', period: null, insertBy: 1, signature: Buffer.alloc(64), createdAt: Date.now() - 8 * 86_400_000 } as const;
  new IssuerStore(db).create({ ...old, id: '01'.repeat(32), state: 'issued' });
  new IssuerStore(db).create({ ...old, id: '02'.repeat(32), state: 'failed' });
  db.close();
  const logs: string[] = [];
  const issuer = await startIssuer(options(dataDir, logs));
  t.after(() => issuer.close());
  assert.equal(issuer.issuer.lookup('01'.repeat(32)), undefined);
  assert.equal(issuer.issuer.lookup('02'.repeat(32))?.state, 'failed');
  assert.ok(logs.some((l) => l.startsWith('info ') && l.includes('purged 1')));
});

test('startIssuer: on restart it resumes the pending work, with the same receipt key', async (t) => {
  const dataDir = tempDir(t);
  const first = payerOf([{ status: 'pending', retryAfterS: 3600 }]);
  const a = await startIssuer(options(dataDir, [], { payer: first.payer }));
  const receipt = (await post(a.port, '/v1/bono/free', { id: ID, captchaToken: 'cap' })).body.receipt;
  await new Promise((r) => setTimeout(r, 30));
  await a.close();
  assert.equal(first.calls.length, 1);

  const second = payerOf([{ status: 'issued' }]);
  const b = await startIssuer(options(dataDir, [], { payer: second.payer }));
  t.after(() => b.close());
  await b.issuer.idle();
  assert.deepEqual(second.calls, [ID]);
  const again = (await post(b.port, '/v1/bono/status', { id: ID })).body;
  assert.equal(again.state, 'issued');
  assert.equal(again.receipt.publicKey, receipt.publicKey);
  assert.equal(again.receipt.signature, receipt.signature);
});

test('startIssuer: if given readRoundState it starts the RoundTicker, and close stops it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let asked = 0;
  const running = await startIssuer(options(tempDir(t), [], { readRoundState: async () => { asked++; return { round: 1n, waiting: false }; } }));
  t.mock.timers.tick(30_000);
  await new Promise((r) => setImmediate(r));
  assert.equal(asked, 1);
  await running.close();
  t.mock.timers.tick(60_000);
  await new Promise((r) => setImmediate(r));
  assert.equal(asked, 1);
});

test('startIssuer: warns about demo tokens if EITHER of the two is one, and not if neither is', async (t) => {
  const demo = loadIssuerConfig({});
  const cases: Array<[string, IssuerConfig, boolean]> = [
    ['both from the demo', { ...CONFIG, captchaToken: demo.captchaToken, cardToken: demo.cardToken }, true],
    ['only the demo CAPTCHA', { ...CONFIG, captchaToken: demo.captchaToken }, true],
    ['only the demo card', { ...CONFIG, cardToken: demo.cardToken }, true],
    ['neither from the demo', CONFIG, false],
  ];
  for (const [name, config, warned] of cases) {
    const logs: string[] = [];
    const running = await startIssuer(options(tempDir(t), logs, { config }));
    await running.close();
    assert.equal(logs.some((l) => l.startsWith('warn ') && l.includes('demo')), warned, name);
  }
});

test('startIssuer: an empty host does not count as loopback (no warning about per-IP limits)', async (t) => {
  const logs: string[] = [];
  const running = await startIssuer(options(tempDir(t), logs, { host: '' }));
  t.after(() => running.close());
  assert.ok(!logs.some((l) => l.includes('TRUSTED_PROXY')), logs.join('\n'));
});

test('startIssuer: a given dbFile overrides <dataDir>/issuer.sqlite, even if empty (not a valid path)', async (t) => {
  const dataDir = tempDir(t);
  await assert.rejects(startIssuer(options(dataDir, [], { dbFile: '' })), { code: 'ENOENT' });
  assert.throws(() => statSync(path.join(dataDir, 'issuer.sqlite')), { code: 'ENOENT' });
});

test('startIssuer: without issuerOptions it starts with the defaults', async (t) => {
  const { issuerOptions: _omitted, ...withoutIssuerOptions } = options(tempDir(t), []);
  const running = await startIssuer(withoutIssuerOptions);
  t.after(() => running.close());
  assert.equal((await post(running.port, '/v1/bono/status', { id: ID })).status, 404);
});

test('startIssuer: upkeep warns when pending requests exceed half of maxPending', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const logs: string[] = [];
  const pending = payerOf([{ status: 'pending', retryAfterS: 3600 }]);
  const running = await startIssuer(options(tempDir(t), logs, { payer: pending.payer, config: { ...CONFIG, maxPending: 4 } }));
  t.after(() => running.close());
  for (const id of ['01', '02', '03']) assert.equal((await post(running.port, '/v1/bono/free', { id: id.repeat(32), captchaToken: 'cap' })).status, 200);
  t.mock.timers.tick(10 * 60_000);
  assert.ok(logs.some((l) => l.startsWith('warn ') && l.includes('3 pending requests')), logs.join('\n'));
});
