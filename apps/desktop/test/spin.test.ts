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

test('the refresh turn is smooth and continuous, never in steps (it went by jerks)', () => {
  const css = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8');
  const rule = css.match(/^\.nm-fila__gira \{[^}]*\}/m)?.[0] ?? '';
  assert.match(rule, /animation: nm-gira 1s linear infinite;/);
  assert.doesNotMatch(rule, /steps\(/);
});

test('the inbox refresh buttons turn while the sync works, all from one shared state (also with reduced motion)', () => {
  const icons = iconsIn('Inbox.tsx');
  assert.equal(icons.length, 2);
  for (const icon of icons) assert.match(icon, /\(\s*'nm-ic', spinning && 'nm-fila__gira keep-motion'\)/, icon);
  const sidebar = readFileSync(new URL('../src/components/Sidebar.tsx', import.meta.url), 'utf8').match(/<Icon name="arrows-rotate"[^>]*>/g) ?? [];
  assert.equal(sidebar.length, 1);
  assert.match(sidebar[0] ?? '', /\(\s*'nm-ic', spinning && 'nm-fila__gira keep-motion'\)/);
  // No inbox icon keeps a turn of its own: one `useSpin` in Main, kicked by any of the buttons.
  assert.doesNotMatch(readFileSync(new URL('../src/screens/Inbox.tsx', import.meta.url), 'utf8'), /useSpin\(/);
  const main = readFileSync(new URL('../src/screens/Main.tsx', import.meta.url), 'utf8');
  assert.equal((main.match(/useSpin\(/g) ?? []).length, 1);
  assert.match(main, /const syncSpin = useSpin\(inbox\.syncing\);/);
  assert.match(main, /kickSpin\(\);\s*syncNow\(\);/);
  // Sidebar, inbox list or empty inbox, and archive: the same turn and the same press.
  assert.equal((main.match(/spinning=\{syncSpin\.spinning\}/g) ?? []).length, 3);
  assert.equal((main.match(/onSync=\{onSync\}/g) ?? []).length, 5);
  assert.doesNotMatch(main, /onSync=\{inbox\.syncNow\}/);
});

test('"Bloquear" and "Cerrar sesión" both lock and then show the profile list', () => {
  const main = readFileSync(new URL('../src/screens/Main.tsx', import.meta.url), 'utf8');
  assert.match(main, /onLock=\{\(\) => void lock\(\)\}/);
  assert.match(main, /onLogOut=\{\(\) => void lock\(\)\}/);
  assert.match(main, /await api\.lock\(\);/);
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /badgeLocked\(\);\s*\/\/[^\n]*\n\s*void showChooser\(true\)\.then\(refresh\);/);
});

test("Sent's refresh is local and instant: its turn is decoration and stops with reduced motion", () => {
  const icons = iconsIn('Sent.tsx');
  assert.equal(icons.length, 1);
  assert.match(icons[0] ?? '', /spin\.spinning && 'nm-fila__gira'\)/);
});
