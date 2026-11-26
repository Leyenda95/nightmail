// The payer's single queue: everything that spends DUST goes through it, one at a time, in arrival order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QueueFullError, QueueStoppedError, SerialQueue } from '../src/payer/queue.ts';

/** A promise resolved by hand. */
function gate<T = void>() {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { open = resolve; });
  return { promise, open };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('runs jobs one at a time in arrival order, and returns each result', async () => {
  const queue = new SerialQueue(10);
  const events: string[] = [];
  const gates = [gate(), gate(), gate()];
  const results = gates.map((g, i) => queue.run(async () => {
    events.push(`start ${i}`);
    await g.promise;
    events.push(`end ${i}`);
    return i * 10;
  }));
  await tick();
  assert.deepEqual(events, ['start 0'], 'the second does not start until the first finishes');
  assert.equal(queue.length, 3, 'counts the running one and those waiting');
  gates[1]!.open(); // opening the second one first does not move it ahead
  await tick();
  assert.deepEqual(events, ['start 0']);
  gates[0]!.open();
  await tick();
  assert.deepEqual(events, ['start 0', 'end 0', 'start 1', 'end 1', 'start 2']);
  assert.equal(queue.length, 1);
  gates[2]!.open();
  assert.deepEqual(await Promise.all(results), [0, 10, 20]);
  assert.equal(queue.length, 0);
});

test('a failing job rejects its promise and does not stop the queue', async () => {
  const queue = new SerialQueue(10);
  const failed = queue.run(async () => { throw new Error('boom'); });
  const next = queue.run(async () => 'ok');
  await assert.rejects(failed, /boom/);
  assert.equal(await next, 'ok');
  // Also when it throws synchronously.
  await assert.rejects(queue.run((() => { throw new Error('sync'); }) as () => Promise<never>), /sync/);
  assert.equal(await queue.run(async () => 1), 1);
  assert.equal(queue.length, 0);
});

test('full: rejects with QueueFullError without running the job, and accepts again when there is room', async () => {
  const queue = new SerialQueue(2);
  const g = gate();
  const first = queue.run(() => g.promise);
  const second = queue.run(async () => 'second');
  let ran = false;
  await assert.rejects(queue.run(async () => { ran = true; }), QueueFullError);
  assert.equal(ran, false);
  assert.equal(queue.length, 2);
  g.open();
  await first;
  assert.equal(await second, 'second');
  assert.equal(await queue.run(async () => 'third'), 'third');
});

test('stopped: waiting and incoming jobs fail with QueueStoppedError without running, stop() waits for the running job', async () => {
  const queue = new SerialQueue(10);
  const g = gate<string>();
  const running = queue.run(() => g.promise);
  let ran = false;
  const waiting = queue.run(async () => { ran = true; });
  await tick(); // the first one has already started
  let stopped = false;
  const stopping = queue.stop().then(() => { stopped = true; });
  await assert.rejects(queue.run(async () => { ran = true; }), QueueStoppedError);
  await tick();
  assert.equal(stopped, false, 'the running job continues');
  g.open('done');
  assert.equal(await running, 'done', 'the one that was running finishes with its result');
  await assert.rejects(waiting, QueueStoppedError);
  await stopping;
  assert.equal(ran, false);
  assert.equal(queue.length, 0);
  await queue.stop(); // again: already stopped
});

test('the maximum size must be a positive integer', () => {
  for (const bad of [0, -1, 1.5, Number.NaN]) assert.throws(() => new SerialQueue(bad), RangeError);
});
