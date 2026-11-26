// Navigation of the main view: which view is shown, which address filters the inbox, which message is open and where
// focus goes after each gesture. Pure rules, no React, so they can be tested with `node --test`;
// `screens/Main.tsx` drives them with `useReducer` and applies the focus.
//
// The layout (three or two panels, `prefs.ts`) changes what is seen, not the state: with two panels the list stays
// mounted (hidden) while reading, to keep its scroll position and its row.
import type { Layout } from './prefs.ts';

/** Views of the main panel: those of the sidebar, "Enviados" and the message being written ("redactar", opened with
 *  "Nuevo mensaje" or "Responder"). */
export const VIEWS = ['bandeja', 'archivo', 'enviados', 'redactar', 'direcciones', 'plan', 'ajustes'] as const;
export type View = (typeof VIEWS)[number];

/** The views that are a message list with its reader: the inbox and the archive. */
export type List = Extract<View, 'bandeja' | 'archivo'>;
export const isList = (view: View): view is List => view === 'bandeja' || view === 'archivo';

/** Where focus goes after a gesture: to the reader, to a message row or to a list title. `null`: it does not move. */
export type Focus = { to: 'lector' } | { to: 'fila'; id: number } | { to: 'lista'; list: List } | { to: 'nombre' } | null;

export interface Nav {
  view: View;
  /** Address chosen in the sidebar (`addrKey`); `null` is the unified inbox. It only filters the inbox. */
  addrKey: string | null;
  /** Message open in the reader. */
  openId: number | null;
  /** The list the open message belongs to: only that one shows it (both stay mounted, hidden). There is a single
   *  open message: entering the other list closes it. */
  openIn: List;
  focus: Focus;
}

export const START: Nav = { view: 'bandeja', addrKey: null, openId: null, openIn: 'bandeja', focus: null };

export type NavAction =
  /** A menu item. "Bandeja" is the unified inbox (it removes the filter). */
  | { type: 'go'; view: View }
  /** An address in the sidebar: the inbox of that address only. */
  | { type: 'filter'; addrKey: string }
  /** The "+" of "Tus direcciones" in the sidebar: the addresses page with focus on the mailbox name. */
  | { type: 'new' }
  /** Open a message from a list (without `list`, from the inbox). */
  | { type: 'open'; id: number; list?: List }
  /** Close the reader (button, Esc, "<- Bandeja" or "<- Archivo"). */
  | { type: 'close' }
  /** Message `id` was archived, taken out of the archive or deleted. `ids`: the list as it was shown (with it still in).
   *  If it is no longer the open one (another was opened meanwhile), nothing changes. */
  | { type: 'gone'; id: number; ids: readonly number[] }
  /** Several of list `list` were archived, taken out of the archive or deleted at once (selection). `ids`: the list as
   *  it was shown. If the open one is among them, it closes; focus goes to the row that takes the place of the first
   *  (or to the list title if none remain). */
  | { type: 'removed'; removed: readonly number[]; ids: readonly number[]; list: List }
  /** Address `addrKey` is no longer in the list (it was abandoned). If the inbox was filtered by it, it goes back to the
   *  unified inbox without changing view. `openAddr`: the address of the open message (that of its last read, or
   *  `null` if unknown). If it is this one, the message closes, whether from the inbox or the archive. */
  | { type: 'dropped'; addrKey: string; openAddr: string | null };

/** The row that takes the place of `id` once removed: the next one or, if it was the last, the previous one. */
export function neighbor<T>(ids: readonly T[], id: T): T | null {
  return neighborOf(ids, [id]);
}

/** The same when removing several: the first remaining one after the first removed or, if none, the last remaining
 *  one before it. `null` if none remain (or none of `removed` was there). */
export function neighborOf<T>(ids: readonly T[], removed: readonly T[]): T | null {
  const gone = new Set(removed);
  const at = ids.findIndex((id) => gone.has(id));
  if (at === -1) return null;
  const after = ids.slice(at + 1).find((id) => !gone.has(id));
  if (after !== undefined) return after;
  return ids.slice(0, at).findLast((id) => !gone.has(id)) ?? null;
}

function closed(nav: Nav): Nav {
  if (nav.openId === null) return nav;
  return { ...nav, openId: null, focus: { to: 'fila', id: nav.openId } };
}

/** Go back to list `list`, which is the open message's (or none is open). Already in it with a message open: with two
 *  panels it returns to the list (otherwise the gesture would do nothing visible); with three, the list is already
 *  visible and the message stays. From another view it returns with the message open, in both. */
function backTo(nav: Nav, list: List, layout: Layout): Nav {
  if (nav.view === list && layout === 'dos') return closed(nav);
  return { ...nav, view: list, focus: null };
}

/** Changing the filter closes the message: it may not belong to the new address (and the filtered inbox has none open).
 *  Also if the open one is from the archive (there is a single open message). The same filter ("Bandeja" or the address already chosen): `backTo`. */
function withFilter(nav: Nav, addrKey: string | null, layout: Layout): Nav {
  if (nav.addrKey !== addrKey || nav.openIn !== 'bandeja') return { ...nav, view: 'bandeja', addrKey, openId: null, openIn: 'bandeja', focus: null };
  return backTo(nav, 'bandeja', layout);
}

/** The archive is not filtered by address (the sidebar filters the inbox): the filter is kept for the way back. There is a
 *  single open message: entering with one from the inbox closes it; going back to the archive: `backTo`. */
function toArchive(nav: Nav, layout: Layout): Nav {
  if (nav.openIn !== 'archivo') return { ...nav, view: 'archivo', openId: null, openIn: 'archivo', focus: null };
  return backTo(nav, 'archivo', layout);
}

function gone(nav: Nav, id: number, ids: readonly number[]): Nav {
  if (nav.openId === null || nav.openId !== id) return nav;
  const next = neighbor(ids, nav.openId);
  return { ...nav, openId: null, focus: next === null ? { to: 'lista', list: nav.openIn } : { to: 'fila', id: next } };
}

function removedMany(nav: Nav, removed: readonly number[], ids: readonly number[], list: List): Nav {
  const closes = nav.openIn === list && nav.openId !== null && removed.includes(nav.openId);
  const next = neighborOf(ids, removed);
  return { ...nav, openId: closes ? null : nav.openId, focus: next === null ? { to: 'lista', list } : { to: 'fila', id: next } };
}

/** Its mail is no longer shown: its filter is removed and, if the open message was its own (in the inbox or the
 *  archive), it closes. No view change and no focus move. If none of that changes, the same state. */
function dropped(nav: Nav, addrKey: string, openAddr: string | null): Nav {
  const unfilters = nav.addrKey === addrKey;
  const closes = nav.openId !== null && openAddr === addrKey;
  if (!unfilters && !closes) return nav;
  return { ...nav, addrKey: unfilters ? null : nav.addrKey, openId: closes ? null : nav.openId, focus: null };
}

/** The addresses of `before` that are no longer in `now` (abandoned), in `before` order. */
export function droppedKeys(before: readonly { addrKey: string }[], now: readonly { addrKey: string }[]): string[] {
  const still = new Set(now.map((a) => a.addrKey));
  return before.filter((a) => !still.has(a.addrKey)).map((a) => a.addrKey);
}

export function navigate(nav: Nav, action: NavAction, layout: Layout): Nav {
  switch (action.type) {
    case 'go':
      // "Bandeja" in the menu is the unified inbox.
      if (action.view === 'bandeja') return withFilter(nav, null, layout);
      if (action.view === 'archivo') return toArchive(nav, layout);
      return { ...nav, view: action.view, focus: null };
    case 'filter':
      return withFilter(nav, action.addrKey, layout);
    case 'new':
      return { ...nav, view: 'direcciones', focus: { to: 'nombre' } };
    case 'open': {
      const list = action.list ?? 'bandeja';
      return { ...nav, view: list, openId: action.id, openIn: list, focus: { to: 'lector' } };
    }
    case 'close':
      return closed(nav);
    case 'gone':
      return gone(nav, action.id, action.ids);
    case 'removed':
      return removedMany(nav, action.removed, action.ids, action.list);
    case 'dropped':
      return dropped(nav, action.addrKey, action.openAddr);
  }
}

/** What the inbox shows. `list`: the visible list (with two panels it is hidden, still mounted, while reading).
 *  `reader`: the message, the "pick a message" placeholder or nothing (two panels with no message: the list fills it all). */
export interface Panes {
  list: boolean;
  reader: 'mensaje' | 'hueco' | null;
}

/** The message open in list `list` (`null` if none or it belongs to the other). */
export function openHere(nav: Pick<Nav, 'openId' | 'openIn'>, list: List): number | null {
  return nav.openIn === list ? nav.openId : null;
}

/** `openId`: the message open in THIS list (`openHere`). */
export function panes(nav: Pick<Nav, 'openId'>, layout: Layout): Panes {
  const open = nav.openId !== null;
  if (layout === 'dos') return open ? { list: false, reader: 'mensaje' } : { list: true, reader: null };
  return { list: true, reader: open ? 'mensaje' : 'hueco' };
}

/** What is needed from a key press (a `KeyboardEvent` satisfies it). */
export interface EscapeKey {
  key: string;
  defaultPrevented: boolean;
  isComposing: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/** Esc with no modifiers, not taken by anyone else nor by an input method. */
export const plainEscape = (e: EscapeKey) =>
  e.key === 'Escape' && !e.defaultPrevented && !e.isComposing && !(e.altKey || e.ctrlKey || e.metaKey || e.shiftKey);

/**
 * Does this key press close the open message (like "Cerrar" or "<- Bandeja")? Only Esc with no modifiers, with the
 * reader visible and no dialog open (there Esc belongs to the dialog: it cancels). Main listens on `document`, so it
 * works with focus anywhere in the app EXCEPT inside the paper: the keyboard of a `sandbox=""` iframe never leaves it,
 * and it is not given `allow-scripts` or `postMessage` to forward it. From the paper, Shift+Tab leads to
 * "Cerrar" / "<- Bandeja", the last stop before it, and Enter closes.
 */
export function escapeCloses(e: EscapeKey, nav: Pick<Nav, 'view' | 'openId' | 'openIn'>, dialogOpen: boolean): boolean {
  return plainEscape(e) && !dialogOpen && isList(nav.view) && openHere(nav, nav.view) !== null;
}

/** Element that receives focus. The reader sets its own focus on mount (`Reader.tsx`): no need to look it up here. */
export function focusSelector(focus: Focus): string | null {
  if (focus === null || focus.to === 'lector') return null;
  if (focus.to === 'lista') return `#${listTitleId(focus.list)}`;
  if (focus.to === 'nombre') return `#${NEW_NAME_ID}`;
  return `[data-nm-msg="${focus.id}"]`;
}

/** `id` of the "Nombre del buzón" field of "Nueva dirección" (focus goes there from the sidebar). */
export const NEW_NAME_ID = 'nm-nuevo-nombre';

/** `id` of the list title (focus goes there when no row remains). */
export const LIST_TITLE_ID = 'nm-lista-titulo';
/** The archive's: both lists stay mounted and an `id` must not repeat. */
export const ARCHIVE_TITLE_ID = 'nm-archivo-titulo';
export const listTitleId = (list: List): string => (list === 'archivo' ? ARCHIVE_TITLE_ID : LIST_TITLE_ID);
/** The title of "Enviados" (focus goes there when no row remains). */
export const SENT_TITLE_ID = 'nm-enviados-titulo';

/** Where focus goes if the strip notice about mail leaves while holding focus (after "Reintentar"): the title of the
 *  visible list or, if the list is hidden (two panels with a message open), the reader. The first that accepts
 *  focus wins (both views stay mounted and the hidden one does not accept it). */
export const noticeFocusSelectors = (list: List): string[] => [`#${listTitleId(list)}`, 'article.nm-lector'];
