// Payer DUST accounting: hourly cap (sliding window) and lost fees by cause.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HourlyCap, LostFees } from '../src/payer/accounting.ts';

const MIN = 60_000;

test('hourly cap: fits while the amount spent in the last hour plus the new one does not exceed the cap', () => {
  const cap = new HourlyCap(100n);
  assert.equal(cap.spent(0), 0n);
  assert.equal(cap.allows(100n, 0), true, 'exactly the cap fits');
  assert.equal(cap.allows(101n, 0), false);
  cap.record(60n, 0);
  cap.record(30n, 10 * MIN);
  assert.equal(cap.spent(10 * MIN), 90n);
  assert.equal(cap.allows(10n, 10 * MIN), true);
  assert.equal(cap.allows(11n, 10 * MIN), false, 'one grain more no longer fits');
});

test('hourly cap: spending from an hour ago or more stops counting (sliding window)', () => {
  const cap = new HourlyCap(100n);
  cap.record(60n, 0);
  cap.record(30n, 10 * MIN);
  assert.equal(cap.spent(60 * MIN - 1), 90n, 'one millisecond before the hour it still counts');
  assert.equal(cap.spent(60 * MIN), 30n, 'at the exact hour the first one no longer does');
  assert.equal(cap.allows(70n, 60 * MIN), true);
  assert.equal(cap.spent(70 * MIN), 0n);
});

test('hourly cap: how long until the oldest spend expires', () => {
  const cap = new HourlyCap(100n);
  assert.equal(cap.retryAfterMs(5), 0, 'with no spend there is no wait');
  cap.record(60n, 0);
  cap.record(40n, 10 * MIN);
  assert.equal(cap.retryAfterMs(15 * MIN), 45 * MIN);
  assert.equal(cap.retryAfterMs(60 * MIN), 10 * MIN, 'once the first one expires, the second one rules');
});

test('hourly cap: the window is configurable and the cap cannot be negative', () => {
  const cap = new HourlyCap(10n, 1000);
  cap.record(10n, 0);
  assert.equal(cap.allows(1n, 999), false);
  assert.equal(cap.allows(1n, 1000), true);
  assert.throws(() => new HourlyCap(-1n), RangeError);
  assert.throws(() => new HourlyCap(1n, 0), RangeError);
  assert.equal(new HourlyCap(0n).allows(0n, 0), true, 'cap 0: nothing is paid (but 0 fits)');
  assert.equal(new HourlyCap(0n).allows(1n, 0), false);
});

test('hourly cap: anything over the cap on its own will never fit, whatever is spent', () => {
  const cap = new HourlyCap(100n);
  cap.record(100n, 0);
  assert.equal(cap.fits(100n), true, 'it will fit once the spending leaves the window');
  assert.equal(cap.fits(101n), false);
  assert.equal(new HourlyCap(0n).fits(1n), false);
});

test('lost fees: total and breakdown by cause', () => {
  const lost = new LostFees();
  assert.deepEqual(lost.snapshot(), { count: 0, dust: 0n, byCause: {} });
  lost.add('issue:FailFallible', 5n);
  lost.add('relay:FailFallible', 7n);
  lost.add('issue:FailFallible', 1n);
  assert.deepEqual(lost.snapshot(), {
    count: 3,
    dust: 13n,
    byCause: { 'issue:FailFallible': { count: 2, dust: 6n }, 'relay:FailFallible': { count: 1, dust: 7n } },
  });
  // The snapshot is a copy: mutating it does not affect the accounting.
  lost.snapshot().byCause['issue:FailFallible']!.count = 99;
  assert.equal(lost.snapshot().byCause['issue:FailFallible']!.count, 2);
});

test('hourly cap: the minimum window is 1 ms (0 is rejected)', () => {
  assert.doesNotThrow(() => new HourlyCap(10n, 1));
  assert.throws(() => new HourlyCap(10n, 0), RangeError);
});
