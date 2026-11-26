// List width with three panels: pure rules of the handle between list and reader. No DOM (from React, only a type),
// so they can be tested with `node --test`. The width is in `rem` (it follows the root font size); the CSS of
// `.nm-paneles` clamps it again so the reader never drops below `READER_MIN_REM`.
import type { CSSProperties } from 'react';

/** Default, minimum and maximum list width, in `rem`. */
export const LIST_WIDTH_DEFAULT = 20.5;
export const LIST_WIDTH_MIN = 17;
export const LIST_WIDTH_MAX = 40;
/** What is always left to the reader (the same as `calc(100% - 24rem)` in `styles/app.css`). */
export const READER_MIN_REM = 24;
/** The CSS variable read by `.nm-paneles` in `styles/app.css`. */
export const LIST_WIDTH_VAR = '--nm-lista-ancho';
/** What each left/right arrow moves. */
export const LIST_WIDTH_STEP = 1;

/** Rounded to 1/16 `rem` (one pixel at 16 px font): the stored value stays short and stable. */
function round(rem: number): number {
  return Math.round(rem * 16) / 16;
}

/** The real maximum for the panel at hand: 40 rem, or less if the reader would drop below 24 rem (never below
 *  the minimum: in a narrow window the CSS rules). Without a valid measurement, the usual maximum. */
export function listWidthMax(panelPx?: number, rootPx?: number): number {
  if (!panelPx || !rootPx || !Number.isFinite(panelPx) || !Number.isFinite(rootPx) || rootPx <= 0) return LIST_WIDTH_MAX;
  return Math.max(LIST_WIDTH_MIN, Math.min(LIST_WIDTH_MAX, round(panelPx / rootPx - READER_MIN_REM)));
}

/** Clamps to [17, max]; anything that is not a finite number is the default. */
export function clampListWidth(rem: number, max: number = LIST_WIDTH_MAX): number {
  if (typeof rem !== 'number' || !Number.isFinite(rem)) return LIST_WIDTH_DEFAULT;
  return round(Math.min(Math.max(rem, LIST_WIDTH_MIN), Math.max(LIST_WIDTH_MIN, max)));
}

/** What is stored can be anything: only a number within [17, 40] is valid; anything else, the default. */
export function parseListWidth(raw: unknown): number {
  if (typeof raw !== 'string' && typeof raw !== 'number') return LIST_WIDTH_DEFAULT;
  if (typeof raw === 'string' && !/^\s*\d+(\.\d+)?\s*$/.test(raw)) return LIST_WIDTH_DEFAULT;
  const rem = Number(raw);
  return Number.isFinite(rem) && rem >= LIST_WIDTH_MIN && rem <= LIST_WIDTH_MAX ? round(rem) : LIST_WIDTH_DEFAULT;
}

/** The width after a key on the handle, or `null` if the key is not its own. Left/right (and down/up) by 1 rem; Home and End
 *  to the extremes. */
export function stepListWidth(rem: number, key: string, max: number = LIST_WIDTH_MAX): number | null {
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      return clampListWidth(rem - LIST_WIDTH_STEP, max);
    case 'ArrowRight':
    case 'ArrowUp':
      return clampListWidth(rem + LIST_WIDTH_STEP, max);
    case 'Home':
      return LIST_WIDTH_MIN;
    case 'End':
      return clampListWidth(LIST_WIDTH_MAX, max);
    default:
      return null;
  }
}

/** The width the mouse asks for: from the list's left edge to the pointer, in `rem`, already clamped. */
export function widthFromPointer(clientX: number, listLeft: number, rootPx: number, max: number = LIST_WIDTH_MAX): number {
  if (!Number.isFinite(rootPx) || rootPx <= 0) return LIST_WIDTH_DEFAULT;
  return clampListWidth((clientX - listLeft) / rootPx, max);
}

/** The `style` prop of `.nm-paneles`: with three panels, the `--nm-lista-ancho` variable read by `styles/app.css`; with
 *  two, nothing (the list fills the whole panel). */
export function listWidthStyle(threePanes: boolean, rem: number): CSSProperties | undefined {
  return threePanes ? ({ [LIST_WIDTH_VAR]: `${clampListWidth(rem)}rem` } as CSSProperties) : undefined;
}
