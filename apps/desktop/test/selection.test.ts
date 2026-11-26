// Selection of several messages: `node --test test/*.test.ts`.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allState, bulkFlags, chosen, clickIntent, deleteBody, deleteButton, deleteTitle, doneText, listKeyAction, NONE, select, selectedText, type Selection, type SelectionAction } from '../src/selection.ts';

const IDS = [9, 8, 7, 6, 5];
const run = (...actions: SelectionAction[]): Selection => actions.reduce(select, NONE);
const ids = (s: Selection) => [...s.ids].sort((a, b) => b - a);

test('toggle: selects and deselects, and the touched row is the range anchor', () => {
  const one = run({ type: 'toggle', id: 8 });
  assert.deepEqual([ids(one), one.anchor], [[8], 8]);
  const back = select(one, { type: 'toggle', id: 8 });
  assert.deepEqual([ids(back), back.anchor], [[], 8]);
});

test('Shift range: from the anchor to the row, in list order, in both directions, adding to the selection', () => {
  assert.deepEqual(ids(run({ type: 'toggle', id: 8 }, { type: 'range', id: 6, ids: IDS })), [8, 7, 6]);
  assert.deepEqual(ids(run({ type: 'toggle', id: 6 }, { type: 'range', id: 9, ids: IDS })), [9, 8, 7, 6]);
  const more = run({ type: 'toggle', id: 5 }, { type: 'toggle', id: 9 }, { type: 'range', id: 7, ids: IDS });
  assert.deepEqual([ids(more), more.anchor], [[9, 8, 7, 5], 7]);
});

test('range without an anchor (or with the anchor outside the list): it toggles that row', () => {
  assert.deepEqual(ids(run({ type: 'range', id: 7, ids: IDS })), [7]);
  assert.deepEqual(ids(run({ type: 'toggle', id: 99 }, { type: 'range', id: 7, ids: IDS })), [99, 7]);
});

test('all and none: everything in the list (not only what is visible), none empties and clears the anchor', () => {
  assert.deepEqual(ids(run({ type: 'all', ids: IDS })), IDS);
  assert.deepEqual(run({ type: 'toggle', id: 8 }, { type: 'none' }), NONE);
  assert.equal(select(NONE, { type: 'none' }), NONE);
});

test('chosen: only those still in the list, in their order (what was archived from the reader or after a sync drops out)', () => {
  const sel = run({ type: 'toggle', id: 5 }, { type: 'toggle', id: 9 }, { type: 'toggle', id: 42 });
  assert.deepEqual(chosen(sel, IDS), [9, 5]);
  assert.deepEqual(chosen(sel, []), []);
});

test('allState: none, some or all', () => {
  assert.equal(allState(0, 5), 'none');
  assert.equal(allState(2, 5), 'some');
  assert.equal(allState(5, 5), 'all');
  assert.equal(allState(0, 0), 'none');
});

test('click on a row: opens, with Ctrl or Cmd toggles, with Shift a range', () => {
  const k = (shiftKey = false, ctrlKey = false, metaKey = false) => ({ shiftKey, ctrlKey, metaKey });
  assert.equal(clickIntent(k()), 'open');
  assert.equal(clickIntent(k(false, true)), 'toggle');
  assert.equal(clickIntent(k(false, false, true)), 'toggle');
  assert.equal(clickIntent(k(true)), 'range');
  assert.equal(clickIntent(k(true, true)), 'range');
});

test('list keys: Ctrl/Cmd+A selects all, Esc only clears the selection if something is selected', () => {
  const key = (k: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'defaultPrevented', boolean>> = {}) => ({
    key: k,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    ...mods,
  });
  assert.equal(listKeyAction(key('a', { ctrlKey: true }), 0, 3), 'all');
  assert.equal(listKeyAction(key('A', { metaKey: true }), 1, 3), 'all');
  assert.equal(listKeyAction(key('a', { ctrlKey: true }), 0, 0), null);
  assert.equal(listKeyAction(key('a', { ctrlKey: true, shiftKey: true }), 0, 3), null);
  assert.equal(listKeyAction(key('a'), 0, 3), null);
  assert.equal(listKeyAction(key('Escape'), 2, 3), 'none');
  // With nothing chosen, Esc still belongs to Main (it closes the open message).
  assert.equal(listKeyAction(key('Escape'), 0, 3), null);
  assert.equal(listKeyAction(key('Escape', { shiftKey: true }), 2, 3), null);
  assert.equal(listKeyAction(key('Escape', { defaultPrevented: true }), 2, 3), null);
  assert.equal(listKeyAction({ ...key('Escape'), isComposing: true }, 2, 3), null);
});

test('texts: "1 seleccionado", "N seleccionados"', () => {
  assert.equal(selectedText(1), '1 seleccionado');
  assert.equal(selectedText(12), '12 seleccionados');
});

test('in bulk: the same marks as the reader ("Borrar" is the local mark, without touching the archive)', () => {
  assert.deepEqual(bulkFlags('archivar'), { archived: true });
  assert.deepEqual(bulkFlags('sacar'), { archived: false });
  assert.deepEqual(bulkFlags('borrar'), { deleted: true });
});

test('in bulk: the notice with how many, and the delete confirmation with the count', () => {
  assert.equal(doneText('borrar', 12), '12 mensajes borrados.');
  assert.equal(doneText('borrar', 1), '1 mensaje borrado.');
  assert.equal(doneText('archivar', 3), '3 mensajes archivados.');
  assert.equal(doneText('archivar', 1), '1 mensaje archivado.');
  assert.equal(doneText('sacar', 2), '2 mensajes sacados del archivo.');
  assert.equal(doneText('sacar', 1), '1 mensaje sacado del archivo.');
  assert.equal(deleteTitle(12), '¿Borrar 12 mensajes?');
  assert.equal(deleteButton(12), 'Borrar 12 mensajes');
  // Just one: the reader's usual texts.
  assert.equal(deleteTitle(1), '¿Borrar este mensaje?');
  assert.equal(deleteButton(1), 'Borrar mensaje');
});

test('delete: the body says it is irreversible', () => {
  for (const n of [1, 12]) {
    const body = deleteBody(n);
    assert.match(body, /irreversible\.$/);
    assert.doesNotMatch(body, /papelera|restauras/);
    assert.doesNotMatch(body, /no podrás recuperar/);
  }
  assert.match(deleteBody(1), /Dejará de verse .* irreversible\.$/);
  assert.match(deleteBody(3), /Dejarán de verse .* irreversible\.$/);
});
