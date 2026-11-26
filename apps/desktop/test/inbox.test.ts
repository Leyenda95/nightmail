// Inbox: short date, filter by address, unread, heading, empty states and keyboard. `node --test test/*.test.ts`.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { AddressView } from '../src/bindings/AddressView.ts';
import type { MessageView } from '../src/bindings/MessageView.ts';
import { formatShortDate } from '../src/format.ts';
import { unreadBadge } from '../src/sidebar.ts';
import { archiveHeading, cappedNote, emptyState, firstUseSteps, isCapped, MESSAGE_PAGE_MAX, focusOrphaned, headingFor, inAddress, listHeading, recipientText, stepRow, unreadCounts } from '../src/inbox.ts';

const secs = (d: Date) => Math.floor(d.getTime() / 1000);
// Friday 20 November 2026, 12:00 (local time).
const NOW = new Date(2026, 10, 20, 12, 0);

test('formatShortDate: today the time, yesterday, weekday, day and month, and the year if not this one', () => {
  assert.equal(formatShortDate(secs(new Date(2026, 10, 20, 10, 42)), NOW), '10:42');
  assert.equal(formatShortDate(secs(new Date(2026, 10, 20, 0, 5)), NOW), '00:05');
  assert.equal(formatShortDate(secs(new Date(2026, 10, 19, 23, 59)), NOW), 'ayer');
  assert.equal(formatShortDate(secs(new Date(2026, 10, 16, 9, 0)), NOW), 'lun');
  assert.equal(formatShortDate(secs(new Date(2026, 10, 14, 9, 0)), NOW), 'sáb');
  assert.equal(formatShortDate(secs(new Date(2026, 10, 13, 9, 0)), NOW), '13 nov');
  assert.equal(formatShortDate(secs(new Date(2026, 0, 3, 9, 0)), NOW), '3 ene');
  assert.equal(formatShortDate(secs(new Date(2025, 10, 20, 9, 0)), NOW), '20 nov 2025');
});

test('formatShortDate: a future date (sender clock ahead) says neither "ayer" nor a weekday', () => {
  assert.equal(formatShortDate(secs(new Date(2026, 10, 20, 18, 0)), NOW), '18:00');
  assert.equal(formatShortDate(secs(new Date(2026, 10, 22, 9, 0)), NOW), '22 nov');
  assert.equal(formatShortDate(secs(new Date(2027, 0, 2, 9, 0)), NOW), '2 ene 2027');
});

const msg = (id: number, addrKey: string, isRead: boolean): MessageView => ({
  id,
  addrKey,
  receivedAt: 0,
  from: null,
  subject: null,
  sentAt: null,
  preview: null,
  isRead,
  starred: false,
  archived: false,
  deleted: false,
});
const MSGS = [msg(5, 'aa', false), msg(4, 'bb', false), msg(3, 'aa', true), msg(2, 'cc', false)];

const addr = (addrKey: string, display: string, kind: 'mailbox' | 'alias' = 'alias'): AddressView => ({
  addrKey,
  slot: { n: 1, kind, j: 0 },
  display,
  name: null,
  createdAt: 0,
});
const BUZON = addr('aa', 'juan.perez2@nightmail.local', 'mailbox');
const ALIAS = addr('bb', 'around.rubber@nightmail.local');
const SIN_NOMBRE = addr('cc', '', 'mailbox');

test('inAddress: without a filter all in their order, with a filter only those of that address', () => {
  assert.deepEqual(inAddress(MSGS, null), MSGS);
  assert.deepEqual(
    inAddress(MSGS, 'aa').map((m) => m.id),
    [5, 3],
  );
  assert.deepEqual(inAddress(MSGS, 'zz'), []);
});

test('unreadCounts: the total and per address, those with none do not appear', () => {
  const u = unreadCounts(MSGS);
  assert.equal(u.total, 3);
  assert.deepEqual(u.byAddr, { aa: 1, bb: 1, cc: 1 });
  assert.deepEqual(unreadCounts([msg(1, 'aa', true)]), { total: 0, byAddr: {} });
});

test("listHeading: the unified inbox, and an address's one with its domain and kind", () => {
  assert.deepEqual(listHeading(null, 3), { title: 'Bandeja de entrada', sub: '3 sin leer · todas tus direcciones', mono: false });
  assert.deepEqual(listHeading(null, 0), { title: 'Bandeja de entrada', sub: 'todas tus direcciones', mono: false });
  assert.deepEqual(listHeading(ALIAS, 2), { title: 'around.rubber', sub: '@nightmail.local · alias · 2 sin leer', mono: true });
  assert.deepEqual(listHeading(BUZON, 0), { title: 'juan.perez2', sub: '@nightmail.local · buzón', mono: true });
  assert.deepEqual(listHeading(SIN_NOMBRE, 1), { title: 'buzón sin nombre', sub: '1 sin leer', mono: false });
});

test("headingFor: without a filter the total, with a filter the address's, an address not yet known gives the inbox", () => {
  const u = unreadCounts(MSGS);
  assert.equal(headingFor(null, [BUZON], u).sub, '3 sin leer · todas tus direcciones');
  assert.equal(headingFor('aa', [BUZON, ALIAS], u).sub, '@nightmail.local · buzón · 1 sin leer');
  assert.equal(headingFor('bb', null, u).title, 'Bandeja de entrada');
});

test('recipientText: the address that received it, as in the sidebar, unknown gives nothing', () => {
  assert.equal(recipientText('bb', [BUZON, ALIAS]), 'around.rubber@');
  assert.equal(recipientText('cc', [SIN_NOMBRE]), 'buzón sin nombre');
  assert.equal(recipientText('zz', [BUZON]), null);
});

test('emptyState: with messages or without knowing the addresses yet, none', () => {
  assert.equal(emptyState(2, [BUZON], null), null);
  assert.equal(emptyState(0, null, null), null);
});

test('emptyState: with the restore unfinished, its empty state (also without knowing the addresses), with messages none', () => {
  assert.deepEqual(emptyState(0, null, null, { restoring: true }), { kind: 'restauracion-pendiente' });
  assert.deepEqual(emptyState(0, [BUZON], null, { restoring: true }), { kind: 'restauracion-pendiente' });
  assert.equal(emptyState(2, [BUZON], null, { restoring: true }), null);
});

test('emptyState: without addresses the first use, with some the empty inbox with the address that can be given out', () => {
  assert.deepEqual(emptyState(0, [], null), { kind: 'primer-uso' });
  assert.deepEqual(emptyState(0, [BUZON], null), { kind: 'vacia', address: BUZON, archived: false });
  assert.deepEqual(emptyState(0, [BUZON, ALIAS], 'bb'), { kind: 'vacia', address: ALIAS, archived: false });
  // Several and no filter: there is no single address to show.
  assert.deepEqual(emptyState(0, [BUZON, ALIAS], null), { kind: 'vacia', address: null, archived: false });
  // An address with no name cannot be handed out.
  assert.deepEqual(emptyState(0, [SIN_NOMBRE], null), { kind: 'vacia', address: null, archived: false });
});

test('stepRow: arrows to the next row, Home and End to the ends, outside the list or without rows nothing', () => {
  const ids = [5, 4, 3];
  assert.equal(stepRow(ids, 4, 'ArrowDown'), 3);
  assert.equal(stepRow(ids, 4, 'ArrowUp'), 5);
  assert.equal(stepRow(ids, 3, 'ArrowDown'), null);
  assert.equal(stepRow(ids, 5, 'ArrowUp'), null);
  assert.equal(stepRow(ids, 4, 'Home'), 5);
  assert.equal(stepRow(ids, 4, 'End'), 3);
  assert.equal(stepRow(ids, 4, 'Enter'), null);
  // From the region (no row with focus): the first with down or Home, the last with up or End.
  assert.equal(stepRow(ids, null, 'ArrowDown'), 5);
  assert.equal(stepRow(ids, null, 'ArrowUp'), 3);
  assert.equal(stepRow([], null, 'ArrowDown'), null);
});

test('focusOrphaned: only if focus has fallen to <body> (or nowhere), never if it is elsewhere', () => {
  const body = {};
  assert.equal(focusOrphaned(body, body), true);
  assert.equal(focusOrphaned(null, body), true);
  assert.equal(focusOrphaned({}, body), false);
});

test('archiveHeading: "Archivo" and how many there are, nothing while they load', () => {
  assert.deepEqual(archiveHeading(2), { title: 'Archivo', sub: '2 mensajes archivados', mono: false });
  assert.equal(archiveHeading(1).sub, '1 mensaje archivado');
  assert.equal(archiveHeading(0).sub, 'Ningún mensaje archivado');
  assert.equal(archiveHeading(null).sub, '');
});

test('inbox badge: the number and, past 99, "99+"', () => {
  assert.equal(unreadBadge(2), '2');
  assert.equal(unreadBadge(99), '99');
  assert.equal(unreadBadge(100), '99+');
});

test('emptyState: if everything there was got archived, it says so (for that address, or for any without a filter)', () => {
  const arch = [{ addrKey: 'bb' }];
  assert.deepEqual(emptyState(0, [BUZON, ALIAS], null, { archived: arch }), { kind: 'vacia', address: null, archived: true });
  assert.deepEqual(emptyState(0, [BUZON, ALIAS], 'bb', { archived: arch }), { kind: 'vacia', address: ALIAS, archived: true });
  // Archived, but from another address: from this one nothing ever arrived.
  assert.deepEqual(emptyState(0, [BUZON, ALIAS], BUZON.addrKey, { archived: arch }), { kind: 'vacia', address: BUZON, archived: false });
  assert.deepEqual(emptyState(0, [BUZON], null, { archived: [] }), { kind: 'vacia', address: BUZON, archived: false });
});

test('emptyState: with the filter and the read cut by the cap, it does not claim there is no mail', () => {
  assert.deepEqual(emptyState(0, [BUZON, ALIAS], 'bb', { read: MESSAGE_PAGE_MAX }), { kind: 'recortada', address: ALIAS });
  // Without a filter, zero rows is truly zero; with the read below the cap, too.
  assert.equal(emptyState(0, [BUZON], null, { read: MESSAGE_PAGE_MAX })?.kind, 'vacia');
  assert.equal(emptyState(0, [BUZON, ALIAS], 'bb', { read: MESSAGE_PAGE_MAX - 1 })?.kind, 'vacia');
  assert.equal(emptyState(3, [BUZON, ALIAS], 'bb', { read: MESSAGE_PAGE_MAX }), null);
});

test("isCapped and cappedNote: the notice appears at exactly the cap, the cap is the core's (`MAX_PAGE`)", () => {
  assert.equal(isCapped(MESSAGE_PAGE_MAX), true);
  assert.equal(isCapped(MESSAGE_PAGE_MAX - 1), false);
  assert.equal(isCapped(null), false);
  assert.equal(cappedNote(), 'Se ven los 500 mensajes más recientes.');
  const rust = readFileSync(new URL('../src-tauri/src/app/views.rs', import.meta.url), 'utf8');
  assert.equal(Number(/pub const MAX_PAGE: u32 = (\d+);/.exec(rust)?.[1]), MESSAGE_PAGE_MAX);
});

test('firstUseSteps: without a plan only "Elegir un plan", with one step 1 done and only "Crear una dirección"', () => {
  assert.deepEqual(firstUseSteps('none'), { planDone: false, button: 'plan' });
  assert.deepEqual(firstUseSteps('free'), { planDone: true, button: 'address' });
  assert.deepEqual(firstUseSteps('paid'), { planDone: true, button: 'address' });
  // Not known yet: no button, so the wrong one never flashes.
  assert.deepEqual(firstUseSteps(null), { planDone: false, button: null });
  // The screen shows a single button, the one of the step missing, and a check mark (with its words) on the step done.
  const tsx = readFileSync(new URL('../src/screens/Inbox.tsx', import.meta.url), 'utf8');
  const first = tsx.slice(tsx.indexOf('function FirstUse'), tsx.indexOf('export function InboxEmpty'));
  assert.match(first, /button === 'plan' \?/);
  // A plan read that never answers still ends with "Elegir un plan".
  assert.match(first, /setTimeout\(\(\) => setPlan\(\(p\) => p \?\? 'none'\), FIRST_USE_WAIT_MS\)/);
  assert.match(first, /<Icon name="checkmark"/);
  assert.match(first, /<span className="sr-only">\{words\.stepDone\} <\/span>/);
});
