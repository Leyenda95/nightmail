// Refresh icons that turn when pressed: how long they keep turning. `node --test test/*.test.ts`.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SPIN_MIN_MS, SPIN_TURN_MS, spinStopDelay } from '../src/spin.ts';

test('spinStopDelay: a refresh that ends at once still makes a whole turn', () => {
  assert.ok(SPIN_MIN_MS > 0 && SPIN_MIN_MS <= SPIN_TURN_MS);
  assert.equal(spinStopDelay(0), SPIN_TURN_MS);
  assert.equal(spinStopDelay(100), SPIN_TURN_MS - 100);
  assert.equal(spinStopDelay(599), SPIN_TURN_MS - 599);
});

test('spinStopDelay: a long refresh stops at the end of the turn in course, never half turned', () => {
  assert.equal(spinStopDelay(1500), 500);
  assert.equal(spinStopDelay(2000), 0);
  assert.equal(spinStopDelay(2001), 999);
  for (const elapsed of [0, 250, 999, 1000, 1700, 4321]) {
    const end = elapsed + spinStopDelay(elapsed);
    assert.equal(end % SPIN_TURN_MS, 0, `ends upright after ${elapsed} ms`);
    assert.ok(end >= SPIN_MIN_MS);
  }
});

test('spinStopDelay: a clock that went back does not give a negative wait', () => {
  assert.equal(spinStopDelay(-50), SPIN_TURN_MS);
});

test('the turn of spin.ts is the one of nm-fila__gira in app.css', () => {
  const css = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8');
  assert.ok(css.includes(`.nm-fila__gira { animation: nm-gira ${SPIN_TURN_MS / 1000}s `));
});

const iconsIn = (file: string) => readFileSync(new URL(`../src/screens/${file}`, import.meta.url), 'utf8').match(/<Icon name="arrows-rotate"[^>]*>/g) ?? [];

test('the inbox refresh buttons turn while the sync works, like the sidebar one (also with reduced motion)', () => {
  const icons = iconsIn('Inbox.tsx');
  assert.equal(icons.length, 2);
  for (const icon of icons) assert.match(icon, /spin\.spinning && 'nm-fila__gira keep-motion'/, icon);
});

test("Sent's refresh is local and instant: its turn is decoration and stops with reduced motion", () => {
  const icons = iconsIn('Sent.tsx');
  assert.equal(icons.length, 1);
  assert.match(icons[0] ?? '', /spin\.spinning && 'nm-fila__gira'\)/);
});
