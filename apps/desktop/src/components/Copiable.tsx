// Text that can be copied with one click (wallet address, the empty inbox's address). Copying uses
// `navigator.clipboard` and, if WebKitGTK does not allow it, selecting the text and `execCommand`; no Tauri plugin.
import { useEffect, useRef, useState } from 'react';
import { copyStatus, copyText } from '../pieces.ts';
import { Icon } from './Icon.tsx';

interface Props {
  text: string;
  /** Accessible text of the button, e.g. "Copiar la dirección". */
  label: string;
}

const FEEDBACK_MS = 2000;

export function Copiable({ text, label }: Props) {
  const codeRef = useRef<HTMLElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    const ok = await copyText(text, {
      writeText: navigator.clipboard?.writeText.bind(navigator.clipboard),
      selectAndCopy: () => {
        const node = codeRef.current;
        if (!node) return false;
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        return document.execCommand('copy');
      },
    });
    setState(ok ? 'ok' : 'fail');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), FEEDBACK_MS);
  }

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
