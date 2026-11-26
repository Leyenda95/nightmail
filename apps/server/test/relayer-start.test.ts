import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRelayerConfig, startRelayer, type RelayerConfig } from '../src/relayer/start.ts';
import { capturingLogger } from './smtp-helpers.ts';

const REGISTRY = 'ab'.repeat(32);
const goodTx = () => ({
  intents: new Map([[1, { actions: [{ address: REGISTRY, entryPoint: 'createAlias', fallibleTranscript: undefined }], ttl: new Date(Date.now() + 30 * 60_000) }]]),
  identifiers: () => ['id-1'],
});
const LIMITS = { perIpPerHour: 20, globalPerHour: 300, attemptsPerIpPerHour: 60, faultsPerIpPerHour: 3, rejectedPerHour: 100 };
const CONFIG: RelayerConfig = { port: 0, trustedProxy: false, ...LIMITS, maxDelayMs: 20_000, maxInFlight: 8 };

test('loadRelayerConfig: defaults (20 per hour and client, 300 global, 60 attempts, 3 strikes, 100 rejections, delay up to 20 s, 8 in flight)', () => {
  assert.deepEqual(loadRelayerConfig({}), { ...CONFIG, port: 8789 });
});

test('loadRelayerConfig: everything can be changed through the environment (the delay accepts 0)', () => {
  const env = {
    NIGHTMAIL_RELAYER_PORT: '9001', NIGHTMAIL_RELAYER_TRUSTED_PROXY: '1', NIGHTMAIL_RELAYER_PER_IP_PER_HOUR: '5',
    NIGHTMAIL_RELAYER_GLOBAL_PER_HOUR: '50', NIGHTMAIL_RELAYER_ATTEMPTS_PER_IP_PER_HOUR: '7',
    NIGHTMAIL_RELAYER_FAULTS_PER_IP_PER_HOUR: '2', NIGHTMAIL_RELAYER_REJECTED_PER_HOUR: '9',
    NIGHTMAIL_RELAYER_MAX_DELAY_MS: '0', NIGHTMAIL_RELAYER_MAX_IN_FLIGHT: '2',
  };
  assert.deepEqual(loadRelayerConfig(env), {
    port: 9001, trustedProxy: true, perIpPerHour: 5, globalPerHour: 50, attemptsPerIpPerHour: 7, faultsPerIpPerHour: 2,
    rejectedPerHour: 9, maxDelayMs: 0, maxInFlight: 2,
  });
});

test('loadRelayerConfig: invalid values throw with the variable name', () => {
  for (const name of ['PORT', 'PER_IP_PER_HOUR', 'GLOBAL_PER_HOUR', 'ATTEMPTS_PER_IP_PER_HOUR', 'FAULTS_PER_IP_PER_HOUR', 'REJECTED_PER_HOUR', 'MAX_IN_FLIGHT']) {
    for (const value of ['0', '-1', '1.5', 'x', '']) assert.throws(() => loadRelayerConfig({ [`NIGHTMAIL_RELAYER_${name}`]: value }), new RegExp(name), `${name}=${value}`);
  }
  assert.throws(() => loadRelayerConfig({ NIGHTMAIL_RELAYER_MAX_DELAY_MS: '-1' }), /MAX_DELAY_MS/);
  assert.throws(() => loadRelayerConfig({ NIGHTMAIL_RELAYER_PORT: '65536' }), /PORT/);
  for (const value of ['', 'yes', '2']) assert.throws(() => loadRelayerConfig({ NIGHTMAIL_RELAYER_TRUSTED_PROXY: value }), /TRUSTED_PROXY/, value);
});

async function post(port: number, path: string, body: object) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
}

test('startRelayer: serves the API, forwards to the payer and closes', async () => {
  const logs: string[] = [];
  const sent: string[] = [];
  const payer = { relay: async (hex: string) => { sent.push(hex); return { status: 200, body: { status: 'SucceedEntirely', txHash: 'f1' } }; } };
  const relayer = await startRelayer({
    dataDir: '/nonexistent', payer, registry: REGISTRY, log: capturingLogger(logs), config: { ...CONFIG, maxDelayMs: 0 },
    parse: goodTx,
  });
  const submitted = await post(relayer.port, '/v1/relay', { tx: 'aa01' });
  assert.equal(submitted.status, 202);
  for (let i = 0; i < 50 && sent.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 20));
  const status = await post(relayer.port, '/v1/relay/status', { ticket: submitted.body.ticket });
  assert.deepEqual(status.body, { state: 'done', outcome: 'included', txHash: 'f1' });
  assert.ok(logs.some((l) => /relayer: listening on port \d+/.test(l)));
  assert.ok(logs.some((l) => /NIGHTMAIL_RELAYER_TRUSTED_PROXY/.test(l)), 'warns about the proxy on loopback');
  await relayer.close();
  await assert.rejects(post(relayer.port, '/v1/relay', { tx: 'aa01' }));
});

test('startRelayer: the configured limits reach the service (attempts per client)', async () => {
  const relayer = await startRelayer({
    dataDir: '/nonexistent', payer: { relay: () => new Promise(() => {}) }, registry: REGISTRY, log: capturingLogger([]),
    config: { ...CONFIG, attemptsPerIpPerHour: 1 }, parse: () => { throw new Error('not a tx'); },
  });
  assert.equal((await post(relayer.port, '/v1/relay', { tx: 'aa01' })).status, 422);
  assert.equal((await post(relayer.port, '/v1/relay', { tx: 'aa02' })).status, 429);
  await relayer.close();
});

test('startRelayer: with a transaction malformed for the production parse → 422 invalid-tx', async () => {
  const relayer = await startRelayer({
    dataDir: '/nonexistent', payer: { relay: async () => ({ status: 200, body: {} }) }, registry: REGISTRY,
    log: capturingLogger([]), config: CONFIG,
  });
  const answer = await post(relayer.port, '/v1/relay', { tx: 'aa01' });
  assert.deepEqual([answer.status, answer.body], [422, { error: 'invalid-tx' }]);
  await relayer.close();
});

test('startRelayer: the loopback warning only appears without a trusted proxy AND on loopback', async () => {
  const warned = async (config: RelayerConfig, host?: string) => {
    const logs: string[] = [];
    const relayer = await startRelayer({
      dataDir: '/nonexistent', payer: { relay: async () => ({ status: 200, body: {} }) }, registry: REGISTRY,
      log: capturingLogger(logs), config, ...(host !== undefined && { host }),
    });
    await relayer.close();
    return logs.some((l) => /NIGHTMAIL_RELAYER_TRUSTED_PROXY/.test(l));
  };
  assert.equal(await warned(CONFIG), true, 'loopback by default, no proxy');
  assert.equal(await warned({ ...CONFIG, trustedProxy: true }), false, 'with a trusted proxy');
  assert.equal(await warned(CONFIG, '0.0.0.0'), false, 'listening outside loopback');
  assert.equal(await warned(CONFIG, ''), false, 'an empty host is respected, it does not fall back to 127.0.0.1');
});
