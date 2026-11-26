// Rotating slogans on the front screen: under the logo, while the front screen is shown, they change every
// `SLOGAN_EVERY_MS` with a soft fade (the fade is in app.css). It always starts with the first and continues in order.
// An exception to "no motion for now": they pass by while the person stays on the screen. As with the front screen's
// night (app.css), "reduce motion" is not consulted: Windows/WSLg may enable it by default and then they would never rotate.
// With the window still (`data-quieto`, from `stillness.ts`: hidden or unfocused) the clock stops and nothing is
// painted; on return, it continues with a new one after a whole interval.
// Only numbers live here (which slogan is due): the text is taken when painting from `t().slogans.list`, in the
// language of that moment.
import { STILL_ATTR } from './stillness.ts';

/** How often the slogan changes (about 5-6 s). */
export const SLOGAN_EVERY_MS = 5500;

/** The next one, and after the last one back to the first. */
export function nextSlogan(index: number, count: number): number {
  return count <= 0 ? 0 : (index + 1) % count;
}

/** The clock that is needed (to test without a browser or waiting). */
export interface SloganClock {
  /** Calls `fn` after `ms`; returns how to cancel it. */
  after(fn: () => void, ms: number): () => void;
  /** Whether the window is still (hidden or unfocused). */
  still(): boolean;
  /** Calls `fn` when the window stops being still; returns how to stop waiting. */
  onWake(fn: () => void): () => void;
}

/**
 * Rotates the slogans from `start`: every `SLOGAN_EVERY_MS` it moves to the next and calls `show` with its number. If
 * the window is still when the time comes, it does not change and stops counting until it returns (then, another whole
 * interval). With fewer than two slogans there is nothing to rotate. Returns how to stop it.
 */
export function rotateSlogans(start: number, count: number, clock: SloganClock, show: (index: number) => void): () => void {
  if (count < 2) return () => {};
  let index = start;
  let cancel: () => void = () => {};
  const wait = () => {
    cancel = clock.after(tick, SLOGAN_EVERY_MS);
  };
  const tick = () => {
    if (clock.still()) {
      const stop = clock.onWake(() => {
        stop();
        wait();
      });
      cancel = stop;
      return;
    }
    index = nextSlogan(index, count);
    show(index);
    wait();
  };
  wait();
  return () => cancel();
}

/** Which slogan is showing now, so it does not start over each time the front screen changes step (each step mounts
 *  its own front screen). On each start it begins with the first. */
export interface SloganMemory {
  /** The first (always 0): the one read by the screen reader, always the same. */
  first(): number;
  /** The one showing now (at the start, the first). */
  current(count: number): number;
  /** Records the one just shown. */
  remember(index: number): void;
}

export function createSloganMemory(): SloganMemory {
  let current = 0;
  return {
    first: () => 0,
    current: (count) => (current >= count ? 0 : current),
    remember(index) {
      current = index;
    },
  };
}

/** This start's memory. */
export const sloganMemory = createSloganMemory();

/** The real clock: `setTimeout` and the stillness of `<html data-quieto>` (the same as for the lights and the
 *  status checks). */
export function domSloganClock(): SloganClock {
  const root = document.documentElement;
  const still = () => root.hasAttribute(STILL_ATTR);
  return {
    after(fn, ms) {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
    still,
    onWake(fn) {
      const observer = new MutationObserver(() => {
        if (!still()) fn();
      });
      observer.observe(root, { attributes: true, attributeFilter: [STILL_ATTR] });
      return () => observer.disconnect();
    },
  };
}
