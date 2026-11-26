// "Nuevo mensaje" and "Responder": writing a plain-text mail to a NightMail address and sending it. The rules (what is
// checked before sending, which field each error belongs to, the shortcuts) are those of `compose.ts`.
//
// The draft lives in Main (`ComposeState`): the form stays mounted (hidden) while another view is looked at, and Main
// knows whether discarding must ask. Nothing is checked over the network until "Enviar": the address is checked by
// its form and domain while typing, and the core checks it in the registry when sending.
//
// "Enviar" is not disabled while it works (focus would be lost, and Ctrl+Enter may come from any field): it carries
// `aria-disabled`, the wait icon, and a second press does nothing. The fields become read only meanwhile.
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { api } from '../api.ts';
import type { AddressView } from '../bindings/AddressView.ts';
import type { SentView } from '../bindings/SentView.ts';
import { Aviso } from '../components/Aviso.tsx';
import { Dialogo } from '../components/Dialogo.tsx';
import { Icon } from '../components/Icon.tsx';
import {
  checkDraft,
  composeKey,
  firstFocus,
  firstProblem,
  hasContent,
  limitText,
  mailSize,
  problemText,
  sendErrorField,
  senderAddresses,
  type ComposeField,
  type Draft,
} from '../compose.ts';
import { describeError } from '../errors.ts';
import { formatSize } from '../format.ts';
import { t } from '../i18n/index.ts';
import type { View } from '../nav.ts';
import { classes, describedBy } from '../pieces.ts';
import { errorCode } from '../pending.ts';

/** The message being written: what it holds now (`draft`), what it held on opening (`seed`, to know whether anything
 *  was written), whether it is a reply, and the view it was opened from (where discarding returns). `key` changes
 *  with each new message: the form starts from scratch. */
export interface ComposeState {
  draft: Draft;
  seed: Draft;
  reply: boolean;
  returnTo: View;
  key: number;
}

interface Props {
  state: ComposeState;
  /** Our addresses (`null` until they load). */
  addresses: AddressView[] | null;
  /** The mail domain, to check the recipient (`null` if unknown: only its form is checked). */
  domain: string | null;
  hidden: boolean;
  onChange: (draft: Draft) => void;
  /** `send_mail` answered: the message is stored, sent or not (`status`). */
  onSent: (view: SentView) => void;
  /** Discarded (already confirmed if anything was written). */
  onDiscard: () => void;
  /** With no address to send from: "Ir a Direcciones". */
  onAddresses: () => void;
}

/** A `send_mail` error, stored untranslated (the text follows the language), and the field it belongs to. */
interface Failure {
  error: unknown;
  field: ComposeField | null;
}

/** The help and the error under a field, tied to it with `aria-describedby` (as in `Campo`). */
function Notes({ id, help, error }: { id: string; help?: ReactNode; error: string | null }) {
  return (
    <>
      {help && (
        <span id={`${id}-ayuda`} className="nm-campo__ayuda">
          {help}
        </span>
      )}
      {error && (
        <span id={`${id}-error`} className="nm-campo__error" role="alert">
          <Icon name="exclamation-circle" className="nm-ic" />
          <span>{error}</span>
        </span>
      )}
    </>
  );
}

/** What ties a control to its label and its notes; an error marks it invalid. */
function wiring(id: string, help: boolean, error: string | null) {
  return {
    id,
    'aria-invalid': error ? (true as const) : undefined,
    'aria-describedby': describedBy(help && `${id}-ayuda`, error && `${id}-error`),
  };
}

/** Confirms discarding what was written: on its own ("Descartar", Esc) or to answer another message. Destructive:
 *  "Seguir escribiendo" comes first and receives focus. */
export function DiscardDialog({ replace = false, onYes, onNo }: { replace?: boolean; onYes: () => void; onNo: () => void }) {
  const words = t().screensMail.compose;
  const footer = (
    <>
      <button type="button" className="button button-medium button-solid-weak nm-btn" onClick={onNo}>
        {words.keepWriting}
      </button>
      <button type="button" className="button button-medium button-solid-danger nm-btn" onClick={onYes}>
        {replace ? words.replaceYes : words.discardYes}
      </button>
    </>
  );
  return (
    <Dialogo title={replace ? words.replaceTitle : words.discardTitle} size="s" footer={footer} onClose={onNo} described>
      <p>{replace ? words.replaceText : words.discardText}</p>
    </Dialogo>
  );
}

/** On opening, and on coming back to it, focus goes to the first empty field (a reply: the body). */
function useOpeningFocus(hidden: boolean, draft: Draft, ids: Record<ComposeField, string>) {
  const latest = useRef(draft);
  useEffect(() => {
    latest.current = draft;
  });
  useEffect(() => {
    if (!hidden) document.getElementById(ids[firstFocus(latest.current)])?.focus();
  }, [hidden, ids]);
}

export function Compose({ state, addresses, domain, hidden, onChange, onSent, onDiscard, onAddresses }: Props) {
  const { draft, seed, reply } = state;
  const words = t().screensMail.compose;
  const base = useId();
  const [ids] = useState(() => ({ from: `${base}de`, to: `${base}para`, subject: `${base}asunto`, body: `${base}cuerpo` }));
  const titleId = `${base}titulo`;
  const senders = senderAddresses(addresses ?? []);
  const from = senders.find((a) => a.addrKey === draft.fromKey) ?? null;
  const problems = checkDraft(draft, domain, from?.display ?? null);
  const size = mailSize(draft, from?.display ?? '');
  // A field's problem is shown once it has been left (or after trying to send), and from then on it follows the typing.
  const [touched, setTouched] = useState<Partial<Record<ComposeField, true>>>({});
  const [submitted, setSubmitted] = useState(false);
  const [sending, setSending] = useState(false);
  const sendingNow = useRef(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [asking, setAsking] = useState(false);
  useOpeningFocus(hidden, draft, ids);

  const focusField = useCallback((field: ComposeField) => document.getElementById(ids[field])?.focus(), [ids]);

  function fieldError(field: ComposeField): string | null {
    if (failure?.field === field) return describeError(failure.error);
    const problem = problems[field];
    if (problem === undefined) return null;
    // With no address at all, the notice in place of "De" says it.
    if (field === 'from' && senders.length === 0) return null;
    return submitted || touched[field] ? problemText(problem) : null;
  }

  function change(field: Exclude<ComposeField, 'from'> | 'fromKey', value: string) {
    if (sendingNow.current) return;
    onChange({ ...draft, [field]: value });
    const edited: ComposeField = field === 'fromKey' ? 'from' : field;
    // A refusal about this field no longer applies to what is written now.
    if (failure?.field === edited) setFailure(null);
  }

  const leave = (field: ComposeField) => setTouched((prev) => (prev[field] ? prev : { ...prev, [field]: true }));

  async function send() {
    if (sendingNow.current) return;
    setSubmitted(true);
    const first = firstProblem(problems);
    if (first !== null) {
      focusField(first);
      return;
    }
    sendingNow.current = true;
    setSending(true);
    setFailure(null);
    try {
      const view = await api.sendMail(draft.fromKey, draft.to, draft.subject, draft.body);
      onSent(view);
    } catch (e) {
      const field = sendErrorField(errorCode(e));
      setFailure({ error: e, field });
      if (field !== null) focusField(field);
    } finally {
      sendingNow.current = false;
      setSending(false);
    }
  }

  function cancel() {
    if (sendingNow.current) return;
    if (hasContent(draft, seed)) setAsking(true);
    else onDiscard();
  }

  function onKey(e: KeyboardEvent<HTMLFormElement>) {
    const action = composeKey(e.nativeEvent);
    if (action === null) return;
    e.preventDefault();
    if (action === 'send') void send();
    else cancel();
  }

  const errors = { from: fieldError('from'), to: fieldError('to'), subject: fieldError('subject'), body: fieldError('body') };
  const general = failure !== null && failure.field === null ? describeError(failure.error) : null;
  const toHelp = domain === null ? words.toHelpPlain : words.toHelp(domain);
  const sizeText = words.size(formatSize(size), limitText());

  return (
    <section className="nm-redactar" aria-labelledby={titleId} hidden={hidden}>
      <header className="nm-redactar__cab">
        <h1 id={titleId} className="nm-redactar__titulo">
          {reply ? words.replyTitle : words.newTitle}
        </h1>
      </header>
      <form
        className="nm-redactar__form"
        noValidate
        aria-labelledby={titleId}
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        onKeyDown={onKey}
      >
        {senders.length === 0 ? (
          <div className="nm-campo">
            <span className="nm-campo__label">{words.from}</span>
            <Aviso
              tone="atencion"
              actions={
                <button type="button" className="button button-small button-outline-weak nm-btn" onClick={onAddresses}>
                  {words.goToAddresses}
                </button>
              }
            >
              <p>{words.noAddress}</p>
            </Aviso>
          </div>
        ) : (
          <div className="nm-campo">
            <label className="nm-campo__label" htmlFor={ids.from}>
              {words.from}
            </label>
            <select
              {...wiring(ids.from, false, errors.from)}
              className="field w-full nm-redactar__de"
              value={draft.fromKey}
              aria-disabled={sending || undefined}
              onChange={(e) => change('fromKey', e.target.value)}
            >
              {from === null && <option value={draft.fromKey} />}
              {senders.map((a) => (
                <option key={a.addrKey} value={a.addrKey}>
                  {a.display}
                </option>
              ))}
            </select>
            <Notes id={ids.from} error={errors.from} />
          </div>
        )}
        <div className="nm-campo">
          <label className="nm-campo__label" htmlFor={ids.to}>
            {words.to}
          </label>
          <input
            {...wiring(ids.to, true, errors.to)}
            className="field w-full nm-redactar__para"
            type="text"
            inputMode="email"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={draft.to}
            readOnly={sending}
            onChange={(e) => change('to', e.target.value)}
            onBlur={() => leave('to')}
          />
          <Notes id={ids.to} help={toHelp} error={errors.to} />
        </div>
        <div className="nm-campo">
          <label className="nm-campo__label" htmlFor={ids.subject}>
            {words.subject}
          </label>
          <input
            {...wiring(ids.subject, false, errors.subject)}
            className="field w-full"
            type="text"
            autoComplete="off"
            value={draft.subject}
            readOnly={sending}
            onChange={(e) => change('subject', e.target.value)}
            onBlur={() => leave('subject')}
          />
          <Notes id={ids.subject} error={errors.subject} />
        </div>
        <div className="nm-campo nm-redactar__cuerpo">
          <label className="nm-campo__label" htmlFor={ids.body}>
            {words.body}
          </label>
          <textarea
            {...wiring(ids.body, true, errors.body)}
            className="textarea w-full"
            autoComplete="off"
            value={draft.body}
            readOnly={sending}
            onChange={(e) => change('body', e.target.value)}
            onBlur={() => leave('body')}
          />
          <Notes id={ids.body} help={<span className="nm-num">{sizeText}</span>} error={errors.body} />
        </div>
        {general && (
          <Aviso tone="error">
            <p>{general}</p>
          </Aviso>
        )}
        <div className="nm-redactar__pie">
          <button
            type="submit"
            className={classes('button button-medium button-solid-norm nm-btn', sending && 'nm-btn--espera')}
            aria-disabled={sending || undefined}
            aria-keyshortcuts="Control+Enter Meta+Enter"
          >
            {sending && <Icon name="espera" className="nm-ic" />}
            {sending ? words.sending : words.send}
          </button>
          <button type="button" className="button button-medium button-outline-weak nm-btn" aria-disabled={sending || undefined} aria-keyshortcuts="Escape" onClick={cancel}>
            {words.discard}
          </button>
          <span className="nm-redactar__atajo" aria-hidden="true">
            {words.shortcut}
          </span>
        </div>
        {/* What "Enviar" is doing, for the screen reader (the button's text changes, but is not announced). */}
        <p className="sr-only" role="status">
          {sending ? words.sending : ''}
        </p>
      </form>
      {asking && (
        <DiscardDialog
          onYes={() => {
            setAsking(false);
            onDiscard();
          }}
          onNo={() => setAsking(false)}
        />
      )}
    </section>
  );
}
