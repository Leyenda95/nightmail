// Plan: your plan (quotas and bonos) and the purchase: free plan, payment with the shielded token or a simulated card
// payment. It only changes how things look: the price confirmed is the contract's, `cannotPay` warns before
// confirming, and while something uses the wallet (this section or the wallet's) the buttons stay disabled.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { abandonedNote } from '../addresses.ts';
import { api, nextOp } from '../api.ts';
import type { BonoView } from '../bindings/BonoView.ts';
import type { PlanView } from '../bindings/PlanView.ts';
import type { Quota } from '../bindings/Quota.ts';
import type { WalletView } from '../bindings/WalletView.ts';
import { Aviso } from '../components/Aviso.tsx';
import { Dialogo } from '../components/Dialogo.tsx';
import { Icon } from '../components/Icon.tsx';
import { Progreso } from '../components/Progreso.tsx';
import { Tag } from '../components/Tag.tsx';
import { useMidnightGate, type Needs } from '../health.ts';
import { bonoParts, cannotPay, offerTitle, planKind, type BonoParts, type PlanKind } from '../payment.ts';
import { stillPendingText } from '../pending.ts';
import { progressParts } from '../progress.ts';
import { quotaPercent } from '../sidebar.ts';
import { t } from '../i18n/index.ts';
import type { CoreEvents } from '../useCoreEvents.ts';
import { ErrorAviso, MidnightWaiting } from './common.tsx';
import { useAction } from './useAction.ts';

const SMALL = 'button button-small nm-btn';
const MEDIUM = 'button button-medium nm-btn';

/** Confirms cancelling a pending bono (a dialog; destructive action, focus on "No"). */
function AbandonDialog({ text, disabled, onYes, onNo }: { text: NonNullable<BonoParts['abandon']>; disabled: boolean; onYes: () => void; onNo: () => void }) {
  const footer = (
    <>
      <button type="button" className={`${MEDIUM} button-solid-weak`} onClick={onNo}>
        {t().screensPlan.plan.keepWaiting}
      </button>
      <button type="button" className={`${MEDIUM} button-solid-danger`} disabled={disabled} onClick={onYes}>
        {text.yes}
      </button>
    </>
  );
  return (
    <Dialogo title={text.title} size="s" footer={footer} onClose={onNo}>
      <p>{text.note}</p>
    </Dialogo>
  );
}

const nowSecs = () => Math.floor(Date.now() / 1000);
/** The longest delay `setTimeout` accepts (~24.8 days); beyond it, it is scheduled again. */
const MAX_DELAY_MS = 2 ** 31 - 1;

/**
 * The current time (in seconds), re-read when `target` arrives: "Se podrá usar a partir del..." disappears
 * on time without remounting the row. A single timer, up to that time and no further.
 */
function useNowUntil(target: number | null): number {
  const [now, setNow] = useState(nowSecs);
  useEffect(() => {
    if (target == null || now >= target) return;
    const ms = Math.min(Math.max(0, target * 1000 - Date.now()) + 250, MAX_DELAY_MS);
    const id = setTimeout(() => setNow(nowSecs()), ms);
    return () => clearTimeout(id);
  }, [target, now]);
  return now;
}

/** A bono; if it did not reach the tree, it can be abandoned to pay another way. */
function BonoRow({ b, disabled, onChanged }: { b: BonoView; disabled: boolean; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const { busy, error, code, run } = useAction();
  const now = useNowUntil(b.usableAt);
  const parts = bonoParts(b, now);

  async function forget() {
    setConfirming(false);
    await run(
      () => api.forgetPendingBono(b.n, b.k),
      (c) => (c === 'stillPending' ? stillPendingText('bono') : null),
    );
    // After an error too: the leaf may have been counted as included rather than abandoned.
    onChanged();
  }

  return (
    <li>
      <Icon name={parts.icon} className="nm-ic" />
      {parts.srOnly && <span className="sr-only">{parts.srOnly}</span>}
      <div className="nm-filas__principal">
        <div className="nm-filas__titulo">
          <span>{parts.title}</span>
          {parts.state && <Tag tone={parts.tone}>{parts.state}</Tag>}
        </div>
        {parts.wait && <div className="nm-filas__sub">{parts.wait}</div>}
      </div>
      {parts.abandon && (
        <button
          type="button"
          className={`${SMALL} button-outline-weak`}
          aria-label={parts.abandon.label}
          disabled={busy || disabled}
          onClick={() => setConfirming(true)}
        >
          {parts.abandon.button}
        </button>
      )}
      {error && (
        <div className="nm-filas__ancho">
          <ErrorAviso message={error} code={code} />
        </div>
      )}
      {confirming && parts.abandon && (
        <AbandonDialog text={parts.abandon} disabled={busy || disabled} onYes={forget} onNo={() => setConfirming(false)} />
      )}
    </li>
  );
}

/** One quota figure. Abandoned ones already count as "usadas" (their slot is not freed): it says how many there are. */
function QuotaFigure({ label, q, abandoned }: { label: string; q: Quota; abandoned: number }) {
  const note = abandonedNote(abandoned);
  return (
    <div className="nm-cupo-dato">
      <span className="nm-suave">{label}</span>
      <span className="nm-cupo-dato__cifra nm-num">
        {q.used} <small>{t().screensPlan.plan.quotaOf(q.limit)}{note && ` ${note}`}</small>
      </span>
      <span className="meter-bar">
        <span className="meter-bar-thumb" style={{ inlineSize: `${quotaPercent(q)}%` }} />
      </span>
    </div>
  );
}

/** The plan label (read when painting: the language changes while the app is open). */
const kindTag = (kind: PlanKind): string | null => (kind === 'none' ? null : kind === 'free' ? t().screensPlan.plan.free : t().screensPlan.plan.paid);

/** "Tu plan": the quota and the bonos (shown if there is any, even a pending one). */
function PlanCard({ plan, kind, disabled, onChanged }: { plan: PlanView; kind: PlanKind; disabled: boolean; onChanged: () => void }) {
  const tag = kindTag(kind);
  return (
    <section className="nm-tarjeta">
      <div className="nm-tarjeta__cab">
        <h2 className="nm-tarjeta__titulo">{t().screensPlan.plan.title}</h2>
        {tag && <Tag>{tag}</Tag>}
      </div>
      <div className="nm-cupos">
        <QuotaFigure label={t().screensMail.sidebar.mailboxes} q={plan.mailboxes} abandoned={plan.mailboxesAbandoned} />
        <QuotaFigure label={t().screensMail.sidebar.aliases} q={plan.aliases} abandoned={plan.aliasesAbandoned} />
      </div>
      <hr className="nm-separador" />
      <ul className="nm-filas">
        {plan.bonos.map((b) => (
          <BonoRow key={`${b.n}/${b.k}`} b={b} disabled={disabled} onChanged={onChanged} />
        ))}
      </ul>
    </section>
  );
}

interface Quote {
  price: string;
  wallet: WalletView;
}

interface QuoteBoxProps {
  quote: Quote;
  busy: boolean;
  disabled: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Contract price and balance before confirming; if it cannot be paid, the reason and no button. */
function QuoteBox({ quote, busy, disabled, onConfirm, onCancel }: QuoteBoxProps) {
  const blocked = cannotPay(quote.price, quote.wallet);
  return (
    <div className="nm-tarjeta nm-tarjeta--hundida">
      <dl className="nm-datos">
        <dt>{t().screensPlan.plan.price}</dt>
        <dd className="text-monospace">{t().screensPlan.plan.amount(quote.price)}</dd>
        <dt>{t().screensPlan.plan.balance}</dt>
        <dd className="text-monospace">{t().screensPlan.plan.amount(quote.wallet.token)}</dd>
      </dl>
      {blocked ? (
        <Aviso tone="atencion">
          <p>{blocked}</p>
        </Aviso>
      ) : (
        <p className="nm-suave">{t().screensPlan.plan.paidFromWallet}</p>
      )}
      <div className="nm-fila">
        {!blocked && (
          <button type="button" className={`${MEDIUM} button-solid-norm`} disabled={disabled} onClick={onConfirm}>
            {t().screensPlan.plan.confirmPayment}
          </button>
        )}
        {/* When the price appears, focus comes here and not to "Confirmar": an extra Enter does not pay. */}
        <button type="button" className={`${MEDIUM} button-outline-weak`} disabled={busy} autoFocus onClick={onCancel}>
          {t().screensPlan.cancel}
        </button>
      </div>
    </div>
  );
}

interface PaidOptionProps {
  quote: Quote | null;
  busy: boolean;
  disabled: boolean;
  onAskPrice: () => void;
  onConfirm: (price: string) => void;
  onCancel: () => void;
  /** The simulated card payment of Night Plus (one only: it has no monthly or annual period). */
  onFiat: () => void;
}

/** "Night Plus" (the paid plan): private tokens as the main option and, below, the simulated card. No prices or quotas written by
 *  hand: the only amount is the one the contract gives when asked. */
function PaidOption({ quote, busy, disabled, onAskPrice, onConfirm, onCancel, onFiat }: PaidOptionProps) {
  return (
    <div className="nm-opcion">
      <div className="nm-opcion__cab">
        <span className="nm-opcion__titulo">{t().screensPlan.plan.paidTitle}</span>
      </div>
      <div className="nm-pila nm-pila--s">
        <span className="nm-pista">{t().screensPlan.plan.shieldedHint}</span>
        {quote === null ? (
          <div className="nm-fila">
            <button type="button" className={`${MEDIUM} button-solid-norm`} disabled={disabled} onClick={onAskPrice}>
              {t().screensPlan.plan.payShielded}
            </button>
          </div>
        ) : (
          <QuoteBox quote={quote} busy={busy} disabled={disabled} onConfirm={() => onConfirm(quote.price)} onCancel={onCancel} />
        )}
      </div>
      <hr className="nm-separador" />
      <div className="nm-pila nm-pila--s">
        <span className="nm-pista">{t().screensPlan.plan.cardHint}</span>
        <div className="nm-fila">
          <button type="button" className={`${SMALL} button-outline-weak`} disabled={disabled} onClick={onFiat}>
            <Icon name="credit-card" className="nm-ic" />
            {t().screensPlan.plan.fiat}
          </button>
        </div>
      </div>
    </div>
  );
}

function FreeOption({ disabled, onFree }: { disabled: boolean; onFree: () => void }) {
  return (
    <div className="nm-opcion">
      <div className="nm-opcion__cab">
        <span className="nm-opcion__titulo">{t().screensPlan.plan.freeTitle}</span>
      </div>
      <div className="nm-fila">
        <button type="button" className={`${MEDIUM} button-outline-weak`} disabled={disabled} onClick={onFree}>
          {t().screensPlan.plan.requestFree}
        </button>
      </div>
    </div>
  );
}

/** The purchase according to the plan: choose (no plan), move to the paid one (free) or "Comprar otro bono" folded (paid).
 *  `status` (progress and error) is always in view: folded, it sits below the fold. */
function Offer({ kind, status, children }: { kind: PlanKind; status: ReactNode; children: ReactNode }) {
  const title = offerTitle(kind);
  if (title === null) {
    return (
      <>
        <details className="nm-pliegue nm-pliegue--tarjeta">
          <summary>
            <Icon name="plus" className="nm-ic" />
            {t().screensPlan.plan.buyAnother}
            <Icon name="chevron-down" className="nm-ic" />
          </summary>
          <div className="nm-pliegue__cuerpo nm-pila">{children}</div>
        </details>
        {status}
      </>
    );
  }
  return (
    <section className="nm-tarjeta">
      <h2 className="nm-tarjeta__titulo">{title}</h2>
      {children}
      {status}
    </section>
  );
}

/** Before the first stage of an operation that opens the wallet. No duration. */
const opening = () => ({ stage: t().screensPlan.plan.opening, note: null });

interface Props {
  events: CoreEvents;
  onChanged: () => void;
  /** Changes when the quota must be re-read without touching what is in progress (an address created or abandoned). */
  reloadKey: number;
  /** The wallet is busy with another section (nothing that uses the bono lock is launched). */
  otherBusy: boolean;
  onBusy: (busy: boolean) => void;
}

export function PlanSection({ events, onChanged, reloadKey, otherBusy, onBusy }: Props) {
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [op, setOp] = useState<number | null>(null);
  /** Contract price the user is looking at to confirm (only that amount is paid) and the wallet. */
  const [quote, setQuote] = useState<Quote | null>(null);
  const [usesWallet, setUsesWallet] = useState(false);
  const { busy, error, code, run, setError } = useAction(onBusy);
  const midnight = useMidnightGate();
  const disabled = busy || otherBusy;
  // The check takes up to a few seconds and meanwhile the buttons stay live: whatever happens in that time prevails.
  // "Cancelar" raises it (the payment no longer starts) and `otherBusy` says whether the other section took the wallet.
  const cancels = useRef(0);
  const otherBusyNow = useRef(otherBusy);
  useEffect(() => {
    otherBusyNow.current = otherBusy;
  }, [otherBusy]);

  // Reads may answer out of order. Each carries its number (`asked`) and is only painted if newer than the last
  // one painted (`painted`): the turn is taken when the answer arrives successfully. A failing read does not take
  // another earlier one's turn that is still on its way, so the old quota does not stay.
  const asked = useRef(0);
  const painted = useRef(0);
  const show = useCallback((mine: number, p: PlanView) => {
    if (mine <= painted.current) return;
    painted.current = mine;
    setPlan(p);
  }, []);
  const load = useCallback(async () => {
    const mine = ++asked.current;
    const p = await run(() => api.getPlan());
    if (p) show(mine, p);
  }, [run, show]);

  // Re-read the quota silently: no "busy" (it does not block the wallet) and without clearing a payment's error.
  useEffect(() => {
    if (reloadKey === 0) return;
    const mine = ++asked.current;
    api.getPlan().then(
      (p) => show(mine, p),
      () => undefined,
    );
  }, [reloadKey, show]);

  // Initial load (and when an operation finishes, via `onChanged`).
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- loads from the backend (external system); the only synchronous part is useAction's busy/error clearing, which is intended.
    void load();
  }, [load]);

  /** Can it start? Before calling `api.*` it is checked that Midnight answers; if not, nothing starts and the
   *  price being viewed stays valid. */
  async function canStart(needs: Needs): Promise<boolean> {
    if (disabled || midnight.checking) return false;
    const cancelsBefore = cancels.current;
    const ok = await midnight.gate(needs);
    if (!ok) setError(null);
    return ok && !otherBusyNow.current && cancels.current === cancelsBefore;
  }

  function cancelQuote() {
    cancels.current += 1;
    setQuote(null);
  }

  async function buy(action: (op: number) => Promise<unknown>, needs: Needs) {
    if (!(await canStart(needs))) return;
    const myOp = nextOp();
    setOp(myOp);
    let wasBusy = false;
    const ok = await run(
      async () => {
        await action(myOp);
        return true;
      },
      (c) => {
        wasBusy = c === 'busy';
        return null;
      },
    );
    // With `busy` the payment was never made: the confirmed price stays valid. With any other ending, it does not.
    if (!wasBusy) setQuote(null);
    if (ok) await load();
    // After an error too: a payment that ended "pendiente" may have been sent and the balance shown is no longer valid.
    onChanged();
  }

  async function askPrice() {
    if (!(await canStart('red'))) return;
    const myOp = nextOp();
    setOp(myOp);
    const got = await run(async () => ({ price: await api.getPrice(), wallet: await api.walletInfo(myOp) }));
    if (got) setQuote(got);
  }

  /** Presentation only: marks that the operation opens the wallet (asking the price, paying with the shielded token) to say
   *  "Abriendo la cartera..." before the first stage. It does not touch `buy` or `askPrice`. */
  async function withWallet(action: () => Promise<void>) {
    setUsesWallet(true);
    try {
      await action();
    } finally {
      setUsesWallet(false);
    }
  }

  const kind = plan ? planKind(plan.bonos) : 'none';
  const stage = op !== null ? events.progress[op] : undefined;
  const shown = busy && stage ? progressParts(stage) : busy && usesWallet ? opening() : null;
  const status = (
    <>
      {shown && <Progreso stage={shown.stage} note={shown.note ?? undefined} />}
      <MidnightWaiting show={busy && midnight.waiting} />
      <ErrorAviso message={midnight.blocker} tone="atencion" />
      <ErrorAviso message={error} code={code} />
    </>
  );
  return (
    <>
      {plan && plan.bonos.length > 0 && <PlanCard plan={plan} kind={kind} disabled={disabled} onChanged={load} />}
      <Offer kind={kind} status={status}>
        {kind === 'none' && <FreeOption disabled={disabled} onFree={() => buy((o) => api.getFreePlan(o), 'red')} />}
        <PaidOption
          quote={quote}
          busy={busy}
          disabled={disabled}
          onAskPrice={() => withWallet(askPrice)}
          onConfirm={(price) => withWallet(() => buy((o) => api.payShielded(price, o), 'pruebas'))}
          onCancel={cancelQuote}
          onFiat={() => buy((o) => api.payFiat(o), 'red')}
        />
      </Offer>
    </>
  );
}
