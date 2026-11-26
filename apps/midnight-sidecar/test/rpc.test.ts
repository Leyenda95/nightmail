import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { serve, type Handler, type ServeOptions } from '../src/rpc.ts';
import { AppError, codes } from '../src/codes.ts';

type Msg = { jsonrpc: string; id?: unknown; result?: unknown; error?: { code: number; message: string }; method?: string; params?: unknown };

function harness(handlers: Parameters<typeof serve>[0], opts: Partial<ServeOptions> = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  serve(handlers, { input, output, onClose: () => {}, ...opts });
  const queue: Msg[] = [];
  const waiters: ((m: Msg) => void)[] = [];
  let partial = '';
  output.setEncoding('utf8');
  output.on('data', (chunk: string) => {
    partial += chunk;
    let nl: number;
    while ((nl = partial.indexOf('\n')) >= 0) {
      const msg = JSON.parse(partial.slice(0, nl)) as Msg;
      partial = partial.slice(nl + 1);
      const w = waiters.shift();
      if (w) w(msg);
      else queue.push(msg);
    }
  });
  /** Next message; fails if it does not arrive within `ms`. */
  const next = (ms = 2000): Promise<Msg> => {
    const queued = queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no message arrived')), ms);
      waiters.push((m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  };
  /** Checks that nothing arrives within `ms`. */
  const nothing = async (ms = 100) => {
    await new Promise((r) => setTimeout(r, ms));
    assert.equal(queue.length, 0, `unexpected message arrived: ${JSON.stringify(queue[0])}`);
  };
  return {
    raw: (s: string | Buffer) => input.write(s),
    send: (m: unknown) => input.write(JSON.stringify(m) + '\n'),
    end: () => input.end(),
    next,
    nothing,
  };
}

const req = (id: number | string, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, params });

test('answers a known method', async () => {
  const h = harness({ echo: async (p) => p });
  h.send(req(1, 'echo', { a: 1 }));
  assert.deepEqual(await h.next(), { jsonrpc: '2.0', id: 1, result: { a: 1 } });
});

test('out-of-order responses with concurrent requests', async () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const h = harness({ wait: async (p) => { await sleep(p as number); return p; } });
  h.send(req(1, 'wait', 80));
  h.send(req(2, 'wait', 10));
  assert.equal((await h.next()).id, 2);
  assert.equal((await h.next()).id, 1);
});

test('line split across chunks, several per chunk, CRLF and split multibyte', async () => {
  const h = harness({ echo: async (p) => p });
  const line = JSON.stringify(req(1, 'echo', 'ñandú €')) + '\r\n';
  const bytes = Buffer.from(line + JSON.stringify(req(2, 'echo', 'x')) + '\n');
  // Cut inside the multibyte character "ñ" (2 bytes).
  const cut = bytes.indexOf(Buffer.from('ñ')) + 1;
  h.raw(bytes.subarray(0, cut));
  h.raw(bytes.subarray(cut));
  assert.deepEqual((await h.next()).result, 'ñandú €');
  assert.deepEqual((await h.next()).result, 'x');
});

test('unknown method and one inherited from the prototype → -32601', async () => {
  const h = harness({});
  h.send(req(1, 'nope'));
  h.send(req(2, 'toString'));
  assert.equal((await h.next()).error?.code, codes.METHOD_NOT_FOUND);
  assert.equal((await h.next()).error?.code, codes.METHOD_NOT_FOUND);
});

test('invalid JSON → -32700 with id null', async () => {
  const h = harness({});
  h.raw('{no es json\n');
  assert.deepEqual(await h.next(), { jsonrpc: '2.0', id: null, error: { code: codes.PARSE_ERROR, message: 'Parse error' } });
});

test('invalid requests → -32600', async () => {
  const h = harness({});
  for (const bad of [null, [], 42, { jsonrpc: '1.0', id: 1, method: 'x' }, { jsonrpc: '2.0', id: 1 }, { jsonrpc: '2.0', id: {}, method: 'x' }]) {
    h.send(bad);
    assert.equal((await h.next()).error?.code, codes.INVALID_REQUEST, JSON.stringify(bad));
  }
});

test('notifications (without id) are not answered', async () => {
  let called = false;
  const h = harness({ x: async () => { called = true; } });
  h.send({ jsonrpc: '2.0', method: 'x' });
  h.send({ jsonrpc: '2.0', method: 'desconocido' });
  await h.nothing();
  assert.equal(called, false);
});

test('AppError keeps its code and its public message', async () => {
  const h = harness({ boom: async () => { throw new AppError(codes.NOT_INITIALIZED, 'Not initialized'); } });
  h.send(req(1, 'boom'));
  assert.deepEqual((await h.next()).error, { code: codes.NOT_INITIALIZED, message: 'Not initialized' });
});

test('unexpected errors do not leak their message', async (t) => {
  const logged: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args); });
  const h = harness({
    boom: async () => { throw new Error('SECRETO-witness-123'); },
    noError: async () => { throw 'SECRETO-string'; },
  });
  h.send(req(1, 'boom'));
  h.send(req(2, 'noError'));
  for (let i = 0; i < 2; i++) {
    const m = await h.next();
    assert.deepEqual(m.error, { code: codes.APP_INTERNAL, message: 'Internal error' });
  }
  assert.ok(!JSON.stringify(logged).includes('SECRETO'), 'without debug, stderr carries no detail');
});

test('in debug mode the detail goes only to stderr', async (t) => {
  const logged: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args); });
  const h = harness({ boom: async () => { throw new Error('detalle-debug'); } }, { isDebug: () => true });
  h.send(req(1, 'boom'));
  assert.equal((await h.next()).error?.message, 'Internal error');
  assert.ok(JSON.stringify(logged.map((a) => a.map(String))).includes('detalle-debug'));
});

test('non-serializable result (bigint) → internal error', async () => {
  const h = harness({ big: async () => 10n });
  h.send(req(1, 'big'));
  assert.equal((await h.next()).error?.code, codes.APP_INTERNAL);
});

test('$/cancel aborts the handler signal', async () => {
  const h = harness({
    slow: (_p, { signal }) =>
      new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('abortado')))),
  });
  h.send(req(7, 'slow'));
  h.send({ jsonrpc: '2.0', method: '$/cancel', params: { id: 7 } });
  assert.deepEqual((await h.next()).error, { code: codes.CANCELLED, message: 'Cancelled' });
});

test('handlers can send progress notifications', async () => {
  const h = harness({ work: async (_p, { notify, requestId }) => { notify('progress', { requestId, stage: 'proving' }); return 'ok'; } });
  h.send(req(3, 'work'));
  assert.deepEqual(await h.next(), { jsonrpc: '2.0', method: 'progress', params: { requestId: 3, stage: 'proving' } });
  assert.equal((await h.next()).result, 'ok');
});

test('a line that is too long is discarded and processing continues', async () => {
  const h = harness({ echo: async (p) => p }, { maxLineBytes: 1024 });
  h.raw('x'.repeat(4096));
  h.raw('\n');
  assert.deepEqual(await h.next(), { jsonrpc: '2.0', id: null, error: { code: codes.PARSE_ERROR, message: 'Line too long' } });
  h.send(req(1, 'echo', 'sigo'));
  assert.equal((await h.next()).result, 'sigo');
});

test('when the input closes it answers what is pending and then closes', async () => {
  let closed = false;
  const h = harness({ slow: async () => { await new Promise((r) => setTimeout(r, 50)); return 'ok'; } }, { onClose: () => { closed = true; } });
  h.send(req(9, 'slow'));
  h.end();
  assert.equal((await h.next()).result, 'ok');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(closed, true);
});

test('a hung handler does not prevent closing (grace period)', async () => {
  let closed = false;
  const h = harness({ hang: () => new Promise(() => {}) }, { onClose: () => { closed = true; }, closeGraceMs: 50 });
  h.send(req(1, 'hang'));
  await new Promise((r) => setTimeout(r, 10));
  h.end();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(closed, true);
});

// --- Characterisation tests added before the `serve` refactor ---

test('request with a valid id but an invalid message answers with that id', async () => {
  const h = harness({});
  h.send({ jsonrpc: '1.0', id: 'abc', method: 'x' });
  h.send({ jsonrpc: '2.0', id: 5 });
  h.send({ jsonrpc: '2.0', id: null, method: 'x' });
  h.send({ jsonrpc: '2.0', id: true, method: 'x' });
  assert.deepEqual(await h.next(), { jsonrpc: '2.0', id: 'abc', error: { code: codes.INVALID_REQUEST, message: 'Invalid request' } });
  assert.deepEqual(await h.next(), { jsonrpc: '2.0', id: 5, error: { code: codes.INVALID_REQUEST, message: 'Invalid request' } });
  assert.deepEqual(await h.next(), { jsonrpc: '2.0', id: null, error: { code: codes.INVALID_REQUEST, message: 'Invalid request' } });
  assert.deepEqual(await h.next(), { jsonrpc: '2.0', id: null, error: { code: codes.INVALID_REQUEST, message: 'Invalid request' } });
});

test('$/cancel with a string id, and ignored cancellations with no effect or response', async () => {
  const h = harness({
    slow: (_p, { signal }) => new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new Error('x')))),
  });
  h.send(req('a', 'slow'));
  // None of these must cancel: unknown id, no params, non-object params, wrong jsonrpc, another method.
  h.send({ jsonrpc: '2.0', method: '$/cancel', params: { id: 'otro' } });
  h.send({ jsonrpc: '2.0', method: '$/cancel' });
  h.send({ jsonrpc: '2.0', method: '$/cancel', params: null });
  h.send({ jsonrpc: '2.0', method: '$/cancel', params: 'a' });
  h.send({ jsonrpc: '1.0', method: '$/cancel', params: { id: 'a' } });
  h.send({ jsonrpc: '2.0', method: '$/otro', params: { id: 'a' } });
  await h.nothing();
  h.send({ jsonrpc: '2.0', method: '$/cancel', params: { id: 'a' } });
  assert.deepEqual(await h.next(), { jsonrpc: '2.0', id: 'a', error: { code: codes.CANCELLED, message: 'Cancelled' } });
});

test('$/cancel with numeric and string ids match by their textual form', async () => {
  const h = harness({
    slow: (_p, { signal }) => new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new Error('x')))),
  });
  h.send(req(7, 'slow'));
  h.send({ jsonrpc: '2.0', method: '$/cancel', params: { id: '7' } });
  assert.equal((await h.next()).error?.code, codes.CANCELLED);
});

test('a $/cancel after the request finishes does not affect a later one with the same id', async () => {
  const h = harness({ echo: async (p) => p, probe: async (_p, { signal }) => signal.aborted });
  h.send(req(1, 'echo', 'a'));
  assert.equal((await h.next()).result, 'a');
  h.send({ jsonrpc: '2.0', method: '$/cancel', params: { id: 1 } });
  h.send(req(1, 'probe'));
  assert.equal((await h.next()).result, false);
});

test('$/cancel only cancels its own request, the others stay pending until closing', async () => {
  const h = harness({
    slow: (_p, { signal }) => new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new Error('x')))),
  });
  h.send(req(1, 'slow'));
  h.send(req(2, 'slow'));
  h.send({ jsonrpc: '2.0', method: '$/cancel', params: { id: 1 } });
  const first = await h.next();
  assert.equal(first.id, 1);
  assert.equal(first.error?.code, codes.CANCELLED);
  await h.nothing();
  h.end();
  const second = await h.next();
  assert.equal(second.id, 2);
  assert.equal(second.error?.code, codes.CANCELLED);
});

test('AppError takes priority over cancellation, generic cancelled error → Cancelled', async (t) => {
  const logged: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args); });
  const h = harness({
    app: (_p, { signal }) => new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new AppError(codes.NOT_INITIALIZED, 'Not initialized')))),
    gen: (_p, { signal }) => new Promise((_r, reject) => signal.addEventListener('abort', () => reject('texto'))),
  });
  h.send(req(1, 'app'));
  h.send(req(2, 'gen'));
  h.send({ jsonrpc: '2.0', method: '$/cancel', params: { id: 1 } });
  h.send({ jsonrpc: '2.0', method: '$/cancel', params: { id: 2 } });
  const a = await h.next();
  const b = await h.next();
  assert.equal(a.id, 1);
  assert.equal(b.id, 2);
  assert.deepEqual(a.error, { code: codes.NOT_INITIALIZED, message: 'Not initialized' });
  assert.deepEqual(b.error, { code: codes.CANCELLED, message: 'Cancelled' });
  assert.deepEqual(logged, [], 'cancelling logs nothing to stderr');
});

test('when the input closes, the signal of pending requests is aborted', async () => {
  const h = harness({
    slow: (_p, { signal }) => new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new Error('x')))),
  });
  h.send(req(1, 'slow'));
  await new Promise((r) => setTimeout(r, 10));
  h.end();
  assert.equal((await h.next()).error?.code, codes.CANCELLED);
});

test('current behavior pinned: handler returning undefined → response without `result`, the serialization error logs the method', async (t) => {
  const logged: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args); });
  const h = harness({ nada: async () => undefined, big: async () => 1n });
  h.send(req(1, 'nada'));
  assert.deepEqual(await h.next(), { jsonrpc: '2.0', id: 1 });
  h.send(req(2, 'big'));
  assert.deepEqual((await h.next()).error, { code: codes.APP_INTERNAL, message: 'Internal error' });
  assert.deepEqual(logged, [['[sidecar] big failed']]);
});

test('empty or blank lines are ignored', async () => {
  const h = harness({ echo: async (p) => p });
  h.raw('\n   \r\n\n');
  h.send(req(1, 'echo', 1));
  assert.equal((await h.next()).result, 1);
});

test('long line: a single warning even if several chunks arrive, and it resumes after the newline', async () => {
  const h = harness({ echo: async (p) => p }, { maxLineBytes: 100 });
  h.raw('x'.repeat(150));
  h.raw('y'.repeat(150));
  h.raw('z'.repeat(150) + '\n');
  assert.equal((await h.next()).error?.code, codes.PARSE_ERROR);
  h.send(req(1, 'echo', 'ok'));
  assert.equal((await h.next()).result, 'ok');
  await h.nothing();
});

test('a line of exactly the maximum size without a newline is not discarded yet', async () => {
  const h = harness({ echo: async (p) => p }, { maxLineBytes: 100 });
  const body = JSON.stringify(req(1, 'echo', 'a'.repeat(100 - JSON.stringify(req(1, 'echo', '')).length)));
  assert.equal(body.length, 100);
  h.raw(body);
  await h.nothing(30);
  h.raw('\n');
  assert.equal((await h.next()).id, 1);
});

test('handler that throws synchronously → Internal error', async (t) => {
  t.mock.method(console, 'error', () => {});
  const h = harness({ boom: (() => { throw new Error('sync'); }) as unknown as Handler });
  h.send(req(1, 'boom'));
  assert.deepEqual(await h.next(), { jsonrpc: '2.0', id: 1, error: { code: codes.APP_INTERNAL, message: 'Internal error' } });
});

test('notify with non-serializable params → Internal error and the notification is not written', async (t) => {
  t.mock.method(console, 'error', () => {});
  const h = harness({ work: async (_p, { notify }) => { notify('progress', 1n); return 'ok'; } });
  h.send(req(1, 'work'));
  assert.deepEqual(await h.next(), { jsonrpc: '2.0', id: 1, error: { code: codes.APP_INTERNAL, message: 'Internal error' } });
  await h.nothing();
});

test('a handler that ignores the abort and returns a result: the result wins', async () => {
  const h = harness({
    stubborn: (_p, { signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve('terminé'))),
  });
  h.send(req(1, 'stubborn'));
  h.send({ jsonrpc: '2.0', method: '$/cancel', params: { id: 1 } });
  assert.deepEqual(await h.next(), { jsonrpc: '2.0', id: 1, result: 'terminé' });
});

test('a $/cancel that arrives before its request does not cancel it', async () => {
  const h = harness({ probe: async (_p, { signal }) => signal.aborted });
  h.send({ jsonrpc: '2.0', method: '$/cancel', params: { id: 1 } });
  h.send(req(1, 'probe'));
  assert.equal((await h.next()).result, false);
});

test('discarded line followed by a valid one in the same chunk', async () => {
  const h = harness({ echo: async (p) => p }, { maxLineBytes: 100 });
  h.raw('x'.repeat(150));
  h.raw('\n' + JSON.stringify(req(1, 'echo', 'ok')) + '\n');
  assert.equal((await h.next()).error?.message, 'Line too long');
  assert.equal((await h.next()).result, 'ok');
});

test('end of input with a partial line without a newline: it is ignored and the process closes', async () => {
  let closed = false;
  const h = harness({ echo: async (p) => p }, { onClose: () => { closed = true; } });
  h.raw(JSON.stringify(req(1, 'echo', 'x')));
  h.end();
  await h.nothing(50);
  assert.equal(closed, true);
});

test('the limit is maxLine + 1 without a newline → discard', async () => {
  const h = harness({}, { maxLineBytes: 100 });
  h.raw('x'.repeat(101));
  assert.deepEqual(await h.next(), { jsonrpc: '2.0', id: null, error: { code: codes.PARSE_ERROR, message: 'Line too long' } });
});

test('an AppError with data sends it in error.data, without data there is no data field', async () => {
  const h = harness({
    named: async () => { throw new AppError(codes.NAME_REJECTED, 'Name rejected', { reason: 'reserved' }); },
    plain: async () => { throw new AppError(codes.INVALID_PARAMS, 'Invalid params'); },
  });
  h.send(req(1, 'named'));
  assert.deepEqual(await h.next(), { jsonrpc: '2.0', id: 1, error: { code: -32008, message: 'Name rejected', data: { reason: 'reserved' } } });
  h.send(req(2, 'plain'));
  assert.deepEqual(await h.next(), { jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'Invalid params' } });
});
