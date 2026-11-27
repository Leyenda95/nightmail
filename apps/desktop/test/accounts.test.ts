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
  networkChoices,
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
  recent: false,
});

test('each row: "Perfil N", its creation day, whether it is the open one and whether it was entered last', () => {
  // The open profile was only chosen; the other one was the last entered: each flag stays its own.
  const rows = accountRows([account('main', 1, true), { ...account('ab'.repeat(16), 2), recent: true }]);
  assert.deepEqual(rows, [
    { id: 'main', name: 'Perfil 1', created: `Creado el ${formatDay(NOV_18)}`, current: true, recent: false },
    { id: 'ab'.repeat(16), name: 'Perfil 2', created: `Creado el ${formatDay(NOV_18)}`, current: false, recent: true },
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
  assert.equal(es.tooLong(40), 'Usa como máximo 40 caracteres.');
  prefs.setLocale('en');
  try {
    const en = t().onboarding.profileName;
    assert.equal(en.label, 'Profile name (optional)');
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

// --- "Nuevo perfil": the "+" of the list, the network and the back arrows ----------------------------------------

test('"Nuevo perfil": the three networks in order, only the local one can be chosen (the others say "Pronto")', () => {
  const choices = networkChoices();
  assert.deepEqual(
    choices.map((c) => [c.value, c.title, c.available]),
    [
      ['local', 'Local', true],
      ['preprod', 'Preprod', false],
      ['mainnet', 'Mainnet', false],
    ],
  );
  assert.equal(choices[0]?.text, 'Una red de pruebas en este ordenador.');
  prefs.setLocale('en');
  try {
    assert.equal(networkChoices()[2]?.text, "Midnight's main network.");
  } finally {
    prefs.setLocale('es');
  }
  // The screen: the local one comes checked and the others disabled; "Continuar" opens the new profile in this window.
  const screen = readFileSync(new URL('../src/screens/Accounts.tsx', import.meta.url), 'utf8');
  assert.match(screen, /defaultChecked=\{c\.available\} disabled=\{!c\.available\}/);
  assert.match(screen, /!c\.available && <Tag>\{s\.soon\}<\/Tag>/);
  assert.match(screen, /onClick=\{\(\) => void open\('new', api\.newAccount\)\}\s*>\s*\{s\.continue\}/);
});

test('switching or creating a profile shows no screen in between: the clicked control is busy and clicks wait', () => {
  const screen = readFileSync(new URL('../src/screens/Accounts.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(screen, /function Opening|<Opening|openingTitle|openingText/);
  assert.doesNotMatch(screen, /if \(opening\) return/);
  // One switch at a time, guarded by a ref so a second click before painting again cannot start another.
  assert.match(screen, /if \(running\.current\) return;\s*running\.current = true;/);
  assert.match(screen, /aria-busy=\{opening === row\.id \|\| undefined\}/);
  assert.match(screen, /aria-busy=\{opening !== null \|\| undefined\}/);
  // A failure frees the screen again and shows the error as before.
  assert.match(screen, /catch \{\s*running\.current = false;\s*setOpening\(null\);\s*setFailed\(true\);/);
  // After the switch: the next profile's first screen is read before mounting it (no loading screen and no empty menu
  // box in between), and that first box appears without its entry fade. On startup nothing of this applies.
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /void readFirstScreen\(failedDelete !== null\)\.then\(\(first\) => \{\s*badgeCleared\(\);/);
  assert.match(app, /useState<Load>\(first\?\.load \?\? \{ kind: 'loading' \}\)/);
  assert.match(app, /api\.takeShowAccounts\(\)\.catch\(\(\) => false\)/);
  assert.match(app, /api\.appStatus\(\)\.then\(\(status\): Load => \(\{ kind: 'ready', status \}\), failure\)/);
  assert.match(app, /api\.listAccounts\(\)\.catch\(\(\) => null\)/);
  assert.match(app, /first: null, quiet: null \}\)/);
  assert.match(app, /first, quiet: \{\} \}\)\);/);
  const welcome = readFileSync(new URL('../src/screens/Welcome.tsx', import.meta.url), 'utf8');
  assert.match(welcome, /useState<AccountView\[\] \| null \| undefined>\(initial\)/);
  assert.match(welcome, /initial=\{menuAccounts\}/);
  assert.match(welcome, /const quiet = useQuietEntry\(paso\);/);
  const css = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.nm-portada__caja\.nm-portada__caja--quieta \{ animation: none; \}/);
  for (const locale of ['es', 'en'] as const) {
    const accounts: Record<string, unknown> = DICTIONARIES[locale].onboarding.accounts;
    assert.equal(accounts.openingTitle, undefined);
    assert.equal(accounts.openingText, undefined);
  }
});

test('a cold start always shows the profile list first when there is a profile to choose, a switch never does', () => {
  // The core decides once, at startup only (`Accounts::list_first_at_startup`), not when another profile opens in the
  // same window (`commands::reopen`, which keeps only the "open profile deleted" case).
  const lib = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  assert.match(lib, /let show_accounts = show_accounts \|\| profile\.accounts\.as_ref\(\)\.is_some_and\(Accounts::list_first_at_startup\);\s*app\.manage\(AppState::new\(profile, show_accounts\)\);/);
  const commands = readFileSync(new URL('../src-tauri/src/commands.rs', import.meta.url), 'utf8');
  assert.doesNotMatch(commands, /list_first_at_startup/);
  // The UI asks before its first screen, so the list is the first thing painted after loading, with no frame between.
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /if \(await api\.takeShowAccounts\(\)\.catch\(\(\) => false\)\) await showChooser\(true\);\s*await refresh\(\);/);
  // Choosing the open profile on that list leaves it for its front screen (unlock) without asking the core again.
  const screen = readFileSync(new URL('../src/screens/Accounts.tsx', import.meta.url), 'utf8');
  assert.match(screen, /row\.current \? onLeave\(\) : void open\(row\.id, \(\) => api\.switchAccount\(row\.id\)\)/);
});

test('the profile list paints with its rows from its first frame, never empty, and the screen before stays meanwhile', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  // Read before it shows: on startup, after a switch that shows it first, and on every way in from a screen.
  assert.match(app, /const list = menu \|\| chooser \|\| showAccounts;\s*const accounts = list \? await api\.listAccounts\(\)\.catch\(\(\) => null\) : undefined;/);
  assert.match(app, /useState<AccountView\[\] \| undefined>\(first\?\.accounts \?\? undefined\)/);
  assert.match(app, /if \(open\) setChooserList\(await readChooserList\(\)\);\s*setChooser\(open\);/);
  assert.match(app, /void showChooser\(true\)\.then\(refresh\);/);
  assert.match(app, /onClick=\{\(\) => void showChooser\(true\)\}/);
  assert.match(app, /onChooser=\{\(open\) => void showChooser\(open\)\}/);
  assert.match(app, /<AccountsScreen onBack=\{\(\) => setChooser\(false\)\} notice=\{notice\} initial=\{chooserList\} \/>/);
  // Nothing else opens it without reading the list first.
  assert.doesNotMatch(app, /setChooser\(true\)|setChooser\(toAccounts\)/);
  // A failed read never blocks: the list screen reads it itself, as before.
  assert.match(app, /return api\.listAccounts\(\)\.catch\(\(\) => undefined\);/);
  const welcome = readFileSync(new URL('../src/screens/Welcome.tsx', import.meta.url), 'utf8');
  assert.match(welcome, /<AccountsScreen onBack=\{\(\) => onChooser\(false\)\} notice=\{notice\} initial=\{chooserAccounts\} \/>/);
  // Back from "Nuevo perfil" the rows are there at once too: the last list read is kept.
  assert.match(welcome, /const \[known, setKnown\] = useState\(initial\);/);
  assert.match(welcome, /initial=\{known\}\s*onList=\{setKnown\}/);
  const screen = readFileSync(new URL('../src/screens/Accounts.tsx', import.meta.url), 'utf8');
  assert.match(screen, /useState<AccountView\[\] \| null>\(initial \?\? null\)/);
});

test('the list: a "+" named "Nuevo perfil" instead of the full width button, and no "Cambiar de perfil" any more', () => {
  const screen = readFileSync(new URL('../src/screens/Accounts.tsx', import.meta.url), 'utf8');
  assert.match(screen, /title=\{s\.newProfile\} aria-label=\{s\.newProfile\} onClick=\{idle\(onNew\)\}>\s*<Icon name="plus"/);
  assert.doesNotMatch(screen, /createOther/);
  // Below the list (after its status line), not next to the title.
  assert.doesNotMatch(screen, /nm-portada__cab/);
  assert.ok(screen.indexOf("<button ref={plus}") > screen.indexOf("</ul>"));
  const welcome = readFileSync(new URL('../src/screens/Welcome.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(welcome, /switchAccount/);
  // Unlock: the back arrow to the list, at the top (before the title), always. The new profile's menu: only with others.
  const unlock = welcome.slice(welcome.indexOf('function Unlock'), welcome.indexOf('function ShowPhrase'));
  assert.match(unlock, /<Back onBack=\{onAccounts\} disabled=\{busy\} label=\{t\(\)\.onboarding\.accounts\.backToAccounts\} \/>\s*<h1/);
  const menu = welcome.slice(welcome.indexOf('function Menu'), welcome.indexOf("type Mode = "));
  assert.match(menu, /\{hasOtherAccounts\(accounts\) && <Back onBack=\{onAccounts\} disabled=\{false\} label=\{t\(\)\.onboarding\.accounts\.backToAccounts\} \/>\}\s*<h1/);
  assert.doesNotMatch(menu, /button-ghost-weak nm-btn w-full/);
});

test('back from "Nuevo perfil" focus returns to the "+", and the new profile menu waits for the list before painting', () => {
  const screen = readFileSync(new URL('../src/screens/Accounts.tsx', import.meta.url), 'utf8');
  assert.match(screen, /if \(focusNew\) plus\.current\?\.focus\(\);/);
  assert.match(screen, /<button ref=\{plus\} type="button" className=\{PLUS\}/);
  const welcome = readFileSync(new URL('../src/screens/Welcome.tsx', import.meta.url), 'utf8');
  assert.match(welcome, /focusNew=\{returned\}/);
  const menu = welcome.slice(welcome.indexOf('function Menu'), welcome.indexOf("type Mode = "));
  assert.match(menu, /if \(accounts === undefined\) return <Portada paso="menu-espera">\{null\}<\/Portada>;/);
});

test('"Elige un perfil" is the base screen: no back arrow, the open profile row and the "+" lead on', () => {
  const screen = readFileSync(new URL('../src/screens/Accounts.tsx', import.meta.url), 'utf8');
  const chooser = screen.slice(screen.indexOf('export function AccountChooser'));
  assert.doesNotMatch(chooser, /<Back /);
  // Ways forward: the open profile's row (to its front screen), another row (open it), the "+" and, with none left
  // after deleting, the front screen.
  assert.match(chooser, /row\.current \? onLeave\(\) : void open\(row\.id, \(\) => api\.switchAccount\(row\.id\)\)/);
  assert.match(chooser, /if \(accounts\.length === 0\) \{\s*onLeave\(\);/);
  assert.match(chooser, /onClick=\{idle\(onNew\)\}/);
  // "Nuevo perfil" keeps its arrow back to the list.
  const fresh = screen.slice(screen.indexOf('export function NewProfile'), screen.indexOf('export function AccountChooser'));
  assert.match(fresh, /<Back onBack=\{idle\(onBack\)\} \/>/);
  // The "+" is compact and centred under the list, not full width: as tall as the large buttons and wider than square.
  assert.match(screen, /const PLUS = 'button button-medium button-outline-weak nm-btn button-for-icon nm-cuentas__nuevo';/);
  const css = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.button\.nm-cuentas__nuevo \{ justify-self: center; --padding-block: 0\.8125rem; --padding-inline: 2rem; \}/);
});

test('"Elige un perfil": the profile entered last says "Usado recientemente" in the plain muted tag, not in green', () => {
  const screen = readFileSync(new URL('../src/screens/Accounts.tsx', import.meta.url), 'utf8');
  // The last one entered (`recent`), not the one merely chosen and open (`current`).
  assert.match(screen, /\{row\.recent && <Tag>\{s\.recentlyUsed\}<\/Tag>\}/);
  assert.doesNotMatch(screen, /row\.current && <Tag/);
  assert.doesNotMatch(screen, /row\.recent && <Tag tone=/);
  assert.equal(DICTIONARIES.es.onboarding.accounts.recentlyUsed, 'Usado recientemente');
  assert.equal(DICTIONARIES.en.onboarding.accounts.recentlyUsed, 'Recently used');
  // The plain tag is the muted secondary text tone.
  const css = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.nm-tag \{[^}]*color: var\(--text-weak\);/);
});

test('"Elige un perfil": if the list cannot be read, "Reintentar" reads it again (no back arrow there either)', () => {
  const screen = readFileSync(new URL('../src/screens/Accounts.tsx', import.meta.url), 'utf8');
  const chooser = screen.slice(screen.indexOf('export function AccountChooser'));
  assert.match(chooser, /\(\) => !cancelled && setLoadFailed\(true\)/);
  assert.match(chooser, /\}, \[reload, setList\]\);/);
  assert.match(chooser, /setLoadFailed\(false\);\s*setReload\(\(n\) => n \+ 1\);/);
  assert.match(chooser, /\{s\.retry\}\s*<\/button>\s*\}\s*>\s*<p>\{s\.loadFailed\}<\/p>/);
  // After deleting, a failed re-read is the same failure.
  assert.match(chooser, /setDeleted\(name\);\s*\} catch \{\s*setLoadFailed\(true\);/);
  assert.doesNotMatch(chooser, /<Back /);
  assert.equal(DICTIONARIES.es.onboarding.accounts.retry, 'Reintentar');
  assert.equal(DICTIONARIES.en.onboarding.accounts.retry, 'Try again');
  assert.equal(DICTIONARIES.es.onboarding.accounts.loadFailed, 'No se ha podido leer la lista de perfiles.');
  assert.equal(DICTIONARIES.en.onboarding.accounts.loadFailed, "Couldn't read the list of profiles.");
});
