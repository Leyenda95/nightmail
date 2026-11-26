// "Plan y cartera" page: which plan is shown and how each bono is labelled.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BonoView } from '../src/bindings/BonoView.ts';
import { bonoParts, offerTitle, planKind } from '../src/payment.ts';

const bono = (paid: boolean, included: boolean, usableAt: number | null = null): BonoView => ({ n: 1, k: paid ? 1 : 0, paid, included, usableAt });

test('without confirmed bonos there is no plan, a pending payment does not change it yet', () => {
  assert.equal(planKind([]), 'none');
  assert.equal(planKind([bono(false, false)]), 'none');
  assert.equal(planKind([bono(true, false)]), 'none');
  assert.equal(planKind([bono(false, true)]), 'free');
  assert.equal(planKind([bono(false, true), bono(true, false)]), 'free');
  assert.equal(planKind([bono(false, true), bono(true, true)]), 'paid');
});

test('the offer: choose without a plan, switch to paid with the free one and, with the paid one, folded (no title)', () => {
  assert.equal(offerTitle('none'), 'Elige un plan');
  assert.equal(offerTitle('free'), 'Pasar al plan de pago');
  assert.equal(offerTitle('paid'), null);
});

test('a confirmed bono: title without counters, no tag and nothing to abandon', () => {
  const p = bonoParts(bono(true, true), 1000);
  assert.equal(p.kind, 'de pago');
  assert.equal(p.title, 'Bono de pago');
  assert.equal(p.state, null);
  assert.equal(p.srOnly, 'Confirmado.');
  assert.equal(p.tone, 'exito');
  assert.equal(p.icon, 'checkmark-circle');
  assert.equal(p.abandon, null);
});

// The button says "Cancelar". The dialog says what is cancelled.
test('a pending bono: "pendiente", the "Cancelar" button and its dialog depending on payment or request', () => {
  const paid = bonoParts(bono(true, false), 1000);
  assert.equal(paid.state, 'pendiente');
  assert.equal(paid.tone, 'atencion');
  assert.equal(paid.icon, 'espera');
  assert.deepEqual(paid.abandon, {
    button: 'Cancelar',
    label: 'Cancelar el pago pendiente del bono de pago',
    title: '¿Cancelar este pago pendiente?',
    note: 'Si ya se pagó y aún puede completarse, no se podrá cancelar.',
    yes: 'Sí, cancelar el pago',
  });
  const free = bonoParts(bono(false, false), 1000);
  assert.equal(free.kind, 'gratis');
  assert.equal(free.title, 'Bono gratis');
  assert.deepEqual(free.abandon, {
    button: 'Cancelar',
    label: 'Cancelar la petición pendiente del bono gratis',
    title: '¿Cancelar esta petición pendiente?',
    note: 'Si la petición ya se aceptó y aún puede completarse, no se podrá cancelar.',
    yes: 'Sí, cancelar la petición',
  });
});

test('"se podrá usar a partir del…" only if the time is in the future', () => {
  assert.equal(bonoParts(bono(false, true, 900), 1000).wait, null);
  assert.equal(bonoParts(bono(false, true, null), 1000).wait, null);
  assert.match(bonoParts(bono(false, true, 2000), 1000).wait ?? '', /^Se podrá usar a partir del \d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}$/);
});
