// Interface preferences: `node --test test/*.test.ts`.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import {
  applyLocale,
  applySize,
  applyTheme,
  autoSize,
  BADGE_COUNTS,
  FIXED_SIZES,
  resolveSize,
  type ScreenInfo,
  createPrefs,
  createSystemTheme,
  DEFAULT_PREFS,
  effectiveLayout,
  effectiveTheme,
  LAYOUTS,
  LOCALES,
  parseBadgeCount,
  parseLayout,
  parseLocale,
  parseSize,
  parseSound,
  parseTheme,
  sizeFontSize,
  SOUNDS,
  SIZES,
  LEGACY_SIZES,
  SIDEBAR_REM,
  sidebarRem,
  STORAGE_KEYS,
  themeAttr,
  THEMES,
  viewportRem,
  watchScreen,
  type PrefsEnv,
} from '../src/prefs.ts';
import { LIST_WIDTH_MIN } from '../src/resize.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

// What may have been stored: the good, the odd (uppercase, spaces, the attribute's value, sizes not in the
// list, names of Object properties) and nothing.
const STORED = [
  ...THEMES, ...LAYOUTS, ...SIZES, ...Object.keys(LEGACY_SIZES), ...LOCALES,
  'EN', 'es-ES', ' es', 'Español', 'Oscuro', ' claro', 'dark', 'light', '120', '150 ', '150.0', '21', '1e2', '', 'null', 'toString', '__proto__', null,
];

/** A stand-in `<html>`: it only stores attributes and `style` properties. */
function fakeRoot(initial?: string, initialFont?: string) {
  const attrs = new Map<string, string>(initial === undefined ? [] : [['data-theme', initial]]);
  const props = new Map<string, string>(initialFont === undefined ? [] : [['--setting-font-size', initialFont]]);
  return {
    theme: () => attrs.get('data-theme') ?? null,
    lang: () => attrs.get('lang') ?? null,
    font: () => props.get('--setting-font-size') ?? null,
    setAttribute: (name: string, value: string) => void attrs.set(name, value),
    removeAttribute: (name: string) => void attrs.delete(name),
    style: {
      setProperty: (name: string, value: string) => void props.set(name, value),
      removeProperty: (name: string) => (props.delete(name), ''),
    },
  };
}

/** A stand-in `localStorage`; `broken` makes reading or writing throw, as with blocked storage. */
function fakeStorage(initial: Record<string, string> = {}, broken = false) {
  const items = new Map(Object.entries(initial));
  const fail = () => {
    if (broken) throw new Error('SecurityError');
  };
  return {
    items,
    reads: 0,
    getItem(key: string) {
      this.reads += 1;
      fail();
      return items.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      fail();
      items.set(key, value);
    },
  };
}

function fakeEnv(initial: Record<string, string> = {}, broken = false) {
  const storage = fakeStorage(initial, broken);
  const root = fakeRoot();
  const env: PrefsEnv = { storage: () => storage, root: () => root };
  return { storage, root, env };
}

test('the keys and defaults are the designed ones', () => {
  assert.deepEqual(STORAGE_KEYS, {
    theme: 'nm.tema',
    layout: 'nm.disposicion',
    listWidth: 'nm.ancho-lista',
    size: 'nm.tamano',
    locale: 'nm.idioma',
    sound: 'nm.sonido',
    badgeCount: 'nm.insignia-numero',
  });
  assert.deepEqual(DEFAULT_PREFS, { theme: 'oscuro', layout: 'tres', listWidth: 20.5, size: 'auto', locale: 'en', sound: 'on', badgeCount: 'on' });
  assert.equal(SIZES[0], DEFAULT_PREFS.size, 'the first size is the default');
  assert.deepEqual([...THEMES], ['sistema', 'claro', 'oscuro']);
  assert.deepEqual([...LAYOUTS], ['tres', 'dos']);
  assert.deepEqual([...LOCALES], ['en', 'es']);
});

test('parseTheme and parseLayout: valid values pass as is, odd or missing ones give the default', () => {
  for (const theme of THEMES) assert.equal(parseTheme(theme), theme);
  for (const layout of LAYOUTS) assert.equal(parseLayout(layout), layout);
  for (const raw of [...STORED, undefined, 0, {}, ['oscuro']]) {
    if (!THEMES.includes(raw as never)) assert.equal(parseTheme(raw), 'oscuro', `tema ${String(raw)}`);
    if (!LAYOUTS.includes(raw as never)) assert.equal(parseLayout(raw), 'tres', `layout ${String(raw)}`);
  }
});

test('themeAttr: the data-theme values are exactly those tokens.css understands', () => {
  assert.equal(themeAttr('sistema'), null);
  assert.equal(themeAttr('claro'), 'light');
  assert.equal(themeAttr('oscuro'), 'dark');
  const tokens = read('../../../design/brand/tokens.css');
  for (const theme of THEMES) {
    const attr = themeAttr(theme);
    if (attr) assert.ok(tokens.includes(`[data-theme="${attr}"] {`), `tokens.css has no block for ${attr}`);
  }
  // Without an attribute the system rules, unless light is forced: it is the rule that leaves "sistema" without an attribute.
  assert.ok(tokens.includes('@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {'));
});

test('effectiveTheme: the preference rules, with "sistema" whatever the computer says', () => {
  assert.equal(effectiveTheme('claro', true), 'light');
  assert.equal(effectiveTheme('claro', false), 'light');
  assert.equal(effectiveTheme('oscuro', true), 'dark');
  assert.equal(effectiveTheme('oscuro', false), 'dark');
  assert.equal(effectiveTheme('sistema', true), 'dark');
  assert.equal(effectiveTheme('sistema', false), 'light');
});

test('applyTheme: sets data-theme and removes it for "el del sistema"', () => {
  const root = fakeRoot('dark');
  applyTheme('claro', root);
  assert.equal(root.theme(), 'light');
  applyTheme('oscuro', root);
  assert.equal(root.theme(), 'dark');
  applyTheme('sistema', root);
  assert.equal(root.theme(), null);
});

test('store: reads what is saved only once and validates each preference separately', () => {
  const { env, storage } = fakeEnv({ 'nm.tema': 'oscuro', 'nm.disposicion': 'cuatro', 'nm.ancho-lista': '26', 'nm.tamano': '130' });
  const prefs = createPrefs(env);
  assert.equal(storage.reads, 0, 'does not touch storage until asked');
  assert.deepEqual(prefs.get(), { theme: 'oscuro', layout: 'tres', listWidth: 26, size: '125', locale: 'en', sound: 'on', badgeCount: 'on' });
  // The same snapshot as long as nothing changes (required by `useSyncExternalStore`).
  assert.equal(prefs.get(), prefs.get());
  assert.equal(storage.reads, 7);
});

test('store: with nothing saved, without storage or if it throws, the default', () => {
  const root = fakeRoot();
  const broken = fakeStorage({ 'nm.tema': 'oscuro', 'nm.disposicion': 'dos' }, true);
  const denied = () => {
    throw new Error('SecurityError');
  };
  const envs: PrefsEnv[] = [
    fakeEnv().env,
    { storage: () => undefined, root: () => root },
    { storage: () => null, root: () => root },
    { storage: () => broken, root: () => root },
    { storage: denied, root: () => root },
  ];
  for (const env of envs) assert.deepEqual(createPrefs(env).get(), DEFAULT_PREFS);
});

test('store: changing the theme saves it, applies it to the document and notifies', () => {
  const { env, storage, root } = fakeEnv();
  const prefs = createPrefs(env);
  let calls = 0;
  const off = prefs.subscribe(() => (calls += 1));

  prefs.setTheme('claro');
  assert.deepEqual(prefs.get(), { theme: 'claro', layout: 'tres', listWidth: 20.5, size: 'auto', locale: 'en', sound: 'on', badgeCount: 'on' });
  assert.equal(storage.items.get('nm.tema'), 'claro');
  assert.equal(root.theme(), 'light');
  assert.equal(calls, 1);

  prefs.setTheme('sistema');
  assert.equal(storage.items.get('nm.tema'), 'sistema');
  assert.equal(root.theme(), null);
  assert.equal(calls, 2);

  // The same as before: no new snapshot and no notification (there is nothing to repaint).
  const before = prefs.get();
  prefs.setTheme('sistema');
  assert.equal(prefs.get(), before);
  assert.equal(calls, 2);

  off();
  prefs.setTheme('claro');
  assert.equal(calls, 2, 'whoever unsubscribes gets no more notifications');
  assert.equal(root.theme(), 'light');
});

test('store: changing the layout saves it and notifies, without touching the theme', () => {
  const { env, storage, root } = fakeEnv({ 'nm.tema': 'claro' });
  const prefs = createPrefs(env);
  let calls = 0;
  prefs.subscribe(() => (calls += 1));
  prefs.setLayout('dos');
  assert.deepEqual(prefs.get(), { theme: 'claro', layout: 'dos', listWidth: 20.5, size: 'auto', locale: 'en', sound: 'on', badgeCount: 'on' });
  assert.equal(storage.items.get('nm.disposicion'), 'dos');
  assert.equal(storage.items.get('nm.tema'), 'claro');
  assert.equal(calls, 1);
  // Another store over the same thing (the app on reopening) reads what was stored.
  assert.deepEqual(createPrefs({ storage: () => storage, root: () => root }).get(), { theme: 'claro', layout: 'dos', listWidth: 20.5, size: 'auto', locale: 'en', sound: 'on', badgeCount: 'on' });
});

test('store: if it cannot be saved, the change still holds until the app closes', () => {
  const { env, storage, root } = fakeEnv({}, true);
  const prefs = createPrefs(env);
  let calls = 0;
  prefs.subscribe(() => (calls += 1));
  prefs.setTheme('claro');
  prefs.setLayout('dos');
  prefs.setSize('150');
  assert.deepEqual(prefs.get(), { theme: 'claro', layout: 'dos', listWidth: 20.5, size: '150', locale: 'en', sound: 'on', badgeCount: 'on' });
  assert.equal(root.theme(), 'light');
  assert.equal(root.font(), '21');
  assert.equal(calls, 3);
  assert.equal(storage.items.size, 0);
});

test('store: the list width is read clamped, saved as text and holds for next time', () => {
  for (const [stored, read] of [['31.5', 31.5], ['12', 20.5], ['90', 20.5], ['ancho', 20.5]] as const) {
    assert.equal(createPrefs(fakeEnv({ 'nm.ancho-lista': stored }).env).get().listWidth, read, stored);
  }
  const { env, storage, root } = fakeEnv({ 'nm.tema': 'oscuro' });
  const prefs = createPrefs(env);
  let calls = 0;
  prefs.subscribe(() => (calls += 1));
  prefs.setListWidth(28);
  assert.deepEqual(prefs.get(), { theme: 'oscuro', layout: 'tres', listWidth: 28, size: 'auto', locale: 'en', sound: 'on', badgeCount: 'on' });
  assert.equal(storage.items.get('nm.ancho-lista'), '28');
  assert.equal(root.theme(), 'dark', 'does not touch the theme');
  assert.equal(calls, 1);
  prefs.setListWidth(28);
  assert.equal(calls, 1, 'the same width does not notify');
  // Out of range it is clamped; anything that is not a number, the default.
  prefs.setListWidth(80);
  assert.equal(storage.items.get('nm.ancho-lista'), '40');
  prefs.setListWidth(3);
  assert.equal(prefs.get().listWidth, 17);
  prefs.setListWidth(NaN);
  assert.equal(storage.items.get('nm.ancho-lista'), '20.5');
  prefs.setListWidth(31.5);
  assert.equal(createPrefs({ storage: () => storage, root: () => root }).get().listWidth, 31.5);
});

test('sizes: the list, its validation and what goes into --setting-font-size', () => {
  assert.deepEqual([...SIZES], ['auto', '100', '125', '150']);
  assert.deepEqual([...FIXED_SIZES], ['100', '125', '150']);
  for (const size of SIZES) assert.equal(parseSize(size), size);
  for (const raw of [...STORED, undefined, 0, 150, {}, ['150']]) {
    if (!SIZES.includes(raw as never) && !(raw === '115' || raw === '130' || raw === '175' || raw === '200')) assert.equal(parseSize(raw), 'auto', `size ${String(raw)}`);
  }
  // 14 px is the base stylesheet's default (root at 16 px): no property. The others, 14 times the %, rounded.
  assert.deepEqual(FIXED_SIZES.map(sizeFontSize), [null, 18, 21]);
  // What was stored with sizes that no longer exist moves to the nearest (on a tie, the smaller).
  assert.equal(parseSize('115'), '125');
  assert.equal(parseSize('130'), '125');
  assert.equal(parseSize('175'), '150');
  assert.equal(parseSize('200'), '150');
});

const screenOf = (width: number, height: number, dpr = 1): ScreenInfo => ({ width, height, dpr });

test("autoSize: with Windows scaling applied (or without a screen) 100 %, without it by the screen's short side", () => {
  // Without scale (WSLg, or Windows at 100 %): the short side gives the size.
  assert.equal(autoSize(screenOf(3840, 2160)), '150', '4K monitor');
  assert.equal(autoSize(screenOf(2160, 3840)), '150', '4K portrait');
  assert.equal(autoSize(screenOf(5120, 2880)), '150', '5K');
  assert.equal(autoSize(screenOf(2560, 1440)), '125', 'QHD');
  assert.equal(autoSize(screenOf(3440, 1440)), '125', 'ultrawide QHD: wide, but not denser');
  assert.equal(autoSize(screenOf(2560, 1600)), '125');
  assert.equal(autoSize(screenOf(1920, 1080)), '100');
  assert.equal(autoSize(screenOf(1920, 1200)), '100');
  // The exact edges.
  assert.equal(autoSize(screenOf(4000, 2700)), '150');
  assert.equal(autoSize(screenOf(4000, 2699)), '150');
  assert.equal(autoSize(screenOf(4000, 2000)), '150');
  assert.equal(autoSize(screenOf(4000, 1999)), '125');
  assert.equal(autoSize(screenOf(4000, 1400)), '125');
  assert.equal(autoSize(screenOf(4000, 1399)), '100');
  assert.equal(autoSize(screenOf(3840, 2160, 1.05)), '150', 'a rounded scale still counts as "no scale"');
  // With Windows' scale already applied (native WebView2 at 175 %: 2194 x 1234 and 1.75), nothing to enlarge.
  assert.equal(autoSize(screenOf(2194, 1234, 1.75)), '100');
  assert.equal(autoSize(screenOf(3840, 2160, 1.1)), '100');
  assert.equal(autoSize(screenOf(3840, 2160, 2)), '100');
  // With no useful data, the default.
  for (const bad of [undefined, null, screenOf(NaN, 2160), screenOf(3840, 2160, NaN), screenOf(3840, 2160, 0), screenOf(0, 0)]) {
    assert.equal(autoSize(bad), '100', String(bad && JSON.stringify(bad)));
  }
});

test('resolveSize: "Automático" comes from the screen, a chosen size is that one, whatever the screen', () => {
  assert.equal(resolveSize('auto', screenOf(3840, 2160)), '150');
  assert.equal(resolveSize('auto', undefined), '100');
  for (const size of FIXED_SIZES) assert.equal(resolveSize(size, screenOf(3840, 2160)), size);
});

test('store: without a saved size "Automático", a saved one (or an old one) is respected on any screen', () => {
  const big = () => screenOf(3840, 2160);
  const fresh = fakeEnv();
  const prefs = createPrefs({ ...fresh.env, screen: big });
  assert.equal(prefs.get().size, 'auto');
  assert.equal(prefs.appliedSize(), '150');
  prefs.apply();
  assert.equal(fresh.root.font(), '21');
  assert.equal(fresh.storage.items.size, 0, 'reading saves nothing');
  for (const [stored, size, font] of [['100', '100', null], ['130', '125', '18'], ['200', '150', '21']] as const) {
    const { env, root } = fakeEnv({ 'nm.tamano': stored });
    const kept = createPrefs({ ...env, screen: big });
    kept.apply();
    assert.equal(kept.get().size, size, stored);
    assert.equal(kept.appliedSize(), size, stored);
    assert.equal(root.font(), font, stored);
  }
  // Choosing "Automático" after a fixed size follows the screen again.
  const { env, storage, root } = fakeEnv({ 'nm.tamano': '100' });
  const back = createPrefs({ ...env, screen: big });
  back.setSize('auto');
  assert.equal(storage.items.get('nm.tamano'), 'auto');
  assert.equal(root.font(), '21');
});

test('store: with "Automático", apply looks at the screen again (another monitor or resolution)', () => {
  let current = screenOf(3840, 2160);
  const { env, root } = fakeEnv();
  const prefs = createPrefs({ ...env, screen: () => current });
  prefs.apply();
  assert.equal(root.font(), '21');
  current = screenOf(1920, 1080);
  assert.equal(prefs.appliedSize(), '100');
  prefs.apply();
  assert.equal(root.font(), null);
});

test('applySize: sets --setting-font-size on the root and removes it for the default, without touching the theme', () => {
  const root = fakeRoot('dark', '18');
  applySize('150', root);
  assert.equal(root.font(), '21');
  applySize('125', root);
  assert.equal(root.font(), '18');
  applySize('100', root);
  assert.equal(root.font(), null);
  assert.equal(root.theme(), 'dark');
});

test('store: changing the size saves it, applies it to the document at once and notifies, odd values give the default', () => {
  const { env, storage, root } = fakeEnv({ 'nm.tema': 'claro' });
  const prefs = createPrefs(env);
  let calls = 0;
  prefs.subscribe(() => (calls += 1));
  prefs.setSize('125');
  assert.deepEqual(prefs.get(), { theme: 'claro', layout: 'tres', listWidth: 20.5, size: '125', locale: 'en', sound: 'on', badgeCount: 'on' });
  assert.equal(storage.items.get('nm.tamano'), '125');
  assert.equal(root.font(), '18');
  assert.equal(root.theme(), 'light', 'also leaves the theme set');
  assert.equal(calls, 1);
  prefs.setSize('125');
  assert.equal(calls, 1, 'the same size does not notify');
  prefs.setSize('130' as never);
  assert.equal(prefs.get().size, '125', 'an old size moves to the nearest one');
  prefs.setSize('999' as never);
  assert.equal(storage.items.get('nm.tamano'), 'auto');
  assert.equal(root.font(), null);
  assert.equal(calls, 2);
  // Next time what was stored is read, and `apply` (startup) sets it.
  prefs.setSize('150');
  const fresh = fakeRoot();
  createPrefs({ storage: () => storage, root: () => fresh }).apply();
  assert.equal(fresh.font(), '21');
});

test('effectiveLayout: three panels only if they fit (60 rem), two is always respected', () => {
  assert.equal(effectiveLayout('tres', 75), 'tres');
  assert.equal(effectiveLayout('tres', 60), 'tres', 'the minimum window (960 px) at 100 %');
  assert.equal(effectiveLayout('tres', 59.9), 'dos');
  assert.equal(effectiveLayout('tres', Infinity), 'tres');
  for (const rem of [10, 60, Infinity]) assert.equal(effectiveLayout('dos', rem), 'dos');
  // The root is 16 px x font / 14: at a 1200 px window only 100 % fits; 125 % (1200 / 20.6 = 58.3 rem) and 150 % do not.
  const at1200 = FIXED_SIZES.map((s) => effectiveLayout('tres', viewportRem(1200, ((sizeFontSize(s) ?? 14) * 16) / 14)));
  assert.deepEqual(at1200, ['tres', 'dos', 'dos']);
  // Full screen at 2K (2560 px), at 150 % they still fit.
  assert.equal(effectiveLayout('tres', viewportRem(2560, 24)), 'tres');
  // "Automático" on a 4K monitor (150 %, root of 24 x 16 / 14 px): full screen fits all three, and at
  // half screen (1920 px, 80 rem) too; in a 1200 px window, two.
  const autoRoot = ((sizeFontSize(autoSize(screenOf(3840, 2160))) ?? 14) * 16) / 14;
  assert.deepEqual([3840, 1920, 1200].map((px) => effectiveLayout('tres', viewportRem(px, autoRoot))), ['tres', 'tres', 'dos']);
});

test('sidebarRem: 15.5 rem, but never more than a third of the window', () => {
  assert.equal(sidebarRem(75), SIDEBAR_REM);
  assert.equal(sidebarRem(46.5), SIDEBAR_REM);
  assert.equal(sidebarRem(30), 10, 'the minimum window (960 px) at 200 %');
  assert.equal(sidebarRem(Infinity), SIDEBAR_REM);
});

test('minimum window (960 px) at any size: the sidebar leaves room for the list or the message', () => {
  for (const s of FIXED_SIZES) {
    const v = viewportRem(960, ((sizeFontSize(s) ?? 14) * 16) / 14);
    assert.ok(v - sidebarRem(v) >= LIST_WIDTH_MIN, `${s} %: ${v - sidebarRem(v)} rem`);
  }
  // At 200 % only one of the two fits (the list, or the message with "<- Bandeja"), even if three panels were chosen.
  assert.equal(effectiveLayout('tres', viewportRem(960, 32)), 'dos');
});

test('when there is room again, the three panels come back (window enlarged or size lowered)', () => {
  const at = (px: number, root: number) => effectiveLayout('tres', viewportRem(px, root));
  assert.deepEqual([at(1200, 24), at(1920, 24), at(1920, 32), at(1200, 16)], ['dos', 'tres', 'tres', 'tres']);
});

test('app.css: the sidebar measures what sidebarRem says', () => {
  const css = read('../src/styles/app.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = css.match(/\.nm-app \{[^}]*grid-template-columns: ([^;]+);/);
  assert.equal(rule?.[1], `min(${SIDEBAR_REM}rem, 33.333%) minmax(0, 1fr)`);
});

test('viewportRem: without useful data, infinite (nothing is forced)', () => {
  assert.equal(viewportRem(1200, 24), 50);
  for (const [w, px] of [[0, 16], [1200, 0], [1200, NaN], [NaN, 16], [-5, 16]]) {
    assert.equal(viewportRem(w, px), Infinity, `${w} / ${px}`);
  }
});

test('store: apply sets the saved theme on the document (startup), and does not fail without a document', () => {
  const { env, root } = fakeEnv({ 'nm.tema': 'oscuro' });
  createPrefs(env).apply();
  assert.equal(root.theme(), 'dark');
  const stale = fakeRoot('dark');
  createPrefs({ storage: () => fakeStorage({ 'nm.tema': 'sistema' }), root: () => stale }).apply();
  assert.equal(stale.theme(), null, '"sistema" removes any existing attribute');
  const fresh = fakeRoot();
  createPrefs({ storage: () => fakeStorage(), root: () => fresh }).apply();
  assert.equal(fresh.theme(), 'dark', 'nothing saved: dark, the default');
  assert.doesNotThrow(() => createPrefs({ storage: () => fakeStorage({ 'nm.tema': 'claro' }), root: () => undefined }).apply());
});

test('store: a value not in the list counts as the default, as when reading, and is never saved', () => {
  const { env, storage, root } = fakeEnv({ 'nm.tema': 'claro', 'nm.disposicion': 'dos' });
  const prefs = createPrefs(env);
  let calls = 0;
  prefs.subscribe(() => (calls += 1));
  // What would arrive with an `as Theme` from a control's `value`.
  prefs.setTheme('morado' as never);
  prefs.setLayout('"><img src=x>' as never);
  assert.deepEqual(prefs.get(), DEFAULT_PREFS);
  assert.deepEqual([...storage.items], [['nm.tema', 'oscuro'], ['nm.disposicion', 'tres']]);
  assert.equal(root.theme(), 'dark');
  assert.equal(calls, 2);
  // And if it was already at the default, there is nothing to change.
  prefs.setTheme(undefined as never);
  prefs.setLayout({} as never);
  assert.equal(calls, 2);
});

// --- Interface language: English by default, also for profiles that already had other
// preferences stored.

test('parseLocale: only "en" and "es" as is, anything else English', () => {
  for (const locale of LOCALES) assert.equal(parseLocale(locale), locale);
  for (const raw of [...STORED, undefined, 0, {}, ['es']]) {
    if (!LOCALES.includes(raw as never)) assert.equal(parseLocale(raw), 'en', `idioma ${String(raw)}`);
  }
});

test('applyLocale: sets lang on the root without touching the theme', () => {
  const root = fakeRoot('dark');
  applyLocale('es', root);
  assert.equal(root.lang(), 'es');
  applyLocale('en', root);
  assert.equal(root.lang(), 'en');
  assert.equal(root.theme(), 'dark');
});

test('store: without a saved language, English, even if there are other preferences (older profiles)', () => {
  const { env, root } = fakeEnv({ 'nm.tema': 'oscuro', 'nm.tamano': '130' });
  const prefs = createPrefs(env);
  assert.equal(prefs.get().locale, 'en');
  prefs.apply();
  assert.equal(root.lang(), 'en');
});

test('store: changing the language saves it, sets lang at once and notifies, odd values give English', () => {
  const { env, storage, root } = fakeEnv({ 'nm.tema': 'claro' });
  const prefs = createPrefs(env);
  let calls = 0;
  prefs.subscribe(() => (calls += 1));
  prefs.setLocale('es');
  assert.deepEqual(prefs.get(), { theme: 'claro', layout: 'tres', listWidth: 20.5, size: 'auto', locale: 'es', sound: 'on', badgeCount: 'on' });
  assert.equal(storage.items.get('nm.idioma'), 'es');
  assert.equal(root.lang(), 'es');
  assert.equal(root.theme(), 'light', 'also leaves the theme set');
  assert.equal(calls, 1);
  prefs.setLocale('es');
  assert.equal(calls, 1, 'the same language does not notify');
  prefs.setLocale('fr' as never);
  assert.equal(storage.items.get('nm.idioma'), 'en');
  assert.equal(root.lang(), 'en');
  assert.equal(calls, 2);
  // Next time what was stored is read, and `apply` (startup) sets it.
  prefs.setLocale('es');
  const fresh = fakeRoot();
  createPrefs({ storage: () => storage, root: () => fresh }).apply();
  assert.equal(fresh.lang(), 'es');
});

test('parseSound: "on" and "off" as is, anything else on (the sound is only turned off on purpose)', () => {
  assert.deepEqual([...SOUNDS], ['on', 'off']);
  assert.equal(parseSound('off'), 'off');
  for (const raw of [...STORED, 'on', 'OFF', 'false', undefined, 0, {}]) assert.equal(parseSound(raw), 'on', `sonido ${String(raw)}`);
});

test('store: the sound is on with nothing saved, and turning it off is saved, notifies and holds next time', () => {
  const { env, storage, root } = fakeEnv({ 'nm.tema': 'claro' });
  const prefs = createPrefs(env);
  assert.equal(prefs.get().sound, 'on');
  let calls = 0;
  prefs.subscribe(() => (calls += 1));
  prefs.setSound('off');
  assert.equal(prefs.get().sound, 'off');
  assert.equal(storage.items.get('nm.sonido'), 'off');
  assert.equal(storage.items.get('nm.tema'), 'claro');
  assert.equal(calls, 1);
  prefs.setSound('off');
  assert.equal(calls, 1, 'the same value does not notify');
  assert.equal(createPrefs({ storage: () => storage, root: () => root }).get().sound, 'off');
  prefs.setSound('raro' as never);
  assert.equal(storage.items.get('nm.sonido'), 'on');
});

test('parseBadgeCount: "on" and "off" as is, anything else on (the number is only hidden on purpose)', () => {
  assert.deepEqual([...BADGE_COUNTS], ['on', 'off']);
  assert.equal(parseBadgeCount('off'), 'off');
  for (const raw of [...STORED, 'on', 'OFF', 'false', undefined, 0, {}]) assert.equal(parseBadgeCount(raw), 'on', `insignia ${String(raw)}`);
});

test('store: the taskbar number is on with nothing saved, and turning it off is saved, notifies and holds next time', () => {
  const { env, storage, root } = fakeEnv({ 'nm.sonido': 'off' });
  const prefs = createPrefs(env);
  assert.equal(prefs.get().badgeCount, 'on');
  let calls = 0;
  prefs.subscribe(() => (calls += 1));
  prefs.setBadgeCount('off');
  assert.equal(prefs.get().badgeCount, 'off');
  assert.equal(storage.items.get('nm.insignia-numero'), 'off');
  assert.equal(storage.items.get('nm.sonido'), 'off', 'the other settings are not touched');
  assert.equal(calls, 1);
  prefs.setBadgeCount('off');
  assert.equal(calls, 1, 'the same value does not notify');
  assert.equal(createPrefs({ storage: () => storage, root: () => root }).get().badgeCount, 'off');
  prefs.setBadgeCount('raro' as never);
  assert.equal(storage.items.get('nm.insignia-numero'), 'on');
});

// --- The machine's theme (`matchMedia`): what `useEffectiveTheme` uses. It may be missing entirely or partly, and the first screen
// must not stay blank because of an ornament (the logo).

/** A stand-in `MediaQueryList`: it records who listens; `api` says which way of listening it has (or none). */
function fakeQuery(matches: boolean, api: 'moderna' | 'antigua' | 'ninguna' = 'moderna') {
  const heard = new Set<() => void>();
  const modern = {
    addEventListener: (type: string, listener: () => void) => void (type === 'change' && heard.add(listener)),
    removeEventListener: (type: string, listener: () => void) => void (type === 'change' && heard.delete(listener)),
  };
  // WebKit older than Safari 14: only `addListener` / `removeListener`.
  const old = { addListener: (listener: () => void) => void heard.add(listener), removeListener: (listener: () => void) => void heard.delete(listener) };
  return { heard, query: { matches, ...(api === 'moderna' ? modern : api === 'antigua' ? old : {}) } };
}

test('system theme: queries (prefers-color-scheme: dark) and reports the current value', () => {
  const asked: string[] = [];
  let dark = false;
  const system = createSystemTheme(() => ({ matchMedia: (query) => (asked.push(query), fakeQuery(dark).query) }));
  assert.equal(system.isDark(), false);
  dark = true;
  assert.equal(system.isDark(), true);
  assert.deepEqual(asked, ['(prefers-color-scheme: dark)', '(prefers-color-scheme: dark)']);
});

test('system theme: subscribes to changes and unsubscribes, with the modern or the old API', () => {
  for (const api of ['moderna', 'antigua'] as const) {
    const { heard, query } = fakeQuery(false, api);
    const system = createSystemTheme(() => ({ matchMedia: () => query }));
    const listener = () => {};
    const off = system.subscribe(listener);
    assert.deepEqual([...heard], [listener], `alta ${api}`);
    off();
    assert.equal(heard.size, 0, `baja ${api}`);
  }
});

test('system theme: without a window, without matchMedia or without a way to listen, light and without throwing', () => {
  const windows = [
    undefined,
    {},
    { matchMedia: undefined },
    { matchMedia: 'no es una función' as never },
    { matchMedia: () => null },
    { matchMedia: () => fakeQuery(false, 'ninguna').query },
  ];
  for (const win of windows) {
    const system = createSystemTheme(() => win);
    assert.equal(system.isDark(), false);
    const off = system.subscribe(() => {});
    assert.doesNotThrow(off);
  }
  // With no way to listen the current theme is still known; only the live change is lost.
  assert.equal(createSystemTheme(() => ({ matchMedia: () => fakeQuery(true, 'ninguna').query })).isDark(), true);
});

// --- public/tema.js: the script that sets the theme before painting. It repeats `prefs.ts`'s rule by hand (it cannot
// import anything), so it is really run here and compared with it.

const TEMA_JS = read('../public/tema.js');

/** Runs `public/tema.js` with a stand-in `document` and `localStorage`; returns the `data-theme` it leaves. */
function runTemaJs(globals: object, initial?: string): string | null {
  const root = fakeRoot(initial);
  const sandbox = Object.defineProperties({ document: { documentElement: root } }, Object.getOwnPropertyDescriptors(globals));
  runInNewContext(TEMA_JS, sandbox, { filename: 'tema.js' });
  return root.theme();
}

/** What `prefs.ts` does with the same storage. */
function viaPrefs(storage: PrefsEnv['storage'], initial?: string): string | null {
  const root = fakeRoot(initial);
  createPrefs({ storage, root: () => root }).apply();
  return root.theme();
}

test('tema.js does the same as prefs.ts with any saved value', () => {
  for (const raw of STORED) {
    const stored: Record<string, string> = raw === null ? {} : { 'nm.tema': raw };
    // With a prior attribute and without: "sistema" (or something odd) must leave it without an attribute.
    for (const initial of [undefined, 'dark']) {
      const expected = themeAttr(parseTheme(raw));
      assert.equal(runTemaJs({ localStorage: fakeStorage(stored) }, initial), expected, `tema.js with ${String(raw)}`);
      assert.equal(viaPrefs(() => fakeStorage(stored), initial), expected, `prefs.ts with ${String(raw)}`);
    }
  }
});

/** Like `runTemaJs`, but returns the `--setting-font-size` it leaves. */
function fontViaTemaJs(stored: Record<string, string>, initialFont?: string, screen?: ScreenInfo): string | null {
  const root = fakeRoot(undefined, initialFont);
  // In the browser, `screen` and `devicePixelRatio` are window globals.
  const display = screen === undefined ? {} : { screen: { width: screen.width, height: screen.height }, devicePixelRatio: screen.dpr };
  runInNewContext(TEMA_JS, { document: { documentElement: root }, localStorage: fakeStorage(stored), ...display });
  return root.font();
}

// Screens to compare tema.js with prefs.ts: each `autoSize` step, its edges, Windows' applied scale
// and broken data.
const SCREENS: (ScreenInfo | undefined)[] = [
  undefined,
  screenOf(1920, 1080),
  screenOf(2560, 1440),
  screenOf(4000, 1399),
  screenOf(4000, 1400),
  screenOf(4000, 2000),
  screenOf(4000, 2700),
  screenOf(3840, 2160),
  screenOf(2160, 3840),
  screenOf(4000, 1999),
  screenOf(5120, 2880),
  screenOf(4000, 2699),
  screenOf(3840, 2160, 1.05),
  screenOf(3840, 2160, 1.06),
  screenOf(2194, 1234, 1.75),
  screenOf(NaN, 2160),
  screenOf(3840, 2160, 0),
];

test('tema.js sets the same size as prefs.ts with any saved value and any screen (and the same size list)', () => {
  for (const raw of STORED) {
    const stored: Record<string, string> = raw === null ? {} : { 'nm.tamano': raw };
    for (const screen of SCREENS) {
      for (const initialFont of [undefined, '18']) {
        const fromPrefs = fakeRoot(undefined, initialFont);
        createPrefs({ storage: () => fakeStorage(stored), root: () => fromPrefs, screen: () => screen }).apply();
        const px = sizeFontSize(resolveSize(parseSize(raw), screen));
        const what = `${String(raw)} en ${JSON.stringify(screen)}`;
        assert.equal(fromPrefs.font(), px === null ? null : String(px), `prefs.ts with ${what}`);
        assert.equal(fontViaTemaJs(stored, initialFont, screen), fromPrefs.font(), `tema.js with ${what}`);
      }
    }
  }
  // With nothing stored, on a 4K monitor with no scale: 150 %.
  assert.equal(fontViaTemaJs({}, undefined, screenOf(3840, 2160)), '21');
  for (const size of FIXED_SIZES) {
    const px = sizeFontSize(size);
    assert.equal(fontViaTemaJs({ 'nm.tamano': size }), px === null ? null : String(px), `${size} missing in tema.js`);
  }
  // Size does not look at the theme, nor the theme at the size.
  assert.equal(fontViaTemaJs({ 'nm.tema': '150' }), null);
  assert.equal(runTemaJs({ localStorage: fakeStorage({ 'nm.tamano': 'oscuro' }) }), 'dark');
});

/** Like `runTemaJs`, but returns the `lang` it leaves. */
function langViaTemaJs(globals: object, initial?: string): string | null {
  const root = fakeRoot();
  if (initial !== undefined) root.setAttribute('lang', initial);
  const sandbox = Object.defineProperties({ document: { documentElement: root } }, Object.getOwnPropertyDescriptors(globals));
  runInNewContext(TEMA_JS, sandbox);
  return root.lang();
}

test('tema.js sets the same lang as prefs.ts with any saved value', () => {
  for (const raw of STORED) {
    const stored: Record<string, string> = raw === null ? {} : { 'nm.idioma': raw };
    for (const initial of [undefined, 'es']) {
      const fromPrefs = fakeRoot();
      if (initial !== undefined) fromPrefs.setAttribute('lang', initial);
      createPrefs({ storage: () => fakeStorage(stored), root: () => fromPrefs }).apply();
      assert.equal(fromPrefs.lang(), parseLocale(raw), `prefs.ts with ${String(raw)}`);
      assert.equal(langViaTemaJs({ localStorage: fakeStorage(stored) }, initial), fromPrefs.lang(), `tema.js with ${String(raw)}`);
    }
  }
  for (const locale of LOCALES) assert.equal(langViaTemaJs({ localStorage: fakeStorage({ 'nm.idioma': locale }) }), locale, `${locale} missing in tema.js`);
  // Without storage, or if it throws, English, like prefs.ts.
  const denied = {
    get localStorage(): never {
      throw new Error('SecurityError');
    },
  };
  assert.equal(langViaTemaJs(denied, 'es'), 'en');
  assert.equal(langViaTemaJs({}, 'es'), 'en');
  assert.equal(langViaTemaJs({ localStorage: fakeStorage({ 'nm.idioma': 'es' }, true) }, 'es'), 'en');
});

test('tema.js: the three themes give exactly sistema → no attribute, claro → light, oscuro → dark', () => {
  assert.equal(runTemaJs({ localStorage: fakeStorage({ 'nm.tema': 'sistema' }) }), null);
  assert.equal(runTemaJs({ localStorage: fakeStorage({ 'nm.tema': 'claro' }) }), 'light');
  assert.equal(runTemaJs({ localStorage: fakeStorage({ 'nm.tema': 'oscuro' }) }), 'dark');
  // It does not look at the other preference.
  assert.equal(runTemaJs({ localStorage: fakeStorage({ 'nm.disposicion': 'claro' }) }), 'dark', 'the default theme: dark');
});

test('tema.js: if storage throws or does not exist, the default theme (dark), like prefs.ts', () => {
  const broken = fakeStorage({ 'nm.tema': 'oscuro' }, true);
  assert.equal(runTemaJs({ localStorage: broken }, 'light'), 'dark');
  assert.equal(viaPrefs(() => broken, 'light'), 'dark');

  // In some browsers what throws is the access to `localStorage` itself.
  const denied = {
    get localStorage(): never {
      throw new Error('SecurityError');
    },
  };
  assert.equal(runTemaJs(denied, 'light'), 'dark');
  assert.equal(viaPrefs(() => denied.localStorage, 'light'), 'dark');

  assert.equal(runTemaJs({}, 'light'), 'dark', 'without `localStorage` (ReferenceError)');
  assert.equal(runTemaJs({ localStorage: null }, 'light'), 'dark');
  assert.equal(viaPrefs(() => null, 'light'), 'dark');
});

test('tema.js is a standalone classic script: no modules, no dependencies and leaving nothing global', () => {
  assert.doesNotMatch(TEMA_JS, /\b(import|export|require)\b/);
  const sandbox: Record<string, unknown> = { document: { documentElement: fakeRoot() }, localStorage: fakeStorage() };
  runInNewContext(TEMA_JS, sandbox);
  assert.deepEqual(Object.keys(sandbox).sort(), ['document', 'localStorage']);
});

// --- index.html: the script is linked before any sheet or module, and nothing is inline (the app's CSP is
// `script-src 'self'`, and an inline `<style>` would force keeping `'unsafe-inline'`).

test('index.html links tema.js in the <head>, before styles and modules, and has nothing inline', () => {
  const html = read('../index.html');
  // The default language is English: the same one tema.js leaves with nothing stored.
  assert.match(html, /<html lang="en">/);
  // All the positions are over the same text, the whole file.
  const at = html.indexOf('<script src="/tema.js"></script>');
  assert.ok(at > html.indexOf('<head>') && at < html.indexOf('</head>'), 'tema.js is not linked in the <head> as a classic script');
  // Today the source file carries no sheets (Vite adds them on build, at the end of the <head>); if someone links one
  // by hand, or a module, it must come after.
  for (const later of ['rel="stylesheet"', 'type="module"']) {
    const other = html.indexOf(later);
    assert.ok(other === -1 || other > at, `${later} comes before tema.js`);
  }
  assert.doesNotMatch(html, /<style[\s>]/i);
  assert.doesNotMatch(html, /\sstyle=/i);
  assert.doesNotMatch(html, /\son[a-z]+=/i);
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length >= 2, 'tema.js or the app module is missing');
  for (const [, attrs, body] of scripts) {
    assert.match(attrs, /\ssrc="\/[^"]+"/);
    assert.equal(body.trim(), '', 'script with inline content');
  }
});

test('refreshSize: with "Automático" it recalculates, only notifies if the size changed and touches nothing else', () => {
  let screen = screenOf(3840, 2160);
  const root = fakeRoot();
  const prefs = createPrefs({ storage: () => fakeStorage(), root: () => root, screen: () => screen });
  prefs.apply();
  const before = root.font();
  let notified = 0;
  prefs.subscribe(() => notified++);
  prefs.refreshSize();
  assert.equal(notified, 0, 'no change, no notification');
  screen = screenOf(1920, 1080);
  prefs.refreshSize();
  assert.equal(notified, 1);
  assert.equal(prefs.appliedSize(), '100');
  assert.notEqual(root.font(), before);
  prefs.refreshSize();
  assert.equal(notified, 1, 'same again: nothing');
});

test('refreshSize: with a fixed size it does nothing', () => {
  let screen = screenOf(3840, 2160);
  const root = fakeRoot();
  const prefs = createPrefs({ storage: () => fakeStorage({ 'nm.tamano': '125' }), root: () => root, screen: () => screen });
  prefs.apply();
  let notified = 0;
  prefs.subscribe(() => notified++);
  screen = screenOf(1920, 1080);
  prefs.refreshSize();
  assert.equal(notified, 0);
});

test('watchScreen: resize, focus and resolution change recalculate, it returns the move notifier', () => {
  const handlers: Record<string, () => void> = {};
  const queries: string[] = [];
  const mq = { matches: false, addEventListener: (_: 'change', l: () => void) => void (handlers.dpr = l) };
  const win = {
    devicePixelRatio: 1,
    addEventListener: (type: 'resize' | 'focus', l: () => void) => void (handlers[type] = l),
    matchMedia: (q: string) => (queries.push(q), mq),
  };
  let calls = 0;
  const onMoved = watchScreen(win, () => calls++);
  handlers.resize();
  handlers.focus();
  handlers.dpr();
  onMoved();
  assert.equal(calls, 4);
  assert.equal(queries.length, 2, 'after a resolution change the new one is watched again');
  assert.doesNotThrow(() => watchScreen(undefined, () => {}));
});
