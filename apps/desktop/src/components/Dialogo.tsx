// Modal dialog: only to confirm something, show a secret or give a result that has to be seen (opening a link,
// abandoning a payment, viewing the phrase, the late result of a restore).
// It is a native <dialog> opened with showModal(): the browser traps focus inside, closes on Esc and, on closing,
// returns focus to where it was. No dependencies or plugins.
//
// It is only painted while needed: the caller mounts it to open it and unmounts it to close it. On opening, focus
// goes to its first control: the content order decides (in a confirmation, "Cancelar" comes first).
//
// It is sized by its content (the dialog block in styles/app.css). With long content, title and footer stay fixed and
// the body scrolls; only then does the body enter the keyboard order, so it can be scrolled without a mouse.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';

interface Props {
  title: string;
  /** Width: `s` for confirmations, `l` for wide content (seed phrase, restore). Without it, the normal one. */
  size?: 's' | 'l';
  /** Footer buttons; the first one is the harmless one. */
  footer: ReactNode;
  /** The dialog was closed with Esc: whoever uses it must stop painting it. */
  onClose: () => void;
  /** While `true`, Esc does not close it: an operation is running that can no longer be cancelled. */
  locked?: boolean;
  /** The body is the dialog's explanation (short confirmations): it is linked with `aria-describedby` and the screen
   *  reader reads it on opening, together with the title. */
  described?: boolean;
  children: ReactNode;
}

function canShowModal(dialog: HTMLDialogElement): boolean {
  return typeof dialog.showModal === 'function';
}

/** Opens the dialog and returns how to close it. It must be closed BEFORE React removes it from the document: only then
 *  does the browser return focus. Without showModal() (an old webview) it is shown non-modally, so the action is
 *  not left without an exit, and focus is moved and returned by hand. */
function openDialog(dialog: HTMLDialogElement): () => void {
  if (canShowModal(dialog)) {
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }
  const previous = document.activeElement;
  dialog.setAttribute('open', '');
  dialog.tabIndex = -1;
  dialog.focus();
  return () => {
    dialog.removeAttribute('open');
    if (previous instanceof HTMLElement) previous.focus();
  };
}

/** Does the body overflow? Checked when it resizes (also at the start: the observer reports on starting). It runs
 *  after the dialog opens, so it does not change where focus goes on opening. Without ResizeObserver, it is not checked. */
function useOverflows(ref: RefObject<HTMLElement | null>): boolean {
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const body = ref.current;
    if (!body || typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(() => setOverflows(body.scrollHeight > body.clientHeight));
    observer.observe(body);
    return () => observer.disconnect();
  }, [ref]);
  return overflows;
}

export function Dialogo({ title, size, footer, onClose, locked = false, described = false, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const overflows = useOverflows(bodyRef);
  const titleId = useId();
  const bodyId = useId();

  // Esc closes the dialog on its own and then reports with `close`. If the dialog is open when the report arrives,
  // it is the echo of a close of ours (StrictMode mounts, unmounts and mounts again): not an order to close.
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return undefined;
    const closed = () => {
      if (!dialog.open) onClose();
    };
    dialog.addEventListener('close', closed);
    return () => dialog.removeEventListener('close', closed);
  }, [onClose]);

  // Before closing on Esc the browser asks with `cancel`: with `locked` it is told no. A webview may still
  // close on the second press (Chromium); whoever uses `locked` must not depend on staying mounted.
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog || !locked) return undefined;
    const keep = (e: Event) => e.preventDefault();
    dialog.addEventListener('cancel', keep);
    return () => dialog.removeEventListener('cancel', keep);
  }, [locked]);

  // A layout effect, not a passive one: its cleanup runs before the <dialog> leaves the document.
  useLayoutEffect(() => {
    const dialog = ref.current;
    return dialog ? openDialog(dialog) : undefined;
  }, []);

  // Only without showModal(): with it, the browser already handles Esc. Handled here, nobody else uses it (`Main`'s Esc would
  // also close the open message: `nav.ts`, `escapeCloses`).
  function closeOnEscape(e: KeyboardEvent<HTMLDialogElement>) {
    if (e.key !== 'Escape' || canShowModal(e.currentTarget)) return;
    e.preventDefault();
    if (!locked) onClose();
  }

  return (
    <dialog
      ref={ref}
      className={size ? `nm-dialogo nm-dialogo--${size}` : 'nm-dialogo'}
      aria-labelledby={titleId}
      aria-describedby={described ? bodyId : undefined}
      onKeyDown={closeOnEscape}
    >
      <h2 id={titleId} className="nm-dialogo__titulo">
        {title}
      </h2>
      <div ref={bodyRef} id={bodyId} className="nm-dialogo__cuerpo" tabIndex={overflows ? 0 : undefined}>
        {children}
      </div>
      <div className="nm-dialogo__pie">{footer}</div>
    </dialog>
  );
}
