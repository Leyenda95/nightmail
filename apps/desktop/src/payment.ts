// Pure rules of the shielded payment (no DOM).
import type { BonoView } from './bindings/BonoView.ts';
import type { WalletView } from './bindings/WalletView.ts';
import { formatDateTime } from './format.ts';
import { t } from './i18n/index.ts';

const isUnits = (text: string): boolean => /^\d+$/.test(text);

/**
 * Why `price` CANNOT be paid with this wallet, or `null` if it can be attempted. Checked before confirming because
 * a failed attempt leaves the payment leaf claimed and blocks the simulated payment.
 */
export function cannotPay(price: string, wallet: WalletView): string | null {
  const words = t().status.payment;
  if (!isUnits(price) || !isUnits(wallet.token)) return words.unreadable;
  if (BigInt(wallet.token) < BigInt(price)) return words.insufficient(wallet.token, price);
  if (!wallet.dustReady && wallet.night === '0') return words.noNight;
  return null;
}

/** The faucet needs DUST for its fee: with neither DUST nor NIGHT to generate it, asking makes no sense. */
export function faucetBlocked(wallet: WalletView): boolean {
  return !wallet.dustReady && wallet.night === '0';
}

/**
 * The line next to DUST about the NIGHT registration the app does by itself in the background, or `null` if there is
 * nothing to say. After a failure the core does not repeat it with the same NIGHT: it waits for more to arrive or for the next session.
 */
export function dustSetupLine(setup: WalletView['dustSetup']): { icon: 'espera' | 'pause'; text: string } | null {
  switch (setup) {
    case 'idle':
      return null;
    case 'activating':
      return { icon: 'espera', text: t().status.payment.dustActivating };
    case 'failed':
      return { icon: 'pause', text: t().status.payment.dustFailed };
  }
}

// Presentation of the "Plan y cartera" page. Labels only: it does not decide what can be paid.
export type PlanKind = 'none' | 'free' | 'paid';

/** The plan you have, counting only confirmed bonos (in the tree): a pending payment does not give quota yet. */
export function planKind(bonos: readonly Pick<BonoView, 'paid' | 'included'>[]): PlanKind {
  const confirmed = bonos.filter((b) => b.included);
  if (confirmed.length === 0) return 'none';
  return confirmed.some((b) => b.paid) ? 'paid' : 'free';
}

/** Title of the purchase card; `null` with the paid plan: buying another bono is folded away. */
export function offerTitle(kind: PlanKind): string | null {
  if (kind === 'none') return t().status.payment.offerNone;
  return kind === 'free' ? t().status.payment.offerFree : null;
}

/** A bono row: kind, state (with its tone and icon: never colour alone), when it can be used and, if pending, how to abandon it. */
export interface BonoParts {
  /** The kind, as a code (not shown: the text is `title`). */
  readonly kind: 'de pago' | 'gratis';
  /** "Bono gratis" / "Bono Night Plus": without the internal counters (`n/k`), which go apart, for support. */
  readonly title: string;
  /** Only shown if there is something to know: a confirmed bono carries no label. */
  readonly state: string | null;
  readonly tone: 'exito' | 'atencion';
  readonly icon: 'checkmark-circle' | 'espera';
  /** Text for screen readers only (the confirmed icon has no visible label). */
  readonly srOnly: string | null;
  /** "Se podrá usar a partir del...", only if that time has not arrived yet. */
  readonly wait: string | null;
  /** Cancelling it: the button, and the title, text and "yes" of its confirmation dialog. */
  readonly abandon: {
    readonly button: string;
    /** What a screen reader says for the button: it starts with its text and says what is cancelled. */
    readonly label: string;
    readonly title: string;
    readonly note: string;
    readonly yes: string;
  } | null;
}

export function bonoParts(b: Pick<BonoView, 'paid' | 'included' | 'usableAt'>, nowSecs: number): BonoParts {
  const words = t().status.payment;
  const kind = b.paid ? 'de pago' : 'gratis';
  const title = words.bonoTitle(b.paid);
  const wait = b.usableAt != null && b.usableAt > nowSecs ? words.usableFrom(formatDateTime(b.usableAt)) : null;
  if (b.included) return { kind, title, state: null, tone: 'exito', icon: 'checkmark-circle', srOnly: words.confirmed, wait, abandon: null };
  // A real button that says only "Cancelar". What is cancelled is said by the row (and the dialog).
  const dialog = b.paid ? words.cancelPaid : words.cancelFree;
  const abandon = { button: words.cancel, label: dialog.label(title), title: dialog.title, note: dialog.note, yes: dialog.yes };
  return { kind, title, state: words.pending, tone: 'atencion', icon: 'espera', srOnly: null, wait, abandon };
}
