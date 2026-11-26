// Payer limits read from the environment (the defaults are provisional).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PAYER_LIMITS, DUST_UNIT, loadPayerLimits } from '../src/payer/config.ts';

test('without variables: default caps of 100 DUST/h for relay and 50 DUST/h for issue, and a queue of 32', () => {
  assert.deepEqual(loadPayerLimits({}), DEFAULT_PAYER_LIMITS);
  assert.deepEqual(DEFAULT_PAYER_LIMITS, { relayDustPerHour: 100n * 10n ** 15n, issueDustPerHour: 50n * 10n ** 15n, maxQueue: 32 });
  assert.equal(DUST_UNIT, 10n ** 15n);
});

test('the variables give the caps in whole DUST and the queue size', () => {
  const limits = loadPayerLimits({
    NIGHTMAIL_PAYER_RELAY_DUST_PER_HOUR: '7', NIGHTMAIL_PAYER_ISSUE_DUST_PER_HOUR: '0', NIGHTMAIL_PAYER_MAX_QUEUE: '5',
  });
  assert.deepEqual(limits, { relayDustPerHour: 7n * DUST_UNIT, issueDustPerHour: 0n, maxQueue: 5 });
  assert.equal(loadPayerLimits({ NIGHTMAIL_PAYER_RELAY_DUST_PER_HOUR: '1000000000' }).relayDustPerHour, 10n ** 9n * DUST_UNIT);
  // The queue size accepts 1 to 10000, inclusive.
  assert.equal(loadPayerLimits({ NIGHTMAIL_PAYER_MAX_QUEUE: '1' }).maxQueue, 1);
  assert.equal(loadPayerLimits({ NIGHTMAIL_PAYER_MAX_QUEUE: '10000' }).maxQueue, 10_000);
});

test('a value that is not an unsigned integer (or a queue of 0) is a configuration error, not a default', () => {
  for (const bad of ['', ' 5', '-1', '1.5', '1e3', 'abc', '12345678901234567890']) {
    assert.throws(() => loadPayerLimits({ NIGHTMAIL_PAYER_RELAY_DUST_PER_HOUR: bad }), /NIGHTMAIL_PAYER_RELAY_DUST_PER_HOUR/, bad);
    assert.throws(() => loadPayerLimits({ NIGHTMAIL_PAYER_ISSUE_DUST_PER_HOUR: bad }), /NIGHTMAIL_PAYER_ISSUE_DUST_PER_HOUR/, bad);
    assert.throws(() => loadPayerLimits({ NIGHTMAIL_PAYER_MAX_QUEUE: bad }), /NIGHTMAIL_PAYER_MAX_QUEUE/, bad);
  }
  assert.throws(() => loadPayerLimits({ NIGHTMAIL_PAYER_MAX_QUEUE: '0' }), /NIGHTMAIL_PAYER_MAX_QUEUE/);
  assert.throws(() => loadPayerLimits({ NIGHTMAIL_PAYER_MAX_QUEUE: '10001' }), /NIGHTMAIL_PAYER_MAX_QUEUE/);
});
