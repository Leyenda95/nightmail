// "Enviados": the messages sent from this device, newest first, and the reader of one. They live only here (the
// server keeps no copy): deleting one deletes it for good. A message that did not go out says why in plain words and
// offers "Reintentar" (the core sends it again with the same identity, so it never arrives twice).
//
// Same layout as the inbox (`nav.ts`, `panes`): with three panels the list and the reader side by side; with two, the
// reader takes the list's place. The ids are those of the sent store, another numbering than the received mail: the
// open one is Main's `sentOpen`, not `nav.openId`.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '../api.ts';
import type { SentDetail } from '../bindings/SentDetail.ts';
import type { SentView } from '../bindings/SentView.ts';
import { Aviso } from '../components/Aviso.tsx';
import { Icon } from '../components/Icon.tsx';
import { canRetry, sentActionText, sentFailureText, sentSubject, statusIcon, statusText } from '../compose.ts';
import { describeError } from '../errors.ts';
import { formatReceived, formatShortDate } from '../format.ts';
import { t } from '../i18n/index.ts';
import { stepRow } from '../inbox.ts';
import { panes, plainEscape, SENT_TITLE_ID } from '../nav.ts';
import { classes } from '../pieces.ts';
import { usePrefs, type Layout } from '../prefs.ts';
import { listWidthStyle } from '../resize.ts';
import { ErrorAviso } from './common.tsx';
import { DeleteDialog } from './DeleteDialog.tsx';
import { ListResizer } from './Inbox.tsx';
import { useAction } from './useAction.ts';
import { useSpin } from './useSpin.ts';

/** The row of message `id` (rows are told apart from the received ones: both lists stay mounted). */
const rowSelector = (id: number) => `[data-nm-enviado="${id}"]`;

interface SentList {
  /** `null` until the first read. */
  messages: SentView[] | null;
  /** How many there are in all (the list brings the newest, up to the core's page). */
  total: number | null;
  error: string | null;
}

/** The sent messages, re-read when `reloadKey` changes. A read already superseded counts for nothing. */
function useSentList(reloadKey: number): SentList {
  const [messages, setMessages] = useState<SentView[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
  useEffect(() => {
    let cancelled = false;
    Promise.all([api.listSent({ offset: 0 }), api.countSent(null)])
      .then(([list, count]) => {
        if (cancelled) return;
        setMessages(list);
        setTotal(count);
        setFailure(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setFailure({ error: e });
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);
  return { messages, total, error: failure === null ? null : describeError(failure.error) };
}

/** The state with its icon and word (never the colour alone). */
function Status({ view, className }: { view: Pick<SentView, 'status'>; className: string }) {
  return (
    <span className={classes(className, `${className}--${view.status}`)}>
      <Icon name={statusIcon(view.status)} className="nm-ic" />
      {statusText(view.status)}
    </span>
  );
}

function Row({ m, current, onOpen }: { m: SentView; current: boolean; onOpen: (id: number) => void }) {
  const words = t().screensMail.sent;
  return (
    <li className="nm-msgs__fila">
      <button type="button" className="nm-msg" aria-current={current ? 'true' : undefined} data-nm-enviado={m.id} onClick={() => onOpen(m.id)}>
        <span className="nm-msg__de">
          <span>
            <span className="sr-only">{words.toSr}</span>
            {m.to}
          </span>
          <time className="nm-msg__hora" dateTime={new Date(m.sentAt * 1000).toISOString()} title={formatReceived(m.sentAt)}>
            {formatShortDate(m.sentAt)}
          </time>
        </span>
        <span className="nm-msg__asunto">{sentSubject(m.subject)}</span>
        <Status view={m} className="nm-msg__estado" />
      </button>
    </li>
  );
}

/** Up and down, Home and End move between rows, from a row or from the list region. */
function onRowKey(e: KeyboardEvent<HTMLElement>, ids: readonly number[]) {
  const from = (e.target as HTMLElement).dataset.nmEnviado;
  const next = stepRow(ids, from === undefined ? null : Number(from), e.key);
  if (next === null) return;
  e.preventDefault();
  e.currentTarget.querySelector<HTMLElement>(rowSelector(next))?.focus();
}

interface ListProps {
  list: SentList;
  openId: number | null;
  hidden: boolean;
  resizable: boolean;
  onOpen: (id: number) => void;
  onRefresh: () => void;
}

function List({ list, openId, hidden, resizable, onOpen, onRefresh }: ListProps) {
  const words = t().screensMail.sent;
  const messages = list.messages ?? [];
  const ids = messages.map((m) => m.id);
  const capped = list.total !== null && list.total > messages.length;
  // Reading the list again is local and instant: the icon makes its minimum turn. It is decoration, not a wait
  // indicator, so it stays still with reduced motion.
  const spin = useSpin();
  return (
    <section className="nm-lista" aria-label={words.listLabel} hidden={hidden}>
      <header className="nm-lista__cab">
        <div className="nm-lista__tit">
          <h1 id={SENT_TITLE_ID} tabIndex={-1} className="nm-lista__titulo">
            {words.title}
          </h1>
          {list.total !== null && <p className="nm-lista__sub">{words.count(list.total)}</p>}
        </div>
        <button
          type="button"
          className="button button-for-icon button-small button-ghost-weak nm-btn"
          title={words.refresh}
          onClick={() => {
            spin.kick();
            onRefresh();
          }}
        >
          <Icon name="arrows-rotate" className={classes('nm-ic', spin.spinning && 'nm-fila__gira')} />
          <span className="sr-only">{words.refresh}</span>
        </button>
      </header>
      {list.error && (
        <div className="nm-lista__aviso">
          <ErrorAviso message={list.error} />
        </div>
      )}
      {capped && <p className="nm-lista__vacia">{words.capped(messages.length)}</p>}
      {list.messages?.length === 0 && <p className="nm-lista__vacia">{words.empty}</p>}
      <ul className="nm-msgs" tabIndex={messages.length > 0 ? 0 : undefined} data-nm-flechas="" onKeyDown={(e) => onRowKey(e, ids)}>
        {messages.map((m) => (
          <Row key={m.id} m={m} current={m.id === openId} onOpen={onOpen} />
        ))}
      </ul>
      {resizable && <ListResizer />}
    </section>
  );
}

/** Loads message `id`; a read already superseded counts for nothing. */
function useSent(id: number) {
  const [detail, setDetail] = useState<SentDetail | null>(null);
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.getSent(id).then(
      (d) => {
        if (cancelled) return;
        setDetail(d);
        setFailure(null);
      },
      (e: unknown) => {
        if (!cancelled) setFailure({ error: e });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id]);
  return { detail, setDetail, loadError: failure === null ? null : describeError(failure.error) };
}

/** Now, in Unix seconds, that moves on by itself when `until` arrives (the time the server asked to wait for): the
 *  "Reintentar" button comes back without anything else happening. */
function useNowUntil(until: number | null): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (until === null) return undefined;
    const wait = until * 1000 - Date.now();
    if (wait <= 0) return undefined;
    const timer = setTimeout(() => setNow(Math.floor(Date.now() / 1000)), wait + 500);
    return () => clearTimeout(timer);
  }, [until]);
  return now;
}

interface ReaderProps {
  id: number;
  /** With two panels it closes with "<- Enviados" (back to the list) instead of the cross. */
  backToList: boolean;
  onClose: () => void;
  /** Its state changed (retried) or it was deleted: re-read the list. */
  onChanged: () => void;
  onDeleted: () => void;
}

/** What did not go out: why, what can be done and "Reintentar". After a retry that went out, "Mensaje enviado.". */
function Delivery({ view, retried, busy, onRetry }: { view: SentView; retried: boolean; busy: boolean; onRetry: () => void }) {
  const words = t().screensMail.sent;
  const now = useNowUntil(view.retryAt);
  const [hideRetried, setHideRetried] = useState(false);
  if (view.status === 'sent') {
    return retried && !hideRetried ? (
      <Aviso tone="exito" autoHide={() => setHideRetried(true)}>
        <p>{words.retried}</p>
      </Aviso>
    ) : null;
  }
  const action = sentActionText(view, new Date(now * 1000));
  const ready = canRetry(view, now);
  const button = (
    <button
      type="button"
      className="button button-small button-outline-weak nm-btn"
      aria-disabled={!ready || busy || undefined}
      aria-busy={busy || undefined}
      onClick={() => ready && onRetry()}
    >
      <Icon name={busy ? 'espera' : 'arrows-rotate'} className="nm-ic" />
      {busy ? words.retrying : words.retry}
    </button>
  );
  return (
    <Aviso tone={view.status === 'failed' ? 'error' : 'info'} actions={button}>
      {view.status === 'failed' && <p>{sentFailureText(view.failure)}</p>}
      {action && <p>{action}</p>}
    </Aviso>
  );
}

function SentReader({ id, backToList, onClose, onChanged, onDeleted }: ReaderProps) {
  const words = t().screensMail.sent;
  const { detail, setDetail, loadError } = useSent(id);
  const { busy, error, run } = useAction();
  const working = useRef(false);
  const [retried, setRetried] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const lector = useRef<HTMLElement>(null);
  useEffect(() => {
    lector.current?.focus();
  }, []);

  async function act<T>(fn: () => Promise<T>): Promise<T | undefined> {
    // The buttons are not disabled meanwhile (focus would be lost): a second press does nothing.
    if (working.current) return undefined;
    working.current = true;
    try {
      return await run(fn);
    } finally {
      working.current = false;
    }
  }

  async function retry() {
    const view = await act(() => api.retrySent(id));
    if (!view) return;
    setDetail((d) => (d ? { ...d, summary: view } : d));
    setRetried(view.status === 'sent');
    onChanged();
  }

  async function remove() {
    setConfirming(false);
    const ok = await act(async () => {
      await api.deleteSent(id);
      return true;
    });
    if (ok) onDeleted();
  }

  const summary = detail?.summary ?? null;
  const loaded = detail !== null || loadError !== null;
  return (
    <article ref={lector} className="nm-lector" aria-label={words.readerLabel} tabIndex={-1}>
      <div className={backToList ? 'nm-lector__barra nm-lector__barra--volver' : 'nm-lector__barra'}>
        {loaded && (
          <button type="button" className="button button-small button-outline-weak nm-btn" onClick={() => setConfirming(true)}>
            <Icon name="trash" className="nm-ic" />
            {words.delete}
          </button>
        )}
        {!backToList && (
          <button type="button" className="button button-small button-ghost-weak nm-btn button-for-icon" title={words.close} onClick={onClose}>
            <Icon name="cross" className="nm-ic" />
            <span className="sr-only">{words.close}</span>
          </button>
        )}
        {backToList && (
          <>
            {loaded && <span className="nm-lector__sep" aria-hidden="true" />}
            <button type="button" className="button button-small button-ghost-weak nm-btn nm-lector__volver" title={words.backTo} aria-label={words.backTo} onClick={onClose}>
              <Icon name="arrow-left" className="nm-ic" />
              {words.title}
            </button>
          </>
        )}
      </div>
      {summary && (
        <header className="nm-lector__cab">
          <h1 className="nm-lector__asunto">{sentSubject(summary.subject)}</h1>
          <dl className="nm-meta">
            <dt>{words.from}</dt>
            <dd>
              <span className="text-monospace">{summary.from}</span>
            </dd>
            <dt>{words.to}</dt>
            <dd>
              <span className="text-monospace">{summary.to}</span>
            </dd>
            <dt>{words.date}</dt>
            <dd>{formatReceived(summary.sentAt)}</dd>
            <dt>{words.state}</dt>
            <dd>
              <Status view={summary} className="nm-envio" />
            </dd>
          </dl>
        </header>
      )}
      {(summary !== null || error || loadError) && (
        <div className="nm-lector__aviso nm-pila nm-pila--s">
          <ErrorAviso message={error ?? loadError} />
          {summary && <Delivery view={summary} retried={retried} busy={busy} onRetry={() => void retry()} />}
        </div>
      )}
      {detail &&
        (detail.body.trim() === '' ? (
          <div className="nm-lector__hueco">
            <p>{words.noBody}</p>
          </div>
        ) : (
          <pre className="nm-texto" tabIndex={0}>
            {detail.body}
          </pre>
        ))}
      {confirming && (
        <DeleteDialog words={{ title: words.deleteTitle, text: words.deleteText, button: words.delete }} onYes={() => void remove()} onNo={() => setConfirming(false)} />
      )}
    </article>
  );
}

interface Props {
  layout: Layout;
  hidden: boolean;
  /** Changes when the list must be re-read (a message sent, a sync). */
  reloadKey: number;
  /** The message open in the reader (Main's: sending one that did not go out opens it here). */
  openId: number | null;
  onOpen: (id: number | null) => void;
}

export function SentFolder({ layout, hidden, reloadKey, openId, onOpen }: Props) {
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const list = useSentList(reloadKey + tick);
  const { listWidth } = usePrefs();
  const show = panes({ openId }, layout);
  const some = (list.messages?.length ?? 0) > 0;

  // On closing, focus returns to the message's row; after deleting it, to the one that takes its place (or the title).
  const focusAfter = useRef<string | null>(null);
  useEffect(() => {
    const selector = focusAfter.current;
    if (selector === null) return;
    focusAfter.current = null;
    document.querySelector<HTMLElement>(selector)?.focus();
  });
  const close = useCallback(() => {
    if (openId !== null) focusAfter.current = rowSelector(openId);
    onOpen(null);
  }, [openId, onOpen]);
  const deleted = useCallback(() => {
    const ids = list.messages?.map((m) => m.id) ?? [];
    const at = openId === null ? -1 : ids.indexOf(openId);
    const next = at === -1 ? null : (ids[at + 1] ?? ids[at - 1] ?? null);
    focusAfter.current = next === null ? `#${SENT_TITLE_ID}` : rowSelector(next);
    onOpen(null);
    reload();
  }, [list.messages, openId, onOpen, reload]);

  // Esc closes the open message, as in the inbox (not inside a dialog: there it cancels).
  useEffect(() => {
    if (hidden || openId === null) return undefined;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!plainEscape(e) || document.querySelector('dialog[open]') !== null) return;
      e.preventDefault();
      close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [hidden, openId, close]);

  return (
    <div className={classes('nm-paneles', layout === 'dos' && 'nm-paneles--dos')} style={listWidthStyle(layout === 'tres', listWidth)} hidden={hidden}>
      <List list={list} openId={openId} hidden={!show.list} resizable={layout === 'tres'} onOpen={onOpen} onRefresh={reload} />
      {show.reader === 'hueco' && <div className="nm-lector">{some && <p className="nm-lector__hueco">{t().screensMail.screens.pickMessage}</p>}</div>}
      {show.reader === 'mensaje' && openId !== null && (
        <SentReader key={openId} id={openId} backToList={layout === 'dos'} onClose={close} onChanged={reload} onDeleted={deleted} />
      )}
    </div>
  );
}
