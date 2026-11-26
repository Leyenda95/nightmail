// "Nombre del perfil" card in Settings: renames the open profile (`set_account_name`, session open). The field starts
// with the name shown now: the one the user wrote or the automatic one ("Perfil 2") in the current language. Left
// empty, the automatic name comes back with its same number. The name is read from `list_accounts` on opening the
// page, and the profile list (`Accounts.tsx`) reads it again each time it opens, so it shows the new one too.
import { useEffect, useState } from 'react';
import { accountNameTooLong, MAX_ACCOUNT_NAME, profileNameDraft } from '../accounts.ts';
import { api } from '../api.ts';
import type { AccountView } from '../bindings/AccountView.ts';
import { Aviso } from '../components/Aviso.tsx';
import { Campo } from '../components/Campo.tsx';
import { t } from '../i18n/index.ts';
import { ErrorAviso } from './common.tsx';
import { onSubmitWith } from './forms.ts';

export function ProfileNameCard() {
  const [own, setOwn] = useState<AccountView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  /** What the user typed; `null` while untouched (the field shows the current name, in the language of the moment). */
  const [typed, setTyped] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.listAccounts().then(
      (list) => {
        if (cancelled) return;
        const current = list.find((a) => a.current);
        if (current === undefined) setLoadFailed(true);
        else setOwn(current);
      },
      () => !cancelled && setLoadFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const s = t().settings.profileName;
  const draft = own === null ? '' : profileNameDraft(own, typed);
  const tooLong = accountNameTooLong(draft);

  async function save() {
    setBusy(true);
    setSaved(false);
    setFailed(false);
    try {
      setOwn(await api.setAccountName(draft));
      setTyped(null);
      setSaved(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  // Busy does not disable the button (focus would be lost): the guard is in the handler.
  const send = () => {
    if (!busy && !tooLong && own !== null) void save();
  };
  return (
    <section className="nm-tarjeta">
      <h2 className="nm-tarjeta__titulo">{s.title}</h2>
      <p className="nm-suave">{s.text(MAX_ACCOUNT_NAME)}</p>
      <ErrorAviso message={loadFailed ? s.loadFailed : null} />
      {own !== null && (
        <form className="nm-pila" onSubmit={onSubmitWith(send)}>
          <Campo
            label={s.label}
            value={draft}
            onChange={(value) => {
              setTyped(value);
              setSaved(false);
            }}
            error={tooLong ? s.tooLong(MAX_ACCOUNT_NAME) : null}
          />
          <div className="nm-fila">
            <button type="submit" className="button button-medium button-outline-weak nm-btn" disabled={tooLong} aria-busy={busy || undefined}>
              {busy ? s.saving : s.save}
            </button>
          </div>
          {saved && (
            <Aviso tone="exito">
              <p>{s.saved}</p>
            </Aviso>
          )}
          <ErrorAviso message={failed ? s.failed : null} />
        </form>
      )}
    </section>
  );
}
