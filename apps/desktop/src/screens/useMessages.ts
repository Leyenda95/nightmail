// The Inbox messages (not archived), of ALL addresses: the sidebar filter is applied here in the app (`inbox.ts`),
// so the list, each address's light and the "Bandeja" counter come from the same read and never contradict each
// other. One local query (SQLite, no network) per sync or flag change.
// The archive is the same read with `archived: true` (`useMessageList`).
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
import type { MessageView } from '../bindings/MessageView.ts';
import { describeError } from '../errors.ts';
import { useAction } from './useAction.ts';

export interface MessageList {
  /** `null` until the first read (no false empty states meanwhile). */
  messages: MessageView[] | null;
  /** The error of the last read. */
  error: string | null;
}

export interface Messages extends MessageList {
  /** The last error, from reading or from "Sincronizar ahora". */
  error: string | null;
  /** Only that of "Sincronizar ahora" (the archive shows it too: it syncs the same thing). */
  syncError: string | null;
  syncing: boolean;
  syncNow: () => void;
}

/** The non-deleted messages of the inbox (`archived: false`) or the archive (`true`). `reloadKey` changes when they
 *  must be re-read (sync, flags). */
export function useMessageList(reloadKey: number, archived: boolean): MessageList {
  const [messages, setMessages] = useState<MessageView[] | null>(null);
  // The read's error, not its text: it is translated on return (with the current language). When the language changes,
  // `App` (the root, with `useLocale()`) repaints everything below without `memo`: this hook runs again and translates it.
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);

  // Without `useAction`: a read already superseded (another cancels it when the key changes) cannot put its error over the
  // new one's good list; neither its result nor its error counts (`cancelled`).
  useEffect(() => {
    let cancelled = false;
    api
      .listMessages({ archived, includeDeleted: false, offset: 0 })
      .then((list) => {
        if (cancelled) return;
        setMessages(list);
        setFailure(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setFailure({ error: e });
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey, archived]);

  return { messages, error: failure === null ? null : describeError(failure.error) };
}

/** The inbox and "Sincronizar ahora". */
export function useMessages(reloadKey: number): Messages {
  const { messages, error: loadError } = useMessageList(reloadKey, false);
  const { busy: syncing, error: syncError, run: sync } = useAction();

  // The button is not disabled while it works (focus would be lost): the guard goes here.
  const syncNow = useCallback(() => {
    if (!syncing) void sync(() => api.syncNow());
  }, [syncing, sync]);

  return { messages, error: syncError ?? loadError, syncError, syncing, syncNow };
}
