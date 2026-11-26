// Password rules, the same on creating them (front screen) and on changing them (Settings): not empty and typed twice
// the same. There is no strength meter or minimum length: the core only rejects the empty one (`emptyPassword`). Kept apart
// from the components so it can be tested with `node --test` (oxlint: `only-export-components`).
// Texts come from the language of that moment: `t()` inside each function, never at module load.
import { t } from '../i18n/index.ts';

/** "Las contraseñas no coinciden." */
export const mismatchText = (): string => t().onboarding.password.mismatch;

/** The repetition already typed does not match (warned about while typing). */
export function pairMismatch(one: string, two: string): boolean {
  return two !== '' && one !== two;
}

/** The password and its repetition are valid to send. */
export function pairReady(one: string, two: string): boolean {
  return one !== '' && one === two;
}

export interface ChangeFields {
  current: string;
  next: string;
  repeat: string;
}

export type ChangeField = keyof ChangeFields;

/** What is missing before calling the core, in the field where it is fixed; `null` if it can be sent. */
export function changeProblem({ current, next, repeat }: ChangeFields): { field: ChangeField; message: string } | null {
  const p = t().onboarding.password;
  if (current === '') return { field: 'current', message: p.typeCurrent };
  if (next === '') return { field: 'next', message: p.typeNext };
  if (!pairReady(next, repeat)) return { field: 'repeat', message: repeat === '' ? p.repeatNext : p.mismatch };
  if (next === current) return { field: 'next', message: p.same };
  return null;
}

/** Any core error leaves the file as it was (`keys::change_password`): the password has not changed. */
export const notChangedText = (): string => t().onboarding.password.notChanged;

/** Where a core error goes: the wrong current password, in its field; the empty new one, in its own; anything else,
 *  in a notice that starts by saying it has not changed. `message` is the already translated text (`describeError`). */
export function changeErrorPlace(
  code: string | null,
  message: string,
): { field: Exclude<ChangeField, 'repeat'>; message: string } | { field: null; message: string } {
  if (code === 'wrongPassword') return { field: 'current', message };
  if (code === 'emptyPassword') return { field: 'next', message };
  return { field: null, message: `${notChangedText()} ${message}` };
}
