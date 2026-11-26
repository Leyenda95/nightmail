// Pure rules of the sidebar: texts of the addresses, the quota and the service status line. No React, so they can
// be tested with `node --test`.
import type { AddressView } from './bindings/AddressView.ts';
import type { PlanView } from './bindings/PlanView.ts';
import type { SidecarStatus } from './bindings/SidecarStatus.ts';
import { HEALTH_EVERY_MS, type HealthSnapshot, type ServerSnapshot } from './health.ts';
import { t } from './i18n/index.ts';
import { planKind } from './payment.ts';

/** An address in the sidebar: the local part with its `@` (the domain is the same for all and goes in the `title`). An
 *  address that exists but whose name is unknown (restored) reads "alias sin nombre" or "buzón sin nombre". */
export function sideAddress(a: Pick<AddressView, 'display' | 'slot'>): { text: string; title: string; named: boolean } {
  if (a.display === '') return { text: t().mail.unnamedAddress(a.slot.kind), title: '', named: false };
  const at = a.display.lastIndexOf('@');
  return { text: at === -1 ? a.display : a.display.slice(0, at + 1), title: a.display, named: true };
}

/** Note under "Tus direcciones": that only the person knows they are theirs. */
export function addressesNote(count: number): string {
  return t().mail.addressesNote(count);
}

/** Quota at the foot of the sidebar, from the confirmed bonos (`planKind`, like the plan page): with none, "Sin plan
 *  todavía" (null); with any paid one, "Night Plus" (`PAID_PLAN`); otherwise "Plan gratis". */
export function planName(plan: Pick<PlanView, 'bonos'>): string | null {
  const kind = planKind(plan.bonos);
  return kind === 'none' ? null : kind === 'free' ? t().mail.planFree : t().mail.planPaid;
}

/** Percentage of the quota bar (0-100; with no limit, 0). */
export function quotaPercent(q: { used: number; limit: number }): number {
  if (q.limit <= 0) return 0;
  return Math.min(100, Math.round((100 * q.used) / q.limit));
}

/** The colour of the status dot: green (`ok`), yellow (`aviso`), red (`caido`) and grey while unknown
 *  (`espera`: checking or starting, `sin`: could not be checked or there is nothing to check). */
export type StatusTone = 'ok' | 'aviso' | 'caido' | 'espera' | 'sin';

/** A status line (Midnight, NightMail server, the summary of both, each detail row): the colour of the dot and
 *  the status word. In the summary and the titles only the dot is seen and the word goes to the screen reader;
 *  in the rows the word is seen. The colour never goes alone. */
export interface StatusLineView {
  tone: StatusTone;
  text: string;
  /** Grey because a check has not answered yet (not because something is starting or does not exist in this build): if it
   *  lasts, it turns red (`overdue`). The value is the wait reason, untranslated: changing the language does not change the reason
   *  (nor restart the deadline). */
  waiting?: WaitReason;
}

/** Why a line waits: the core says nothing, the check has not answered or it could not even be asked. */
export type WaitReason = 'silent' | 'checking' | 'notChecked';

/** How long a part that does not answer can stay grey before turning red: three checks in a row
 *  (`HEALTH_EVERY_MS`, every 30 s), that is, a minute and a half. */
export const ANSWER_LIMIT_MS = 3 * HEALTH_EVERY_MS;

/** Why a line waits (`null` if it does not). The deadline belongs to each reason: if it changes, it starts from zero. */
export const waitReason = (line: StatusLineView): WaitReason | null => line.waiting ?? null;

/** The deadline's clock (injected to test with `node --test`): timer, time, whether the window is still and
 *  notification of each change in stillness. */
export interface OverdueEnv {
  /** Calls `fn` after `ms`; returns how to cancel it. */
  after(fn: () => void, ms: number): () => void;
  now(): number;
  still(): boolean;
  /** Calls `fn` each time the window becomes still or stops being still; returns how to stop notifying. */
  onStill(fn: () => void): () => void;
}

/** Counts a wait's deadline and calls `onExpire` when it is reached. With the window still nothing is checked
 *  (`health.ts`), so the deadline also pauses and resumes on return: it is three checks, not a minute and a half of
 *  wall clock. Returns how to stop counting. */
export function watchOverdue(env: OverdueEnv, ms: number, onExpire: () => void): () => void {
  let left = ms;
  let startedAt = 0;
  let cancel: (() => void) | null = null;
  let over = false;
  const run = () => {
    if (over || cancel !== null || env.still()) return;
    startedAt = env.now();
    cancel = env.after(() => {
      cancel = null;
      over = true;
      onExpire();
    }, Math.max(0, left));
  };
  const pause = () => {
    if (cancel === null) return;
    cancel();
    cancel = null;
    left -= env.now() - startedAt;
  };
  const stopWatching = env.onStill(() => (env.still() ? pause() : run()));
  run();
  return () => {
    over = true;
    pause();
    stopWatching();
  };
}

/** The line after waiting `ANSWER_LIMIT_MS` with no answer (`expired`): red if it was still waiting, unchanged otherwise. */
export function overdue(line: StatusLineView, expired: boolean): StatusLineView {
  return line.waiting && expired ? { tone: 'caido', text: t().mail.status.noAnswer } : line;
}

/** A line that was already red (`prev`, the last one shown) stays red while it waits for an answer: if the
 *  mail was not answering and then the whole server stops answering, the line does not go back to grey (nor does the
 *  mail notice go away) during the deadline. With any answer, the new line rules. */
export function holdDown(prev: StatusLineView | null, next: StatusLineView): StatusLineView {
  return next.waiting && prev?.tone === 'caido' ? { tone: 'caido', text: t().mail.status.noAnswer } : next;
}

/** With the helper component ready, what the last check says (`health.ts`): "ready" only means the
 *  process started, not that the network answers. A ping with no answer counts as offline. Without the network Midnight
 *  cannot be used (red). The proof server is only needed to pay and to create addresses: yellow. */
function readyLine(h: HealthSnapshot): StatusLineView {
  const w = t().mail.status;
  if (h.failed || h.health?.indexer === false) return { tone: 'caido', text: w.offline };
  if (h.health === null) return { tone: 'espera', text: w.checkingDots, waiting: 'checking' };
  if (!h.health.proofServer) return { tone: 'aviso', text: w.proofServerMissing };
  return { tone: 'ok', text: w.connected };
}

export function midnightLine(s: SidecarStatus | null, h: HealthSnapshot): StatusLineView {
  const w = t().mail.status;
  switch (s?.state) {
    case 'ready':
      return readyLine(h);
    case 'notStarted':
      return { tone: 'espera', text: w.starting };
    case 'down':
      return { tone: 'caido', text: w.down };
    case 'unavailable':
      return { tone: 'sin', text: w.unavailableInBuild };
    // The core does not even answer what the component is doing.
    default:
      return { tone: 'espera', text: w.waiting, waiting: 'silent' };
  }
}

/** The NightMail server's services, in detail order, with the name shown. */
export function serverParts(): readonly { key: 'mailbox' | 'issuer' | 'relayer'; label: string }[] {
  const m = t().mail;
  return [
    { key: 'mailbox', label: m.serverMail },
    { key: 'issuer', label: m.serverIssuer },
    // The relayer takes the addresses' operations to Midnight. It is ours and can fail with Midnight up: it is
    // named by what the person can no longer do.
    { key: 'relayer', label: m.serverRelayer },
  ];
}

/** NightMail server line: whether its services answer. `failed`: the app could not even ask. Without mail, new mail
 *  cannot be read: it is serious (red) even if the rest answers. Without bono issuing or address creation, mail
 *  keeps arriving: yellow. */
export function serverLine(h: ServerSnapshot): StatusLineView {
  const w = t().mail.status;
  if (h.failed) return { tone: 'sin', text: w.notChecked, waiting: 'notChecked' };
  if (h.health === null) return { tone: 'espera', text: w.checkingDots, waiting: 'checking' };
  const parts = serverParts();
  const up = parts.filter((p) => h.health?.[p.key]).length;
  if (up === parts.length) return { tone: 'ok', text: w.connected };
  if (up === 0) return { tone: 'caido', text: w.notResponding };
  if (!h.health.mailbox) return { tone: 'caido', text: w.mailNotResponding };
  return { tone: 'aviso', text: w.partlyAvailable };
}

/** A detail row (the network, the proof server, the mail...): answers, does not answer or, with no data, checking (the
 *  first check has not answered yet, `pending`) or unchecked. This word is shown, at the right of the
 *  row. */
export function partLine(ok: boolean | null, pending = false): StatusLineView {
  const w = t().mail.status;
  if (ok === null) return pending ? { tone: 'espera', text: w.checking } : { tone: 'sin', text: w.notChecked };
  return ok ? { tone: 'ok', text: w.responding } : { tone: 'caido', text: w.notResponding };
}

/** The single dot at the foot of the sidebar, "Estado del servicio", from the Midnight line and the server line. Red,
 *  "no disponible", if one of the two has a serious failure (mail cannot be read or Midnight used: the Midnight
 *  network, the component that talks to it, the mail or the whole server). Yellow, "con incidencias", if only
 *  something minor fails (the proof server, bono issuing or address creation). Green, "operativo", if both
 *  confirm it. Grey, "comprobando..." or "sin comprobar", with nothing to say yet. */
export function serviceLine(midnight: StatusLineView, server: StatusLineView): StatusLineView {
  const w = t().mail.status;
  const tones = [midnight.tone, server.tone];
  if (tones.includes('caido')) return { tone: 'caido', text: w.unavailable };
  if (tones.includes('aviso')) return { tone: 'aviso', text: w.withIssues };
  if (midnight.tone === 'ok' && server.tone === 'ok') return { tone: 'ok', text: w.operational };
  if (tones.includes('espera')) return { tone: 'espera', text: w.checkingDots };
  return { tone: 'sin', text: w.notChecked };
}

/** The notice above the mail list when the server's mail does not answer (the status panel no longer carries
 *  sentences). */
export const mailDownText = (): string => t().mail.mailDown;

/** Does the `mailDownText()` notice show? Only in a view with a mail list (`isList`: inbox and archive) and with the
 *  server line ALREADY red after its deadline (`overdue`): the mail does not answer, the whole server does not answer or the app has gone
 *  `ANSWER_LIMIT_MS` with no answer. The initial grey ("comprobando...") and yellow (bonos, addresses) do not
 *  trigger it. It goes away by itself when the mail answers again. */
export function mailDownShown(listView: boolean, server: StatusLineView): boolean {
  return listView && server.tone === 'caido';
}

/** Cap of the number on the "Bandeja de entrada" row: above it, "99+". */
export const unreadBadge = (n: number) => (n > 99 ? '99+' : String(n));
