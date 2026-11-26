// "Cambiar la contraseña" (Settings): a dialog with the current one, the new one and its repetition. The core checks the current
// one by opening the seed phrase file and replaces it in one go (`keys::change_password`): either the old one or the
// new one remains. The session stays open. Passwords leave React state as soon as they are sent.
import { useId, useState } from 'react';
import { api } from '../api.ts';
import { Campo } from '../components/Campo.tsx';
import { Dialogo } from '../components/Dialogo.tsx';
import { ErrorAviso } from './common.tsx';
import { onSubmitWith } from './forms.ts';
import { t } from '../i18n/index.ts';
import { changeErrorPlace, changeProblem, mismatchText, pairMismatch, type ChangeField, type ChangeFields } from './password.ts';
import { useAction } from './useAction.ts';

const OK = 'button button-medium button-solid-norm nm-btn';
const CANCEL = 'button button-medium button-outline-weak nm-btn';
const EMPTY: ChangeFields = { current: '', next: '', repeat: '' };

interface Props {
  onClose: () => void;
  /** The password has changed. While it changes, neither "Cancelar" nor Esc close the dialog (it can no longer be cancelled);
   *  if a webview closes it anyway, this is still called: the card's notice does not depend on the dialog. */
  onChanged: () => void;
}

export function PasswordChange({ onClose, onChanged }: Props) {
  const [fields, setFields] = useState<ChangeFields>(EMPTY);
  // Whether a submit was attempted with a problem in the fields. The problem and its text are derived when painting (from `fields`, which
  // does not change until edited, and editing clears it): so the text follows the language.
  const [checked, setChecked] = useState(false);
  const problem = checked ? changeProblem(fields) : null;
  const { busy, error, code, run } = useAction();
  const formId = useId();
  const ids = { current: useId(), next: useId(), repeat: useId() };

  function edit(field: ChangeField, value: string) {
    setFields((f) => ({ ...f, [field]: value }));
    setChecked(false);
  }

  function focus(field: ChangeField) {
    document.getElementById(ids[field])?.focus();
  }

  async function submit() {
    if (busy) return;
    const found = changeProblem(fields);
    setChecked(found !== null);
    if (found) {
      focus(found.field);
      return;
    }
    const { current, next } = fields;
    // Out of state before waiting for the core (Argon2id takes time): if it fails, they are typed again.
    setFields(EMPTY);
    const ok = await run(async () => {
      await api.changePassword(current, next);
      return true;
    });
    if (ok) {
      onChanged();
      onClose();
    } else {
      focus('current');
    }
  }

  const place = error ? changeErrorPlace(code, error) : null;
  const fieldError = (field: ChangeField) =>
    problem?.field === field ? problem.message : place?.field === field ? place.message : null;
  const repeatError = fieldError('repeat') ?? (pairMismatch(fields.next, fields.repeat) ? mismatchText() : null);
  const s = t().onboarding.password;
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
          <button type="submit" form={formId} className={OK} aria-busy={busy || undefined}>
            {busy ? s.busy : s.submit}
          </button>
        </>
      }
    >
      <form id={formId} className="nm-pila nm-pila--l" onSubmit={onSubmitWith(() => void submit())}>
        <p className="nm-suave">{s.text}</p>
        <Campo
          id={ids.current}
          label={s.current}
          type="password"
          value={fields.current}
          onChange={(v) => edit('current', v)}
          error={fieldError('current')}
          autoFocus
        />
        <Campo
          id={ids.next}
          label={s.next}
          type="password"
          value={fields.next}
          onChange={(v) => edit('next', v)}
          error={fieldError('next')}
        />
        <Campo
          id={ids.repeat}
          label={s.repeat}
          type="password"
          value={fields.repeat}
          onChange={(v) => edit('repeat', v)}
          error={repeatError}
        />
      </form>
      <ErrorAviso message={place?.field === null ? place.message : null} />
    </Dialogo>
  );
}
