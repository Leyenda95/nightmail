// Event notices hide themselves after a few seconds. The timer stops while the pointer is over the notice or the focus is
// inside it (the person may be reading it or about to press a button) and starts again, in full, when both are gone.
import { useEffect, useRef } from 'react';

/** How long an event notice stays before it hides itself. */
export const NOTICE_HIDE_MS = 5000;

export interface AutoHide {
  /** Pointer over the notice (or gone) / focus inside it (or gone). */
  setPointer: (inside: boolean) => void;
  setFocus: (inside: boolean) => void;
  /** Stops for good (unmount, or the notice was replaced). */
  stop: () => void;
}

/** Starts the countdown. `onHide` runs once, `ms` after the last moment the notice was neither hovered nor focused. */
export function startAutoHide(onHide: () => void, ms: number = NOTICE_HIDE_MS): AutoHide {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pointer = false;
  let focus = false;
  let done = false;
  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const arm = () => {
    clear();
    if (done || pointer || focus) return;
    timer = setTimeout(() => {
      timer = null;
      done = true;
      onHide();
    }, ms);
  };
  arm();
  return {
    setPointer: (inside) => {
      pointer = inside;
      arm();
    },
    setFocus: (inside) => {
      focus = inside;
      arm();
    },
    stop: () => {
      done = true;
      clear();
    },
  };
}

/** For a component: with `onHide`, the countdown runs while mounted (a new `restartKey` restarts it; a new function
 *  identity does not, the latest one is called). Returns the handlers to put on the notice's element. */
export function useAutoHide(onHide: (() => void) | undefined, restartKey?: unknown) {
  const controller = useRef<AutoHide | null>(null);
  const latest = useRef(onHide);
  useEffect(() => {
    latest.current = onHide;
  });
  const enabled = onHide !== undefined;
  useEffect(() => {
    if (!enabled) return undefined;
    const c = startAutoHide(() => latest.current?.());
    controller.current = c;
    return () => {
      c.stop();
      controller.current = null;
    };
  }, [enabled, restartKey]);
  return {
    onPointerEnter: () => controller.current?.setPointer(true),
    onPointerLeave: () => controller.current?.setPointer(false),
    onFocus: () => controller.current?.setFocus(true),
    onBlur: (e: React.FocusEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget)) controller.current?.setFocus(false);
    },
  };
}
