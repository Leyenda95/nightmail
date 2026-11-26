// Rotating front screen slogans: the rotation rule with a fake clock, the injected randomness and the
// texts of both languages.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DICTIONARIES } from '../src/i18n/index.ts';
import {
  SLOGAN_EVERY_MS,
  createSloganMemory,
  nextSlogan,
  rotateSlogans,
  type SloganClock,
} from '../src/slogans.ts';

/** A fake clock: time only advances with `advance`, and stillness is set by hand. */
function fakeClock() {
  let now = 0;
  let timers: { at: number; fn: () => void }[] = [];
  let wakers: (() => void)[] = [];
  let still = false;
  const clock: SloganClock = {
    after(fn, ms) {
      const timer = { at: now + ms, fn };
      timers.push(timer);
      return () => {
        timers = timers.filter((t) => t !== timer);
      };
    },
    still: () => still,
    onWake(fn) {
      wakers.push(fn);
      return () => {
        wakers = wakers.filter((w) => w !== fn);
      };
    },
  };
  return {
    clock,
    pending: () => timers.length,
    waiting: () => wakers.length,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        now = due.at;
        due.fn();
      }
      now = end;
    },
    setStill(value: boolean) {
      still = value;
      if (!value) for (const w of [...wakers]) w();
    },
  };
}

test('nextSlogan: the next one and, after the last, the first', () => {
  assert.equal(nextSlogan(0, 5), 1);
  assert.equal(nextSlogan(3, 5), 4);
  assert.equal(nextSlogan(4, 5), 0);
  assert.equal(nextSlogan(0, 1), 0);
});

test('rotateSlogans: a new one every interval, in order and wrapping around', () => {
  const f = fakeClock();
  const shown: number[] = [];
  rotateSlogans(3, 5, f.clock, (i) => shown.push(i));
  f.advance(SLOGAN_EVERY_MS - 1);
  assert.deepEqual(shown, []);
  f.advance(1);
  assert.deepEqual(shown, [4]);
  f.advance(SLOGAN_EVERY_MS * 3);
  assert.deepEqual(shown, [4, 0, 1, 2]);
});

test('rotateSlogans: the interval is about 5-6 s', () => {
  assert.ok(SLOGAN_EVERY_MS >= 5000 && SLOGAN_EVERY_MS <= 6000);
});

test('rotateSlogans: with the window still it neither changes nor counts, on return another full interval', () => {
  const f = fakeClock();
  const shown: number[] = [];
  rotateSlogans(0, 5, f.clock, (i) => shown.push(i));
  f.setStill(true);
  f.advance(SLOGAN_EVERY_MS);
  assert.deepEqual(shown, []);
  // Really stopped: no timers, waiting for it to return.
  assert.equal(f.pending(), 0);
  assert.equal(f.waiting(), 1);
  f.advance(SLOGAN_EVERY_MS * 10);
  assert.deepEqual(shown, []);
  f.setStill(false);
  assert.equal(f.waiting(), 0);
  f.advance(SLOGAN_EVERY_MS - 1);
  assert.deepEqual(shown, []);
  f.advance(1);
  assert.deepEqual(shown, [1]);
});

test('rotateSlogans: stopping cancels everything, also while waiting for the window to return', () => {
  const f = fakeClock();
  const shown: number[] = [];
  const stop = rotateSlogans(0, 5, f.clock, (i) => shown.push(i));
  stop();
  f.advance(SLOGAN_EVERY_MS * 3);
  assert.deepEqual(shown, []);
  assert.equal(f.pending(), 0);

  const g = fakeClock();
  const stop2 = rotateSlogans(0, 5, g.clock, (i) => shown.push(i));
  g.setStill(true);
  g.advance(SLOGAN_EVERY_MS);
  stop2();
  assert.equal(g.waiting(), 0);
  g.setStill(false);
  g.advance(SLOGAN_EVERY_MS * 3);
  assert.deepEqual(shown, []);
});

test('rotateSlogans: with a single slogan there is nothing to rotate', () => {
  const f = fakeClock();
  const shown: number[] = [];
  rotateSlogans(0, 1, f.clock, (i) => shown.push(i));
  f.advance(SLOGAN_EVERY_MS * 3);
  assert.deepEqual(shown, []);
  assert.equal(f.pending(), 0);
});

test('startup memory: starts with the first and the current one carries on when the step changes', () => {
  const m = createSloganMemory();
  assert.equal(m.current(6), 0);
  assert.equal(m.first(), 0);
  m.remember(4);
  // Another front screen (another step): it carries on where it was; the screen reader's fixed one does not change.
  assert.equal(m.current(6), 4);
  assert.equal(m.first(), 0);
  // Another start: from the first again.
  assert.equal(createSloganMemory().current(6), 0);
});

test('the fixed headline: a separate key in both languages, no forbidden marks and outside the rotating list', () => {
  assert.equal(DICTIONARIES.en.slogans.headline, "The world's most private email.");
  assert.equal(DICTIONARIES.es.slogans.headline, 'El correo más privado del mundo.');
  for (const d of [DICTIONARIES.en, DICTIONARIES.es]) {
    assert.doesNotMatch(d.slogans.headline, /;|\/\/|—| – /);
    assert.ok(!(d.slogans.list as readonly string[]).includes(d.slogans.headline));
    // Nor in the other language's list.
    for (const o of [DICTIONARIES.en, DICTIONARIES.es]) assert.ok(!(o.slogans.list as readonly string[]).includes(d.slogans.headline));
  }
});

test('the slogans: all six, the new one first, in their order, in both languages', () => {
  assert.deepEqual(DICTIONARIES.en.slogans.list, [
    'No account. No phone number. No IP.',
    "Even we can't connect the dots.",
    'Email privately. Sign up freely.',
    'Write freely. Leave no trace.',
    'Sign up anywhere. Share nothing.',
    'Many addresses. Zero clues.',
  ]);
  assert.deepEqual(DICTIONARIES.es.slogans.list, [
    'Sin cuenta. Sin número de teléfono. Sin IP.',
    'Ni nosotros podemos atar cabos.',
    'Tu correo privado. Regístrate con libertad.',
    'Escribe libremente. No dejes rastro.',
    'Regístrate donde quieras. Sin compartir nada.',
    'Muchas direcciones. Ninguna pista.',
  ]);
  assert.equal(DICTIONARIES.es.slogans.list.length, DICTIONARIES.en.slogans.list.length);
  for (const list of [DICTIONARIES.en.slogans.list, DICTIONARIES.es.slogans.list]) {
    for (const slogan of list) assert.doesNotMatch(slogan, /;|\/\/|—| – /);
  }
  // The earlier fixed slogan is gone.
  assert.ok(!DICTIONARIES.es.slogans.list.some((s) => s.includes('Ni el proveedor')));
});
