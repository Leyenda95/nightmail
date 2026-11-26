// Pure Inbox rules: filter by address, unread (the sidebar light and counter), list heading, empty states and
// keyboard. No React, so they can be tested with `node --test`.
import type { AddressView } from './bindings/AddressView.ts';
import type { MessageView } from './bindings/MessageView.ts';
import { t } from './i18n/index.ts';
import type { PlanKind } from './payment.ts';
import { sideAddress } from './sidebar.ts';

/** The messages of the address chosen in the sidebar (`null`: all), in the same order. */
export function inAddress<M extends Pick<MessageView, 'addrKey'>>(messages: readonly M[], addrKey: string | null): M[] {
  return addrKey === null ? [...messages] : messages.filter((m) => m.addrKey === addrKey);
}

/** Unread: the total (the "Bandeja de entrada" menu) and per address (its light and number). No entry, none. */
export interface Unread {
  total: number;
  byAddr: Record<string, number>;
}

export function unreadCounts(messages: readonly Pick<MessageView, 'addrKey' | 'isRead'>[]): Unread {
  const byAddr: Record<string, number> = {};
  let total = 0;
  for (const m of messages) {
    if (m.isRead) continue;
    total += 1;
    byAddr[m.addrKey] = (byAddr[m.addrKey] ?? 0) + 1;
  }
  return { total, byAddr };
}

/** List heading: the unified inbox, or the chosen address (in monospace) with its domain and type. */
export interface ListHeading {
  title: string;
  sub: string;
  mono: boolean;
}

const unreadText = (n: number) => (n > 0 ? [t().mail.inbox.unread(n)] : []);

export function listHeading(address: Pick<AddressView, 'display' | 'slot'> | null, unread: number): ListHeading {
  if (address === null) {
    return { title: t().mail.inbox.title, sub: [...unreadText(unread), t().mail.inbox.allAddresses].join(' · '), mono: false };
  }
  const kind = t().mail.slotKind(address.slot.kind);
  const at = address.display.lastIndexOf('@');
  if (address.display === '' || at === -1) {
    return { title: sideAddress(address).text, sub: unreadText(unread).join(' · '), mono: false };
  }
  const domain = address.display.slice(at);
  return { title: address.display.slice(0, at), sub: [domain, kind, ...unreadText(unread)].join(' · '), mono: true };
}

/** The heading according to the sidebar filter. An address not known yet counts as the whole inbox (this only
 *  happens while addresses load: the filter is chosen from them). */
export function headingFor(addrKey: string | null, addresses: readonly AddressView[] | null, unread: Unread): ListHeading {
  const address = addrKey === null ? undefined : addresses?.find((a) => a.addrKey === addrKey);
  if (addrKey === null || address === undefined) return listHeading(null, unread.total);
  return listHeading(address, unread.byAddr[addrKey] ?? 0);
}

/** Archive heading: how many there are. `null` while they are read. */
export function archiveHeading(count: number | null): ListHeading {
  const sub = count === null ? '' : t().mail.inbox.archivedCount(count);
  return { title: t().mail.inbox.archiveTitle, sub, mono: false };
}

/** The empty archive, in the place of the rows. */
export const archiveEmptyText = (): string => t().mail.inbox.archiveEmpty;

/** "-> address that received it" of a row, as named in the sidebar. If it belongs to none known, nothing. */
export function recipientText(addrKey: string, addresses: readonly AddressView[]): string | null {
  const a = addresses.find((x) => x.addrKey === addrKey);
  return a ? sideAddress(a).text : null;
}

/** The most messages the core returns per read (`MAX_PAGE` in `views.rs`; a test ties them together). If a
 *  read reaches that number, there may be older ones that are not visible. */
export const MESSAGE_PAGE_MAX = 500;

/** Is the list cut by the read cap? It can only be known that it may be: with exactly the cap. */
export const isCapped = (read: number | null | undefined): boolean => (read ?? 0) >= MESSAGE_PAGE_MAX;

/** The fixed note under the heading when the list is cut. */
export const cappedNote = (): string => t().mail.inbox.cappedNote(MESSAGE_PAGE_MAX);

/** What is shown instead of the empty list. No addresses: first use. With some: the empty inbox, with the address that
 *  can be handed out if only one is possible (the chosen one, or the only one) and it has a name.
 *  `archived`: what was there has been archived (it is not that nothing arrived). `recortada`: with the filter on and
 *  the read cut by the cap, having no rows does not prove there is no mail for that address.
 *  `null`: there are messages, or the addresses are not known yet (no flicker between the two empty states). */
export type EmptyState =
  | { kind: 'primer-uso' }
  | { kind: 'vacia'; address: AddressView | null; archived: boolean }
  | { kind: 'recortada'; address: AddressView | null }
  | { kind: 'restauracion-pendiente' };

/** What is known about the whole read (before the filter) and the archive, so as not to claim what is untrue. */
export interface EmptyContext {
  restoring?: boolean;
  /** How many messages the Inbox read returned, across all addresses. */
  read?: number;
  /** The archived messages read (`null`/absent: not known yet). */
  archived?: readonly Pick<MessageView, 'addrKey'>[] | null;
}

export function emptyState(shown: number, addresses: readonly AddressView[] | null, addrKey: string | null, ctx: EmptyContext = {}): EmptyState | null {
  if (shown > 0) return null;
  // Unfinished restore: neither the plan nor the addresses work yet, and the addresses may fail to load.
  if (ctx.restoring) return { kind: 'restauracion-pendiente' };
  if (addresses === null) return null;
  if (addresses.length === 0) return { kind: 'primer-uso' };
  const one = addrKey === null ? (addresses.length === 1 ? addresses[0] : null) : addresses.find((a) => a.addrKey === addrKey);
  const address = one && one.display !== '' ? one : null;
  if (addrKey !== null && isCapped(ctx.read)) return { kind: 'recortada', address };
  const archived = (ctx.archived ?? []).some((m) => addrKey === null || m.addrKey === addrKey);
  return { kind: 'vacia', address, archived };
}

/** First use ("Crea tu primera dirección"), two steps: 1 choose a plan, 2 create an address. Without a plan only step 1's
 *  button; with one, step 1 is done and only step 2's button. `plan`: the plan kind (`planKind`, confirmed bonos only),
 *  `null` while it is not known yet (no button, so the wrong one never flashes). */
export function firstUseSteps(plan: PlanKind | null): { planDone: boolean; button: 'plan' | 'address' | null } {
  if (plan === null) return { planDone: false, button: null };
  return plan === 'none' ? { planDone: false, button: 'plan' } : { planDone: true, button: 'address' };
}

/** Has focus been left with nowhere to go? It happens when the list and the empty state replace each other (archiving
 *  the last one, mail arriving in the empty inbox): the focused element unmounts and focus falls to `<body>`. */
export function focusOrphaned(active: unknown, body: unknown): boolean {
  return active === null || active === body;
}

/** List keyboard: up/down to the neighbouring row, Home/End to the extremes. `id` is the row with focus (`null`: the
 *  list region). Returns the row that receives focus or `null` if the key moves nothing. */
export function stepRow(ids: readonly number[], id: number | null, key: string): number | null {
  if (ids.length === 0) return null;
  const last = ids.length - 1;
  const at = id === null ? -1 : ids.indexOf(id);
  const target = rowTarget(key, at, last);
  return target === null ? null : (ids[target] ?? null);
}

function rowTarget(key: string, at: number, last: number): number | null {
  switch (key) {
    case 'Home':
      return 0;
    case 'End':
      return last;
    case 'ArrowDown':
      return at === -1 ? 0 : at < last ? at + 1 : null;
    case 'ArrowUp':
      return at === -1 ? last : at > 0 ? at - 1 : null;
    default:
      return null;
  }
}
