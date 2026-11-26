// Badge on NightMail's taskbar button in Windows: the screen sends the core the unread count of the Inbox when
// it changes, and the padlock when locking (`set_taskbar_badge`, which draws in Rust). This file decides what to
// send and when, without repeating what is already shown.
//
// The number comes from the already loaded Inbox list (`unreadCounts`, the same one as the sidebar counter), which
// holds at most the `MESSAGE_PAGE_MAX` (500) newest messages: unread messages older than those do not count.
// This only shows with more than 500 messages in the Inbox and fewer than 100 unread among the recent ones (with
// 100 or more it already reads "99+"). There is no other counter: the core does not keep a count.
import { useEffect } from 'react';
import { api } from './api.ts';
import { usePrefs } from './prefs.ts';

export interface BadgeState {
  unread: number;
  locked: boolean;
  /** Show the number (Settings, `badgeCount` in `prefs.ts`). Without it nothing is drawn while unlocked; the padlock
   *  still shows on locking. */
  showCount: boolean;
}

/** What the taskbar shows for that state: two states with the same key look the same. */
function look(s: BadgeState): string {
  if (s.locked) return 'candado';
  if (!s.showCount || s.unread <= 0) return 'nada';
  return s.unread >= 100 ? '99+' : String(s.unread);
}

/** A valid integer for the core (`u32`). */
const toU32 = (n: number): number => (Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 0), 0xffff_ffff) : 0);

/** What to send to go from `last` (the last thing sent, `null` at start) to `next`, or `null` if that is already
 *  shown. When needed, `unread` is sanitised to an unsigned integer. */
export function badgeToSend(next: BadgeState, last: BadgeState | null): BadgeState | null {
  const clean = { ...next, unread: toU32(next.unread) };
  return last !== null && look(last) === look(clean) ? null : clean;
}

/** Retries of a send that fails (Windows could not set the image). The number: `times` times, every `everyMs`. The
 *  padlock: unlimited, with a wait that doubles from `everyMs` up to `lockMaxMs`. */
export interface BadgeRetry {
  times: number;
  everyMs: number;
  lockMaxMs: number;
  /** The timer (in tests, one fired by hand). */
  later: (fn: () => void, ms: number) => void;
}

const RETRY: BadgeRetry = { times: 5, everyMs: 2000, lockMaxMs: 30_000, later: (fn, ms) => void setTimeout(fn, ms) };
const LOCK_SHOWN: BadgeState = { unread: 0, locked: true, showCount: true };

/** A sender that remembers what was last sent (what is shown). If the core fails, it keeps remembering it and retries
 *  while it is still the last thing requested. The padlock never gives up (with the app locked no other change
 *  comes, and the previous number must not stay visible); the number is forgotten after `times` retries and the next
 *  change is sent again. If the core answers that it kept the padlock although the number was requested (no session:
 *  a read that finishes after locking), what is shown is the padlock. */
export function createBadgeSender(
  send: (s: BadgeState) => Promise<boolean>,
  retry: BadgeRetry = RETRY,
): (next: BadgeState) => void {
  let last: BadgeState | null = null;
  /** `tries`: the retries already made of `s`. */
  const attempt = (s: BadgeState, tries: number): void => {
    send(s).then(
      (lockShown) => {
        if (last === s && lockShown && !s.locked) last = LOCK_SHOWN;
      },
      () => {
        if (last !== s) return;
        if (!s.locked && tries >= retry.times) {
          last = null;
          return;
        }
        const wait = s.locked ? Math.min(retry.everyMs * 2 ** Math.min(tries, 30), retry.lockMaxMs) : retry.everyMs;
        retry.later(() => {
          if (last === s) attempt(s, tries + 1);
        }, wait);
      },
    );
  };
  return (next) => {
    const s = badgeToSend(next, last);
    if (s === null) return;
    last = s;
    attempt(s, 0);
  };
}

/** The app's own (one for the whole life of the window: it survives locking and unlocking). */
export const pushBadge = createBadgeSender((s) => api.setTaskbarBadge(s.unread, s.locked, s.showCount));

/** With NightMail unlocked: sends the number every time it or the Settings choice changes (also on mount, which
 *  removes the padlock). */
export function useTaskbarBadge(unread: number): void {
  const showCount = usePrefs().badgeCount === 'on';
  useEffect(() => {
    pushBadge({ unread, locked: false, showCount });
  }, [unread, showCount]);
}

/** On locking: the padlock. Even if an Inbox read from before locking later asks for the number, the core with no
 *  session keeps the padlock (`set_taskbar_badge`). */
export const badgeLocked = (): void => pushBadge(LOCK_SHOWN);
