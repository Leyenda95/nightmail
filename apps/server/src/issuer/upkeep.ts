// Issuer upkeep: purges issued requests after a few days (on startup and every 24 h) and warns the operator
// every few minutes if pending requests pile up or receipts are past their insert-by deadline (a signed
// promise being broken). Only counts are logged.
import { errorKind, type Logger } from '../log.ts';
import type { IssuerStore } from './store.ts';

const DAY_MS = 86_400_000;
export const KEEP_ISSUED_MS = 7 * DAY_MS;
const PURGE_EVERY_MS = DAY_MS;
const CHECK_EVERY_MS = 10 * 60_000;

export type UpkeepDeps = {
  store: Pick<IssuerStore, 'countPending' | 'countOverdue' | 'purgeIssued'>;
  log: Logger;
  /** Warn when pending requests exceed this. */
  warnPending: number;
  /** Time in milliseconds. */
  now?: () => number;
};

export function startUpkeep({ store, log, warnPending, now = Date.now }: UpkeepDeps): { stop(): void } {
  const guarded = (work: () => void) => () => {
    try {
      work();
    } catch (error) {
      log.warn(`issuer: upkeep failed (${errorKind(error)})`);
    }
  };
  const purge = guarded(() => {
    const purged = store.purgeIssued(now() - KEEP_ISSUED_MS);
    if (purged > 0) log.info(`issuer: purged ${purged} issued requests older than 7 days`);
  });
  const check = guarded(() => {
    const pending = store.countPending();
    const overdue = store.countOverdue(Math.floor(now() / 1000));
    if (pending > warnPending) log.warn(`issuer: ${pending} pending requests (the payer is not keeping up)`);
    if (overdue > 0) log.warn(`issuer: ${overdue} receipt(s) past their insert-by time are still pending`);
  });
  purge();
  const timers = [setInterval(purge, PURGE_EVERY_MS), setInterval(check, CHECK_EVERY_MS)];
  for (const timer of timers) timer.unref();
  return { stop: () => timers.forEach(clearInterval) };
}
