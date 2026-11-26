// "Eliminar perfil de este ordenador": a dialog that says what is erased (this computer's files only, nothing on
// Midnight), asks for THAT profile's password and deletes it (`delete_account`). Used by the trash can of each box in
// the profile list (`Accounts.tsx`) and by the Settings card for the open profile. The core checks the password as
// unlocking does, with the same failed-attempt counter and waits: wrong, nothing is deleted. The password leaves React
// state as soon as it is sent.
//
// Deleting the open profile opens another one in this same window and the whole UI starts again from the profile list,
// or the welcome screen if none is left (`profileSwitch.ts`). If it fails once the profile is closed, that same
// profile opens again and the list shows the error. Another profile: `onDeleted`.
import { useId, useState } from 'react';
import { deleteFieldError, deleteProfileError } from '../accounts.ts';
import { api } from '../api.ts';
import { Aviso } from '../components/Aviso.tsx';
import { Campo } from '../components/Campo.tsx';
import { Dialogo } from '../components/Dialogo.tsx';
import { Icon } from '../components/Icon.tsx';
import { t } from '../i18n/index.ts';
import { profileOpened } from '../profileSwitch.ts';
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
  const { busy: running, error, code, run } = useAction();
  // `switched`: the next profile is being read and mounted in place of this one, which stays busy until replaced
  // (as the profile list does), so it cannot be sent again meanwhile. Only `deleted` or an error free it.
  const [switching, setSwitching] = useState(false);
  const busy = running || switching;
  const formId = useId();
  const s = t().onboarding.deleteProfile;

  async function submit() {
    if (busy) return;
    if (password === '') {
      setEmpty(true);
      return;
    }
    setEmpty(false);
    const typed = password;
    // Out of state before waiting for the core (Argon2id takes time): if it fails, it is typed again.
    setPassword('');
    const outcome = await run(async () => {
      const answer = await api.deleteAccount(id, typed);
      // Set before the action ends, so the dialog is never free in between.
      if (answer.kind === 'switched') setSwitching(true);
      return answer;
    }, deleteProfileError);
    // `switched` with an error: the open profile was closed but not deleted, and it opened again.
    if (outcome?.kind === 'switched') profileOpened(outcome.error);
    else if (outcome?.kind === 'deleted') onDeleted();
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
