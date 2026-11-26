// What the "Estado del servicio" line of the sidebar (`screens/ServiceStatus.tsx`) and the mail notice of the list
// (`screens/MailDownNotice.tsx`) share: checking everything at once and the switch from grey to red after
// `ANSWER_LIMIT_MS`. The pure rules are in `sidebar.ts`; here only the real clock and the React hooks.
import { useEffect, useState } from 'react';
import { health, serverHealth, useServerHealth } from './health.ts';
import { ANSWER_LIMIT_MS, holdDown, overdue, serverLine, waitReason, watchOverdue, type OverdueEnv, type StatusLineView, type WaitReason } from './sidebar.ts';
import { STILL_ATTR } from './stillness.ts';

/** Checks Midnight and the server at once ("Comprobar conexión" and "Reintentar" of the mail notice). */
export const checkAll = () => Promise.all([health.check(), serverHealth.check()]);

/** When opening the status panel, no new check is made if the last one finished less than this ago. */
export const OPEN_CHECK_AFTER_MS = 5_000;

/** On opening the status panel: checks both parts right away instead of waiting for the next 30 s one,
 *  unless one is already running (it waits for that) or one just finished (`OPEN_CHECK_AFTER_MS`). With the app
 *  locked it checks nothing (`refresh` in `health.ts`). */
export const checkAllOnOpen = () => Promise.all([health.refresh(OPEN_CHECK_AFTER_MS), serverHealth.refresh(OPEN_CHECK_AFTER_MS)]);

/** The line, red if it has spent `ANSWER_LIMIT_MS` in a row waiting for an answer that does not come (grey at first), and
 *  red too if it already was and is now waiting (`holdDown`). */
export function useOverdue(line: StatusLineView): StatusLineView {
  // The deadline belongs to each wait reason: going from "the core says nothing" to "checking..." starts from zero.
  // The reason that expired is stored: with another reason there is no red even for an instant, even if the
  // notice that clears it arrives a render late. When the wait ends it is cleared, so the same reason, if it returns, counts from zero.
  const reason = waitReason(line);
  const [expiredFor, setExpiredFor] = useState<WaitReason | null>(null);
  useEffect(() => {
    if (reason === null) return;
    const stop = watchOverdue(OVERDUE_ENV, ANSWER_LIMIT_MS, () => setExpiredFor(reason));
    return () => {
      stop();
      setExpiredFor(null);
    };
  }, [reason]);
  // The last line shown: a red does not go back to grey because the check then fails. It is stored during
  // render (React's pattern for what depends on the previous render), only on change, so there is no
  // one-instant grey between the two.
  const [last, setLast] = useState<StatusLineView | null>(null);
  const shown = holdDown(last, overdue(line, reason !== null && expiredFor === reason));
  if (last?.tone !== shown.tone || last.text !== shown.text) setLast(shown);
  return shown;
}

/** The NightMail server line as the sidebar paints it: grey at first and red if it does not answer within
 *  `ANSWER_LIMIT_MS`. Computed once, in `Main`, which passes it to the sidebar and to the list's mail notice
 *  (`MailDownNotice`): both turn red and return together. */
export function useServerLine(): StatusLineView {
  return useOverdue(serverLine(useServerHealth()));
}

/** The real clock: stillness is `<html data-quieto>` (`stillness.ts`), the same as for the checks. */
const OVERDUE_ENV: OverdueEnv = {
  after: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
  // Monotonic clock: if the system clock jumps, the time spent paused is not thrown off.
  now: () => performance.now(),
  still: () => document.documentElement.hasAttribute(STILL_ATTR),
  onStill: (fn) => {
    const observer = new MutationObserver(fn);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: [STILL_ATTR] });
    return () => observer.disconnect();
  },
};
