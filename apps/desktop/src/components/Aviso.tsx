// Notice: what happened, what is still safe (only when money is at stake), what you can do. Always with icon and text, never colour alone.
import type { ReactNode } from 'react';
import { avisoClass, avisoIcon, avisoRole, type AvisoTone } from '../pieces.ts';
import { Icon } from './Icon.tsx';

interface Props {
  tone: AvisoTone;
  /** Global strip: edge to edge, above the panels. */
  strip?: boolean;
  /** Buttons that fix what the notice reports; they go to the right of the text, and under it only when the row has no room. */
  actions?: ReactNode;
  /** A notice that can be closed: a plain "X" after the actions (only the icon, no box), named `label`. */
  dismiss?: { label: string; onDismiss: () => void };
  /** The role, if the tone's does not fit. `null`: none, because a separate, always-mounted region announces it. */
  role?: 'alert' | 'status' | null;
  /** The text, in paragraphs (`<p>`); what is still safe goes in one with the `nm-suave` class. */
  children: ReactNode;
}

export function Aviso({ tone, strip = false, actions, dismiss, role, children }: Props) {
  return (
    <div className={avisoClass(tone, strip)} role={role === undefined ? avisoRole(tone) : (role ?? undefined)}>
      <div className="nm-aviso__principal">
        <Icon name={avisoIcon(tone)} className="nm-ic" />
        <div className="nm-aviso__cuerpo">{children}</div>
      </div>
      {(actions || dismiss) && (
        <div className="nm-aviso__acciones">
          {actions}
          {dismiss && (
            <button type="button" className="nm-aviso__cerrar" title={dismiss.label} aria-label={dismiss.label} onClick={dismiss.onDismiss}>
              <Icon name="cross" className="nm-ic" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
