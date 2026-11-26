// Global notice about pending work resumed on unlock (`resume`), in the strip above the panels: what failed, what to do
// and "Reintentar ahora" (with "Volver a sincronizar" for a `staleState`). If the NightMail server does not answer, it
// says so and explains that the button will work when it returns.
import type { SlotId } from '../bindings/SlotId.ts';
import { Aviso } from '../components/Aviso.tsx';
import { Icon } from '../components/Icon.tsx';
import { known, useServerHealth } from '../health.ts';
import { t } from '../i18n/index.ts';
import { resumeBusy, resumeSummary, resumeTitle, retryNowButton } from '../notices.ts';
import { passBusy } from '../pending.ts';
import type { CoreEvents } from '../useCoreEvents.ts';
import { StaleRetry } from './common.tsx';

/** `pending`: the slots that are still half-done (`null` if unknown). The report is from a pass already gone: of the
 *  slots it names, only those appear (one finished another way, like creating an alias, no longer does). */
export function ResumeNotices({ events, pending }: { events: CoreEvents; pending: readonly SlotId[] | null }) {
  const { resume, resumeError, resumePass, retryResume } = events;
  // Running from the press until the result of its pass, and also during a background pass: it is when
  // the "En proceso" rows say "en proceso".
  const busy = passBusy(resumePass);
  // The same check as the sidebar's server line: if it does not answer, the notice says so.
  const server = known(useServerHealth());
  // An empty report clears it; the bonos' `busy` is not shown; with `staleState`, "Volver a sincronizar".
  const summary = resumeSummary(resume, resumeError, pending, server);
  if (!summary) return null;
  function retryNow() {
    // The button has no `disabled` (it would lose focus): while running, it does nothing. If the session is gone, the screen
    // changes by itself.
    if (!busy) retryResume().catch(() => {});
  }
  const actions = (
    <>
      <button
        type="button"
        className="button button-small button-outline-weak nm-btn"
        aria-busy={busy || undefined}
        aria-disabled={busy || undefined}
        onClick={retryNow}
      >
        <Icon name={busy ? 'espera' : 'arrows-rotate'} className="nm-ic" />
        {busy ? t().onboarding.resume.retrying : retryNowButton()}
      </button>
      {summary.stale && !busy && <StaleRetry onDone={retryNow} resetOn={resumeError ?? resume} />}
    </>
  );
  // While retrying, the previous result is no longer valid: it only says it is running.
  if (busy) {
    return (
      <Aviso tone="info" strip actions={actions}>
        <p>
          <strong>{resumeBusy()}</strong> {t().onboarding.resume.meanwhile}
        </p>
      </Aviso>
    );
  }
  return (
    <Aviso tone="atencion" strip actions={actions}>
      <p>
        <strong>{resumeTitle()}</strong> {summary.cause}
      </p>
      {summary.lines.length > 0 && (
        <ul>
          {summary.lines.map((l) => (
            <li key={l.key}>
              {l.mono ? <span className="text-monospace">{l.label}</span> : l.label} {l.text}
            </li>
          ))}
        </ul>
      )}
    </Aviso>
  );
}
