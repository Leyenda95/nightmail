// Tests against the real process (node src/index.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const root = fileURLToPath(new URL('..', import.meta.url));
const init = JSON.parse(readFileSync(new URL('../../../packages/test-vectors/rpc/initialize.json', import.meta.url), 'utf8'));
// Closed ports: independent of the devnet.
init.endpoints.proofServer = 'http://127.0.0.1:9';
init.endpoints.indexer = 'http://127.0.0.1:9/graphql';

test('initialize + ping and clean exit on EOF', async () => {
  const child = spawn(process.execPath, ['src/index.ts'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.setEncoding('utf8').on('data', (c: string) => (out += c));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: init }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n');
  child.stdin.end();
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 0);
  const lines = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2, `stdout must only have responses: ${out}`);
  const ping = lines.find((l) => l.id === 2);
  assert.equal(ping.result.pong, true);
  assert.equal(ping.result.proofServer, false);
});

test('contract.findBonos and contract.proveCall are served by the real process (with the SDK loaded)', async () => {
  const child = spawn(process.execPath, ['src/index.ts'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.setEncoding('utf8').on('data', (c: string) => (out += c));
  const send = (id: number, method: string, params: unknown) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  const contractAddress = 'ad'.repeat(32);
  send(1, 'initialize', init);
  send(2, 'contract.findBonos', { contractAddress, leaves: ['ee'.repeat(32)] });
  send(3, 'contract.proveCall', { contractAddress, circuit: 'createAlias', args: { encPk: 'e1'.repeat(32), authPk: 'a7'.repeat(32) },
    witnesses: { s: '51'.repeat(32), k: 0, plan: 'free', validUntil: 4294967295, j: 0 } });
  send(4, 'contract.proveCall', { contractAddress, circuit: 'buyBono', args: {} });
  child.stdin.end();
  assert.equal(await new Promise((resolve) => child.on('exit', resolve)), 0);
  const lines = out.trim().split('\n').map((l) => JSON.parse(l));
  const answer = (id: number) => lines.find((l) => l.id === id);
  assert.ok(answer(1).result.methods.includes('contract.proveCall'));
  // The indexer is a closed port: both methods reach it and give a public error, with no extra noise.
  assert.deepEqual(answer(2).error, { code: -32006, message: 'Indexer unavailable' });
  assert.deepEqual(answer(3).error, { code: -32006, message: 'Indexer unavailable' });
  assert.deepEqual(answer(4).error, { code: -32602, message: 'Invalid params' });
  assert.deepEqual(lines.filter((l) => l.id === undefined), [{ jsonrpc: '2.0', method: 'progress', params: { requestId: 3, stage: 'reading-state', percent: null } }]);
});

test('hardened stdout: console.log from a dependency goes to stderr', () => {
  const script = `
    const { protocolOut } = await import('./src/stdio.ts');
    console.log('noise from a dependency');
    process.stdout.write('más ruido\\n');
    protocolOut.write('PROTOCOLO\\n');
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'PROTOCOLO\n');
  assert.match(r.stderr, /noise from a dependency/);
  assert.match(r.stderr, /más ruido/);
});
