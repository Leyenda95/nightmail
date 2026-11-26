// NightMail logo: the horizontal lockup (symbol + name) and the bare symbol.
// Each has a version for light backgrounds and another for dark ones, and they are separate files: the choice is made here,
// in JS, with the theme actually in view (Settings' or, with "system", the machine's). A `<picture>` with
// `media="(prefers-color-scheme: dark)"` would only look at the machine and fail with a forced theme.
import lockupLight from '../../../../design/brand/logo-lockup-horizontal.svg';
import lockupDark from '../../../../design/brand/logo-lockup-horizontal-dark.svg';
import symbolLight from '../../../../design/brand/logo-symbol.svg';
import symbolDark from '../../../../design/brand/logo-symbol-dark.svg';
import { useEffectiveTheme } from '../prefs.ts';

// Lockup proportion (196.92 x 48) and minimum on-screen sizes.
const RATIO = 196.92 / 48;
const MIN_HEIGHT = 20;
const MIN_SYMBOL = 16;

/** Does the dark-background version apply? Yes with the dark theme in view, or always if forced. */
function useDarkVersion(forced: boolean): boolean {
  const theme = useEffectiveTheme();
  return forced || theme === 'dark';
}

/** `dark` forces the dark-background version, whatever the theme: for what is always night, like the front screen's
 *  panel. Without it, it follows the theme. */
export function Logo({ height = 28, dark = false }: { height?: number; dark?: boolean }) {
  const h = Math.max(height, MIN_HEIGHT);
  const src = useDarkVersion(dark) ? lockupDark : lockupLight;
  return <img src={src} alt="NightMail" height={h} width={Math.round(h * RATIO)} className="block" />;
}

/** The bare symbol, decorative (`alt=""`): it accompanies a text that already says what it is. `dark`, as in `Logo`. */
export function LogoSymbol({ size = 48, dark = false }: { size?: number; dark?: boolean }) {
  const s = Math.max(size, MIN_SYMBOL);
  const src = useDarkVersion(dark) ? symbolDark : symbolLight;
  return <img src={src} alt="" width={s} height={s} className="block" />;
}
