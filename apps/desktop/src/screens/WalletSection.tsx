// Payment wallet: the embedded wallet used to pay the plan in the shielded token (and its faucet on test networks).
// It only changes how things look: while the plan uses it, its buttons stay disabled.
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { api, nextOp } from '../api.ts';
import type { Progress } from '../bindings/Progress.ts';
import type { WalletView } from '../bindings/WalletView.ts';
import { Aviso } from '../components/Aviso.tsx';
import { Copiable } from '../components/Copiable.tsx';
import { Icon } from '../components/Icon.tsx';
import { InfoTip } from '../components/InfoTip.tsx';
import { Progreso } from '../components/Progreso.tsx';
import { formatDust, formatNight } from '../format.ts';
import { useMidnightGate, type Needs } from '../health.ts';
import { dustSetupLine, faucetBlocked } from '../payment.ts';
import { progressParts } from '../progress.ts';
import { t } from '../i18n/index.ts';
import type { CoreEvents } from '../useCoreEvents.ts';
import { ErrorAviso, MidnightWaiting } from './common.tsx';
import { useAction } from './useAction.ts';

const MEDIUM = 'button button-medium button-outline-weak nm-btn';

function WalletDetails({ wallet }: { wallet: WalletView }) {
  const setup = dustSetupLine(wallet.dustSetup);
  return (
    <>
      <dl className="nm-datos">
        <dt>NIGHT</dt>
        <dd className="text-monospace">{formatNight(wallet.night)}</dd>
        <dt>
          DUST <InfoTip label={t().screensPlan.wallet.dustInfoLabel} text={t().screensPlan.wallet.dustInfo} />
        </dt>
        <dd>
          <span className="text-monospace">{formatDust(wallet.dust)}</span>
          {/* The registration the app does by itself: when it finishes `walletChanged` arrives and the wallet is re-read. */}
          {setup && (
            <span className="nm-pista nm-dust-setup">
              <Icon name={setup.icon} className="nm-ic" />
              {setup.text}
            </span>
          )}
        </dd>
        <dt>{t().screensPlan.wallet.tokenName}</dt>
        <dd className="text-monospace">{wallet.token}</dd>
      </dl>
      <div className="nm-pila nm-pila--s">
        <span className="nm-suave">{t().screensPlan.wallet.receiveNight}</span>
        {wallet.unshieldedAddress ? (
          <Copiable text={wallet.unshieldedAddress} label={t().screensMail.inbox.copyAddress} />
        ) : (
          <p className="nm-pista">{t().screensPlan.wallet.addressUnavailable}</p>
        )}
      </div>
    </>
  );
}

interface ButtonsProps {
  wallet: WalletView | null;
  disabled: boolean;
  onLoad: () => void;
  onFaucet: () => void;
}

/** "Ver cartera" / "Actualizar" and, on test networks, the faucet (disabled without DUST or NIGHT, and it says so). */
function WalletButtons({ wallet, disabled, onLoad, onFaucet }: ButtonsProps) {
  const faucet = wallet?.faucet ? { blocked: faucetBlocked(wallet) } : null;
  return (
    <>
      <div className="nm-fila">
        <button type="button" className={MEDIUM} disabled={disabled} onClick={onLoad}>
          <Icon name={wallet ? 'arrows-rotate' : 'wallet'} className="nm-ic" />
          {wallet ? t().screensPlan.wallet.refresh : t().screensPlan.wallet.view}
        </button>
        {faucet && (
          <button type="button" className={MEDIUM} disabled={disabled || faucet.blocked} onClick={onFaucet}>
            {t().screensPlan.wallet.requestToken}
          </button>
        )}
      </div>
      {faucet && (
        <p className="nm-pista">{t().screensPlan.wallet.tokenNote}</p>
      )}
      {faucet?.blocked && (
        <Aviso tone="info">
          <p>{t().screensPlan.wallet.faucetBlocked}</p>
        </Aviso>
      )}
    </>
  );
}

/** The real stage; before the first, the wallet is being opened. */
function walletProgress(stage: Progress | undefined): { stage: string; note: string | null } {
  return stage ? progressParts(stage) : { stage: t().screensPlan.wallet.opening, note: t().screensPlan.wallet.openingNote };
}

interface Props {
  events: CoreEvents;
  /** Rises when the plan has paid (or tried to): the balance shown is no longer valid. */
  reloadKey: number;
  /** The page is not in view: a stale wallet is re-read on returning to it, not in the background. */
  hidden: boolean;
  /** The plan is using the wallet or the bono lock. */
  otherBusy: boolean;
  onBusy: (busy: boolean) => void;
}

export function WalletSection({ events, reloadKey, hidden, otherBusy, onBusy }: Props) {
  const [wallet, setWallet] = useState<WalletView | null>(null);
  const [shownFor, setShownFor] = useState(reloadKey);
  const [op, setOp] = useState<number | null>(null);
  // Only that it was requested is stored: the text is translated when painting (the language changes while the app is open).
  const [faucetDone, setFaucetDone] = useState(false);
  const { busy, error, code, run, setError } = useAction(onBusy);
  const midnight = useMidnightGate();
  const disabled = busy || otherBusy;
  // If during the check the plan section takes the wallet, nothing starts here.
  const otherBusyNow = useRef(otherBusy);
  useEffect(() => {
    otherBusyNow.current = otherBusy;
  }, [otherBusy]);

  async function canStart(needs: Needs): Promise<boolean> {
    if (disabled || midnight.checking) return false;
    setFaucetDone(false);
    const ok = await midnight.gate(needs);
    if (!ok) setError(null);
    return ok && !otherBusyNow.current;
  }

  // After a payment the balance shown is no longer valid. If the wallet was open, it stays open and is re-read by itself
  // (as on pressing "Actualizar") as soon as the plan releases it. If it cannot be read, it is hidden until looked at again.
  const [stale, setStale] = useState(false);
  if (shownFor !== reloadKey) {
    setShownFor(reloadKey);
    if (wallet) setStale(true);
  }

  async function tracked<T>(action: (op: number) => Promise<T>): Promise<T | undefined> {
    const myOp = nextOp();
    setOp(myOp);
    return run(() => action(myOp));
  }

  async function readWallet() {
    const w = await tracked((o) => api.walletInfo(o));
    if (w) setWallet(w);
  }

  async function refresh() {
    setStale(false);
    if (!(await canStart('red'))) {
      // If the plan took the wallet again during the check, it retries when it releases it.
      if (otherBusyNow.current) setStale(true);
      else setWallet(null);
      return;
    }
    const fresh = await tracked((o) => api.walletInfo(o));
    setWallet(fresh ?? null);
  }

  const refreshNow = useEffectEvent(() => void refresh());
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- reads from the backend (external system), like the plan load; the only synchronous part is useAction's busy flag and lowering `stale`, which is intended.
    if (stale && !hidden && !disabled && !midnight.checking) refreshNow();
  }, [stale, hidden, disabled, midnight.checking]);

  // Before starting it is checked that Midnight answers: without a network, the wallet would wait without saying anything.
  async function load() {
    if (await canStart('red')) await readWallet();
  }

  async function faucet() {
    if (!(await canStart('pruebas'))) return;
    const ok = await tracked(async (o) => {
      await api.faucet(o);
      return true;
    });
    if (ok) {
      await readWallet();
      setFaucetDone(true);
    }
  }

  const shown = walletProgress(op !== null ? events.progress[op] : undefined);
  return (
    <section className="nm-tarjeta">
      <h2 className="nm-tarjeta__titulo">{t().screensPlan.wallet.title}</h2>
      <p className="nm-suave">{t().screensPlan.wallet.intro}</p>
      {wallet && <WalletDetails wallet={wallet} />}
      {otherBusy && !busy && <p className="nm-pista">{t().screensPlan.wallet.waitForPlan}</p>}
      {busy && <Progreso stage={shown.stage} note={shown.note ?? undefined} />}
      <MidnightWaiting show={busy && midnight.waiting} />
      <WalletButtons wallet={wallet} disabled={disabled} onLoad={load} onFaucet={faucet} />
      {faucetDone && (
        <Aviso tone="info">
          <p>{t().screensPlan.wallet.faucetDone}</p>
        </Aviso>
      )}
      <ErrorAviso message={midnight.blocker} tone="atencion" />
      <ErrorAviso message={error} code={code} />
    </section>
  );
}
