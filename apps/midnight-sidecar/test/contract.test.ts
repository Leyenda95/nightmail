// contract.hashes and contract.snapshot (with a fake indexer behind net.ts).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ContractState } from '@midnight-ntwrk/compact-runtime';
import { createHandlers } from '../src/handlers.ts';
import { setFetchForTests } from '../src/net.ts';
import { AppError, codes } from '../src/codes.ts';
import { contractHandlers, MAX_HASH_OPS, MAX_SNAPSHOT_LIMIT } from '../src/contract.ts';
import type { ContractSnapshot } from '../src/protocol/ContractSnapshot.ts';
// Real NightMailRegistry state built with the simulator (helper from the package's tests).
import { hex, registryState } from '../../../packages/midnight/test/helpers.ts';

const vectors = new URL('../../../packages/test-vectors/', import.meta.url);
const json = (path: string) => JSON.parse(readFileSync(new URL(path, vectors), 'utf8'));
const ctx = (signal = new AbortController().signal) => ({ signal, requestId: 1, notify: () => {} });
const ADDRESS = 'ad'.repeat(32);
const INDEXER = json('rpc/initialize.json').endpoints.indexer;

async function ready(indexer = INDEXER) {
  const h = createHandlers({ initialized: null });
  const init = json('rpc/initialize.json');
  await h.initialize({ ...init, endpoints: { ...init.endpoints, indexer } }, ctx());
  return h;
}
type Handlers = Awaited<ReturnType<typeof ready>>;

/** Error the promise rejects with (fails if it does not reject). */
async function failure(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  assert.fail('an error was expected');
}
async function code(p: Promise<unknown>): Promise<number> {
  const e = await failure(p);
  assert.ok(e instanceof AppError, `AppError expected: ${e}`);
  return e.code;
}

afterEach(() => setFetchForTests((...args) => fetch(...args)));

// --- contract.hashes ------------------------------------------------------------------------------

test('contract.hashes reproduces the RPC vector shared with Rust', async () => {
  const v = json('rpc/contract-hashes.json');
  assert.deepEqual(await (await ready())['contract.hashes'](v.params, ctx()), v.result);
});

test('the hashes RPC vector matches the contract vectors', () => {
  const rpc = json('rpc/contract-hashes.json').result.results;
  const c = json('contract/registry.json');
  assert.deepEqual(rpc, [c.bonoId, c.bonoLeafFree, c.bonoLeafPaid, c.slotNullifierMailbox3, c.slotNullifierAlias3,
    c.slotNullifierMailbox3Gen1, 'juan.perez', c.addressKey, c.aliasKey, c.nameCommit, 'around.rubber.hc9n6db283sn']);
});

test('contract.hashes exige initialize', async () => {
  const v = json('rpc/contract-hashes.json');
  assert.equal(await code(createHandlers({ initialized: null })['contract.hashes'](v.params, ctx())), codes.NOT_INITIALIZED);
});

test('contract.hashes rejects malformed params with a fixed message', async () => {
  const h = await ready();
  const { params } = json('rpc/contract-hashes.json');
  const op = (o: object | null) => ({ ...params, ops: [o] });
  const s = '51'.repeat(32);
  const bad = [
    null, [], {}, { ...params, ops: [] }, { ...params, ops: 'x' }, { ...params, contractAddress: 'AD'.repeat(32) },
    { ops: params.ops }, { ...params, ops: new Array(MAX_HASH_OPS + 1).fill(params.ops[0]) },
    op({ op: 'nope' }), op({ op: 'toString' }), op({}), op(null), op({ op: 'idK', s, k: -1 }), op({ op: 'idK', s, k: '1' }),
    op({ op: 'idK', s: 'AB'.repeat(32), k: 1 }), op({ op: 'leaf', id: s, plan: 'gold', validUntil: 0 }),
    op({ op: 'leaf', id: s, plan: ['free'], validUntil: 0 }), op({ op: 'leaf', id: s, plan: 'free', validUntil: 2 ** 32 }),
    op({ op: 'slotNul', s, kind: 'alias', j: 256, gen: 0 }), op({ op: 'slotNul', s, kind: 'toString', j: 0, gen: 0 }),
    op({ op: 'addrKey' }), op({ op: 'normalizeName', name: 7 }), op({ op: 'aliasAddress', addrKey: 'ab' }),
  ];
  for (const p of bad) {
    const err = await failure(h['contract.hashes'](p, ctx()));
    assert.ok(err instanceof AppError, String(bad.indexOf(p)));
    assert.deepEqual([err.code, err.message], [codes.INVALID_PARAMS, 'Invalid params']);
  }
  const max = { ...params, ops: new Array(MAX_HASH_OPS).fill(params.ops[0]) };
  assert.equal(((await h['contract.hashes'](max, ctx())) as { results: string[] }).results.length, MAX_HASH_OPS);
});

test('normalizeName and addrKey apply the name rules: NAME_REJECTED with the reason in data', async () => {
  const h = await ready();
  const { params } = json('rpc/contract-hashes.json');
  const cases = [['josé', 'invalid'], ['a--b', 'invalid'], ['juan.perez.abcdefghijkl', 'alias-form'], ['Postmaster', 'reserved']];
  for (const op of ['normalizeName', 'addrKey']) {
    for (const [name, reason] of cases) {
      const err = await failure(h['contract.hashes']({ ...params, ops: [{ op, name }] }, ctx()));
      assert.deepEqual([err.code, err.message, err.data], [codes.NAME_REJECTED, 'Name rejected', { reason }], `${op} ${name}`);
    }
  }
});

test('the name error matches the RPC vector shared with Rust', async () => {
  const v = json('rpc/name-rejected.json');
  const { params } = json('rpc/contract-hashes.json');
  const err = await failure((await ready())['contract.hashes']({ ...params, ops: [v.request] }, ctx()));
  assert.deepEqual({ code: err.code, message: err.message, data: err.data }, v.error);
});

// --- contract.snapshot ----------------------------------------------------------------------------

const hashAt = (h: number) => h.toString(16).padStart(64, '0');
const timeAt = (h: number) => 1_800_000_000_000 + h * 6000;

/** Fake indexer: latest block `tip`, and the registry exists since `since`. */
function fakeIndexer(stateHex: string, tip = 100, since = 10) {
  const requests: { url: string; variables: Record<string, unknown> }[] = [];
  setFetchForTests(async (url, init) => {
    const { variables } = JSON.parse(String(init?.body));
    requests.push({ url: String(url), variables });
    if (!variables.offset) return Response.json({ data: { block: { height: tip } } });
    const h = variables.offset.height;
    const block = { height: h, hash: hashAt(h), timestamp: timeAt(h) };
    return Response.json({ data: { block, contract: h >= since ? { state: stateHex } : null } });
  });
  return requests;
}

/** Walks every page and joins the collections. */
async function allPages(h: Handlers, limit: number) {
  const pages: ContractSnapshot[] = [];
  let cursor: unknown = undefined;
  do {
    const p = (await h['contract.snapshot']({ contractAddress: ADDRESS, cursor, limit }, ctx())) as ContractSnapshot;
    pages.push(p);
    cursor = p.next;
  } while (cursor);
  return pages;
}

test('contract.snapshot: all pages from the same block and, together, the full state', async () => {
  const { stateHex, expected } = await registryState();
  const requests = fakeIndexer(stateHex);
  const h = await ready();
  const pages = await allPages(h, 1);
  assert.equal(pages.length, 3, 'the longest collection (3 nullifiers) sets the pages');
  assert.ok(pages.every((p) => p.blockHeight === 100 && p.blockHash === hashAt(100) && p.blockTimestamp === timeAt(100)));
  const first = pages[0];
  assert.deepEqual([first.round, first.price], [expected.round.toString(), '8']);
  assert.deepEqual(first.oldPrices, expected.oldPrices.map((o) => ({ price: '5', until: o.until.toString() })));
  assert.deepEqual(first.bonos, { leafCount: 1, root: expected.bonos.root.toString() });
  assert.deepEqual(first.totals, { slotNullifiers: 3, addresses: 2, pendingNames: 1 });
  assert.deepEqual(pages.flatMap((p) => p.pendingNames),
    expected.pendingNames.map((p) => ({ ...p, reservedRound: p.reservedRound.toString() })));
  assert.deepEqual(pages.flatMap((p) => p.slotNullifiers), expected.slotNullifiers);
  assert.deepEqual(pages.flatMap((p) => p.addresses), expected.addresses.map((a) => ({ ...a, kind: 'alias' })));
  assert.deepEqual(pages.at(-1)!.next, null);
  // One request for the latest block and another for the state at it; later pages do not ask again.
  assert.deepEqual(requests.map((r) => r.variables.offset ?? null), [null, { height: 100 }]);
  assert.ok(requests.every((r) => r.url === INDEXER));
});

test('contract.snapshot paginates each collection with its offset and stops returning those already finished', async () => {
  const { stateHex } = await registryState();
  fakeIndexer(stateHex);
  const h = await ready();
  await h['contract.snapshot']({ contractAddress: ADDRESS }, ctx());
  const at = (cursor: object) => h['contract.snapshot']({ contractAddress: ADDRESS, cursor, limit: 1 }, ctx()) as Promise<ContractSnapshot>;
  // Only addresses remain: the next cursor continues with them alone.
  const onlyAddresses = await at({ blockHeight: 100, slotNullifiers: null, addresses: 0, pendingNames: null });
  assert.deepEqual([onlyAddresses.slotNullifiers.length, onlyAddresses.addresses.length, onlyAddresses.pendingNames.length], [0, 1, 0]);
  assert.deepEqual(onlyAddresses.next, { blockHeight: 100, slotNullifiers: null, addresses: 1, pendingNames: null });
  const onlyPending = await at({ blockHeight: 100, slotNullifiers: null, addresses: null, pendingNames: 0 });
  assert.deepEqual([onlyPending.pendingNames.length, onlyPending.next], [1, null]);
  const done = await at({ blockHeight: 100, slotNullifiers: null, addresses: 1, pendingNames: null });
  assert.deepEqual([done.addresses.length, done.next], [1, null]);
  const past = await at({ blockHeight: 100, slotNullifiers: 5, addresses: 5, pendingNames: 5 });
  assert.deepEqual([past.slotNullifiers, past.addresses, past.pendingNames, past.next], [[], [], [], null]);
});

test('contract.snapshot with the shape of the RPC vector shared with Rust', async () => {
  const { stateHex } = await registryState();
  fakeIndexer(stateHex);
  const page = await (await ready())['contract.snapshot']({ contractAddress: ADDRESS, limit: 1 }, ctx());
  const shape = (v: unknown): unknown => Array.isArray(v) ? v.slice(0, 1).map(shape)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : typeof v;
  const example = json('rpc/contract-snapshot.json').result;
  const { next, ...rest } = page as ContractSnapshot;
  const { next: exampleNext, ...exampleRest } = example;
  assert.deepEqual(shape(rest), shape(exampleRest));
  assert.deepEqual(Object.keys(next!).sort(), Object.keys(exampleNext).sort(), 'the cursor has the same fields (offsets: number or null)');
  assert.equal(example.addresses[0].nameCipher.length, 208, 'nameCipher: 104 bytes');
});

test('contract.snapshot: no contract, or the state of another contract → CONTRACT_NOT_FOUND', async () => {
  const { stateHex } = await registryState();
  for (const [state, since] of [[stateHex, 1000], [hex(new ContractState().serialize()), 0]] as const) {
    fakeIndexer(state, 100, since);
    const err = await failure((await ready())['contract.snapshot']({ contractAddress: ADDRESS }, ctx()));
    assert.deepEqual([err.code, err.message], [codes.CONTRACT_NOT_FOUND, 'Contract not found']);
  }
});

test('contract.snapshot: malformed params → INVALID_PARAMS, without initialize → NOT_INITIALIZED', async () => {
  fakeIndexer('00');
  const h = await ready();
  const cursor = { blockHeight: 100, slotNullifiers: 0, addresses: 0, pendingNames: 0 };
  const bad = [
    null, [], {}, { contractAddress: 'AD'.repeat(32) }, { contractAddress: ADDRESS, limit: 0 },
    { contractAddress: ADDRESS, limit: MAX_SNAPSHOT_LIMIT + 1 }, { contractAddress: ADDRESS, limit: '5' },
    { contractAddress: ADDRESS, cursor: 'x' }, { contractAddress: ADDRESS, cursor: { ...cursor, blockHeight: -1 } },
    { contractAddress: ADDRESS, cursor: { ...cursor, blockHeight: 1.5 } }, { contractAddress: ADDRESS, cursor: { ...cursor, addresses: -1 } },
    { contractAddress: ADDRESS, cursor: { ...cursor, pendingNames: 'a' } }, { contractAddress: ADDRESS, cursor: { blockHeight: 1 } },
    { contractAddress: ADDRESS, cursor: { slotNullifiers: 0, addresses: 0, pendingNames: 0 } },
    { contractAddress: ADDRESS, cursor: { ...cursor, blockHeight: null } }, { contractAddress: ADDRESS, cursor: { ...cursor, blockHeight: '100' } },
  ];
  for (const p of bad) assert.equal(await code(h['contract.snapshot'](p, ctx())), codes.INVALID_PARAMS, JSON.stringify(p));
  assert.equal(await code(createHandlers({ initialized: null })['contract.snapshot']({ contractAddress: ADDRESS }, ctx())),
    codes.NOT_INITIALIZED);
});

test('contract.snapshot: a cursor whose state the sidecar no longer has → SNAPSHOT_EXPIRED', async () => {
  const { stateHex } = await registryState();
  const requests = fakeIndexer(stateHex);
  const cursor = { blockHeight: 100, slotNullifiers: 0, addresses: 0, pendingNames: 0 };
  const h = await ready();
  const expired = async (handlers: Handlers, params: object) => {
    const err = await failure(handlers['contract.snapshot'](params, ctx()));
    assert.deepEqual([err.code, err.message], [codes.SNAPSHOT_EXPIRED, 'Snapshot expired'], JSON.stringify(params));
  };
  await expired(h, { contractAddress: ADDRESS, cursor }); // never read
  await h['contract.snapshot']({ contractAddress: ADDRESS }, ctx());
  await h['contract.snapshot']({ contractAddress: ADDRESS, cursor }, ctx());
  await expired(h, { contractAddress: ADDRESS, cursor: { ...cursor, blockHeight: 99 } });
  await expired(h, { contractAddress: 'ae'.repeat(32), cursor });
  assert.equal(requests.length, 2, 'pages with a cursor do not go to the indexer');
  // another indexer (initialize again with another URL): another state
  const other = createHandlers({ initialized: null });
  const init = json('rpc/initialize.json');
  await other.initialize(init, ctx());
  await other['contract.snapshot']({ contractAddress: ADDRESS }, ctx());
  await other.initialize({ ...init, endpoints: { ...init.endpoints, indexer: 'http://127.0.0.1:9999/graphql' } }, ctx());
  await expired(other, { contractAddress: ADDRESS, cursor });
});

test('contract.snapshot: indexer down (network, 5xx, GraphQL errors) → UPSTREAM_UNAVAILABLE', async () => {
  const fails: (() => Promise<Response>)[] = [
    async () => { throw new TypeError('fetch failed'); },
    async () => new Response('boom', { status: 502 }),
    async () => new Response('boom', { status: 500 }),
    async () => new Response('slow down', { status: 429 }),
    async () => Response.json({ errors: [{ message: 'x' }], data: null }),
  ];
  for (const f of fails) {
    setFetchForTests(f);
    const err = await failure((await ready())['contract.snapshot']({ contractAddress: ADDRESS }, ctx()));
    assert.deepEqual([err.code, err.message], [codes.UPSTREAM_UNAVAILABLE, 'Indexer unavailable']);
  }
});

test('contract.snapshot: indexer response that is not understood → internal error (not AppError)', async () => {
  const odd: (() => Promise<Response>)[] = [
    async () => new Response('nope', { status: 404 }),
    async () => new Response('{not json'),
    async () => Response.json({ data: { block: { height: 'x' } } }),
  ];
  for (const f of odd) {
    setFetchForTests(f);
    const err = await failure((await ready())['contract.snapshot']({ contractAddress: ADDRESS }, ctx()));
    assert.ok(err instanceof Error && !(err instanceof AppError), String(err));
  }
});

test('contract.snapshot: a response larger than the cap is not read in full', async () => {
  const { stateHex } = await registryState();
  fakeIndexer(stateHex);
  for (const max of [1000, 0]) {
    const h = contractHandlers(() => INDEXER, { maxIndexerResponseBytes: max });
    const err = await failure(h['contract.snapshot']({ contractAddress: ADDRESS }, ctx()));
    assert.ok(err instanceof Error && !(err instanceof AppError) && /too large/.test(err.message), String(max));
  }
  const page = await contractHandlers(() => INDEXER)['contract.snapshot']({ contractAddress: ADDRESS, limit: MAX_SNAPSHOT_LIMIT }, ctx());
  assert.equal((page as ContractSnapshot).next, null, 'with the default cap and the maximum limit, everything in one page');
});

test('contract.snapshot: if the core cancels, the error comes out as is (rpc.ts answers Cancelled)', async () => {
  const controller = new AbortController();
  setFetchForTests(async () => {
    controller.abort();
    throw new DOMException('aborted', 'AbortError');
  });
  const err = await failure((await ready())['contract.snapshot']({ contractAddress: ADDRESS }, ctx(controller.signal)));
  assert.ok(!(err instanceof AppError) && err.name === 'AbortError');
});

test('contract.snapshot logs (debug) the size of the state read, nothing else', async () => {
  const { stateHex } = await registryState();
  fakeIndexer(stateHex);
  const lines: string[] = [];
  const h = contractHandlers(() => INDEXER, { log: (m) => lines.push(m) });
  await h['contract.snapshot']({ contractAddress: ADDRESS }, ctx());
  assert.deepEqual(lines, [`contract.snapshot: state of ${stateHex.length / 2} bytes at block 100`]);
  await contractHandlers(() => INDEXER)['contract.snapshot']({ contractAddress: ADDRESS }, ctx()); // without a log it does not fail
});

test('the debug log only writes to stderr with debug', async () => {
  const { stateHex } = await registryState();
  fakeIndexer(stateHex);
  const written: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { written.push(args.join(' ')); };
  try {
    for (const debug of [false, true]) {
      const h = createHandlers({ initialized: null });
      await h.initialize({ ...json('rpc/initialize.json'), debug }, ctx());
      await h['contract.snapshot']({ contractAddress: ADDRESS }, ctx());
    }
  } finally {
    console.error = original;
  }
  assert.deepEqual(written, [`[sidecar] contract.snapshot: state of ${stateHex.length / 2} bytes at block 100`]);
});
