// Options of the Settings page: no preference is missing and all are understood. And live language switching:
// what is stored (options, failures, wait reasons) comes out in the language of each moment.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DICTIONARIES } from '../src/i18n/index.ts';
import { BADGE_COUNTS, DEFAULT_PREFS, LAYOUTS, LOCALES, SIZES, THEMES, prefs, type Locale } from '../src/prefs.ts';
import { badgeCountChoices, languageChoices, layoutChoices, sizeChoices, themeChoices } from '../src/screens/settings.ts';
import { failureText, failureWhat, type Failure } from '../src/screens/useAction.ts';
import { midnightLine, serverLine, waitReason } from '../src/sidebar.ts';

/** Runs `fn` with the given language and returns to the tests' Spanish. */
function inLocale<T>(locale: Locale, fn: () => T): T {
  try {
    prefs.setLocale(locale);
    return fn();
  } finally {
    prefs.setLocale('es');
  }
}

test('every theme, layout and language in prefs.ts has its option, without repeats and in the same order', () => {
  assert.deepEqual(themeChoices().map((c) => c.value), [...THEMES]);
  assert.deepEqual(layoutChoices().map((c) => c.value), [...LAYOUTS]);
  assert.deepEqual(languageChoices().map((c) => c.value), [...LOCALES]);
});

test('the taskbar number: its two options (on first, the default), with title and text and no drawing', () => {
  assert.deepEqual(badgeCountChoices().map((c) => c.value), [...BADGE_COUNTS]);
  assert.equal(badgeCountChoices()[0].value, DEFAULT_PREFS.badgeCount);
  assert.equal(DICTIONARIES.es.settings.badgeCount.legend, 'Mostrar el número de correos sin leer en el icono de la barra de tareas');
  for (const locale of LOCALES) {
    inLocale(locale, () => {
      for (const c of badgeCountChoices()) {
        assert.ok(c.title.trim() && c.text?.trim(), `${locale} ${c.value}`);
        assert.equal(c.art, undefined, `${locale} ${c.value}`);
        assert.equal(c.boxes, 0, `${locale} ${c.value}`);
      }
    });
  }
});

test('every option has a title, text and drawing (languages, only title and drawing)', () => {
  for (const locale of LOCALES) {
    inLocale(locale, () => {
      for (const c of [...themeChoices(), ...layoutChoices(), ...sizeChoices('100')]) {
        assert.ok(c.title.trim() && c.text?.trim() && c.art.trim(), `${locale} ${c.value}`);
      }
      for (const c of languageChoices()) assert.ok(c.title.trim() && c.art.trim() && c.glyph, `${locale} ${c.value}`);
    });
  }
});

test('the three-panel option draws 3 boxes and the others 2', () => {
  for (const c of [...themeChoices(), ...layoutChoices()]) assert.equal(c.boxes, c.value === 'tres' ? 3 : 2, c.value);
});

test('every size in prefs.ts has its option, in order, with its "Aa" growing each time and no boxes', () => {
  const sizes = sizeChoices('175');
  assert.deepEqual(sizes.map((c) => c.value), [...SIZES]);
  assert.deepEqual(sizes.map((c) => c.title), ['Automático (175 %)', '100 %', '125 %', '150 %', '175 %', '200 %']);
  assert.deepEqual(sizes.map((c) => c.scale), [1.75, 1, 1.25, 1.5, 1.75, 2]);
  assert.deepEqual(sizes.map((c) => c.text), [
    'Se ajusta a la pantalla.',
    'Tamaño normal.',
    'Un 25 % más grande.',
    'Un 50 % más grande.',
    'Un 75 % más grande.',
    'Un 100 % más grande.',
  ]);
  for (const c of sizes) {
    assert.equal(c.boxes, 0, c.value);
    assert.equal(c.glyph, 'Aa', c.value);
  }
});

test('"Automático" says the size in use, and its "Aa" is at that scale', () => {
  const [auto] = sizeChoices('100');
  assert.equal(auto.title, 'Automático (100 %)');
  assert.equal(auto.scale, 1);
  assert.equal(sizeChoices('200')[0].title, 'Automático (200 %)');
  assert.equal(inLocale('en', () => sizeChoices('125'))[0].title, 'Automatic (125%)');
});

test('en: sizes with the English percent sign, without a space', () => {
  const sizes = inLocale('en', () => sizeChoices('175'));
  assert.deepEqual(sizes.map((c) => c.title), ['Automatic (175%)', '100%', '125%', '150%', '175%', '200%']);
  assert.deepEqual(sizes.map((c) => c.text), ['Matches your screen.', 'Normal size.', '25% larger.', '50% larger.', '75% larger.', '100% larger.']);
});

test('en: Settings texts', () => {
  const s = DICTIONARIES.en.settings;
  assert.equal(s.language.legend, 'Language');
  assert.equal(s.layout.legend, 'Layout');
  assert.equal(s.theme.legend, 'Theme');
  assert.equal(s.size.legend, 'Interface size');
  assert.equal(s.password.title, 'Password');
  assert.equal(s.password.change, 'Change password');
  assert.equal(s.version, 'NightMail version');
  assert.match(s.password.text, /recovery phrase/);
  assert.deepEqual(inLocale('en', layoutChoices).map((c) => c.title), ['Three panels', 'Two panels']);
  assert.deepEqual(inLocale('en', themeChoices).map((c) => c.title), ['System', 'Light', 'Dark']);
});

test('language names are always written in their own language, whatever the interface language', () => {
  assert.deepEqual(DICTIONARIES.en.settings.languageNames, DICTIONARIES.es.settings.languageNames);
  for (const locale of LOCALES) {
    const choices = inLocale(locale, languageChoices);
    assert.deepEqual(choices.map((c) => c.title), ['English', 'Español'], locale);
    assert.deepEqual(choices.map((c) => c.lang), ['en', 'es'], locale);
    assert.deepEqual(choices.map((c) => c.glyph), ['En', 'Es'], locale);
  }
});

test('live: the options come out in the language current when they are requested', () => {
  assert.equal(layoutChoices()[0].title, 'Tres paneles');
  assert.equal(inLocale('en', layoutChoices)[0].title, 'Three panels');
  assert.equal(layoutChoices()[0].title, 'Tres paneles');
});

test('live: a stored failure is translated when read, not when stored', () => {
  const failure: Failure = { error: { code: 'wrongPassword' } };
  assert.equal(failureText(failure), 'Contraseña incorrecta. Vuelve a intentarlo.');
  assert.equal(inLocale('en', () => failureText(failure)), 'Wrong password. Try again.');
  assert.equal(inLocale('en', () => failureWhat(failure)), 'Wrong password.');
  assert.equal(failureWhat(failure), 'Contraseña incorrecta.');
  assert.equal(failureText(null), null);
  assert.equal(failureWhat(null), null);
});

test("live: a failure's own text (`explain`) is also requested again in the new language", () => {
  const explain = (code: string | null) =>
    code === 'stillPending' ? (prefs.get().locale === 'en' ? 'Still pending.' : 'Sigue pendiente.') : null;
  const failure: Failure = { error: { code: 'stillPending' }, explain };
  assert.equal(failureText(failure), 'Sigue pendiente.');
  assert.equal(inLocale('en', () => failureText(failure)), 'Still pending.');
  // With no text of its own for that code, the usual one.
  assert.equal(failureText({ error: { code: 'wrongPassword' }, explain }), 'Contraseña incorrecta. Vuelve a intentarlo.');
});

test("live: changing the language does not change the bar's wait reason (the grey→red timer does not restart)", () => {
  const ready = { state: 'ready', sidecarVersion: '0.1.0' } as const;
  const noData = { health: null, failed: false };
  const lines = () => [
    midnightLine(null, noData),
    midnightLine(ready, noData),
    serverLine(noData),
    serverLine({ ...noData, failed: true }),
  ];
  const es = lines();
  const en = inLocale('en', lines);
  assert.deepEqual(en.map(waitReason), es.map(waitReason));
  assert.deepEqual(es.map(waitReason), ['silent', 'checking', 'checking', 'notChecked']);
  assert.notDeepEqual(en.map((l) => l.text), es.map((l) => l.text));
});
