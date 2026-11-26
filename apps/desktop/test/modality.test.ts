// Keyboard-only focus: `<html data-nm-entrada>` says whether the last input was the mouse or the keyboard, and app.css hides the
// focus ring while the mouse is in charge (also the one set from code: list title, reader...).
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  focusKind,
  INPUT_ATTR,
  switchesToKeyboard,
  watchInputModality,
  type ElementLike,
  type KeyPress,
  type ModalityDocument,
  type ModalityWindow,
  type WatchedEvent,
} from '../src/modality.ts';

function el(tagName: string, attrs: Record<string, string> = {}): ElementLike {
  return { tagName, getAttribute: (name) => attrs[name] ?? null };
}

test('focusKind: buttons, links, checkboxes, dropdowns, rows and the handle are controls, what only scrolls is not', () => {
  const controls: ElementLike[] = [
    el('BUTTON'),
    el('A', { href: '#' }),
    el('SUMMARY'),
    el('SELECT'),
    el('INPUT', { type: 'checkbox' }),
    el('INPUT', { type: 'radio' }),
    el('DIV', { role: 'separator' }),
    el('LI', { role: 'option' }),
    el('UL', { 'data-nm-flechas': '' }),
  ];
  for (const c of controls) assert.equal(focusKind(c), 'control', c.tagName);
  const others: (ElementLike | null)[] = [
    null,
    el('BODY'),
    el('PRE', { tabindex: '0' }),
    el('H1', { tabindex: '-1' }),
    el('ARTICLE', { tabindex: '-1' }),
    el('DIALOG'),
    el('IFRAME', { tabindex: '0' }),
    el('A'),
    el('INPUT'),
    el('INPUT', { type: 'password' }),
    el('TEXTAREA'),
  ];
  for (const o of others) assert.equal(focusKind(o), 'otro', o?.tagName);
});

test('switchesToKeyboard: Tab and Shift+Tab always, arrows, Home, End, Enter and Space only on a control', () => {
  const press = (key: string, mods: Partial<KeyPress> = {}): KeyPress => ({ key, ...mods });
  const both = (p: KeyPress) => [switchesToKeyboard(p, 'control'), switchesToKeyboard(p, 'otro')];

  assert.deepEqual(both(press('Tab')), [true, true]);
  assert.deepEqual(both(press('Tab', { shiftKey: true })), [true, true], 'Shift+Tab counts');
  for (const key of ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' ']) {
    assert.deepEqual(both(press(key)), [true, false], key);
  }
  assert.deepEqual(both(press('ArrowDown', { shiftKey: true })), [true, false], 'Shift+arrow on a control counts');
  // Scrolling the page, closing a dialog opened with the mouse, Shift alone or typing: no.
  for (const key of ['PageDown', 'PageUp', 'Escape', 'Shift', 'a', 'F5']) {
    assert.deepEqual(both(press(key)), [false, false], key);
  }
  assert.deepEqual(both(press('Shift', { shiftKey: true })), [false, false], 'Shift alone');
  assert.deepEqual(both(press('A', { shiftKey: true })), [false, false], 'Shift+letter');
  // Shortcuts (copy, switching windows): no, not even with Tab.
  for (const mod of ['ctrlKey', 'altKey', 'metaKey'] as const) {
    assert.deepEqual(both(press('Tab', { [mod]: true })), [false, false], mod);
    assert.deepEqual(both(press('ArrowDown', { [mod]: true })), [false, false], mod);
  }
});

type Listener = (e: WatchedEvent) => void;

/** A fake `addEventListener` that, like the real one, only removes a listener with the same function and the same phase. */
function registry() {
  const all: { type: string; fn: Listener; capture: boolean }[] = [];
  return {
    all,
    add: (type: string, fn: Listener, capture: boolean) => void all.push({ type, fn, capture }),
    remove: (type: string, fn: Listener, capture: boolean) => {
      const i = all.findIndex((r) => r.type === type && r.fn === fn && r.capture === capture);
      if (i !== -1) all.splice(i, 1);
    },
    fire: (type: string, e: WatchedEvent) => {
      for (const r of all.filter((x) => x.type === type)) r.fn(e);
    },
  };
}

function fakes() {
  const docL = registry();
  const winL = registry();
  const attrs = new Map<string, string>();
  const writes: string[] = [];
  const state: { active: ElementLike | null; now: number } = { active: null, now: 1000 };
  const doc: ModalityDocument = {
    get activeElement() {
      return state.active;
    },
    documentElement: {
      setAttribute: (name, value) => {
        writes.push(value);
        attrs.set(name, value);
      },
      removeAttribute: (name) => void attrs.delete(name),
    },
    addEventListener: docL.add,
    removeEventListener: docL.remove,
  };
  const win: ModalityWindow = { document: doc, addEventListener: winL.add, removeEventListener: winL.remove };
  const at = (ms: number) => void (state.now = ms);
  const key = (k: string, target: ElementLike | null = el('BUTTON'), mods: Partial<KeyPress> = {}) =>
    docL.fire('keydown', { timeStamp: state.now, key: k, target, ...mods });
  const pointer = (type = 'pointerdown') => docL.fire(type, { timeStamp: state.now });
  const focusIn = (target: ElementLike) => {
    state.active = target;
    docL.fire('focusin', { timeStamp: state.now, target });
  };
  /** The window loses focus: with a click inside the mail (iframe) Chromium leaves the iframe as `activeElement`. */
  const blur = (active: ElementLike | null) => {
    state.active = active;
    winL.fire('blur', { timeStamp: state.now });
  };
  return { win, attrs, writes, docL, winL, at, key, pointer, focusIn, blur };
}

const FRAME = el('IFRAME', { tabindex: '0' });

test('watchInputModality: untouched it starts without a ring, Tab switches to keyboard, a click switches back', () => {
  const f = fakes();
  const stop = watchInputModality(f.win);
  assert.equal(f.attrs.get(INPUT_ATTR), 'puntero', 'at startup the browser does not decide: no ring until a key');
  // Unlocking by typing the password and pressing Enter is not moving with the keyboard: the focus the app then sets on
  // the inbox title carries no ring.
  const password = el('INPUT', { type: 'password' });
  f.key('a', password);
  f.key('Enter', password);
  f.focusIn(el('H1', { tabindex: '-1' }));
  assert.equal(f.attrs.get(INPUT_ATTR), 'puntero');

  f.key('Tab', el('BODY'));
  assert.equal(f.attrs.get(INPUT_ATTR), 'teclado');
  f.pointer();
  assert.equal(f.attrs.get(INPUT_ATTR), 'puntero');
  f.key('Tab');
  f.pointer('mousedown');
  assert.equal(f.attrs.get(INPUT_ATTR), 'puntero');
  stop();
});

test('watchInputModality: with the mouse, Esc, Page Down and the arrows on the mail text do not turn on the ring', () => {
  const f = fakes();
  const stop = watchInputModality(f.win);
  f.pointer();
  f.key('Escape', el('DIALOG'));
  f.key('Escape', el('BUTTON'));
  f.key('PageDown', el('PRE', { tabindex: '0' }));
  f.key('ArrowDown', el('PRE', { tabindex: '0' }));
  f.key(' ', el('H1', { tabindex: '-1' }));
  f.key('Shift', el('BUTTON'), { shiftKey: true });
  f.key('c', el('BUTTON'), { ctrlKey: true });
  assert.equal(f.attrs.get(INPUT_ATTR), 'puntero');
  // Enter on a button (opens a dialog with the keyboard): the focus the dialog sets is shown.
  f.key('Enter', el('BUTTON'));
  assert.equal(f.attrs.get(INPUT_ATTR), 'teclado');
  stop();
});

test('watchInputModality: only writes the attribute when it changes (a held key does not rewrite it)', () => {
  const f = fakes();
  const stop = watchInputModality(f.win);
  for (let i = 0; i < 30; i++) f.key('ArrowDown', el('BUTTON'));
  f.pointer();
  f.pointer('mousedown');
  f.pointer();
  assert.deepEqual(f.writes, ['puntero', 'teclado', 'puntero']);
  stop();
});

test('watchInputModality: click inside the mail and Tab to leave it: focus comes out with a ring', () => {
  const f = fakes();
  const stop = watchInputModality(f.win);
  f.pointer();
  f.at(2000);
  f.blur(FRAME);
  // Tab is pressed inside the iframe (it does not arrive); outside, only focus returning to the app is seen, with no click before.
  f.at(3000);
  f.focusIn(el('BUTTON'));
  assert.equal(f.attrs.get(INPUT_ATTR), 'teclado');
  stop();
});

test('watchInputModality: leaving the mail with a click in the app does not turn on the ring', () => {
  const f = fakes();
  const stop = watchInputModality(f.win);
  f.pointer();
  f.at(2000);
  f.blur(FRAME);
  f.at(3000);
  f.pointer();
  f.at(3004);
  f.focusIn(el('BUTTON'));
  assert.equal(f.attrs.get(INPUT_ATTR), 'puntero');
  // Once outside the mail, a focus moved by code does not count as keyboard.
  f.at(5000);
  f.focusIn(el('H1', { tabindex: '-1' }));
  assert.equal(f.attrs.get(INPUT_ATTR), 'puntero');
  stop();
});

test('watchInputModality: switching window while not in the mail does not count as leaving it', () => {
  const f = fakes();
  const stop = watchInputModality(f.win);
  f.pointer();
  f.focusIn(el('BUTTON'));
  f.at(2000);
  f.blur(el('BUTTON'));
  f.at(9000);
  f.focusIn(el('BUTTON'));
  assert.equal(f.attrs.get(INPUT_ATTR), 'puntero');
  stop();
});

test("watchInputModality: listens in capture (the blur, only the window's) and, on stop, removes everything", () => {
  const f = fakes();
  const stop = watchInputModality(f.win);
  assert.deepEqual(f.docL.all.map((r) => r.type).sort(), ['focusin', 'keydown', 'mousedown', 'pointerdown']);
  for (const r of f.docL.all) assert.equal(r.capture, true, r.type);
  assert.deepEqual(f.winL.all.map((r) => [r.type, r.capture]), [['blur', false]]);
  f.key('Tab');
  stop();
  assert.equal(f.docL.all.length, 0);
  assert.equal(f.winL.all.length, 0);
  assert.equal(f.attrs.has(INPUT_ATTR), false);
});

test('app.css: with the mouse no focus ring is shown, except on text fields', () => {
  const css = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const gate = ':root\\[data-nm-entrada="puntero"\\]';
  // The app's ring and the browser's (outline), and that of the base buttons (border and halo, via variables).
  assert.match(
    css,
    new RegExp(
      `^${gate} :focus-visible:not\\(input:not\\(\\[type="checkbox"\\], \\[type="radio"\\]\\), textarea, select\\) \\{\\s*outline: none;\\s*--focus-ring: transparent;\\s*--focus-outline: var\\(--button-default-border-color, transparent\\);\\s*\\}`,
      'm',
    ),
  );
  // What is drawn outside the focused element (the checkbox and the option, with :has) is turned off too.
  assert.match(css, new RegExp(`${gate} \\.nm-eleccion:has\\(input:focus-visible\\),\\s*${gate} \\.nm-casilla:has\\(input:focus-visible\\) \\.nm-casilla__caja \\{ outline: none; box-shadow: none; \\}`));
});

test('Inbox.tsx: the message list, walked with the arrows, carries the control mark', () => {
  const tsx = readFileSync(new URL('../src/screens/Inbox.tsx', import.meta.url), 'utf8');
  assert.match(tsx, /\sdata-nm-flechas=""\s+onKeyDown=\{\(e\) => onRowKey\(/);
});
