// The accounts on this device, as the "Elige un perfil" list shows them (the screens call them "perfiles"). Pure functions: the screen is
// `screens/Accounts.tsx` and the core keeps the list (`list_accounts`). Nothing personal is shown: no name, no address,
// only "Perfil N", its creation day and which one is open.
// Exception: the name the user wrote for the profile (`AccountView.name`) replaces "Perfil N" (see `profileName`).
import type { AccountView } from './bindings/AccountView.ts';
import { formatDay } from './format.ts';
import { t } from './i18n/index.ts';

/** One row of the list. */
export interface AccountRow {
  id: string;
  /** "Perfil 2". */
  name: string;
  /** "Creado el 18 nov 2026", or `null` if the device does not know the day. */
  created: string | null;
  /** The account this window opened (marked "Usado recientemente"). */
  current: boolean;
}

export function accountRows(list: readonly AccountView[]): AccountRow[] {
  const s = t().onboarding.accounts;
  return list.map((a) => ({
    id: a.id,
    name: profileName(a),
    created: a.createdAt === null ? null : s.created(formatDay(a.createdAt)),
    current: a.current,
  }));
}

/** The name shown for a profile: the one the user wrote, always as written, or else the automatic one with its fixed
 *  number in the language of the moment ("Perfil 4", "Profile 4"). The core keeps that number (`account-number`), so
 *  it does not change when another profile is removed. */
export function profileName(a: Pick<AccountView, 'name' | 'autoNumber'>): string {
  return a.name ?? t().onboarding.accounts.name(a.autoNumber);
}

/** What the name field in Settings shows: what the user typed (`null`: nothing yet) or else the name shown now, so an
 *  untouched automatic name follows the language. Saving it as it is keeps it automatic: the core reads "Perfil N" and
 *  "Profile N" as the automatic name with that number. */
export function profileNameDraft(own: Pick<AccountView, 'name' | 'autoNumber'>, typed: string | null): string {
  return typed ?? profileName(own);
}

/** Whether there is any account to go back to apart from the open one ("Volver a mis perfiles" on the front screen of a
 *  new account). */
export function hasOtherAccounts(list: readonly AccountView[] | null): boolean {
  return list !== null && list.some((a) => !a.current);
}

/** The networks offered on "Nuevo perfil". Only the local one can be chosen for now: the choice is shown but not sent
 *  to the core, which in this build only knows the local network (`AppConfig` in `config.rs`). */
export type Network = 'local' | 'preprod' | 'mainnet';

export interface NetworkChoice {
  value: Network;
  title: string;
  text: string;
  /** `false`: shown disabled, with "Pronto". */
  available: boolean;
}

export function networkChoices(): NetworkChoice[] {
  const s = t().onboarding.accounts.networks;
  return (['local', 'preprod', 'mainnet'] as const).map((value) => ({ value, ...s[value], available: value === 'local' }));
}

/** Longest name, in characters, the same as the core's (`MAX_NAME_CHARS` in `accounts.rs`). */
export const MAX_ACCOUNT_NAME = 40;

/** Characters that show nothing or reorder the text (zero-width ones, direction marks, soft hyphen, BOM), as the core's
 *  `is_invisible`. */
const INVISIBLE = /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;
/** Control characters: they become a space, as in the core. */
const CONTROL = /\p{Cc}/gu;

/** The name as the core will store it (`clean_name` in `accounts.rs`): invisible characters removed, control characters
 *  and runs of spaces made one space, ends trimmed. Empty: the default name. */
export function cleanAccountName(text: string): string {
  return text.replace(INVISIBLE, '').replace(CONTROL, ' ').split(/\s+/u).filter(Boolean).join(' ');
}

/** Accessible name of the trash can in a profile's box ("Eliminar Perfil 2 de este ordenador"). */
export function deleteProfileLabel(name: string): string {
  return t().onboarding.deleteProfile.trashLabel(name);
}

/** Own text for the errors of deleting a profile (`useAction`'s `explain`), or `null`: the general one. A wrong password
 *  goes to the field (`deleteFieldError`). */
export function deleteProfileError(code: string | null): string | null {
  const s = t().onboarding.deleteProfile;
  switch (code) {
    case 'profileInUse':
      return s.inUse;
    case 'sessionBusy':
      return s.sessionBusy;
    case 'notFound':
      return s.notFound;
    default:
      return null;
  }
}

/** The password field's error: empty when sending, or the core said it is wrong. Anything else goes apart. */
export function deleteFieldError(empty: boolean, code: string | null, error: string | null): string | null {
  if (empty) return t().onboarding.deleteProfile.empty;
  return code === 'wrongPassword' ? error : null;
}

/** Whether the name is too long to be accepted (counted in characters, as the core does, not UTF-16 units). */
export function accountNameTooLong(text: string): boolean {
  return [...cleanAccountName(text)].length > MAX_ACCOUNT_NAME;
}
