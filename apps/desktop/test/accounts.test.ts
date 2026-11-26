// The "Elige un perfil" list: what each row says and when the new account's menu offers "Volver a mis perfiles".
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  accountNameTooLong,
  accountRows,
  cleanAccountName,
  deleteFieldError,
  deleteProfileError,
  deleteProfileLabel,
  hasOtherAccounts,
  MAX_ACCOUNT_NAME,
  profileName,
  profileNameDraft,
} from '../src/accounts.ts';
import type { AccountView } from '../src/bindings/AccountView.ts';
import { formatDay } from '../src/format.ts';
import { DICTIONARIES, t } from '../src/i18n/index.ts';
import { prefs } from '../src/prefs.ts';

// 18 Nov 2026 at noon UTC: the same day in every time zone the tests run in.
const NOV_18 = Date.UTC(2026, 10, 18, 12) / 1000;

const account = (id: string, number: number, current = false, createdAt: number | null = NOV_18): AccountView => ({
  id,
  name: null,
  number,
  autoNumber: number,
  createdAt,
  current,
});

test('each row: "Perfil N", its creation day and whether it is the open one', () => {
  const rows = accountRows([account('main', 1, true), account('ab'.repeat(16), 2)]);
  assert.deepEqual(rows, [
    { id: 'main', name: 'Perfil 1', created: `Creado el ${formatDay(NOV_18)}`, current: true },
    { id: 'ab'.repeat(16), name: 'Perfil 2', created: `Creado el ${formatDay(NOV_18)}`, current: false },
  ]);
  assert.equal(rows[0]?.created, 'Creado el 18 nov 2026');
});

test('without a known creation day the row says nothing about it', () => {
  assert.equal(accountRows([account('main', 1, false, null)])[0]?.created, null);
});

test('the rows speak the language of the moment', () => {
  prefs.setLocale('en');
  try {
    const [row] = accountRows([account('main', 3)]);
    assert.equal(row?.name, 'Profile 3');
    assert.equal(row?.created, 'Created on Nov 18, 2026');
  } finally {
    prefs.setLocale('es');
  }
});

test('the numbers are the core\'s, in its order (never renumbered here)', () => {
  const rows = accountRows([account('main', 1), account('cd'.repeat(16), 3)]);
  assert.deepEqual(
    rows.map((r) => r.name),
    ['Perfil 1', 'Perfil 3'],
  );
});

test('"Volver a mis perfiles" only when there is another account to go back to', () => {
  assert.equal(hasOtherAccounts(null), false, 'list not read (or failed)');
  assert.equal(hasOtherAccounts([]), false, 'first install');
  assert.equal(hasOtherAccounts([account('main', 1, true)]), false, 'only the open one');
  assert.equal(hasOtherAccounts([account('main', 1)]), true, 'a new, still empty account is not listed: account 1 is another');
  assert.equal(hasOtherAccounts([account('main', 1, true), account('ef'.repeat(16), 2)]), true);
});

// ---------- Profile names ----------

test('a profile with a name shows it instead of the default one, which stays for the rest', () => {
  const named: AccountView = { ...account('ab'.repeat(16), 2), name: 'Trabajo' };
  const rows = accountRows([account('main', 1, true), named]);
  assert.deepEqual(
    rows.map((r) => r.name),
    [t().onboarding.accounts.name(1), 'Trabajo'],
  );
});

test('a name with markup is plain text in the row (React escapes it when drawing)', () => {
  const name = '<img src=x onerror=alert(1)>';
  const [row] = accountRows([{ ...account('main', 1), name }]);
  assert.equal(row?.name, name);
});

test('the name is cleaned as the core does: invisible characters out, controls and spaces made one space', () => {
  assert.equal(cleanAccountName(''), '');
  assert.equal(cleanAccountName('   \t\n'), '');
  assert.equal(cleanAccountName('\u200B\uFEFF\u00AD\u061C\u2066'), '');
  assert.equal(cleanAccountName('  a   b  '), 'a b');
  assert.equal(cleanAccountName('a\nb\r\nc\td\u0000e\u0007f\u0085g'), 'a b c d e f g');
  assert.equal(cleanAccountName('ad\u202Enimda\u200F'), 'adnimda');
  assert.equal(cleanAccountName('../../etc'), '../../etc', 'never a path: it stays text');
});

test('the limit counts characters, not UTF-16 units, and ignores what cleaning removes', () => {
  assert.equal(MAX_ACCOUNT_NAME, 40);
  assert.equal(accountNameTooLong('ñ'.repeat(40)), false);
  assert.equal(accountNameTooLong('😀'.repeat(40)), false, 'each emoji is 2 UTF-16 units but 1 character');
  assert.equal(accountNameTooLong(`   ${'a'.repeat(40)}   `), false);
  assert.equal(accountNameTooLong('a'.repeat(41)), true);
  assert.equal(accountNameTooLong(''), false);
});

/** Runs `fn` in English and returns to the tests' Spanish. */
function inEnglish<T>(fn: () => T): T {
  prefs.setLocale('en');
  try {
    return fn();
  } finally {
    prefs.setLocale('es');
  }
}

test('the automatic name follows the language and uses its fixed number, not the place in the list', () => {
  // Profile 2 was removed: this one is now second in the list but keeps the number 3 it was given.
  const auto: AccountView = { ...account('bb'.repeat(16), 2), autoNumber: 3 };
  assert.equal(profileName(auto), 'Perfil 3');
  assert.equal(inEnglish(() => profileName(auto)), 'Profile 3');
  const rows = accountRows([account('main', 1, true), auto]);
  assert.deepEqual(
    rows.map((r) => r.name),
    ['Perfil 1', 'Perfil 3'],
  );
  assert.deepEqual(
    inEnglish(() => accountRows([account('main', 1, true), auto]).map((r) => r.name)),
    ['Profile 1', 'Profile 3'],
  );
});

test('a name the user wrote is shown as written in both languages, even one that looks like the automatic one', () => {
  for (const name of ['Trabajo', 'Perfil de casa', 'Work profile 2']) {
    const own: AccountView = { ...account('main', 1, true), name, autoNumber: 5 };
    assert.equal(profileName(own), name);
    assert.equal(inEnglish(() => profileName(own)), name);
    assert.equal(inEnglish(() => accountRows([own])[0]?.name), name);
  }
});

test('Settings: the field starts with the name shown now and keeps what the user types', () => {
  const auto: AccountView = { ...account('main', 1, true), autoNumber: 2 };
  assert.equal(profileNameDraft(auto, null), 'Perfil 2', 'untouched: the automatic name in Spanish');
  assert.equal(inEnglish(() => profileNameDraft(auto, null)), 'Profile 2', 'and in English after switching');
  assert.equal(profileNameDraft(auto, ''), '', 'emptied by the user: stays empty (saving it brings back the automatic name)');
  assert.equal(profileNameDraft(auto, 'Casa'), 'Casa');
  // After saving, the core answers the profile as listed now and the field shows that.
  const renamed: AccountView = { ...auto, name: 'Casa' };
  assert.equal(profileNameDraft(renamed, null), 'Casa');
  assert.equal(inEnglish(() => profileNameDraft(renamed, null)), 'Casa');
  // Emptied and saved: automatic again with the same number.
  assert.equal(profileNameDraft({ ...renamed, name: null }, null), 'Perfil 2');
});

test('Settings: a name over the limit marks the field with the error, in both languages', () => {
  const s = () => t().settings.profileName;
  assert.equal(accountNameTooLong('a'.repeat(MAX_ACCOUNT_NAME + 1)), true);
  assert.equal(accountNameTooLong(` ${'a'.repeat(MAX_ACCOUNT_NAME)} `), false);
  assert.equal(s().tooLong(MAX_ACCOUNT_NAME), 'Usa como m\u00E1ximo 40 caracteres.');
  assert.equal(inEnglish(() => s().tooLong(MAX_ACCOUNT_NAME)), 'Use 40 characters at most.');
});

test('the Settings profile name texts, in both languages, always say perfil or profile', () => {
  const es = t().settings.profileName;
  assert.equal(es.title, 'Nombre del perfil');
  assert.equal(es.save, 'Guardar el nombre');
  assert.match(es.text(40), /Hasta 40 caracteres\..*Perfil y su n\u00FAmero/);
  const en = inEnglish(() => t().settings.profileName);
  assert.equal(en.title, 'Profile name');
  assert.equal(en.save, 'Save name');
  assert.match(en.text(40), /Up to 40 characters\..*Profile and its number/);
  for (const text of [es.text(40), es.saved, es.failed, es.loadFailed]) assert.match(text, /perfil/i);
  for (const text of [en.text(40), en.saved, en.failed, en.loadFailed]) assert.match(text, /profile/i);
});

test('the profile name texts, in both languages', () => {
  const es = t().onboarding.profileName;
  assert.equal(es.label, 'Nombre del perfil (opcional)');
  assert.match(es.help(40), /Hasta 40 caracteres/);
  assert.equal(es.tooLong(40), 'Usa como máximo 40 caracteres.');
  prefs.setLocale('en');
  try {
    const en = t().onboarding.profileName;
    assert.equal(en.label, 'Profile name (optional)');
    assert.match(en.help(40), /Up to 40 characters/);
    assert.equal(en.tooLong(40), 'Use 40 characters at most.');
  } finally {
    prefs.setLocale('es');
  }
});

// --- Deleting a profile from this computer ---------------------------------------------------------------

test('each box has its own trash can, to the right, named after that profile', () => {
  const rows = accountRows([account('main', 1, true), { ...account('ab'.repeat(16), 2), name: 'Trabajo' }]);
  assert.deepEqual(
    rows.map((r) => deleteProfileLabel(r.name)),
    ['Eliminar Perfil 1 de este ordenador', 'Eliminar Trabajo de este ordenador'],
  );
  prefs.setLocale('en');
  try {
    assert.equal(deleteProfileLabel(accountRows([account('main', 1)])[0]?.name ?? ''), 'Delete Profile 1 from this computer');
  } finally {
    prefs.setLocale('es');
  }
  // In the list, inside every row: the trash can (with its accessible name) comes after the profile's choose button (tab order), inside the same row.
  const screen = readFileSync(new URL('../src/screens/Accounts.tsx', import.meta.url), 'utf8');
  const row = screen.slice(screen.indexOf('rows.map((row)'), screen.indexOf('</li>'));
  assert.ok(row.length > 0, 'the rows were found');
  const trash = row.indexOf('<Icon name="trash"');
  assert.ok(trash > 0 && trash > row.indexOf('className="nm-cuenta"'), 'the trash can goes after the choose button, to the right');
  assert.match(row, /aria-label=\{deleteProfileLabel\(row\.name\)\}/);
  assert.match(row, /setDeleting\(row\)/, 'it asks for THAT profile');
  // The trash can is transparent at rest (not display:none, so Tab still reaches it) and shows on row hover or focus; always visible without hover.
  const css = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.nm-cuenta__borrar \{[^}]*opacity: 0;/);
  assert.doesNotMatch(css, /\.nm-cuenta__borrar[^{]*\{[^}]*(display: none|visibility: hidden)/);
  assert.match(css, /\.nm-cuentas__fila:hover \.nm-cuenta__borrar,\s*\.nm-cuentas__fila:focus-within \.nm-cuenta__borrar,\s*\.nm-cuenta__borrar:focus-visible \{ opacity: 1; \}/);
  assert.match(css, /@media \(hover: none\) \{ \.nm-cuenta__borrar \{ opacity: 1; \} \}/);
});

test('deleting: a wrong or empty password goes to the field, the rest has its own words', () => {
  const s = t().onboarding.deleteProfile;
  assert.equal(deleteFieldError(true, null, null), 'Escribe la contraseña de este perfil.');
  assert.equal(deleteFieldError(false, 'wrongPassword', 'Contraseña incorrecta.'), 'Contraseña incorrecta.');
  // The wait after too many failures is the same as unlocking: the general text, not the field.
  assert.equal(deleteFieldError(false, 'tooManyAttempts', 'Espera'), null);
  assert.equal(deleteProfileError('profileInUse'), s.inUse);
  assert.equal(deleteProfileError('sessionBusy'), s.sessionBusy);
  assert.equal(deleteProfileError('notFound'), s.notFound);
  assert.equal(deleteProfileError('wrongPassword'), null);
  assert.equal(deleteProfileError('tooManyAttempts'), null);
  assert.equal(deleteProfileError(null), null);
});

test('the delete texts, in both languages: this computer only, nothing on Midnight, the 24 words', () => {
  const es = t().onboarding.deleteProfile;
  assert.equal(es.title, 'Eliminar perfil de este ordenador');
  assert.equal(es.cardButton, 'Eliminar perfil de este ordenador');
  assert.equal(es.submit, 'Eliminar perfil');
  assert.match(es.device, /claves.*correo.*nombre/);
  assert.match(es.chain, /^En Midnight no se borra nada\. Las direcciones que registraste siguen existiendo/);
  assert.match(es.words, /24 palabras.*para siempre\.$/);
  assert.equal(es.which('Perfil 2'), 'Perfil: Perfil 2');
  assert.equal(es.inUse, 'Este perfil está abierto en otra ventana de NightMail. Cierra esa ventana y vuelve a intentarlo.');
  prefs.setLocale('en');
  try {
    const en = t().onboarding.deleteProfile;
    assert.equal(en.title, 'Delete profile from this computer');
    assert.equal(en.cardButton, 'Delete profile from this computer');
    assert.equal(en.submit, 'Delete profile');
    assert.match(en.chain, /^Nothing is erased on Midnight\. The addresses you registered still exist/);
    assert.match(en.words, /24 words.*forever\.$/);
    assert.equal(en.deleted('Profile 2'), 'Profile deleted: Profile 2.');
  } finally {
    prefs.setLocale('es');
  }
  // Always "perfil", never "cuenta" (or "account").
  const texts = (o: unknown): string[] =>
    typeof o === 'string'
      ? [o]
      : typeof o === 'function'
        ? [String(o('X'))]
        : typeof o === 'object' && o !== null
          ? Object.values(o).flatMap(texts)
          : [];
  for (const text of texts(DICTIONARIES.es.onboarding.deleteProfile)) assert.doesNotMatch(text, /cuenta/i, text);
  for (const text of texts(DICTIONARIES.en.onboarding.deleteProfile)) assert.doesNotMatch(text, /account/i, text);
});
