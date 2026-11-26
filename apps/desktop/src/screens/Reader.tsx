// Reader of one message: a full-height column with the bar, the header and the mail. HTML is only painted inside an
// `iframe sandbox=""` after DOMPurify and with its own CSP (contract of `mail::parser`), on always-light paper; text is
// painted by the app (React escapes it) and follows the theme.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../api.ts';
import type { InlineImageView } from '../bindings/InlineImageView.ts';
import type { MessageDetail } from '../bindings/MessageDetail.ts';
import { Aviso } from '../components/Aviso.tsx';
import { Icon } from '../components/Icon.tsx';
import { replyBlockedText, replySubject, replyTarget, type ReplySeed } from '../compose.ts';
import { formatReceived, senderAddress } from '../format.ts';
import { t } from '../i18n/index.ts';
import { useLocale } from '../i18n/locale.ts';
import { citedImages, decodableImages, decodeInBrowser, remoteImagesNote } from '../images.ts';
import { extractTextLinks, type LinkList } from '../links.ts';
import { bodyKind, canToggle, focusTarget, usableText, type BodyKind } from '../reader.ts';
import { senderSeal } from '../seal.ts';
import { cleanToSrcDoc, sanitizeHtml } from '../sanitize.ts';
import { Attachments } from './Attachments.tsx';
import { ErrorAviso } from './common.tsx';
import { DeleteDialog } from './DeleteDialog.tsx';
import { MessageLinks } from './MessageLinks.tsx';
import { useAction } from './useAction.ts';

interface Props {
  id: number;
  /** The flags changed: re-read the inbox. */
  onChanged: () => void;
  /** With two panels it closes with "<- Bandeja de entrada" (back to the list) instead of the cross. */
  backToList: boolean;
  onClose: () => void;
  /** After archiving it, taking it out of the archive or deleting it (focus goes to the row that takes its place, not its own). */
  onGone: (id: number) => void;
  /** Opened from the archive: "Sacar del archivo" instead of "Archivar", and "<- Archivo". */
  archived: boolean;
  /** The mail domain: only a sender of it can be answered (`null` if unknown). */
  domain: string | null;
  /** "Responder": opens the form with the sender and "Re: subject". */
  onReply: (seed: ReplySeed) => void;
}

type Marks = { archived?: boolean; deleted?: boolean };

/** Is anything left to show after sanitising? (visible text or some image) */
function hasVisibleContent(clean: string): boolean {
  if (clean.trim() === '') return false;
  const doc = new DOMParser().parseFromString(clean, 'text/html');
  return (doc.body.textContent ?? '').trim() !== '' || doc.body.querySelector('img') !== null;
}

interface HtmlView {
  srcDoc: string | null;
  links: LinkList;
  /** Remote images the HTML carried (not loaded: only noted). */
  remoteImages: number;
}

/**
 * Clean HTML in `srcdoc` (or `null` if nothing visible remains), its links and how many remote images it carried. `images`
 * are ONLY the inline images already known to decode (`useDecodableImages`), never the core's as they come.
 */
function useHtmlView(html: string | null, images: readonly InlineImageView[]): HtmlView {
  // The sanitiser and the `srcdoc` write texts ("imagen no disponible"...): with another language they must be rebuilt.
  const locale = useLocale();
  return useMemo(() => {
    if (html == null) return NO_HTML;
    const { html: clean, remoteImages, ...links } = sanitizeHtml(html, images);
    return hasVisibleContent(clean) ? { srcDoc: cleanToSrcDoc(clean), links, remoteImages } : NO_HTML;
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- the language is not read inside, but it changes the text produced.
  }, [html, images, locale]);
}

const NO_LINKS: LinkList = { links: [], omitted: 0 };
const NO_HTML: HtmlView = { srcDoc: null, links: NO_LINKS, remoteImages: 0 };
const NO_IMAGES: readonly InlineImageView[] = [];
/** While the message loads (or its images are checked) there is nothing to sanitise or show. */
const NOT_LOADED: Pick<MessageDetail, 'html' | 'text' | 'unreadable'> = { html: null, text: null, unreadable: false };

/**
 * The message's inline images that can be decoded, or `null` while checking. They are checked in the app, before
 * painting: one that does not decode is treated as not delivered ("imagen no disponible"). With no HTML nothing is
 * checked, and only the ones the HTML cites (the rest are not painted); the size limits live in `images.ts`.
 */
function useDecodableImages(html: string | null, inline: readonly InlineImageView[] | null): readonly InlineImageView[] | null {
  const wanted = useMemo(() => (inline === null ? null : html == null ? NO_IMAGES : citedImages(html, inline)), [html, inline]);
  const [checked, setChecked] = useState<{ from: readonly InlineImageView[]; ok: InlineImageView[] } | null>(null);
  useEffect(() => {
    if (wanted === null || wanted.length === 0) return;
    let cancelled = false;
    void decodableImages(wanted, decodeInBrowser).then((ok) => {
      if (!cancelled) setChecked({ from: wanted, ok });
    });
    return () => {
      cancelled = true;
    };
  }, [wanted]);
  if (wanted === null || wanted.length === 0) return wanted;
  return checked?.from === wanted ? checked.ok : null;
}

/** What is seen of the message: the body that applies (`null` while loading), whether it can be toggled and the links of THAT body. */
interface View {
  kind: BodyKind | null;
  toggle: boolean;
  srcDoc: string | null;
  text: string | null;
  links: LinkList;
  /** Blocked remote images of the HTML in view (0 if the text is shown). */
  remoteImages: number;
  /** Inline images actually shown (those that decode, only with the HTML in view): they label "Adjuntos". */
  shownImages: readonly InlineImageView[];
}

function useView(detail: MessageDetail | null, asText: boolean): View {
  const images = useDecodableImages(detail?.html ?? null, detail?.inlineImages ?? null);
  const ready = detail !== null && images !== null;
  const { html, text: rawText, unreadable } = ready ? detail : NOT_LOADED;
  const { srcDoc, links, remoteImages } = useHtmlView(html, images ?? NO_IMAGES);
  const text = usableText(rawText);
  const textLinks = useMemo(() => extractTextLinks(text ?? ''), [text]);
  const state = { unreadable, hasHtml: srcDoc !== null, hasText: text !== null, asText };
  const kind = ready ? bodyKind(state) : null;
  const papel = kind === 'papel';
  const shownImages = papel && images !== null ? images : NO_IMAGES;
  return { kind, toggle: canToggle(state), srcDoc, text, links: papel ? links : textLinks, remoteImages: papel ? remoteImages : 0, shownImages };
}

/** Loads message `id`, marks it read and knows how to archive it, take it out of the archive or delete it. */
function useMessage({ id, onChanged, onGone }: Pick<Props, 'id' | 'onChanged' | 'onGone'>) {
  const [detail, setDetail] = useState<MessageDetail | null>(null);
  // The load failed: the message is not shown, but it can still be archived or deleted (flags do not need the body;
  // otherwise a message that fails to load would stay in the list forever).
  const [failed, setFailed] = useState(false);
  const { error, run } = useAction();
  const marking = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const d = await run(() => api.getMessage(id));
      if (cancelled) return;
      if (!d) {
        setFailed(true);
        return;
      }
      setDetail(d);
      if (!d.summary.isRead) {
        await run(() => api.setFlags(id, { isRead: true }));
        onChanged();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, run, onChanged]);

  async function mark(flags: Marks) {
    // "Archivar" and "Borrar" are not disabled meanwhile (a disabled button loses focus and never recovers it):
    // a second press while the first still runs does nothing.
    if (marking.current) return;
    marking.current = true;
    const ok = await run(async () => {
      await api.setFlags(id, flags);
      return true;
    });
    marking.current = false;
    if (ok) {
      onChanged();
      onGone(id);
    }
  }

  return { detail, failed, error, mark };
}

/**
 * Reader focus. On opening it goes to the reader (Main mounts it with `key={id}`: each message starts from scratch);
 * when the mail arrives it moves to its body, where Page Down and the arrows scroll. Only if it is still in the reader: if
 * meanwhile the user went elsewhere (another row, the menu, a bar button), it is not taken away.
 */
function useReaderFocus(kind: BodyKind | null) {
  const lector = useRef<HTMLElement>(null);
  const body = useRef<HTMLElement | null>(null);
  const setBody = useCallback((element: HTMLElement | null) => {
    body.current = element;
  }, []);

  useEffect(() => {
    lector.current?.focus();
  }, []);
  useEffect(() => {
    if (focusTarget(kind) === 'cuerpo' && document.activeElement === lector.current) body.current?.focus();
  }, [kind]);

  return { lector, setBody };
}

const BUTTON = 'button button-small button-outline-weak nm-btn';
const QUIET = 'button button-small button-ghost-weak nm-btn';

/** "Responder". Only a NightMail sender can be answered: otherwise the button is still there, marked as unavailable
 *  (`aria-disabled`, so it can still be reached with Tab) and it says why (tooltip and description). */
function ReplyButton({ detail, domain, onReply }: { detail: MessageDetail; domain: string | null; onReply: (seed: ReplySeed) => void }) {
  const noteId = useId();
  const target = replyTarget(detail.summary.from, domain);
  const words = t().screensMail.reader;
  const blocked = target.ok === false ? replyBlockedText(target.reason) : null;
  return (
    <>
      <button
        type="button"
        className={BUTTON}
        // Focus returns here if the reply is discarded (`useCompose` in Main.tsx).
        data-nm-responder=""
        aria-disabled={blocked ? true : undefined}
        aria-describedby={blocked ? noteId : undefined}
        title={blocked ?? undefined}
        onClick={() => {
          if (target.ok) onReply({ addrKey: detail.summary.addrKey, to: target.to, subject: replySubject(detail.summary.subject) });
        }}
      >
        {words.reply}
      </button>
      {blocked && (
        <span id={noteId} className="sr-only">
          {blocked}
        </span>
      )}
    </>
  );
}

interface BarProps {
  /** "Responder", once the message has loaded. */
  reply: ReactNode;
  /** Loading has finished (well or with an error): it can be archived (or taken out of the archive) and deleted. */
  loaded: boolean;
  /** From the archive: "Sacar del archivo" and "<- Archivo". */
  archived: boolean;
  toggle: boolean;
  asText: boolean;
  onMark: (flags: Marks) => void;
  /** "Borrar": opens the confirmation (`DeleteDialog`). */
  onDelete: () => void;
  onToggle: () => void;
  backToList: boolean;
  onClose: () => void;
}

/** "<- Bandeja de entrada" or "<- Archivo" (two panels): returns to the list, like "Cerrar". It is seen first in the bar
 *  (CSS `order`), but comes last in the document: so it remains the last Tab stop before the paper and, from
 *  inside the iframe, Shift+Tab and Enter return to the list (Esc does not leave the paper: `nav.ts`, `escapeCloses`). */
function BackToList({ loaded, archived, onClose }: { loaded: boolean; archived: boolean; onClose: () => void }) {
  const words = t().screensMail.reader;
  return (
    <>
      {loaded && <span className="nm-lector__sep" aria-hidden="true" />}
      <button type="button" className={`${QUIET} nm-lector__volver`} title={archived ? words.backToArchive : words.backToInbox} onClick={onClose}>
        <Icon name="arrow-left" className="nm-ic" />
        <span className="sr-only">{words.backPrefix(archived)}</span>
        {archived ? t().mail.inbox.archiveTitle : t().mail.inbox.title}
      </button>
    </>
  );
}

/** Reader bar. "Cerrar" (or "<- Bandeja de entrada") is always there and in the same place, and is the last Tab stop before
 *  the mail; the rest appears when loading finishes. "Borrar" asks first (no trash). */
function Bar({ reply, loaded, archived, toggle, asText, onMark, onDelete, onToggle, backToList, onClose }: BarProps) {
  const words = t().screensMail.reader;
  return (
    <div className={backToList ? 'nm-lector__barra nm-lector__barra--volver' : 'nm-lector__barra'}>
      {reply}
      {loaded && (
        <>
          <button type="button" className={BUTTON} onClick={() => onMark({ archived: !archived })}>
            <Icon name={archived ? 'inbox' : 'archive-box'} className="nm-ic" />
            {archived ? words.unarchive : words.archive}
          </button>
          <button type="button" className={BUTTON} onClick={onDelete}>
            <Icon name="trash" className="nm-ic" />
            {words.delete}
          </button>
        </>
      )}
      <div className="nm-fila">
        {toggle && (
          <button type="button" className={QUIET} onClick={onToggle}>
            <Icon name={asText ? 'code' : 'text-align-left'} className="nm-ic" />
            {asText ? words.viewAsHtml : words.viewAsText}
          </button>
        )}
        {!backToList && (
          <button type="button" className={`${QUIET} button-for-icon`} title={words.close} onClick={onClose}>
            <Icon name="cross" className="nm-ic" />
            <span className="sr-only">{words.close}</span>
          </button>
        )}
      </div>
      {backToList && <BackToList loaded={loaded} archived={archived} onClose={onClose} />}
    </div>
  );
}

/** The sender seal: a quiet line if the sender was checked, a sober notice if it arrived sealed but could not be checked, nothing for SMTP mail. */
function SealNote({ summary }: { summary: MessageDetail['summary'] }) {
  const words = t().screensMail.reader;
  const seal = senderSeal(summary);
  if (seal === 'verified') {
    return (
      <p className="nm-lector__sello">
        <Icon name="checkmark-circle" className="nm-ic" />
        <span>{words.sealVerified}</span>
      </p>
    );
  }
  if (seal === 'unverified') {
    return (
      <div className="nm-lector__aviso">
        <Aviso tone="atencion">
          <p>
            <strong>{words.sealUnverifiedTitle}</strong>
          </p>
          <p>{words.sealUnverified}</p>
        </Aviso>
      </div>
    );
  }
  return null;
}

/** Subject and message details. Addresses go in monospace (rule of `format.ts`: the address is always shown). */
function Header({ detail }: { detail: MessageDetail }) {
  const { from, subject, receivedAt } = detail.summary;
  const words = t().screensMail.reader;
  return (
    <header className="nm-lector__cab">
      <h1 className="nm-lector__asunto">{subject ?? words.noSubject}</h1>
      <dl className="nm-meta">
        <dt>{words.from}</dt>
        <dd>
          <span className="text-monospace">{senderAddress(from)}</span>
        </dd>
        {detail.to.length > 0 && (
          <>
            <dt>{words.to}</dt>
            <dd>
              <span className="text-monospace">{detail.to.join(', ')}</span>
            </dd>
          </>
        )}
        <dt>{words.received}</dt>
        <dd>{formatReceived(receivedAt)}</dd>
      </dl>
      <SealNote summary={detail.summary} />
    </header>
  );
}

/** In `tauri dev` the app's CSP is not applied: only the sanitiser and the `srcdoc` CSP protect. */
function DevNotice() {
  if (!import.meta.env.DEV) return null;
  return (
    <p className="nm-lector__nota">
      <Icon name="info-circle" className="nm-ic" />
      <span>{t().screensMail.reader.devMode}</span>
    </p>
  );
}

/** "N imágenes remotas bloqueadas...": there is no button to load them: the mail never requests anything from the network. */
function RemoteImagesNote({ count }: { count: number }) {
  const note = remoteImagesNote(count);
  if (note === null) return null;
  return (
    <p className="nm-lector__nota">
      <Icon name="info-circle" className="nm-ic" />
      <span>{note}</span>
    </p>
  );
}

/** Notices about the mail: the load, archive or delete error, and "mensaje incompleto". Nothing if there are none. */
function Notices({ error, truncated }: { error: string | null; truncated: boolean }) {
  if (!error && !truncated) return null;
  return (
    <div className="nm-lector__aviso nm-pila nm-pila--s">
      <ErrorAviso message={error} />
      {truncated && (
        <Aviso tone="atencion">
          <p>{t().screensMail.reader.truncated}</p>
        </Aviso>
      )}
    </div>
  );
}

interface BodyProps extends Pick<View, 'kind' | 'srcDoc' | 'text'> {
  /** The scrollable body (the iframe or the text) is pointed here to receive focus. */
  bodyRef: (element: HTMLElement | null) => void;
}

/**
 * The mail. HTML goes in its iframe: `sandbox=""` (no scripts, no same origin, no forms, no new windows and
 * no navigating the window) and only via `srcDoc`, which comes from the sanitiser and carries its CSP in front (`srcdoc.ts`). Do not add
 * `allow-*` or `src`: a test prevents it. Text goes as is (React escapes it).
 */
function Body({ kind, srcDoc, text, bodyRef }: BodyProps) {
  if (kind === 'papel' && srcDoc !== null) {
    return (
      <div className="nm-papel">
        <iframe ref={bodyRef} sandbox="" srcDoc={srcDoc} title={t().screensMail.reader.contentTitle} tabIndex={0} />
      </div>
    );
  }
  if (kind === 'texto') {
    return (
      <pre ref={bodyRef} className="nm-texto" tabIndex={0}>
        {text}
      </pre>
    );
  }
  if (kind === 'ilegible') {
    return (
      <div className="nm-lector__hueco">
        <div className="nm-pila nm-pila--s">
          <p>
            <strong>{t().screensMail.reader.unreadable}</strong>
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="nm-lector__hueco">
      <p>{t().screensMail.reader.noContent}</p>
    </div>
  );
}

export function Reader({ id, onChanged, backToList, onClose, onGone, archived, domain, onReply }: Props) {
  const { detail, failed, error, mark } = useMessage({ id, onChanged, onGone });
  const [asText, setAsText] = useState(false);
  const view = useView(detail, asText);
  const { lector, setBody } = useReaderFocus(view.kind);
  const [confirming, setConfirming] = useState(false);
  // It closes before deleting: focus returns to "Borrar" and, if it succeeds, Main sends it to the neighbouring row.
  const deleteNow = () => {
    setConfirming(false);
    void mark({ deleted: true });
  };

  return (
    <article ref={lector} className="nm-lector" aria-label={t().screensMail.reader.openMessage} tabIndex={-1}>
      <Bar reply={detail && <ReplyButton detail={detail} domain={domain} onReply={onReply} />} loaded={detail !== null || failed} archived={archived} toggle={view.toggle} asText={asText} onMark={mark} onDelete={() => setConfirming(true)} onToggle={() => setAsText((v) => !v)} backToList={backToList} onClose={onClose} />
      {detail && <Header detail={detail} />}
      {detail && view.kind !== 'ilegible' && <DevNotice />}
      <RemoteImagesNote count={view.remoteImages} />
      <Notices error={error} truncated={detail?.truncated ?? false} />
      {/* `kind` is `null` while the images are checked: neither the body nor "sin contenido" yet. */}
      {detail && view.kind !== null && (
        <>
          <Body kind={view.kind} srcDoc={view.srcDoc} text={view.text} bodyRef={setBody} />
          {/* At the foot, folded: the links of the body in view and the attachments. */}
          <MessageLinks key={view.kind} list={view.links} />
          <Attachments attachments={detail.attachments} shownImages={view.shownImages} />
        </>
      )}
      {/* Confirm "Borrar": at the end, so it does not come between the bar and its notices. */}
      {confirming && <DeleteDialog onYes={deleteNow} onNo={() => setConfirming(false)} />}
    </article>
  );
}
