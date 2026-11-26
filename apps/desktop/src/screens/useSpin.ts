// A refresh icon that turns from the press (or from when `busy` starts) until the work ends, with the minimum and the
// whole turns of `spin.ts`. While `spinning` the icon carries the sidebar's turning class (`nm-fila__gira`). Each
// caller decides whether it also keeps moving under reduced motion (only real waits do).
import { useCallback, useEffect, useRef, useState } from 'react';
import { spinStopDelay } from '../spin.ts';

export function useSpin(busy = false): { spinning: boolean; kick: () => void } {
  const [spinning, setSpinning] = useState(false);
  // Mirror of `spinning` for `kick` (no side effects inside a state updater), and when the turn in course started.
  const on = useRef(false);
  const started = useRef(0);

  const kick = useCallback(() => {
    if (on.current) return;
    on.current = true;
    started.current = Date.now();
    setSpinning(true);
  }, []);

  // Work started by someone else (the sidebar's button) also turns this icon.
  useEffect(() => {
    if (busy) kick();
  }, [busy, kick]);

  // Once the work is over, it stops at the end of the turn in course.
  useEffect(() => {
    if (!spinning || busy) return;
    const timer = window.setTimeout(
      () => {
        on.current = false;
        setSpinning(false);
      },
      spinStopDelay(Date.now() - started.current),
    );
    return () => window.clearTimeout(timer);
  }, [spinning, busy]);

  return { spinning, kick };
}
