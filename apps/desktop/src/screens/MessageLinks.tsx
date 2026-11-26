// The message's links, OUTSIDE the iframe. Opening one: `inspect_link` (the core validates and normalises) then a
// dialog with the URL that will open then `open_link` (validates again and opens exactly that URL in the system
// browser). Nothing here navigates the app window: no anchors with a target and no opening windows.
import { useRef, useState } from 'react';
import { api } from '../api.ts';
import type { LinkInfo } from '../bindings/LinkInfo.ts';
import { Aviso } from '../components/Aviso.tsx';
import { Dialogo } from '../components/Dialogo.tsx';
import { Icon } from '../components/Icon.tsx';
import { t } from '../i18n/index.ts';
import { destinationLabel, splitUrl, textHostMismatch, type LinkList, type MailLink } from '../links.ts';
import { ErrorAviso } from './common.tsx';
import { useAction } from './useAction.ts';

/** Full, selectable URL, with the host highlighted. */
function FullUrl({ info }: { info: LinkInfo }) {
  const parts = splitUrl(info.url, info.host);
  return (
    <code className="nm-copiable">
      {parts === null ? (
        info.url
      ) : (
        <>
          {parts[0]}
          <strong>{parts[1]}</strong>
          {parts[2]}
        </>
      )}
    </code>
  );
}

interface ConfirmProps {
  link: MailLink;
  info: LinkInfo;
  onDone: () => void;
}

/** Confirmation: "Cancelar" comes first and takes focus; "Abrir" is not the bright button (the light does not invite
 *  leaving). If opening fails, the dialog stays open with the URL in view so it can be copied. On closing, focus returns to
 *  "Abrir..." (native `<dialog>`). */
function ConfirmOpen({ link, info, onDone }: ConfirmProps) {
  const { error, run } = useAction();
  const opening = useRef(false);
  const shown = textHostMismatch(link.text, info.host);
  const words = t().screensMail.links;
  async function open() {
    // The button is not disabled (it would lose focus): a second press while the first runs does nothing.
    if (opening.current) return;
    opening.current = true;
    const ok = await run(async () => {
      await api.openLink(info.url);
      return true;
    });
    opening.current = false;
    if (ok) onDone();
  }
  const footer = (
    <>
      <button type="button" className="button button-medium button-solid-weak nm-btn" onClick={onDone}>
        {words.cancel}
      </button>
      <button type="button" className="button button-medium button-outline-weak nm-btn" onClick={open}>
        <Icon name="arrow-out-square" className="nm-ic" />
        {words.openInBrowser}
      </button>
    </>
  );
  return (
    <Dialogo title={words.confirmTitle} footer={footer} onClose={onDone}>
      {/* The host (from the core, ASCII) and the warnings go BEFORE the URL: a long URL cannot hide them. */}
      <p>
        {words.goesTo} <strong className="text-monospace">{info.host}</strong>
      </p>
      {shown !== null && (
        <Aviso tone="atencion">
          <p>
            {words.mismatchStart}<bdi>{shown}</bdi>{words.mismatchEnd(info.host)}
          </p>
        </Aviso>
      )}
      {!info.secure && (
        <Aviso tone="atencion">
          <p>{words.notSecure}</p>
        </Aviso>
      )}
      <FullUrl info={info} />
      <p className="nm-suave">{words.openNote}</p>
      <ErrorAviso message={error} />
    </Dialogo>
  );
}

/** A row: `[n]`, "text" then destination and "Abrir...". If the core rejects it, the reason below; if it accepts,
 *  the confirmation. */
function LinkRow({ link }: { link: MailLink }) {
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const words = t().screensMail.links;
  const { error, run } = useAction();
  const inspecting = useRef(false);
  async function inspect() {
    if (inspecting.current) return;
    inspecting.current = true;
    const checked = await run(() => api.inspectLink(link.href));
    inspecting.current = false;
    if (checked) setInfo(checked);
  }
  // In a text-only mail the "text" is the URL itself: it goes in monospace, like the destination.
  const text = link.text === link.href ? <span className="text-monospace">{link.text}</span> : <bdi>{link.text}</bdi>;
  return (
    <li>
      <span className="nm-enlaces__n">[{link.n}]</span>
      {/* The text is written by the sender: it goes between «» and isolated so it cannot reorder or imitate the destination.
          It may be cut with «…»; the destination is not (it wraps onto several lines if needed). */}
      <span className="nm-enlaces__txt">
        <span className="nm-enlaces__texto">{link.text ? <>{words.quoteOpen}{text}{words.quoteClose}</> : words.noText}</span>
        <span className="nm-enlaces__destino">
          {'→ '}
          <span className="text-monospace">{destinationLabel(link.href)}</span>
        </span>
      </span>
      <button type="button" className="button button-small button-outline-weak nm-btn" onClick={inspect}>
        {words.open}
      </button>
      {error && (
        <div className="nm-enlaces__error">
          <ErrorAviso message={error} />
        </div>
      )}
      {info !== null && <ConfirmOpen link={link} info={info} onDone={() => setInfo(null)} />}
    </li>
  );
}

/** "Enlaces de este mensaje (N)" fold at the foot of the reader; nothing if there are no links. */
export function MessageLinks({ list }: { list: LinkList }) {
  const total = list.links.length + list.omitted;
  if (total === 0) return null;
  return (
    <details className="nm-pliegue">
      <summary>
        <Icon name="link" className="nm-ic" />
        {t().screensMail.links.title(total)}
        <Icon name="chevron-down" className="nm-ic" />
      </summary>
      <div className="nm-pliegue__cuerpo">
        <ul className="nm-enlaces">
          {list.links.map((link) => (
            <LinkRow key={link.n} link={link} />
          ))}
        </ul>
        {list.omitted > 0 && <p className="nm-pista nm-pliegue__nota">{t().screensMail.links.more(list.omitted)}</p>}
      </div>
    </details>
  );
}
