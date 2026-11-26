// "i" icon with a short explanation that appears on hover or when reached by keyboard. The button can be focused
// and the explanation is its accessible description (`aria-describedby`): a screen reader reads it without opening anything.
// Escape hides it without removing focus from the button, also if the mouse opened it (rules in `infoTip`, pieces.ts).
import { useEffect, useId, useReducer } from 'react';
import { classes, INFO_TIP_IDLE, infoTip } from '../pieces.ts';
import { Icon } from './Icon.tsx';

interface Props {
  /** Accessible text of the button, e.g. "Qué es el DUST". */
  label: string;
  /** The explanation. */
  text: string;
}

export function InfoTip({ label, text }: Props) {
  const id = useId();
  const [state, send] = useReducer(infoTip, INFO_TIP_IDLE);

  // Only while visible: Escape hides it wherever focus is (opened with the mouse, focus may be elsewhere).
  // Not captured: the Midnight panel listens in capture and, if open, that Escape is its own and does not reach here.
  useEffect(() => {
    if (!state.shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      send('escape');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [state.shown]);

  return (
    <span
      className={classes('nm-info', state.shown && 'nm-info--abierta')}
      onMouseEnter={() => send('enter')}
      onMouseLeave={() => send('leave')}
    >
      <button
        type="button"
        className="nm-info__boton"
        aria-label={label}
        aria-describedby={id}
        onFocus={() => send('focus')}
        onBlur={() => send('blur')}
      >
        <Icon name="info-circle" className="nm-ic" />
      </button>
      <span role="tooltip" id={id} className="nm-info__texto">
        {text}
      </span>
    </span>
  );
}
