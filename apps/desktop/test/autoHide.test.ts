// Event notices hide themselves after 5 s, paused by pointer or focus. `node --test test/*.test.ts`.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mock, test } from 'node:test';
import { NOTICE_HIDE_MS, startAutoHide } from '../src/autoHide.ts';

test('hides after 5 seconds, once', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let hidden = 0;
    startAutoHide(() => hidden++);
    assert.equal(NOTICE_HIDE_MS, 5000);
    mock.timers.tick(4999);
    assert.equal(hidden, 0);
    mock.timers.tick(1);
    assert.equal(hidden, 1);
    mock.timers.tick(20000);
    assert.equal(hidden, 1);
  } finally {
    mock.timers.reset();
  }
});

test('pointer or focus pause it; on leaving it counts the 5 seconds again from zero', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let hidden = 0;
    const h = startAutoHide(() => hidden++);
    mock.timers.tick(3000);
    h.setPointer(true);
    mock.timers.tick(60000);
    assert.equal(hidden, 0);
    h.setFocus(true);
    h.setPointer(false);
    mock.timers.tick(60000);
    assert.equal(hidden, 0, 'focus alone keeps it');
    h.setFocus(false);
    mock.timers.tick(4999);
    assert.equal(hidden, 0);
    mock.timers.tick(1);
    assert.equal(hidden, 1);
  } finally {
    mock.timers.reset();
  }
});

test('stop (unmount or replaced notice) cancels it; a new one starts its own count', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let a = 0;
    let b = 0;
    const first = startAutoHide(() => a++);
    mock.timers.tick(4000);
    first.stop();
    startAutoHide(() => b++);
    mock.timers.tick(4999);
    assert.deepEqual([a, b], [0, 0]);
    mock.timers.tick(1);
    assert.deepEqual([a, b], [0, 1]);
    first.setPointer(false);
    mock.timers.tick(10000);
    assert.equal(a, 0, 'a stopped notice stays stopped');
  } finally {
    mock.timers.reset();
  }
});

test('which notices hide themselves: the event ones; errors and those with an action stay', () => {
  const read = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8');
  for (const f of ['../src/screens/Main.tsx', '../src/screens/Settings.tsx', '../src/screens/ProfileNameCard.tsx', '../src/screens/AddressesSection.tsx', '../src/screens/Sent.tsx']) {
    assert.match(read(f), /autoHide=/, f);
  }
  assert.match(read('../src/components/Aviso.tsx'), /useAutoHide\(autoHide\)/);
  assert.match(read('../src/newMail.ts'), /AUTO_HIDE_MS = NOTICE_HIDE_MS/);
  // Errors and notices with an action to press do not carry it.
  const main = read('../src/screens/Main.tsx');
  assert.doesNotMatch(main, /<Aviso tone="error" strip autoHide/);
  assert.doesNotMatch(read('../src/screens/Recovery.tsx'), /autoHide/);
  assert.doesNotMatch(read('../src/screens/ResumeNotices.tsx'), /autoHide/);
});
