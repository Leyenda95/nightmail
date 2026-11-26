// "Elige un perfil" (the screens call accounts "perfiles"): the accounts saved on this device, to open another one or create or restore a new one. Only the
// box's content: whoever shows it puts it in its frame (the front screen, `Welcome.tsx`). Choosing another account
// restarts NightMail into it (the core saves the choice and relaunches the app), so meanwhile "Abriendo el perfil…"
// stays until the window closes. Choosing the open one restarts nothing: it goes back to its front screen.
// To the right of each box, inside it, a trash can deletes that profile from this computer (`DeleteProfile.tsx`, with its password).
// Deleting another one reads the list again (none left: back to the front screen, the welcome); deleting the open one
// restarts NightMail.
import { useCallback, useEffect, useRef, useState } from 'react';
import { accountRows, deleteProfileLabel, type AccountRow } from '../accounts.ts';
import { api } from '../api.ts';
import type { AccountView } from '../bindings/AccountView.ts';
import type { SwitchOutcome } from '../bindings/SwitchOutcome.ts';
import { Icon } from '../components/Icon.tsx';
import { Luz } from '../components/Luz.tsx';
import { Tag } from '../components/Tag.tsx';
import { t } from '../i18n/index.ts';
import { ErrorAviso } from './common.tsx';
import { DeleteProfileDialog } from './DeleteProfile.tsx';

const SECONDARY = 'button button-large button-outline-weak nm-btn w-full';
const TRASH = 'button button-medium button-ghost-weak nm-btn button-for-icon nm-cuenta__borrar';

/** `onBack`: back to the open account's front screen (unlock, the create or restore menu, or "ya está abierto"). */
export function AccountChooser({ onBack }: { onBack: () => void }) {
  const [list, setList] = useState<AccountView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [opening, setOpening] = useState(false);
  const [deleting, setDeleting] = useState<AccountRow | null>(null);
  // The name of the profile just deleted, announced once.
  const [deleted, setDeleted] = useState<string | null>(null);
  const title = useRef<HTMLHeadingElement>(null);

  // The deleted profile's trash can is gone, so focus would be lost: it goes to the title instead.
  useEffect(() => {
    if (deleted !== null) title.current?.focus();
  }, [deleted]);

  useEffect(() => {
    let cancelled = false;
    api.listAccounts().then(
      (accounts) => !cancelled && setList(accounts),
      () => !cancelled && setFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, []);

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

  const closeDelete = useCallback(() => setDeleting(null), []);

  /** Another profile was deleted: the list again. With none left, the front screen of the open (empty) one. */
  async function afterDelete(name: string) {
    setDeleting(null);
    try {
      const accounts = await api.listAccounts();
      if (accounts.length === 0) {
        onBack();
        return;
      }
      setList(accounts);
      setDeleted(name);
    } catch {
      setFailed(true);
    }
  }

  const s = t().onboarding.accounts;
  if (opening) {
    return (
      <>
        <h1 className="nm-portada__titulo nm-portada__titulo--s">{s.openingTitle}</h1>
        <p className="nm-fila" role="status">
          <Luz mode="trabaja" /> {s.openingText}
        </p>
      </>
    );
  }
  const rows = list === null ? [] : accountRows(list);
  return (
    <>
      <button type="button" className="button button-small button-ghost-weak nm-btn nm-volver" onClick={onBack}>
        <Icon name="arrow-left" className="nm-ic" />
        {t().onboarding.welcome.back}
      </button>
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
                onClick={() => (row.current ? onBack() : void open(() => api.switchAccount(row.id)))}
              >
                <span className="nm-cuenta__txt">
                  <span className="nm-cuenta__nombre">{row.name}</span>
                  {row.created !== null && <span className="nm-cuenta__fecha">{row.created}</span>}
                </span>
                {row.current && <Tag tone="exito">{s.openNow}</Tag>}
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
      <button type="button" className={SECONDARY} onClick={() => void open(api.newAccount)}>
        {s.createOther}
      </button>
      <ErrorAviso message={failed ? s.failed : null} />
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
