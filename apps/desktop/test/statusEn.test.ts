// English texts of states and pending items: progress, half-done slots, payment, addresses, the pending
// notice and Midnight health. Each test file runs in its own process: here the language is `en`.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OrchError } from '../src/bindings/OrchError.ts';
import type { PendingSlot } from '../src/bindings/PendingSlot.ts';
import type { PlanView } from '../src/bindings/PlanView.ts';
import type { Progress } from '../src/bindings/Progress.ts';
import type { ResumeReport } from '../src/bindings/ResumeReport.ts';
import type { WalletView } from '../src/bindings/WalletView.ts';
import { abandonButton, abandonedNote, abandonedText, abandonLabel, abandonNote, abandonTexts, pendingTag, quotaNotice, seeMailLabel } from '../src/addresses.ts';
import { midnightBlocker, midnightWaitingText, noNetworkText, noProofServerText } from '../src/health.ts';
import { DICTIONARIES } from '../src/i18n/index.ts';
import { resumeBusy, resumeSummary, resumeTitle, retryNowButton, serverBackText, serverDownText } from '../src/notices.ts';
import { bonoParts, cannotPay, dustSetupLine, offerTitle } from '../src/payment.ts';
import { actionLabels, inProcessText, pendingButton, pendingParts, stillPendingText, stopGenericText, stoppedText, stopReasonText } from '../src/pending.ts';
import { prefs } from '../src/prefs.ts';
import { progressParts } from '../src/progress.ts';

prefs.setLocale('en');

const slot = (over: Partial<PendingSlot>): PendingSlot => ({
  slot: { n: 1, kind: 'mailbox', j: 1 },
  paused: false,
  inProgress: false,
  stopped: false,
  stopReason: null,
  abandonable: false,
  name: 'ana',
  ...over,
});

/** All the texts of a dictionary value, also those that come from calling its functions. */
function texts(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (typeof v === 'function') {
    const tries: unknown[][] = [Array.from({ length: v.length }, (_, i) => (i === 0 ? 'X' : 2)), ['mailbox', 1], ['alias', 2], [true], [false], [1, 1, 1]];
    return tries.flatMap((args) => {
      try {
        return texts(v(...args));
      } catch {
        return [];
      }
    });
  }
  if (v && typeof v === 'object') return Object.values(v).flatMap(texts);
  return [];
}

test('en status: no «;», «//», «—» or « – », and no Spanish letters or quotes', () => {
  for (const text of texts(DICTIONARIES.en.status)) {
    assert.doesNotMatch(text, /;|\/\/|—| – /, text);
    assert.doesNotMatch(text, /[áéíóúñ¿¡«»]/, text);
    assert.doesNotMatch(text, /\breveal|\brounds?\b|half-done|halfway|keep working|still encrypted/i, text);
  }
});

test('en progress: every stage has an English heading, and the same notes as Spanish', () => {
  assert.deepEqual(progressParts({ stage: 'relaying' }), {
    stage: 'Sending to Midnight',
    note: 'Waiting for Midnight to confirm the operation.',
  });
  assert.deepEqual(progressParts({ stage: 'requestingBono' }), { stage: 'Requesting the voucher', note: null });
  assert.equal(progressParts({ stage: 'bonoReady', n: 2 }).stage, 'Voucher confirmed');
  assert.equal(progressParts({ stage: 'recovering', n: 64 }).stage, 'Looking for your vouchers on Midnight');
  assert.match(progressParts({ stage: 'recovering', n: 64 }).note!, /recovery phrase/);
  assert.deepEqual(progressParts({ stage: 'etapaNueva' } as unknown as Progress), { stage: 'Under way', note: null });
  // The same stages carry a note in both languages.
  const { es, en } = DICTIONARIES;
  for (const [key, value] of Object.entries(es.status.progress.stages)) {
    const other = en.status.progress.stages[key as keyof typeof en.status.progress.stages];
    assert.equal('note' in other, 'note' in value, key);
  }
});

test('en pending rows: stage, state and stop reasons', () => {
  assert.deepEqual(pendingParts(slot({})), { who: 'mailbox ana', what: 'mailbox ana', stage: 'Creating the mailbox', stopped: false, state: 'in progress' });
  assert.equal(pendingParts(slot({ slot: { n: 1, kind: 'alias', j: 2 }, name: null })).stage, 'Creating the alias');
  assert.equal(pendingParts(slot({ stopped: true, paused: true, stopReason: { code: 'attemptsExhausted' } })).state, 'stopped: after several unsuccessful attempts');
  assert.equal(inProcessText(), 'in progress');
  assert.equal(stoppedText(), 'stopped');
  assert.equal(stopGenericText(), "couldn't be completed");
  assert.equal(stopReasonText(null, 'mailbox'), "couldn't be completed");
  assert.equal(stopReasonText({ code: 'busy' }, 'mailbox'), "couldn't be completed");
  const taken: OrchError = { code: 'callRejected', reason: 'address-taken' };
  assert.equal(stopReasonText(taken, 'mailbox'), 'name taken');
  assert.equal(stopReasonText(taken, 'alias'), 'alias ending taken');
  assert.equal(stopReasonText({ code: 'callRejected', reason: 'other' }, 'alias'), 'rejected by Midnight');
});

test('en pending buttons: the glossary names, and texts that name the button the row really has', () => {
  assert.deepEqual(pendingButton(), { resume: 'Resume', retry: 'Retry' });
  assert.deepEqual(actionLabels('mailbox ana'), {
    resume: 'Resume the mailbox ana',
    retry: 'Retry the mailbox ana',
    abandon: 'Cancel creating the mailbox ana',
  });
  // Buttons go without quotes.
  assert.match(stillPendingText('slot', true), /Finish it with the Resume button\.$/);
  assert.match(stillPendingText('slot', false), /Finish it with the Retry button\.$/);
  assert.match(stillPendingText('slot'), /the Retry button \(or with the Resume button, if it stopped after several attempts\)\.$/);
  assert.doesNotMatch(stillPendingText('bono'), /Retry|Resume|\d+ min/);
});

test('en payment: balance, DUST line, offer and voucher rows', () => {
  const wallet: WalletView = { unshieldedAddress: null, night: '5', dust: '0', dustReady: true, token: '100', faucet: true, dustSetup: 'idle' };
  assert.equal(cannotPay('100', wallet), null);
  assert.equal(cannotPay('101', wallet), 'Insufficient balance: you have 100 NightMail tokens and the plan costs 101.');
  assert.equal(cannotPay('2', { ...wallet, token: '1' }), 'Insufficient balance: you have 1 NightMail token and the plan costs 2.');
  assert.match(cannotPay('100', { ...wallet, dustReady: false, night: '0' })!, /NIGHT/);
  assert.equal(cannotPay('1e3', wallet), "The price or the balance couldn't be read.");
  assert.deepEqual(dustSetupLine('activating'), { icon: 'espera', text: 'Activating DUST generation' });
  assert.equal(offerTitle('none'), 'Choose a plan');
  assert.equal(offerTitle('free'), 'Switch to Night Plus');
  const confirmed = bonoParts({ paid: true, included: true, usableAt: null }, 1000);
  assert.equal(confirmed.title, 'Night Plus voucher');
  assert.equal(confirmed.srOnly, 'Confirmed.');
  const pending = bonoParts({ paid: false, included: false, usableAt: null }, 1000);
  assert.equal(pending.state, 'pending');
  assert.deepEqual(pending.abandon, {
    button: 'Cancel',
    label: 'Cancel the pending request for the free voucher',
    title: 'Cancel this pending request?',
    note: "If the request has already been accepted and can still complete, it can't be canceled.",
    yes: 'Yes, cancel the request',
  });
  assert.equal(bonoParts({ paid: true, included: false, usableAt: null }, 1000).abandon?.label, 'Cancel the pending payment for the Night Plus voucher');
  // The date goes in English's format, with no Spanish leftovers.
  const wait = bonoParts({ paid: false, included: true, usableAt: 2000 }, 1000).wait!;
  assert.match(wait, /^Can be used from /);
  assert.doesNotMatch(wait, /[áéíóúñ]| del | a partir/);
});

test('en addresses: quota notice with plurals, menu tag, abandon texts', () => {
  const plan = (paid: boolean, m: number, a: number): PlanView => ({
    bonos: [{ n: 1, k: 0, paid, included: true, usableAt: null }],
    mailboxes: { used: m, limit: m },
    aliases: { used: a, limit: a },
    mailboxesAbandoned: 0,
    aliasesAbandoned: 0,
  });
  assert.equal(quotaNotice(plan(false, 1, 1)), 'You have no free slots left in your free plan (1 mailbox and 1 alias).');
  assert.equal(quotaNotice(plan(true, 5, 20)), 'You have no free slots left in your Night Plus plan (5 mailboxes and 20 aliases).');
  assert.equal(quotaNotice({ ...plan(false, 0, 0), bonos: [] }), "You don't have a plan yet: choose one to be able to create addresses.");
  assert.equal(pendingTag({ total: 2, stopped: 0 }), '2 in progress');
  assert.equal(pendingTag({ total: 3, stopped: 1 }), '1 stopped');
  assert.equal(pendingTag({ total: 0, stopped: 0 }), null);
  assert.deepEqual(abandonTexts(), {
    title: 'Abandon this address?',
    body: ["This operation can't be undone.", "The slot in your plan isn't freed, and no one will be able to register this address again, not even you."],
    yes: 'Abandon address',
    no: 'Cancel',
  });
  assert.equal(abandonButton(), 'Abandon');
  assert.equal(abandonLabel('ana@nightmail.test'), 'Abandon ana@nightmail.test');
  assert.equal(seeMailLabel('ana@nightmail.test'), 'See mail for ana@nightmail.test');
  // Without a name: standalone it is capitalised ("Unnamed alias"), mid-sentence lowercase.
  assert.equal(seeMailLabel('Unnamed alias'), 'See mail for unnamed alias');
  assert.equal(abandonLabel('Unnamed mailbox'), 'Abandon unnamed mailbox');
  assert.equal(abandonedText(), 'Address abandoned.');
  assert.equal(abandonNote(), "When you abandon an address, the slot in your plan isn't freed.");
  assert.equal(abandonedNote(0), null);
  assert.equal(abandonedNote(1), '(1 abandoned)');
  assert.equal(abandonedNote(3), '(3 abandoned)');
});

test('en resume notice: titles, grouped lines with plurals, server texts name the notice button', () => {
  const report = (over: Partial<ResumeReport>): ResumeReport => ({ bonosIncluded: 0, bonosError: null, addresses: 0, needsName: [], failed: [], ...over });
  const fail = (kind: 'mailbox' | 'alias', n: number, error: OrchError) => ({ slot: { n, kind, j: 1 }, error });
  const down: OrchError = { code: 'serviceUnavailable' };
  assert.equal(resumeTitle(), "The pending operations couldn't be finished.");
  assert.equal(resumeBusy(), 'Retrying.');
  assert.equal(retryNowButton(), 'Retry now');
  assert.match(serverDownText(), /press the Retry now button to finish\.$/);
  assert.equal(serverBackText(), 'The NightMail server is responding now. Press the Retry now button.');
  const s = resumeSummary(report({ failed: [fail('alias', 1, down), fail('alias', 2, down), fail('mailbox', 3, down), fail('mailbox', 4, { code: 'midnightUnavailable' })] }), null)!;
  assert.deepEqual(s.lines.map((l) => l.label), ['2 aliases', 'One mailbox', 'One mailbox']);
  assert.equal(s.lines[0]?.text, "not finished: The service isn't available right now.");
  const unreachable: OrchError = { code: 'serverUnreachable' };
  const offline = resumeSummary(report({ failed: [fail('mailbox', 1, unreachable), fail('mailbox', 2, unreachable)] }), null, null, null)!;
  assert.equal(offline.cause, serverDownText());
  assert.deepEqual(offline.lines, [{ key: 'mailbox|', label: '2 mailboxes', mono: false, text: 'not finished.' }]);
  const bonos = resumeSummary(report({ bonosError: down }), null)!;
  assert.deepEqual(bonos.lines[0], { key: 'bonos', label: 'Pending vouchers', mono: false, text: "not checked: The service isn't available right now." });
});

test('en Midnight health: blockers and the waiting note', () => {
  const h = (indexer: boolean, proofServer: boolean) => ({ indexer, proofServer });
  assert.equal(midnightBlocker(h(false, true), 'red'), noNetworkText());
  assert.equal(midnightBlocker(h(true, false), 'pruebas'), noProofServerText());
  assert.match(noNetworkText(), /^There's no connection to the Midnight network/);
  assert.match(noNetworkText(), /start it\. If not, wait a few minutes and try again\.$/);
  assert.match(noProofServerText(), /Start it and try again\.$/);
  assert.match(midnightWaitingText(), /The operation is still waiting\./);
});
