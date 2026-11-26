// Taskbar badge: what is sent to the core and when.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { badgeToSend, createBadgeSender, type BadgeState } from '../src/badge.ts';

const open = (unread: number): BadgeState => ({ unread, locked: false, showCount: true });
const LOCKED: BadgeState = { unread: 0, locked: true, showCount: true };

test('badgeToSend: the first time it is always sent, also 0 (clears whatever was there)', () => {
  assert.deepEqual(badgeToSend(open(0), null), open(0));
  assert.deepEqual(badgeToSend(open(3), null), open(3));
  assert.deepEqual(badgeToSend(LOCKED, null), LOCKED);
});

test('badgeToSend: only when what is seen changes', () => {
  assert.equal(badgeToSend(open(3), open(3)), null);
  assert.deepEqual(badgeToSend(open(4), open(3)), open(4));
  assert.deepEqual(badgeToSend(open(0), open(3)), open(0));
  // From 100 on it is "99+": not repeated.
  assert.deepEqual(badgeToSend(open(100), open(99)), open(100));
  assert.equal(badgeToSend(open(250), open(100)), null);
  assert.deepEqual(badgeToSend(open(99), open(250)), open(99));
  // Without a number (the Settings choice off), 0 and 5 look the same: nothing.
  assert.equal(badgeToSend({ ...open(5), showCount: false }, { ...open(0), showCount: false }), null);
});

test('badgeToSend: turning the number off in Settings clears it, turning it on shows it again', () => {
  const hidden = (unread: number): BadgeState => ({ ...open(unread), showCount: false });
  assert.deepEqual(badgeToSend(hidden(5), open(5)), hidden(5));
  assert.equal(badgeToSend(hidden(8), hidden(5)), null, 'new mail with the number off: nothing to change');
  assert.deepEqual(badgeToSend(open(8), hidden(8)), open(8));
  // With 0 unread it looks the same either way: nothing is sent.
  assert.equal(badgeToSend(hidden(0), open(0)), null);
  // The padlock does not depend on it.
  assert.deepEqual(badgeToSend(LOCKED, hidden(5)), LOCKED);
});

test('badgeToSend: locking puts the padlock with any number, and unlocking goes back to the number', () => {
  assert.deepEqual(badgeToSend(LOCKED, open(7)), LOCKED);
  assert.deepEqual(badgeToSend(LOCKED, open(0)), LOCKED);
  assert.equal(badgeToSend({ ...LOCKED, unread: 9 }, LOCKED), null);
  assert.deepEqual(badgeToSend(open(7), LOCKED), open(7));
  assert.deepEqual(badgeToSend(open(0), LOCKED), open(0));
});

test('badgeToSend: the number goes as an unsigned integer', () => {
  assert.deepEqual(badgeToSend(open(-2), null), open(0));
  assert.deepEqual(badgeToSend(open(3.7), null), open(3));
  assert.deepEqual(badgeToSend(open(Number.NaN), null), open(0));
  assert.deepEqual(badgeToSend(open(1e12), null), open(0xffff_ffff));
});

/** A hand-driven timer: it stores what is scheduled and fires it on request. */
function manualTimer() {
  const queue: (() => void)[] = [];
  const waits: number[] = [];
  return {
    retry: {
      times: 2,
      everyMs: 10,
      lockMaxMs: 80,
      later: (fn: () => void, ms: number) => {
        waits.push(ms);
        queue.push(fn);
      },
    },
    /** The waits requested, in order. */
    waits,
    pending: () => queue.length,
    fire: () => queue.splice(0).forEach((fn) => fn()),
  };
}

/** Lets already resolved promises run. */
const settle = () => new Promise<void>((r) => setImmediate(r));

test('createBadgeSender: sends without repeating what is already shown', async () => {
  const sent: BadgeState[] = [];
  const timer = manualTimer();
  const push = createBadgeSender(async (s) => {
    sent.push(s);
    return s.locked;
  }, timer.retry);
  push(open(2));
  push(open(2));
  push(LOCKED);
  push({ ...LOCKED, unread: 5 });
  await settle();
  assert.deepEqual(sent, [open(2), LOCKED]);
  assert.equal(timer.pending(), 0);
});

test('createBadgeSender: a forced send goes out even if it looks like the last one (another profile opened)', async () => {
  const sent: BadgeState[] = [];
  const timer = manualTimer();
  const push = createBadgeSender(async (s) => {
    sent.push(s);
    return s.locked;
  }, timer.retry);
  push(open(0));
  push(open(0), true);
  push(open(0));
  await settle();
  assert.deepEqual(sent, [open(0), open(0)]);
});

test('createBadgeSender: if Windows fails to set the padlock, it retries without waiting for another change', async () => {
  const sent: BadgeState[] = [];
  let failures = 0;
  const timer = manualTimer();
  const push = createBadgeSender(async (s) => {
    sent.push(s);
    if (failures-- > 0) throw new Error('core');
    return s.locked;
  }, timer.retry);
  push(open(4));
  await settle();
  failures = 1;
  push(LOCKED);
  await settle();
  // The padlock failed once: a retry stays scheduled, and the same padlock is not sent twice meanwhile.
  assert.equal(timer.pending(), 1);
  push(LOCKED);
  assert.deepEqual(sent, [open(4), LOCKED]);
  timer.fire();
  await settle();
  assert.deepEqual(sent, [open(4), LOCKED, LOCKED]);
  assert.equal(timer.pending(), 0);
  // Already set: not repeated.
  push(LOCKED);
  await settle();
  assert.equal(sent.filter((s) => s.locked).length, 2);
});

test('createBadgeSender: the padlock never gives up, with growing waits up to the cap, until it is set', async () => {
  const sent: BadgeState[] = [];
  let failures = 9;
  const timer = manualTimer();
  const push = createBadgeSender(async (s) => {
    sent.push(s);
    if (failures-- > 0) throw new Error('core');
    return s.locked;
  }, timer.retry);
  push(LOCKED);
  await settle();
  // Many more failures than `times` (2): it keeps retrying.
  for (let i = 0; i < 9; i++) {
    assert.equal(timer.pending(), 1, `reintento ${i}`);
    timer.fire();
    await settle();
  }
  assert.equal(sent.length, 10);
  assert.equal(timer.pending(), 0);
  // It doubles from 10 ms and does not pass the cap (80 ms).
  assert.deepEqual(timer.waits, [10, 20, 40, 80, 80, 80, 80, 80, 80]);
  // Set: not repeated.
  push(LOCKED);
  await settle();
  assert.equal(sent.length, 10);
});

test('createBadgeSender: the padlock retry stops if something else is requested', async () => {
  const sent: BadgeState[] = [];
  let fail = true;
  const timer = manualTimer();
  const push = createBadgeSender(async (s) => {
    sent.push(s);
    if (fail) throw new Error('core');
    return s.locked;
  }, timer.retry);
  push(LOCKED);
  await settle();
  timer.fire();
  await settle();
  assert.equal(timer.pending(), 1);
  // Unlocking before the next retry: the padlock is no longer sent.
  fail = false;
  push(open(3));
  await settle();
  timer.fire();
  await settle();
  assert.deepEqual(sent, [LOCKED, LOCKED, open(3)]);
  assert.equal(timer.pending(), 0);
});

test('createBadgeSender: retries the latest request, not the old one, and forgets it after running out of retries', async () => {
  const sent: BadgeState[] = [];
  let fail = true;
  const timer = manualTimer();
  const push = createBadgeSender(async (s) => {
    sent.push(s);
    if (fail) throw new Error('core');
    return s.locked;
  }, timer.retry);
  push(open(1));
  await settle();
  // Before the retry, what is wanted changes: the retry of open(1) is no longer sent.
  push(open(2));
  await settle();
  timer.fire();
  await settle();
  assert.deepEqual(sent, [open(1), open(2), open(2)]);
  // open(2) uses up its 2 retries: it is forgotten and the same value is sent again.
  timer.fire();
  await settle();
  assert.equal(timer.pending(), 0);
  assert.equal(sent.length, 4);
  fail = false;
  push(open(2));
  await settle();
  assert.equal(sent.length, 5);
});

test('createBadgeSender: if the core left the padlock (no session), unlocking sends the number again', async () => {
  const sent: BadgeState[] = [];
  let session = true;
  const push = createBadgeSender(async (s) => {
    sent.push(s);
    return s.locked || !session;
  }, manualTimer().retry);
  push(open(0));
  await settle();
  push(LOCKED);
  await settle();
  session = false;
  // An Inbox read that finishes after locking: it asks for the number, the core keeps the padlock.
  push(open(0));
  await settle();
  // Locked is still the padlock: no need to send it again.
  push(LOCKED);
  await settle();
  assert.equal(sent.length, 3);
  // On unlocking with the same number as before, it is sent (the number is not visible yet).
  session = true;
  push(open(0));
  await settle();
  assert.deepEqual(sent, [open(0), LOCKED, open(0), open(0)]);
});