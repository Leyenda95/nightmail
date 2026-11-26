import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { installOutputRedaction, makeRedactor } from '../src/redact.ts';
import { loadConfig, parseNetwork, walletSeedSource } from '../src/config.ts';

const SECRET = 'nightpreprodFAKEfakeFAKE12345';

test('hides the secret in every format it can appear in', () => {
  const redact = makeRedactor([SECRET]);
  const url = new URL(`wss://rpc.example.io/?project_id=${SECRET}`);
  const samples = [
    `disconnected from ${url.href}: 1006`,
    inspect(url), // URLSearchParams { 'project_id' => '…' }
    inspect(new Error(`boom ${url.href}`)),
    JSON.stringify({ project_id: SECRET }),
    encodeURIComponent(`project_id=${SECRET}`),
  ];
  for (const s of samples) {
    assert.ok(s.includes(SECRET), 'the sample contains the secret');
    assert.ok(!redact(s).includes(SECRET), `not hidden: ${s}`);
  }
});

test('installOutputRedaction filters text and buffers', () => {
  const written: unknown[] = [];
  const fake = { write: (chunk: unknown) => { written.push(chunk); return true; } };
  installOutputRedaction([SECRET], [fake]);
  fake.write(`a ${SECRET} b` as never);
  fake.write(Buffer.from(`c ${SECRET}`) as never);
  assert.deepEqual(written, ['a *** b', 'c ***']);
});

test('loadConfig: preprod requires the project_id, exposes it only as a secret and not in process.env', () => {
  process.env['BLOCKFROST_PROJECT_ID'] = 'exportado-por-error';
  assert.throws(() => loadConfig('preprod', {}), /BLOCKFROST_PROJECT_ID is required/);
  assert.equal(process.env['BLOCKFROST_PROJECT_ID'], undefined, 'it is removed from the environment');
  const cfg = loadConfig('preprod', { BLOCKFROST_PROJECT_ID: SECRET });
  assert.deepEqual(cfg.secrets, [SECRET]);
  assert.ok(cfg.relayURL.includes(`project_id=${SECRET}`));
});

test('operator wallet: on the devnet it uses the genesis seed (funded), on preprod a random one', () => {
  const random = () => new Uint8Array(32).fill(5);
  assert.equal(Buffer.from(walletSeedSource('undeployed', random)()).toString('hex'), '0'.repeat(63) + '1');
  assert.deepEqual(walletSeedSource('preprod', random)(), random());
});

test('parseNetwork rejects unknown networks', () => {
  assert.equal(parseNetwork(undefined), 'preprod');
  assert.equal(parseNetwork('undeployed'), 'undeployed');
  assert.throws(() => parseNetwork('mainnet; rm -rf /'), /Unsupported network/);
  assert.throws(() => parseNetwork(''), /Unsupported network/, 'an empty variable does not pick a network on its own');
});
