// Interface language. The preference lives in `prefs.ts` (key `nm.idioma`, English by default); here it is only read, and
// the language-dependent pieces that are not texts go here: the BCP-47 tag and plurals.
import { useSyncExternalStore } from 'react';
import { LOCALES, prefs, type Locale } from '../prefs.ts';

export { LOCALES, type Locale };

/** BCP-47 tag of each language, for `Intl` (dates, plurals). US English: hours are 24 h, which the
 *  options of each formatter say, not the tag. */
export const LOCALE_TAGS: Record<Locale, string> = { en: 'en-US', es: 'es-ES' };

/** The current language. Read on every call: never keep it in a module constant. */
export function currentLocale(): Locale {
  return prefs.get().locale;
}

/** The BCP-47 tag of a language (by default, the current one). */
export function localeTag(locale: Locale = currentLocale()): string {
  return LOCALE_TAGS[locale];
}

/** The language, up to date: whoever uses it repaints when it changes. */
export function useLocale(): Locale {
  return useSyncExternalStore(prefs.subscribe, currentLocale);
}

/** The forms of a plural: `other` always; the other CLDR categories as needed (in English and Spanish
 *  `one` is enough). */
export type PluralForms = { other: string } & Partial<Record<Intl.LDMLPluralRule, string>>;

const pluralRules = new Map<Locale, Intl.PluralRules>();

/** The form that applies to `n` under the language's rules, or `other` if that form is missing.
 *  Inside `src/i18n/<language>/` the file's own language is always passed (`plural(n, forms, 'es')`): so a
 *  dictionary does not depend on the preference of the moment. */
export function plural(n: number, forms: PluralForms, locale: Locale = currentLocale()): string {
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(LOCALE_TAGS[locale]);
    pluralRules.set(locale, rules);
  }
  return forms[rules.select(n)] ?? forms.other;
}
