// Navigation of the main view and sidebar: `node --test test/*.test.ts`.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ARCHIVE_TITLE_ID,
  droppedKeys,
  escapeCloses,
  focusSelector,
  isList,
  LIST_TITLE_ID,
  navigate,
  neighbor,
  neighborOf,
  noticeFocusSelectors,
  openHere,
  panes,
  START,
  type Nav,
  type NavAction,
} from '../src/nav.ts';
import type { Layout } from '../src/prefs.ts';
import { addressesNote, ANSWER_LIMIT_MS, holdDown, mailDownText, mailDownShown, midnightLine, overdue, partLine, waitReason, watchOverdue, type OverdueEnv, planName, quotaPercent, serverLine, serviceLine, sideAddress, type StatusLineView } from '../src/sidebar.ts';

const LAYOUTS: Layout[] = ['tres', 'dos'];
const run = (layout: Layout, ...actions: NavAction[]): Nav => actions.reduce((nav, a) => navigate(nav, a, layout), START);

test('neighbor: the row that takes the place, the next one, the previous if it was the last, or none', () => {
  assert.equal(neighbor([5, 4, 3], 4), 3);
  assert.equal(neighbor([5, 4, 3], 3), 4);
  assert.equal(neighbor([5], 5), null);
  assert.equal(neighbor([5, 4], 9), null);
  assert.equal(neighbor([], 1), null);
});

test('open: the message, in the inbox, with focus on the reader (both layouts)', () => {
  for (const layout of LAYOUTS) {
    const nav = run(layout, { type: 'go', view: 'plan' }, { type: 'open', id: 7 });
    assert.deepEqual(nav, { view: 'bandeja', addrKey: null, openId: 7, openIn: 'bandeja', focus: { to: 'lector' } }, layout);
  }
});

test('close (button, Esc, "← Bandeja"): focus returns to the message row, without a message nothing changes', () => {
  for (const layout of LAYOUTS) {
    assert.deepEqual(run(layout, { type: 'open', id: 7 }, { type: 'close' }).focus, { to: 'fila', id: 7 }, layout);
    assert.equal(run(layout, { type: 'open', id: 7 }, { type: 'close' }).openId, null, layout);
    assert.equal(navigate(START, { type: 'close' }, layout), START, layout);
  }
});

test('archive or delete: focus goes to the row that takes its place, or to the title if none is left (both)', () => {
  for (const layout of LAYOUTS) {
    const open = run(layout, { type: 'open', id: 4 });
    assert.deepEqual(navigate(open, { type: 'gone', id: 4, ids: [5, 4, 3] }, layout), { ...open, openId: null, focus: { to: 'fila', id: 3 } });
    assert.deepEqual(navigate(open, { type: 'gone', id: 4, ids: [5, 4] }, layout).focus, { to: 'fila', id: 5 });
    assert.deepEqual(navigate(open, { type: 'gone', id: 4, ids: [4] }, layout).focus, { to: 'lista', list: 'bandeja' });
    // Already closed (another gesture won): nothing.
    assert.equal(navigate(START, { type: 'gone', id: 4, ids: [4] }, layout), START);
  }
});

test('neighborOf: when removing several, the first remaining after the first removed, or the last before, or none', () => {
  assert.equal(neighborOf([9, 8, 7, 6, 5], [8, 6]), 7);
  assert.equal(neighborOf([9, 8, 7, 6, 5], [8, 7, 6]), 5);
  assert.equal(neighborOf([9, 8, 7], [8, 7]), 9);
  assert.equal(neighborOf([9, 8, 7], [7, 9, 8]), null);
  assert.equal(neighborOf([9, 8], [1]), null);
});

test('in bulk (selection): closes the open one if it was removed and focus goes to the row that takes its place', () => {
  for (const layout of LAYOUTS) {
    const open = run(layout, { type: 'open', id: 8 });
    const removed = navigate(open, { type: 'removed', removed: [8, 7], ids: [9, 8, 7, 6], list: 'bandeja' }, layout);
    assert.deepEqual(removed, { ...open, openId: null, focus: { to: 'fila', id: 6 } }, layout);
    // The open one was not among those removed: it stays open; focus still goes to the list.
    const kept = navigate(open, { type: 'removed', removed: [6], ids: [9, 8, 7, 6], list: 'bandeja' }, layout);
    assert.deepEqual(kept, { ...open, focus: { to: 'fila', id: 7 } }, layout);
    // With none open and no rows left: to that list's title.
    const all = navigate(START, { type: 'removed', removed: [2, 1], ids: [2, 1], list: 'archivo' }, layout);
    assert.deepEqual(all, { ...START, focus: { to: 'lista', list: 'archivo' } }, layout);
    // The open one belongs to the other list (the same id is impossible, but just in case): it does not close.
    const otherList = navigate(open, { type: 'removed', removed: [8], ids: [8], list: 'archivo' }, layout);
    assert.equal(otherList.openId, 8, layout);
  }
});

test('late archive or delete: if another message was already opened, it is not closed and focus does not move', () => {
  for (const layout of LAYOUTS) {
    const other = run(layout, { type: 'open', id: 4 }, { type: 'open', id: 5 });
    assert.equal(navigate(other, { type: 'gone', id: 4, ids: [5, 4, 3] }, layout), other, layout);
  }
});

test("choosing an address: that address's inbox, no message open, going back to it from another view closes nothing", () => {
  for (const layout of LAYOUTS) {
    const nav = run(layout, { type: 'open', id: 7 }, { type: 'filter', addrKey: 'ab' });
    assert.deepEqual(nav, { view: 'bandeja', addrKey: 'ab', openId: null, openIn: 'bandeja', focus: null }, layout);
    const again = run(layout, { type: 'filter', addrKey: 'ab' }, { type: 'open', id: 2 }, { type: 'go', view: 'plan' }, { type: 'filter', addrKey: 'ab' });
    assert.deepEqual(again, { view: 'bandeja', addrKey: 'ab', openId: 2, openIn: 'bandeja', focus: null }, layout);
  }
});

test('the already chosen address, while in its inbox: with three panels the message stays, with two it goes back to the list, to its row', () => {
  const open = (layout: Layout) => run(layout, { type: 'filter', addrKey: 'ab' }, { type: 'open', id: 2 }, { type: 'filter', addrKey: 'ab' });
  assert.deepEqual(open('tres'), { view: 'bandeja', addrKey: 'ab', openId: 2, openIn: 'bandeja', focus: null });
  assert.deepEqual(open('dos'), { view: 'bandeja', addrKey: 'ab', openId: null, openIn: 'bandeja', focus: { to: 'fila', id: 2 } });
  // With no message open, with two panels nothing changes (the list is already visible).
  const list = run('dos', { type: 'filter', addrKey: 'ab' });
  assert.equal(navigate(list, { type: 'filter', addrKey: 'ab' }, 'dos'), list);
});

const ESC = { key: 'Escape', defaultPrevented: false, isComposing: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

test('Esc closes the message open in the inbox (both layouts, focus returns to its row with `close`)', () => {
  for (const layout of LAYOUTS) {
    assert.equal(escapeCloses(ESC, run(layout, { type: 'open', id: 7 }), false), true, layout);
  }
});

test('Esc does nothing without a message, in another view, with a dialog open, if someone else used it, with modifiers or while composing', () => {
  const open = run('tres', { type: 'open', id: 7 });
  assert.equal(escapeCloses(ESC, START, false), false, 'no message');
  assert.equal(escapeCloses(ESC, navigate(open, { type: 'go', view: 'plan' }, 'tres'), false), false, 'another view');
  assert.equal(escapeCloses(ESC, open, true), false, 'dialog open: Esc belongs to it');
  assert.equal(escapeCloses({ ...ESC, defaultPrevented: true }, open, false), false, 'already handled');
  assert.equal(escapeCloses({ ...ESC, isComposing: true }, open, false), false, 'composing');
  for (const mod of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const) {
    assert.equal(escapeCloses({ ...ESC, [mod]: true }, open, false), false, mod);
  }
  assert.equal(escapeCloses({ ...ESC, key: 'Enter' }, open, false), false, 'another key');
});

test('menu: another view keeps inbox, filter and message for the return, focus stays on the menu', () => {
  for (const layout of LAYOUTS) {
    const nav = run(layout, { type: 'filter', addrKey: 'ab' }, { type: 'open', id: 2 }, { type: 'go', view: 'direcciones' });
    assert.deepEqual(nav, { view: 'direcciones', addrKey: 'ab', openId: 2, openIn: 'bandeja', focus: null }, layout);
  }
});

test('"Bandeja" in the menu clears the filter (and closes the message, which could belong to another address)', () => {
  for (const layout of LAYOUTS) {
    const nav = run(layout, { type: 'filter', addrKey: 'ab' }, { type: 'open', id: 2 }, { type: 'go', view: 'bandeja' });
    assert.deepEqual(nav, { view: 'bandeja', addrKey: null, openId: null, openIn: 'bandeja', focus: null }, layout);
  }
});

test('"Bandeja" while already there: with three panels the message stays, with two it goes back to the list, to its row', () => {
  assert.deepEqual(run('tres', { type: 'open', id: 2 }, { type: 'go', view: 'bandeja' }), { ...START, openId: 2, focus: null });
  assert.deepEqual(run('dos', { type: 'open', id: 2 }, { type: 'go', view: 'bandeja' }), { ...START, focus: { to: 'fila', id: 2 } });
  // From another view it returns with the message open, in both.
  for (const layout of LAYOUTS) {
    const back = run(layout, { type: 'open', id: 2 }, { type: 'go', view: 'ajustes' }, { type: 'go', view: 'bandeja' });
    assert.equal(back.openId, 2, layout);
  }
});

test('panes: three panels always show the list and the reader (or its gap)', () => {
  assert.deepEqual(panes({ openId: null }, 'tres'), { list: true, reader: 'hueco' });
  assert.deepEqual(panes({ openId: 3 }, 'tres'), { list: true, reader: 'mensaje' });
});

test('panes: two panels, the list alone or the message in its place (the list stays mounted, hidden)', () => {
  assert.deepEqual(panes({ openId: null }, 'dos'), { list: true, reader: null });
  assert.deepEqual(panes({ openId: 3 }, 'dos'), { list: false, reader: 'mensaje' });
});

test('focusSelector: the row by its id, the list title, the reader focuses itself', () => {
  assert.equal(focusSelector({ to: 'fila', id: 12 }), '[data-nm-msg="12"]');
  assert.equal(focusSelector({ to: 'lista', list: 'bandeja' }), `#${LIST_TITLE_ID}`);
  assert.equal(focusSelector({ to: 'lector' }), null);
  assert.equal(focusSelector(null), null);
});

// --- Archive ---

const inArchive = (layout: Layout, ...actions: NavAction[]) => run(layout, { type: 'go', view: 'archivo' }, ...actions);

test('archive: entering closes the inbox message (it is not archived) and keeps the filter for the return', () => {
  for (const layout of LAYOUTS) {
    const nav = run(layout, { type: 'filter', addrKey: 'ab' }, { type: 'open', id: 2 }, { type: 'go', view: 'archivo' });
    assert.deepEqual(nav, { view: 'archivo', addrKey: 'ab', openId: null, openIn: 'archivo', focus: null }, layout);
  }
});

test('archive: opening a message opens it there, with focus on the reader, the inbox does not show it', () => {
  for (const layout of LAYOUTS) {
    const nav = inArchive(layout, { type: 'open', id: 9, list: 'archivo' });
    assert.deepEqual(nav, { view: 'archivo', addrKey: null, openId: 9, openIn: 'archivo', focus: { to: 'lector' } }, layout);
    assert.equal(openHere(nav, 'archivo'), 9, layout);
    assert.equal(openHere(nav, 'bandeja'), null, layout);
  }
});

test('archive: closing returns focus to its row, unarchiving or deleting to the one that takes its place or to the ARCHIVE title', () => {
  for (const layout of LAYOUTS) {
    const open = inArchive(layout, { type: 'open', id: 9, list: 'archivo' });
    assert.deepEqual(navigate(open, { type: 'close' }, layout).focus, { to: 'fila', id: 9 }, layout);
    assert.deepEqual(navigate(open, { type: 'gone', id: 9, ids: [9, 8] }, layout).focus, { to: 'fila', id: 8 }, layout);
    const last = navigate(open, { type: 'gone', id: 9, ids: [9] }, layout);
    assert.deepEqual(last.focus, { to: 'lista', list: 'archivo' }, layout);
    assert.equal(focusSelector(last.focus), `#${ARCHIVE_TITLE_ID}`);
    assert.equal(last.view, 'archivo', layout);
  }
});

test('archive: another view and back keeps the message, "Bandeja" or an address close it (it belongs to the archive)', () => {
  for (const layout of LAYOUTS) {
    const open = inArchive(layout, { type: 'open', id: 9, list: 'archivo' });
    const back = navigate(navigate(open, { type: 'go', view: 'plan' }, layout), { type: 'go', view: 'archivo' }, layout);
    assert.deepEqual(back, { ...open, focus: null }, layout);
    for (const action of [{ type: 'go', view: 'bandeja' }, { type: 'filter', addrKey: 'ab' }] as const) {
      const nav = navigate(open, action, layout);
      assert.equal(nav.view, 'bandeja', layout);
      assert.equal(nav.openId, null, layout);
      assert.equal(nav.openIn, 'bandeja', layout);
    }
  }
});

test('archive: "Archivo" while in it with a message: with three panels it stays, with two it goes back to the list, to its row', () => {
  const again = (layout: Layout) => inArchive(layout, { type: 'open', id: 9, list: 'archivo' }, { type: 'go', view: 'archivo' });
  assert.equal(again('tres').openId, 9);
  assert.equal(again('tres').focus, null);
  assert.equal(again('dos').openId, null);
  assert.deepEqual(again('dos').focus, { to: 'fila', id: 9 });
  // With no message, with two panels nothing changes.
  const list = inArchive('dos');
  assert.equal(navigate(list, { type: 'go', view: 'archivo' }, 'dos'), list);
});

test('archive: opening from the inbox after visiting the archive belongs to the inbox again', () => {
  const nav = inArchive('tres', { type: 'open', id: 9, list: 'archivo' }, { type: 'go', view: 'bandeja' }, { type: 'open', id: 3 });
  assert.deepEqual(nav, { view: 'bandeja', addrKey: null, openId: 3, openIn: 'bandeja', focus: { to: 'lector' } });
});

test("archive: Esc closes the message open in it, not from another view nor the other list's", () => {
  for (const layout of LAYOUTS) {
    const open = inArchive(layout, { type: 'open', id: 9, list: 'archivo' });
    assert.equal(escapeCloses(ESC, open, false), true, layout);
    assert.equal(escapeCloses(ESC, open, true), false, layout);
    assert.equal(escapeCloses(ESC, navigate(open, { type: 'go', view: 'ajustes' }, layout), false), false, layout);
    // An incoherent state (inbox view with the archive's message) does not close anything blindly either.
    assert.equal(escapeCloses(ESC, { ...open, view: 'bandeja' }, false), false, layout);
  }
});

const slot = { n: 1, kind: 'mailbox' as const, j: 2 };

test('sideAddress: the local part with its @ and the full address as title, without a name "buzón sin nombre"', () => {
  assert.deepEqual(sideAddress({ display: 'juan@nightmail.local', slot }), { text: 'juan@', title: 'juan@nightmail.local', named: true });
  assert.deepEqual(sideAddress({ display: '', slot }), { text: 'buzón sin nombre', title: '', named: false });
  assert.deepEqual(sideAddress({ display: 'raro', slot }).text, 'raro');
});

test('addressesNote: that only you know it', () => {
  assert.equal(addressesNote(0), 'Aún no tienes ninguna.');
  assert.equal(addressesNote(1), 'Solo tú sabes que esta dirección es tuya.');
  assert.equal(addressesNote(3), 'Solo tú sabes que estas direcciones son tuyas.');
  assert.equal(addressesNote(9), 'Solo tú sabes que estas direcciones son tuyas.');
});

test('planName and quotaPercent: the footer quota', () => {
  const bono = { n: 1, k: 0, paid: false, included: true, usableAt: null };
  assert.equal(planName({ bonos: [] }), null);
  assert.equal(planName({ bonos: [bono] }), 'Plan gratis');
  assert.equal(planName({ bonos: [bono, { ...bono, k: 1, paid: true }] }), 'Night Plus');
  // Only confirmed bonos count, as on the plan page and in the core's quota.
  assert.equal(planName({ bonos: [bono, { ...bono, k: 1, paid: true, included: false }] }), 'Plan gratis');
  assert.equal(planName({ bonos: [{ ...bono, included: false }] }), null);
  assert.equal(quotaPercent({ used: 1, limit: 5 }), 20);
  assert.equal(quotaPercent({ used: 0, limit: 0 }), 0);
  assert.equal(quotaPercent({ used: 9, limit: 5 }), 100);
});

const H = (indexer: boolean, proofServer: boolean) => ({
  health: { sidecarVersion: '0.1.0', nodeVersion: 'v24', indexer, proofServer },
  failed: false,
});
const NO_DATA = { health: null, failed: false };

test('midnightLine: each state with its dot colour and its word, grey while unknown', () => {
  const ready = { state: 'ready', sidecarVersion: '0.1.0' } as const;
  assert.deepEqual(midnightLine(ready, H(true, true)), { tone: 'ok', text: 'conectado' });
  assert.deepEqual(midnightLine({ state: 'down', failures: 3 }, H(true, true)), { tone: 'caido', text: 'caído' });
  assert.deepEqual(midnightLine({ state: 'notStarted' }, NO_DATA), { tone: 'espera', text: 'arrancando…' });
  assert.deepEqual(midnightLine({ state: 'unavailable' }, NO_DATA), { tone: 'sin', text: 'no disponible en esta build' });
  assert.deepEqual(midnightLine(null, NO_DATA), { tone: 'espera', text: '…', waiting: 'silent' });
});

test('midnightLine: "listo" is not "conectado" until the network and the proof server respond (F4)', () => {
  const ready = { state: 'ready', sidecarVersion: '0.1.0' } as const;
  assert.deepEqual(midnightLine(ready, NO_DATA), { tone: 'espera', text: 'comprobando…', waiting: 'checking' });
  assert.deepEqual(midnightLine(ready, H(false, true)), { tone: 'caido', text: 'sin conexión' });
  assert.deepEqual(midnightLine(ready, H(false, false)), { tone: 'caido', text: 'sin conexión' });
  assert.deepEqual(midnightLine(ready, H(true, false)), { tone: 'aviso', text: 'falta el proof server' });
  // A ping with no answer does not leave the earlier "conectado" standing.
  assert.equal(midnightLine(ready, { ...H(true, true), failed: true }).text, 'sin conexión');
});

test('dropped: an abandoned address removes its inbox filter without changing view, another changes nothing', () => {
  for (const layout of LAYOUTS) {
    const filtered = run(layout, { type: 'filter', addrKey: 'aa' }, { type: 'open', id: 4 }, { type: 'go', view: 'direcciones' });
    const after = navigate(filtered, { type: 'dropped', addrKey: 'aa', openAddr: 'aa' }, layout);
    // Returns to "Bandeja de entrada" and closes the message (it belonged to it), without leaving "Direcciones".
    assert.deepEqual(after, { ...filtered, addrKey: null, openId: null, focus: null }, layout);
    assert.equal(navigate(filtered, { type: 'dropped', addrKey: 'bb', openAddr: 'aa' }, layout), filtered, layout);
  }
});

test('dropped: the open message of the abandoned address is closed also without a filter and in the archive', () => {
  for (const layout of LAYOUTS) {
    // Unfiltered inbox, with one of its messages open: it closes and the view stays.
    const unified = run(layout, { type: 'open', id: 4 });
    assert.deepEqual(navigate(unified, { type: 'dropped', addrKey: 'aa', openAddr: 'aa' }, layout), { ...unified, openId: null, focus: null }, layout);
    // The open one belongs to another address (or it is unknown which): untouched.
    assert.equal(navigate(unified, { type: 'dropped', addrKey: 'aa', openAddr: 'bb' }, layout), unified, layout);
    assert.equal(navigate(unified, { type: 'dropped', addrKey: 'aa', openAddr: null }, layout), unified, layout);
    // Archive with one of its messages open and the inbox filtered by it: the filter is removed and it closes.
    const archived = run(layout, { type: 'filter', addrKey: 'aa' }, { type: 'open', id: 9, list: 'archivo' });
    const after = navigate(archived, { type: 'dropped', addrKey: 'aa', openAddr: 'aa' }, layout);
    assert.deepEqual(after, { ...archived, addrKey: null, openId: null, focus: null }, layout);
    assert.equal(after.view, 'archivo', layout);
    // Archive with a message from another address: the filter is removed and the message stays.
    assert.equal(navigate(archived, { type: 'dropped', addrKey: 'aa', openAddr: 'bb' }, layout).openId, 9, layout);
    // With no message open and no filter: the same state.
    assert.equal(navigate(START, { type: 'dropped', addrKey: 'aa', openAddr: 'aa' }, layout), START, layout);
  }
});

test('droppedKeys: the addresses that are gone, in their order', () => {
  const k = (...keys: string[]) => keys.map((addrKey) => ({ addrKey }));
  assert.deepEqual(droppedKeys(k('a', 'b', 'c'), k('a', 'c')), ['b']);
  assert.deepEqual(droppedKeys(k('a', 'b', 'c'), k('b')), ['a', 'c']);
  assert.deepEqual(droppedKeys(k('a'), k('a', 'b')), []);
  assert.deepEqual(droppedKeys([], k('a')), []);
  assert.deepEqual(droppedKeys(k('a', 'b'), []), ['a', 'b']);
});

test('neighbor also with address keys (focus after abandoning one)', () => {
  assert.equal(neighbor(['a', 'b', 'c'], 'b'), 'c');
  assert.equal(neighbor(['a', 'b', 'c'], 'c'), 'b');
  assert.equal(neighbor(['a'], 'a'), null);
});

const S = (mailbox: boolean, relayer: boolean, issuer: boolean) => ({ health: { mailbox, relayer, issuer }, failed: false });

test('serverLine: the NightMail server is separate from Midnight and says whether it is fully, partly or not available', () => {
  assert.deepEqual(serverLine(NO_DATA), { tone: 'espera', text: 'comprobando…', waiting: 'checking' });
  assert.deepEqual(serverLine(S(true, true, true)), { tone: 'ok', text: 'conectado' });
  assert.deepEqual(serverLine(S(false, false, false)), { tone: 'caido', text: 'no responde' });
  // Without bono issuing or address creation, mail keeps arriving: yellow.
  for (const s of [S(true, false, true), S(true, true, false), S(true, false, false)]) {
    assert.deepEqual(serverLine(s), { tone: 'aviso', text: 'parcialmente disponible' });
  }
  // Without mail, new mail cannot be read: red even if the rest answers.
  for (const s of [S(false, true, true), S(false, false, true), S(false, true, false)]) {
    assert.deepEqual(serverLine(s), { tone: 'caido', text: 'el correo no responde' });
  }
  // If the app could not even ask, the earlier "conectado" does not stay standing.
  assert.deepEqual(serverLine({ ...S(true, true, true), failed: true }), { tone: 'sin', text: 'sin comprobar', waiting: 'notChecked' });
});

test('mailDownShown: the mail notice appears with the server mail in red, only in inbox and archive', () => {
  // The line as the sidebar paints it: `serverLine` and, after the deadline (`expired`), `overdue`.
  const shown = (snap: Parameters<typeof serverLine>[0], expired = false, view: Parameters<typeof isList>[0] = 'bandeja') =>
    mailDownShown(isList(view), overdue(serverLine(snap), expired));
  // The mail does not answer (only it or the whole server): immediately, like the red dot.
  assert.equal(shown(S(false, true, true)), true);
  assert.equal(shown(S(false, false, false)), true);
  assert.equal(shown(S(false, true, true), false, 'archivo'), true);
  // In the other views there is no mail list.
  for (const view of ['direcciones', 'plan', 'ajustes'] as const) assert.equal(shown(S(false, false, false), false, view), false, view);
  // With mail up it does not show, even if bono issuing or address creation are missing (yellow).
  assert.equal(shown(S(true, true, true)), false);
  assert.equal(shown(S(true, false, false)), false);
  // The first check with no answer is grey: it does not show until the deadline passes (red, "sin respuesta").
  assert.equal(shown(NO_DATA), false);
  assert.equal(shown(NO_DATA, true), true);
  // The app cannot ask the server: the same, grey and then red. The earlier "conectado" does not cover it.
  const unreachable = { ...S(true, true, true), failed: true };
  assert.equal(shown(unreachable), false);
  assert.equal(shown(unreachable, true), true);
  // It answers again: it goes away by itself (the expired deadline no longer counts without a wait).
  assert.equal(shown(S(true, true, true), true), false);
});

test('holdDown: a red line stays red while waiting, and the mail notice does not go away', () => {
  // The line shown before and now, like `useOverdue`: `holdDown(previous, overdue(serverLine(snap), expired))`.
  const red = serverLine(S(false, true, true));
  assert.equal(red.tone, 'caido');
  // The mail was not answering and then the whole server stops answering: grey "sin comprobar" without this.
  const unreachable = { ...S(false, true, true), failed: true };
  const held = holdDown(red, overdue(serverLine(unreachable), false));
  assert.deepEqual(held, { tone: 'caido', text: 'sin respuesta' });
  assert.equal(mailDownShown(true, held), true);
  // It stays so on the next failed check (the previous one is already the held one).
  assert.deepEqual(holdDown(held, overdue(serverLine(unreachable), false)), held);
  // Without red before, the initial grey and the cannot-ask grey stay grey (the deadline rules).
  assert.deepEqual(holdDown(null, serverLine(NO_DATA)), serverLine(NO_DATA));
  assert.deepEqual(holdDown(serverLine(S(true, true, true)), serverLine(unreachable)), serverLine(unreachable));
  // With an answer the new line rules: back to green and the notice goes away.
  const back = holdDown(held, serverLine(S(true, true, true)));
  assert.deepEqual(back, { tone: 'ok', text: 'conectado' });
  assert.equal(mailDownShown(true, back), false);
  // Red that turns yellow (mail returns, bono issuing is missing): yellow, no notice.
  assert.equal(holdDown(red, serverLine(S(true, false, true))).tone, 'aviso');
});

test('noticeFocusSelectors: after the notice goes, the visible list title and, if it is hidden, the reader', () => {
  assert.deepEqual(noticeFocusSelectors('bandeja'), [`#${LIST_TITLE_ID}`, 'article.nm-lector']);
  assert.deepEqual(noticeFocusSelectors('archivo'), [`#${ARCHIVE_TITLE_ID}`, 'article.nm-lector']);
});

test('mailDownText(): short and without forbidden marks in the app texts', () => {
  assert.doesNotMatch(mailDownText(), /;|\/\/|—/);
  assert.ok(mailDownText().length <= 100, String(mailDownText().length));
});

test('partLine: each detail row is a green dot if it responds, red if not and grey without data', () => {
  assert.deepEqual(partLine(true), { tone: 'ok', text: 'responde' });
  assert.deepEqual(partLine(false), { tone: 'caido', text: 'no responde' });
  assert.deepEqual(partLine(null), { tone: 'sin', text: 'sin comprobar' });
  // While the first answer arrives, "comprobando" (no ellipsis: it is the word shown in the row).
  assert.deepEqual(partLine(null, true), { tone: 'espera', text: 'comprobando' });
  assert.deepEqual(partLine(true, true), { tone: 'ok', text: 'responde' });
});

const OK: StatusLineView = { tone: 'ok', text: 'conectado' };
const AVISO: StatusLineView = { tone: 'aviso', text: 'parcialmente disponible' };
const CAIDO: StatusLineView = { tone: 'caido', text: 'sin conexión' };
const ESPERA: StatusLineView = { tone: 'espera', text: 'comprobando…' };
const SIN: StatusLineView = { tone: 'sin', text: 'sin comprobar' };

test('serviceLine: red if something serious fails, yellow if only something minor, green if all works and grey when unknown', () => {
  assert.deepEqual(serviceLine(OK, OK), { tone: 'ok', text: 'operativo' });
  // Serious (Midnight or the mail or the whole server): red, even if the other part works or is not known yet.
  for (const [m, s] of [[CAIDO, CAIDO], [CAIDO, OK], [OK, CAIDO], [AVISO, CAIDO], [CAIDO, AVISO], [CAIDO, ESPERA], [ESPERA, CAIDO], [CAIDO, SIN]]) {
    assert.deepEqual(serviceLine(m, s), { tone: 'caido', text: 'no disponible' });
  }
  // A build without the Midnight component ("sin") and the server down: red.
  assert.deepEqual(serviceLine(SIN, CAIDO), { tone: 'caido', text: 'no disponible' });
  // Only something minor (proof server, bono issuing, address creation): yellow.
  for (const [m, s] of [[OK, AVISO], [AVISO, OK], [AVISO, AVISO], [ESPERA, AVISO], [SIN, AVISO], [AVISO, SIN]]) {
    assert.deepEqual(serviceLine(m, s), { tone: 'aviso', text: 'con incidencias' });
  }
  // With no problems in view, "operativo" only if both parts confirm it. Otherwise, grey.
  assert.deepEqual(serviceLine(OK, ESPERA), ESPERA);
  assert.deepEqual(serviceLine(SIN, ESPERA), ESPERA);
  assert.deepEqual(serviceLine(OK, SIN), SIN);
  assert.deepEqual(serviceLine(SIN, OK), SIN);
  assert.deepEqual(serviceLine(SIN, SIN), SIN);
});

test('the service status shows no words on hover: no `title` (and the screen reader does not hear it twice)', () => {
  const src = readFileSync(join(import.meta.dirname, '../src/screens/ServiceStatus.tsx'), 'utf8');
  assert.doesNotMatch(src, /\btitle=/);
});

test('the service status panel has no sentences: only names, dots and "Comprobar conexión"', () => {
  const src = readFileSync(join(import.meta.dirname, '../src/screens/ServiceStatus.tsx'), 'utf8');
  assert.doesNotMatch(src, /<p\b|role="alert"/);
});

test('overdue: grey at first, red after three unanswered checks, only if a response was expected', () => {
  assert.equal(ANSWER_LIMIT_MS, 90_000);
  const ready = { state: 'ready', sidecarVersion: '0.1.0' } as const;
  const RED = { tone: 'caido', text: 'sin respuesta' };
  // The server that does not answer, the Midnight check that does not arrive and the core that says nothing.
  for (const line of [serverLine({ ...S(true, true, true), failed: true }), serverLine(NO_DATA), midnightLine(ready, NO_DATA), midnightLine(null, NO_DATA)]) {
    assert.equal(overdue(line, false), line, 'before the deadline it stays grey');
    assert.deepEqual(overdue(line, true), RED);
  }
  // Neither the startup, nor the build without Midnight, nor what already has a colour change with the deadline.
  for (const line of [midnightLine({ state: 'notStarted' }, NO_DATA), midnightLine({ state: 'unavailable' }, NO_DATA), serverLine(S(true, true, true)), serverLine(S(true, false, true)), midnightLine(ready, H(false, true))]) {
    assert.equal(overdue(line, true), line);
  }
  // In the summary, an expired grey counts as serious.
  assert.equal(serviceLine(overdue(midnightLine({ state: 'unavailable' }, NO_DATA), true), overdue(serverLine(NO_DATA), true)).tone, 'caido');
});

/** A fake clock: `tick(ms)` advances time and fires what is due; `setStill` changes stillness and notifies. */
function fakeClock() {
  let t = 0;
  let quiet = false;
  let timers: { at: number; fn: () => void }[] = [];
  const watchers = new Set<() => void>();
  const env: OverdueEnv = {
    after(fn, ms) {
      const timer = { at: t + ms, fn };
      timers.push(timer);
      return () => {
        timers = timers.filter((x) => x !== timer);
      };
    },
    now: () => t,
    still: () => quiet,
    onStill(fn) {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
  };
  return {
    env,
    tick(ms: number) {
      t += ms;
      for (const timer of timers.filter((x) => x.at <= t)) {
        timers = timers.filter((x) => x !== timer);
        timer.fn();
      }
    },
    setStill(v: boolean) {
      quiet = v;
      watchers.forEach((fn) => fn());
    },
    pending: () => timers.length,
    watching: () => watchers.size,
  };
}

test('watchOverdue: expires after 90 s of active window, stops with the window still and continues on return', () => {
  const c = fakeClock();
  let fired = 0;
  watchOverdue(c.env, ANSWER_LIMIT_MS, () => fired++);
  c.tick(30_000);
  // The person goes to another window: nothing is checked, and the deadline does not run either.
  c.setStill(true);
  c.tick(10 * 60_000);
  assert.equal(fired, 0, 'still: it does not expire, however long it waits');
  // Back: 60 s of the 90 remain, it does not expire at once (no sudden red before the check on return).
  c.setStill(false);
  c.tick(59_000);
  assert.equal(fired, 0);
  c.tick(1_000);
  assert.equal(fired, 1);
  c.tick(ANSWER_LIMIT_MS);
  assert.equal(fired, 1, 'expires only once');
});

test('watchOverdue: with the window already still it does not start counting, and on stop it leaves nothing running', () => {
  const c = fakeClock();
  let fired = 0;
  c.setStill(true);
  const stop = watchOverdue(c.env, ANSWER_LIMIT_MS, () => fired++);
  c.tick(ANSWER_LIMIT_MS * 2);
  assert.equal(fired, 0);
  c.setStill(false);
  c.tick(ANSWER_LIMIT_MS - 1);
  // An answer arrives (or the reason changes): counting stops, with no timers or notices pending.
  stop();
  assert.equal(c.pending(), 0);
  assert.equal(c.watching(), 0);
  c.tick(ANSWER_LIMIT_MS);
  c.setStill(true);
  c.setStill(false);
  assert.equal(fired, 0);
});

test('waitReason: the deadline belongs to each wait reason (a silent core and "comprobando…" do not share a deadline)', () => {
  const ready = { state: 'ready', sidecarVersion: '0.1.0' } as const;
  const silent = waitReason(midnightLine(null, NO_DATA));
  const checking = waitReason(midnightLine(ready, NO_DATA));
  assert.notEqual(silent, null);
  assert.notEqual(checking, null);
  assert.notEqual(silent, checking);
  assert.notEqual(waitReason(serverLine(NO_DATA)), waitReason(serverLine({ ...S(true, true, true), failed: true })));
  for (const line of [midnightLine({ state: 'notStarted' }, NO_DATA), midnightLine({ state: 'unavailable' }, NO_DATA), serverLine(S(true, true, true))]) {
    assert.equal(waitReason(line), null);
  }
});

test('the service status panel checks on opening (not on closing) and keeps nothing after the response', () => {
  const src = readFileSync(join(import.meta.dirname, '../src/screens/ServiceStatus.tsx'), 'utf8');
  assert.match(src, /if \(!open\) void checkAllOnOpen\(\);\s*setOpen\(!open\);/);
  // Opening goes through `refresh` (running, just done, app locked); "Comprobar conexión" still uses `check`.
  const status = readFileSync(join(import.meta.dirname, '../src/serviceStatus.ts'), 'utf8');
  assert.match(status, /checkAllOnOpen = \(\) => Promise\.all\(\[health\.refresh\(OPEN_CHECK_AFTER_MS\), serverHealth\.refresh\(OPEN_CHECK_AFTER_MS\)\]\)/);
  assert.match(status, /checkAll = \(\) => Promise\.all\(\[health\.check\(\), serverHealth\.check\(\)\]\)/);
});
