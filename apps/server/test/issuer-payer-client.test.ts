import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adaptPayer } from '../src/issuer/payer-client.ts';
import { capturingLogger } from './smtp-helpers.ts';

const ID = 'ab'.repeat(32);
type Reply = { status: number; body: unknown };

function adapter(reply: Reply | Error | Array<Reply>) {
  const logs: string[] = [];
  const list = Array.isArray(reply) ? [...reply] : undefined;
  const answer = () => {
    const next = list ? list.shift()! : (reply as Reply | Error);
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  const payer = adaptPayer({ issue: answer }, capturingLogger(logs));
  return { payer, logs };
}

test('issue: issued and already-issued are "issued"', async () => {
  assert.deepEqual(await adapter({ status: 200, body: { status: 'issued', txHash: 'aa' } }).payer.issue(ID, 'free'), { status: 'issued' });
  assert.deepEqual(await adapter({ status: 200, body: { status: 'already-issued' } }).payer.issue(ID, 'free'), { status: 'already-issued' });
});

test('issue: pending keeps retryAfterS, failed keeps the reason', async () => {
  const pending = await adapter({ status: 200, body: { status: 'pending', txHash: 'aa', retryAfterS: 90 } }).payer.issue(ID, 'paid');
  assert.deepEqual(pending, { status: 'pending', retryAfterS: 90 });
  for (const reason of ['fee-lost', 'rejected', 'not-prepared']) {
    assert.deepEqual(await adapter({ status: 200, body: { status: 'failed', reason } }).payer.issue(ID, 'free'), { status: 'failed', reason });
  }
});

test('issue: 409 id-conflict is failed', async () => {
  const r = await adapter({ status: 409, body: { error: 'id-conflict' } }).payer.issue(ID, 'free');
  assert.deepEqual(r, { status: 'failed', reason: 'id-conflict' });
});

test('issue: 422 fee-over-cap is failed and warns the operator', async () => {
  const { payer, logs } = adapter({ status: 422, body: { error: 'fee-over-cap' } });
  assert.deepEqual(await payer.issue(ID, 'free'), { status: 'failed', reason: 'fee-over-cap' });
  assert.ok(logs.some((l) => l.startsWith('warn ') && l.includes('cap')));
});

test('issue: a general payer throttle (429, 503, 500) is unavailable (pauses the whole queue), with retryAfterS if present', async () => {
  const cases: Array<[Reply, string]> = [
    [{ status: 429, body: { error: 'dust-cap', retryAfterS: 120 } }, 'dust-cap'],
    [{ status: 503, body: { error: 'dust-unavailable', transient: false, retryAfterS: 60 } }, 'dust-unavailable'],
    [{ status: 503, body: { error: 'indexer-behind', retryAfterS: 30 } }, 'indexer-behind'],
    [{ status: 503, body: { error: 'not-ready' } }, 'not-ready'],
    [{ status: 503, body: { error: 'queue-full' } }, 'queue-full'],
    [{ status: 503, body: { error: 'stopping' } }, 'stopping'],
    [{ status: 500, body: { error: 'internal' } }, 'internal'],
    [{ status: 502, body: 'no es json' }, 'http-502'],
  ];
  for (const [reply, reason] of cases) {
    const r = await adapter(reply).payer.issue(ID, 'free');
    const retryAfterS = (reply.body as { retryAfterS?: number }).retryAfterS;
    assert.deepEqual(r, { status: 'unavailable', reason, ...(retryAfterS !== undefined && { retryAfterS }) });
  }
});

test('issue: if the client throws (missing socket, cut, timeout) it is unavailable, without logging anything here', async () => {
  const { payer, logs } = adapter(new Error('connect ENOENT /secret/path'));
  assert.deepEqual(await payer.issue(ID, 'free'), { status: 'unavailable', reason: 'unreachable' });
  assert.deepEqual(logs, []);
});

test('issue: an unintelligible 200 response is pending for the id (retrying with the same id is safe)', async () => {
  assert.deepEqual(await adapter({ status: 200, body: { status: 'raro' } }).payer.issue(ID, 'free'), { status: 'pending' });
  assert.deepEqual(await adapter({ status: 200, body: null }).payer.issue(ID, 'free'), { status: 'pending' });
});

test('issue: 400, 404, other 4xx and 503 no-contract are failed (retrying does not fix them) and the code is reported ONCE', async () => {
  const replies: Reply[] = [
    { status: 400, body: { error: 'bad-request' } },
    { status: 400, body: { error: 'bad-request' } },
    { status: 404, body: { error: 'not-found' } },
    { status: 503, body: { error: 'no-contract' } },
    { status: 503, body: { error: 'no-contract' } },
    { status: 415, body: { error: 'Raro Con Espacios' } },
  ];
  const { payer, logs } = adapter(replies);
  const reasons: string[] = [];
  for (let i = 0; i < replies.length; i++) {
    const r = await payer.issue(ID, 'free');
    assert.equal(r.status, 'failed');
    reasons.push((r as { reason: string }).reason);
  }
  assert.deepEqual(reasons, ['bad-request', 'bad-request', 'not-found', 'no-contract', 'no-contract', 'http-415']);
  const warns = logs.filter((l) => l.startsWith('warn '));
  assert.equal(warns.length, 4, warns.join('\n'));
  assert.ok(warns[0]!.includes('bad-request') && warns[2]!.includes('no-contract'));
});
