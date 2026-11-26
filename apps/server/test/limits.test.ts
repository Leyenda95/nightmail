import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter, Slots } from '../src/limits.ts';

test('RateLimiter: lets `limit` events through per window and not one more', () => {
  const limiter = new RateLimiter({ limit: 3, windowMs: 1000 });
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => limiter.hit('ip', 100 + i)), [true, true, true, false, false]);
  assert.equal(limiter.allows('ip', 200), false);
  assert.equal(limiter.allows('otra', 200), true, 'each key has its own count');
});

test('RateLimiter: the window starts with the first event and expires exactly after windowMs', () => {
  const limiter = new RateLimiter({ limit: 1, windowMs: 1000 });
  assert.equal(limiter.hit('ip', 5000), true);
  assert.equal(limiter.hit('ip', 5999), false, 'still inside the window');
  assert.equal(limiter.allows('ip', 5999), false);
  assert.equal(limiter.allows('ip', 6000), true, 'at exactly 1000 ms it has already expired');
  assert.equal(limiter.hit('ip', 6000), true);
  assert.equal(limiter.hit('ip', 6999), false, 'the new window starts at 6000, not at 5000');
  assert.equal(limiter.hit('ip', 7000), true);
});

test('RateLimiter: allows does not count, nor does a rejected event', () => {
  const limiter = new RateLimiter({ limit: 2, windowMs: 1000 });
  for (let i = 0; i < 10; i++) assert.equal(limiter.allows('ip', 0), true);
  assert.equal(limiter.hit('ip', 0), true);
  assert.equal(limiter.hit('ip', 1), true);
  for (let i = 0; i < 10; i++) assert.equal(limiter.hit('ip', 2), false);
  assert.equal(limiter.hit('ip', 1000), true, 'the rejections did not extend the window');
});

test('RateLimiter: an event can cost more than 1 (a byte budget), and one that does not fit is not counted', () => {
  const limiter = new RateLimiter({ limit: 100, windowMs: 1000 });
  assert.equal(limiter.allows('ip', 0, 100), true);
  assert.equal(limiter.allows('ip', 0, 101), false);
  assert.equal(limiter.hit('ip', 0, 60), true);
  assert.equal(limiter.hit('ip', 1, 50), false, '60 + 50 > 100');
  assert.equal(limiter.allows('ip', 1, 40), true, 'the rejected 50 were not counted');
  assert.equal(limiter.hit('ip', 2, 40), true);
  assert.equal(limiter.hit('ip', 3), false, 'full: not even the default cost of 1');
  assert.equal(limiter.hit('ip', 1000, 100), true, 'a new window');
  assert.equal(limiter.hit('otra', 0, 101), false, 'more than the whole limit never fits');
  assert.equal(limiter.size, 1, 'a rejected first event opens no window');
  for (const cost of [0, -1, 1.5, Number.NaN]) assert.throws(() => limiter.hit('ip', 0, cost), RangeError, String(cost));
});

test('RateLimiter: refund returns one event of the current window, and does not touch another window or go below 0', () => {
  const limiter = new RateLimiter({ limit: 2, windowMs: 1000 });
  limiter.hit('ip', 100);
  limiter.hit('ip', 200);
  assert.equal(limiter.allows('ip', 300), false);
  limiter.refund('ip', 200);
  assert.equal(limiter.allows('ip', 300), true, 'devuelto');
  assert.equal(limiter.hit('ip', 300), true);
  limiter.refund('ip', 99); // counted before this window started: untouched
  assert.equal(limiter.allows('ip', 300), false);
  limiter.refund('ip', 1100); // from the next window: untouched too
  assert.equal(limiter.allows('ip', 300), false);
  limiter.refund('nadie', 300); // unknown key: no-op
  for (let i = 0; i < 5; i++) limiter.refund('ip', 150);
  assert.equal(limiter.hit('ip', 400), true);
  assert.equal(limiter.hit('ip', 400), true);
  assert.equal(limiter.hit('ip', 400), false, 'does not go below 0: the window (reopened at 400) still limits to 2');
  limiter.refund('ip', 1399);
  assert.equal(limiter.allows('ip', 1399), true, 'the last instant of the window still belongs to it');
});

test('RateLimiter: refund with a cost returns that much of the current window, never below 0', () => {
  const limiter = new RateLimiter({ limit: 100, windowMs: 1000 });
  limiter.hit('ip', 0, 60);
  limiter.hit('ip', 10, 40);
  assert.equal(limiter.allows('ip', 20), false);
  limiter.refund('ip', 10, 40);
  assert.equal(limiter.allows('ip', 20, 40), true, 'the 40 are back');
  assert.equal(limiter.allows('ip', 20, 41), false, 'and no more');
  limiter.refund('ip', 1000, 60); // from the next window: untouched
  assert.equal(limiter.allows('ip', 20, 41), false);
  limiter.refund('ip', 20, 500);
  assert.equal(limiter.allows('ip', 20, 100), true, 'down to 0, not below');
  assert.equal(limiter.hit('ip', 20, 100), true);
  assert.equal(limiter.hit('ip', 20), false);
});

test('RateLimiter: resetIn gives the time left until the window of the key ends (0 with no window or when already over)', () => {
  const limiter = new RateLimiter({ limit: 2, windowMs: 1000 });
  assert.equal(limiter.resetIn('ip', 0), 0);
  limiter.hit('ip', 100);
  assert.equal(limiter.resetIn('ip', 100), 1000);
  assert.equal(limiter.resetIn('ip', 600), 500);
  assert.equal(limiter.resetIn('ip', 1100), 0);
  assert.equal(limiter.resetIn('ip', 5000), 0);
});

test('RateLimiter: sweep forgets only expired windows', () => {
  const limiter = new RateLimiter({ limit: 2, windowMs: 1000 });
  limiter.hit('vieja', 0);
  limiter.hit('nueva', 500);
  limiter.sweep(1000);
  assert.equal(limiter.size, 1);
  assert.equal(limiter.resetIn('nueva', 1000), 500);
  limiter.sweep(1499);
  assert.equal(limiter.size, 1, 'still there 1 ms before expiring');
});

test('RateLimiter: the number of keys is capped, expired ones are forgotten first', () => {
  const limiter = new RateLimiter({ limit: 1, windowMs: 1000, maxKeys: 3 });
  limiter.hit('a', 0);
  limiter.hit('b', 500);
  limiter.hit('c', 600);
  assert.equal(limiter.size, 3);
  limiter.hit('d', 1000); // 'a' has expired: only it is forgotten
  assert.equal(limiter.size, 3);
  assert.equal(limiter.allows('b', 1001), false);
  assert.equal(limiter.allows('c', 1001), false);
  assert.equal(limiter.allows('d', 1001), false);
});

test('RateLimiter: making room forgets all expired keys, including the one expiring at that instant', () => {
  const limiter = new RateLimiter({ limit: 1, windowMs: 1000, maxKeys: 3 });
  limiter.hit('a', 0);
  limiter.hit('b', 100);
  limiter.hit('c', 200);
  limiter.hit('d', 1100); // 'a' expired 100 ms ago and 'b' expires right now
  assert.equal(limiter.size, 2);
  assert.equal(limiter.allows('c', 1100), false);
});

test('RateLimiter: full and with none expired, forgets the oldest key', () => {
  const limiter = new RateLimiter({ limit: 1, windowMs: 1000, maxKeys: 2 });
  limiter.hit('a', 0);
  limiter.hit('b', 1);
  limiter.hit('c', 2);
  assert.equal(limiter.size, 2);
  assert.equal(limiter.allows('a', 3), true, 'the oldest one was forgotten');
  assert.equal(limiter.allows('b', 3), false);
  assert.equal(limiter.allows('c', 3), false);
});

test('RateLimiter: a key that comes back after expiring becomes the most recent', () => {
  const limiter = new RateLimiter({ limit: 1, windowMs: 10, maxKeys: 2 });
  limiter.hit('a', 0);
  limiter.hit('b', 5);
  limiter.hit('a', 12); // 'a' expired and reopens: now 'b' is the oldest
  limiter.hit('c', 13);
  assert.equal(limiter.allows('a', 14), false, 'the reopened one is kept');
  assert.equal(limiter.allows('b', 14), true, 'the oldest one was forgotten');
});

test('RateLimiter: rejects parameters that are not positive integers', () => {
  for (const bad of [{ limit: 0, windowMs: 1 }, { limit: 1, windowMs: 0 }, { limit: 1.5, windowMs: 1 }, { limit: 1, windowMs: 1, maxKeys: 0 }]) {
    assert.throws(() => new RateLimiter(bad), RangeError);
  }
});

test('Slots: as many slots as configured, no queue, and they are returned', () => {
  const slots = new Slots(2);
  assert.equal(slots.tryAcquire(), true);
  assert.equal(slots.tryAcquire(), true);
  assert.equal(slots.tryAcquire(), false);
  assert.equal(slots.available, 0);
  slots.release();
  assert.equal(slots.available, 1);
  assert.equal(slots.tryAcquire(), true);
  assert.equal(new Slots(1).tryAcquire(), true, 'a single slot is valid');
  assert.throws(() => new Slots(0), RangeError);
  assert.throws(() => new Slots(1.5), RangeError);
});
