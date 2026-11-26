// Sets the theme, interface size and language chosen in Settings BEFORE painting: a classic synchronous script, linked in
// the <head> of index.html (nothing inline: the CSP is `script-src 'self'`). It repeats src/prefs.ts's rules by hand,
// and that file rules; test/prefs.test.ts runs this one and checks they do the same. With nothing stored (or if
// storage fails) no theme is set (tokens.css follows the system) and the size is "Automático", from the screen.
// The language is always set: the stored one or, if none, English (the default).
(function () {
  var theme = null;
  var size = null;
  var locale = null;
  try {
    theme = localStorage.getItem('nm.tema');
    size = localStorage.getItem('nm.tamano');
    locale = localStorage.getItem('nm.idioma');
  } catch {
    // No access to storage: the system theme and the default size.
  }
  var root = document.documentElement;
  if (theme === 'claro') root.setAttribute('data-theme', 'light');
  else if (theme === 'oscuro') root.setAttribute('data-theme', 'dark');
  else root.removeAttribute('data-theme');

  // The sizes are those of FIXED_SIZES in prefs.ts. `--setting-font-size` = 14 px times the %, rounded; 14 is the
  // normal one. Anything that is not one of them is "Automático" (autoSize in prefs.ts): with no system scale
  // (devicePixelRatio up to 1.05), by the screen's short side; with scale or no data, 100 %.
  var sizes = ['100', '125', '150', '175', '200'];
  if (size === '115' || size === '130') size = '125'; // sizes that no longer exist (LEGACY_SIZES in prefs.ts)
  if (sizes.indexOf(size) === -1) {
    var dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : NaN;
    var scr = typeof screen === 'object' && screen ? screen : null;
    var short = scr ? Math.min(scr.width, scr.height) : NaN;
    size = '100';
    if (dpr > 0 && dpr <= 1.05) {
      if (short >= 2700) size = '200';
      else if (short >= 2000) size = '175';
      else if (short >= 1400) size = '125';
    }
  }
  var px = Math.round((14 * Number(size)) / 100);
  if (px === 14) root.style.removeProperty('--setting-font-size');
  else root.style.setProperty('--setting-font-size', String(px));

  // The languages are those of LOCALES in prefs.ts. Anything that is not one of them is English.
  root.setAttribute('lang', locale === 'es' ? 'es' : 'en');
})();
