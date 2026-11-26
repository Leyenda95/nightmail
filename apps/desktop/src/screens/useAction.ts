// "Busy"/error state of an asynchronous action.
import { useCallback, useState } from 'react';
import { describeError, errorParts } from '../errors.ts';
import { errorCode } from '../pending.ts';

/** Own text for an error code (or `null`: that of `describeError`). */
export type Explain = (code: string | null) => string | null;

/** The last failure, stored UNTRANSLATED: the text is derived when painting, in the language of that moment.
 *  `explain` is only stored if it gave its own text, so it can be asked again in the other language. */
export interface Failure {
  error: unknown;
  explain?: Explain;
}

/** The failure text in the current language. */
export function failureText(failure: Failure | null): string | null {
  if (failure === null) return null;
  return failure.explain?.(errorCode(failure.error)) ?? describeError(failure.error);
}

/** Only "what happened", in the current language. */
export function failureWhat(failure: Failure | null): string | null {
  return failure === null ? null : errorParts(failure.error).what;
}

/**
 * Runs an asynchronous action keeping "busy", the last error and its code (to offer the action that fixes it, e.g.
 * "Volver a sincronizar" for `staleState`). It never stores the raw exception text, nor the already translated
 * text: the error is stored and translated when painting, so it follows the language without restarting.
 * `onBusy` reports upwards (the busy wallet is shared between sections).
 */
export function useAction(onBusy?: (busy: boolean) => void) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  /** Only to clear the error (`setError(null)`): a loose text would not change language. */
  const setError = useCallback((cleared: null) => setFailure(cleared), []);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, explain?: Explain): Promise<T | undefined> => {
      setBusy(true);
      onBusy?.(true);
      setFailure(null);
      try {
        return await fn();
      } catch (e) {
        // `explain` is called here once: some callers note something on seeing it (PlanSection, `busy`). Note: if it gives
        // its own text, it is stored and called again on EVERY paint (`failureText`, for the language of that
        // moment). So an `explain` with side effects (noting something) must return `null`, like PlanSection's: then
        // it is not stored and its effect happens only here.
        setFailure(explain?.(errorCode(e)) != null ? { error: e, explain } : { error: e });
        return undefined;
      } finally {
        setBusy(false);
        onBusy?.(false);
      }
    },
    [onBusy],
  );
  // "What happened" is used by notices that already carry their own "what is safe" and "what you can do".
  const code = failure === null ? null : errorCode(failure.error);
  return { busy, error: failureText(failure), code, what: failureWhat(failure), run, setError };
}
