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

/** What the "Copiar" notice (`role="status"`) says for the result; nothing until it has been pressed. */
export function copyStatus(state: 'idle' | 'ok' | 'fail'): string {
  if (state === 'ok') return t().mail.copied;
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
