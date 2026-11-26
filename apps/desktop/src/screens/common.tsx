// Small pieces shared by the screens.
import { useState } from 'react';
import { api } from '../api.ts';
import { Aviso } from '../components/Aviso.tsx';
import { describeError } from '../errors.ts';
import { midnightWaitingText } from '../health.ts';
import { t } from '../i18n/index.ts';

/** For a lasting `staleState`: syncs with the chain again (`retry_stale`) so the action can be repeated. `onDone`, on
 *  success (in the `resume` notice: resume what is pending again). When `resetOn` changes (a new report, which may
 *  carry `staleState` again), it can be pressed again. */
export function StaleRetry({ onDone, resetOn }: { onDone?: () => void; resetOn?: unknown }) {
  const [phase, setPhase] = useState<'idle' | 'busy' | 'done'>('idle');
  const [seen, setSeen] = useState(resetOn);
  if (seen !== resetOn) {
    setSeen(resetOn);
    setPhase('idle');
  }
  // The error is stored, not its text: it is translated when painting (the language may change with the notice in view).
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
  async function retry() {
    if (phase === 'busy') return;
    setPhase('busy');
    setFailure(null);
    try {
      await api.retryStale();
      setPhase('done');
      onDone?.();
    } catch (e) {
      setFailure({ error: e });
      setPhase('idle');
    }
  }
  const words = t().screensMail.common;
  if (phase === 'done') return <p>{onDone ? words.retryDoneApp : words.retryDoneRepeat}</p>;
  // Busy does not disable the button (focus would be lost): `retry` does nothing if already running.
  return (
    <>
      <button type="button" className="button button-small button-outline-weak nm-btn" aria-busy={phase === 'busy' || undefined} onClick={retry}>
        {phase === 'busy' ? words.syncing : words.syncAgain}
      </button>
      {failure && <p role="alert">{describeError(failure.error)}</p>}
    </>
  );
}

/** Global strip: the app's exit was postponed until a payment finishes (`exitDeferred`). */
export function ExitNotice() {
  return (
    <Aviso tone="info" strip>
      <p>{t().screensMail.common.exitDeferred}</p>
    </Aviso>
  );
}

/** Error of an action that belongs to no particular field: an error notice, or nothing. With `code`, the
 *  action that fixes it ("Volver a sincronizar" for `staleState`); `tone`, for what is not a failure but a wait.
 *  `syncsByItself`: the action already synced again on its own (what creates an address), so `staleState` gets no
 *  button: trying again later is enough. */
export function ErrorAviso({
  message,
  code,
  tone = 'error',
  syncsByItself = false,
}: {
  message: string | null;
  code?: string | null;
  tone?: 'error' | 'atencion';
  syncsByItself?: boolean;
}) {
  if (!message) return null;
  return (
    <Aviso tone={tone} actions={code === 'staleState' && !syncsByItself ? <StaleRetry /> : undefined}>
      <p>{message}</p>
    </Aviso>
  );
}

/** Under the progress of a running operation, if Midnight stops answering. It does not cancel it: it only says so. */
export function MidnightWaiting({ show }: { show: boolean }) {
  return show ? <p className="nm-pista">{midnightWaitingText()}</p> : null;
}
