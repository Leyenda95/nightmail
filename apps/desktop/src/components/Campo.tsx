// Form field: label above, the base control (`.field` or `.textarea`) and, below, its messages. The label is tied
// to the control by `htmlFor` and the messages by `aria-describedby`; an error also marks the control with
// `aria-invalid` and carries an icon, so it does not depend on colour alone. The base stylesheet draws the error border on
// `.field`; `.textarea` lacks it and `styles/app.css` supplies it.
import { useId, useState } from 'react';
import { t } from '../i18n/index.ts';
import { describedBy } from '../pieces.ts';
import { Icon } from './Icon.tsx';

interface ControlProps {
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'password';
  /** Several lines, in monospace (the seed phrase). */
  multiline?: boolean;
  /** Fixed ending attached to the field ("@dominio"); only on single-line fields. */
  suffix?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Focuses the field on mount (the first one of a full-screen form). */
  autoFocus?: boolean;
}

interface Props extends ControlProps {
  label: string;
  /** Fixed `id` of the control, so navigation can send focus to it (`nav.ts`); otherwise a generated one. */
  id?: string;
  /** Permanent help under the field. */
  help?: string;
  /** Error message; while there is one, the field is marked invalid. */
  error?: string | null;
  /** Confirmation ("... está disponible"). */
  ok?: string | null;
}

/** What ties the control to its label and messages. */
interface Wiring {
  id: string;
  'aria-invalid'?: true;
  'aria-describedby'?: string;
}

// Nothing typed here (passwords, seed phrase, mailbox names) should be autocorrected or remembered.
const QUIET = { autoComplete: 'off', autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false } as const;

function Control({ value, onChange, type = 'text', multiline = false, suffix, placeholder, disabled, autoFocus, ...wiring }: ControlProps & Wiring) {
  // Password fields carry an eye button that shows what was typed and hides it again.
  const [shown, setShown] = useState(false);
  const common = { ...QUIET, ...wiring, value, placeholder, disabled, autoFocus };
  if (multiline) return <textarea className="textarea w-full" rows={4} {...common} onChange={(e) => onChange(e.target.value)} />;
  if (type === 'password') {
    const label = shown ? t().screensMail.common.hidePassword : t().screensMail.common.showPassword;
    return (
      <span className="nm-con-ojo">
        <input className="field w-full" type={shown ? 'text' : 'password'} {...common} onChange={(e) => onChange(e.target.value)} />
        <button type="button" className="nm-con-ojo__boton" title={label} aria-label={label} aria-controls={wiring.id} disabled={disabled} onClick={() => setShown(!shown)}>
          <Icon name={shown ? 'eye-off' : 'eye'} className="nm-ic" />
        </button>
      </span>
    );
  }
  const input = <input className={suffix ? 'field' : 'field w-full'} type={type} {...common} onChange={(e) => onChange(e.target.value)} />;
  if (!suffix) return input;
  return (
    <span className="nm-con-sufijo">
      {input}
      <span className="nm-con-sufijo__sufijo">{suffix}</span>
    </span>
  );
}

export function Campo({ label, id: fixedId, help, error, ok, ...control }: Props) {
  const generated = useId();
  const id = fixedId ?? generated;
  const ids = { help: `${id}-ayuda`, error: `${id}-error`, ok: `${id}-ok` };
  return (
    <div className="nm-campo">
      <label className="nm-campo__label" htmlFor={id}>
        {label}
      </label>
      <Control {...control} id={id} aria-invalid={error ? true : undefined} aria-describedby={describedBy(help && ids.help, error && ids.error, ok && ids.ok)} />
      {help && (
        <span id={ids.help} className="nm-campo__ayuda">
          {help}
        </span>
      )}
      {error && (
        <span id={ids.error} className="nm-campo__error" role="alert">
          <Icon name="exclamation-circle" className="nm-ic" />
          <span>{error}</span>
        </span>
      )}
      {ok && (
        <span id={ids.ok} className="nm-campo__ok" role="status">
          <Icon name="checkmark" className="nm-ic" />
          {ok}
        </span>
      )}
    </div>
  );
}
