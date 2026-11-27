// The window after a relayed inclusion in which an unknown recipient is "try later" (registry/settling.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEarlyRelayAnswer } from '../src/payer/config.ts';
import { DEFAULT_SETTLING_MS, RecentInclusions, settlingWindow } from '../src/registry/settling.ts';

test('the window exists only with the early relay answer on: off (the default) keeps 550/404 as before', () => {
  assert.equal(settlingWindow(loadEarlyRelayAnswer({})), undefined, 'unset: no window');
  assert.equal(settlingWindow(loadEarlyRelayAnswer({ NIGHTMAIL_PAYER_EARLY_RELAY_ANSWER: '0' })), undefined);
  const on = settlingWindow(loadEarlyRelayAnswer({ NIGHTMAIL_PAYER_EARLY_RELAY_ANSWER: '1' }));
  assert.ok(on instanceof RecentInclusions);
  assert.equal(on.settling(), false, 'nothing included yet');
  on.note();
  assert.equal(on.settling(), true);
  assert.throws(() => loadEarlyRelayAnswer({ NIGHTMAIL_PAYER_EARLY_RELAY_ANSWER: 'yes' }), /must be 0 or 1/);
});

test('settling only within the window after the last inclusion; each inclusion restarts it', () => {
  const clock = { now: 1_000_000 };
  const inclusions = new RecentInclusions(60_000, () => clock.now);
  assert.equal(inclusions.settling(), false, 'nothing included yet');
  inclusions.note();
  assert.equal(inclusions.settling(), true);
  clock.now += 59_999;
  assert.equal(inclusions.settling(), true);
  inclusions.note();
  clock.now += 59_999;
  assert.equal(inclusions.settling(), true, 'restarted by the second inclusion');
  clock.now += 1;
  assert.equal(inclusions.settling(), false);
  assert.equal(DEFAULT_SETTLING_MS, 60_000);
});
