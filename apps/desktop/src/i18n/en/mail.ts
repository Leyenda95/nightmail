// English texts of the `mail` namespace: list and selection.
// Same shape as `es/mail.ts`: `tsc -b` fails if a key is missing or extra.
import type { Messages } from '../index.ts';
import { PAID_PLAN } from '../brand.ts';
import { plural } from '../locale.ts';

const messages = (n: number): string => plural(n, { one: '1 message', other: `${n} messages` }, 'en');

export default {
  // sidebar.ts
  slotKind: (kind: 'mailbox' | 'alias'): string => (kind === 'mailbox' ? 'mailbox' : 'alias'),
  unnamedAddress: (kind: 'mailbox' | 'alias'): string => `Unnamed ${kind === 'mailbox' ? 'mailbox' : 'alias'}`,
  addressesNote: (count: number): string => {
    if (count <= 0) return "You don't have any yet.";
    return plural(
      count,
      { one: 'Only you know this address is yours.', other: 'Only you know these addresses are yours.' },
      'en',
    );
  },
  planFree: 'Free plan',
  planPaid: PAID_PLAN,
  status: {
    noAnswer: 'no response',
    offline: 'no connection',
    checkingDots: 'checking…',
    proofServerMissing: 'proof server missing',
    connected: 'connected',
    starting: 'starting…',
    down: 'down',
    unavailableInBuild: 'not available in this build',
    waiting: '…',
    notChecked: 'not checked',
    notResponding: 'not responding',
    mailNotResponding: 'mail is not responding',
    partlyAvailable: 'partially available',
    checking: 'checking',
    responding: 'responding',
    unavailable: 'unavailable',
    withIssues: 'degraded',
    operational: 'operational',
  },
  serverMail: 'Mail',
  serverIssuer: 'Voucher issuing',
  serverRelayer: 'Address creation',
  mailDown: "There's no connection to the mail server. New messages will arrive once it's restored.",
  // inbox.ts
  inbox: {
    title: 'Inbox',
    allAddresses: 'all your addresses',
    unread: (n: number): string => `${n} unread`,
    archiveTitle: 'Archive',
    archivedCount: (n: number): string =>
      n === 0 ? 'No archived messages' : plural(n, { one: '1 archived message', other: `${n} archived messages` }, 'en'),
    archiveEmpty: 'Anything you archive from the reader is kept here, out of your inbox.',
    cappedNote: (n: number): string => `Showing the ${n} most recent messages.`,
  },
  // selection.ts
  selection: {
    selected: (n: number): string => plural(n, { one: '1 selected', other: `${n} selected` }, 'en'),
    doneDeleted: (n: number): string => `${messages(n)} deleted.`,
    doneArchived: (n: number): string => `${messages(n)} archived.`,
    doneUnarchived: (n: number): string => `${messages(n)} unarchived.`,
    deleteTitle: (n: number): string => (n === 1 ? 'Delete this message?' : `Delete ${messages(n)}?`),
    deleteButton: (n: number): string => (n === 1 ? 'Delete message' : `Delete ${messages(n)}`),
    deleteBody: (n: number): string =>
      n === 1
        ? "It will no longer be shown in the inbox or the archive. This operation can't be undone."
        : "They will no longer be shown in the inbox or the archive. This operation can't be undone.",
  },
  // pieces.ts
  copied: 'Copied',
  copiedSecret: (seconds: number): string => `Copied. It will be cleared from the clipboard in ${seconds} seconds.`,
  copyFailed: "Couldn't copy. Select it and press Ctrl+C.",
  // sanitize.ts
  imageUnavailable: 'image not available',
} satisfies Messages['mail'];
