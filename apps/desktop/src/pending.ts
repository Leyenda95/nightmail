// Pure rules of the actions after an error (no DOM): half-done slots and pending payments.
import type { PendingSlot } from './bindings/PendingSlot.ts';
import type { OrchError } from './bindings/OrchError.ts';
import type { ResumeReport } from './bindings/ResumeReport.ts';
import type { SlotFailure } from './bindings/SlotFailure.ts';
import type { SlotId } from './bindings/SlotId.ts';
import { slotKindName, slotLabel } from './format.ts';
import { t } from './i18n/index.ts';

// The text of the step a half-done slot is at is in `t().status.pending.stage`.

/** The buttons of a half-done slot row. */
export interface PendingActions {
  readonly resume: boolean;
  readonly retry: boolean;
  readonly abandon: boolean;
}

/** What the user can do with a half-done slot (the core checks again). */
export function pendingActions(p: PendingSlot): PendingActions {
  // While an operation is driving it (being created or resumed), nothing has failed yet and the operation has the
  // turn: neither retry nor abandon. With nothing running, what remains is there because it failed or was cut off:
  // `resume_paused_slot` only helps after the attempt cap is exhausted; if it is not paused, everything pending
  // is retried (`resume_now`). `abandon_slot`, when the core would already allow it (`abandonable`).
  if (p.inProgress) return { resume: false, retry: false, abandon: false };
  return { resume: p.paused, retry: !p.paused, abandon: p.abandonable };
}

/** The buttons the row shows. While the action of one of its buttons lasts, those of that moment (`frozen`), even if
 *  a re-read says otherwise: "Reanudar" resets the attempts, so re-read midway it would come out unpaused and turn
 *  into "Reintentar" (focus would be lost). Cancel does not, meanwhile: the operation has the turn. */
export function rowActions(p: PendingSlot, frozen: PendingActions | null): PendingActions {
  return frozen ? { ...frozen, abandon: false } : pendingActions(p);
}

/** Label of the button that resumes a half-done slot: that of `resume` if paused, that of `retry` if not (see
 *  `pendingActions`). A single source for the button and the texts that name it. */
export function pendingButton(): { readonly resume: string; readonly retry: string } {
  return t().status.pending.button;
}

/** State of the row after its step: it carries on by itself (the app is driving it now or will retry later) or it is
 *  stopped (it will not continue without the user: a failure that would repeat, exhausted attempts or a mailbox
 *  with no name). If stopped, it says why (the core's `stopReason`, `stopReasonText`). */
export const inProcessText = (): string => t().status.pending.inProcess;
export const stoppedText = (): string => t().status.pending.stopped;

/** Reason for a stopped slot that the core did not give, or with no better text. */
export const stopGenericText = (): string => t().status.pending.stopGeneric;

/** Why it stopped, after "detenido: ". A deliberately complete table: a new variant does not compile until it gets text.
 *  What really leaves a slot stopped has its own text: the missing name, the attempt cap and the `drive` errors that do
 *  not clear by themselves (`may_clear_by_itself`). Those that clear by themselves never stop it, and those that do not
 *  come from driving a slot (or have nothing better to say) carry the generic one. */
function stopReasons(): Record<OrchError['code'], string> {
  const { stopReason: own, stopGeneric: generic } = t().status.pending;
  return {
    ...own,
    // They clear by themselves: they never stop a row.
    midnightUnavailable: generic,
    busy: generic,
    bonoNotReady: generic,
    rateLimited: generic,
    serviceUnavailable: generic,
    serverUnreachable: generic,
    stillPending: generic,
    wallet: generic,
    // They do not come from driving a slot (they are about bonos, payments or configuration), or there is nothing better to say.
    alreadyHasPlan: generic,
    badConfig: generic,
    noFreeSlot: generic,
    slotBurned: generic,
    wrongName: generic,
    captchaFailed: generic,
    paymentFailed: generic,
    issueFailed: generic,
    badReceipt: generic,
    priceChanged: generic,
    insufficientFunds: generic,
    store: generic,
    internal: generic,
  };
}

type CallProblem = Extract<OrchError, { code: 'callRejected' }>['reason'];
type SlotKind = PendingSlot['slot']['kind'];

/** Contract rejections, with a clearer reason than "rechazado por Midnight" when there is one. A complete table, like
 *  `stopReasons`. "address-taken" only comes from `registerMailbox`, and the core then frees the slot (it does not stop
 *  the row). Its text stays in case that changes, and depends on the slot kind. */
function stopCalls(): Record<CallProblem, string | Record<SlotKind, string>> {
  const { stopReason: reason, stopCall: call } = t().status.pending;
  return {
    'not-a-bono': call.notABono,
    'no-slots-left': call.noSlotsLeft,
    'address-taken': { mailbox: reason.nameTaken, alias: reason.aliasSuffixTaken },
    // Nothing better to say.
    'slot-already-used': reason.callRejected,
    'wrong-token': reason.callRejected,
    'wrong-amount': reason.callRejected,
    'old-price-expired': reason.callRejected,
    other: reason.callRejected,
  };
}

/** Short text of the stop reason (without "detenido: "), by slot kind. */
export function stopReasonText(reason: OrchError | null, kind: SlotKind): string {
  if (reason === null) return stopGenericText();
  if (reason.code !== 'callRejected') return stopReasons()[reason.code];
  const text = stopCalls()[reason.reason];
  return typeof text === 'string' ? text : text[kind];
}

/** A half-done slot in parts, for its row: who it is, which step it is at (headline, capitalised), whether it is stopped
 *  (its icon) and its state (what follows the step). */
export function pendingParts(p: PendingSlot): { who: string; what: string; stage: string; stopped: boolean; state: string } {
  const words = t().status.pending;
  const who = p.slot.kind === 'mailbox' && p.name ? words.mailboxNamed(p.name) : slotLabel(p.slot);
  const what = p.slot.kind === 'mailbox' && p.name ? who : slotKindName(p.slot);
  const stage = words.stage[p.slot.kind];
  return { who, what, stage: stage.charAt(0).toUpperCase() + stage.slice(1), stopped: p.stopped, state: rowState(p) };
}

function rowState(p: PendingSlot): string {
  return p.stopped ? t().status.pending.stoppedWith(stopReasonText(p.stopReason, p.slot.kind)) : inProcessText();
}

/** What a screen reader says for each button of the row: it starts with the visible text and names the row
 *  (`what`, from `pendingParts`: the kind, or "buzón ana"). */
export function actionLabels(what: string): { resume: string; retry: string; abandon: string } {
  const { actions } = t().status.pending;
  return { resume: actions.resume(what), retry: actions.retry(what), abandon: actions.abandon(what) };
}

/** What the button that finishes a slot whose attempt was already admitted is called: that of its row. Without knowing whether it is paused (the
 *  screen does not say yet), both, so the text never names a button that is not there. */
function finishButton(paused: boolean | undefined): string {
  const words = t().status.pending;
  if (paused === undefined) return words.finishEither;
  return words.finishOne(paused ? words.button.resume : words.button.retry);
}

/** Text of `stillPending` when trying to abandon. A slot: its "Cancelar" only appears when the store would already
 *  allow it (`abandonable`), so the "not yet" almost always comes from the chain, which has (or is about to have)
 *  its last attempt (`abandon_slot`). `paused` (from its `PendingSlot`) picks the button that is named. */
export function stillPendingText(what: 'slot' | 'bono', paused?: boolean): string {
  const words = t().status.pending;
  return what === 'slot' ? words.stillPendingSlot(finishButton(paused)) : words.stillPendingBono;
}

/** Code of a core error, or `null`. */
export function errorCode(e: unknown): string | null {
  if (typeof e !== 'object' || e === null) return null;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/** Identifies a slot (for keys and comparisons): the same `n` and `j` of another kind is another slot. */
export const slotKey = (s: SlotId): string => `${s.n}/${s.kind}/${s.j}`;

/** What the `resume` notice shows: nothing (an empty report clears it), the failures, and if any is `staleState`, also
 *  "Volver a sincronizar". The bonos' `busy` is not shown: it was the user's own payment and is looked at on the next
 *  pass. The report is from a pass already gone: a slot that has since finished or been cancelled by another path
 *  (creating an alias resumes the half-done one) no longer appears. `pending` are the slots that are still
 *  half-done, or `null` if unknown (then all appear). */
export function resumeNotice(
  resume: ResumeReport | null,
  resumeError: OrchError | null,
  pending: readonly SlotId[] | null = null,
): { show: boolean; stale: boolean; bonos: OrchError | null; failed: SlotFailure[] } {
  const open = pending && new Set(pending.map(slotKey));
  const failed = (resume?.failed ?? []).filter((f) => !open || open.has(slotKey(f.slot)));
  const bonos = resume?.bonosError && resume.bonosError.code !== 'busy' ? resume.bonosError : null;
  const errors = [resumeError, bonos, ...failed.map((f) => f.error)];
  const show = resumeError !== null || bonos !== null || failed.length > 0;
  return { show, stale: errors.some((e) => e?.code === 'staleState'), bonos, failed };
}

/** Whether a `resume` pass is running. `asked`: one was requested ("Reintentar") and the one that serves it has not started yet.
 *  `running`: the core announced one starting (`resumeStarted`) and not yet its result. */
export interface ResumePass {
  readonly asked: boolean;
  readonly running: boolean;
}

export const IDLE_PASS: ResumePass = { asked: false, running: false };

/** What moves a pass: it is requested (`asked`), the request does not reach the core (`askFailed`), the core starts one
 *  (`started`) or gives its result (`finished`). */
export type PassStep = 'asked' | 'askFailed' | 'started' | 'finished';

/** The core serves a request made during a pass with ANOTHER pass, which announces itself on start: the result of the
 *  earlier one does not complete the request. */
export function nextPass(pass: ResumePass, step: PassStep): ResumePass {
  switch (step) {
    case 'asked':
      return { ...pass, asked: true };
    case 'askFailed':
      return { ...pass, asked: false };
    case 'started':
      return { asked: false, running: true };
    case 'finished':
      return pass.running ? { ...pass, running: false } : IDLE_PASS;
  }
}

/** Is "Reintentando..." shown? */
export const passBusy = (pass: ResumePass): boolean => pass.asked || pass.running;

/** On locking: the `resume` notice belonged to that session, and so does its pass. */
export function withoutResume<T extends { resume: unknown; resumeError: unknown; resumePass: ResumePass }>(state: T): T {
  return { ...state, resume: null, resumeError: null, resumePass: IDLE_PASS };
}
