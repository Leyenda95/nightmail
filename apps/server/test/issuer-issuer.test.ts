import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto, { createPublicKey, verify } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { Issuer, type IssuerDeps } from '../src/issuer/issuer.ts';
import type { IssueOutcome, IssuePlan, PayerClient } from '../src/issuer/payer-client.ts';
import { createReceiptSigner, receiptMessage, SPKI_PREFIX, type ReceiptPeriod } from '../src/issuer/receipt.ts';
import { IssuerStore, type BonoRequest } from '../src/issuer/store.ts';
import { MEMORY, openDatabase } from '../src/storage/db.ts';
import { capturingLogger } from './smtp-helpers.ts';
import { gate } from './issuer-gate.ts';

const A = 'aa'.repeat(32);
const B = 'bb'.repeat(32);
const CONTRACT = 'c0'.repeat(32);
/** On the hour (a multiple of 3600 s). */
const NOW = 1_800_000_000_000;

function harness(answers: Record<string, IssueOutcome[]> | ((id: string, call: number) => Promise<IssueOutcome>), over: Partial<IssuerDeps> = {}) {
  const store = new IssuerStore(openDatabase(MEMORY));
  const signer = createReceiptSigner(Buffer.alloc(32, 3), CONTRACT);
  const calls: Array<{ id: string; plan: IssuePlan }> = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  const payer: PayerClient = {
    issue: async (id, plan) => {
      calls.push({ id, plan });
      const n = calls.filter((c) => c.id === id).length;
      if (typeof answers === 'function') return answers(id, n);
      const list = answers[id] ?? [];
      return list[Math.min(n - 1, list.length - 1)] ?? { status: 'issued' };
    },
    advanceRound: async () => ({ status: 'failed' }),
  };
  const sleep = async (ms: number, signal: AbortSignal) => {
    sleeps.push(ms);
    if (ms >= 2_000_000) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  };
  const issuer = new Issuer({ store, payer, signer, log: capturingLogger(logs), now: () => NOW, delayMs: () => 0, sleep, ...over });
  return { issuer, store, signer, calls, sleeps, logs };
}

function verifies(signer: { publicKey: Buffer }, r: BonoRequest, period: ReceiptPeriod): boolean {
  const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, signer.publicKey]), format: 'der', type: 'spki' });
  const message = receiptMessage({ contract: CONTRACT, id: r.id, plan: r.plan, period, insertBy: BigInt(r.insertBy) });
  return verify(null, message, key, r.signature);
}

const warns = (logs: string[], text: string) => logs.filter((l) => l.startsWith('warn ') && l.includes(text));

test('submit: pending request with a signed v2 receipt, deadline rounded up to the minute and creation time to the hour', async () => {
  const h = harness({}, { now: () => NOW + 1_234_567 });
  const result = h.issuer.submit(A, 'free', null);
  assert.ok(result.ok);
  const { request } = result;
  assert.equal(request.state, 'pending');
  assert.equal(request.insertBy, 1_800_005_160, 'now + 1234.567 s + 3900 s = …5134.567 → …5160');
  assert.equal(request.insertBy % 60, 0);
  assert.equal(request.createdAt, NOW, 'without the exact time on disk');
  assert.equal(verifies(h.signer, request, 'none'), true);
  await h.issuer.idle();
  assert.equal(h.issuer.lookup(A)?.state, 'issued');
  assert.deepEqual(h.calls, [{ id: A, plan: 'free' }]);
});

test('already-issued also counts as issued, the paid receipt signs the period', async () => {
  const h = harness({ [A]: [{ status: 'already-issued' }] });
  const result = h.issuer.submit(A, 'paid', 'monthly');
  assert.ok(result.ok);
  assert.equal(verifies(h.signer, result.request, 'monthly'), true);
  assert.equal(verifies(h.signer, result.request, 'annual'), false);
  await h.issuer.idle();
  assert.equal(h.issuer.lookup(A)?.state, 'issued');
  assert.equal(h.issuer.lookup(A)?.period, 'monthly');
});

test('the random delay is applied before requesting issuance', async () => {
  const h = harness({}, { delayMs: () => 4321 });
  h.issuer.submit(A, 'free', null);
  await h.issuer.idle();
  assert.deepEqual(h.sleeps, [4321]);
});

test('rejected / not-prepared: own retry with the SAME receipt, up to 5 times with backoff, then failed', async () => {
  const h = harness({ [A]: [{ status: 'failed', reason: 'rejected' }] });
  const first = h.issuer.submit(A, 'free', null);
  assert.ok(first.ok);
  await h.issuer.idle();
  assert.equal(h.calls.length, 6);
  assert.deepEqual(h.sleeps, [0, 30_000, 60_000, 120_000, 240_000, 480_000]);
  const after = h.issuer.lookup(A)!;
  assert.equal(after.state, 'failed');
  assert.deepEqual(after.signature, first.request.signature);
  assert.equal(after.insertBy, first.request.insertBy);
});

test('not-prepared that later succeeds: issued without the user repeating anything', async () => {
  const h = harness({ [A]: [{ status: 'failed', reason: 'not-prepared' }, { status: 'failed', reason: 'not-prepared' }, { status: 'issued' }] });
  h.issuer.submit(A, 'free', null);
  await h.issuer.idle();
  assert.equal(h.issuer.lookup(A)?.state, 'issued');
  assert.equal(h.calls.length, 3);
});

test('fee-lost: a single retry (each one costs a fee), then failed, and a new submit requeues it with a new receipt', async () => {
  let now = NOW;
  const h = harness({ [A]: [{ status: 'failed', reason: 'fee-lost' }, { status: 'failed', reason: 'fee-lost' }, { status: 'issued' }] }, { now: () => now });
  h.issuer.submit(A, 'free', null);
  await h.issuer.idle();
  assert.equal(h.issuer.lookup(A)?.state, 'failed');
  assert.equal(h.calls.length, 2);
  assert.ok(h.logs.some((l) => l.includes('fee-lost')));
  now += 7_200_000;
  const again = h.issuer.submit(A, 'free', null);
  assert.ok(again.ok);
  assert.equal(again.request.insertBy, (NOW + 7_200_000) / 1000 + 3900);
  assert.equal(again.request.state, 'pending');
  await h.issuer.idle();
  assert.equal(h.issuer.lookup(A)?.state, 'issued');
  assert.equal(h.calls.length, 3);
});

test('the other failures (id-conflict, fee-over-cap, no-contract…) are not retried', async () => {
  for (const reason of ['id-conflict', 'fee-over-cap', 'no-contract', 'bad-request', 'constructor']) {
    const h = harness({ [A]: [{ status: 'failed', reason }, { status: 'issued' }] });
    h.issuer.submit(A, 'free', null);
    await h.issuer.idle();
    assert.equal(h.issuer.lookup(A)?.state, 'failed', reason);
    assert.equal(h.calls.length, 1, reason);
  }
});

test('an unknown payer status never counts as issued: the same id is retried', async () => {
  const h = harness({ [A]: [{ status: 'raro' } as unknown as IssueOutcome, { status: 'issued' }] });
  h.issuer.submit(A, 'free', null);
  await h.issuer.idle();
  assert.equal(h.calls.length, 2);
  assert.equal(h.issuer.lookup(A)?.state, 'issued');
});

test('pending: retries with the SAME id after retryAfterS and then with backoff', async () => {
  const h = harness({ [A]: [{ status: 'pending', retryAfterS: 90 }, { status: 'pending' }, { status: 'pending' }, { status: 'issued' }] });
  h.issuer.submit(A, 'free', null);
  await h.issuer.idle();
  assert.equal(h.issuer.lookup(A)?.state, 'issued');
  assert.equal(h.calls.length, 4);
  assert.ok(h.calls.every((c) => c.id === A && c.plan === 'free'));
  assert.deepEqual(h.sleeps, [0, 90_000, 60_000, 120_000]);
});

test('pending: a huge retryAfterS is capped', async () => {
  const h = harness({ [A]: [{ status: 'pending', retryAfterS: 999_999 }] });
  h.issuer.submit(A, 'free', null);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(h.sleeps, [0, 35 * 60_000]);
  await h.issuer.close();
});

test('payer unavailable (429/503/cut): the WHOLE queue pauses until retryAfter, with one log line per pause', async () => {
  const h = harness({ [A]: [{ status: 'unavailable', reason: 'dust-cap', retryAfterS: 120 }, { status: 'issued' }], [B]: [{ status: 'issued' }] });
  h.issuer.submit(A, 'free', null);
  h.issuer.submit(B, 'free', null);
  await h.issuer.idle();
  assert.deepEqual(h.calls.map((c) => c.id), [A, A, B], 'B was not requested during the pause');
  assert.deepEqual(h.sleeps, [0, 0, 120_000]);
  assert.equal(warns(h.logs, 'pausing').length, 1);
  assert.ok(warns(h.logs, 'pausing')[0]!.includes('dust-cap'));
  assert.equal(h.issuer.lookup(B)?.state, 'issued');
});

test('consecutive pauses without retryAfterS: backoff 30 s, 60 s…, after a good contact it starts over', async () => {
  const down: IssueOutcome = { status: 'unavailable', reason: 'unreachable' };
  const h = harness({ [A]: [down, down, { status: 'issued' }], [B]: [down, { status: 'issued' }] });
  h.issuer.submit(A, 'free', null);
  await h.issuer.idle();
  h.issuer.submit(B, 'free', null);
  await h.issuer.idle();
  assert.deepEqual(h.sleeps, [0, 30_000, 60_000, 0, 30_000]);
  assert.equal(warns(h.logs, 'pausing').length, 3);
  assert.deepEqual([h.issuer.lookup(A)?.state, h.issuer.lookup(B)?.state], ['issued', 'issued']);
});

test('an exception after "issued" (the state could not be saved) does not leave the id stuck: it is retried with the same id', async () => {
  const h = harness({ [A]: [{ status: 'issued' }, { status: 'already-issued' }] });
  const setState = h.store.setState.bind(h.store);
  let failures = 1;
  h.store.setState = (id, state) => {
    if (failures-- > 0) throw new Error('disk full /secret/path');
    setState(id, state);
  };
  h.issuer.submit(A, 'free', null);
  await h.issuer.idle();
  assert.equal(h.issuer.lookup(A)?.state, 'issued');
  assert.equal(h.calls.length, 2);
  assert.ok(h.logs.some((l) => l.startsWith('warn ')));
  assert.ok(!h.logs.join('\n').includes('/secret/path'));
});

test('the same id with the other plan is id_conflict and does not call the payer, with the same plan it returns the same receipt', async () => {
  const h = harness({});
  const first = h.issuer.submit(A, 'free', null);
  assert.ok(first.ok);
  assert.deepEqual(h.issuer.submit(A, 'paid', 'annual'), { ok: false, error: 'id_conflict' });
  const same = h.issuer.submit(A, 'free', null);
  assert.ok(same.ok);
  assert.deepEqual(same.request.signature, first.request.signature);
  await h.issuer.idle();
  assert.equal(h.calls.length, 1);
});

test('the queue is serial: the second issuance does not start until the first one finishes', async () => {
  const g = gate();
  const order: string[] = [];
  const h = harness(async (id) => {
    order.push(`start ${id}`);
    if (id === A) await g.promise;
    order.push(`end ${id}`);
    return { status: 'issued' };
  });
  h.issuer.submit(A, 'free', null);
  h.issuer.submit(B, 'free', null);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, [`start ${A}`]);
  g.resolve();
  await h.issuer.idle();
  assert.deepEqual(order, [`start ${A}`, `end ${A}`, `start ${B}`, `end ${B}`]);
});

test('a pending request waiting for its retry does not block the others', async () => {
  const h = harness({ [A]: [{ status: 'pending', retryAfterS: 3600 }], [B]: [{ status: 'issued' }] });
  h.issuer.submit(A, 'free', null);
  h.issuer.submit(B, 'free', null);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.issuer.lookup(B)?.state, 'issued');
  assert.equal(h.issuer.lookup(A)?.state, 'pending');
  await h.issuer.close();
});

test('pendingCount: the pending ones (queued and waiting for a retry)', async () => {
  const h = harness({ [A]: [{ status: 'pending', retryAfterS: 3600 }], [B]: [{ status: 'issued' }] });
  assert.equal(h.issuer.pendingCount(), 0);
  h.issuer.submit(A, 'free', null);
  h.issuer.submit(B, 'free', null);
  assert.equal(h.issuer.pendingCount(), 2);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.issuer.pendingCount(), 1);
  await h.issuer.close();
});

test('close: cancels the waits and does not call the payer again', async () => {
  const h = harness({ [A]: [{ status: 'pending', retryAfterS: 3600 }] });
  h.issuer.submit(A, 'free', null);
  await new Promise((r) => setTimeout(r, 20));
  await h.issuer.close();
  assert.equal(h.calls.length, 1);
  assert.equal(h.issuer.lookup(A)?.state, 'pending', 'stays pending on disk for the next start');
  h.issuer.submit(B, 'free', null);
  await h.issuer.idle();
  assert.equal(h.calls.length, 1);
});

test('close: bounded, if the issuance in progress does not finish in time, it warns and moves on (stays pending on disk)', async () => {
  const never = gate<IssueOutcome>();
  const h = harness(() => never.promise, { closeTimeoutMs: 30 });
  h.issuer.submit(A, 'free', null);
  await new Promise((r) => setTimeout(r, 10));
  const started = Date.now();
  await h.issuer.close();
  assert.ok(Date.now() - started < 1000);
  assert.equal(warns(h.logs, 'in flight').length, 1);
  assert.equal(h.issuer.lookup(A)?.state, 'pending');
});

test('resume: picks up the pending ones from disk and leaves the others alone', async () => {
  const h = harness({});
  const row = (id: string, state: 'pending' | 'issued' | 'failed') =>
    h.store.create({ id, plan: 'free', period: null, state, insertBy: 1, signature: Buffer.alloc(64), createdAt: 1 });
  row(A, 'pending');
  row(B, 'issued');
  row('cc'.repeat(32), 'failed');
  h.issuer.resume();
  await h.issuer.idle();
  assert.deepEqual(h.calls, [{ id: A, plan: 'free' }]);
  assert.equal(h.issuer.lookup(A)?.state, 'issued');
});

test('the default random delay comes from randomInt(0, 30 s): from 0 (no delay) up to 30 s', async (t) => {
  const asked: Array<[number, number]> = [];
  t.mock.method(crypto, 'randomInt', ((min: number, max: number) => { asked.push([min, max]); return min; }) as unknown as typeof crypto.randomInt);
  syncBuiltinESMExports();
  t.after(() => syncBuiltinESMExports());
  const sleeps: number[] = [];
  const issuer = new Issuer({
    store: new IssuerStore(openDatabase(MEMORY)), payer: { issue: async () => ({ status: 'issued' }), advanceRound: async () => ({ status: 'failed' }) },
    signer: createReceiptSigner(Buffer.alloc(32, 3), CONTRACT), log: capturingLogger([]), now: () => NOW, sleep: async (ms) => { sleeps.push(ms); },
  });
  issuer.submit(A, 'free', null);
  await issuer.idle();
  assert.deepEqual(asked, [[0, 30_000]]);
  assert.deepEqual(sleeps, [0]);
});

test('close with nothing in flight does not warn "in flight" (only warns if the deadline passes)', async () => {
  const h = harness({});
  h.issuer.submit(A, 'free', null);
  await h.issuer.idle();
  await h.issuer.close();
  assert.equal(warns(h.logs, 'in flight').length, 0);
});

test('a request no longer in the store is dropped without calling the payer or warning', async (t) => {
  const h = harness({}, { sleep: () => new Promise((resolve) => setTimeout(resolve, 1)) });
  t.after(() => h.issuer.close());
  h.issuer.submit(A, 'free', null);
  h.store.get = () => undefined;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.calls.length, 0);
  assert.equal(h.logs.filter((l) => l.startsWith('warn ')).length, 0);
});

test('payer pause: the log states the seconds (retryAfter 120 s → "120 s")', async () => {
  const h = harness({ [A]: [{ status: 'unavailable', reason: 'dust-cap', retryAfterS: 120 }, { status: 'issued' }] });
  h.issuer.submit(A, 'free', null);
  await h.issuer.idle();
  const line = warns(h.logs, 'pausing')[0]!;
  assert.ok(line.endsWith('pausing the queue for 120 s'), line);
});
