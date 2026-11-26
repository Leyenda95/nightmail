// New-mail notice while another part of the app is in view: "3 mensajes nuevos", with "Ir a la bandeja" and a button
// to dismiss it. It only says how many, never from whom nor the subject. When it appears, how it
// groups arrivals and when it hides itself is decided by `newMail.ts`.
//
// It goes in the notice strip, like the mail-down one, and is announced the same way: the sentence is spoken by `NewMailStatus`, a polite
// `role="status"` region that is always mounted. The visible notice has no role and its sentence is not read twice:
// the button has it as its description.
import { useEffect, useRef } from 'react';
import { Aviso } from '../components/Aviso.tsx';
import { Icon } from '../components/Icon.tsx';
import { t } from '../i18n/index.ts';
import { focusOrphaned } from '../inbox.ts';
import { LIST_TITLE_ID } from '../nav.ts';

const STATUS_ID = 'correo-nuevo';

/** The region that announces the notice: always mounted, with the sentence only while the notice is visible. */
export function NewMailStatus({ count }: { count: number }) {
  return (
    <p id={STATUS_ID} className="sr-only" role="status">
      {count > 0 ? t().screensMail.newMail.count(count) : ''}
    </p>
  );
}

interface Props {
  count: number;
  onGo: () => void;
  onDismiss: () => void;
  /** The pointer or focus enters (`true`) or leaves: while they are in, it does not hide itself. */
  onHold: (held: boolean) => void;
}

export function NewMailNotice({ count, onGo, onDismiss, onHold }: Props) {
  // If it goes away with focus inside ("Ir a la bandeja", dismiss), focus goes to the inbox title if visible. If it is not
  // visible (dismissed from Settings), it stays where the browser leaves it.
  const focused = useRef(false);
  useEffect(
    () => () => {
      if (focused.current && focusOrphaned(document.activeElement, document.body)) document.getElementById(LIST_TITLE_ID)?.focus();
    },
    [],
  );
  const words = t().screensMail.newMail;
  return (
    <div
      onMouseEnter={() => onHold(true)}
      onMouseLeave={() => onHold(false)}
      onFocus={() => {
        focused.current = true;
        onHold(true);
      }}
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget)) return;
        if (e.relatedTarget !== null) focused.current = false;
        onHold(false);
      }}
    >
      <Aviso
        tone="info"
        strip
        role={null}
        actions={
          <>
            <button type="button" className="button button-small button-outline-weak nm-btn" aria-describedby={STATUS_ID} onClick={onGo}>
              <Icon name="inbox" className="nm-ic" />
              {words.goToInbox}
            </button>
            <button type="button" className="button button-small button-ghost-weak nm-btn button-for-icon" title={words.dismiss} onClick={onDismiss}>
              <Icon name="cross" className="nm-ic" />
              <span className="sr-only">{words.dismiss}</span>
            </button>
          </>
        }
      >
        <p aria-hidden="true">{words.count(count)}</p>
      </Aviso>
    </div>
  );
}
