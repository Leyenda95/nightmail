// "Copiar": `copyText` and the `Copiable` notice. `node --test test/*.test.ts`.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { prefs } from '../src/prefs.ts';
import { clearClipboard, copyStatus, copyText, SECRET_CLEAR_SECONDS, secretWipe, type WipeEnv } from '../src/pieces.ts';

const never = () => {
  throw new Error('should not have been called');
};

test('copyText: uses the clipboard and does not touch plan B', async () => {
  const written: string[] = [];
  const ok = await copyText('abc', { writeText: async (t) => void written.push(t), selectAndCopy: never });
  assert.equal(ok, true);
  assert.deepEqual(written, ['abc']);
});

test('copyText: if the clipboard fails or does not exist, tries select and copy', async () => {
  const denied = async () => Promise.reject(new Error('denegado'));
  assert.equal(await copyText('abc', { writeText: denied, selectAndCopy: () => true }), true);
  assert.equal(await copyText('abc', { selectAndCopy: () => true }), true);
});

test('copyText: if nothing works it returns false and does not throw', async () => {
  assert.equal(await copyText('abc', { selectAndCopy: () => false }), false);
  assert.equal(
    await copyText('abc', {
      selectAndCopy: () => {
        throw new Error('x');
      },
    }),
    false,
  );
});

test('copyStatus: "Copiada", the manual way out if it fails and nothing at rest', () => {
  assert.equal(copyStatus('idle'), '');
  assert.equal(copyStatus('ok'), 'Copiada');
  assert.match(copyStatus('fail'), /Ctrl\+C/);
});

test('copyStatus: the recovery phrase says it will be wiped from the clipboard', () => {
  assert.equal(SECRET_CLEAR_SECONDS, 30);
  assert.equal(copyStatus('ok', true), 'Copiada. Se borrará del portapapeles en 30 segundos.');
  assert.equal(copyStatus('ok', false), 'Copiada');
  assert.equal(copyStatus('idle', true), '');
  prefs.setLocale('en');
  try {
    assert.equal(copyStatus('ok', true), 'Copied. It will be cleared from the clipboard in 30 seconds.');
  } finally {
    prefs.setLocale('es');
  }
});

test('clearClipboard: writes an empty text, plan B if that fails, false if nothing works', async () => {
  const written: string[] = [];
  assert.equal(await clearClipboard({ writeText: async (t) => void written.push(t), copyEmpty: never }), true);
  assert.deepEqual(written, ['']);
  const denied = async () => {
    throw new Error('Document is not focused');
  };
  assert.equal(await clearClipboard({ writeText: denied, copyEmpty: () => true }), true);
  assert.equal(await clearClipboard({ writeText: denied, copyEmpty: () => false }), false);
  assert.equal(
    await clearClipboard({
      copyEmpty: () => {
        throw new Error('no');
      },
    }),
    false,
  );
});

/** A fake window: the timer, focus and copy events are fired by hand. `focused` decides whether writing works. */
function fakeWindow() {
  const w = {
    focused: true,
    written: [] as string[],
    timers: new Map<number, () => void>(),
    focusWaiters: new Set<() => void>(),
    copyListeners: new Set<() => void>(),
    next: 1,
  };
  const env: WipeEnv = {
    writeText: async (t) => {
      if (!w.focused) throw new Error('Document is not focused');
      w.written.push(t);
    },
    copyEmpty: () => false,
    setTimer: (fn, ms) => {
      assert.equal(ms, SECRET_CLEAR_SECONDS * 1000);
      const id = w.next++;
      w.timers.set(id, fn);
      return id;
    },
    clearTimer: (id) => void w.timers.delete(id),
    onNextFocus: (fn) => {
      w.focusWaiters.add(fn);
      return () => void w.focusWaiters.delete(fn);
    },
    onCopy: (fn) => {
      w.copyListeners.add(fn);
      return () => void w.copyListeners.delete(fn);
    },
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  async function fireTimers() {
    const fns = [...w.timers.values()];
    w.timers.clear();
    for (const fn of fns) fn();
    await tick();
  }
  async function focus() {
    const fns = [...w.focusWaiters];
    w.focusWaiters.clear();
    for (const fn of fns) fn();
    await tick();
  }
  function copy() {
    for (const fn of [...w.copyListeners]) fn();
  }
  return { w, env, fireTimers, focus, copy };
}

test('secretWipe: at 30 seconds the clipboard is emptied, and nothing is left waiting', async () => {
  const f = fakeWindow();
  const wipe = secretWipe(f.env);
  wipe.schedule();
  assert.equal(f.w.timers.size, 1);
  await f.fireTimers();
  assert.deepEqual(f.w.written, ['']);
  assert.equal(f.w.focusWaiters.size, 0);
  assert.equal(f.w.copyListeners.size, 0);
});

test('secretWipe: another copy in the app (a copy button or Ctrl+C) cancels the wipe', async () => {
  // A copy button that is not secret: `useCopy` calls `cancel`.
  const f = fakeWindow();
  const wipe = secretWipe(f.env);
  wipe.schedule();
  wipe.cancel();
  await f.fireTimers();
  assert.deepEqual(f.w.written, []);
  // Ctrl+C in the window: the `copy` event.
  const g = fakeWindow();
  secretWipe(g.env).schedule();
  g.copy();
  assert.equal(g.w.timers.size, 0);
  await g.fireTimers();
  assert.deepEqual(g.w.written, []);
  // Copying the phrase again starts the count again: one timer only.
  const h = fakeWindow();
  const again = secretWipe(h.env);
  again.schedule();
  again.schedule();
  assert.equal(h.w.timers.size, 1);
  assert.equal(h.w.copyListeners.size, 1);
});

test('secretWipe: without focus it tries again on every return of focus until it works', async () => {
  const f = fakeWindow();
  const wipe = secretWipe(f.env);
  wipe.schedule();
  f.w.focused = false;
  await f.fireTimers();
  assert.deepEqual(f.w.written, []);
  assert.equal(f.w.focusWaiters.size, 1);
  // The focus event arrives before the document can write: it waits again.
  await f.focus();
  assert.deepEqual(f.w.written, []);
  assert.equal(f.w.focusWaiters.size, 1);
  f.w.focused = true;
  await f.focus();
  assert.deepEqual(f.w.written, ['']);
  assert.equal(f.w.focusWaiters.size, 0);
  // A copy while it waits for focus cancels it too.
  const g = fakeWindow();
  secretWipe(g.env).schedule();
  g.w.focused = false;
  await g.fireTimers();
  g.copy();
  assert.equal(g.w.focusWaiters.size, 0);
});

test('secretWipe: plan B of the wipe is itself a copy and does not cancel the wipe', async () => {
  const f = fakeWindow();
  let copies = 0;
  f.env.writeText = undefined;
  f.env.copyEmpty = () => {
    copies++;
    f.copy();
    return false;
  };
  secretWipe(f.env).schedule();
  await f.fireTimers();
  assert.equal(copies, 1);
  // It failed, so it still waits for focus: the copy event of its own plan B did not cancel it.
  assert.equal(f.w.focusWaiters.size, 1);
});

test('the phrase copy buttons are secret, the wipe lives outside the component and any other copy cancels it', () => {
  for (const f of ['../src/screens/Welcome.tsx', '../src/screens/SeedReveal.tsx']) {
    assert.match(readFileSync(new URL(f, import.meta.url), 'utf8'), /<CopyButton text=\{seedWords\(phrase\)\.join\(' '\)\} label=\{s\.copy\} secret \/>/, f);
  }
  const c = readFileSync(new URL('../src/components/Copiable.tsx', import.meta.url), 'utf8');
  assert.match(c, /^const phraseWipe = secretWipe\(\{$/m);
  assert.match(c, /if \(ok\) \{\s*if \(secret\) phraseWipe\.schedule\(\);\s*else phraseWipe\.cancel\(\);\s*\}/);
  assert.match(c, /document\.addEventListener\('copy', fn\);/);
});
