// Language base: dictionaries with the same shape, t() following the preference, and plural().
// This file does NOT pin Spanish (it does not import `./idioma-es.ts`): it tests both languages.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DICTIONARIES, t } from '../src/i18n/index.ts';
import { currentLocale, LOCALE_TAGS, localeTag, plural } from '../src/i18n/locale.ts';
import { LOCALES, prefs } from '../src/prefs.ts';

/** The namespaces. Frozen: the `index.ts` files of `es/` and `en/` are not touched afterwards, so work on
 *  different namespaces can proceed in parallel without clashing. */
const NAMESPACES = ['errors', 'format', 'status', 'mail', 'screensMail', 'screensPlan', 'onboarding', 'settings', 'slogans'];

/** Sample arguments to call the dictionary functions (plurals and figures). */
const SAMPLES = [0, 1, 2, 5, 1000];

/** Shape differences between two dictionaries: keys, type of each value, list length, function arity,
 *  empty texts and functions that give no text with the sample arguments. Empty if they are equal. */
function differences(a: unknown, b: unknown, path = ''): string[] {
  const here = path || '(root)';
  const kind = (v: unknown) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
  if (kind(a) !== kind(b)) return [`${here}: ${kind(a)} vs ${kind(b)}`];
  if (typeof a === 'string') return a.trim() && (b as string).trim() ? [] : [`${here}: empty text`];
  if (typeof a === 'function') return functionDifferences(a, b as (...args: unknown[]) => unknown, here);
  if (Array.isArray(a)) {
    const other = b as unknown[];
    if (a.length !== other.length) return [`${here}: ${a.length} elements vs ${other.length}`];
    return a.flatMap((v, i) => differences(v, other[i], `${path}[${i}]`));
  }
  if (kind(a) !== 'object') return [`${here}: type not allowed ${kind(a)}`];
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys.flatMap((k) => {
    const sub = path ? `${path}.${k}` : k;
    if (!(k in left)) return [`${sub}: extra`];
    if (!(k in right)) return [`${sub}: missing`];
    return differences(left[k], right[k], sub);
  });
}

function functionDifferences(a: (...args: unknown[]) => unknown, b: (...args: unknown[]) => unknown, here: string): string[] {
  if (a.length !== b.length) return [`${here}: ${a.length} parameters vs ${b.length}`];
  // It can only be called with numbers: if the first gives no text with them (it asks for something else), nothing more is checked.
  for (const n of SAMPLES) {
    const args = Array.from({ length: a.length }, () => n);
    let first: unknown;
    try {
      first = a(...args);
    } catch {
      return [];
    }
    if (typeof first !== 'string' || !first.trim()) return [];
    let second: unknown;
    try {
      second = b(...args);
    } catch (e) {
      return [`${here}(${n}): throws ${String(e)}`];
    }
    if (typeof second !== 'string' || !second.trim()) return [`${here}(${n}): gives no text`];
  }
  return [];
}

test('differences catches what it should and lets two equal shapes pass', () => {
  const es = { a: 'Hola', b: { c: 'x', d: (n: number) => `${n} cosas` }, e: ['uno', 'dos'] };
  const en = { a: 'Hello', b: { c: 'x', d: (n: number) => `${n} things` }, e: ['one', 'two'] };
  assert.deepEqual(differences(es, en), []);
  assert.deepEqual(differences(es, { ...en, a: ' ' }), ['a: empty text']);
  assert.deepEqual(differences(es, { ...en, z: 'sobra' }), ['z: extra']);
  assert.deepEqual(differences(es, { a: 'Hello', e: en.e }), ['b: missing']);
  assert.deepEqual(differences(es, { ...en, b: { c: 'x', d: 'texto' } }), ['b.d: function vs string']);
  assert.deepEqual(differences(es, { ...en, b: { c: 'x', d: () => 'x' } }), ['b.d: 1 parameters vs 0']);
  assert.deepEqual(differences(es, { ...en, b: { c: 'x', d: (n: number) => (n === 2 ? '' : 'x') } }), ['b.d(2): gives no text']);
  assert.deepEqual(differences(es, { ...en, e: ['one'] }), ['e: 2 elements vs 1']);
  assert.deepEqual(differences(es, { ...en, e: ['one', ''] }), ['e[1]: empty text']);
  // A function that asks for something other than numbers is not called with numbers in the other language.
  const parts = { f: (p: { name: string }) => p.name.toUpperCase() };
  assert.deepEqual(differences(parts, { f: (p: { name: string }) => p.name }), []);
});

test('both languages have the same namespaces, in the same order, and the same shape', () => {
  assert.deepEqual(Object.keys(DICTIONARIES), [...LOCALES]);
  for (const locale of LOCALES) assert.deepEqual(Object.keys(DICTIONARIES[locale]), NAMESPACES, locale);
  assert.deepEqual(differences(DICTIONARIES.es, DICTIONARIES.en), []);
});

test('every file in src/i18n/es/ and src/i18n/en/ is a registered namespace (none is left out)', () => {
  for (const locale of LOCALES) {
    const dir = join(import.meta.dirname, '../src/i18n', locale);
    const names = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
      .map((f) => f.slice(0, -'.ts'.length))
      .sort();
    assert.deepEqual(names, [...NAMESPACES].sort(), locale);
  }
});

test('t() gives the dictionary of the language chosen at each moment, without restarting', () => {
  const before = prefs.get().locale;
  try {
    prefs.setLocale('es');
    assert.equal(currentLocale(), 'es');
    assert.equal(t(), DICTIONARIES.es);
    prefs.setLocale('en');
    assert.equal(currentLocale(), 'en');
    assert.equal(t(), DICTIONARIES.en);
  } finally {
    prefs.setLocale(before);
  }
});

test('with nothing saved (also in node, without localStorage) the language is English', () => {
  // This file does not pin the language: the app's store starts at the default. It works because `node --test` runs each
  // file in its own process (per-process isolation, the default): the `./idioma-es.ts` that the other files import
  // does not reach here. If everything ran in one process (`--test-isolation=none`), this test would fail.
  assert.equal(prefs.get().locale, 'en');
  assert.equal(t(), DICTIONARIES.en);
});

test('BCP-47 tags: US English and Spain Spanish', () => {
  assert.deepEqual(LOCALE_TAGS, { en: 'en-US', es: 'es-ES' });
  assert.equal(localeTag('es'), 'es-ES');
  assert.equal(localeTag(), LOCALE_TAGS[currentLocale()]);
});

test('plural: picks the form by the language rules and falls back to "other" if the right one is missing', () => {
  const items = (n: number, locale: 'en' | 'es') => plural(n, { one: 'one', other: 'other' }, locale);
  for (const locale of LOCALES) {
    assert.equal(items(1, locale), 'one', locale);
    for (const n of [0, 2, 5, 1000, 1.5]) assert.equal(items(n, locale), 'other', `${locale} ${n}`);
  }
  // In Spanish, a million is "many" in CLDR: without that form, "other".
  assert.equal(plural(1_000_000, { one: 'un', other: 'muchos' }, 'es'), 'muchos');
  assert.equal(plural(1_000_000, { one: 'un', many: 'de', other: 'muchos' }, 'es'), 'de');
  // With no language, the current one.
  const before = prefs.get().locale;
  try {
    prefs.setLocale('es');
    assert.equal(plural(1, { one: 'un buzón', other: 'buzones' }), 'un buzón');
  } finally {
    prefs.setLocale(before);
  }
});

/** The fixed texts (not the functions) of a dictionary, at any depth. */
function stringLeaves(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(stringLeaves);
  if (v !== null && typeof v === 'object') return Object.values(v).flatMap(stringLeaves);
  return [];
}

/** The quotes of each language: "..." guillemets in Spanish and curly quotes in English. */
const QUOTED: Record<'en' | 'es', RegExp> = { en: /“([^“”]+)”/g, es: /«([^«»]+)»/g };
/** Quoted but not the name of a screen, a section or a field (real quotations, examples). Empty for now. */
const QUOTED_ALLOWED = new Set<string>([]);

/** The quoted texts of a language's dictionary. */
const quotedIn = (locale: 'en' | 'es') =>
  stringLeaves(DICTIONARIES[locale]).flatMap((s) => [...s.matchAll(QUOTED[locale])].map((m) => m[1]));

test('what goes in quotes (a screen, a section, a field) is named the same as in its place in the same dictionary', () => {
  for (const locale of LOCALES) {
    const leaves = stringLeaves(DICTIONARIES[locale]);
    const names = new Set(leaves.map((s) => s.trim()));
    const quoted = quotedIn(locale);
    assert.ok(quoted.length > 0, locale);
    const bad = quoted.filter((q) => !names.has(q) && !QUOTED_ALLOWED.has(q));
    assert.deepEqual(bad, [], locale);
  }
});

test('the buttons a sentence tells you to press go without quotes', () => {
  const buttons = {
    es: ['Reintentar', 'Reanudar', 'Reintentar ahora', 'Actualizar'],
    en: ['Retry', 'Resume', 'Retry now', 'Refresh'],
  } as const;
  for (const locale of LOCALES) {
    const quoted = quotedIn(locale);
    for (const b of buttons[locale]) assert.ok(!quoted.includes(b), `${locale}: ${b}`);
    // The screen names keep theirs.
    assert.ok(quoted.includes(locale === 'es' ? 'Direcciones' : 'Addresses'), locale);
  }
});
