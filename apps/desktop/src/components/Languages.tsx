// The language selector for screens without Settings: the front screen (before unlocking) and the startup error
// screen. It stores into `prefs` (like Settings): the root (`App`, with `useLocale()`) repaints everything in the new language.
import { t } from '../i18n/index.ts';
import { LOCALES, useLocale } from '../i18n/locale.ts';
import { prefs } from '../prefs.ts';

/** One button per language, each name written in its own language (with its `lang`, so the screen reader pronounces it
 *  properly) and the current one marked with `aria-pressed`. It switches instantly, without losing what was typed (nothing is remounted).
 *  It sits in the top corner of its container (which must be positioned) and after the main content in the DOM: Tab
 *  reaches the screen's own content first. */
export function Languages() {
  const locale = useLocale();
  const names = t().settings.languageNames;
  return (
    <div className="nm-portada__idiomas" role="group" aria-label={t().settings.language.legend}>
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          className="button button-small button-ghost-weak nm-btn nm-portada__idioma"
          aria-pressed={l === locale}
          onClick={() => prefs.setLocale(l)}
        >
          {names[l]}
        </button>
      ))}
    </div>
  );
}
