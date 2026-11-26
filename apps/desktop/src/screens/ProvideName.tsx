// Asks for the name of a restored mailbox that has none and calls `provide_name`. Only the form: whoever uses it puts
// the explanation around it (the "Restauración terminada" card, the "Direcciones" row) and the field label.
import { useState } from 'react';
import { explainAfterSync } from '../addresses.ts';
import { api, nextOp } from '../api.ts';
import type { SlotId } from '../bindings/SlotId.ts';
import { Campo } from '../components/Campo.tsx';
import { t } from '../i18n/index.ts';
import { ErrorAviso } from './common.tsx';
import { onSubmitWith } from './forms.ts';
import { useAction } from './useAction.ts';

interface Props {
  slot: SlotId;
  /** Field label; whoever uses it decides whether it names the slot (outside a card that already says so). */
  label: string;
  /** "@domain", if known (see `mailDomain`); without it, the field has no suffix. */
  suffix?: string;
  /** Reports when checking the name starts and ends (whoever uses it can keep it in view meanwhile). */
  onBusy?: (busy: boolean) => void;
  onDone: () => void;
}

export function ProvideName({ slot, label, suffix, onBusy, onDone }: Props) {
  const [name, setName] = useState('');
  const { busy, error, code, run } = useAction();

  async function submit() {
    onBusy?.(true);
    // The core syncs again on its own first: a `staleState` here only asks to try again later.
    const ok = await run(() => api.provideName(slot, name, nextOp()), explainAfterSync);
    onBusy?.(false);
    if (ok) onDone();
  }

  // Busy does not disable the button (focus would be lost): the guard is in the handler.
  const empty = name.trim() === '';
  const send = () => {
    if (!busy && !empty) void submit();
  };
  // The error may not be about the name (Midnight down, store): it goes in a notice and does not mark the field invalid.
  return (
    <form className="nm-pila" onSubmit={onSubmitWith(send)}>
      <Campo label={label} value={name} onChange={setName} suffix={suffix} />
      <div className="nm-fila">
        <button type="submit" className="button button-medium button-outline-weak nm-btn" disabled={empty} aria-busy={busy || undefined}>
          {busy ? t().screensPlan.checking : t().screensPlan.provideName.save}
        </button>
      </div>
      <ErrorAviso message={error} code={code} syncsByItself />
    </form>
  );
}
