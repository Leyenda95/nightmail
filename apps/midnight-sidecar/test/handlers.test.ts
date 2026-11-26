import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHandlers, type SidecarState } from '../src/handlers.ts';
import { setFetchForTests } from '../src/net.ts';
import { AppError, codes } from '../src/codes.ts';

const vectors = new URL('../../../packages/test-vectors/rpc/', import.meta.url);
const initParams = () => JSON.parse(readFileSync(new URL('initialize.json', vectors), 'utf8'));
const ctx = () => ({ signal: new AbortController().signal, requestId: 1, notify: () => {} });

async function code(p: Promise<unknown>): Promise<number> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof AppError, `AppError expected: ${e}`);
    return e.code;
  }
  assert.fail('an error was expected');
}

afterEach(() => setFetchForTests((...args) => fetch(...args)));

test('the codes match the vectors shared with Rust', () => {
  const expected = JSON.parse(readFileSync(new URL('error-codes.json', vectors), 'utf8'));
  assert.deepEqual({ ...codes }, expected);
});

test('no method works before initialize', async () => {
  const h = createHandlers({ initialized: null });
  assert.equal(await code(h.ping(null, ctx())), codes.NOT_INITIALIZED);
});

test('initialize with the example params', async () => {
  const state: SidecarState = { initialized: null };
  const h = createHandlers(state);
  const res = (await h.initialize(initParams(), ctx())) as { protocolVersion: string; methods: string[] };
  assert.equal(res.protocolVersion, '1.5');
  assert.deepEqual(res.methods.sort(),
    ['contract.findBonos', 'contract.hashes', 'contract.proveCall', 'contract.snapshot', 'initialize', 'ping',
      'wallet.balance', 'wallet.buyBono', 'wallet.close', 'wallet.faucet', 'wallet.open', 'wallet.registerDust', 'wallet.sync']);
  assert.ok(state.initialized);
});

test('initialize rejects another major version and accepts another minor one', async () => {
  const h = createHandlers({ initialized: null });
  assert.equal(await code(h.initialize({ ...initParams(), protocolVersion: '2.0' }, ctx())), codes.PROTOCOL_MISMATCH);
  assert.equal(await code(h.initialize({ ...initParams(), protocolVersion: '2.1' }, ctx())), codes.PROTOCOL_MISMATCH);
  for (const minor of ['1.0', '1.9']) await createHandlers({ initialized: null }).initialize({ ...initParams(), protocolVersion: minor }, ctx());
});

test('initialize rejects malformed params', async () => {
  const h = createHandlers({ initialized: null });
  for (const bad of [null, {}, { ...initParams(), network: 'mainnet' }, { ...initParams(), debug: 'yes' }]) {
    assert.equal(await code(h.initialize(bad, ctx())), codes.INVALID_PARAMS);
  }
});

// The prover receives the witnesses (the bono secret). Until the app can verify
// a TEE attestation, a remote one cannot be allowed.
test('initialize always rejects a remote proof server, even if permission is requested', async () => {
  const remote = { ...initParams(), endpoints: { ...initParams().endpoints, proofServer: 'https://prover.example.com' } };
  for (const params of [remote, { ...remote, allowRemoteProver: true }]) {
    assert.equal(await code(createHandlers({ initialized: null }).initialize(params, ctx())), codes.INVALID_CONFIG);
  }
});

const withProver = (proofServer: string) => ({ ...initParams(), endpoints: { ...initParams().endpoints, proofServer } });

test('proof server: loopback IPs only, without depending on name resolution', async () => {
  const rejected = [
    'http://127.0.0.1@evil.com:6300', // the part before @ is the user, the host is evil.com
    'http://127.0.0.1.evil.com:6300',
    'http://0.0.0.0:6300',
    'http://localhost:6300', // depends on the hosts file or DNS
    'http://10.0.0.5:6300',
  ];
  for (const url of rejected) {
    assert.equal(await code(createHandlers({ initialized: null }).initialize(withProver(url), ctx())), codes.INVALID_CONFIG, url);
  }
  for (const url of ['http://127.0.0.1:6300', 'http://[::1]:6300', 'http://127.1:6300']) {
    await createHandlers({ initialized: null }).initialize(withProver(url), ctx());
  }
});

// Only the validated origin reaches the prover client; a path, a query or credentials
// in the URL make no sense for a local service and are rejected.
test('proof server: the URL is only an origin (no user, password, path, query or fragment)', async () => {
  const rejected = [
    'http://user@127.0.0.1:6300', 'http://user:pw@127.0.0.1:6300', 'http://:pw@127.0.0.1:6300', 'http://127.0.0.1:6300/prove',
    'http://127.0.0.1:6300/a/', 'http://127.0.0.1:6300/?x=1', 'http://127.0.0.1:6300?x=1', 'http://127.0.0.1:6300/#frag',
  ];
  for (const url of rejected) {
    assert.equal(await code(createHandlers({ initialized: null }).initialize(withProver(url), ctx())), codes.INVALID_CONFIG, url);
  }
  for (const [url, origin] of [['http://127.0.0.1:6300', 'http://127.0.0.1:6300'], ['http://127.0.0.1:6300/', 'http://127.0.0.1:6300'],
    ['http://127.1:6300', 'http://127.0.0.1:6300'], ['https://[::1]:6300/', 'https://[::1]:6300']]) {
    const state: SidecarState = { initialized: null };
    await createHandlers(state).initialize(withProver(url), ctx());
    assert.equal(state.initialized!.endpoints.proofServer, origin, 'the normalized origin is stored');
  }
});

test('ping asks the validated proof server origin', async () => {
  const urls: string[] = [];
  setFetchForTests(async (url) => {
    urls.push(String(url));
    return new Response('9.0.2');
  });
  const h = createHandlers({ initialized: null });
  await h.initialize(withProver('http://127.1:6300/'), ctx());
  await h.ping(null, ctx());
  assert.ok(urls.includes('http://127.0.0.1:6300/version'), urls.join(' '));
});

// With NODE_USE_ENV_PROXY (or --use-env-proxy) Node's fetch would send requests, including the
// witnesses bound for the prover, to the HTTP(S)_PROXY proxy. The supervisor does not let those
// variables through; if someone launches the sidecar by hand with them, it refuses to initialize.
test('initialize refuses if the environment diverts fetch to a proxy', async () => {
  const init = () => createHandlers({ initialized: null }).initialize(initParams(), ctx());
  const saved = process.env.NODE_USE_ENV_PROXY;
  try {
    for (const on of ['1', 'true']) {
      process.env.NODE_USE_ENV_PROXY = on;
      assert.equal(await code(init()), codes.INVALID_CONFIG, on);
    }
    for (const off of ['', '0']) {
      process.env.NODE_USE_ENV_PROXY = off;
      await init();
    }
    delete process.env.NODE_USE_ENV_PROXY;
    await init();
    process.execArgv.push('--use-env-proxy');
    try {
      assert.equal(await code(init()), codes.INVALID_CONFIG, 'command-line option');
    } finally {
      process.execArgv.pop();
    }
  } finally {
    if (saved === undefined) delete process.env.NODE_USE_ENV_PROXY;
    else process.env.NODE_USE_ENV_PROXY = saved;
  }
});

// NODE_OPTIONS options do not show up in process.execArgv.
test('initialize also refuses with --use-env-proxy in NODE_OPTIONS (and not for similar options)', async () => {
  const init = () => createHandlers({ initialized: null }).initialize(initParams(), ctx());
  const saved = process.env.NODE_OPTIONS;
  try {
    for (const on of ['--use-env-proxy', '--max-old-space-size=4096 --use-env-proxy', '  --use-env-proxy  --no-warnings',
      '--use_env_proxy', '"--use-env-proxy"', "'--use-env-proxy'", '--use-env-proxy=1']) {
      process.env.NODE_OPTIONS = on;
      assert.equal(await code(init()), codes.INVALID_CONFIG, on);
    }
    for (const off of ['', '--max-old-space-size=4096', '--no-use-env-proxy', '--use-env-proxy-x']) {
      process.env.NODE_OPTIONS = off;
      await init();
    }
  } finally {
    if (saved === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = saved;
  }
});

test('initialize rejects endpoints with the wrong protocol', async () => {
  const bad = { ...initParams(), endpoints: { ...initParams().endpoints, indexerWs: 'http://127.0.0.1:8088' } };
  assert.equal(await code(createHandlers({ initialized: null }).initialize(bad, ctx())), codes.INVALID_CONFIG);
});

async function pingWith(fake: typeof fetch) {
  setFetchForTests(fake);
  const h = createHandlers({ initialized: null });
  await h.initialize(initParams(), ctx());
  return (await h.ping(null, ctx())) as { pong: boolean; proofServer: boolean; indexer: boolean };
}

test('ping with everything available', async () => {
  const res = await pingWith(async (url) =>
    String(url).endsWith('/version')
      ? new Response('9.0.0')
      : Response.json({ data: { block: { height: 3 } } }),
  );
  assert.deepEqual([res.pong, res.proofServer, res.indexer], [true, true, true]);
});

test('ping: GraphQL with errors and HTTP 200 does not count as available', async () => {
  const res = await pingWith(async (url) =>
    String(url).endsWith('/version') ? new Response('9.0.0') : Response.json({ errors: [{ message: 'x' }] }),
  );
  assert.equal(res.indexer, false);
});

test('ping: the indexer answers with an HTTP error → unavailable, even if the body looks fine', async () => {
  const res = await pingWith(async (url) =>
    String(url).endsWith('/version')
      ? new Response('9.0.0')
      : Response.json({ data: { block: { height: 3 } } }, { status: 503 }),
  );
  assert.deepEqual([res.proofServer, res.indexer], [true, false]);
});

test('ping: network errors → unavailable, without throwing', async () => {
  const res = await pingWith(async () => { throw new TypeError('fetch failed'); });
  assert.deepEqual([res.pong, res.proofServer, res.indexer], [true, false, false]);
});
