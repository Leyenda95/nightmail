// Midnight health: the gate before starting and the store. `node --test test/*.test.ts`.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MidnightHealth } from '../src/bindings/MidnightHealth.ts';
import {
  createHealth,
  createServerHealth,
  HEALTH_EVERY_MS,
  known,
  midnightBlocker,
  noNetworkText,
  noProofServerText,
  midnightWaitingText,
  type HealthEnv,
} from '../src/health.ts';

const h = (indexer: boolean, proofServer: boolean): MidnightHealth => ({
  sidecarVersion: '0.1.0',
  nodeVersion: 'v24',
  indexer,
  proofServer,
});

test('midnightBlocker: without the indexer nothing starts, without the proof server only what generates proofs', () => {
  assert.equal(midnightBlocker(h(true, true), 'red'), null);
  assert.equal(midnightBlocker(h(true, true), 'pruebas'), null);
  assert.equal(midnightBlocker(h(false, true), 'red'), noNetworkText());
  assert.equal(midnightBlocker(h(false, false), 'pruebas'), noNetworkText());
  assert.equal(midnightBlocker(h(true, false), 'red'), null);
  assert.equal(midnightBlocker(h(true, false), 'pruebas'), noProofServerText());
  // With no data nothing is blocked: the operation will report its own error.
  assert.equal(midnightBlocker(null, 'pruebas'), null);
});

test('texts: in plain words, they say what is happening and what to do, without comforting phrases', () => {
  assert.match(noNetworkText(), /no hay conexión con la red de Midnight/i);
  // Each notice says what to do, also with a network that is not local.
  assert.match(noNetworkText(), /arráncala\. Si no, espera unos minutos y vuelve a intentarlo/);
  assert.match(noProofServerText(), /Arráncalo y vuelve a intentarlo/);
  assert.match(midnightWaitingText(), /arráncala/);
  for (const t of [noNetworkText(), noProofServerText(), midnightWaitingText()]) assert.doesNotMatch(t, /no se ha (cambiado|perdido|tocado) nada/i);
});

test('known: an unanswered ping invalidates the previous result', () => {
  assert.deepEqual(known({ health: h(true, true), failed: false }), h(true, true));
  assert.equal(known({ health: h(true, true), failed: true }), null);
  assert.equal(known({ health: null, failed: false }), null);
});

/** A `ping` answered by hand and a clock fired by hand. */
function fakeEnv() {
  const pending: { resolve: (v: MidnightHealth) => void; reject: (e: unknown) => void }[] = [];
  const timers: { fn: () => void; ms: number; stopped: boolean }[] = [];
  const env: HealthEnv = {
    ping: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    every(fn, ms) {
      const t = { fn, ms, stopped: false };
      timers.push(t);
      return () => {
        t.stopped = true;
      };
    },
  };
  return { env, pending, timers };
}

test('store: the first subscriber checks and repeats every 30 s, without subscribers it stops', async () => {
  const { env, pending, timers } = fakeEnv();
  const store = createHealth(env);
  assert.deepEqual(store.get(), { health: null, failed: false });
  let calls = 0;
  const off1 = store.subscribe(() => calls++);
  const off2 = store.subscribe(() => {});
  assert.equal(pending.length, 1, 'a single check on subscribing');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, HEALTH_EVERY_MS);
  pending[0].resolve(h(false, true));
  const snap = await store.check();
  assert.deepEqual(snap, { health: h(false, true), failed: false });
  assert.equal(calls, 1);
  off1();
  assert.equal(timers[0].stopped, false);
  off2();
  assert.equal(timers[0].stopped, true);
  // Subscribing again (on unlocking again) checks again.
  store.subscribe(() => {})();
  assert.equal(pending.length, 2);
});

test('store: simultaneous checks share a single ping, the same result does not notify', async () => {
  const { env, pending } = fakeEnv();
  const store = createHealth(env);
  let calls = 0;
  store.subscribe(() => calls++);
  const a = store.check();
  const b = store.check();
  assert.equal(pending.length, 1);
  pending[0].resolve(h(true, true));
  assert.equal(await a, await b);
  const first = store.get();
  const c = store.check();
  pending[1].resolve(h(true, true));
  await c;
  assert.equal(store.get(), first, 'the same snapshot if nothing changes');
  assert.equal(calls, 1);
});

test('store: a failing ping does not throw, keeps the last data and flags the failure', async () => {
  const { env, pending } = fakeEnv();
  const store = createHealth(env);
  const first = store.check();
  pending[0].resolve(h(true, true));
  await first;
  const second = store.check();
  pending[1].reject(new Error('no response'));
  assert.deepEqual(await second, { health: h(true, true), failed: true });
  assert.equal(known(store.get()), null);
  const third = store.check();
  pending[2].resolve(h(true, false));
  assert.deepEqual(await third, { health: h(true, false), failed: false });
});

test('store: with the window still the periodic check is skipped, a manual one is not', async () => {
  const { env, pending, timers } = fakeEnv();
  let still = false;
  const store = createHealth({ ...env, still: () => still });
  store.subscribe(() => {});
  assert.equal(pending.length, 1);
  pending[0].resolve(h(true, true));
  await store.check();
  still = true;
  timers[0].fn();
  assert.equal(pending.length, 1, 'still: no ping');
  const manual = store.check();
  assert.equal(pending.length, 2, 'manual: yes');
  pending[1].resolve(h(true, true));
  await manual;
  still = false;
  timers[0].fn();
  assert.equal(pending.length, 3, 'back: checks again');
});

test('server store: the same result does not notify, a different one does', async () => {
  const pending: ((v: { mailbox: boolean; relayer: boolean; issuer: boolean }) => void)[] = [];
  const store = createServerHealth({
    ping: () => new Promise((resolve) => pending.push(resolve)),
    every: () => () => {},
  });
  let calls = 0;
  store.subscribe(() => calls++);
  pending[0]({ mailbox: true, relayer: true, issuer: true });
  await store.check();
  const c = store.check();
  pending[1]({ mailbox: true, relayer: true, issuer: true });
  await c;
  assert.equal(calls, 1);
  const d = store.check();
  pending[2]({ mailbox: true, relayer: false, issuer: true });
  assert.deepEqual(await d, { health: { mailbox: true, relayer: false, issuer: true }, failed: false });
  assert.equal(calls, 2);
});

test('store: when the person comes back (the window stops being still) it checks right away', async () => {
  const { env, pending, timers } = fakeEnv();
  const wakes: { fn: () => void; stopped: boolean }[] = [];
  const store = createHealth({
    ...env,
    still: () => true,
    wake(fn) {
      const w = { fn, stopped: false };
      wakes.push(w);
      return () => {
        w.stopped = true;
      };
    },
  });
  const off = store.subscribe(() => {});
  pending[0].resolve(h(true, true));
  await store.check();
  timers[0].fn();
  assert.equal(pending.length, 1, 'still: the timer does not check');
  wakes[0].fn();
  assert.equal(pending.length, 2, 'on return, it does');
  off();
  assert.equal(wakes[0].stopped, true, 'without subscribers it stops watching');
  assert.equal(timers[0].stopped, true);
});

test('refresh (opening the status panel): checks right away, unless one is running or it has just checked', async () => {
  const { env, pending } = fakeEnv();
  let clock = 1_000;
  const store = createHealth({ ...env, now: () => clock });
  store.subscribe(() => {});
  assert.equal(pending.length, 1, 'the first subscriber one');
  // Opening and closing quickly while that one is still running: it waits for it, with no other ping.
  const a = store.refresh(5_000);
  const b = store.refresh(5_000);
  assert.equal(pending.length, 1);
  pending[0].resolve(h(true, true));
  assert.deepEqual(await a, { health: h(true, true), failed: false });
  assert.equal(await a, await b);
  // Just checked: not either.
  clock += 4_999;
  assert.deepEqual(await store.refresh(5_000), { health: h(true, true), failed: false });
  assert.equal(pending.length, 1, 'within the interval, no ping');
  // Past the deadline, yes: and the new result is the one that stays.
  clock += 1;
  const c = store.refresh(5_000);
  assert.equal(pending.length, 2);
  pending[1].resolve(h(false, true));
  assert.deepEqual(await c, { health: h(false, true), failed: false });
  assert.deepEqual(store.get(), { health: h(false, true), failed: false });
});

test('refresh: the interval counts from the last check, including the periodic one and a failed one', async () => {
  const { env, pending, timers } = fakeEnv();
  let clock = 0;
  const store = createHealth({ ...env, now: () => clock });
  store.subscribe(() => {});
  pending[0].resolve(h(true, true));
  await store.check();
  clock = 40_000;
  timers[0].fn();
  pending[1].reject(new Error('no response'));
  await store.check();
  clock += 1_000;
  assert.deepEqual(await store.refresh(5_000), { health: h(true, true), failed: true });
  assert.equal(pending.length, 2, 'the periodic one has just finished');
});

test('refresh: with the app locked (nobody subscribed) it checks nothing', async () => {
  const { env, pending } = fakeEnv();
  const store = createHealth({ ...env, now: () => 0 });
  assert.deepEqual(await store.refresh(5_000), { health: null, failed: false });
  assert.equal(pending.length, 0, 'before unlocking');
  const off = store.subscribe(() => {});
  pending[0].resolve(h(true, true));
  await store.check();
  off();
  assert.deepEqual(await store.refresh(0), { health: h(true, true), failed: false });
  assert.equal(pending.length, 1, 'after locking');
});

test('refresh: a single ping in flight, so an old response does not arrive after a new one', async () => {
  const { env, pending } = fakeEnv();
  let clock = 0;
  const store = createHealth({ ...env, now: () => clock });
  store.subscribe(() => {});
  pending[0].resolve(h(true, true));
  await store.check();
  // The periodic one (or "Comprobar conexión") is still running when the panel opens: a second one does not start.
  clock = 60_000;
  const button = store.check();
  const opened = store.refresh(5_000);
  assert.equal(pending.length, 2);
  pending[1].resolve(h(true, false));
  assert.equal(await opened, await button);
  assert.deepEqual(store.get(), { health: h(true, false), failed: false });
});
