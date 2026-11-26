// "Nueva dirección" card of the addresses page: a mailbox with a chosen name or a random alias, with the slots left
// (from `get_plan`), the real stage while it is created and, if none remains, the notice that explains it before
// failing.
import { useState } from 'react';
import { explainAfterSync, slotsLeft, quotaNotice } from '../addresses.ts';
import { api, nextOp } from '../api.ts';
import type { AddressView } from '../bindings/AddressView.ts';
import type { NameCheck } from '../bindings/NameCheck.ts';
import type { PlanView } from '../bindings/PlanView.ts';
import type { Quota } from '../bindings/Quota.ts';
import { Aviso } from '../components/Aviso.tsx';
import { Campo } from '../components/Campo.tsx';
import { Icon } from '../components/Icon.tsx';
import { Progreso } from '../components/Progreso.tsx';
import { useMidnightGate } from '../health.ts';
import { NEW_NAME_ID } from '../nav.ts';
import { progressParts } from '../progress.ts';
import { t } from '../i18n/index.ts';
import type { CoreEvents } from '../useCoreEvents.ts';
import { ErrorAviso, MidnightWaiting } from './common.tsx';
import { onSubmitWith } from './forms.ts';
import { useAction } from './useAction.ts';

type Doing = 'check' | 'mailbox' | 'alias';

interface Props {
  events: CoreEvents;
  /** `null` if it has not arrived yet or could not be read: then how many are left is not said. */
  plan: PlanView | null;
  /** "@domain", if known. */
  suffix?: string;
  /** A creation starts (the previous "Dirección creada" is cleared). */
  onStart: () => void;
  onCreated: (address: AddressView) => void;
  /** A creation finished, well or badly: the core may have left, resumed or released a half-done slot. */
  onChanged: () => void;
  onPlan: () => void;
}

/** Name errors: they go in the field, not in the foot notice. */
const NAME_CODES: readonly (string | null)[] = ['nameTaken', 'nameRejected'];

/** Header of an option: the kind and "te quedan X de Y" (only if the plan is known). */
function OptionHead({ title, q }: { title: string; q: Quota | undefined }) {
  return (
    <div className="nm-opcion__cab">
      <span className="nm-opcion__titulo">{title}</span>
      {q && (
        <span className="nm-opcion__precio">
          {t().screensPlan.newAddress.leftBefore}
          <span className="text-monospace">{slotsLeft(q)}</span>
          {t().screensPlan.newAddress.leftMiddle}
          <span className="text-monospace">{q.limit}</span>
        </span>
      )}
    </div>
  );
}

/** What the field says after "Comprobar": available (confirmation) or not (field error). */
function checkMessages(c: NameCheck | null): { ok: string | null; error: string | null } {
  if (!c) return { ok: null, error: null };
  return c.available
    ? { ok: t().screensPlan.newAddress.available(c.normalized), error: null }
    : { ok: null, error: t().screensPlan.newAddress.unavailable(c.normalized) };
}

function QuotaNotice({ plan, onPlan }: { plan: PlanView | null; onPlan: () => void }) {
  const text = quotaNotice(plan);
  if (!text) return null;
  const actions = (
    <button type="button" className="button button-small button-outline-weak nm-btn" onClick={onPlan}>
      {t().screensPlan.newAddress.viewPlans}
    </button>
  );
  return (
    <Aviso tone="info" actions={actions}>
      <p>{text}</p>
    </Aviso>
  );
}

export function NewAddress({ events, plan, suffix, onStart, onCreated, onChanged, onPlan }: Props) {
  const [name, setName] = useState('');
  const [checked, setChecked] = useState<NameCheck | null>(null);
  const [op, setOp] = useState<number | null>(null);
  const [doing, setDoing] = useState<Doing | null>(null);
  const { busy, error, code, run, setError } = useAction();
  const midnight = useMidnightGate();

  // Busy disables nothing (focus would be lost): each handler carries its guard. The core does one address operation
  // at a time, so none is started here either while one lasts.
  const empty = name.trim() === '';
  async function check() {
    if (busy || midnight.checking || empty) return;
    setDoing('check');
    const r = await run(() => api.checkName(name));
    if (r) setChecked(r);
  }
  async function create(kind: Doing, action: (op: number) => Promise<AddressView>) {
    if (busy || midnight.checking) return;
    // Creating needs the network and the proof server: if something is missing, it does not start and says what.
    if (!(await midnight.gate('pruebas'))) {
      setError(null);
      return;
    }
    const myOp = nextOp();
    setOp(myOp);
    setDoing(kind);
    onStart();
    const created = name;
    // The core syncs again on its own before creating: a `staleState` here only asks to try again later.
    const address = await run(() => action(myOp), explainAfterSync);
    onChanged();
    setChecked(null);
    if (!address) return;
    // Only cleared if the created name is still there: what was typed meanwhile is not lost.
    if (kind === 'mailbox') setName((n) => (n === created ? '' : n));
    onCreated(address);
  }

  const now = busy ? doing : null;
  const progress = now !== null && op !== null ? events.progress[op] : undefined;
  const stage = progress ? progressParts(progress) : null;
  const stageView = stage && (
    <>
      <Progreso stage={stage.stage} note={stage.note ?? undefined} />
      <MidnightWaiting show={midnight.waiting} />
    </>
  );
  const mailboxFull = plan !== null && slotsLeft(plan.mailboxes) === 0;
  const aliasFull = plan !== null && slotsLeft(plan.aliases) === 0;
  const messages = checkMessages(checked);
  const nameError = NAME_CODES.includes(code) ? error : null;
  return (
    <section className="nm-tarjeta">
      {/* With no field (mailboxes used up), focus from "Nueva dirección" and from after creating comes to the title. */}
      <h2 className="nm-tarjeta__titulo" id={mailboxFull ? NEW_NAME_ID : undefined} tabIndex={mailboxFull ? -1 : undefined}>
        {t().screensMail.sidebar.newAddress}
      </h2>
      <QuotaNotice plan={plan} onPlan={onPlan} />
      <form className="nm-opcion" onSubmit={onSubmitWith(() => void check())}>
        <OptionHead title={t().screensPlan.newAddress.mailbox} q={plan?.mailboxes} />
        {!mailboxFull && (
          <>
            <p className="nm-suave">{t().screensPlan.newAddress.youChoose}</p>
            <Campo
              id={NEW_NAME_ID}
              label={t().screensPlan.newAddress.mailboxName}
              value={name}
              onChange={(v) => {
                setName(v);
                setChecked(null);
              }}
              suffix={suffix}
              ok={messages.ok}
              error={messages.error ?? nameError}
            />
          </>
        )}
        {now === 'mailbox' && stageView}
        <div className="nm-fila">
          <button
            type="button"
            className="button button-medium button-solid-norm nm-btn"
            disabled={mailboxFull || empty}
            aria-busy={now === 'mailbox' || undefined}
            onClick={() => void create('mailbox', (o) => api.createMailbox(name, o))}
          >
            {now === 'mailbox' ? t().screensPlan.newAddress.creating : t().screensPlan.newAddress.createMailbox}
          </button>
          {!mailboxFull && (
            <button type="submit" className="button button-medium button-outline-weak nm-btn" disabled={empty} aria-busy={now === 'check' || undefined}>
              {now === 'check' ? t().screensPlan.checking : t().screensPlan.newAddress.check}
            </button>
          )}
        </div>
      </form>
      <div className="nm-opcion">
        <OptionHead title={t().screensPlan.newAddress.alias} q={plan?.aliases} />
        {!aliasFull && <p className="nm-suave">{t().screensPlan.newAddress.aliasNote}</p>}
        {now === 'alias' && stageView}
        <div className="nm-fila">
          <button
            type="button"
            className="button button-medium button-outline-weak nm-btn"
            disabled={aliasFull}
            aria-busy={now === 'alias' || undefined}
            onClick={() => void create('alias', (o) => api.createAlias(o))}
          >
            <Icon name="plus" className="nm-ic" />
            {now === 'alias' ? t().screensPlan.newAddress.creating : t().screensPlan.newAddress.createAlias}
          </button>
        </div>
      </div>
      <p className="nm-pista">{t().screensPlan.newAddress.proofNote}</p>
      <ErrorAviso message={midnight.blocker} tone="atencion" />
      <ErrorAviso message={nameError ? null : error} code={code} syncsByItself />
    </section>
  );
}
