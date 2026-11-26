// Another profile opened in this same window (`switch_account`, `new_account`, or `delete_account` on the open
// one): the core already closed the previous profile and opened the next one without restarting the app. The UI then
// starts again from scratch, as on startup (`App.tsx` mounts its screens anew), so no screen state of the previous
// profile survives.
import { createContext, useContext, useEffect, useState } from 'react';

/** A new object each time another profile opens in this window, given by the root (`null` on startup, where the first
 *  screen keeps its fade). The first front screen box mounted with it appears at once, without its entry fade, so a
 *  switch shows no transition. */
export const QuietEntry = createContext<object | null>(null);

/** The switches whose first box has already mounted (marked in an effect, so a double render in development reads the
 *  same answer twice). */
const entered = new WeakSet<object>();

/** For the front screen box (`Portada`): whether the box for `step` skips its entry fade. Only the box mounted first
 *  after a switch, and only while it shows that same step: a later step, or coming back to it, fades in as usual. */
export function useQuietEntry(step: string | undefined): boolean {
  const token = useContext(QuietEntry);
  const [quiet, setQuiet] = useState(() => (token !== null && !entered.has(token) ? { step } : null));
  useEffect(() => {
    if (token !== null) entered.add(token);
  }, [token]);
  // Another step: from here on, every box fades in as usual.
  if (quiet !== null && quiet.step !== step) setQuiet(null);
  return quiet !== null && quiet.step === step;
}

/** `error`: why deleting the open profile failed after closing it (it opened again), to show on the new screens. */
type Listener = (error: unknown) => void;

let listener: Listener | null = null;

/** The root listens here (one at a time). Returns how to stop listening. */
export function onProfileOpened(f: Listener): () => void {
  listener = f;
  return () => {
    if (listener === f) listener = null;
  };
}

/** Called once the core answers that a profile is open now in place of the previous one. */
export function profileOpened(error: unknown = null): void {
  listener?.(error);
}
