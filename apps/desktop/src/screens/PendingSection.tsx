// Half-done mailboxes and aliases: resume those paused by the proof cap and abandon those not yet reserved. It is a card
// of "Direcciones" and only appears if there is any; the menu flags it with "N en proceso" or "N detenidas".
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FocusEvent } from 'react';
import { explainAfterSync } from '../addresses.ts';
import { api, nextOp } from '../api.ts';
import type { PendingSlot } from '../bindings/PendingSlot.ts';
import { Dialogo } from '../components/Dialogo.tsx';
import { Icon } from '../components/Icon.tsx';
import { Progreso } from '../components/Progreso.tsx';
import {
  actionLabels,
  passBusy,
  pendingButton,
  pendingParts,
  rowActions,
  slotKey,
  stillPendingText,
  type PendingActions,
} from '../pending.ts';
import { progressParts } from '../progress.ts';
import { t } from '../i18n/index.ts';
import type { CoreEvents } from '../useCoreEvents.ts';
import { ErrorAviso } from './common.tsx';
import { useAction } from './useAction.ts';

const SMALL = 'button button-small nm-btn';

/** Confirms cancelling the creation (a dialog; destructive action, focus on "No"). */
function AbandonDialog({ onYes, onNo }: { onYes: () => void; onNo: () => void }) {
  const footer = (
    <>
      <button type="button" className="button button-medium button-solid-weak nm-btn" onClick={onNo}>
        {t().screensPlan.pending.keepGoing}
      </button>
      <button type="button" className="button button-medium button-solid-danger nm-btn" onClick={onYes}>
        {t().screensPlan.pending.yesCancel}
      </button>
    </>
  );
  return (
    <Dialogo title={t().screensPlan.pending.cancelTitle} size="s" footer={footer} onClose={onNo} described>
      <p>{t().screensPlan.pending.cancelBody}</p>
    </Dialogo>
  );
}

interface RowProps {
  p: PendingSlot;
  events: CoreEvents;
  onChanged: () => void;
}

function PendingRow({ p, events, onChanged }: RowProps) {
  const [op, setOp] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const { busy, error, code, run } = useAction();
  // While "Reanudar" lasts, its buttons of that moment (`rowActions`): re-read midway, it would come out unpaused.
  const [frozen, setFrozen] = useState<PendingActions | null>(null);
  const actions = rowActions(p, frozen);
  const { who, what, stage, stopped, state } = pendingParts(p);
  const labels = actionLabels(what);

  // If what had focus disappears (the row switches to "en proceso" after "Reintentar"), focus would
  // go to the top of the page: it is moved to the step line. Only if that is gone and focus has not gone elsewhere.
  // A click on a slot (focus goes nowhere with the button still set) forgets it.
  const statusRef = useRef<HTMLDivElement>(null);
  const lastFocused = useRef<HTMLElement | null>(null);
  const remember = (e: FocusEvent<HTMLElement>) => {
    if (e.target instanceof HTMLElement) lastFocused.current = e.target;
  };
  const forget = (e: FocusEvent<HTMLElement>) => {
    if (e.relatedTarget === null && e.target.isConnected) lastFocused.current = null;
  };
  useLayoutEffect(() => {
    const active = document.activeElement;
    const gone = lastFocused.current !== null && !lastFocused.current.isConnected;
    if (!gone || (active !== null && active !== document.body)) return;
    lastFocused.current = null;
    statusRef.current?.focus();
  }, [actions.resume, actions.retry, actions.abandon]);

  // Busy does not disable the buttons (focus would be lost): each handler carries its guard.
  // After any end (an error too) the list is re-read: the slot may have changed step.
  async function resume() {
    if (busy) return;
    const myOp = nextOp();
    setOp(myOp);
    setFrozen(actions);
    // The core syncs again on its own first: a `staleState` here only asks to try again later.
    await run(() => api.resumePausedSlot(p.slot, myOp), explainAfterSync);
    setFrozen(null);
    onChanged();
  }
  // A retry pass running (requested here, in the notice or in the background): "Reintentar" does not repeat it.
  const passing = passBusy(events.resumePass);
  async function retry() {
    // The result arrives as an event (`resumed`/`resumeFailed`) and the list is re-read with it. Meanwhile the notice
    // above also says "Reintentando...". With a pass already running it does nothing (like the notice's button).
    // Stopped because Midnight's data was out of date: it syncs again on its own first, as creating does, so the
    // user never needs "Volver a sincronizar" here.
    if (busy || passing) return;
    await run(async () => {
      if (p.stopReason?.code === 'staleState') await api.retryStale();
      await events.retryResume();
    }, explainAfterSync);
  }
  async function abandon() {
    setConfirming(false);
    if (busy) return;
    await run(
      () => api.abandonSlot(p.slot),
      (c) => (c === 'stillPending' ? stillPendingText('slot', p.paused) : null),
    );
    onChanged();
  }

  const progress = busy && op !== null ? events.progress[op] : undefined;
  const shown = progress ? progressParts(progress) : null;
  return (
    <li>
      <Icon name={stopped ? 'pause' : 'espera'} className="nm-ic" />
      <div className="nm-filas__principal">
        <div className="nm-filas__titulo">
          <span className={p.name ? 'text-monospace' : undefined}>{who}</span>
        </div>
        {/* The "·" is not read. Only the state is announced on change: the whole line is read if it receives focus. */}
        <div className="nm-filas__sub" ref={statusRef} tabIndex={-1}>
          {stage} <span aria-hidden="true">·</span> <span aria-live="polite">{state}</span>
        </div>
      </div>
      <div className="nm-fila" onFocus={remember} onBlur={forget}>
        {actions.resume && (
          <button
            type="button"
            className={`${SMALL} button-outline-weak`}
            aria-label={labels.resume}
            aria-busy={busy || undefined}
            onClick={resume}
          >
            {pendingButton().resume}
          </button>
        )}
        {actions.retry && (
          <button
            type="button"
            className={`${SMALL} button-outline-weak`}
            aria-label={labels.retry}
            aria-busy={busy || passing || undefined}
            aria-disabled={passing || undefined}
            onClick={retry}
          >
            {pendingButton().retry}
          </button>
        )}
        {actions.abandon && (
          <button type="button" className={`${SMALL} button-outline-weak`} aria-label={labels.abandon} onClick={() => setConfirming(true)}>
            {t().screensPlan.cancel}
          </button>
        )}
      </div>
      {(shown || error) && (
        <div className="nm-filas__ancho nm-pila">
          {shown && <Progreso stage={shown.stage} note={shown.note ?? undefined} />}
          <ErrorAviso message={error} code={code} tone={code === 'stillPending' ? 'atencion' : 'error'} syncsByItself />
        </div>
      )}
      {/* If meanwhile it can no longer be cancelled (it becomes "en proceso"), the dialog closes by itself. */}
      {confirming && actions.abandon && <AbandonDialog onYes={abandon} onNo={() => setConfirming(false)} />}
    </li>
  );
}

interface Props {
  events: CoreEvents;
  reloadKey: number;
  onChanged: () => void;
  /** The list after each read, or `null` if it could not be read (the menu label and the `resume` notice). */
  onList: (list: readonly PendingSlot[] | null) => void;
}

export function PendingSection({ events, reloadKey, onChanged, onList }: Props) {
  const [pending, setPending] = useState<PendingSlot[]>([]);

  // Without Midnight there is nothing to do with them: a failure reading the list only hides it. Reads may
  // answer out of order: only the last one requested counts.
  const asked = useRef(0);
  const load = useCallback(async () => {
    const mine = ++asked.current;
    const list = await api.listPendingSlots().catch(() => null);
    if (mine !== asked.current) return;
    setPending(list ?? []);
    onList(list);
  }, [onList]);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- syncs with the backend (external system): setState happens after an await, not synchronously.
    void load();
  }, [reloadKey, events.resume, events.resumeError, events.pendingTick, load]);

  const changed = useCallback(() => {
    void load();
    onChanged();
  }, [load, onChanged]);

  if (pending.length === 0) return null;
  return (
    <section className="nm-tarjeta">
      <div className="nm-tarjeta__cab">
        <h2 className="nm-tarjeta__titulo">{t().screensPlan.pending.title}</h2>
        <span className="text-monospace">{pending.length}</span>
      </div>
      <ul className="nm-filas">
        {pending.map((p) => (
          <PendingRow key={slotKey(p.slot)} p={p} events={events} onChanged={changed} />
        ))}
      </ul>
    </section>
  );
}
