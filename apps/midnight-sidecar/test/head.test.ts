// chain.head: the node's latest block time, read from the node over net.ts (no real network here).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setFetchForTests } from '../src/net.ts';
import { codes } from '../src/codes.ts';
import { decodeTimestamp, nodeHttpUrl, TIMESTAMP_NOW_KEY } from '../src/head.ts';
import { appError, ctx, json, ready } from './helpers.ts';

afterEach(() => setFetchForTests((...args) => fetch(...args)));

const vector = json('rpc/chain-head.json');

/** The node answers `answer` (a JSON-RPC body, or a Response); returns what was asked. */
function node(answer: unknown | (() => Response | Promise<Response>)) {
  const requests: { url: string; body: unknown; method?: string }[] = [];
  setFetchForTests(async (input, init = {}) => {
    requests.push({ url: String(input), body: JSON.parse(String(init.body)), method: init.method });
    if (typeof answer === 'function') return (answer as () => Response)();
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  return requests;
}

test('chain.head asks the node for Timestamp.Now and decodes it (the vector shared with Rust)', async () => {
  const requests = node({ jsonrpc: '2.0', id: 1, result: vector.storage });
  const h = await ready();
  assert.deepEqual(await h['chain.head']({}, ctx()), vector.result);
  assert.equal(requests.length, 1);
  // HTTP form of the configured node endpoint (ws://127.0.0.1:9944), and a request with only the fixed key.
  assert.equal(requests[0].url, 'http://127.0.0.1:9944/');
  assert.equal(requests[0].method, 'POST');
  assert.deepEqual(requests[0].body, vector.request);
  assert.equal(TIMESTAMP_NOW_KEY, vector.request.params[0]);
});

test('Timestamp.Now is a little-endian u64 in hex: anything else is an internal error', () => {
  assert.equal(decodeTimestamp('0x10f8c3eaa1010000'), 1_794_940_074_000);
  assert.equal(decodeTimestamp('0x0100000000000000'), 1);
  for (const bad of [null, 7, '', '0x', '10f8c3eaa1010000', '0x10f8c3eaa10100', '0x10f8c3eaa101000000', '0xzzf8c3eaa1010000',
    '0x0000000000000000', '0xffffffffffffffff']) {
    assert.throws(() => decodeTimestamp(bad), (e: any) => e.code === codes.APP_INTERNAL, String(bad));
  }
});

test('the node endpoint is used in its http(s) form', () => {
  assert.equal(nodeHttpUrl('ws://127.0.0.1:9944'), 'http://127.0.0.1:9944/');
  assert.equal(nodeHttpUrl('wss://node.example:443/rpc'), 'https://node.example/rpc');
  assert.equal(nodeHttpUrl('http://127.0.0.1:9944'), 'http://127.0.0.1:9944/');
});

test('a node that does not answer, answers an error or a non-200 is UPSTREAM_UNAVAILABLE; a bad value is internal', async () => {
  const h = await ready();
  const cases: [unknown, number][] = [
    [() => Promise.reject(new TypeError('fetch failed')), codes.UPSTREAM_UNAVAILABLE],
    [() => new Response('busy', { status: 503 }), codes.UPSTREAM_UNAVAILABLE],
    [{ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'x' } }, codes.UPSTREAM_UNAVAILABLE],
    [{ jsonrpc: '2.0', id: 1, result: null }, codes.APP_INTERNAL],
    [() => new Response('not json'), codes.APP_INTERNAL],
    [() => new Response('x'.repeat(5000)), codes.APP_INTERNAL],
  ];
  for (const [answer, code] of cases) {
    node(answer);
    assert.equal((await appError(h['chain.head']({}, ctx()) as Promise<unknown>)).code, code, String(answer));
  }
});
