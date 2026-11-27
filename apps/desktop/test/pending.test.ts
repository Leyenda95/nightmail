// Pure rules of the actions after an error: `node --test test/*.test.ts`.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PendingSlot } from '../src/bindings/PendingSlot.ts';
import type { OrchError } from '../src/bindings/OrchError.ts';
import type { ResumeReport } from '../src/bindings/ResumeReport.ts';
import {
  actionLabels,
  errorCode,
  inProcessText,
  pendingButton,
  pendingActions,
  pendingParts,
  IDLE_PASS,
  nextPass,
  passBusy,
  resumeNotice,
  rowActions,
  type PassStep,
  stoppedText,
  stopGenericText,
  stopReasonText,
  stillPendingText,
  withoutResume,
} from '../src/pending.ts';

const slot = (over: Partial<PendingSlot>): PendingSlot => ({
  slot: { n: 0, kind: 'mailbox', j: 0 },
  paused: false,
  inProgress: false,
  stopped: false,
  stopReason: null,
  abandonable: true,
  name: 'ana',
  ...over,
});

test('pendingActions: resume if paused, otherwise retry, abandon only if the core already allows it', () => {
  assert.deepEqual(pendingActions(slot({})), { resume: false, retry: true, abandon: true });
  assert.deepEqual(pendingActions(slot({ paused: true })), { resume: true, retry: false, abandon: true });
  assert.deepEqual(pendingActions(slot({ paused: true, abandonable: false })), { resume: true, retry: false, abandon: false });
  // With a proof that can still land, abandoning would give "todavía no": it is not offered.
  assert.deepEqual(pendingActions(slot({ abandonable: false })), { resume: false, retry: true, abandon: false });
  // With nothing running, never a row without any button.
  assert.deepEqual(pendingActions(slot({ inProgress: false, abandonable: false })), { resume: false, retry: true, abandon: false });
});

// While it is being created, "Reintentar" makes no sense (nothing has failed) and cancelling is not
// possible either (the operation has the turn): the row only says it is running.
test('pendingActions: no buttons while an operation holds it', () => {
  for (const paused of [false, true]) {
    assert.deepEqual(pendingActions(slot({ inProgress: true, paused })), { resume: false, retry: false, abandon: false });
  }
});

// "Reanudar" resets the attempts. Re-read midway through the operation, the slot comes out
// unpaused (and running): the row does not swap "Reanudar" for "Reintentar" nor offer to cancel.
test('rowActions: paused → "Reanudar" → reread unpaused: its buttons remain, without cancelling', () => {
  const paused = slot({ paused: true, abandonable: true });
  const frozen = pendingActions(paused);
  assert.deepEqual(frozen, { resume: true, retry: false, abandon: true });
  for (const reread of [slot({ paused: false, abandonable: true }), slot({ paused: false, inProgress: true })]) {
    assert.deepEqual(rowActions(reread, frozen), { resume: true, retry: false, abandon: false });
  }
  // With nothing frozen, whatever the list says.
  assert.deepEqual(rowActions(slot({ inProgress: true }), null), { resume: false, retry: false, abandon: false });
  assert.deepEqual(rowActions(slot({}), null), pendingActions(slot({})));
});

test('pendingParts: who, stage (capitalized heading), whether it is stopped and its state, separately for the row', () => {
  assert.deepEqual(pendingParts(slot({ name: 'juan.perez' })), {
    who: 'buzón juan.perez',
    what: 'buzón juan.perez',
    stage: 'Creando el buzón',
    stopped: false,
    state: inProcessText(),
  });
  const exhausted = slot({ slot: { n: 1, kind: 'alias', j: 2 }, paused: true, stopped: true, stopReason: { code: 'attemptsExhausted' } });
  assert.deepEqual(pendingParts(exhausted), {
    who: 'alias en creación',
    what: 'alias',
    stage: 'Creando el alias',
    stopped: true,
    state: 'detenido: tras varios intentos sin éxito',
  });
});

// "en proceso" if it will continue by itself (the app drives it or will retry), "detenido" if it needs the
// user. The core decides (`stopped`). With the attempts used up, why.
test('pendingParts: "en proceso" or "detenido", according to the core', () => {
  assert.equal(inProcessText(), 'en proceso');
  assert.equal(stoppedText(), 'detenido');
  assert.equal(pendingParts(slot({ inProgress: true })).state, inProcessText());
  assert.equal(pendingParts(slot({})).state, inProcessText(), 'the app will retry it by itself');
  assert.equal(
    pendingParts(slot({ stopped: true, paused: true, stopReason: { code: 'attemptsExhausted' } })).state,
    'detenido: tras varios intentos sin éxito',
  );
  // Resuming: the attempts no longer count as used up (the core does not mark it stopped).
  assert.equal(pendingParts(slot({ inProgress: true, paused: true })).state, inProcessText());
});

// Each stopped row says why, in a short text. What is not in the table, generic.
test('pendingParts: the stopped row says the reason the core gives', () => {
  const state = (stopReason: OrchError | null) => pendingParts(slot({ stopped: true, stopReason })).state;
  assert.equal(stoppedText(), 'detenido');
  assert.equal(state({ code: 'nameTaken' }), 'detenido: nombre ocupado');
  assert.equal(state({ code: 'nameRejected', reason: 'reserved' }), 'detenido: nombre no válido');
  assert.equal(state({ code: 'aliasSuffixTaken' }), 'detenido: terminación del alias ocupada');
  assert.equal(state({ code: 'relayerRefused' }), 'detenido: rechazado por el servicio de envío');
  assert.equal(state({ code: 'staleState' }), 'detenido: datos de Midnight atrasados');
  assert.equal(state({ code: 'clock' }), 'detenido: la hora del dispositivo no coincide');
  assert.equal(state({ code: 'contractMismatch' }), 'detenido: hace falta una versión nueva de la app');
  assert.equal(state({ code: 'sidecarTooOld' }), 'detenido: hace falta volver a instalar la app');
  assert.equal(state({ code: 'attemptsExhausted' }), 'detenido: tras varios intentos sin éxito');
  assert.equal(state({ code: 'needsName' }), 'detenido: falta el nombre');
  // Contract rejections: the clear ones by name, the rest "rechazado por Midnight".
  assert.equal(state({ code: 'callRejected', reason: 'slot-already-used' }), 'detenido: rechazado por Midnight');
  // "address-taken": the text depends on the slot kind.
  const taken: OrchError = { code: 'callRejected', reason: 'address-taken' };
  assert.equal(state(taken), 'detenido: nombre ocupado', 'mailbox');
  assert.equal(
    pendingParts(slot({ slot: { n: 0, kind: 'alias', j: 0 }, stopped: true, stopReason: taken })).state,
    'detenido: terminación del alias ocupada',
    'alias',
  );
  assert.equal(state({ code: 'callRejected', reason: 'not-a-bono' }), 'detenido: Midnight no reconoce el bono');
  assert.equal(state({ code: 'callRejected', reason: 'no-slots-left' }), 'detenido: no quedan huecos en el plan');
  assert.equal(state({ code: 'callRejected', reason: 'other' }), 'detenido: rechazado por Midnight');
  // Unknown or no reason: the generic one.
  assert.equal(stopGenericText(), 'no se pudo completar');
  assert.equal(state({ code: 'internal' }), 'detenido: no se pudo completar');
  assert.equal(state({ code: 'store' }), 'detenido: no se pudo completar');
  assert.equal(state({ code: 'rateLimited', retryAfterS: 5 }), 'detenido: no se pudo completar', 'it passes by itself');
  assert.equal(state(null), 'detenido: no se pudo completar');
  // Without stopping, no reason is given even if there were one.
  assert.equal(pendingParts(slot({ stopReason: { code: 'nameTaken' } })).state, inProcessText());
});

test('stopReasonText: short texts, without ";", "//" or "—"', () => {
  const reasons: (OrchError | null)[] = [
    null,
    { code: 'needsName' },
    { code: 'attemptsExhausted' },
    { code: 'nameTaken' },
    { code: 'nameRejected', reason: 'invalid' },
    { code: 'aliasSuffixTaken' },
    { code: 'relayerRefused' },
    { code: 'staleState' },
    { code: 'clock' },
    { code: 'contractMismatch' },
    { code: 'sidecarTooOld' },
    { code: 'callRejected', reason: 'not-a-bono' },
    { code: 'callRejected', reason: 'no-slots-left' },
    { code: 'callRejected', reason: 'address-taken' },
    { code: 'callRejected', reason: 'other' },
  ];
  for (const r of reasons) {
    for (const kind of ['mailbox', 'alias'] as const) {
      const text = stopReasonText(r, kind);
      assert.ok(text.length <= 40, text);
      assert.doesNotMatch(text, /;|\/\/|—/, text);
    }
  }
});

// "Cancelar" only appears when the store would already allow it, so the "todavía no"
// comes from the chain, which already has the attempt: it can never be cancelled, no deadline is promised.
test('stillPendingText: explains why it cannot be abandoned yet', () => {
  assert.match(stillPendingText('slot'), /^No se puede cancelar: su último intento ya ha llegado a Midnight o está a punto de hacerlo\./);
  assert.doesNotMatch(stillPendingText('slot'), /\d+ min/, 'does not promise a deadline');
  assert.match(stillPendingText('bono'), /puede completarse/);
  assert.doesNotMatch(stillPendingText('bono'), /\d+ min/, 'the deadline depends on the method: no false figure');
});

// Edge case: the text said "Reintentar" for a paused slot too, whose button is "Reanudar".
test('stillPendingText: names the button the row really has', () => {
  for (const paused of [false, true]) {
    const actions = pendingActions(slot({ paused }));
    const shown = actions.resume ? pendingButton().resume : pendingButton().retry;
    const hidden = actions.resume ? pendingButton().retry : pendingButton().resume;
    const text = stillPendingText('slot', paused);
    // Buttons go without quotes.
    assert.ok(text.endsWith(`Termínalo con el botón ${shown}.`), `paused ${paused}: names "${shown}"`);
    assert.doesNotMatch(text, /[«»]/);
    assert.ok(!text.includes(hidden), `paused ${paused}: does not name "${hidden}"`);
    assert.match(text, /ya ha llegado a Midnight o está a punto de hacerlo/);
  }
  assert.equal(pendingButton().resume, 'Reanudar');
  assert.equal(pendingButton().retry, 'Reintentar');
  // Whoever does not state the state (today's screen) gets a text that works for both buttons.
  const either = stillPendingText('slot');
  assert.ok(either.includes('con el botón Reintentar (o con el botón Reanudar,'));
  assert.doesNotMatch(either, /[«»]/);
  assert.match(either, /si se detuvo tras varios intentos/);
  // A bono's does not name any button of the slot row.
  assert.doesNotMatch(stillPendingText('bono', true), /Reintentar|Reanudar/);
});

// Each button says which row it belongs to, starting with its visible text.
test('actionLabels: the visible text and the row', () => {
  assert.deepEqual(actionLabels('buzón ana'), {
    resume: 'Reanudar el buzón ana',
    retry: 'Reintentar el buzón ana',
    abandon: 'Cancelar la creación del buzón ana',
  });
  assert.equal(actionLabels(pendingParts(slot({ slot: { n: 2, kind: 'alias', j: 20 } })).what).retry, 'Reintentar el alias');
});

test('errorCode: only from objects with a string `code`', () => {
  assert.equal(errorCode({ code: 'staleState' }), 'staleState');
  assert.equal(errorCode({ code: 3 }), null);
  assert.equal(errorCode('staleState'), null);
  assert.equal(errorCode(null), null);
});

const report = (over: Partial<ResumeReport>): ResumeReport => ({
  bonosIncluded: 0,
  bonosError: null,
  addresses: 0,
  needsName: [],
  failed: [],
  ...over,
});
const failure = (error: OrchError) => ({ slot: { n: 0, kind: 'alias' as const, j: 0 }, error });

test('resumeNotice: an empty report clears the notice, the `busy` of the bonos is not shown', () => {
  assert.equal(resumeNotice(null, null).show, false);
  assert.equal(resumeNotice(report({}), null).show, false);
  assert.equal(resumeNotice(report({ bonosError: { code: 'busy' } }), null).show, false);
  assert.equal(resumeNotice(report({ bonosError: { code: 'serviceUnavailable' } }), null).show, true);
  assert.equal(resumeNotice(report({ failed: [failure({ code: 'serviceUnavailable' })] }), null).show, true);
  assert.equal(resumeNotice(null, { code: 'midnightUnavailable' }).show, true);
});

test('resumeNotice: with `staleState` it offers "Volver a sincronizar" (L2)', () => {
  assert.equal(resumeNotice(report({ failed: [failure({ code: 'serviceUnavailable' })] }), null).stale, false);
  assert.equal(resumeNotice(report({ failed: [failure({ code: 'staleState' })] }), null).stale, true);
  assert.equal(resumeNotice(report({ bonosError: { code: 'staleState' } }), null).stale, true);
  assert.equal(resumeNotice(null, { code: 'staleState' }).stale, true);
});

test('withoutResume: locking forgets the `resume` notice and its running pass', () => {
  const state = {
    resume: report({ failed: [failure({ code: 'busy' })] }),
    resumeError: { code: 'store' } as OrchError,
    resumePass: { asked: true, running: true },
    syncTick: 3,
  };
  assert.deepEqual(withoutResume(state), { resume: null, resumeError: null, resumePass: IDLE_PASS, syncTick: 3 });
});

const passAfter = (...steps: PassStep[]) => steps.reduce(nextPass, IDLE_PASS);

// After "Reintentar ahora" the notice kept the same button while the row was already running. It happened if pressed with
// a pass already running: its result cleared the "Reintentando..." and another one started.
test('nextPass: "Reintentar ahora" stays busy from the press until the result of its pass', () => {
  assert.equal(passBusy(IDLE_PASS), false);
  assert.equal(passBusy(passAfter('asked')), true, 'as soon as it is pressed, before the pass starts');
  assert.equal(passBusy(passAfter('asked', 'started')), true);
  assert.equal(passBusy(passAfter('asked', 'started', 'finished')), false, 'with the result, the new one is shown');
});

test("nextPass: pressed during another pass, that pass's result does not end it", () => {
  const during = passAfter('started', 'asked', 'finished');
  assert.equal(passBusy(during), true, 'the core runs another pass for the request');
  assert.equal(passBusy(nextPass(during, 'started')), true);
  assert.equal(passBusy(passAfter('started', 'asked', 'finished', 'started', 'finished')), false);
});

test('nextPass: a pass nobody asked for (background) also shows as busy', () => {
  assert.equal(passBusy(passAfter('started')), true);
  assert.equal(passBusy(passAfter('started', 'finished')), false);
});

test('nextPass: if the request does not reach the core, it does not stay busy', () => {
  assert.equal(passBusy(passAfter('asked', 'askFailed')), false);
  assert.equal(passBusy(passAfter('started', 'asked', 'askFailed')), true, 'the previous pass continues');
  // A result with no start (it should not arrive) leaves nothing hanging.
  assert.equal(passBusy(passAfter('asked', 'finished')), false);
});
