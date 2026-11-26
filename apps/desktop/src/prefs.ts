// Interface preferences: theme, layout, list width, interface size, language, sound on new mail and the unread count
// on the taskbar badge.
// They are stored in `localStorage` on this device; they do not go through the core nor touch the mail. The pure
// rules come first; then the store (with storage and document injected, so it can be tested with `node --test`)
// and, at the end, the only part that depends on React.
//
// `public/tema.js` repeats the theme, size and language rules by hand to apply them before painting. If you change
// a key here, the values or what is set on `<html>`, change it there too: `test/prefs.test.ts` runs it and compares.
import { useSyncExternalStore } from 'react';
import { clampListWidth, LIST_WIDTH_DEFAULT, LIST_WIDTH_MIN, parseListWidth, READER_MIN_REM } from './resize.ts';

/** Themes that can be chosen in Settings. */
export const THEMES = ['sistema', 'claro', 'oscuro'] as const;
export type Theme = (typeof THEMES)[number];

/** Layouts: three panels (list and message together) or two (the message takes the list's place). */
export const LAYOUTS = ['tres', 'dos'] as const;
export type Layout = (typeof LAYOUTS)[number];

/** Fixed interface sizes, as a % of normal (the first one, not enlarged). To change the list it is enough to
 *  touch this line and the one in `public/tema.js` (a test checks they match); Settings takes its options from here. */
export const FIXED_SIZES = ['100', '125', '150', '175', '200'] as const;
export type FixedSize = (typeof FIXED_SIZES)[number];

/** What is chosen in Settings: "Automático" (the default, see `autoSize`) or a fixed one. */
export const SIZES = ['auto', ...FIXED_SIZES] as const;
export type Size = (typeof SIZES)[number];

/** Interface languages. The default is English, also with nothing stored. */
export const LOCALES = ['en', 'es'] as const;
export type Locale = (typeof LOCALES)[number];

/** Sound on new mail (outside the inbox): on by default. */
export const SOUNDS = ['on', 'off'] as const;
export type Sound = (typeof SOUNDS)[number];

/** The unread count on the taskbar badge (Windows, `badge.ts`): on by default. Off, there is no number (the padlock
 *  while locked stays). */
export const BADGE_COUNTS = ['on', 'off'] as const;
export type BadgeCount = (typeof BADGE_COUNTS)[number];

export interface Prefs {
  theme: Theme;
  layout: Layout;
  /** List width with three panels, in `rem` (17 to 40; see `resize.ts`). One value for Inbox and Archive. */
  listWidth: number;
  size: Size;
  locale: Locale;
  sound: Sound;
  badgeCount: BadgeCount;
}

export const DEFAULT_PREFS: Prefs = {
  theme: 'sistema',
  layout: 'tres',
  listWidth: LIST_WIDTH_DEFAULT,
  size: 'auto',
  locale: 'en',
  sound: 'on',
  badgeCount: 'on',
};

/** `localStorage` key of each preference. */
export const STORAGE_KEYS = {
  theme: 'nm.tema',
  layout: 'nm.disposicion',
  listWidth: 'nm.ancho-lista',
  size: 'nm.tamano',
  locale: 'nm.idioma',
  sound: 'nm.sonido',
  badgeCount: 'nm.insignia-numero',
} as const;

/** `data-theme` values understood by `design/brand/tokens.css`; also the theme that ends up shown. */
export type ThemeAttr = 'light' | 'dark';

function oneOf<T extends string>(values: readonly T[], raw: unknown, fallback: T): T {
  return (values as readonly unknown[]).includes(raw) ? (raw as T) : fallback;
}

/** What is stored can be anything (or nothing): whatever is not a theme means "follow the system". */
export function parseTheme(raw: unknown): Theme {
  return oneOf(THEMES, raw, DEFAULT_PREFS.theme);
}

export function parseLayout(raw: unknown): Layout {
  return oneOf(LAYOUTS, raw, DEFAULT_PREFS.layout);
}

/** Sizes that no longer exist and which one they map to (the nearest; on a tie, the smaller): stored values are not left without meaning. */
export const LEGACY_SIZES: Readonly<Record<string, Size>> = { '115': '125', '130': '125' };

export function parseSize(raw: unknown): Size {
  const migrated = typeof raw === 'string' && Object.hasOwn(LEGACY_SIZES, raw) ? LEGACY_SIZES[raw] : raw;
  return oneOf(SIZES, migrated, DEFAULT_PREFS.size);
}

/** Anything not in the language list is English. `lang` on `<html>` carries the same value. */
export function parseLocale(raw: unknown): Locale {
  return oneOf(LOCALES, raw, DEFAULT_PREFS.locale);
}

/** Anything other than "off" is "on": sound is only turned off on purpose. */
export function parseSound(raw: unknown): Sound {
  return oneOf(SOUNDS, raw, DEFAULT_PREFS.sound);
}

/** Anything other than "off" is "on": the number is only hidden on purpose. */
export function parseBadgeCount(raw: unknown): BadgeCount {
  return oneOf(BADGE_COUNTS, raw, DEFAULT_PREFS.badgeCount);
}

/** Default `--setting-font-size`: the base stylesheet sets `html { font-size: calc(var(--setting-font-size) * 16 / 14 %) }` and
 *  the whole interface is in `rem`. Without the property the root stays at 16 px, the same as with 14. */
export const BASE_FONT_SIZE = 14;

/** What goes in `--setting-font-size` for each size (14 px times the %, rounded: 18, 21, 25, 28); `null` means "no
 *  property", the normal size. */
export function sizeFontSize(size: FixedSize): number | null {
  const px = Math.round((BASE_FONT_SIZE * Number(size)) / 100);
  return px === BASE_FONT_SIZE ? null : px;
}

/** What is used from the screen: its size in CSS px and `devicePixelRatio`. */
export interface ScreenInfo {
  width: number;
  height: number;
  dpr: number;
}

/** Up to this value, `devicePixelRatio` counts as 1 (system rounding). */
const UNSCALED_DPR = 1.05;

/** Steps of "Automático": the screen's short side in px (largest first) and the size it gets. The short side rather
 *  than the width, so a 3440 x 1440 ultrawide (as dense as a 2560 x 1440) does not come out huge. They are the heights of
 *  5K (2880), 4K (2160) and QHD (1440), with margin: 200 % as macOS does on 5K, 175 % on a 28" 4K and 125 % on QHD
 *  (at 150 % it would fit the same as on a 1707 x 960 screen). */
const AUTO_STEPS: readonly (readonly [number, FixedSize])[] = [
  [2700, '200'],
  [2000, '175'],
  [1400, '125'],
];

/** The size for "Automático". If the system already scales the window (`devicePixelRatio` above 1: native Windows at
 *  175 % gives 1.75 and a 2194 px screen), the interface already looks the right size: 100 %. Without scaling (WSLg does
 *  not pass Windows' one, or Windows at 100 %) and on dense screens, it grows by the short side. With no useful data, 100 %. */
export function autoSize(screen: ScreenInfo | null | undefined): FixedSize {
  if (!screen || !(screen.dpr > 0 && screen.dpr <= UNSCALED_DPR)) return '100';
  const short = Math.min(screen.width, screen.height);
  return AUTO_STEPS.find(([min]) => short >= min)?.[1] ?? '100';
}

/** The size actually applied: the chosen one or, with "Automático", the one the screen gives. */
export function resolveSize(size: Size, screen: ScreenInfo | null | undefined): FixedSize {
  return size === 'auto' ? autoSize(screen) : size;
}

/** Sidebar width, in `rem`, when it fits. `styles/app.css` (`.nm-app`) repeats it with the cap of a third of the
 *  window (`test/prefs.test.ts` checks they match). */
export const SIDEBAR_REM = 15.5;

/** The real sidebar: 15.5 rem, but never more than a third of the window (at 200 %, in 960 px, 10 rem). */
export function sidebarRem(viewportRem: number): number {
  return Math.min(SIDEBAR_REM, viewportRem / 3);
}

/** What the list and reader ask for together: their minimums plus some air. */
const LIST_AND_READER_REM = LIST_WIDTH_MIN + READER_MIN_REM + 3.5;

/** The layout actually used: the chosen one, except three panels in a window where, without the sidebar, the list and
 *  the reader do not fit (at 150 %, a 1200 px window is 50 rem); then two, and the three return as soon as there is
 *  room. At 100 % it never happens: the window does not go below 960 px = 60 rem. */
export function effectiveLayout(layout: Layout, viewportRem: number): Layout {
  return layout === 'tres' && viewportRem - sidebarRem(viewportRem) < LIST_AND_READER_REM ? 'dos' : layout;
}

/** Window width in `rem`. With no useful data (no window, root at 0), infinite: nothing is forced. */
export function viewportRem(widthPx: number, rootFontPx: number): number {
  return widthPx > 0 && rootFontPx > 0 ? widthPx / rootFontPx : Infinity;
}

/** The `data-theme` of `<html>` for each theme; `null` means "no attribute": then `tokens.css` follows the system. */
export function themeAttr(theme: Theme): ThemeAttr | null {
  if (theme === 'claro') return 'light';
  return theme === 'oscuro' ? 'dark' : null;
}

/** The theme actually shown: the chosen one or, with "system", the machine's. */
export function effectiveTheme(theme: Theme, systemDark: boolean): ThemeAttr {
  return themeAttr(theme) ?? (systemDark ? 'dark' : 'light');
}

/** What is used from `<html>`. */
export interface ThemeRoot {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/** Sets the theme on the document: `data-theme` on the root, or removes it for "system". */
export function applyTheme(theme: Theme, root: ThemeRoot): void {
  const attr = themeAttr(theme);
  if (attr) root.setAttribute('data-theme', attr);
  else root.removeAttribute('data-theme');
}

/** What is used from the `style` of `<html>` (CSSOM: the CSP allows it, since it forbids `style=` in the HTML). */
export interface SizeRoot {
  style: {
    setProperty(name: string, value: string): void;
    removeProperty(name: string): unknown;
  };
}

/** Sets the size on the document: `--setting-font-size` on the root, or removes it for the normal one. */
export function applySize(size: FixedSize, root: SizeRoot): void {
  const px = sizeFontSize(size);
  if (px === null) root.style.removeProperty('--setting-font-size');
  else root.style.setProperty('--setting-font-size', String(px));
}

/** Sets the language on the document: `lang` on the root (screen readers, hyphenation and spell checker). */
export function applyLocale(locale: Locale, root: Pick<ThemeRoot, 'setAttribute'>): void {
  root.setAttribute('lang', locale);
}

/** `<html>`: what the theme, size and language touch. */
export type PrefsRoot = ThemeRoot & SizeRoot;

/** What is used from `localStorage`. */
export interface PrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Where storage and the document root come from. They are requested each time. Requesting storage can throw
 *  (blocked) or return nothing, and that is tolerated; the root may not exist (in tests), but requesting it does not throw. */
export interface PrefsEnv {
  storage(): PrefsStorage | null | undefined;
  root(): PrefsRoot | null | undefined;
  /** The screen, for "Automático". Without it (in tests), 100 %. */
  screen?(): ScreenInfo | null | undefined;
}

export interface PrefsStore {
  /** The current preferences. The same object as long as they do not change (it works as a snapshot). */
  get(): Prefs;
  /** As when reading, anything not in the list counts as the default: an odd value is neither stored nor distributed. */
  setTheme(theme: Theme): void;
  setLayout(layout: Layout): void;
  /** Clamped to [17, 40]; anything that is not a number becomes the default. */
  setListWidth(rem: number): void;
  setSize(size: Size): void;
  setLocale(locale: Locale): void;
  setSound(sound: Sound): void;
  setBadgeCount(badgeCount: BadgeCount): void;
  /** Notifies every change; returns how to unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** The size applied now (`resolveSize` with the screen at this moment). */
  appliedSize(): FixedSize;
  /** Sets the stored theme, size and language on the document (startup). With "Automático" it looks at the screen
   *  again, so it also works when that changes. */
  apply(): void;
  /** With "Automático", looks at the screen again: only if the resulting size differs from the last applied does it put
   *  it on the document and notify subscribers. Without "Automático" or without a change, it does nothing. */
  refreshSize(): void;
}

function readItem(env: PrefsEnv, key: string): string | null {
  try {
    return env.storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeItem(env: PrefsEnv, key: string, value: string): void {
  try {
    env.storage()?.setItem(key, value);
  } catch {
    // Without storage, the change lasts until the app closes.
  }
}

function readPrefs(env: PrefsEnv): Prefs {
  return {
    theme: parseTheme(readItem(env, STORAGE_KEYS.theme)),
    layout: parseLayout(readItem(env, STORAGE_KEYS.layout)),
    listWidth: parseListWidth(readItem(env, STORAGE_KEYS.listWidth)),
    size: parseSize(readItem(env, STORAGE_KEYS.size)),
    locale: parseLocale(readItem(env, STORAGE_KEYS.locale)),
    sound: parseSound(readItem(env, STORAGE_KEYS.sound)),
    badgeCount: parseBadgeCount(readItem(env, STORAGE_KEYS.badgeCount)),
  };
}

/** The preferences store: reads what is stored the first time it is asked and, on each change, stores, applies the
 *  theme, size and language to the document and notifies subscribers. */
export function createPrefs(env: PrefsEnv): PrefsStore {
  let current: Prefs | undefined;
  const listeners = new Set<() => void>();
  const get = () => (current ??= readPrefs(env));
  const appliedSize = () => resolveSize(get().size, env.screen?.());
  let lastSize: FixedSize | undefined;
  const apply = () => {
    const root = env.root();
    if (!root) return;
    applyTheme(get().theme, root);
    lastSize = appliedSize();
    applySize(lastSize, root);
    applyLocale(get().locale, root);
  };
  const set = <K extends keyof Prefs>(key: K, value: Prefs[K]) => {
    if (get()[key] === value) return;
    current = { ...get(), [key]: value };
    writeItem(env, STORAGE_KEYS[key], String(value));
    apply();
    listeners.forEach((listener) => listener());
  };
  return {
    get,
    appliedSize,
    apply,
    refreshSize() {
      const root = env.root();
      if (!root || get().size !== 'auto') return;
      const size = appliedSize();
      if (size === lastSize) return;
      lastSize = size;
      applySize(size, root);
      listeners.forEach((listener) => listener());
    },
    setTheme: (theme) => set('theme', parseTheme(theme)),
    setLayout: (layout) => set('layout', parseLayout(layout)),
    setListWidth: (rem) => set('listWidth', clampListWidth(rem)),
    setSize: (size) => set('size', parseSize(size)),
    setLocale: (locale) => set('locale', parseLocale(locale)),
    setSound: (sound) => set('sound', parseSound(sound)),
    setBadgeCount: (badgeCount) => set('badgeCount', parseBadgeCount(badgeCount)),
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** The app's preferences, over the window's `localStorage` and `<html>`. */
export const prefs = createPrefs({
  storage: () => globalThis.localStorage,
  root: () => globalThis.document?.documentElement,
  screen: () => {
    const w = globalThis.window;
    return w?.screen ? { width: w.screen.width, height: w.screen.height, dpr: w.devicePixelRatio } : undefined;
  },
});

/** What is used from `window` to learn that the screen may have changed. */
export interface ScreenWatchWindow {
  addEventListener(type: 'resize' | 'focus', listener: () => void): void;
  matchMedia?(query: string): SystemQuery | null | undefined;
  devicePixelRatio?: number;
}

/** With "Automático" the screen can change without the window changing size (dragged to another monitor, or on
 *  Wayland the monitor is not known until it is shown): it is looked at again on resize, on regaining focus and when
 *  the resolution changes (`matchMedia`). Returns `onMoved`, to notify when the window moves. */
export function watchScreen(win: ScreenWatchWindow | undefined, refresh: () => void): () => void {
  if (!win) return refresh;
  win.addEventListener('resize', refresh);
  win.addEventListener('focus', refresh);
  const watchDpr = () => {
    const q = typeof win.matchMedia === 'function' ? win.matchMedia(`(resolution: ${win.devicePixelRatio ?? 1}dppx)`) : null;
    q?.addEventListener?.('change', () => {
      refresh();
      watchDpr();
    });
  };
  watchDpr();
  return refresh;
}

// Placed before React's listeners (`subscribeViewport`), which then already read the new root.
const onMoved = watchScreen(globalThis.window, () => prefs.refreshSize());
// The Tauri window's move event (covered by the listen-to-events permission already granted).
if (globalThis.window && '__TAURI_INTERNALS__' in globalThis.window) {
  void import('@tauri-apps/api/event').then(({ listen }) => listen('tauri://move', onMoved)).catch(() => {});
}

// --- The system theme

const SYSTEM_DARK = '(prefers-color-scheme: dark)';

/** What is used from `MediaQueryList`. In WebKit older than Safari 14 only `addListener` / `removeListener` exist. */
export interface SystemQuery {
  matches: boolean;
  addEventListener?(type: 'change', listener: () => void): void;
  removeEventListener?(type: 'change', listener: () => void): void;
  addListener?(listener: () => void): void;
  removeListener?(listener: () => void): void;
}

/** What is used from `window`. There may be no window, or it may lack `matchMedia`. */
export interface SystemWindow {
  matchMedia?(query: string): SystemQuery | null | undefined;
}

export interface SystemTheme {
  /** Is the machine in dark mode right now? */
  isDark(): boolean;
  /** Notifies when the machine changes theme; returns how to unsubscribe. */
  subscribe(listener: () => void): () => void;
}

/** The machine's theme, via `matchMedia`. None of this throws: if `matchMedia` is missing, the machine counts as light
 *  (the same as `tokens.css` does without the `prefers-color-scheme` rule), and if there is no way to listen, only
 *  the change while the app is open is lost. */
export function createSystemTheme(win: () => SystemWindow | undefined): SystemTheme {
  const query = () => {
    const w = win();
    return typeof w?.matchMedia === 'function' ? w.matchMedia(SYSTEM_DARK) : null;
  };
  return {
    isDark: () => query()?.matches ?? false,
    subscribe(listener) {
      const q = query();
      if (typeof q?.addEventListener === 'function') {
        q.addEventListener('change', listener);
        return () => q.removeEventListener?.('change', listener);
      }
      if (typeof q?.addListener === 'function') {
        q.addListener(listener);
        return () => q.removeListener?.(listener);
      }
      return () => {};
    },
  };
}

const system = createSystemTheme(() => globalThis.window);

// --- React

/** The preferences, up to date: whoever uses it repaints when they change. */
export function usePrefs(): Prefs {
  return useSyncExternalStore(prefs.subscribe, prefs.get);
}

/** The window width changes on resize and, in `rem`, also when the size changes (which is applied to the root
 *  before notifying, so the new one is already read here). */
function subscribeViewport(listener: () => void): () => void {
  const off = prefs.subscribe(listener);
  globalThis.window?.addEventListener('resize', listener);
  return () => {
    off();
    globalThis.window?.removeEventListener('resize', listener);
  };
}

function layoutNow(): Layout {
  const root = globalThis.document?.documentElement;
  const rootPx = root ? Number.parseFloat(getComputedStyle(root).fontSize) : 0;
  return effectiveLayout(prefs.get().layout, viewportRem(globalThis.window?.innerWidth ?? 0, rootPx));
}

/** The layout actually used (`effectiveLayout`), up to date with the preference, the size and the window. */
export function useEffectiveLayout(): Layout {
  return useSyncExternalStore(subscribeViewport, layoutNow);
}

/** The size actually applied (`prefs.appliedSize`), up to date: to say in Settings how much "Automático" is. */
export function useAppliedSize(): FixedSize {
  return useSyncExternalStore(subscribeViewport, prefs.appliedSize);
}

/** The theme actually shown (`light` or `dark`), up to date: it changes with the preference and, if it is "system",
 *  with the machine. For what cannot follow the theme through CSS alone, such as picking the logo version. */
export function useEffectiveTheme(): ThemeAttr {
  const { theme } = usePrefs();
  const dark = useSyncExternalStore(system.subscribe, system.isDark);
  return effectiveTheme(theme, dark);
}
