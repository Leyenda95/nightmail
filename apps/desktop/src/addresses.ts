// Pure rules of the "Addresses" page: slots left, the notice when the quota is used up, and the menu
// label "N in progress" or "N stopped". No React, so they can be tested with `node --test`.
import type { PendingSlot } from './bindings/PendingSlot.ts';
import type { PlanView } from './bindings/PlanView.ts';
import type { Quota } from './bindings/Quota.ts';
import type { SlotId } from './bindings/SlotId.ts';
import { t } from './i18n/index.ts';
import { slotKey } from './pending.ts';
import { planKind } from './payment.ts';

/** Free slots of a quota (never negative). */
export function slotsLeft(q: Quota): number {
  return Math.max(0, q.limit - q.used);
}

/**
 * Notice on "New address" when none can be created any more: it explains before failing. `null` if a slot is
 * left or if the plan could not be read (the core then explains the error on the attempt).
 */
export function quotaNotice(plan: PlanView | null): string | null {
  if (plan === null || slotsLeft(plan.mailboxes) > 0 || slotsLeft(plan.aliases) > 0) return null;
  const kind = planKind(plan.bonos);
  if (kind === 'none') return t().status.addresses.noPlan;
  return t().status.addresses.quotaFull(kind === 'paid', plan.mailboxes.limit, plan.aliases.limit);
}

/** Own text of `staleState` (or `null`) for what creates an address: create one, resume or retry a half-done one, or
 *  provide its name. Those already sync again on their own (`sync_for_user_address_op` in the core, and the
 *  "Reintentar" of a row stopped for that reason), so the generic "Vuelve a sincronizar" would point to a button
 *  that is not there. For `useAction`'s `run`. */
export function explainAfterSync(code: string | null): string | null {
  return code === 'staleState' ? t().screensPlan.staleAfterSync : null;
}

/** How many addresses are half-created and how many of those are stopped (waiting for the user). */
export interface PendingCount {
  readonly total: number;
  readonly stopped: number;
}

/** What is known about the list of half-created slots outside its card: the count (for the menu) and the slots (for
 *  the `resume` notice), or `slots: null` if the list has not been read yet or could not be. */
export interface PendingView {
  readonly count: PendingCount;
  readonly slots: readonly SlotId[] | null;
}

export const NO_PENDING_VIEW: PendingView = { count: { total: 0, stopped: 0 }, slots: null };

const slotsText = (slots: readonly SlotId[] | null) => slots && slots.map(slotKey).join(' ');

/** The view after reading the list (`null` if it could not be read). If nothing shown changes, the previous one is
 *  returned, so each re-read does not repaint the whole screen. */
export function nextPendingView(prev: PendingView, list: readonly PendingSlot[] | null): PendingView {
  const slots = list && list.map((p) => p.slot);
  const count = { total: list?.length ?? 0, stopped: list?.filter((p) => p.stopped).length ?? 0 };
  const same = prev.count.total === count.total && prev.count.stopped === count.stopped && slotsText(prev.slots) === slotsText(slots);
  return same ? prev : { count, slots };
}

/** Menu label of "Addresses", or nothing. If any is stopped, "N stopped": it is what needs attention and wins even
 *  while others carry on by themselves. Otherwise "N in progress". */
export function pendingTag({ total, stopped }: PendingCount): string | null {
  const words = t().status.addresses;
  if (stopped > 0) return words.stoppedTag(stopped);
  return total > 0 ? words.inProcessTag(total) : null;
}

/** Texts of "Abandon" for an address: a mark kept only in the app, irreversible. */
export interface AbandonTexts {
  readonly title: string;
  /** Body paragraphs, in order (the address goes before them, apart, in monospace). */
  readonly body: readonly string[];
  readonly yes: string;
  readonly no: string;
}

/** The confirmation dialog. */
export function abandonTexts(): AbandonTexts {
  return t().status.addresses.abandon;
}

/** `id` of the "Your addresses" title (focus goes there if the last one is abandoned). */
export const ADDRESSES_TITLE_ID = 'nm-direcciones-titulo';

/** The button of each row of "Your addresses". */
export const abandonButton = (): string => t().status.addresses.abandonButton;
/** Accessible name of "See mail" and "Abandon" in a row: the button says which address it belongs to (every row
 *  repeats the same visible texts). `address`: the address as shown in the row. */
export const seeMailLabel = (address: string): string => t().status.addresses.seeMail(address);
export const abandonLabel = (address: string): string => t().status.addresses.abandonAddress(address);
/** The notice after abandoning. */
export const abandonedText = (): string => t().status.addresses.abandoned;
/** The note under the "Your addresses" list. */
export const abandonNote = (): string => t().status.addresses.abandonNote;

/**
 * How many of a quota on the plan card are abandoned (they already count as used), or nothing if none. Agrees
 * with the figure's gender: "buzón" and "alias" are masculine ("1 abandonado", "2 abandonados").
 */
export function abandonedNote(count: number): string | null {
  if (count <= 0) return null;
  return t().status.addresses.abandonedCount(count);
}
