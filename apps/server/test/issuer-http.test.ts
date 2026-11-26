import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { listenOn, readJsonObject, respond } from '../src/issuer/http.ts';
import { capturingLogger } from './smtp-helpers.ts';

/** A fake request with the given headers and the body split into the given chunks. */
function fakeRequest(chunks: string[], headers: Record<string, string> = {}): IncomingMessage {
  const stream = Readable.from(chunks.map((c) => Buffer.from(c)), { objectMode: false });
  return Object.assign(stream, { headers: { 'content-type': 'application/json', ...headers } }) as unknown as IncomingMessage;
}

test('readJsonObject: a body of exactly maxBytes is accepted, also in several chunks (without Content-Length)', async () => {
  assert.deepEqual(await readJsonObject(fakeRequest(['{"a":1}']), 7), { ok: true, value: { a: 1 } });
  assert.deepEqual(await readJsonObject(fakeRequest(['{"a"', ':1}']), 7), { ok: true, value: { a: 1 } });
});

test('readJsonObject: a streamed body of maxBytes + 1 (without Content-Length) is 413', async () => {
  const r = await readJsonObject(fakeRequest(['{"a":1}']), 6);
  assert.ok(!r.ok);
  assert.equal(r.reply.status, 413);
  const split = await readJsonObject(fakeRequest(['{"a"', ':1}']), 6);
  assert.ok(!split.ok);
  assert.equal(split.reply.status, 413);
});

test('readJsonObject: Content-Length equal to maxBytes is accepted, larger is 413 without reading the body', async () => {
  assert.deepEqual(await readJsonObject(fakeRequest(['{"a":1}'], { 'content-length': '7' }), 7), { ok: true, value: { a: 1 } });
  const r = await readJsonObject(fakeRequest(['{"a":1}'], { 'content-length': '8' }), 7);
  assert.ok(!r.ok);
  assert.equal(r.reply.status, 413);
});

test('readJsonObject: no Content-Length counts as 0 (with maxBytes 0 it is not 413 because of the header)', async () => {
  const r = await readJsonObject(fakeRequest([]), 0);
  assert.ok(!r.ok);
  assert.equal(r.reply.status, 400, 'empty body: invalid JSON, not too large');
});

test('readJsonObject: a read error is 400 bad_request', async () => {
  const req = fakeRequest([]);
  const result = readJsonObject(req, 100);
  req.emit('error', new Error('reset'));
  const r = await result;
  assert.ok(!r.ok);
  assert.deepEqual([r.reply.status, r.reply.body], [400, { error: 'bad_request' }]);
});

test('listenOn: returns the actual port, or the requested one if there is no network address', async () => {
  const fake = (address: unknown) => {
    const server = new EventEmitter();
    return Object.assign(server, { listen: () => { setImmediate(() => server.emit('listening')); }, address: () => address }) as unknown as Server;
  };
  assert.equal(await listenOn(fake({ port: 4321 }), 0, '127.0.0.1'), 4321);
  assert.equal(await listenOn(fake(null), 8788, '127.0.0.1'), 8788);
  assert.equal(await listenOn(fake('/tmp/socket'), 8788, '127.0.0.1'), 8788);
});

test('respond: a pipelined request (without a socket) is not served', async () => {
  let routed = false;
  const res = { socket: null } as unknown as ServerResponse;
  await respond(res, async () => { routed = true; return { status: 200, body: {} }; }, { label: 'x', log: capturingLogger([]), timeoutMs: 1000 });
  assert.equal(routed, false);
});
