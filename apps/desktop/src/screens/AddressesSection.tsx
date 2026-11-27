// "Direcciones" page: on the left "En proceso" (if any) and your addresses, with their kind, their date, "Ver correo"
// and "Abandonar", and the missing name of a restored mailbox; on the right, "Nueva dirección".
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { abandonButton, abandonedText, abandonLabel, abandonNote, ADDRESSES_TITLE_ID, seeMailLabel } from '../addresses.ts';
import { api } from '../api.ts';
import type { AddressView } from '../bindings/AddressView.ts';
import type { PlanView } from '../bindings/PlanView.ts';
import { Aviso } from '../components/Aviso.tsx';
import { Luz } from '../components/Luz.tsx';
import { Tag } from '../components/Tag.tsx';
import { formatDay, mailDomain, slotKindName, slotKindTitle } from '../format.ts';
import { classes } from '../pieces.ts';
import { t } from '../i18n/index.ts';
import { neighbor, NEW_NAME_ID, type NavAction } from '../nav.ts';
import { addressesNote } from '../sidebar.ts';
import type { CoreEvents } from '../useCoreEvents.ts';
import { AbandonAddressDialog } from './AbandonAddressDialog.tsx';
import { ErrorAviso } from './common.tsx';
import { NewAddress } from './NewAddress.tsx';
import { ProvideName } from './ProvideName.tsx';
import { useAction } from './useAction.ts';

interface Props {
  events: CoreEvents;
  /** Reports the updated list (the sidebar and the inbox use it). */
  onLoaded: (addresses: AddressView[]) => void;
  /** Changes when the list and quota must be re-read (e.g. after buying a plan). */
  reloadKey: number;
  onNav: (action: NavAction) => void;
  /** A creation finished (well or badly): "En proceso", the plan and the quota must be re-read. */
  onChanged: () => void;
  /** The "En proceso" card (`PendingSection`), which goes above the list. */
  pending: ReactNode;
}

interface RowProps {
  a: AddressView;
  fresh: boolean;
  suffix?: string;
  /** An abandon is in progress: no "Abandonar" responds until it finishes. */
  abandonBusy: boolean;
  onNamed: () => void;
  onSee: (addrKey: string) => void;
  onAbandon: (a: AddressView) => void;
}

/** The "Abandonar" button of `addrKey`'s row (focus goes to the next row's after abandoning one). */
const abandonSelector = (addrKey: string) => `[data-nm-abandon="${addrKey}"]`;

/** The address as shown in its row (no name yet: "alias sin nombre"). */
const shownAddress = (a: AddressView) => (a.display !== '' ? a.display : t().mail.unnamedAddress(a.slot.kind));

function AddressRow({ a, fresh, suffix, abandonBusy, onNamed, onSee, onAbandon }: RowProps) {
  const named = a.display !== '';
  const shown = shownAddress(a);
  return (
    <li>
      <Luz mode={fresh ? 'destello' : named ? 'encendida' : 'apagada'} />
      <div className="nm-filas__principal">
        <div className={classes('nm-filas__dir', named && 'text-monospace')}>{shown}</div>
        <div className="nm-filas__sub nm-fila">
          <Tag>{slotKindTitle(a.slot)}</Tag>
          {/* They agree with the kind next to them: "buzón" and "alias" are masculine. */}
          {fresh && <Tag tone="exito">{t().screensPlan.addresses.new}</Tag>}
          {named && <span>{t().screensPlan.addresses.createdOn(formatDay(a.createdAt))}</span>}
        </div>
      </div>
      <div className="nm-fila">
        <button type="button" className="button button-small button-ghost-weak nm-btn" aria-label={seeMailLabel(shown)} onClick={() => onSee(a.addrKey)}>
          {t().screensPlan.addresses.seeMail}
        </button>
        <button
          type="button"
          className="button button-small button-ghost-weak nm-btn"
          data-nm-abandon={a.addrKey}
          aria-label={abandonLabel(shown)}
          disabled={abandonBusy}
          onClick={() => onAbandon(a)}
        >
          {abandonButton()}
        </button>
      </div>
      {!named && (
        <div className="nm-filas__ancho nm-pila">
          <p className="nm-suave">{t().screensPlan.nameNotRead}</p>
          <ProvideName slot={a.slot} label={t().screensPlan.nameOf(slotKindName(a.slot))} suffix={suffix} onDone={onNamed} />
        </div>
      )}
    </li>
  );
}

export function AddressesSection({ events, onLoaded, reloadKey, onNav, onChanged, pending }: Props) {
  const [addresses, setAddresses] = useState<AddressView[]>([]);
  const [plan, setPlan] = useState<PlanView | null>(null);
  // The one just created: "Dirección creada", its "nuevo" tag and its flash.
  const [fresh, setFresh] = useState<string | null>(null);
  // The one about to be abandoned (the dialog open) and the "Dirección abandonada." notice.
  const [abandoning, setAbandoning] = useState<AddressView | null>(null);
  const [abandoned, setAbandoned] = useState(false);
  const { error, run } = useAction();
  // Abandoning has its own state: the list read that comes afterwards (or that of an event) does not clear its error.
  const abandonAction = useAction();
  const abandonRun = abandonAction.run;
  // The guard is in a ref: two presses before repainting would still see `busy` as false.
  const abandoningNow = useRef(false);
  // Abandoning really ends when the list re-read also finishes: until then they stay disabled.
  const [abandonPending, setAbandonPending] = useState(false);

  // The quota is read separately: if it fails (no plan, restore pending...), the only effect is that how many are left is not said. Reads
  // may answer out of order: only the last one requested counts.
  const asked = useRef(0);
  const load = useCallback(async () => {
    const mine = ++asked.current;
    const [list, p] = await Promise.all([run(() => api.listAddresses()), api.getPlan().catch(() => null)]);
    if (mine !== asked.current) return;
    setPlan(p);
    if (list) {
      setAddresses(list);
      onLoaded(list);
    }
  }, [run, onLoaded]);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- loads from the backend (external system); the only synchronous part is useAction's busy/error clearing, which is intended.
    void load();
  }, [reloadKey, load]);

  // After creating, the pressed button may become disabled (empty name, quota used up): with the list and quota already
  // re-read, focus goes to the name or, if no mailboxes remain, to the card title.
  const [refocus, setRefocus] = useState(0);
  useEffect(() => {
    if (refocus > 0) document.getElementById(NEW_NAME_ID)?.focus();
  }, [refocus]);
  const onCreated = useCallback(
    async (a: AddressView) => {
      setFresh(a.addrKey);
      await load();
      setRefocus((n) => n + 1);
    },
    [load],
  );
  const onSee = (addrKey: string) => onNav({ type: 'filter', addrKey });

  // Abandoning: the dialog closes, the mark is set, the list is re-read and focus goes to the "Abandonar" of the row that takes its
  // place or, if none remains, to the card title. Main removes its filter and its open message (`dropped`).
  // Focus is set after the new list paints: `afterAbandon` says where (the row's key or `null`, the title).
  const [afterAbandon, setAfterAbandon] = useState<{ to: string | null } | null>(null);
  useEffect(() => {
    if (afterAbandon === null) return;
    const row = afterAbandon.to === null ? null : document.querySelector<HTMLElement>(abandonSelector(afterAbandon.to));
    (row ?? document.getElementById(ADDRESSES_TITLE_ID))?.focus();
  }, [afterAbandon]);
  const abandon = useCallback(
    async (a: AddressView) => {
      setAbandoning(null);
      if (abandoningNow.current) return;
      abandoningNow.current = true;
      setAbandonPending(true);
      setAbandoned(false);
      const keys = addresses.map((x) => x.addrKey);
      try {
        const ok = await abandonRun(async () => {
          await api.abandonAddress(a.addrKey);
          return true;
        });
        // If it fails, focus returns to its "Abandonar" (it was disabled meanwhile and lost focus).
        if (!ok) {
          setAfterAbandon({ to: a.addrKey });
          return;
        }
        setFresh(null);
        setAbandoned(true);
        await load();
        onChanged();
        setAfterAbandon({ to: neighbor(keys, a.addrKey) });
      } finally {
        abandoningNow.current = false;
        setAbandonPending(false);
      }
    },
    [addresses, abandonRun, load, onChanged],
  );
  const domain = mailDomain(addresses);
  const suffix = domain === null ? undefined : `@${domain}`;
  return (
    <>
      {abandoned && (
        <Aviso tone="exito" autoHide={() => setAbandoned(false)}>
          <p>
            <strong>{abandonedText()}</strong>
          </p>
        </Aviso>
      )}
      {fresh && (
        <Aviso key={fresh} tone="exito" autoHide={() => setFresh(null)}>
          <p>
            <strong>{t().screensPlan.addresses.createdBold}</strong>
            {t().screensPlan.addresses.createdRest}
          </p>
        </Aviso>
      )}
      <div className="nm-cols">
        <div className="nm-col">
          {pending}
          <section className="nm-tarjeta">
            <div className="nm-tarjeta__cab">
              <h2 className="nm-tarjeta__titulo" id={ADDRESSES_TITLE_ID} tabIndex={-1}>
                {t().screensMail.sidebar.yourAddresses}
              </h2>
              <span className="text-monospace">{addresses.length}</span>
            </div>
            {addresses.length === 0 ? (
              <p className="nm-suave">{addressesNote(0)}</p>
            ) : (
              <ul className="nm-filas">
                {addresses.map((a) => (
                  <AddressRow
                    key={a.addrKey}
                    a={a}
                    fresh={a.addrKey === fresh}
                    suffix={suffix}
                    abandonBusy={abandonAction.busy || abandonPending}
                    onNamed={load}
                    onSee={onSee}
                    onAbandon={setAbandoning}
                  />
                ))}
              </ul>
            )}
            {addresses.length > 0 && <p className="nm-suave">{abandonNote()}</p>}
            <ErrorAviso message={error} />
            <ErrorAviso message={abandonAction.error} />
          </section>
        </div>
        <div className="nm-col">
          <NewAddress
            events={events}
            plan={plan}
            suffix={suffix}
            onStart={() => {
              setFresh(null);
              setAbandoned(false);
            }}
            onCreated={(a) => void onCreated(a)}
            onChanged={onChanged}
            onPlan={() => onNav({ type: 'go', view: 'plan' })}
          />
        </div>
      </div>
      {abandoning && (
        <AbandonAddressDialog
          address={shownAddress(abandoning)}
          onYes={() => void abandon(abandoning)}
          onNo={() => setAbandoning(null)}
        />
      )}
    </>
  );
}
