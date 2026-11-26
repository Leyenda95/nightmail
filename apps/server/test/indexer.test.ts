import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { IndexerError, IndexerUnavailable } from '@nightmail/midnight';
import { contractActionSource, httpGraphQL, toNotice } from '../src/registry/indexer.ts';
import type { ActionNotice } from '../src/registry/sync.ts';

const ADDRESS = 'ab'.repeat(32);
const HASH = 'cd'.repeat(32);
const noop = () => {};
const action = (height: number, typename = 'ContractCall', entryPoint: unknown = 'createAlias') =>
  ({ __typename: typename, stateAt: { height, hash: HASH }, ...(entryPoint !== null && { entryPoint }) });
const result = (contractActions: unknown) => ({ data: { contractActions } });

test('toNotice: a call carries its circuit, a deploy or an update gives null', () => {
  assert.deepEqual(toNotice(result(action(7))), { height: 7, hash: HASH, entryPoint: 'createAlias' });
  assert.deepEqual(toNotice(result(action(0, 'ContractDeploy', null))), { height: 0, hash: HASH, entryPoint: null });
  assert.deepEqual(toNotice(result(action(9, 'ContractUpdate', null))), { height: 9, hash: HASH, entryPoint: null });
});

test('toNotice: rejects anything without the expected shape', () => {
  const malformed = [
    null, {}, { data: null }, result(null), result({}),
    result({ ...action(7), stateAt: null }),
    result({ ...action(7), stateAt: { height: -1, hash: HASH } }),
    result({ ...action(7), stateAt: { height: 1.5, hash: HASH } }),
    result({ ...action(7), stateAt: { height: '7', hash: HASH } }),
    result({ ...action(7), stateAt: { height: 7, hash: 'CD'.repeat(32) } }),
    result({ ...action(7), stateAt: { height: 7, hash: HASH.slice(2) } }),
    result({ ...action(7), stateAt: { height: 7 } }),
    result(action(7, 'ContractCall', null)),
    result(action(7, 'ContractCall', 5)),
  ];
  for (const value of malformed) assert.throws(() => toNotice(value), IndexerError, JSON.stringify(value));
  assert.throws(() => toNotice({ data: null, errors: [{ message: 'x' }] }), IndexerUnavailable);
});

// --- httpGraphQL ---

type Call = { url: string; init: RequestInit };
function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond({ url, init });
  }) as typeof fetch;
  return { calls, fetchFn };
}

test('httpGraphQL: sends the query by POST without following redirects and returns the JSON body', async () => {
  const { calls, fetchFn } = fakeFetch(() => Response.json({ data: { block: { height: 3 } } }));
  const gql = httpGraphQL('http://indexer.test/graphql', { fetchFn });
  assert.deepEqual(await gql('{ block { height } }', { a: 1 }), { data: { block: { height: 3 } } });
  assert.equal(calls[0]!.url, 'http://indexer.test/graphql');
  assert.equal(calls[0]!.init.method, 'POST');
  assert.equal(calls[0]!.init.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { query: '{ block { height } }', variables: { a: 1 } });
  assert.equal((calls[0]!.init.headers as Record<string, string>)['content-type'], 'application/json');
  assert.ok(calls[0]!.init.signal instanceof AbortSignal);
});

test('httpGraphQL: an HTTP error status or a network failure is IndexerUnavailable, without echoing the URL', async () => {
  const secret = 'http://indexer.test/graphql?project_id=SECRETO';
  const down = httpGraphQL(secret, { fetchFn: fakeFetch(() => new Response('no', { status: 503 })).fetchFn });
  await assert.rejects(down('{}', {}), (e: Error) => e instanceof IndexerUnavailable && e.message === 'indexer: HTTP 503');
  const broken = httpGraphQL(secret, { fetchFn: fakeFetch(() => { throw new TypeError(`fetch failed ${secret}`); }).fetchFn });
  await assert.rejects(broken('{}', {}), (e: Error) => e instanceof IndexerUnavailable && !e.message.includes('SECRETO') && e.cause === undefined);
});

test('httpGraphQL: aborts on timeout and enforces the size cap', async () => {
  const slow = fakeFetch(({ init }) => new Promise<Response>((_, reject) => {
    init.signal!.addEventListener('abort', () => reject(new DOMException('timeout', 'TimeoutError')));
  }));
  await assert.rejects(httpGraphQL('http://indexer.test', { fetchFn: slow.fetchFn, timeoutMs: 20 })('{}', {}), IndexerUnavailable);
  const big = fakeFetch(() => new Response(JSON.stringify({ data: 'x'.repeat(200) })));
  await assert.rejects(httpGraphQL('http://indexer.test', { fetchFn: big.fetchFn, maxBytes: 100 })('{}', {}), IndexerError);
  const text = fakeFetch(() => new Response('<html>'));
  await assert.rejects(httpGraphQL('http://indexer.test', { fetchFn: text.fetchFn })('{}', {}), IndexerError);
});

// --- contractActionSource against a fake indexer (graphql-transport-ws) ---

type Behaviour = { actions: unknown[]; then?: 'complete' | 'error' | 'close' | 'stay'; answerPings?: boolean };

async function fakeIndexer(behaviours: Behaviour[]) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const subscriptions: { query: string; variables: unknown }[] = [];
  const protocols: string[] = [];
  let pings = 0;
  server.on('connection', (socket) => {
    protocols.push(socket.protocol);
    const behaviour = behaviours.shift() ?? { actions: [] };
    const send = (message: unknown) => socket.send(JSON.stringify(message));
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'connection_init') send({ type: 'connection_ack' });
      if (message.type === 'ping') {
        pings++;
        if (behaviour.answerPings !== false) send({ type: 'pong' });
      }
      if (message.type !== 'subscribe') return;
      subscriptions.push(message.payload);
      for (const a of behaviour.actions) send({ id: message.id, type: 'next', payload: { data: { contractActions: a } } });
      if (behaviour.then === 'complete') send({ id: message.id, type: 'complete' });
      if (behaviour.then === 'error') send({ id: message.id, type: 'error', payload: [{ message: 'boom' }] });
      if (behaviour.then === 'close') socket.close(1011, 'internal error');
    });
  });
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/graphql/ws?project_id=SECRETO`;
  return { url: () => url, subscriptions, protocols, pings: () => pings, close: () => new Promise<void>((resolve) => { for (const c of server.clients) c.terminate(); server.close(() => resolve()); }) };
}

const servers: { close(): Promise<void> }[] = [];
after(async () => { for (const s of servers) await s.close(); });
async function indexerWith(...behaviours: Behaviour[]) {
  const indexer = await fakeIndexer(behaviours);
  servers.push(indexer);
  return indexer;
}

async function collect(source: AsyncIterable<ActionNotice>): Promise<ActionNotice[]> {
  const notices: ActionNotice[] = [];
  for await (const notice of source) notices.push(notice);
  return notices;
}

test('the subscription asks only for what it needs, from the given height, and delivers the actions in order', async () => {
  const indexer = await indexerWith({ actions: [action(5, 'ContractDeploy', null), action(6, 'ContractCall', 'advanceRound'), action(6)], then: 'complete' });
  const source = contractActionSource(indexer.url(), ADDRESS);
  const notices = await collect(source(5, new AbortController().signal, noop));
  assert.deepEqual(notices, [
    { height: 5, hash: HASH, entryPoint: null },
    { height: 6, hash: HASH, entryPoint: 'advanceRound' },
    { height: 6, hash: HASH, entryPoint: 'createAlias' },
  ]);
  assert.deepEqual(indexer.protocols, ['graphql-transport-ws']);
  const [subscription] = indexer.subscriptions;
  assert.deepEqual(subscription!.variables, { address: ADDRESS, offset: { height: 5 } });
  const fields = subscription!.query.replace(/\s+/g, ' ');
  assert.match(fields, /contractActions\(address: \$address, offset: \$offset\) \{ __typename stateAt \{ height hash \} \.\.\. on ContractCall \{ entryPoint \} \}/);
  assert.doesNotMatch(subscription!.query, /\bstate\b(?!At)/, 'the state is not requested');
});

test('each call opens a new subscription from its height', async () => {
  const indexer = await indexerWith({ actions: [action(1)], then: 'complete' }, { actions: [action(9)], then: 'complete' });
  const source = contractActionSource(indexer.url(), ADDRESS);
  assert.equal((await collect(source(0, new AbortController().signal, noop)))[0]!.height, 1);
  assert.equal((await collect(source(9, new AbortController().signal, noop)))[0]!.height, 9);
  assert.deepEqual(indexer.subscriptions.map((s) => (s.variables as { offset: unknown }).offset), [{ height: 0 }, { height: 9 }]);
});

for (const then of ['error', 'close'] as const) {
  test(`an indexer failure (${then}) ends the subscription with IndexerUnavailable, after delivering what was received and without echoing the URL`, async () => {
    const indexer = await indexerWith({ actions: [action(3)], then });
    const source = contractActionSource(indexer.url(), ADDRESS);
    const seen: ActionNotice[] = [];
    await assert.rejects(async () => {
      for await (const notice of source(0, new AbortController().signal, noop)) seen.push(notice);
    }, (e: Error) => e instanceof IndexerUnavailable && !e.message.includes('SECRETO'));
    assert.equal(seen.length, 1);
  });
}

test('a malformed action ends the subscription', async () => {
  const indexer = await indexerWith({ actions: [action(3), { __typename: 'ContractCall' }], then: 'stay' });
  const source = contractActionSource(indexer.url(), ADDRESS);
  await assert.rejects(collect(source(0, new AbortController().signal, noop)), IndexerError);
});

test('with no indexer on the other side, fails with IndexerUnavailable', async () => {
  const indexer = await indexerWith();
  const url = indexer.url();
  await indexer.close();
  await assert.rejects(collect(contractActionSource(url, ADDRESS)(0, new AbortController().signal, noop)), IndexerUnavailable);
});

test('aborting the signal closes the subscription even if nothing else arrives', async () => {
  const indexer = await indexerWith({ actions: [action(3)], then: 'stay' });
  const controller = new AbortController();
  const seen: ActionNotice[] = [];
  const t0 = performance.now();
  try {
    for await (const notice of contractActionSource(indexer.url(), ADDRESS)(0, controller.signal, noop)) {
      seen.push(notice);
      setTimeout(() => controller.abort(), 10);
    }
  } catch (error) {
    assert.ok(error instanceof IndexerUnavailable, String(error));
  }
  assert.equal(seen.length, 1);
  assert.ok(performance.now() - t0 < 3000);
});

test('an indexer that stops answering pings is considered lost (connecting is not a sign of life)', async () => {
  const indexer = await indexerWith({ actions: [action(3)], then: 'stay', answerPings: false });
  const source = contractActionSource(indexer.url(), ADDRESS, { keepAliveMs: 30, pongTimeoutMs: 40 });
  let alive = 0;
  const t0 = performance.now();
  await assert.rejects(collect(source(0, new AbortController().signal, () => { alive++; })), IndexerUnavailable);
  assert.ok(indexer.pings() >= 1);
  assert.equal(alive, 0, 'neither the connection nor any pong');
  assert.ok(performance.now() - t0 < 3000);
});

test('an indexer that answers pings stays connected, and each pong is a sign of life', async () => {
  const indexer = await indexerWith({ actions: [action(3)], then: 'stay' });
  const controller = new AbortController();
  const source = contractActionSource(indexer.url(), ADDRESS, { keepAliveMs: 20, pongTimeoutMs: 40 });
  const seen: ActionNotice[] = [];
  let alive = 0;
  setTimeout(() => controller.abort(), 200);
  try {
    for await (const notice of source(0, controller.signal, () => { alive++; })) seen.push(notice);
  } catch (error) {
    assert.ok(error instanceof IndexerUnavailable, String(error));
  }
  assert.ok(indexer.pings() >= 3, 'stayed alive for several pings');
  assert.ok(alive >= 2 && alive >= indexer.pings() - 1, `${alive} signals (pongs) for ${indexer.pings()} pings`);
  assert.equal(seen.length, 1);
});

test('httpGraphQL: aborting the given signal cancels the request in progress without waiting for the timeout', async () => {
  const hanging = fakeFetch(({ init }) => new Promise<Response>((_, reject) => {
    init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }));
  const stop = new AbortController();
  const gql = httpGraphQL('http://indexer.test', { fetchFn: hanging.fetchFn, timeoutMs: 60_000, signal: stop.signal });
  const t0 = performance.now();
  setTimeout(() => stop.abort(), 10);
  await assert.rejects(gql('{}', {}), IndexerUnavailable);
  assert.ok(performance.now() - t0 < 1000);
});
