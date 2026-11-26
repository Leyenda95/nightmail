// "Frase semilla" (sidebar): a dialog that asks for the password again and shows the 24 words.
// The phrase is discarded on closing: whoever uses it unmounts it (Esc, "Cancelar", "Cerrar").
import { useId, useState } from 'react';
import { api } from '../api.ts';
import { Campo } from '../components/Campo.tsx';
import { Dialogo } from '../components/Dialogo.tsx';
import { seedWords } from '../format.ts';
import { t } from '../i18n/index.ts';
import { ErrorAviso } from './common.tsx';
import { onSubmitWith } from './forms.ts';
import { useAction } from './useAction.ts';

const OK = 'button button-medium button-solid-norm nm-btn';
const CANCEL = 'button button-medium button-outline-weak nm-btn';

export function SeedReveal({ onClose }: { onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [phrase, setPhrase] = useState<string | null>(null);
  const { busy, error, code, run } = useAction();
  const [empty, setEmpty] = useState(false);
  const formId = useId();
  const s = t().onboarding.seedReveal;

  async function reveal() {
    if (busy) return;
    if (password === '') {
      setEmpty(true);
      return;
    }
    setEmpty(false);
    const seed = await run(() => api.revealSeed(password));
    setPassword('');
    if (seed) setPhrase(seed.phrase);
  }

  // A wrong password belongs to the field; any other error goes apart and does not mark it.
  const fieldError = empty ? s.empty : code === 'wrongPassword' ? error : null;
  if (phrase !== null) {
    return (
      <Dialogo
        title={s.title}
        size="l"
        onClose={onClose}
        footer={
          <button type="button" className={OK} autoFocus onClick={onClose}>
            {s.close}
          </button>
        }
      >
        {/* BIP-39 list in English in both languages (as in Welcome.tsx). */}
        <ol className="nm-semilla" lang="en">
          {seedWords(phrase).map((word, i) => (
            <li key={i}>{word}</li>
          ))}
        </ol>
        <p className="nm-pista">{s.hint}</p>
      </Dialogo>
    );
  }
  return (
    <Dialogo
      title={s.askTitle}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={CANCEL} onClick={onClose}>
            {s.cancel}
          </button>
          <button type="submit" form={formId} className={OK} aria-busy={busy || undefined}>
            {busy ? s.busy : s.show}
          </button>
        </>
      }
    >
      <form id={formId} className="nm-pila nm-pila--l" onSubmit={onSubmitWith(() => void reveal())}>
        <p className="nm-suave">{s.askText}</p>
        <Campo label={s.password} type="password" value={password} onChange={(v) => {
            setPassword(v);
            setEmpty(false);
          }} error={fieldError} autoFocus />
      </form>
      <ErrorAviso message={fieldError ? null : error} />
    </Dialogo>
  );
}
