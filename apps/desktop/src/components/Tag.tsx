// Small label: the kind of an address ("Buzón", "Alias") or the state of a bono ("confirmado", "pendiente").
// The tone only accompanies: the text says the state.
import type { ReactNode } from 'react';
import { tagClass, type TagTone } from '../pieces.ts';

export function Tag({ tone, children }: { tone?: TagTone; children: ReactNode }) {
  return <span className={tagClass(tone)}>{children}</span>;
}
