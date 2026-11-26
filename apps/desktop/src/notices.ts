// Text of the global notice "no se ha podido terminar lo pendiente", with no DOM. The notice carries its own button:
// each error tells "what happened" (`errorParts().what`) and, if the notice's button does not fix it, what to do.
import { errorParts } from './errors.ts';
import { t } from './i18n/index.ts';
import { resumeNotice } from './pending.ts';
import type { OrchError } from './bindings/OrchError.ts';
import type { ResumeReport } from './bindings/ResumeReport.ts';
import type { ServerHealth } from './bindings/ServerHealth.ts';
import type { SlotId } from './bindings/SlotId.ts';
import type { SlotFailure } from './bindings/SlotFailure.ts';

/** Notice headline. */
export const resumeTitle = (): string => t().status.notices.title;
/** Headline while a pass is running. */
export const resumeBusy = (): string => t().status.notices.busy;
/** The notice's button: the same source as the texts that name it (`serverDownText`, `serverBackText`). */
export const retryNowButton = (): string => t().status.notices.retryNow;

/** The NightMail server does not answer: "Reintentar ahora" would fail the same until it returns. Said once, as the
 *  general cause, and the slot lines do not repeat it. */
export const serverDownText = (): string => t().status.notices.serverDown;
/** It failed because the server did not answer, but the last check says it answers now. */
export const serverBackText = (): string => t().status.notices.serverBack;

/** A line of the list: `label` (in monospace if it is a slot) and what happens to it. */
export interface ResumeLine {
  key: string;
  label: string;
  mono: boolean;
  text: string;
}

export interface ResumeSummary {
  /** What happened in general (the pass's failure, the server down), or `null` if there are only lines. */
  cause: string | null;
  lines: ResumeLine[];
  /** There is a `staleState`: "Volver a sincronizar" is offered. */
  stale: boolean;
}

/** How each error is told in the notice. `serverDown`: the NightMail server does not answer (it goes as the general cause);
 *  `serverUp`: the last check says it answers. */
interface Telling {
  serverDown: boolean;
  serverUp: boolean;
}

/** What the notice says for an error, or `null` if the general cause already says it (the server down). A slot stopped
 *  after several attempts is not fixed by "Reintentar ahora": it also carries what to do. */
function tell(e: OrchError, how: Telling): string | null {
  if (e.code === 'serverUnreachable') {
    if (how.serverDown) return null;
    if (how.serverUp) return serverBackText();
  }
  const { what, action } = errorParts(e);
  return e.code === 'attemptsExhausted' && action ? `${what} ${action}` : what;
}

/** The slots that did not finish, one line per kind and cause: "2 alias sin terminar: cause". Different causes get
 *  different lines. */
function failedLines(failed: readonly SlotFailure[], how: Telling): ResumeLine[] {
  const groups = new Map<string, { id: string; kind: SlotId['kind']; count: number; text: string | null }>();
  for (const f of failed) {
    const text = tell(f.error, how);
    const id = `${f.slot.kind}|${text ?? ''}`;
    const g = groups.get(id);
    if (g) g.count += 1;
    else groups.set(id, { id, kind: f.slot.kind, count: 1, text });
  }
  return [...groups.values()].map((g) => {
    const words = t().status.notices;
    const text = g.text === null ? words.unfinished : words.unfinishedWith(g.text);
    return { key: g.id, label: words.failedLabel(g.kind, g.count), mono: false, text };
  });
}

/** What the notice shows, or `null` if there is nothing to show (an empty report clears it). `pending`: the slots
 *  that are still half-done (`resumeNotice`), or `null` if unknown. `server`: the last NightMail server check, or
 *  `null` if unknown (then the failure itself says it). */
export function resumeSummary(
  resume: ResumeReport | null,
  resumeError: OrchError | null,
  pending: readonly SlotId[] | null = null,
  server: ServerHealth | null = null,
): ResumeSummary | null {
  const { show, stale, bonos, failed } = resumeNotice(resume, resumeError, pending);
  if (!show) return null;
  // The server being down is the cause only of what failed because it did not answer (`serverUnreachable`), and only while
  // the part it depends on does not answer: slots go through the relayer and bonos through the Issuer. A stopped slot or
  // one with the name taken is not promised that "Reintentar ahora" will finish it.
  const unreachable = (e: OrchError | null) => e?.code === 'serverUnreachable';
  const telling = (up: boolean | undefined, failedHere: boolean): Telling => ({
    serverDown: failedHere && up !== true,
    serverUp: up === true,
  });
  const slots = telling(server?.relayer, unreachable(resumeError) || failed.some((f) => unreachable(f.error)));
  const bonosT = telling(server?.issuer, unreachable(bonos));
  const lines = failedLines(failed, slots);
  if (bonos) {
    const text = tell(bonos, bonosT);
    const words = t().status.notices;
    lines.push({ key: 'bonos', label: words.bonosLabel, mono: false, text: text === null ? words.unchecked : words.uncheckedWith(text) });
  }
  const serverDown = slots.serverDown || bonosT.serverDown;
  const causes = [resumeError && tell(resumeError, slots), serverDown ? serverDownText() : null].filter(Boolean);
  return { cause: causes.length > 0 ? causes.join(' ') : null, lines, stale };
}
