// A panel that opens from a button at the foot of the sidebar ("Estado del servicio", the Settings options). It closes
// on pressing outside its box (the button itself stays inside: it toggles) or with Esc.
import { useEffect, useRef, useState } from 'react';

export function usePopup(panelId: string) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: Event) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      // With a dialog open, Esc belongs to it (as in `Main`).
      if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
      // Captured and not let through: Esc closes only the panel, not also an open message (`Main`).
      e.preventDefault();
      e.stopPropagation();
      // If focus was inside the panel (which is about to unmount), it returns to the button; pressing outside takes it from no one.
      if (document.getElementById(panelId)?.contains(document.activeElement)) toggle.current?.focus();
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, panelId]);

  return { open, setOpen, box, toggle };
}
