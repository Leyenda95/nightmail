// "Elige un perfil" (the screens call accounts "perfiles"): the accounts saved on this device, to open another one or,
// with the "+" below the list, "Nuevo perfil" (choose the network, then create or restore). It is the base screen, so it
// has no back arrow: the open profile's row leads to its front screen. Only the
// box's content: whoever shows it puts it in its frame (the front screen, `Welcome.tsx`). Choosing another account
// restarts NightMail into it (the core saves the choice and relaunches the app), so meanwhile "Abriendo el perfil…"
// stays until the window closes. Choosing the open one restarts nothing: it goes back to its front screen.
// To the right of each box, inside it, a trash can deletes that profile from this computer (`DeleteProfile.tsx`, with its password).
// Deleting another one reads the list again (none left: back to the front screen, the welcome); deleting the open one
// restarts NightMail.
import { useCallback, useEffect, useRef, useState } from 'react';
import { accountRows, deleteProfileLabel, networkChoices, type AccountRow } from '../accounts.ts';
import { api } from '../api.ts';
import type { AccountView } from '../bindings/AccountView.ts';
import type { SwitchOutcome } from '../bindings/SwitchOutcome.ts';
import { Aviso } from '../components/Aviso.tsx';
import { Icon } from '../components/Icon.tsx';
import { Luz } from '../components/Luz.tsx';
import { Tag } from '../components/Tag.tsx';
import { t } from '../i18n/index.ts';
import { classes } from '../pieces.ts';
import { ErrorAviso } from './common.tsx';
import { DeleteProfileDialog } from './DeleteProfile.tsx';

const PRIMARY = 'button button-large button-solid-norm nm-btn w-full';
const PLUS = 'button button-medium button-outline-weak nm-btn button-for-icon nm-cuentas__nuevo';
const TRASH = 'button button-medium button-ghost-weak nm-btn button-for-icon nm-cuenta__borrar';

/** Opening another profile or a new one: the core restarts NightMail (`restarting`) or, if it is the open one,
 *  `alreadyOpen` and `onBack` goes back to its front screen. Meanwhile "Abriendo el perfil…". */
function useOpen(onBack: () => void) {
  const [failed, setFailed] = useState(false);
  const [opening, setOpening] = useState(false);
  async function open(action: () => Promise<SwitchOutcome>) {
    if (opening) return;
    setFailed(false);
    setOpening(true);
    try {
      // `restarting`: the window closes on its own, nothing else to do here.
      if ((await action()) === 'alreadyOpen') onBack();
    } catch {
      setOpening(false);
      setFailed(true);
    }
  }
  return { failed, opening, open };
}

function Opening() {
  const s = t().onboarding.accounts;
  return (
    <>
      <h1 className="nm-portada__titulo nm-portada__titulo--s">{s.openingTitle}</h1>
      <p className="nm-fila" role="status">
        <Luz mode="trabaja" /> {s.openingText}
      </p>
    </>
  );
}

/** "Volver" of "Nuevo perfil" (back to the list), the same arrow as on the other front screen steps. */
function Back({ onBack }: { onBack: () => void }) {
  return (
    <button type="button" className="button button-small button-ghost-weak nm-btn nm-volver" onClick={onBack}>
      <Icon name="arrow-left" className="nm-ic" />
      {t().onboarding.welcome.back}
    </button>
  );
}

/** "Nuevo perfil", from the "+" of the list: first the network. Only the local one can be chosen for now and the choice
 *  is not sent to the core (`networkChoices`). "Continuar" does what the list's button did before: the core prepares an
 *  empty profile and restarts NightMail into it, where the front screen offers to create or restore. If the open
 *  profile is itself still empty, that is the one used (`alreadyOpen`, `onDone`). `onBack`: back to the list. */
export function NewProfile({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const { failed, opening, open } = useOpen(onDone);
  const title = useRef<HTMLHeadingElement>(null);
  // The "+" that opened it is gone: focus goes to the title.
  useEffect(() => title.current?.focus(), []);
  const s = t().onboarding.accounts;
  if (opening) return <Opening />;
  return (
    <>
      <Back onBack={onBack} />
      <h1 ref={title} tabIndex={-1} className="nm-portada__titulo nm-portada__titulo--s">
        {s.newProfile}
      </h1>
      <p>{s.newProfileText}</p>
      <fieldset className="nm-ajuste">
        <legend className="sr-only">{s.network}</legend>
        <div className="nm-elecciones nm-elecciones--una">
          {networkChoices().map((c) => (
            <label key={c.value} className={classes('nm-eleccion', c.available ? 'nm-eleccion--activa' : 'nm-eleccion--inactiva')}>
              <input type="radio" name="red" value={c.value} defaultChecked={c.available} disabled={!c.available} />
              <span className="nm-eleccion__cuerpo">
                <span className="nm-eleccion__titulo">
                  {c.title} {!c.available && <Tag>{s.soon}</Tag>}
                </span>
                <span className="nm-eleccion__texto">{c.text}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <button type="button" className={PRIMARY} onClick={() => void open(api.newAccount)}>
        {s.continue}
      </button>
      <ErrorAviso message={failed ? s.failed : null} />
    </>
  );
}

/** `onLeave`: to the open account's front screen (unlock, the create or restore menu, or "ya está abierto"), when its
 *  row is chosen or no profile is left after deleting. No back arrow: this is the base screen.
 *  `onNew`: the "+", to "Nuevo perfil". `focusNew`: coming back from "Nuevo perfil", focus goes to the "+" again. */
export function AccountChooser({ onLeave, onNew, focusNew = false }: { onLeave: () => void; onNew: () => void; focusNew?: boolean }) {
  const [list, setList] = useState<AccountView[] | null>(null);
  const { failed, opening, open } = useOpen(onLeave);
  const [deleting, setDeleting] = useState<AccountRow | null>(null);
  // The name of the profile just deleted, announced once.
  const [deleted, setDeleted] = useState<string | null>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const plus = useRef<HTMLButtonElement>(null);

  // On mounting (it does not change meanwhile): the "Volver" of "Nuevo perfil" is gone, so focus would be lost.
  useEffect(() => {
    if (focusNew) plus.current?.focus();
  }, [focusNew]);

  // The deleted profile's trash can is gone, so focus would be lost: it goes to the title instead.
  useEffect(() => {
    if (deleted !== null) title.current?.focus();
  }, [deleted]);

  // The list could not be read: with no back arrow, "Reintentar" is the way on. `reload` counts its presses.
  const [loadFailed, setLoadFailed] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.listAccounts().then(
      (accounts) => {
        if (cancelled) return;
        setList(accounts);
        // "Reintentar" is gone with the notice, so focus would be lost: it goes to the title.
        if (reload > 0) title.current?.focus();
      },
      () => !cancelled && setLoadFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, [reload]);

  const closeDelete = useCallback(() => setDeleting(null), []);

  /** Another profile was deleted: the list again. With none left, the front screen of the open (empty) one. */
  async function afterDelete(name: string) {
    setDeleting(null);
    try {
      const accounts = await api.listAccounts();
      if (accounts.length === 0) {
        onLeave();
        return;
      }
      setList(accounts);
      setDeleted(name);
    } catch {
      setLoadFailed(true);
    }
  }

  const s = t().onboarding.accounts;
  if (opening) return <Opening />;
  const rows = list === null ? [] : accountRows(list);
  return (
    <>
      <h1 ref={title} tabIndex={-1} className="nm-portada__titulo nm-portada__titulo--s">
        {s.title}
      </h1>
      <p>{s.text}</p>
      {rows.length > 0 && (
        <ul className="nm-cuentas">
          {rows.map((row) => (
            <li key={row.id} className="nm-cuentas__fila">
              <button
                type="button"
                className="nm-cuenta"
                aria-current={row.current ? 'true' : undefined}
                onClick={() => (row.current ? onLeave() : void open(() => api.switchAccount(row.id)))}
              >
                <span className="nm-cuenta__txt">
                  <span className="nm-cuenta__nombre">{row.name}</span>
                  {row.created !== null && <span className="nm-cuenta__fecha">{row.created}</span>}
                </span>
                {row.current && <Tag>{s.recentlyUsed}</Tag>}
              </button>
              <button
                type="button"
                className={TRASH}
                title={deleteProfileLabel(row.name)}
                aria-label={deleteProfileLabel(row.name)}
                onClick={() => {
                  setDeleted(null);
                  setDeleting(row);
                }}
              >
                <Icon name="trash" className="nm-ic" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="sr-only" role="status">
        {deleted === null ? '' : t().onboarding.deleteProfile.deleted(deleted)}
      </p>
      <button ref={plus} type="button" className={PLUS} title={s.newProfile} aria-label={s.newProfile} onClick={onNew}>
        <Icon name="plus" className="nm-ic" />
      </button>
      <ErrorAviso message={failed ? s.failed : null} />
      {loadFailed && (
        <Aviso
          tone="error"
          actions={
            <button
              type="button"
              className="button button-small button-outline-weak nm-btn"
              onClick={() => {
                setLoadFailed(false);
                setReload((n) => n + 1);
              }}
            >
              <Icon name="arrows-rotate" className="nm-ic" />
              {s.retry}
            </button>
          }
        >
          <p>{s.loadFailed}</p>
        </Aviso>
      )}
      {deleting && (
        <DeleteProfileDialog
          id={deleting.id}
          name={deleting.name}
          onClose={closeDelete}
          onDeleted={() => void afterDelete(deleting.name)}
        />
      )}
    </>
  );
}
