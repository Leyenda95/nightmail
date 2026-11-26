// Text of the global notice "no se ha podido terminar lo pendiente": `node --test test/*.test.ts`.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OrchError } from '../src/bindings/OrchError.ts';
import type { ResumeReport } from '../src/bindings/ResumeReport.ts';
import { errorParts } from '../src/errors.ts';
import { resumeBusy, resumeTitle, resumeSummary, serverBackText, serverDownText } from '../src/notices.ts';

const report = (over: Partial<ResumeReport>): ResumeReport => ({ bonosIncluded: 0, bonosError: null, addresses: 0, needsName: [], failed: [], ...over });
const failure = (error: OrchError, n = 1) => ({ slot: { n, kind: 'mailbox' as const, j: 1 }, error });
const down: OrchError = { code: 'serviceUnavailable' };

test('resumeSummary: nothing to show if there are no failures (an empty report clears the notice)', () => {
  assert.equal(resumeSummary(null, null), null);
  assert.equal(resumeSummary(report({}), null), null);
  assert.equal(resumeSummary(report({ bonosError: { code: 'busy' } }), null), null);
});

test('resumeSummary: a general failure tells only "what happened", without the other two parts', () => {
  const s = resumeSummary(null, { code: 'midnightUnavailable' });
  assert.ok(s);
  assert.equal(s.cause, errorParts({ code: 'midnightUnavailable' }).what);
  assert.equal(s.cause, 'Ahora mismo no hay conexión con Midnight.');
  assert.deepEqual(s.lines, []);
  assert.equal(s.stale, false);
});

test('resumeSummary: each unfinished slot, with its label and only "what happened"', () => {
  const s = resumeSummary(report({ failed: [failure(down, 1), failure({ code: 'midnightUnavailable' }, 2)] }), null);
  assert.ok(s);
  assert.equal(s.cause, null);
  assert.deepEqual(
    s.lines.map((l) => [l.key, l.label, l.mono, l.text]),
    [
      [`mailbox|${errorParts(down).what}`, 'Un buzón', false, `sin terminar: ${errorParts(down).what}`],
      ['mailbox|Ahora mismo no hay conexión con Midnight.', 'Un buzón', false, 'sin terminar: Ahora mismo no hay conexión con Midnight.'],
    ],
  );
  for (const l of s.lines) assert.equal(l.text.includes(errorParts(down).action), false);
});

test('resumeSummary: unchecked bonos are one more line, `busy` does not count', () => {
  const s = resumeSummary(report({ bonosError: down }), null);
  assert.ok(s);
  assert.deepEqual(s.lines, [{ key: 'bonos', label: 'Bonos pendientes', mono: false, text: `sin comprobar: ${errorParts(down).what}` }]);
});

test('resumeSummary: with `staleState` anywhere it offers "Volver a sincronizar"', () => {
  assert.equal(resumeSummary(null, { code: 'staleState' })?.stale, true);
  assert.equal(resumeSummary(report({ failed: [failure({ code: 'staleState' })] }), null)?.stale, true);
  assert.equal(resumeSummary(report({ failed: [failure(down)] }), null)?.stale, false);
});

// Regression: the notice kept saying an alias was "sin terminar: El servicio no está disponible ahora mismo" when that
// same alias had already been created (creating an alias resumes the half-done slot).
test('resumeSummary: a slot that is no longer unfinished does not appear (it finished or was cancelled another way)', () => {
  const r = report({ failed: [failure(down, 1), failure(down, 2)] });
  const s = resumeSummary(r, null, [{ n: 2, kind: 'mailbox', j: 1 }]);
  assert.ok(s);
  assert.deepEqual(s.lines.map((l) => l.key), [`mailbox|${errorParts(down).what}`]);
  // With none half-done and no other failure, there is nothing left to report.
  assert.equal(resumeSummary(r, null, []), null);
  // The same number of another kind is not the same slot.
  assert.equal(resumeSummary(r, null, [{ n: 1, kind: 'alias', j: 1 }]), null);
  // Unknown list (not read yet or could not be read): everything is shown.
  assert.equal(resumeSummary(r, null, null)?.lines.length, 1, 'same cause: one line with its count');
  assert.equal(resumeSummary(r, null, null)?.lines[0]?.label, '2 buzones');
  // A general or bono failure still shows even if no slot remains half-done.
  assert.equal(resumeSummary(r, { code: 'midnightUnavailable' }, [])?.cause, 'Ahora mismo no hay conexión con Midnight.');
  assert.equal(resumeSummary(report({ bonosError: down }), null, [])?.lines.length, 1);
});

test('resumeSummary: slots of the same kind and cause go on one line with their count, different causes apart', () => {
  const alias = (j: number, error: OrchError) => ({ slot: { n: 0, kind: 'alias' as const, j }, error });
  const s = resumeSummary(report({ failed: [alias(1, down), alias(2, down), alias(3, { code: 'midnightUnavailable' }), failure(down)] }), null);
  assert.ok(s);
  assert.deepEqual(
    s.lines.map((l) => [l.label, l.text]),
    [
      ['2 alias', `sin terminar: ${errorParts(down).what}`],
      ['Un alias', 'sin terminar: Ahora mismo no hay conexión con Midnight.'],
      ['Un buzón', `sin terminar: ${errorParts(down).what}`],
    ],
  );
});

// "se han agotado los intentos" and the whole notice were misunderstood. It says what happened
// and what to do, without the word "agotado".
test('resumeSummary: the title says it could not finish, without "retomar"', () => {
  assert.equal(resumeTitle(), 'No se ha podido terminar lo pendiente.');
  // While retrying, without "lo pendiente".
  assert.equal(resumeBusy(), 'Reintentando.');
});

test('resumeSummary: a slot stopped after several attempts says how to try again ("Reanudar")', () => {
  const s = resumeSummary(report({ failed: [failure({ code: 'attemptsExhausted' })] }), null);
  assert.ok(s);
  assert.deepEqual(s.lines.map((l) => [l.label, l.text]), [
    [
      'Un buzón',
      'sin terminar: La dirección se ha detenido después de varios intentos. Para volver a intentarlo, pulsa ' +
        'Reanudar en «Direcciones».',
    ],
  ]);
  for (const l of s.lines) assert.doesNotMatch(l.text, /agot/i);
});

const health = (relayer: boolean) => ({ mailbox: true, relayer, issuer: true });
const unreachable: OrchError = { code: 'serverUnreachable' };

test('resumeSummary: with the server down it says so once and explains when "Reintentar ahora" helps', () => {
  assert.equal(
    serverDownText(),
    'El servidor de NightMail no responde. Cuando vuelva a responder, pulsa el botón Reintentar ahora para terminar.',
  );
  const r = report({ failed: [failure(unreachable, 1), failure({ code: 'attemptsExhausted' }, 2)] });
  // It knows from the server's last check...
  const s = resumeSummary(r, null, null, health(false));
  assert.ok(s);
  assert.equal(s.cause, serverDownText());
  // ...and the slot's line does not repeat the cause.
  assert.equal(s.lines[0]?.text, 'sin terminar.');
  assert.match(s.lines[1]?.text ?? '', /pulsa Reanudar en/);
  // Without a check, from the failure itself.
  assert.equal(resumeSummary(r, null, null, null)?.cause, serverDownText());
  assert.equal(resumeSummary(null, unreachable, null, null)?.cause, serverDownText());
  // Next to another general cause, both.
  assert.equal(
    resumeSummary(report({ failed: [failure(unreachable)] }), { code: 'midnightUnavailable' }, null, health(false))?.cause,
    `Ahora mismo no hay conexión con Midnight. ${serverDownText()}`,
  );
});

// A server being down is only the cause of what failed because it did not answer.
test('resumeSummary: without a server failure it does not promise that "Reintentar ahora" will finish it', () => {
  const r = report({ failed: [failure({ code: 'attemptsExhausted' }, 1), failure({ code: 'nameTaken' }, 2)] });
  const s = resumeSummary(r, null, null, health(false));
  assert.ok(s);
  assert.equal(s.cause, null);
  assert.equal(resumeSummary(null, { code: 'midnightUnavailable' }, null, health(false))?.cause, 'Ahora mismo no hay conexión con Midnight.');
});

test('resumeSummary: bonos depend on the Issuer, not on the relayer', () => {
  const r = report({ bonosError: unreachable });
  const issuerDown = resumeSummary(r, null, null, { mailbox: true, relayer: true, issuer: false });
  assert.equal(issuerDown?.cause, serverDownText());
  assert.equal(issuerDown?.lines[0]?.text, 'sin comprobar.');
  const issuerUp = resumeSummary(r, null, null, { mailbox: true, relayer: false, issuer: true });
  assert.equal(issuerUp?.cause, null, 'a down relayer is not the cause for the bonos');
  assert.equal(issuerUp?.lines[0]?.text, `sin comprobar: ${serverBackText()}`);
});

test('resumeSummary: with the server responding it does not say it is down', () => {
  const s = resumeSummary(report({ failed: [failure(down)] }), null, null, health(true));
  assert.ok(s);
  assert.equal(s.cause, null);
  assert.equal(resumeSummary(report({ failed: [failure(down)] }), null, null, null)?.cause, null);
  // The server answers now: the earlier failure does not say it is still down (the sidebar would contradict it), it says what to do.
  assert.equal(serverBackText(), 'El servidor de NightMail ya responde. Pulsa el botón Reintentar ahora.');
  const back = resumeSummary(report({ failed: [failure(unreachable)] }), unreachable, null, health(true));
  assert.equal(back?.cause, serverBackText());
  assert.equal(back?.lines[0]?.text, `sin terminar: ${serverBackText()}`);
});
