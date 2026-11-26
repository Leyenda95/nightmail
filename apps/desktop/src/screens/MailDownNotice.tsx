// Notice above the mail list (inbox and archive) while the NightMail server's mail does not answer: the status panel no
// longer carries sentences and nothing else said that new mail is not arriving. When it shows is decided by
// `mailDownShown` (`sidebar.ts`) with the same line as the sidebar dot (`useServerLine`, `serviceStatus.ts`).
//
// It goes in the notice strip, edge to edge over the panels: once even with a list and a reader, also with the
// empty inbox and with a message open.
//
// Screen reader: the sentence is announced by `MailDownStatus`, a `role="status"` region that is always mounted (empty
// without a notice). A region that appears already filled is not always announced (Orca with WebKitGTK), and the button
// stays outside it so "Comprobando..." does not read the sentence again. The visible notice has no role and its
// sentence is not read twice: the button has it as its description.
import { useEffect, useRef, useState } from 'react';
import { Aviso } from '../components/Aviso.tsx';
import { Icon } from '../components/Icon.tsx';
import { t } from '../i18n/index.ts';
import { focusOrphaned } from '../inbox.ts';
import { noticeFocusSelectors, type List } from '../nav.ts';
import { checkAll } from '../serviceStatus.ts';
import { mailDownText } from '../sidebar.ts';

const STATUS_ID = 'correo-caido';

/** The region that announces the notice: always mounted, with the sentence only while the notice is visible. */
export function MailDownStatus({ shown }: { shown: boolean }) {
  return (
    <p id={STATUS_ID} className="sr-only" role="status">
      {shown ? mailDownText() : ''}
    </p>
  );
}

/** Focuses the first of `selectors` that accepts it (a hidden one does not). */
function focusFirst(selectors: readonly string[]) {
  for (const selector of selectors) {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      el.focus();
      if (document.activeElement === el) return;
    }
  }
}

/** `list`: the view the notice is in, to leave focus on its title if the notice goes away with focus inside. */
export function MailDownNotice({ list }: { list: List }) {
  const [checking, setChecking] = useState(false);
  // Focus is on "Reintentar". A `blur` with no target (the button unmounts, the window loses focus) does not clear it:
  // on unmount it is checked whether focus stayed on <body>.
  const focused = useRef(false);
  const target = useRef(list);
  useEffect(() => {
    target.current = list;
  }, [list]);
  useEffect(
    () => () => {
      // The ring mode (`modality.ts`) is left alone: invisible with the mouse, visible with the keyboard, as it should be.
      if (focused.current && focusOrphaned(document.activeElement, document.body)) focusFirst(noticeFocusSelectors(target.current));
    },
    [],
  );

  async function retry() {
    // No `disabled` (the button would lose focus): while running, it does nothing. If the mail answers, the notice goes away by itself.
    if (checking) return;
    setChecking(true);
    try {
      await checkAll();
    } finally {
      setChecking(false);
    }
  }

  return (
    <Aviso
      tone="atencion"
      strip
      role={null}
      actions={
        <button
          type="button"
          className="button button-small button-outline-weak nm-btn"
          aria-busy={checking || undefined}
          aria-disabled={checking || undefined}
          aria-describedby={STATUS_ID}
          onFocus={() => {
            focused.current = true;
          }}
          onBlur={(e) => {
            if (e.relatedTarget !== null) focused.current = false;
          }}
          onClick={retry}
        >
          <Icon name={checking ? 'espera' : 'arrows-rotate'} className="nm-ic" />
          {checking ? t().screensMail.mailDown.checking : t().screensMail.mailDown.retry}
        </button>
      }
    >
      <p aria-hidden="true">{mailDownText()}</p>
    </Aviso>
  );
}
