// Pure rules of the reader: what is shown of an open message and where focus goes when mail arrives.
// No React or DOM, so they can be tested with `node --test`; `screens/Reader.tsx` paints them.

/** What fills the reader body: the HTML in its iframe ("papel"), the text, or a notice if there is nothing to read. */
export type BodyKind = 'papel' | 'texto' | 'ilegible' | 'vacio';

export interface BodyState {
  /** The core could not read the message. */
  unreadable: boolean;
  /** There is HTML left to show after sanitising it. */
  hasHtml: boolean;
  /** There is text that is not blank. */
  hasText: boolean;
  /** The user asked for "Ver como texto". */
  asText: boolean;
}

/** The message text, or `null` if missing or blank. */
export function usableText(text: string | null): string | null {
  return text !== null && text.trim() !== '' ? text : null;
}

/** HTML wins; "Ver como texto" only counts if there is text. An unreadable message shows no body. */
export function bodyKind({ unreadable, hasHtml, hasText, asText }: BodyState): BodyKind {
  if (unreadable) return 'ilegible';
  if (hasHtml && !(asText && hasText)) return 'papel';
  return hasText ? 'texto' : 'vacio';
}

/** Are "Ver como texto" / "Ver como HTML" offered? Only if both versions exist. */
export function canToggle({ unreadable, hasHtml, hasText }: BodyState): boolean {
  return !unreadable && hasHtml && hasText;
}

/**
 * Where reader focus goes: with the mail visible, to its body (the iframe or the text), so Page Down and the arrows
 * scroll it; while loading, or with no body, it stays on the reader itself.
 */
export function focusTarget(kind: BodyKind | null): 'cuerpo' | 'lector' {
  return kind === 'papel' || kind === 'texto' ? 'cuerpo' : 'lector';
}
