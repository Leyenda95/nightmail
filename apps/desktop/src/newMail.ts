// New mail while the inbox is not being looked at: an in-app notice and a short sound. No system notifications.
// The pure rules come first; at the end, the only part that depends on React.
//
// What counts as new is decided by the core, per address (`SyncView.fresh`, `mail/sync.rs`): what arrives at an
// address that was already up to date in this session. Backlog (on unlock, from a restored or newly created
// address) does not notify, even if another address fails. Archiving, deleting or reading do not go through here.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { SyncView } from './bindings/SyncView.ts';
import { chime } from './chime.ts';
import { STILL_ATTR } from './stillness.ts';

/** `arrived`: the new messages that arrived in the session (it only grows). After a round, it adds its own. */
export const afterSync = (arrived: number, report: SyncView): number => arrived + report.fresh;

/** The notice. `seen`: what of `arrived` is already counted. `count`: the messages it states (0, not shown). `chimes`: how many
 *  times it was due to sound (rises with each notified arrival). `held`: the pointer or focus is on it and it does not hide itself. */
export interface MailNotice {
  seen: number;
  count: number;
  chimes: number;
  held: boolean;
}

/** The notice when the main view mounts: what arrived earlier is not announced. */
export const noticeStart = (arrived: number): MailNotice => ({ seen: arrived, count: 0, chimes: 0, held: false });

const hidden = (notice: MailNotice, seen: number): MailNotice => ({ ...notice, seen, count: 0, held: false });

/** With `arrived` up to date: in the inbox there is no notice (and what arrived is already visible). Elsewhere, what arrives
 *  is added to any notice there was and it sounds. Returns the same object if nothing changes. */
export function nextNotice(notice: MailNotice, arrived: number, inInbox: boolean): MailNotice {
  if (inInbox) return notice.count === 0 && notice.seen === arrived ? notice : hidden(notice, arrived);
  const fresh = arrived - notice.seen;
  if (fresh === 0) return notice;
  if (fresh < 0) return { ...notice, seen: arrived };
  return { ...notice, seen: arrived, count: notice.count + fresh, chimes: notice.chimes + 1 };
}

/** Is the person looking at the Inbox? Only if it is the open view AND the window is visible and focused. With the window
 *  minimised, hidden or behind another ("still", `stillness.ts`) the Inbox is not being watched: the notice and sound fire. */
export const watchingInbox = (inInbox: boolean, still: boolean): boolean => inInbox && !still;

/** Dismisses the notice (button or timeout). Whatever arrives afterwards opens a new one. */
export function dismissNotice(notice: MailNotice): MailNotice {
  return notice.count === 0 ? notice : hidden(notice, notice.seen);
}

export function holdNotice(notice: MailNotice, held: boolean): MailNotice {
  return notice.count === 0 || notice.held === held ? notice : { ...notice, held };
}

/** How long the notice takes to hide itself, from the last arrival (if the pointer or focus is not on it). */
export const AUTO_HIDE_MS = 8000;

// --- React

/** Is the window still (`<html data-quieto>`, from `stillness.ts`)? It follows the attribute, without repeating the watching. */
const readStill = () => document.documentElement.hasAttribute(STILL_ATTR);
const subscribeStill = (onChange: () => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: [STILL_ATTR] });
  return () => observer.disconnect();
};
const useWindowStill = (): boolean => useSyncExternalStore(subscribeStill, readStill);

/** The new-mail notice, up to date with `arrived` and the view. It sounds on each notified arrival (if the sound is
 *  on in Settings) and hides itself after `AUTO_HIDE_MS`. */
export function useMailNotice(arrived: number, inInboxView: boolean) {
  const inInbox = watchingInbox(inInboxView, useWindowStill());
  const [notice, setNotice] = useState(() => noticeStart(arrived));
  // State that follows its data: adjusted while rendering (no effect that renders twice).
  const next = nextNotice(notice, arrived, inInbox);
  if (next !== notice) setNotice(next);
  const { count, chimes, held } = next;
  const shown = count > 0;
  useEffect(() => {
    if (chimes > 0) void chime.play();
  }, [chimes]);
  useEffect(() => {
    if (!shown || held) return;
    const timer = setTimeout(() => setNotice(dismissNotice), AUTO_HIDE_MS);
    return () => clearTimeout(timer);
  }, [shown, held, chimes]);
  // The first click or key of the session readies the sound (some engines do not play without a prior gesture).
  useEffect(() => {
    const prime = () => {
      document.removeEventListener('pointerdown', prime);
      document.removeEventListener('keydown', prime);
      void chime.prime();
    };
    document.addEventListener('pointerdown', prime);
    document.addEventListener('keydown', prime);
    return () => {
      document.removeEventListener('pointerdown', prime);
      document.removeEventListener('keydown', prime);
    };
  }, []);
  const dismiss = useCallback(() => setNotice(dismissNotice), [setNotice]);
  const hold = useCallback((on: boolean) => setNotice((n) => holdNotice(n, on)), [setNotice]);
  return { count, dismiss, hold };
}
