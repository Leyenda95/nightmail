// Stillness: with the window hidden or unfocused, endless animations (the lights that beat in the sidebar and the
// front screen's night) stop. Without a GPU (WebKitGTK on WSLg) every frame is painted on the CPU: five 8 px lights
// beating cost almost a whole core with the window open and forgotten behind another.
// Here only two marks on <html> are set or removed; what stops with each is stated in app.css:
// - `data-quieto`: hidden OR unfocused. For decorative things and the slogans' clock (and other clocks in the app).
// - `data-oculta`: ONLY hidden (minimised, on another desktop). For the three wait indicators
//   (`.nm-luz--trabaja`, `.nm-fila__gira` of "Actualizar" and `.nm-espera__gira` of the wait icon). With the window
//   visible but unfocused they keep spinning, so it is visible that work is going on.
// The lights and the front screen are still by default (without `<html data-movimiento>`, see app.css). `data-quieto`
// is kept so that motion can be turned back on without further changes.
//
// It starts in motion and only stops on an event (`blur` or `visibilitychange`): if one never arrived, the window
// stays as it was before (moving), never stopped without reason.

/** Should it stop? Hidden (minimised, on another desktop) or unfocused (another window in front). */
export function shouldBeStill(visibility: DocumentVisibilityState, focused: boolean): boolean {
  return visibility === 'hidden' || !focused;
}

/** The minimum of `window` that is needed (to test without a browser). */
export interface StillnessWindow {
  addEventListener(type: 'focus' | 'blur', listener: () => void): void;
  removeEventListener(type: 'focus' | 'blur', listener: () => void): void;
}

/** The minimum of `document`. */
export interface StillnessDocument {
  readonly visibilityState: DocumentVisibilityState;
  /** Still `true` if focus moved into the reader's iframe (that `blur` does not count). */
  hasFocus(): boolean;
  readonly documentElement: { toggleAttribute(name: string, force: boolean): boolean };
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export const STILL_ATTR = 'data-quieto';
/** Only hidden (focus does not count): what pauses the wait indicators. */
export const HIDDEN_ATTR = 'data-oculta';

/** Watches focus and visibility and sets `<html data-quieto>` and `<html data-oculta>`. Returns how to stop watching. */
export function watchStillness(
  win: StillnessWindow = window,
  doc: StillnessDocument = document,
  pollMs = 1000,
): () => void {
  let focused = true;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  const apply = () => {
    doc.documentElement.toggleAttribute(STILL_ATTR, shouldBeStill(doc.visibilityState, focused));
    doc.documentElement.toggleAttribute(HIDDEN_ATTR, doc.visibilityState === 'hidden');
  };
  const stopPoll = () => {
    clearInterval(poll);
    poll = undefined;
  };
  const onFocus = () => {
    clearTimeout(pending);
    stopPoll();
    focused = true;
    apply();
  };
  // The `blur` also arrives when focus enters the message iframe: right after, it is checked whether the document
  // still has focus (then it did not leave the window). If the iframe has it, when the window loses it this document
  // gets no `blur` (the isolated iframe's does): it is polled every `pollMs` while focus stays in the iframe, and
  // polling stops with the returning `focus` or on detecting that it left.
  const onBlur = () => {
    clearTimeout(pending);
    stopPoll();
    pending = setTimeout(() => {
      focused = doc.hasFocus();
      apply();
      if (focused) {
        poll = setInterval(() => {
          if (doc.hasFocus()) return;
          stopPoll();
          focused = false;
          apply();
        }, pollMs);
      }
    }, 0);
  };
  win.addEventListener('focus', onFocus);
  win.addEventListener('blur', onBlur);
  doc.addEventListener('visibilitychange', apply);
  apply();
  return () => {
    clearTimeout(pending);
    stopPoll();
    win.removeEventListener('focus', onFocus);
    win.removeEventListener('blur', onBlur);
    doc.removeEventListener('visibilitychange', apply);
    doc.documentElement.toggleAttribute(STILL_ATTR, false);
    doc.documentElement.toggleAttribute(HIDDEN_ATTR, false);
  };
}
