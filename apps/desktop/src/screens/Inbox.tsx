// Inbox: the message list for all addresses or the one chosen in the sidebar, and what replaces it when empty.
// Data comes from `useMessages`; the rules, from `inbox.ts`.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import illustration from '../../../../design/brand/ilustracion-bandeja-vacia.svg';
import { api } from '../api.ts';
import type { AddressView } from '../bindings/AddressView.ts';
import type { MessageView } from '../bindings/MessageView.ts';
import { Copiable } from '../components/Copiable.tsx';
import { Icon } from '../components/Icon.tsx';
import { formatReceived, formatShortDate, senderAddress } from '../format.ts';
import { t } from '../i18n/index.ts';
import { cappedNote, firstUseSteps, focusOrphaned, recipientText, stepRow, type EmptyState, type ListHeading } from '../inbox.ts';
import { LIST_TITLE_ID } from '../nav.ts';
import { planKind, type PlanKind } from '../payment.ts';
import { classes } from '../pieces.ts';
import { prefs, usePrefs } from '../prefs.ts';
import { clampListWidth, LIST_WIDTH_DEFAULT, LIST_WIDTH_MAX, LIST_WIDTH_MIN, LIST_WIDTH_VAR, listWidthMax, stepListWidth, widthFromPointer } from '../resize.ts';
import { allState, bulkFlags, chosen, clickIntent, doneText, listKeyAction, NONE, select, selectedText, type AllState, type BulkKind, type SelectionAction } from '../selection.ts';
import { senderSeal } from '../seal.ts';
import { ErrorAviso } from './common.tsx';
import { DeleteDialog } from './DeleteDialog.tsx';
import { useAction } from './useAction.ts';
import { useSpin } from './useSpin.ts';

/** On mounting the list or the empty state (one replaces the other), if focus was left on `<body>` because the focused
 *  element unmounted, it goes to the title. If it is elsewhere, it is left alone. */
function useRescueFocus(titleId = LIST_TITLE_ID) {
  useEffect(() => {
    if (focusOrphaned(document.activeElement, document.body)) document.getElementById(titleId)?.focus();
  }, [titleId]);
}

/** Hand-drawn checkbox (the base stylesheet leaves the native one transparent): the native one stays on top, for the click and the
 *  screen reader (checked or "half", `indeterminate`). `onChange` receives whether Shift was held (range). */
function Casilla({ state, label, id, focusable = true, className, onChange, children }: {
  state: AllState;
  label: string;
  id?: string;
  focusable?: boolean;
  className?: string;
  onChange: (shift: boolean) => void;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'some';
  }, [state]);
  return (
    <label className={classes('nm-casilla', className)}>
      <span className={classes('nm-casilla__caja', state !== 'none' && 'nm-casilla__caja--si')}>
        <input
          ref={ref}
          id={id}
          type="checkbox"
          tabIndex={focusable ? undefined : -1}
          checked={state === 'all'}
          aria-label={label}
          onChange={(e) => onChange((e.nativeEvent as MouseEvent).shiftKey === true)}
        />
        {state !== 'none' && <Icon name={state === 'some' ? 'minus' : 'checkmark'} className="nm-ic" />}
      </span>
      {children}
    </label>
  );
}

/** Choosing a row: toggle it or the range from the last one touched. */
type Pick = (id: number, how: 'toggle' | 'range') => void;

interface RowProps {
  m: MessageView;
  /** The message open in the reader: its row is marked and stops looking new. */
  current: boolean;
  /** "-> address that received it"; `null` with the filter on (redundant) or if it belongs to none known. */
  recipient: string | null;
  /** Chosen for a bulk action. */
  selected: boolean;
  onOpen: (id: number) => void;
  onPick: Pick;
}

/** Small mark by the sender: checked sender (lock) or sealed but unchecked (warning). Nothing for SMTP mail. */
function SealMark({ message }: { message: MessageView }) {
  const seal = senderSeal(message);
  if (seal === 'none') return null;
  const words = t().screensMail.reader;
  const label = seal === 'verified' ? words.sealVerifiedShort : words.sealUnverifiedShort;
  return (
    <span className={`nm-msg__sello nm-msg__sello--${seal}`} role="img" aria-label={label} title={label}>
      <Icon name={seal === 'verified' ? 'lock' : 'exclamation-circle'} size={12} className="nm-ic" />
    </span>
  );
}

function Row({ m, current, recipient, selected, onOpen, onPick }: RowProps) {
  const fresh = !m.isRead && !current;
  const words = t().screensMail.inbox;
  const subject = m.subject ?? words.noSubject;
  return (
    <li className="nm-msgs__fila">
      {/* Out of the Tab order (the row is already a stop): with the keyboard, Space on the row. */}
      <Casilla
        state={selected ? 'all' : 'none'}
        label={words.selectRow(subject)}
        focusable={false}
        className="nm-casilla--fila"
        onChange={(shift) => onPick(m.id, shift ? 'range' : 'toggle')}
      />
      <button
        type="button"
        className={classes('nm-msg', fresh && 'nm-msg--nuevo', selected && 'nm-msg--elegido')}
        aria-current={current ? 'true' : undefined}
        data-nm-msg={m.id}
        onClick={(e) => {
          const intent = clickIntent(e);
          if (intent === 'open') onOpen(m.id);
          else onPick(m.id, intent);
        }}
      >
        <span className="nm-msg__de">
          <span>
            {selected && <span className="sr-only">{words.selectedSr}</span>}
            {fresh && <span className="sr-only">{words.unreadSr}</span>}
            <SealMark message={m} />
            {senderAddress(m.from)}
          </span>
          <time className="nm-msg__hora" dateTime={new Date(m.receivedAt * 1000).toISOString()} title={formatReceived(m.receivedAt)}>
            {formatShortDate(m.receivedAt)}
          </time>
        </span>
        <span className="nm-msg__asunto">{subject}</span>
        {m.preview && <span className="nm-msg__resumen">{m.preview}</span>}
        {recipient && (
          <span className="nm-msg__para">
            <Icon name="arrow-right" className="nm-ic" />
            {recipient}
          </span>
        )}
      </button>
    </li>
  );
}

/** Moves focus with the keyboard between rows (`stepRow`): up/down, Home and End, from a row or from the region.
 *  Space on a row chooses or unchooses it (with Shift, the range); Enter still opens it. */
function onRowKey(e: KeyboardEvent<HTMLElement>, ids: readonly number[], onPick: Pick) {
  const from = (e.target as HTMLElement).dataset.nmMsg;
  if (e.key === ' ' && from !== undefined && !(e.altKey || e.ctrlKey || e.metaKey)) {
    // Without this, the row's button would be pressed on releasing Space and would open the message.
    e.preventDefault();
    onPick(Number(from), e.shiftKey ? 'range' : 'toggle');
    return;
  }
  const next = stepRow(ids, from === undefined ? null : Number(from), e.key);
  if (next === null) return;
  e.preventDefault();
  e.currentTarget.querySelector<HTMLElement>(`[data-nm-msg="${next}"]`)?.focus();
}

/** What must be measured when a drag starts or a key is pressed: the panels, the list's left edge,
 *  the px of a `rem` and the maximum for the current width. */
function measure(handle: HTMLElement | null) {
  const list = handle?.parentElement;
  const panes = list?.parentElement;
  if (!list || !panes) return null;
  const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  return { panes, left: list.getBoundingClientRect().left, rootPx, max: listWidthMax(panes.clientWidth, rootPx) };
}

/** Class `<html>` carries while dragging: so the cursor and no-select apply to the whole window, also
 *  outside the panels (sidebar) and over buttons to which the base stylesheet gives its own cursor. */
const DRAGGING = 'nm-arrastrando';

/** Handle on the list's right edge (only with three panels): dragged with the mouse, moved with left/right arrows
 *  (Home and End to the extremes) and with a double click it returns to the default width. While dragging, the width goes
 *  straight to the panels' CSS variable (without repainting React) and is stored on release. */
export function ListResizer() {
  const { listWidth } = usePrefs();
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<NonNullable<ReturnType<typeof measure>> & { width: number }>(null);
  const [live, setLive] = useState<number | null>(null);
  // The real maximum for the current window width (what the screen reader reads in aria-valuemax).
  const [max, setMax] = useState(LIST_WIDTH_MAX);
  useEffect(() => {
    const update = () => setMax(measure(ref.current)?.max ?? LIST_WIDTH_MAX);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  // If the handle disappears mid-drag (e.g. on switching to two panels), the class must not stay set: it would leave the
  // interface unselectable and the HTML mail without a mouse. Nothing is stored: the drag did not finish.
  useEffect(
    () => () => {
      if (drag.current) document.documentElement.classList.remove(DRAGGING);
      drag.current = null;
    },
    [],
  );

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    const m = measure(ref.current);
    if (!m) return;
    // Without this, dragging selects text (and the browser may start dragging the selection).
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
    drag.current = { ...m, width: clampListWidth(listWidth, m.max) };
    document.documentElement.classList.add(DRAGGING);
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d) return;
    d.width = widthFromPointer(e.clientX, d.left, d.rootPx, d.max);
    d.panes.style.setProperty(LIST_WIDTH_VAR, `${d.width}rem`);
    setLive(d.width);
  }

  function onPointerEnd() {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    document.documentElement.classList.remove(DRAGGING);
    setLive(null);
    prefs.setListWidth(d.width);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const max = measure(ref.current)?.max ?? LIST_WIDTH_MAX;
    const next = stepListWidth(Math.min(listWidth, max), e.key, max);
    if (next === null) return;
    e.preventDefault();
    prefs.setListWidth(next);
  }

  return (
    <div
      ref={ref}
      className="nm-tirador"
      role="separator"
      aria-orientation="vertical"
      aria-label={t().screensMail.inbox.resizeLabel}
      aria-valuemin={LIST_WIDTH_MIN}
      aria-valuemax={max}
      aria-valuenow={Math.min(live ?? listWidth, max)}
      tabIndex={0}
      title={t().screensMail.inbox.resizeTitle}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onLostPointerCapture={onPointerEnd}
      onKeyDown={onKeyDown}
      onDoubleClick={() => prefs.setListWidth(LIST_WIDTH_DEFAULT)}
    />
  );
}

interface SyncProps {
  syncing: boolean;
  onSync: () => void;
}

const syncLabel = (syncing: boolean) => (syncing ? t().screensMail.inbox.syncing : t().screensMail.inbox.syncNow);

interface InboxProps extends SyncProps {
  /** The messages shown (already filtered), in order; `null` while they are read. */
  messages: MessageView[] | null;
  heading: ListHeading;
  /** To name the address that received each one; `null` with the filter on (redundant to say). */
  addresses: readonly AddressView[] | null;
  openId: number | null;
  error: string | null;
  hidden: boolean;
  onOpen: (id: number) => void;
  /** The archive uses the same list: its name, the `id` of its title (both stay mounted) and what is said if there
   *  are none. The empty inbox has its own screen (`InboxEmpty`). */
  label?: string;
  titleId?: string;
  empty?: string;
  /** With three panels, the handle to change the list width. */
  resizable?: boolean;
  /** When it changes (another view, another filter), the selection is emptied. */
  scope: string;
  /** The read hit the message cap: there may be older ones not visible (said under the heading). */
  capped?: boolean;
  /** It is the archive: in bulk, "Sacar del archivo" instead of "Archivar". */
  archived?: boolean;
  /** After a successful bulk action: `removed` are no longer in the list; `ids`, the list as it was shown. */
  onBulkDone: (removed: number[], ids: number[]) => void;
}

/** What was done in bulk, without text: the action and to how many. */
interface Done {
  kind: BulkKind;
  n: number;
}

/** The list's selection: emptied when `scope` changes; `picked` are the chosen ones still in `ids`.
 *  `done` is the notice of the last bulk action: it goes away as soon as something is chosen again. */
function useSelection(ids: readonly number[], scope: string) {
  // The selection stores the `scope` it was made in: with another, it counts as empty (no effect to clear it).
  // What was done is stored as data (what and how many): the text is written when painting, in the language of that moment.
  const [state, setState] = useState({ scope, sel: NONE, done: null as Done | null });
  const current = state.scope === scope;
  const sel = current ? state.sel : NONE;
  const dispatch = useCallback(
    (action: SelectionAction) => setState((s) => ({ scope, sel: select(s.scope === scope ? s.sel : NONE, action), done: null })),
    [scope],
  );
  const finish = useCallback((done: Done) => setState({ scope, sel: NONE, done }), [scope]);
  const picked = useMemo(() => chosen(sel, ids), [sel, ids]);
  const onPick = useCallback<Pick>((id, how) => dispatch(how === 'range' ? { type: 'range', id, ids } : { type: 'toggle', id }), [dispatch, ids]);
  return { picked, done: current ? state.done : null, dispatch, finish, onPick };
}

/** Archives, takes out of the archive or deletes the chosen ones at once (`set_flags_many`: all or none). "Borrar"
 *  asks first (`DeleteDialog` with the count). A second press while the first runs does nothing. */
function useBulk(picked: readonly number[], ids: readonly number[], finish: (done: Done) => void, onBulkDone: InboxProps['onBulkDone']) {
  const { error, run } = useAction();
  const working = useRef(false);
  const [confirming, setConfirming] = useState(false);

  async function apply(kind: BulkKind) {
    if (working.current || picked.length === 0) return;
    working.current = true;
    const target = [...picked];
    const shown = [...ids];
    const ok = await run(async () => {
      await api.setFlagsMany(target, bulkFlags(kind));
      return true;
    });
    working.current = false;
    if (!ok) return;
    finish({ kind, n: target.length });
    onBulkDone(target, shown);
  }

  const dialog = confirming ? (
    <DeleteDialog
      count={picked.length}
      // It closes before deleting: focus returns to "Borrar" and, if it succeeds, goes to the next row (`nav.ts`).
      onYes={() => {
        setConfirming(false);
        void apply('borrar');
      }}
      onNo={() => setConfirming(false)}
    />
  ) : null;
  return { error, apply, askDelete: () => setConfirming(true), dialog };
}

interface SelectBarProps {
  picked: readonly number[];
  total: number;
  /** `id` of "Seleccionar todo": focus returns there on cancelling (the button disappears). */
  allId: string;
  archived: boolean;
  onAll: () => void;
  onNone: () => void;
  onArchive: () => void;
  onDelete: () => void;
}

const BAR_BUTTON = 'button button-small button-outline-weak nm-btn';

/** Selection bar, above the rows: "Seleccionar todo" (half if some are chosen) and, with any chosen,
 *  how many and what can be done with them. */
function SelectBar({ picked, total, allId, archived, onAll, onNone, onArchive, onDelete }: SelectBarProps) {
  const words = t().screensMail.inbox;
  const count = picked.length;
  const state = allState(count, total);
  return (
    <div className="nm-lista__acciones">
      <Casilla id={allId} state={state} label={words.selectAll} onChange={() => (state === 'all' ? onNone() : onAll())}>
        <span className={classes('nm-lista__cuenta', count > 0 && 'nm-lista__cuenta--si')}>{count > 0 ? selectedText(count) : words.selectAll}</span>
      </Casilla>
      {count > 0 && (
        <div className="nm-fila nm-lista__botones">
          <button type="button" className={BAR_BUTTON} onClick={onArchive}>
            <Icon name={archived ? 'inbox' : 'archive-box'} className="nm-ic" />
            {archived ? words.unarchive : words.archive}
          </button>
          <button type="button" className={BAR_BUTTON} onClick={onDelete}>
            <Icon name="trash" className="nm-ic" />
            {words.delete}
          </button>
          <button
            type="button"
            className="button button-small button-ghost-weak nm-btn"
            onClick={() => {
              onNone();
              document.getElementById(allId)?.focus();
            }}
          >
            {words.cancelSelection}
          </button>
        </div>
      )}
    </div>
  );
}

export function Inbox({ messages, heading, addresses, openId, error, hidden, syncing, onSync, onOpen, label, titleId = LIST_TITLE_ID, empty, resizable = false, scope, archived = false, capped = false, onBulkDone }: InboxProps) {
  useRescueFocus(titleId);
  const list = useMemo(() => messages ?? [], [messages]);
  const ids = useMemo(() => list.map((m) => m.id), [list]);
  const { picked, done, dispatch, finish, onPick } = useSelection(ids, scope);
  const bulk = useBulk(picked, ids, finish, onBulkDone);
  const pickedSet = useMemo(() => new Set(picked), [picked]);
  const allId = useId();
  const shownError = error ?? bulk.error;
  const spin = useSpin(syncing);

  // Ctrl/Cmd+A and Esc with focus in the list (rows, region or its bar). Not inside a dialog opened from here.
  function onListKey(e: KeyboardEvent<HTMLElement>) {
    if ((e.target as HTMLElement).closest('dialog')) return;
    const action = listKeyAction(e, picked.length, ids.length);
    if (action === null) return;
    e.preventDefault();
    dispatch(action === 'all' ? { type: 'all', ids } : { type: 'none' });
  }

  return (
    <section className="nm-lista" aria-label={label ?? t().screensMail.inbox.listLabel} hidden={hidden} onKeyDown={onListKey}>
      <header className="nm-lista__cab">
        <div className="nm-lista__tit">
          <h1 id={titleId} tabIndex={-1} className={classes('nm-lista__titulo', heading.mono && 'text-monospace')}>
            {heading.title}
          </h1>
          <p className="nm-lista__sub">{heading.sub}</p>
        </div>
        <button
          type="button"
          className="button button-for-icon button-small button-ghost-weak nm-btn"
          title={syncLabel(syncing)}
          onClick={() => {
            spin.kick();
            onSync();
          }}
        >
          <Icon name="arrows-rotate" className={classes('nm-ic', spin.spinning && 'nm-fila__gira keep-motion')} />
          <span className="sr-only">{syncLabel(syncing)}</span>
        </button>
      </header>
      {shownError && (
        <div className="nm-lista__aviso">
          <ErrorAviso message={shownError} />
        </div>
      )}
      {capped && <p className="nm-lista__vacia">{cappedNote()}</p>}
      {empty && messages?.length === 0 && <p className="nm-lista__vacia">{empty}</p>}
      {list.length > 0 && (
        <SelectBar
          picked={picked}
          total={ids.length}
          allId={allId}
          archived={archived}
          onAll={() => dispatch({ type: 'all', ids })}
          onNone={() => dispatch({ type: 'none' })}
          onArchive={() => void bulk.apply(archived ? 'sacar' : 'archivar')}
          onDelete={bulk.askDelete}
        />
      )}
      {/* What was done in bulk, in view until something is chosen again. */}
      {done && picked.length === 0 && (
        <p className="nm-lista__hecho">
          <Icon name="checkmark" className="nm-ic" />
          {doneText(done.kind, done.n)}
        </p>
      )}
      {/* The count and what was done, for the screen reader (the bar and the notice appear and disappear). */}
      <p className="sr-only" role="status">
        {picked.length > 0 ? selectedText(picked.length) : done ? doneText(done.kind, done.n) : ''}
      </p>
      {/* Region with its own scroll: Page Down moves it with focus in it or in a row. */}
      <ul
        className={classes('nm-msgs', picked.length > 0 && 'nm-msgs--eligiendo')}
        tabIndex={list.length > 0 ? 0 : undefined}
        // The arrows send focus to the rows: it counts as a control for the focus ring (modality.ts).
        data-nm-flechas=""
        onKeyDown={(e) => onRowKey(e, ids, onPick)}
        onKeyUp={(e) => {
          // The row's button is pressed on releasing Space: Space belongs to selection (`onRowKey`).
          if (e.key === ' ' && (e.target as HTMLElement).dataset.nmMsg !== undefined) e.preventDefault();
        }}
      >
        {list.map((m) => (
          <Row
            key={m.id}
            m={m}
            current={m.id === openId}
            recipient={addresses && recipientText(m.addrKey, addresses)}
            selected={pickedSet.has(m.id)}
            onOpen={onOpen}
            onPick={onPick}
          />
        ))}
      </ul>
      {resizable && <ListResizer />}
      {bulk.dialog}
    </section>
  );
}

/** The empty inbox's title: what is archived and what is cut by the cap do not count as "aún no ha llegado nada". */
function emptyTitle(state: Extract<EmptyState, { kind: 'vacia' | 'recortada' }>): string {
  const words = t().screensMail.inbox;
  if (state.kind === 'recortada') return words.emptyCappedTitle;
  if (state.archived) return words.emptyArchivedTitle;
  return state.address ? words.emptyAddressTitle : words.emptyTitle;
}

function emptyText(state: Extract<EmptyState, { kind: 'vacia' | 'recortada' }>): string {
  const words = t().screensMail.inbox;
  if (state.kind === 'recortada') return words.emptyCapped(cappedNote());
  return state.archived ? words.emptyArchived : words.emptyText;
}

interface EmptyProps extends SyncProps {
  state: EmptyState;
  error: string | null;
  onPlan: () => void;
  /** "Crear una dirección" on first use: with a plan already chosen, the missing step (the addresses page). */
  onNew: () => void;
  /** Changes when the plan must be re-read on first use (plan bought, sync). */
  planKey: number;
}

/** How long first use waits for the plan before showing "Elegir un plan". */
const FIRST_USE_WAIT_MS = 4000;

/** First use: the two steps and only the button of the one missing (`firstUseSteps`). The plan is read here, as the
 *  sidebar's quota does; if it cannot be read, as if there were none ("Elegir un plan" leads to the page that explains it). */
function FirstUse({ planKey, onPlan, onNew }: { planKey: number; onPlan: () => void; onNew: () => void }) {
  const [plan, setPlan] = useState<PlanKind | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.getPlan().then(
      (p) => !cancelled && setPlan(planKind(p.bonos)),
      () => !cancelled && setPlan('none'),
    );
    // No answer after a while: as if there were none, so a button always shows (a late answer still corrects it).
    const slow = setTimeout(() => setPlan((p) => p ?? 'none'), FIRST_USE_WAIT_MS);
    return () => {
      cancelled = true;
      clearTimeout(slow);
    };
  }, [planKey]);
  const words = t().screensMail.inbox;
  const { planDone, button } = firstUseSteps(plan);
  return (
    <>
      <h1 id={LIST_TITLE_ID} tabIndex={-1} className="nm-vacio__titulo">
        {words.firstTitle}
      </h1>
      <p>{words.firstIntro}</p>
      <ol className="nm-pasos">
        {planDone ? (
          <li className="nm-pasos__hecho">
            <span className="nm-pasos__marca" aria-hidden="true">
              <Icon name="checkmark" className="nm-ic" />
            </span>
            <span>
              <span className="sr-only">{words.stepDone} </span>
              {words.firstStep1}
            </span>
          </li>
        ) : (
          <li>{words.firstStep1}</li>
        )}
        <li>{words.firstStep2}</li>
      </ol>
      {button !== null && (
        <div className="nm-vacio__botones">
          {button === 'plan' ? (
            <button type="button" className="button button-large button-solid-norm nm-btn" onClick={onPlan}>
              {words.choosePlan}
            </button>
          ) : (
            <button type="button" className="button button-large button-solid-norm nm-btn" onClick={onNew}>
              {words.createAddress}
            </button>
          )}
        </div>
      )}
    </>
  );
}

/** Instead of the empty list, full width: first use or the empty inbox. The title carries the `id` of the list's:
 *  if the last message is archived or deleted, focus goes there. */
export function InboxEmpty({ state, error, syncing, onSync, onPlan, onNew, planKey }: EmptyProps) {
  useRescueFocus();
  const words = t().screensMail.inbox;
  const spin = useSpin(syncing);
  return (
    <section className="nm-vacio">
      <div className="nm-vacio__noche">
        <img src={illustration} alt="" />
      </div>
      {state.kind === 'restauracion-pendiente' ? (
        <>
          <h1 id={LIST_TITLE_ID} tabIndex={-1} className="nm-vacio__titulo">
            {words.restoringTitle}
          </h1>
          <p>{words.restoringText}</p>
        </>
      ) : state.kind === 'primer-uso' ? (
        <FirstUse planKey={planKey} onPlan={onPlan} onNew={onNew} />
      ) : (
        <>
          <h1 id={LIST_TITLE_ID} tabIndex={-1} className="nm-vacio__titulo">
            {emptyTitle(state)}
          </h1>
          {/* The title already says "a esta dirección": not repeated. */}
          <p>{emptyText(state)}</p>
          {state.address && <Copiable text={state.address.display} label={words.copyAddress} />}
          <ErrorAviso message={error} />
          <button
            type="button"
            className="button button-medium button-outline-weak nm-btn"
            onClick={() => {
              spin.kick();
              onSync();
            }}
          >
            <Icon name="arrows-rotate" className={classes('nm-ic', spin.spinning && 'nm-fila__gira keep-motion')} />
            {syncLabel(syncing)}
          </button>
        </>
      )}
    </section>
  );
}
