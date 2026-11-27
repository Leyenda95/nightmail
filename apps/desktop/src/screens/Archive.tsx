// "Archivo" view: what the core already stores with `archived: true`, with the same list and reader as the inbox. In
// the reader, "Archivar" becomes "Sacar del archivo". It is not filtered by address: the sidebar filters the inbox.
// Navigation (which message is open and where focus goes) is that of `nav.ts`.
import { useCallback, useEffect, useRef } from 'react';
import type { AddressView } from '../bindings/AddressView.ts';
import type { ReplySeed } from '../compose.ts';
import { t } from '../i18n/index.ts';
import { archiveEmptyText, archiveHeading, isCapped } from '../inbox.ts';
import { ARCHIVE_TITLE_ID, openHere, panes, type Nav, type NavAction } from '../nav.ts';
import { classes } from '../pieces.ts';
import { usePrefs, type Layout } from '../prefs.ts';
import { listWidthStyle } from '../resize.ts';
import { Inbox } from './Inbox.tsx';
import { Reader } from './Reader.tsx';
import type { MessageList } from './useMessages.ts';

interface Props {
  nav: Nav;
  layout: Layout;
  hidden: boolean;
  archive: MessageList;
  /** The error of "Sincronizar ahora" (the list button syncs everything, as in the inbox). */
  syncError: string | null;
  syncing: boolean;
  /** The refresh icon turns (shared with the inbox's, `Main.tsx`). */
  spinning: boolean;
  onSync: () => void;
  addresses: AddressView[] | null;
  onNav: (action: NavAction) => void;
  onFlags: () => void;
  /** The mail domain and "Responder", for the reader. */
  domain: string | null;
  onReply: (seed: ReplySeed) => void;
}

export function ArchiveView({ nav, layout, hidden, archive, syncError, syncing, spinning, onSync, addresses, onNav, onFlags, domain, onReply }: Props) {
  const openId = openHere(nav, 'archivo');
  const show = panes({ openId }, layout);
  const { listWidth } = usePrefs();
  const messages = archive.messages;
  // The list as shown: on taking out or deleting the open one, focus goes to the row that takes its place (`nav.ts`, `gone`).
  const shownIds = useRef<number[]>([]);
  useEffect(() => {
    if (messages) shownIds.current = messages.map((m) => m.id);
  }, [messages]);
  const onOpen = useCallback((id: number) => onNav({ type: 'open', id, list: 'archivo' }), [onNav]);
  const onClose = useCallback(() => onNav({ type: 'close' }), [onNav]);
  const onBulkDone = useCallback(
    (removed: number[], ids: number[]) => {
      onFlags();
      onNav({ type: 'removed', removed, ids, list: 'archivo' });
    },
    [onFlags, onNav],
  );
  const onGone = useCallback((id: number) => onNav({ type: 'gone', id, ids: shownIds.current }), [onNav]);
  const some = (messages?.length ?? 0) > 0;
  return (
    <div className={classes('nm-paneles', layout === 'dos' && 'nm-paneles--dos')} style={listWidthStyle(layout === 'tres', listWidth)} hidden={hidden}>
      <Inbox
        messages={messages}
        heading={archiveHeading(messages?.length ?? null)}
        addresses={addresses}
        openId={openId}
        error={syncError ?? archive.error}
        hidden={!show.list}
        syncing={syncing}
        spinning={spinning}
        onSync={onSync}
        onOpen={onOpen}
        resizable={layout === 'tres'}
        scope={String(hidden)}
        archived
        capped={isCapped(messages?.length)}
        onBulkDone={onBulkDone}
        label={t().screensMail.archive.listLabel}
        titleId={ARCHIVE_TITLE_ID}
        empty={archiveEmptyText()}
      />
      {show.reader === 'hueco' && <div className="nm-lector">{some && <p className="nm-lector__hueco">{t().screensMail.screens.pickMessage}</p>}</div>}
      {show.reader === 'mensaje' && openId !== null && (
        <Reader key={openId} id={openId} archived domain={domain} onReply={onReply} backToList={layout === 'dos'} onChanged={onFlags} onClose={onClose} onGone={onGone} />
      )}
    </div>
  );
}
