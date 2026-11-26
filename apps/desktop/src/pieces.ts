// Pure rules of the base pieces (`components/`): which icon and role each notice has, which classes the light has
// and which messages a field points to. No React, so they can be tested with `node --test`.

import type { IconName } from '@nightmail/icons';
import { t } from './i18n/index.ts';

type Part = string | false | null | undefined;

/** Joins the classes present (empty or false ones are skipped). */
export function classes(...parts: Part[]): string {
  return parts.filter(Boolean).join(' ');
}

/** `aria-describedby`: the ids of the messages present, or nothing if there are none. */
export function describedBy(...ids: Part[]): string | undefined {
  return classes(...ids) || undefined;
}

// The tones and states below are, verbatim, the end of a class in `styles/app.css`: a test checks that
// they all exist, so a new tone without its rule (or a renamed rule) does not slip through silently.

/** Tones of a notice (`nm-aviso--*` classes). */
export const AVISO_TONES = ['error', 'atencion', 'exito', 'info'] as const;
export type AvisoTone = (typeof AVISO_TONES)[number];

/** Classes of a notice; `strip` is the global strip, edge to edge over the panels. */
export function avisoClass(tone: AvisoTone, strip = false): string {
  return classes('nm-aviso', `nm-aviso--${tone}`, strip && 'nm-aviso--franja');
}

// Each tone has its own icon: the tone is never told apart by colour alone.
const AVISO_ICON: Record<AvisoTone, IconName> = {
  error: 'exclamation-circle',
  atencion: 'exclamation-triangle-filled',
  exito: 'checkmark-circle',
  info: 'info-circle',
};

export function avisoIcon(tone: AvisoTone): IconName {
  return AVISO_ICON[tone];
}

/** What interrupts (error, attention) is announced at once; the rest waits its turn. */
export function avisoRole(tone: AvisoTone): 'alert' | 'status' {
  return tone === 'error' || tone === 'atencion' ? 'alert' : 'status';
}

/** Tones of a tag (`nm-tag--*` classes); with no tone, the neutral one. */
export const TAG_TONES = ['atencion', 'exito'] as const;
export type TagTone = (typeof TAG_TONES)[number];

export function tagClass(tone?: TagTone): string {
  return classes('nm-tag', tone && `nm-tag--${tone}`);
}

/** States of the light (`nm-luz--*` classes, except `encendida`, which is the plain light). */
export const LUZ_MODES = ['encendida', 'apagada', 'late', 'trabaja', 'destello'] as const;
export type LuzMode = (typeof LUZ_MODES)[number];

// Heartbeat rhythms that exist in `app.css` (`nm-luz--late` and `nm-luz--late-2`...`-5`).
const RHYTHMS = 5;

/** Classes of the light. `rhythm` is the address's position in the list (0, 1, 2...): each beats with a different
 *  period so they never synchronise. It goes by class, not computed styles (a design rule). */
export function luzClass(mode: LuzMode = 'encendida', rhythm = 0): string {
  if (mode === 'encendida') return 'nm-luz';
  if (mode !== 'late') return `nm-luz nm-luz--${mode}`;
  const n = Number.isFinite(rhythm) && rhythm > 0 ? Math.trunc(rhythm) % RHYTHMS : 0;
  return classes('nm-luz nm-luz--late', n > 0 && `nm-luz--late-${n + 1}`);
}

/** What `copyText` needs from the environment: injected so it can be tested without a browser. */
export interface CopyEnv {
  /** `navigator.clipboard.writeText`, if it exists. */
  writeText?: (text: string) => Promise<void>;
  /** Plan B (WebKitGTK without clipboard permission): selects the text and calls `execCommand('copy')`. */
  selectAndCopy: () => boolean;
}

/** Copies `text`; returns whether it worked. Never throws: a failing clipboard is a `false`, not an exception. */
export async function copyText(text: string, env: CopyEnv): Promise<boolean> {
  if (env.writeText) {
    try {
      await env.writeText(text);
      return true;
    } catch {
      // Falls through to plan B.
    }
  }
  try {
    return env.selectAndCopy();
  } catch {
    return false;
  }
}

/** Seconds after which a copied secret (the recovery phrase) is wiped from the clipboard. */
export const SECRET_CLEAR_SECONDS = 30;

/** What `clearClipboard` needs from the environment: injected so it can be tested without a browser. */
export interface ClearEnv {
  /** `navigator.clipboard.writeText`, if it exists. */
  writeText?: (text: string) => Promise<void>;
  /** Plan B: `execCommand('copy')` with an empty text. Usually refused without a click, but it costs nothing to try. */
  copyEmpty: () => boolean;
}

/** Empties the clipboard (writes an empty text) once. What is in it is not read first: reading the clipboard can ask
 *  the person for permission and is itself a peek at what they copied, so it is wiped whatever it holds. Never throws.
 *  Returns whether it was emptied. */
export async function clearClipboard(env: ClearEnv): Promise<boolean> {
  if (env.writeText) {
    try {
      await env.writeText('');
      return true;
    } catch {
      // Falls through to plan B.
    }
  }
  try {
    return env.copyEmpty();
  } catch {
    return false;
  }
}

/** What `secretWipe` needs besides the clipboard: timers and the window's events, injected for the tests. */
export interface WipeEnv extends ClearEnv {
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
  /** Calls `fn` once, the next time the window gets focus. Returns how to stop waiting. */
  onNextFocus: (fn: () => void) => () => void;
  /** Calls `fn` on every copy made in this window (Ctrl+C or a copy button's plan B). Returns how to stop listening. */
  onCopy: (fn: () => void) => () => void;
}

/** The wipe of a copied secret (the recovery phrase), `SECRET_CLEAR_SECONDS` after copying it. `schedule` after copying
 *  the secret (it starts the count again). `cancel` after any other copy in the app: that copy already replaced the
 *  secret in the clipboard and must not be wiped. The webview refuses to write while the window has no focus (the
 *  person went to paste the phrase elsewhere): then it tries again each time the window gets focus back, until it works.
 *  On purpose with no time limit (accepted by the owner): coming back hours later still wipes the clipboard, whatever
 *  another app put in it by then. */
export function secretWipe(env: WipeEnv): { schedule: () => void; cancel: () => void } {
  let timer: number | null = null;
  let stopFocus: (() => void) | null = null;
  let stopCopy: (() => void) | null = null;
  // Each `cancel` starts a new generation: an attempt still running from an older one does not wait for focus again.
  let generation = 0;
  // Plan B of the wipe is itself a copy: it must not cancel the wipe.
  let wiping = false;

  function cancel() {
    generation++;
    if (timer !== null) env.clearTimer(timer);
    timer = null;
    stopFocus?.();
    stopFocus = null;
    stopCopy?.();
    stopCopy = null;
  }

  async function wipe(mine: number) {
    wiping = true;
    let ok: boolean;
    try {
      ok = await clearClipboard(env);
    } finally {
      wiping = false;
    }
    if (mine !== generation) return;
    if (ok) {
      cancel();
      return;
    }
    stopFocus = env.onNextFocus(() => {
      stopFocus = null;
      void wipe(mine);
    });
  }

  function schedule() {
    cancel();
    const mine = generation;
    stopCopy = env.onCopy(() => {
      if (!wiping) cancel();
    });
    timer = env.setTimer(() => {
      timer = null;
      void wipe(mine);
    }, SECRET_CLEAR_SECONDS * 1000);
  }

  return { schedule, cancel };
}

/** What the "Copiar" notice (`role="status"`) says for the result; nothing until it has been pressed. `secret`: the
 *  copied text is wiped from the clipboard after `SECRET_CLEAR_SECONDS`, and the notice says so. */
export function copyStatus(state: 'idle' | 'ok' | 'fail', secret = false): string {
  if (state === 'ok') return secret ? t().mail.copiedSecret(SECRET_CLEAR_SECONDS) : t().mail.copied;
  if (state === 'fail') return t().mail.copyFailed;
  return '';
}

// Explanation of the "i" icon (InfoTip).

/** What an explanation knows: whether the mouse is over it, whether the button has focus and whether Escape closed it. `shown`
 *  is derived from the rest. */
export interface InfoTipState {
  readonly hovered: boolean;
  readonly focused: boolean;
  readonly dismissed: boolean;
  readonly shown: boolean;
}
export type InfoTipEvent = 'enter' | 'leave' | 'focus' | 'blur' | 'escape';

function infoTipState(hovered: boolean, focused: boolean, dismissed: boolean): InfoTipState {
  // With neither mouse nor focus the dismissal is forgotten: next time it shows again.
  const kept = dismissed && (hovered || focused);
  return { hovered, focused, dismissed: kept, shown: (hovered || focused) && !kept };
}

export const INFO_TIP_IDLE: InfoTipState = infoTipState(false, false, false);

/** Shows on hover or with focus. Escape hides it without moving focus (WCAG 1.4.13: it can be dismissed) and
 *  it stays hidden until the mouse and focus leave. */
export function infoTip(s: InfoTipState, event: InfoTipEvent): InfoTipState {
  switch (event) {
    case 'enter':
      return infoTipState(true, s.focused, s.dismissed);
    case 'leave':
      return infoTipState(false, s.focused, s.dismissed);
    case 'focus':
      return infoTipState(s.hovered, true, s.dismissed);
    case 'blur':
      return infoTipState(s.hovered, false, s.dismissed);
    case 'escape':
      return s.shown ? infoTipState(s.hovered, s.focused, true) : s;
  }
}
