// Text that can be copied with one click (wallet address, the empty inbox's address). Copying uses
// `navigator.clipboard` and, if WebKitGTK does not allow it, selecting the text and `execCommand`; no Tauri plugin.
// `CopyButton`: the same copy for text already on screen in another shape (the 24 words of the recovery phrase).
import { useEffect, useRef, useState, type RefObject } from 'react';
import { copyStatus, copyText, SECRET_CLEAR_SECONDS, secretWipe } from '../pieces.ts';
import { Icon } from './Icon.tsx';

interface Props {
  text: string;
  /** Accessible text of the button, e.g. "Copiar la dirección". */
  label: string;
}

const FEEDBACK_MS = 2000;
const SECRET_MS = SECRET_CLEAR_SECONDS * 1000;

/** Plan B of the wipe: `execCommand('copy')` that puts an empty text instead of the selection. */
function copyEmpty(): boolean {
  const put = (e: ClipboardEvent) => {
    e.clipboardData?.setData('text/plain', '');
    e.preventDefault();
  };
  document.addEventListener('copy', put);
  try {
    return document.execCommand('copy');
  } finally {
    document.removeEventListener('copy', put);
  }
}

// The clipboard wipe of a copied secret lives at module level, not in the component: if the screen or dialog closes
// before the 30 seconds, the phrase still goes away at 30 seconds (a timer inside the component would die with it and
// leave the phrase in the clipboard). One for the whole app: copying the phrase again starts the count again, and any
// other copy in the app cancels it (`secretWipe`). If the window has no focus then, it tries again on every return of
// focus until it works, with no time limit on purpose (accepted by the owner).
const phraseWipe = secretWipe({
  writeText: (text) => navigator.clipboard.writeText(text),
  copyEmpty,
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (id) => window.clearTimeout(id),
  onNextFocus: (fn) => {
    window.addEventListener('focus', fn, { once: true });
    return () => window.removeEventListener('focus', fn);
  },
  onCopy: (fn) => {
    document.addEventListener('copy', fn);
    return () => document.removeEventListener('copy', fn);
  },
});

/** Selects what is inside `node` and copies it with `execCommand` (plan B of `copyText`). */
function selectAndCopy(node: HTMLElement | null): boolean {
  if (!node) return false;
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return document.execCommand('copy');
}

/** Copies `text` and keeps, for two seconds, whether it worked. `fallback`: the element whose text plan B selects.
 *  `secret`: after copying, the clipboard is wiped in `SECRET_CLEAR_SECONDS`, and the notice saying so stays until then. */
function useCopy(text: string, fallback: RefObject<HTMLElement | null>, secret = false) {
  const timer = useRef<number | undefined>(undefined);
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    const ok = await copyText(text, {
      writeText: navigator.clipboard?.writeText.bind(navigator.clipboard),
      selectAndCopy: () => selectAndCopy(fallback.current),
    });
    // Any other copy already replaced the phrase in the clipboard: the pending wipe must not erase it.
    if (ok) {
      if (secret) phraseWipe.schedule();
      else phraseWipe.cancel();
    }
    setState(ok ? 'ok' : 'fail');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), ok && secret ? SECRET_MS : FEEDBACK_MS);
  }

  return { state, copy };
}

export function Copiable({ text, label }: Props) {
  const codeRef = useRef<HTMLElement>(null);
  const { state, copy } = useCopy(text, codeRef);

  return (
    <div className="nm-copiar">
      {/* The button sits at the end of the text, inside the box and at the font size; only the text is copied. */}
      <div className="nm-copiable nm-copiar__caja">
        <code ref={codeRef} className="nm-copiar__texto">
          {text}
        </code>
        <button type="button" className="nm-copiar__boton" title={label} aria-label={label} onClick={copy}>
          <Icon name={state === 'ok' ? 'checkmark' : 'squares'} className="nm-ic" />
        </button>
      </div>
      <span role="status" className={state === 'fail' ? 'nm-pista' : 'nm-copiar__estado'}>
        {copyStatus(state)}
      </span>
    </div>
  );
}

/** A button with the copy icon and a visible text, for text shown in another shape (a list of words). It copies
 *  `text` as it is. Plan B selects a hidden copy of `text` next to the button, inside the same dialog (outside an open
 *  dialog nothing can be selected). `secret` (the recovery phrase): wiped from the clipboard 30 seconds after copying. */
export function CopyButton({ text, label, secret = false }: Props & { secret?: boolean }) {
  const hiddenRef = useRef<HTMLSpanElement>(null);
  const { state, copy } = useCopy(text, hiddenRef, secret);

  return (
    <div className="nm-copiar">
      <div>
        <button type="button" className="button button-small button-outline-weak nm-btn" onClick={copy}>
          <Icon name={state === 'ok' ? 'checkmark' : 'squares'} className="nm-ic" />
          {label}
        </button>
        <span ref={hiddenRef} className="nm-copiar__oculto" aria-hidden="true">
          {text}
        </span>
      </div>
      <span role="status" className={state === 'fail' ? 'nm-pista' : 'nm-copiar__estado'}>
        {copyStatus(state, secret)}
      </span>
    </div>
  );
}
