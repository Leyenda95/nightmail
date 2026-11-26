// Front screen, seed phrase and password texts: English says the same as Spanish and the password rules speak the
// language of that moment.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { describeError } from '../src/errors.ts';
import { DICTIONARIES } from '../src/i18n/index.ts';
import { retryNowButton } from '../src/notices.ts';
import { prefs, type Locale } from '../src/prefs.ts';
import { changeErrorPlace, changeProblem, mismatchText, notChangedText } from '../src/screens/password.ts';

const en = DICTIONARIES.en.onboarding;
const es = DICTIONARIES.es.onboarding;

/** Runs `fn` with the language set and returns it as it was. */
function inLocale(locale: Locale, fn: () => void) {
  const before = prefs.get().locale;
  prefs.setLocale(locale);
  try {
    fn();
  } finally {
    prefs.setLocale(before);
  }
}

test('en onboarding: the fixed glossary', () => {
  assert.equal(en.welcome.showPhrase.title, 'Your recovery phrase');
  assert.equal(en.welcome.restore.phrase, 'Recovery phrase');
  assert.equal(en.welcome.menu.create, 'Create my recovery phrase');
  assert.match(en.welcome.showPhrase.note, /“Recovery phrase”/);
  assert.equal(en.startup.retry, 'Retry');
  assert.equal(en.recovery.retry, 'Retry the restore');
  assert.equal(en.startup.badConfigTitle, 'Configuration incomplete');
  assert.match(en.welcome.create.text, /^It protects your recovery phrase on this device\./);
  assert.match(en.welcome.restore.recoveringText, /^We're searching Midnight for /);
  assert.equal(en.password.text, 'After that, unlock NightMail with the new password.');
  assert.equal(en.recovery.doneTitle, 'Restore complete');
  assert.match(en.recovery.later, /“Addresses”/);
  assert.match(en.welcome.restore.recoveringText, /vouchers/);
  assert.equal(en.resume.retrying, 'Retrying…');
  assert.equal(en.resume.meanwhile, 'Meanwhile, you can keep using the app.');
});

test('profiles: the same words in both languages, "perfil" and never "cuenta"', () => {
  assert.equal(es.accounts.switchAccount, 'Cambiar de perfil');
  assert.equal(en.accounts.switchAccount, 'Switch profile');
  assert.equal(es.accounts.title, 'Elige un perfil');
  assert.equal(en.accounts.title, 'Choose a profile');
  assert.equal(es.accounts.text, 'Estos son los perfiles guardados en este dispositivo. Cada uno se abre con su propia contraseña.');
  assert.equal(en.accounts.text, 'These are the profiles saved on this device. Each one opens with its own password.');
  assert.equal(es.accounts.name(2), 'Perfil 2');
  assert.equal(en.accounts.name(2), 'Profile 2');
  assert.equal(es.accounts.created('18 nov 2026'), 'Creado el 18 nov 2026');
  assert.equal(en.accounts.created('Nov 18, 2026'), 'Created on Nov 18, 2026');
  assert.equal(es.accounts.openNow, 'Abierto ahora');
  assert.equal(en.accounts.openNow, 'Open now');
  assert.equal(es.accounts.createOther, 'Crear o restaurar otro perfil');
  assert.equal(en.accounts.createOther, 'Create or restore another profile');
  assert.equal(es.accounts.backToAccounts, 'Volver a mis perfiles');
  assert.equal(en.accounts.backToAccounts, 'Back to my profiles');
  assert.equal(es.accounts.openingTitle, 'Abriendo el perfil…');
  assert.equal(en.accounts.openingTitle, 'Opening the profile…');
  assert.equal(es.accounts.openingText, 'NightMail se cerrará y se abrirá de nuevo con el perfil elegido.');
  assert.equal(es.accounts.failed, 'No se ha podido cambiar de perfil. Vuelve a intentarlo.');
  assert.equal(es.startup.chooseOther, 'Elegir otro perfil');
  assert.equal(en.startup.chooseOther, 'Choose another profile');
  assert.equal(es.startup.profileInUseText, 'Este perfil ya está abierto en otra ventana de NightMail. Usa esa ventana o elige otro perfil.');
  assert.match(en.startup.profileInUseText, /^This profile is already open in another NightMail window\./);
  assert.equal(es.welcome.menu.title, 'Aquí no hay perfil.');
  assert.equal(en.welcome.menu.title, "There's no profile here.");
  assert.match(es.welcome.showPhrase.text, /controla tu perfil\./);
  assert.match(en.welcome.showPhrase.text, /controls your profile\./);
  assert.match(es.seedReveal.hint, /controla tu perfil\.$/);
  assert.match(en.seedReveal.hint, /controls your profile\.$/);
  assert.equal(DICTIONARIES.es.screensMail.sidebar.logOut, 'Cerrar sesión');
  assert.equal(DICTIONARIES.en.screensMail.sidebar.logOut, 'Log out');
  // No visible onboarding text says "cuenta" or "account" any more (the "Sin cuenta" slogan lives in `slogans`).
  const strings = (o: unknown): string[] =>
    typeof o === 'string' ? [o] : typeof o === 'object' && o !== null ? Object.values(o).flatMap(strings) : [];
  for (const text of strings(es)) assert.doesNotMatch(text, /cuenta/i, text);
  for (const text of strings(en)) assert.doesNotMatch(text, /account/i, text);
});

test('the pending notice button: "Retry now" and "Reintentar ahora"', () => {
  inLocale('en', () => assert.equal(retryNowButton(), 'Retry now'));
  inLocale('es', () => assert.equal(retryNowButton(), 'Reintentar ahora'));
});

test('en onboarding: unnamed mailbox and alias (the kind comes from mail.slotKind)', () => {
  const enKind = DICTIONARIES.en.mail.slotKind;
  const esKind = DICTIONARIES.es.mail.slotKind;
  assert.equal(en.recovery.missingName(enKind('mailbox')), 'Missing mailbox name');
  assert.equal(en.recovery.missingName(enKind('alias')), 'Missing alias name');
  assert.equal(en.recovery.nameLabel(enKind('mailbox')), 'Mailbox name');
  assert.equal(en.recovery.nameLabel(enKind('alias')), 'Alias name');
  assert.match(en.recovery.missingNameText(enKind('alias')), /^We couldn't read the alias's name\./);
  // The Spanish as ever.
  assert.equal(es.recovery.missingName(esKind('mailbox')), 'Falta el nombre de un buzón');
  assert.equal(es.recovery.nameLabel(esKind('alias')), 'Nombre del alias');
  assert.equal(
    es.recovery.missingNameText(esKind('mailbox')),
    'No hemos podido leer el nombre del buzón. Escríbelo tal como lo elegiste y comprobaremos que coincide.',
  );
});

test('en onboarding: what it says is still safe matches the Spanish', () => {
  // Phrase saved and encrypted on the device; no plan or addresses until it finishes. Nothing more.
  assert.match(en.recovery.safe, /already saved and encrypted on this device/);
  assert.match(en.recovery.safe, /can't use the plan or the addresses/);
  assert.match(en.welcome.showPhrase.text, /We don't have it and can't recover it for you\./);
  assert.match(es.welcome.showPhrase.text, /Nosotros no la tenemos y no podemos recuperarla por ti\./);
});

test('the password rules in English', () => {
  inLocale('en', () => {
    assert.equal(mismatchText(), "The passwords don't match.");
    const ok = { current: 'old', next: 'new', repeat: 'new' };
    assert.deepEqual(changeProblem({ ...ok, current: '' }), { field: 'current', message: 'Enter your current password.' });
    assert.deepEqual(changeProblem({ ...ok, next: '', repeat: '' }), { field: 'next', message: 'Enter the new password.' });
    assert.deepEqual(changeProblem({ ...ok, repeat: '' }), { field: 'repeat', message: 'Repeat the new password.' });
    assert.deepEqual(changeProblem({ ...ok, repeat: 'ne' }), { field: 'repeat', message: "The passwords don't match." });
    assert.deepEqual(changeProblem({ current: 'x', next: 'x', repeat: 'x' }), {
      field: 'next',
      message: 'The new password is the same as the current one.',
    });
    const placed = changeErrorPlace('storage', describeError({ code: 'storage' }));
    assert.equal(placed.field, null);
    assert.ok(placed.message.startsWith(`${notChangedText()} `));
    assert.equal(notChangedText(), "The password hasn't been changed.");
  });
});

test('the front page language selector: each name in its own language, the same in both dictionaries', () => {
  assert.deepEqual(DICTIONARIES.en.settings.languageNames, { en: 'English', es: 'Español' });
  assert.deepEqual(DICTIONARIES.es.settings.languageNames, DICTIONARIES.en.settings.languageNames);
  assert.equal(DICTIONARIES.en.settings.language.legend, 'Language');
  assert.equal(DICTIONARIES.es.settings.language.legend, 'Idioma');
});

test('every screen before entering has the language selector, the same as the front page', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const welcome = readFileSync(new URL('../src/screens/Welcome.tsx', import.meta.url), 'utf8');
  // A piece of code: from `function name` to the first closing brace at the start of a line.
  const fn = (src: string, name: string) => src.match(new RegExp(`function ${name}\\b[\\s\\S]*?\\n\\}`))?.[0] ?? '';
  // Startup (loading, incomplete configuration, error): the `Startup` frame always paints it, unconditionally.
  assert.match(fn(app, 'Startup'), /^ {8}<Languages \/>$/m);
  for (const kind of ['loading', 'badConfig', 'error']) {
    const block = app.match(new RegExp(`case '${kind}':[\\s\\S]*?</Startup>`))?.[0] ?? '';
    assert.match(block, /return \(\s*<Startup>/, kind);
  }
  // Front screen (unlock, menu, create, view the phrase, restore and its steps): all inside `Portada`, which paints it.
  assert.match(fn(welcome, 'Portada'), /<Languages \/>/);
  for (const step of ['Unlock', 'ShowPhrase', 'Create', 'Restore', 'Menu', 'AccountsScreen']) {
    const returns = fn(welcome, step).match(/return \(\s*<\w+/g) ?? [];
    assert.ok(returns.length > 0, step);
    for (const r of returns) assert.match(r, /<(Portada|ShowPhrase)$/, step);
  }
  // A single selector for all: that of components/Languages.tsx, which stores in `prefs` like Settings.
  for (const src of [app, welcome]) {
    assert.match(src, /import \{ Languages \} from '[./]+\/components\/Languages\.tsx';/);
    assert.doesNotMatch(src, /function Languages\b/);
  }
});

test('the loading and incomplete configuration screens change language with the selector', () => {
  const seen = (locale: Locale) => {
    let out: string[] = [];
    inLocale(locale, () => {
      const s = DICTIONARIES[prefs.get().locale].onboarding.startup;
      out = [s.opening, s.badConfigTitle, s.badConfigText];
    });
    return out;
  };
  const enTexts = seen('en');
  const esTexts = seen('es');
  enTexts.forEach((text, i) => {
    assert.ok(text !== '' && esTexts[i] !== '');
    assert.notEqual(text, esTexts[i]);
  });
});

test('the startup error screen: when the language changes, the title, the error and "Reintentar" change with it', () => {
  // `App` translates when painting: what is seen is `startup` and `describeError` read with the language of that moment.
  const seen = (locale: Locale) => {
    let out: string[] = [];
    inLocale(locale, () => {
      const s = DICTIONARIES[prefs.get().locale].onboarding.startup;
      out = [s.failedTitle, describeError({ code: 'storage' }), s.retry];
    });
    return out;
  };
  const [enTitle, enError, enRetry] = seen('en');
  const [esTitle, esError, esRetry] = seen('es');
  assert.equal(enTitle, "Couldn't open NightMail");
  assert.equal(esTitle, 'No se ha podido abrir NightMail');
  assert.equal(enRetry, 'Retry');
  assert.equal(esRetry, 'Reintentar');
  assert.ok(enError !== '' && esError !== '');
  assert.notEqual(enError, esError);
});
