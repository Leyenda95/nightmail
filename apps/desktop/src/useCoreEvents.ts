// A single listener for the Tauri `nightmail` event (payload `AppEvent`).
import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { api } from './api.ts';
import type { AppEvent } from './bindings/AppEvent.ts';
import type { OrchError } from './bindings/OrchError.ts';
import type { Progress } from './bindings/Progress.ts';
import type { RecoveryReport } from './bindings/RecoveryReport.ts';
import type { ResumeReport } from './bindings/ResumeReport.ts';
import { afterSync } from './newMail.ts';
import { IDLE_PASS, nextPass, withoutResume, type PassStep, type ResumePass } from './pending.ts';

interface CoreState {
  /** Latest progress stage per operation. */
  progress: Record<number, Progress>;
  /** Rises with each `synced` and `addressesChanged`: used to refresh the inbox, the archive and the plan. */
  syncTick: number;
  /** Rises with each `pendingChanged` (a half-done slot starts or stops running): re-reads "En proceso". */
  pendingTick: number;
  /** Rises with each `walletChanged` (the background DUST registration finished): the wallet shown is re-read. */
  walletTick: number;
  resume: ResumeReport | null;
  resumeError: OrchError | null;
  /** Whether a `resume` pass is running (requested or in the background): the notice and the rows say the same. */
  resumePass: ResumePass;
  /** A pending recovery retried on unlock and completed. */
  recovered: RecoveryReport | null;
  recoverFailed: OrchError | null;
  /** Exit was postponed until a payment finishes. */
  exitDeferred: boolean;
  /** New messages that arrived in the session, without backlog (`newMail.ts`): the new-mail notice comes from here. */
  mailArrived: number;
}

export interface CoreEvents extends CoreState {
  /** Retries everything pending now (`resume_now`). The result arrives as an event; meanwhile `resumePass`
   *  is running. Throws if the request does not reach the core. */
  retryResume: () => Promise<void>;
}

const INITIAL: CoreState = {
  progress: {},
  syncTick: 0,
  pendingTick: 0,
  walletTick: 0,
  resume: null,
  resumeError: null,
  resumePass: IDLE_PASS,
  recovered: null,
  recoverFailed: null,
  exitDeferred: false,
  mailArrived: 0,
};

const step = (state: CoreState, s: PassStep): CoreState => ({ ...state, resumePass: nextPass(state.resumePass, s) });

function reduce(state: CoreState, ev: AppEvent): CoreState {
  switch (ev.kind) {
    case 'progress':
      return { ...state, progress: { ...state.progress, [ev.event.op]: ev.event.progress } };
    case 'synced':
      return { ...state, syncTick: state.syncTick + 1, mailArrived: afterSync(state.mailArrived, ev.report) };
    case 'resumeStarted':
      return step(state, 'started');
    case 'resumed':
      return { ...step(state, 'finished'), resume: ev.report, resumeError: null };
    case 'resumeFailed':
      return { ...step(state, 'finished'), resumeError: ev.error };
    case 'recovered':
      return { ...state, recovered: ev.report, recoverFailed: null };
    case 'recoverFailed':
      return { ...state, recoverFailed: ev.error };
    case 'exitDeferred':
      return { ...state, exitDeferred: true };
    case 'pendingChanged':
      return { ...state, pendingTick: state.pendingTick + 1 };
    case 'walletChanged':
      return { ...state, walletTick: state.walletTick + 1 };
    case 'addressesChanged':
      // They re-read the inbox and the plan, as with a sync round.
      return { ...state, syncTick: state.syncTick + 1 };
  }
}

/** The events, and `clearResume` to forget the `resume` notice on locking. */
export function useCoreEvents(): CoreEvents & { clearResume: () => void } {
  const [state, setState] = useState<CoreState>(INITIAL);
  const clearResume = useCallback(() => setState(withoutResume), []);
  const retryResume = useCallback(async () => {
    setState((s) => step(s, 'asked'));
    try {
      await api.resumeNow();
    } catch (e) {
      // With no session there will be no pass: it does not stay at "Reintentando...". The error remains for whoever shows it.
      setState((s) => step(s, 'askFailed'));
      throw e;
    }
  }, []);
  useEffect(() => {
    const unlisten = listen<AppEvent>('nightmail', (e) => setState((s) => reduce(s, e.payload)));
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);
  return { ...state, retryResume, clearResume };
}
