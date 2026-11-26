// Operator services that use the payer (Issuer + RoundTicker and the public relayer), started alongside the
// receiving server. Uses a fake payer and arbitrary free ports.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  closeTogether, type OperatorPayer, type OperatorSetup, prepareOperatorServices, roundReader, startOperatorServices,
} from '../src/operator-services.ts';
import { capturingLogger } from './smtp-helpers.ts';
import { tempDir } from './temp-dir.ts';

const REGISTRY = 'ab'.repeat(32);
type Reply = { status: number; body: unknown };
/** Arbitrary free ports. */
const ENV = { NIGHTMAIL_ISSUER_PORT: '1', NIGHTMAIL_RELAYER_PORT: '1' };

function fakePayer(health: Reply | Error | 'hang' = { status: 200, body: { ready: true, contract: REGISTRY } }): OperatorPayer {
  const answer = async (): Promise<Reply> => ({ status: 503, body: { error: 'not-ready' } });
  return {
    health: async () => {
      if (health === 'hang') return new Promise<never>(() => {});
      if (health instanceof Error) throw health;
      return health;
    },
    relay: answer, issue: answer, advanceRound: answer,
  };
}

async function prepare(logs: string[], health?: Reply | Error | 'hang') {
  const setup = await prepareOperatorServices({ dataDir: '/nonexistent', registry: REGISTRY, log: capturingLogger(logs), env: ENV, payer: fakePayer(health), timeoutMs: 50 });
  return { ...setup, issuerConfig: { ...setup.issuerConfig, port: 0 }, relayerConfig: { ...setup.relayerConfig, port: 0 } };
}

function start(t: TestContext, setup: OperatorSetup, logs: string[] = []) {
  return startOperatorServices({
    dataDir: tempDir(t), registry: REGISTRY, log: capturingLogger(logs), setup, roundState: () => undefined, healthy: () => true,
  });
}

async function post(port: number, path: string, body: object) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.status;
}

test('prepare reads the configurations from the environment (an invalid value throws before opening anything)', async () => {
  const setup = await prepareOperatorServices({
    dataDir: '/nonexistent', registry: REGISTRY, log: capturingLogger([]), payer: fakePayer(),
    env: { NIGHTMAIL_ISSUER_PORT: '9001', NIGHTMAIL_RELAYER_PER_IP_PER_HOUR: '7' },
  });
  assert.equal(setup.issuerConfig.port, 9001);
  assert.equal(setup.relayerConfig.perIpPerHour, 7);
  await assert.rejects(prepareOperatorServices({ dataDir: '/x', registry: REGISTRY, log: capturingLogger([]), payer: fakePayer(), env: { NIGHTMAIL_RELAYER_PORT: 'abc' } }), /RELAYER_PORT/);
});

test('starts the Issuer and the relayer on their ports and closes them', async (t) => {
  const logs: string[] = [];
  const services = await start(t, await prepare(logs), logs);
  assert.equal(await post(services.relayerPort, '/v1/relay/status', { ticket: '00'.repeat(16) }), 404, 'the relayer answers');
  assert.equal(await post(services.issuerPort, '/v1/nada', {}), 404, 'the Issuer answers');
  assert.ok(logs.some((l) => /issuer: listening/.test(l)));
  assert.ok(logs.some((l) => /relayer: listening/.test(l)));
  assert.ok(!logs.some((l) => l.startsWith('warn payer')), 'the payer contract matches: no warning');
  await services.close();
  await assert.rejects(post(services.relayerPort, '/v1/relay/status', { ticket: '00'.repeat(16) }));
  await assert.rejects(post(services.issuerPort, '/v1/nada', {}));
});

for (const [name, health, error] of [
  ['pays for ANOTHER registry', { status: 200, body: { ready: true, contract: 'cd'.repeat(32) } }, /another registry contract/],
  ['is ready but without a registry (started before the deployment)', { status: 200, body: { ready: true, contract: null } }, /no registry contract/],
] as [string, Reply, RegExp][]) {
  test(`if the payer ${name}, prepare throws (nothing is opened)`, async () => {
    await assert.rejects(prepare([], health), error);
  });
}

for (const [name, health, why] of [
  ['is unreachable', Object.assign(new Error('connect ENOENT /secret/payer.sock'), { code: 'ENOENT' }), 'Error/ENOENT'],
  ['hangs (short timeout, not the client 30 min)', 'hang', 'Timeout'],
  ['is not ready yet (no contract in /health)', { status: 503, body: { ready: false } }, 'not ready'],
  ['is not ready yet (contract: null)', { status: 200, body: { ready: false, contract: null } }, 'not ready'],
  ['answers with a null body', { status: 200, body: null }, 'not ready'],
  ['answers with a contract that is not 32-byte hex', { status: 200, body: { contract: 'otro' } }, 'not ready'],
] as [string, Reply | Error | 'hang', string][]) {
  test(`when the payer ${name}, prepare warns (only the error class) and moves on`, async () => {
    const logs: string[] = [];
    await prepare(logs, health);
    assert.deepEqual(logs.filter((l) => l.startsWith('warn')), [`warn payer: could not check its registry contract (${why}); the issuer and the relayer will retry`]);
  });
}

test('if the relayer cannot listen (port in use), the already started Issuer is closed and it throws', async (t) => {
  const first = await start(t, await prepare([]));
  t.after(() => first.close());
  const logs: string[] = [];
  const setup = await prepare([]);
  await assert.rejects(start(t, { ...setup, relayerConfig: { ...setup.relayerConfig, port: first.relayerPort } }, logs), /EADDRINUSE/);
  const issuerPort = Number(logs.find((l) => /issuer: listening on port/.test(l))!.match(/port (\d+)/)![1]);
  await assert.rejects(post(issuerPort, '/v1/nada', {}), 'the Issuer was closed');
});

test('closeTogether: closes everything at once and waits for all of it, even if something fails or throws (and warns)', async () => {
  const order: string[] = [];
  const logs: string[] = [];
  let release!: () => void;
  const slow = new Promise<void>((resolve) => { release = resolve; });
  const closing = closeTogether([
    async () => { order.push('slow starts'); await slow; order.push('slow ends'); },
    () => { order.push('sync'); },
    async () => { order.push('fails'); throw new Error('x'); },
    () => { throw new TypeError('throws /secret/path'); },
  ], capturingLogger(logs));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['slow starts', 'sync', 'fails'], 'does not wait for the slow one to start the others');
  release();
  await closing;
  assert.equal(order.at(-1), 'slow ends');
  assert.deepEqual(logs, ['warn closing failed (Error)', 'warn closing failed (TypeError)']);
});

test('roundReader: the RegistrySync round, with none read yet or with the sync stuck, "nobody waiting"', async () => {
  const waiting = () => ({ round: 4n, waiting: true });
  assert.deepEqual(await roundReader(waiting, () => true)(), { round: 4n, waiting: true });
  assert.deepEqual(await roundReader(() => undefined, () => true)(), { round: 0n, waiting: false });
  assert.deepEqual(await roundReader(waiting, () => false)(), { round: 0n, waiting: false }, 'the round may lag behind');
});
