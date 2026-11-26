// The interface texts in both languages. No library: typed dictionaries.
//
// - `es/<namespace>.ts` is the source of the shape: whatever Spanish has, English must have.
// - `en/<namespace>.ts` ends in `satisfies Messages['<namespace>']`: if a key is missing or extra, or a type
//   changes, `tsc -b` fails. `test/i18n.test.ts` repeats it at run time (arity, empty texts, plurals).
// - A value is a text or, if it carries data, plurals or grammar, a function returning text
//   (`selected: (n: number) => plural(n, { one: '1 selected', other: `${n} selected` }, 'en')`).
// - Use: `t().<namespace>.<key>` INSIDE the function or component, never at module load (the language
//   changes while the app is open).
import { en } from './en/index.ts';
import { es } from './es/index.ts';
import { currentLocale, type Locale } from './locale.ts';

/** The shape of a dictionary: texts are `string` (not the concrete Spanish text) and functions
 *  keep their parameters. */
export type Shape<T> = T extends string
  ? string
  : T extends (...args: infer A) => infer R
    ? (...args: A) => Shape<R>
    : T extends object
      ? { readonly [K in keyof T]: Shape<T[K]> }
      : T;

/** The shape of all the app's texts, taken from Spanish. */
export type Messages = Shape<typeof es>;

export const DICTIONARIES: Record<Locale, Messages> = { en, es };

/** The texts of the current language. */
export function t(): Messages {
  return DICTIONARIES[currentLocale()];
}
