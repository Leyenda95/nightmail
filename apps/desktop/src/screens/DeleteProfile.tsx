// "Eliminar perfil de este ordenador": a dialog that says what is erased (this computer's files only, nothing on
// Midnight), asks for THAT profile's password and deletes it (`delete_account`). Used by the trash can of each box in
// the profile list (`Accounts.tsx`) and by the Settings card for the open profile. The core checks the password as
// unlocking does, with the same failed-attempt counter and waits: wrong, nothing is deleted. The password leaves React
// state as soon as it is sent.
//
// Deleting the open profile restarts NightMail (into the profile list, or the welcome screen if none is left): the
// dialog then stays, locked, saying so until the window closes. Another profile: `onDeleted`.
import { useId, useState } from 'react';
import { deleteFieldError, deleteProfileError } from '../accounts.ts';
import { api } from '../api.ts';
import { Aviso } from '../components/Aviso.tsx';
import { Campo } from '../components/Campo.tsx';
import { Dialogo } from '../components/Dialogo.tsx';
import { Icon } from '../components/Icon.tsx';
import { Luz } from '../components/Luz.tsx';
import { t } from '../i18n/index.ts';
import { ErrorAviso } from './common.tsx';
import { onSubmitWith } from './forms.ts';
import { useAction } from './useAction.ts';

const CANCEL = 'button button-medium button-outline-weak nm-btn';
const DANGER = 'button button-medium button-solid-danger nm-btn';

interface Props {
  /** The profile (`AccountView.id`) and its name as the list shows it. */
  id: string;
  name: string;
  onClose: () => void;
  /** Another profile than the open one was deleted: the list must be read again. */
  onDeleted: () => void;
}

export function DeleteProfileDialog({ id, name, onClose, onDeleted }: Props) {
  const [password, setPassword] = useState('');
  const [empty, setEmpty] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const { busy, error, code, run } = useAction();
  const formId = useId();
  const s = t().onboarding.deleteProfile;

  async function submit() {
    if (busy || restarting) return;
    if (password === '') {
      setEmpty(true);
      return;
    }
    setEmpty(false);
    const typed = password;
    // Out of state before waiting for the core (Argon2id takes time): if it fails, it is typed again.
    setPassword('');
    const outcome = await run(() => api.deleteAccount(id, typed), deleteProfileError);
    if (outcome === 'restarting') setRestarting(true);
    else if (outcome === 'deleted') onDeleted();
  }

  if (restarting) {
    return (
      <Dialogo title={s.restartingTitle} size="s" onClose={onClose} locked footer={null}>
        <p className="nm-fila" role="status">
          <Luz mode="trabaja" /> {s.restartingText}
        </p>
      </Dialogo>
    );
  }

  const fieldError = deleteFieldError(empty, code, error);
  return (
    <Dialogo
      title={s.title}
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <button type="button" className={CANCEL} disabled={busy} onClick={onClose}>
            {s.cancel}
          </button>
          <button type="submit" form={formId} className={DANGER} aria-busy={busy || undefined}>
            <Icon name="trash" className="nm-ic" />
            {busy ? s.busy : s.submit}
          </button>
        </>
      }
    >
      <form id={formId} className="nm-pila nm-pila--l" onSubmit={onSubmitWith(() => void submit())}>
        <p>
          <strong>{s.which(name)}</strong>
        </p>
        <p>{s.device}</p>
        <p>{s.chain}</p>
        {/* Part of the explanation, not news: no live role. */}
        <Aviso tone="atencion" role={null}>
          <p>{s.words}</p>
        </Aviso>
        <Campo
          label={s.password}
          type="password"
          value={password}
          onChange={(v) => {
            setPassword(v);
            setEmpty(false);
          }}
          error={fieldError}
          autoFocus
        />
      </form>
      <ErrorAviso message={fieldError ? null : error} />
    </Dialogo>
  );
}
