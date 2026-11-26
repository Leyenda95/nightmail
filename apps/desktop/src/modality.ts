// Keyboard-only focus: the focus ring shows while one moves around the app with the keyboard, never with the mouse.
// `:focus-visible` is not enough: when code moves focus (to the list title after deleting the last message, to the
// reader when opening one, to the button that opened a dialog on closing it, to a drag handle while dragging...)
// WebView2 and WebKitGTK decide on their own whether to show it, and after a click they sometimes do.
// `focus({ focusVisible: false })` is only understood by Firefox. So the app keeps the count itself:
// `<html data-nm-entrada="puntero|teclado">`, and app.css (the keyboard-only focus rule) hides the ring while the
// mouse is in charge. Focus still moves the same (screen readers).
//
// Which key counts as "moving with the keyboard" is decided by `switchesToKeyboard`: Tab always; arrows, Home, End,
// Enter and Space only on a control (over the mail text they only scroll); Esc never (closing with Esc a dialog
// opened with the mouse must not light the ring of the button focus returns to).
//
// The app starts as with the mouse (no ring) until the first moving key. If the browser's `:focus-visible` were left
// to decide, typing the password and pressing Enter would be enough to show the ring on the inbox title, where focus
// goes on open (`useRescueFocus`), as if it had been reached with Tab.
// Limit (the same as the `:focus-visible` polyfill's): if after a click focus is moved by something that presses no
// keys (screen reader, voice control, UIA automation), the ring does not show until the next key.

type Mode = 'puntero' | 'teclado';

/** The minimum of an element needed to know what it is. */
export interface ElementLike {
  readonly tagName: string;
  getAttribute(name: string): string | null;
}

/** What is used from each event (`keydown`, `pointerdown`, `mousedown`, `focusin`, `blur`). */
export interface WatchedEvent {
  readonly timeStamp: number;
  readonly target?: unknown;
  readonly key?: string;
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
}

export type KeyPress = Pick<WatchedEvent, 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'> & { readonly key: string };

type DocEvent = 'keydown' | 'pointerdown' | 'mousedown' | 'focusin';

/** The minimum of `document` (to test without a browser). */
export interface ModalityDocument {
  readonly activeElement: ElementLike | null;
  readonly documentElement: { setAttribute(name: string, value: string): void; removeAttribute(name: string): void };
  addEventListener(type: DocEvent, listener: (e: WatchedEvent) => void, capture: boolean): void;
  removeEventListener(type: DocEvent, listener: (e: WatchedEvent) => void, capture: boolean): void;
}

/** The minimum of `window`: the `blur` that signals focus has entered the mail (iframe). */
export interface ModalityWindow {
  readonly document: ModalityDocument;
  addEventListener(type: 'blur', listener: (e: WatchedEvent) => void, capture: boolean): void;
  removeEventListener(type: 'blur', listener: (e: WatchedEvent) => void, capture: boolean): void;
}

export const INPUT_ATTR = 'data-nm-entrada';

/** Marks what is not a control but is walked with arrows (the message list moves focus to its rows). */
export const ARROWS_ATTR = 'data-nm-flechas';

/** "control": arrows or Enter do something (button, link, checkbox, row, handle...). "otro": it only scrolls or is
 *  typed into (mail text, titles, dialog, text fields). */
export type FocusKind = 'control' | 'otro';

const CONTROL_TAGS = new Set(['BUTTON', 'SELECT', 'SUMMARY']);
const CONTROL_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file']);
const CONTROL_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'switch', 'option', 'tab', 'treeitem', 'row', 'gridcell', 'slider', 'separator',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'listbox', 'grid', 'tree', 'tablist', 'menu', 'menubar', 'radiogroup',
]);

export function focusKind(el: ElementLike | null): FocusKind {
  if (el === null) return 'otro';
  const role = el.getAttribute('role');
  const control =
    CONTROL_TAGS.has(el.tagName) ||
    (el.tagName === 'A' && el.getAttribute('href') !== null) ||
    (el.tagName === 'INPUT' && CONTROL_INPUTS.has(el.getAttribute('type') ?? 'text')) ||
    (role !== null && CONTROL_ROLES.has(role)) ||
    el.getAttribute(ARROWS_ATTR) !== null;
  return control ? 'control' : 'otro';
}

const CONTROL_KEYS = new Set(['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' ']);

/** Does this key, with focus on something of this kind, mean moving around the app with the keyboard? */
export function switchesToKeyboard(press: KeyPress, kind: FocusKind): boolean {
  // A shortcut (Ctrl+C, Alt+Tab...) is not moving with the keyboard. Shift does count (Shift+Tab).
  if (press.ctrlKey || press.altKey || press.metaKey) return false;
  if (press.key === 'Tab') return true;
  return kind === 'control' && CONTROL_KEYS.has(press.key);
}

function asElement(x: unknown): ElementLike | null {
  return typeof x === 'object' && x !== null && 'tagName' in x && 'getAttribute' in x ? (x as ElementLike) : null;
}

/** A focus that reaches the app up to this long after a click belongs to that click. */
const POINTER_GRACE_MS = 100;

/** Watches keyboard and mouse and sets `<html data-nm-entrada>`. Returns how to stop watching. */
export function watchInputModality(win: ModalityWindow = window): () => void {
  const doc = win.document;
  let mode: Mode | null = null;
  let lastPointerAt = Number.NEGATIVE_INFINITY;
  let inFrame = false;
  // Only written on change: a held key sends about 30 `keydown` per second.
  const set = (next: Mode) => {
    if (next === mode) return;
    mode = next;
    doc.documentElement.setAttribute(INPUT_ATTR, next);
  };
  set('puntero');
  const onKey = (e: WatchedEvent) => {
    if (e.key !== undefined && switchesToKeyboard({ ...e, key: e.key }, focusKind(asElement(e.target)))) set('teclado');
  };
  // `mousedown` as well as `pointerdown`, in case some old WebKitGTK sends no pointer events.
  const onPointer = (e: WatchedEvent) => {
    lastPointerAt = e.timeStamp;
    set('puntero');
  };
  // The mail lives in an isolated iframe: what is pressed inside does not reach here. When a click enters it, the app
  // only sees the window lose focus with the iframe as `activeElement` (Chromium sends no `focusin` to the iframe). If
  // focus later returns to the app without a click right before, it was left with Tab.
  const onBlur = () => {
    inFrame = doc.activeElement?.tagName === 'IFRAME';
  };
  const onFocusIn = (e: WatchedEvent) => {
    if (inFrame && e.timeStamp - lastPointerAt > POINTER_GRACE_MS) set('teclado');
    inFrame = false;
  };
  // Captured: it arrives before the gesture moves focus, even if something stops the event further down.
  const docListeners: [DocEvent, (e: WatchedEvent) => void][] = [
    ['keydown', onKey],
    ['pointerdown', onPointer],
    ['mousedown', onPointer],
    ['focusin', onFocusIn],
  ];
  for (const [type, fn] of docListeners) doc.addEventListener(type, fn, true);
  // Not captured: capturing would also deliver the `blur` of every element on the page, not just the window's.
  win.addEventListener('blur', onBlur, false);
  return () => {
    for (const [type, fn] of docListeners) doc.removeEventListener(type, fn, true);
    win.removeEventListener('blur', onBlur, false);
    doc.documentElement.removeAttribute(INPUT_ATTR);
  };
}
