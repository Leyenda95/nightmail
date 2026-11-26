// Result of a restore and retry of the pending recovery. On the front screen (after restoring) they are the whole
// screen; inside the main view (a late result or a failure after unlocking) they are a dialog and a notice strip.
import { Fragment, useState, type ReactNode } from 'react';
import { api, nextOp } from '../api.ts';
import type { RecoveryReport } from '../bindings/RecoveryReport.ts';
import { Aviso } from '../components/Aviso.tsx';
import { Dialogo } from '../components/Dialogo.tsx';
import { Icon } from '../components/Icon.tsx';
import { recoveryFacts, slotKindName } from '../format.ts';
import { t } from '../i18n/index.ts';
import { ProvideName } from './ProvideName.tsx';
import { useAction } from './useAction.ts';

interface BodyProps {
  report: RecoveryReport;
  /** Where it is seen: on the front screen the title is an `h1` (the cards, `h2`); in the dialog the title is already an `h2`. */
  where: 'portada' | 'dialogo';
  /** What goes between the cards and the closing note (on the front screen, "Continuar"). */
  children?: ReactNode;
}

/** What was recovered and, for each mailbox with no name, the card to write it. */
function RecoveryBody({ report, where, children }: BodyProps) {
  const [pending, setPending] = useState(report.needsName);
  const CardHeading = where === 'portada' ? 'h2' : 'h3';
  const s = t().onboarding.recovery;
  return (
    <>
      <p>{s.intro}</p>
      <dl className="nm-datos">
        {recoveryFacts(report).map(([label, count]) => (
          <Fragment key={label}>
            <dt>{label}</dt>
            <dd className="text-monospace">{count}</dd>
          </Fragment>
        ))}
      </dl>
      {pending.map((slot, i) => (
        <section key={`${slot.n}/${slot.kind}/${slot.j}`} className="nm-tarjeta nm-tarjeta--hundida">
          <CardHeading className="nm-tarjeta__titulo">{s.missingName(slotKindName(slot))}</CardHeading>
          <p className="nm-suave">{s.missingNameText(slotKindName(slot))}</p>
          <ProvideName slot={slot} label={s.nameLabel(slotKindName(slot))} onDone={() => setPending((p) => p.filter((_, k) => k !== i))} />
        </section>
      ))}
      {children}
      {pending.length > 0 && <p className={where === 'portada' ? 'nm-portada__pie' : 'nm-pista'}>{s.later}</p>}
    </>
  );
}

const CONTINUE = 'button button-large button-solid-norm nm-btn w-full';

/** "Restauración terminada" at full screen (front screen). */
export function RecoveryResult({ report, onDone }: { report: RecoveryReport; onDone: () => void }) {
  const s = t().onboarding.recovery;
  return (
    <>
      <h1 className="nm-portada__titulo nm-portada__titulo--s">{s.doneTitle}</h1>
      <RecoveryBody report={report} where="portada">
        <button type="button" className={CONTINUE} onClick={onDone}>
          {s.continue}
        </button>
      </RecoveryBody>
    </>
  );
}

/** The late result of a restore (the "Restauración terminada" card, in a dialog). Esc = "Continuar". */
export function RecoveryDialog({ report, onDone }: { report: RecoveryReport; onDone: () => void }) {
  const s = t().onboarding.recovery;
  return (
    <Dialogo
      title={s.doneTitle}
      size="l"
      onClose={onDone}
      footer={
        <button type="button" className="button button-medium button-solid-norm nm-btn" onClick={onDone}>
          {s.continue}
        </button>
      }
    >
      <RecoveryBody report={report} where="dialogo" />
    </Dialogo>
  );
}

interface RetryProps {
  /** What happened (`errorParts().what`): the notice already carries its "what is safe" and its button. */
  message?: string | null;
  onReport: (r: RecoveryReport) => void;
  /** Global strip of the main view; without it, the notice and the large button of the front screen. */
  strip?: boolean;
}

/** "Reintentar restauración": calls `recover` again; until it succeeds, plan and addresses fail with `recoveryPending`. */
export function RecoveryRetry({ message, onReport, strip = false }: RetryProps) {
  const { busy, what, run } = useAction();
  async function retry() {
    if (busy) return;
    const r = await run(() => api.recover(nextOp()));
    if (r) onReport(r);
  }
  const s = t().onboarding.recovery;
  const cause = what || message || null;
  // Busy does not disable the button (focus would be lost): `retry` does nothing if already running.
  const button = (
    <button
      type="button"
      className={strip ? 'button button-small button-outline-weak nm-btn' : 'button button-large button-solid-norm nm-btn w-full'}
      aria-busy={busy || undefined}
      onClick={retry}
    >
      <Icon name="arrows-rotate" className="nm-ic" />
      {busy ? s.retrying : s.retry}
    </button>
  );
  const safe = <p className="nm-suave">{s.safe}</p>;
  if (strip) {
    return (
      <Aviso tone="error" strip actions={button}>
        <p>
          <strong>{s.notCompleted}</strong> {cause}
        </p>
        {safe}
      </Aviso>
    );
  }
  return (
    <>
      <Aviso tone="error">
        {cause && <p>{cause}</p>}
        {safe}
      </Aviso>
      {button}
    </>
  );
}
