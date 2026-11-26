// "Direcciones" page: `node --test test/*.test.ts`.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { abandonButton, abandonNote, abandonedText, abandonedNote, abandonLabel, abandonTexts, explainAfterSync, NO_PENDING_VIEW, nextPendingView, pendingTag, quotaNotice, seeMailLabel, slotsLeft } from '../src/addresses.ts';
import type { BonoView } from '../src/bindings/BonoView.ts';
import type { PendingSlot } from '../src/bindings/PendingSlot.ts';
import type { PlanView } from '../src/bindings/PlanView.ts';
import { formatDay, mailDomain, slotKindTitle } from '../src/format.ts';
import { focusSelector, navigate, NEW_NAME_ID, START } from '../src/nav.ts';

// Confirmed: the plan name only counts the bonos in the tree (`planKind`).
const bono = (paid: boolean) => ({ paid, included: true }) as BonoView;
const plan = (bonos: BonoView[], m: [number, number], a: [number, number]): PlanView => ({
  bonos,
  mailboxes: { used: m[0], limit: m[1] },
  aliases: { used: a[0], limit: a[1] },
});

test('formatDay: day, short month and year, in local time', () => {
  assert.equal(formatDay(new Date(2026, 10, 18, 23, 59).getTime() / 1000), '18 nov 2026');
  assert.equal(formatDay(new Date(2025, 0, 1, 0, 0).getTime() / 1000), '1 ene 2025');
});

test('slotKindTitle: "Buzón" or "Alias"', () => {
  assert.equal(slotKindTitle({ kind: 'mailbox' }), 'Buzón');
  assert.equal(slotKindTitle({ kind: 'alias' }), 'Alias');
});

test('mailDomain: the domain of the newest named address, with none null (never a made-up one)', () => {
  assert.equal(mailDomain([{ display: '' }, { display: 'juan@correo.example' }]), 'correo.example');
  assert.equal(mailDomain([{ display: 'vieja@antes.example' }, { display: 'nueva@ahora.example' }, { display: '' }]), 'ahora.example');
  assert.equal(mailDomain([]), null);
  assert.equal(mailDomain([{ display: '' }]), null);
  assert.equal(mailDomain([{ display: 'sin-arroba' }, { display: '@solo' }, { display: 'roto@' }]), null);
});

test('slotsLeft: free slots of a quota, never negative', () => {
  assert.equal(slotsLeft({ used: 1, limit: 5 }), 4);
  assert.equal(slotsLeft({ used: 3, limit: 2 }), 0);
});

test('quotaNotice: only with no free slot left, without a plan it invites choosing one, without reading the plan nothing', () => {
  assert.equal(quotaNotice(null), null);
  assert.equal(quotaNotice(plan([bono(false)], [1, 1], [1, 2])), null);
  assert.equal(quotaNotice(plan([bono(false)], [0, 1], [2, 2])), null);
  assert.equal(quotaNotice(plan([bono(false)], [1, 1], [2, 2])), 'No te quedan huecos libres en tu plan gratis (1 buzón y 2 alias).');
  assert.equal(quotaNotice(plan([bono(true)], [5, 5], [20, 20])), 'No te quedan huecos libres en tu plan Night Plus (5 buzones y 20 alias).');
  assert.equal(quotaNotice(plan([], [0, 0], [0, 0])), 'Aún no tienes plan: elige uno para poder crear direcciones.');
});

test('explainAfterSync: creating already synced again on its own, so staleState asks to wait and names no button', () => {
  const text = explainAfterSync('staleState');
  assert.equal(
    text,
    'Los datos que llegan de Midnight siguen atrasados o no cuadran, aunque la app ya ha vuelto a sincronizar. ' +
      'Vuelve a intentarlo dentro de unos minutos.',
  );
  assert.doesNotMatch(text ?? '', /Vuelve a sincronizar/);
  // Any other error keeps its usual text.
  for (const code of [null, 'nameTaken', 'midnightUnavailable', 'stillPending']) assert.equal(explainAfterSync(code), null, String(code));
});

test('pendingTag: "N en proceso", or nothing if there are none', () => {
  assert.equal(pendingTag({ total: 2, stopped: 0 }), '2 en proceso');
  assert.equal(pendingTag({ total: 1, stopped: 0 }), '1 en proceso');
  assert.equal(pendingTag({ total: 0, stopped: 0 }), null);
});

test('pendingTag: if some are stopped, "N detenidas" (singular "1 detenida"), even if others are still in progress', () => {
  assert.equal(pendingTag({ total: 2, stopped: 2 }), '2 detenidas');
  assert.equal(pendingTag({ total: 1, stopped: 1 }), '1 detenida');
  // Mixed: "detenidas" wins and only the stopped ones count.
  assert.equal(pendingTag({ total: 3, stopped: 1 }), '1 detenida');
  assert.equal(pendingTag({ total: 5, stopped: 2 }), '2 detenidas');
});

test('"Nueva dirección" (the sidebar "+"): the addresses page with focus on the name, every time it is pressed', () => {
  for (const layout of ['tres', 'dos'] as const) {
    const first = navigate(START, { type: 'new' }, layout);
    assert.equal(first.view, 'direcciones', layout);
    assert.deepEqual(first.focus, { to: 'nombre' }, layout);
    // A new focus (another object) even though it was already there: Main's effect sets it again.
    assert.notEqual(navigate(first, { type: 'new' }, layout).focus, first.focus, layout);
    // The open message and the filter do not change: on returning to the inbox they are still there.
    const reading = navigate(navigate(START, { type: 'open', id: 3 }, layout), { type: 'new' }, layout);
    assert.equal(reading.openId, 3, layout);
  }
  assert.equal(focusSelector({ to: 'nombre' }), `#${NEW_NAME_ID}`);
});

test('"Abandonar": the dialog with only two sentences, the button, the abandoned notice and the note', () => {
  const t = abandonTexts();
  assert.equal(t.title, '¿Abandonar esta dirección?');
  assert.deepEqual(t.body, [
    'Esta operación no se puede deshacer.',
    'El hueco de tu plan no se libera y nadie podrá volver a registrar esta dirección, tampoco tú.',
  ]);
  assert.equal(t.no, 'Cancelar');
  assert.equal(t.yes, 'Abandonar dirección');
  assert.equal(abandonButton(), 'Abandonar');
  assert.equal(abandonedText(), 'Dirección abandonada.');
  assert.equal(abandonNote(), 'Al abandonar una dirección, el hueco de tu plan no se libera.');
});

test('abandonedNote: how many are abandoned in a plan quota, masculine like "buzón" and "alias"', () => {
  assert.equal(abandonedNote(0), null);
  assert.equal(abandonedNote(1), '(1 abandonado)');
  assert.equal(abandonedNote(2), '(2 abandonados)');
});

test('seeMailLabel and abandonLabel: each row button says which address it belongs to', () => {
  assert.equal(seeMailLabel('ana@nightmail.test'), 'Ver correo de ana@nightmail.test');
  assert.equal(abandonLabel('ana@nightmail.test'), 'Abandonar ana@nightmail.test');
});

test('nextPendingView: count and slots of the list, without changes the same view (no repaint)', () => {
  const row = (j: number, stopped = false) => ({ slot: { n: 0, kind: 'alias' as const, j }, stopped }) as PendingSlot;
  const one = nextPendingView(NO_PENDING_VIEW, [row(3), row(4, true)]);
  assert.deepEqual(one, { count: { total: 2, stopped: 1 }, slots: [{ n: 0, kind: 'alias', j: 3 }, { n: 0, kind: 'alias', j: 4 }] });
  assert.equal(nextPendingView(one, [row(3), row(4, true)]), one);
  // Another slot with the same count does change the view: the `resume` notice depends on which ones they are.
  assert.deepEqual(nextPendingView(one, [row(3), row(5, true)]).slots, [{ n: 0, kind: 'alias', j: 3 }, { n: 0, kind: 'alias', j: 5 }]);
  // With the list unreadable: count zero and unknown slots.
  assert.deepEqual(nextPendingView(one, null), NO_PENDING_VIEW);
  assert.equal(nextPendingView(NO_PENDING_VIEW, null), NO_PENDING_VIEW);
  assert.deepEqual(nextPendingView(NO_PENDING_VIEW, []), { count: { total: 0, stopped: 0 }, slots: [] });
});
