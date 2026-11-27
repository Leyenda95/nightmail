// Sidebar of the main view: "Nuevo mensaje", the menu (with "Enviados"), your addresses as an inbox filter and, at the foot, the quota,
// the Midnight line, "Ajustes" (with "Cerrar sesión") and "Bloquear".
import { useEffect, useState } from 'react';
import { pendingTag, type PendingCount } from '../addresses.ts';
import { api } from '../api.ts';
import type { AddressView } from '../bindings/AddressView.ts';
import { NEW_MESSAGE_ID } from '../compose.ts';
import type { PlanView } from '../bindings/PlanView.ts';
import { t } from '../i18n/index.ts';
import type { Unread } from '../inbox.ts';
import type { Nav, NavAction, View } from '../nav.ts';
import { classes } from '../pieces.ts';
import { ServiceStatus } from '../screens/ServiceStatus.tsx';
import { addressesNote, planName, quotaPercent, sideAddress, unreadBadge, type StatusLineView } from '../sidebar.ts';
import { usePopup } from '../usePopup.ts';
import { Icon, type IconName } from './Icon.tsx';
import { Logo } from './Logo.tsx';
import { Luz } from './Luz.tsx';
import { Tag } from './Tag.tsx';

interface Props {
  nav: Pick<Nav, 'view' | 'addrKey'>;
  addresses: AddressView[];
  /** Unread in the inbox: the number on "Bandeja de entrada" and, on each address, its light and number. */
  unread: Unread;
  /** Changes when the quota must be re-read (plan bought, address created, sync). */
  planKey: number;
  onNav: (action: NavAction) => void;
  /** "Nuevo mensaje": opens the form (or the one already being written). */
  onCompose: () => void;
  /** "Bloquear": lock and show the account list. */
  onLock: () => void;
  /** "Cerrar sesión" (in the Settings options): the same as "Bloquear". */
  onLogOut: () => void;
  locking: boolean;
  /** Half-done addresses: the "N en proceso" or "N detenidas" label of "Direcciones". */
  pending: PendingCount;
  /** The same sync as the list's "Sincronizar ahora" (`useMessages`). */
  syncing: boolean;
  /** Its icon turns together with the list's (`useSpin` in `Main.tsx`). */
  spinning: boolean;
  onSync: () => void;
  /** The NightMail server line with its deadline (`useServerLine`): the same one that decides the mail notice. */
  serverNow: StatusLineView;
}

/** `aria-current` of the menu: only on what is in view (with an address chosen, it carries the mark). */
const current = (on: boolean) => (on ? ('page' as const) : undefined);

/** How many are unread (nothing if none). The number is visible; "sin leer" only for the screen reader. */
function UnreadNum({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <span className="nm-nav__num">
      {n}
      <span className="sr-only">{t().screensMail.sidebar.unreadAfter}</span>
    </span>
  );
}

/** "Bandeja de entrada": the navigation button, "Actualizar" and the badge with the unread count. They are two
 *  sibling buttons (never one inside the other); "Actualizar" and the badge sit over the right end of the
 *  row. The badge is not announced: its data goes in the button's name (`sr-only`). While syncing it is not disabled
 *  (focus would be lost): `aria-busy` and the `syncNow` guard. */
function InboxRow({ unread, on, syncing, spinning, onGo, onSync }: { unread: number; on: boolean; syncing: boolean; spinning: boolean; onGo: () => void; onSync: () => void }) {
  return (
    <li className={classes('nm-fila', unread > 0 && 'nm-fila--num')}>
      <button type="button" className="nm-nav__item nm-fila__ir" aria-current={current(on)} onClick={onGo}>
        <Icon name="inbox" className="nm-ic" />
        <span className="nm-fila__txt">{t().mail.inbox.title}</span>
        {unread > 0 && <span className="sr-only">{t().screensMail.sidebar.unreadSr(unread)}</span>}
      </button>
      <span className="nm-fila__fin">
        <button
          type="button"
          className="nm-fila__act"
          title={t().screensMail.sidebar.refreshInbox}
          aria-label={t().screensMail.sidebar.refreshInbox}
          aria-busy={syncing || undefined}
          onClick={onSync}
        >
          <Icon name="arrows-rotate" className={classes('nm-ic', spinning && 'nm-fila__gira keep-motion')} />
        </button>
        {unread > 0 && (
          <span className="nm-fila__num" aria-hidden="true">
            {unreadBadge(unread)}
          </span>
        )}
      </span>
    </li>
  );
}

interface MenuItemProps {
  icon: IconName;
  label: string;
  on?: boolean;
  count?: number;
  /** Attention label at the end ("2 en proceso"), or nothing. */
  tag?: string | null;
  onClick: () => void;
}

function MenuItem({ icon, label, on, count = 0, tag, onClick }: MenuItemProps) {
  return (
    <li>
      <button type="button" className="nm-nav__item" aria-current={current(on ?? false)} onClick={onClick}>
        <Icon name={icon} className="nm-ic" />
        <span className="nm-nav__txt">{label}</span>
        <UnreadNum n={count} />
        {tag && <Tag tone="atencion">{tag}</Tag>}
      </button>
    </li>
  );
}

function Menu({ nav, unread, pending, go, syncing, spinning, onSync }: { nav: Props['nav']; unread: number; pending: PendingCount; go: (view: View) => void; syncing: boolean; spinning: boolean; onSync: () => void }) {
  return (
    <ul className="nm-nav">
      <InboxRow unread={unread} on={nav.view === 'bandeja' && nav.addrKey === null} syncing={syncing} spinning={spinning} onGo={() => go('bandeja')} onSync={onSync} />
      {/* The archive: no counter; it is not filtered by address. */}
      <MenuItem icon="archive-box" label={t().mail.inbox.archiveTitle} on={nav.view === 'archivo'} onClick={() => go('archivo')} />
      {/* What was sent from this device: no counter, not filtered by address. */}
      <MenuItem icon="arrow-right" label={t().screensMail.sidebar.sent} on={nav.view === 'enviados'} onClick={() => go('enviados')} />
      {/* "N en proceso" or "N detenidas": "En proceso" only shows inside the page. */}
      <MenuItem icon="at" label={t().screensMail.screens.addresses} tag={pendingTag(pending)} on={nav.view === 'direcciones'} onClick={() => go('direcciones')} />
      <MenuItem icon="wallet" label={t().screensMail.screens.plan} on={nav.view === 'plan'} onClick={() => go('plan')} />
    </ul>
  );
}

function Addresses({ nav, addresses, unread, onNav }: Pick<Props, 'nav' | 'addresses' | 'unread' | 'onNav'>) {
  return (
    <>
      <div className="nm-side__cabecera">
        <h2 className="nm-side__titulo">{t().screensMail.sidebar.yourAddresses}</h2>
        {/* Creating an address lives here and on the "Direcciones" page: focus goes to the mailbox name. */}
        <button type="button" className="nm-side__mas" title={t().screensMail.sidebar.newAddress} aria-label={t().screensMail.sidebar.newAddress} onClick={() => onNav({ type: 'new' })}>
          <Icon name="plus" className="nm-ic" />
        </button>
      </div>
      {addresses.length > 0 && (
        <ul className="nm-nav">
          {addresses.map((a, i) => {
            const shown = sideAddress(a);
            const fresh = unread.byAddr[a.addrKey] ?? 0;
            const on = nav.view === 'bandeja' && nav.addrKey === a.addrKey;
            return (
              <li key={a.addrKey}>
                <button
                  type="button"
                  className={classes('nm-dir', !shown.named && 'nm-dir--sin-nombre')}
                  aria-current={on ? 'true' : undefined}
                  title={shown.title || undefined}
                  onClick={() => onNav({ type: 'filter', addrKey: a.addrKey })}
                >
                  {/* Light on = new mail; each address beats at its own rhythm. */}
                  <Luz mode={fresh > 0 ? 'late' : 'apagada'} rhythm={i} />
                  <span className="nm-dir__txt">{shown.text}</span>
                  <UnreadNum n={fresh} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="nm-side__nota">{addressesNote(addresses.length)}</p>
    </>
  );
}

function QuotaBar({ label, q }: { label: string; q: { used: number; limit: number } }) {
  return (
    <span className="nm-cupo__dato">
      <span className="nm-cupo__etiqueta">
        {label}{' '}
        <b>
          {q.used}/{q.limit}
        </b>
      </span>
      <span className="meter-bar">
        <span className="meter-bar-thumb" style={{ inlineSize: `${quotaPercent(q)}%` }} />
      </span>
    </span>
  );
}

/** The quota leads to "Plan y cartera". While it has not arrived (or if it fails) it is not shown: the plan page explains it. */
function Quota({ planKey, onClick }: { planKey: number; onClick: () => void }) {
  const [plan, setPlan] = useState<PlanView | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.getPlan().then(
      (p) => !cancelled && setPlan(p),
      () => !cancelled && setPlan(null),
    );
    return () => {
      cancelled = true;
    };
  }, [planKey]);
  if (!plan) return null;
  const name = planName(plan);
  return (
    <button type="button" className="nm-cupo" onClick={onClick}>
      <span className="nm-cupo__plan">
        {name ?? t().screensMail.sidebar.noPlan}
        <Icon name="chevron-right" className="nm-ic" />
      </span>
      {name === null ? (
        <span className="nm-cupo__dato nm-cupo__dato--ancho">{t().screensMail.sidebar.choosePlan}</span>
      ) : (
        <>
          <QuotaBar label={t().screensMail.sidebar.mailboxes} q={plan.mailboxes} />
          <QuotaBar label={t().screensMail.sidebar.aliases} q={plan.aliases} />
        </>
      )}
    </button>
  );
}

const SETTINGS_PANEL_ID = 'ajustes-opciones';

/** "Ajustes" opens, upwards like "Estado del servicio", two options: all the settings, or "Cerrar sesión" (lock and
 *  go to the account list, like "Bloquear"). Choosing one closes it. */
function SettingsMenu({ on, onSettings, onLogOut }: { on: boolean; onSettings: () => void; onLogOut: () => void }) {
  const { open, setOpen, box, toggle } = usePopup(SETTINGS_PANEL_ID);
  const choose = (action: () => void) => {
    setOpen(false);
    action();
  };
  const settings = t().screensMail.screens.settings;
  return (
    <li>
      <div className="nm-menu-caja" ref={box}>
        {open && (
          <div className="nm-menu-panel" id={SETTINGS_PANEL_ID}>
            <button type="button" className="nm-nav__item" onClick={() => choose(onSettings)}>
              <Icon name="cog-wheel" className="nm-ic" />
              <span className="nm-nav__txt">{settings}</span>
            </button>
            <button type="button" className="nm-nav__item" onClick={() => choose(onLogOut)}>
              <Icon name="arrow-out-square" className="nm-ic" />
              <span className="nm-nav__txt">{t().screensMail.sidebar.logOut}</span>
            </button>
          </div>
        )}
        <button
          ref={toggle}
          type="button"
          className="nm-nav__item"
          aria-current={current(on)}
          aria-expanded={open}
          aria-controls={open ? SETTINGS_PANEL_ID : undefined}
          onClick={() => setOpen(!open)}
        >
          <Icon name="cog-wheel" className="nm-ic" />
          <span className="nm-nav__txt">{settings}</span>
        </button>
      </div>
    </li>
  );
}

export function Sidebar({ nav, addresses, unread, planKey, onNav, onCompose, onLock, onLogOut, locking, pending, syncing, spinning, onSync, serverNow }: Props) {
  const go = (view: View) => onNav({ type: 'go', view });
  return (
    <nav className="nm-side" aria-label={t().screensMail.sidebar.navLabel}>
      <div className="nm-side__marca">
        <Logo height={26} />
      </div>
      {/* Text only, no icon. */}
      <button
        id={NEW_MESSAGE_ID}
        type="button"
        className="button button-medium button-solid-norm nm-btn w-full"
        aria-current={nav.view === 'redactar' ? 'page' : undefined}
        onClick={onCompose}
      >
        {t().screensMail.sidebar.newMessage}
      </button>
      <div className="nm-side__centro">
        <Menu nav={nav} unread={unread.total} pending={pending} go={go} syncing={syncing} spinning={spinning} onSync={onSync} />
        <Addresses nav={nav} addresses={addresses} unread={unread} onNav={onNav} />
      </div>
      <div className="nm-side__pie">
        <Quota planKey={planKey} onClick={() => go('plan')} />
        <ServiceStatus serverNow={serverNow} />
        <ul className="nm-nav">
          <SettingsMenu on={nav.view === 'ajustes'} onSettings={() => go('ajustes')} onLogOut={onLogOut} />
          <li>
            <button type="button" className="nm-nav__item" aria-busy={locking || undefined} onClick={onLock}>
              <Icon name="lock" className="nm-ic" />
              <span className="nm-nav__txt">{locking ? t().screensMail.sidebar.locking : t().screensMail.sidebar.lock}</span>
            </button>
          </li>
        </ul>
      </div>
    </nav>
  );
}
