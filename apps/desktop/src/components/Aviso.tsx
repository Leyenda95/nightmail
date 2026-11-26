// Notice: what happened, what is still safe (only when money is at stake), what you can do. Always with icon and text, never colour alone.
import type { ReactNode } from 'react';
import { avisoClass, avisoIcon, avisoRole, type AvisoTone } from '../pieces.ts';
import { Icon } from './Icon.tsx';

interface Props {
  tone: AvisoTone;
  /** Global strip: edge to edge, above the panels. */
  strip?: boolean;
  /** Buttons that fix what the notice reports; they go under the text. */
  actions?: ReactNode;
  /** The role, if the tone's does not fit. `null`: none, because a separate, always-mounted region announces it. */
  role?: 'alert' | 'status' | null;
  /** The text, in paragraphs (`<p>`); what is still safe goes in one with the `nm-suave` class. */
  children: ReactNode;
}

export function Aviso({ tone, strip = false, actions, role, children }: Props) {
  return (
    <div className={avisoClass(tone, strip)} role={role === undefined ? avisoRole(tone) : (role ?? undefined)}>
      <Icon name={avisoIcon(tone)} className="nm-ic" />
      <div className="nm-aviso__cuerpo">
        {children}
        {actions && <div className="nm-aviso__acciones">{actions}</div>}
      </div>
    </div>
  );
}
