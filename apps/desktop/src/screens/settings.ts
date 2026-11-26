// The options of the Settings page: text and drawing of each. Kept apart from `Settings.tsx` so it can be tested with
// `node --test` that no option of `prefs.ts` is missing (oxlint: `only-export-components`).
// They are functions and not constants: texts come from the language of that moment (no `t()` at load).
import { formatPercent } from '../format.ts';
import { t } from '../i18n/index.ts';
import {
  FIXED_SIZES,
  LOCALES,
  SIZES,
  type BadgeCount,
  type FixedSize,
  type Layout,
  type Locale,
  type Size,
  type Sound,
  type Theme,
} from '../prefs.ts';

export interface Choice<T extends string> {
  value: T;
  title: string;
  /** Without text, the option carries only the title (the languages). */
  text?: string;
  /** Language of the title if it is not the interface's (each language is written in its own), for the screen reader. */
  lang?: Locale;
  /** Class of the drawing that accompanies the option (`nm-esquema ...`, `nm-muestra ...` or `nm-letra`). Without a drawing, only
   *  the text (the sound). */
  art?: string;
  /** Boxes of the drawing: one per panel (the theme sample always has 2; the size and language ones, none). */
  boxes: 3 | 2 | 0;
  /** Letters of the `nm-letra` drawing: "Aa" for sizes, "En"/"Es" for languages. */
  glyph?: string;
  /** Sizes only: the "Aa" sample, at this scale of the default. */
  scale?: number;
}

/** The letters of each language's drawing (not translatable text: it is the language code). */
const LANGUAGE_GLYPHS: Record<Locale, string> = { en: 'En', es: 'Es' };

/** One language for each of `LOCALES`, with its name written in that language (whatever the interface's). */
export function languageChoices(): readonly Choice<Locale>[] {
  const names = t().settings.languageNames;
  return LOCALES.map((locale) => ({
    value: locale,
    title: names[locale],
    lang: locale,
    art: 'nm-letra',
    boxes: 0,
    glyph: LANGUAGE_GLYPHS[locale],
  }));
}

export function layoutChoices(): readonly Choice<Layout>[] {
  const s = t().settings.layout;
  return [
    { value: 'tres', ...s.three, art: 'nm-esquema nm-esquema--tres', boxes: 3 },
    { value: 'dos', ...s.two, art: 'nm-esquema nm-esquema--dos', boxes: 2 },
  ];
}

export function themeChoices(): readonly Choice<Theme>[] {
  const s = t().settings.theme;
  return [
    { value: 'sistema', ...s.system, art: 'nm-muestra nm-muestra--sistema', boxes: 2 },
    { value: 'claro', ...s.light, art: 'nm-muestra nm-muestra--claro', boxes: 2 },
    { value: 'oscuro', ...s.dark, art: 'nm-muestra nm-muestra--oscuro', boxes: 2 },
  ];
}

/** One option per size of `SIZES`: changing the list there is enough. "Automático" says how much it is now (`applied`)
 *  and its "Aa" goes at that scale. */
export function sizeChoices(applied: FixedSize): readonly Choice<Size>[] {
  const s = t().settings.size;
  const normal = Number(FIXED_SIZES[0]);
  return SIZES.map((size) => {
    const percent = Number(size === 'auto' ? applied : size);
    let text = s.larger(formatPercent(percent - normal));
    if (size === 'auto') text = s.automaticText;
    else if (percent === normal) text = s.standard;
    return {
      value: size,
      title: size === 'auto' ? s.automatic(formatPercent(percent)) : formatPercent(percent),
      text,
      art: 'nm-letra',
      boxes: 0,
      glyph: 'Aa',
      scale: percent / normal,
    };
  });
}

/** Sound on new mail: on or off, no drawing. */
export function soundChoices(): readonly Choice<Sound>[] {
  const s = t().settings.sound;
  return [
    { value: 'on', ...s.on, boxes: 0 },
    { value: 'off', ...s.off, boxes: 0 },
  ];
}

/** The unread count on the taskbar icon: on or off, no drawing (like the sound). */
export function badgeCountChoices(): readonly Choice<BadgeCount>[] {
  const s = t().settings.badgeCount;
  return [
    { value: 'on', ...s.on, boxes: 0 },
    { value: 'off', ...s.off, boxes: 0 },
  ];
}
