// Stillness: unfocused or hidden, `<html data-quieto>` and app.css for the endless animations.
// Only hidden, `<html data-oculta>`: the only thing that stops the three wait indicators.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { setTimeout as tick } from 'node:timers/promises';
import { HIDDEN_ATTR, shouldBeStill, STILL_ATTR, watchStillness, type StillnessDocument, type StillnessWindow } from '../src/stillness.ts';

test('shouldBeStill: hidden or unfocused, still, visible and focused, running', () => {
  assert.equal(shouldBeStill('visible', true), false);
  assert.equal(shouldBeStill('visible', false), true);
  assert.equal(shouldBeStill('hidden', true), true);
  assert.equal(shouldBeStill('hidden', false), true);
});

function fakes() {
  const listeners = new Map<string, () => void>();
  const attrs = new Set<string>();
  const state = { visibility: 'visible' as DocumentVisibilityState, docFocus: false };
  const on = (type: string, fn: () => void) => void listeners.set(type, fn);
  const off = (type: string) => void listeners.delete(type);
  const win: StillnessWindow = { addEventListener: on, removeEventListener: off };
  const doc: StillnessDocument = {
    get visibilityState() {
      return state.visibility;
    },
    hasFocus: () => state.docFocus,
    documentElement: {
      toggleAttribute(name: string, force: boolean) {
        if (force) attrs.add(name);
        else attrs.delete(name);
        return force;
      },
    },
    addEventListener: on,
    removeEventListener: off,
  };
  const fire = (type: string) => listeners.get(type)?.();
  return { win, doc, attrs, state, fire, listeners };
}

test('watchStillness: starts running, stops on losing focus or hiding and resumes on regaining it', async () => {
  const f = fakes();
  const stop = watchStillness(f.win, f.doc);
  assert.equal(f.attrs.has(STILL_ATTR), false, 'with no event it does not stop');

  f.fire('blur');
  await tick(5);
  assert.equal(f.attrs.has(STILL_ATTR), true);
  f.fire('focus');
  assert.equal(f.attrs.has(STILL_ATTR), false);

  f.state.visibility = 'hidden';
  f.fire('visibilitychange');
  assert.equal(f.attrs.has(STILL_ATTR), true);
  f.state.visibility = 'visible';
  f.fire('visibilitychange');
  assert.equal(f.attrs.has(STILL_ATTR), false);

  stop();
  assert.equal(f.listeners.size, 0);
  assert.equal(f.attrs.has(STILL_ATTR), false);
});

test('watchStillness: data-oculta only with the window hidden, never on losing focus', async () => {
  const f = fakes();
  const stop = watchStillness(f.win, f.doc);
  assert.equal(f.attrs.has(HIDDEN_ATTR), false);
  f.fire('blur');
  await tick(5);
  assert.equal(f.attrs.has(STILL_ATTR), true, 'unfocused: still');
  assert.equal(f.attrs.has(HIDDEN_ATTR), false, 'unfocused but visible: not hidden');
  f.state.visibility = 'hidden';
  f.fire('visibilitychange');
  assert.equal(f.attrs.has(HIDDEN_ATTR), true);
  f.state.visibility = 'visible';
  f.fire('visibilitychange');
  assert.equal(f.attrs.has(HIDDEN_ATTR), false);
  assert.equal(f.attrs.has(STILL_ATTR), true, 'still unfocused');
  f.state.visibility = 'hidden';
  f.fire('visibilitychange');
  stop();
  assert.equal(f.attrs.has(HIDDEN_ATTR), false, 'removed when watching stops');
});

test('watchStillness: focus entering the reader iframe does not stop it', async () => {
  const f = fakes();
  f.state.docFocus = true; // the document still has focus: its iframe holds it
  const stop = watchStillness(f.win, f.doc);
  f.fire('blur');
  await tick(5);
  assert.equal(f.attrs.has(STILL_ATTR), false);
  stop();
});

test('watchStillness: with focus in the iframe, it stops when the window loses it (no blur of its own)', async () => {
  const f = fakes();
  f.state.docFocus = true;
  const stop = watchStillness(f.win, f.doc, 5);
  f.fire('blur');
  await tick(10);
  assert.equal(f.attrs.has(STILL_ATTR), false);
  f.state.docFocus = false; // another window in front: the blur reaches the iframe, not this document
  await tick(30);
  assert.equal(f.attrs.has(STILL_ATTR), true);
  f.fire('focus');
  assert.equal(f.attrs.has(STILL_ATTR), false);
  stop();
});

test('app.css: endless pulsing goes in steps (a single switch) and stops with data-quieto', () => {
  const css = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /:root \{ --nm-latido-paso: steps\(12\); --nm-trabaja-paso: steps\(8\); \}/);
  for (const [cls, paso, gate] of [
    ['nm-luz--late', 'latido', ':root\\[data-movimiento\\] '],
    ['nm-luz--trabaja', 'trabaja', ''],
    ['nm-noche__luz', 'latido', ':root\\[data-movimiento\\] '],
    ['nm-noche__tuya', 'latido', ':root\\[data-movimiento\\] '],
  ]) {
    const rule = new RegExp(`^${gate}\\.${cls} \\{ animation: [^;]* var\\(--nm-${paso}-paso\\) infinite; \\}`, 'm');
    assert.match(css, rule, `${cls} follows --nm-${paso}-paso`);
  }
  // Still by default: the only thing that repeats without `data-movimiento` is what indicates work in progress.
  const loops = [...css.matchAll(/^([^{}\n]+)\{[^}]*\binfinite\b/gm)].map((m) => m[1].trim());
  const ungated = loops.filter((sel) => !sel.startsWith(':root[data-movimiento] '));
  assert.deepEqual(ungated.sort(), ['.nm-espera__gira', '.nm-fila__gira', '.nm-luz--trabaja']);
  const still = /:root\[data-quieto\] \.nm-luz:not\(\.nm-luz--trabaja\),\s*:root\[data-quieto\] \.nm-noche__luz,\s*:root\[data-quieto\] \.nm-noche__tuya \{ animation-play-state: paused; \}/;
  assert.match(css, still);
  // The wait icon's smooth spin: continuous (no steps).
  assert.match(css, /^\.nm-espera__gira \{ animation: nm-gira 1s linear infinite; \}/m);
  // The three wait indicators only stop with the window hidden (data-oculta).
  const hidden = /:root\[data-oculta\] \.nm-luz--trabaja,\s*:root\[data-oculta\] \.nm-fila__gira,\s*:root\[data-oculta\] \.nm-espera__gira \{ animation-play-state: paused; \}/;
  assert.match(css, hidden);
});

test('app.css: data-quieto (unfocused) does not pause the wait indicators and data-oculta pauses nothing else', () => {
  const css = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap((m) => m[1].split(',').map((s) => s.trim()));
  const withAttr = (attr: string) => selectors.filter((s) => s.startsWith(`:root[${attr}]`));
  const quieto = withAttr('data-quieto');
  assert.ok(quieto.length > 0);
  for (const cls of ['nm-espera__gira', 'nm-fila__gira']) {
    assert.ok(!quieto.some((s) => s.includes(`.${cls}`)), `${cls} is not paused by data-quieto`);
  }
  // A bare `.nm-luz` would also catch the working light: each light rule with data-quieto must exclude it.
  for (const s of quieto.filter((x) => /\.nm-luz(?![-\w])/.test(x))) {
    assert.ok(s.includes(':not(.nm-luz--trabaja)'), `${s} excludes the working light`);
  }
  assert.ok(!quieto.some((s) => s.replace(':not(.nm-luz--trabaja)', '').includes('.nm-luz--trabaja')));
  assert.deepEqual(withAttr('data-oculta').sort(), [
    ':root[data-oculta] .nm-espera__gira',
    ':root[data-oculta] .nm-fila__gira',
    ':root[data-oculta] .nm-luz--trabaja',
  ]);
});

test('app.css: with reduced motion (Windows without "Efectos de animación") the wait indicators keep moving', () => {
  // The wait icon looked still on Windows. Only what is decorative is turned off.
  const css = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([^@]*?)\n\}/g)].map((m) => m[1]);
  assert.ok(blocks.length > 0, 'there is a reduced motion block');
  const body = blocks.join('\n');
  assert.match(body, /\.nm-luz:not\(\.nm-luz--trabaja\) \{ animation: none !important; \}/);
  for (const cls of ['nm-espera__gira', 'nm-fila__gira']) assert.doesNotMatch(body, new RegExp(`\\.${cls}\\b`), cls);
  assert.doesNotMatch(body, /\.nm-luz--trabaja\s*[,{]/);
});

test('the wait indicators carry keep-motion (the base stylesheet stops the rest with reduced motion) and no decorative one', () => {
  const read = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
  const icon = read('components/Icon.tsx');
  assert.ok(icon.includes("name === 'espera' ? 'nm-espera__gira keep-motion '"), 'wait icon');
  assert.ok(read('components/Sidebar.tsx').includes("syncing && 'nm-fila__gira keep-motion'"), 'Actualizar spinner');
  const luz = read('components/Luz.tsx');
  assert.ok(luz.includes("mode === 'trabaja' ? ' keep-motion' : ''"), 'working light');
  assert.ok(luz.includes('luzClass(mode, rhythm) + keep'), 'the class is added to the light');
  // The front screen's slogans also fade with reduced motion (only the slogan).
  const welcome = read('screens/Welcome.tsx');
  assert.ok(welcome.includes("className={i === index ? 'nm-lema keep-motion nm-lema--visible' : 'nm-lema keep-motion'}"), 'lema');
  assert.equal((welcome.match(/keep-motion/g) ?? []).length, 2, 'in Welcome only the slogan (visible and not visible)');
  // Only those files carry it: no light or decorative ornament.
  const all = ['components', 'screens'].flatMap((d) => readdirSync(new URL(`../src/${d}`, import.meta.url)).map((f) => `${d}/${f}`)).concat(['App.tsx', 'pieces.ts']);
  const withKeep = all.filter((f) => /\.tsx?$/.test(f) && read(f).includes('keep-motion')).sort();
  // The refresh buttons of the lists turn like the sidebar's while they work (spin.test.ts).
  assert.deepEqual(withKeep, ['components/Icon.tsx', 'components/Luz.tsx', 'components/Sidebar.tsx', 'screens/Inbox.tsx', 'screens/Welcome.tsx']);
  assert.equal((icon.match(/keep-motion/g) ?? []).length, 1);
});

test('app.css: the slogan fades with a transition (what keep-motion protects from the base stylesheet)', () => {
  const css = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /^\.nm-lema \{[^}]*transition: opacity \d+ms/m);
  assert.match(css, /^\.nm-lema--visible \{[^}]*transition: opacity \d+ms/m);
  // No reduced-motion @media of its own removes the slogan's fade.
  const blocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([^@]*?)\n\}/g)].map((m) => m[1]).join('\n');
  assert.doesNotMatch(blocks, /\.nm-lema/);
});
