// Selection of several messages in the inbox or archive: which rows are chosen, the Shift range, "Select all" and
// the texts of the action bar. Pure rules, no React (`node --test`).
// Bulk actions use the same flags as the reader (`set_flags_many` in the core).
import { t } from './i18n/index.ts';

export interface Selection {
  /** The chosen ids. Ids no longer in the list may remain (one was archived from the reader, a sync arrived):
   *  `chosen` drops them before use. */
  ids: ReadonlySet<number>;
  /** The last row chosen or unchosen by hand: the other end of the Shift range. */
  anchor: number | null;
}

export const NONE: Selection = { ids: new Set(), anchor: null };

export type SelectionAction =
  /** Click on the checkbox, Ctrl/Cmd+click or Space on a row. */
  | { type: 'toggle'; id: number }
  /** Shift+click or Shift+Space: from the last row touched to this one, in the order of `ids` (the list as it is shown). */
  | { type: 'range'; id: number; ids: readonly number[] }
  /** "Select all" or Ctrl+A: everything in the list (not just what fits on screen). */
  | { type: 'all'; ids: readonly number[] }
  /** "Cancelar selección", Esc, a change of view or filter, or after an action. */
  | { type: 'none' };

export function select(sel: Selection, action: SelectionAction): Selection {
  switch (action.type) {
    case 'toggle': {
      const ids = new Set(sel.ids);
      if (!ids.delete(action.id)) ids.add(action.id);
      return { ids, anchor: action.id };
    }
    case 'range': {
      const from = sel.anchor === null ? -1 : action.ids.indexOf(sel.anchor);
      const to = action.ids.indexOf(action.id);
      // With no other end in this list (or the row is not there), it is a normal click on the checkbox.
      if (from === -1 || to === -1) return select(sel, { type: 'toggle', id: action.id });
      const ids = new Set(sel.ids);
      for (const id of action.ids.slice(Math.min(from, to), Math.max(from, to) + 1)) ids.add(id);
      return { ids, anchor: action.id };
    }
    case 'all':
      return { ids: new Set(action.ids), anchor: null };
    case 'none':
      return sel.ids.size === 0 && sel.anchor === null ? sel : NONE;
  }
}

/** The chosen ones still in the list, in its order. */
export function chosen(sel: Selection, ids: readonly number[]): number[] {
  return ids.filter((id) => sel.ids.has(id));
}

/** State of "Select all": none, some (half-checked box) or all. */
export type AllState = 'none' | 'some' | 'all';

export function allState(count: number, total: number): AllState {
  if (count === 0) return 'none';
  return count >= total ? 'all' : 'some';
}

/** What a click on a row does according to the keys: open it, toggle it (Ctrl/Cmd) or choose a range (Shift). */
export function clickIntent(e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): 'open' | 'toggle' | 'range' {
  if (e.shiftKey) return 'range';
  if (e.ctrlKey || e.metaKey) return 'toggle';
  return 'open';
}

/** What is needed from a key press (a `KeyboardEvent` satisfies it). */
export interface ListKey {
  key: string;
  defaultPrevented: boolean;
  isComposing?: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/** List keys with focus in it: Ctrl/Cmd+A chooses all; Esc, with something chosen, clears the selection (and does not
 *  close the open message: the next Esc does that). `null`: the key does not belong to selection. */
export function listKeyAction(e: ListKey, selected: number, total: number): 'all' | 'none' | null {
  if (e.defaultPrevented || e.isComposing === true) return null;
  const plain = !(e.altKey || e.ctrlKey || e.metaKey || e.shiftKey);
  if (e.key === 'Escape' && plain && selected > 0) return 'none';
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'a' && total > 0) return 'all';
  return null;
}

/** "N seleccionados", in the bar and in the region read by the screen reader. */
export const selectedText = (n: number): string => t().mail.selection.selected(n);

/** What is done in bulk: archive (inbox), take out of the archive (archive) or delete (both). */
export type BulkKind = 'archivar' | 'sacar' | 'borrar';

/** The flags of each action: the same ones the reader sets on a message. "Borrar" is the local `deleted` flag. */
export function bulkFlags(kind: BulkKind): { archived?: boolean; deleted?: boolean } {
  if (kind === 'borrar') return { deleted: true };
  return { archived: kind === 'archivar' };
}

/** The notice after the action, with how many. */
export function doneText(kind: BulkKind, n: number): string {
  const s = t().mail.selection;
  if (kind === 'borrar') return s.doneDeleted(n);
  if (kind === 'archivar') return s.doneArchived(n);
  return s.doneUnarchived(n);
}

/** Confirming bulk "Borrar": the title and the button say how many. */
export const deleteTitle = (n: number): string => t().mail.selection.deleteTitle(n);
export const deleteButton = (n: number): string => t().mail.selection.deleteButton(n);

/** The dialog body: no trash and no promise to restore. Note: "Borrar" is only the local `deleted` flag; restoring the account with the 24 words brings deleted messages back. */
export const deleteBody = (n: number): string => t().mail.selection.deleteBody(n);
