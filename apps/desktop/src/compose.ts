// Pure rules of writing a mail (`screens/Compose.tsx`) and of the "Enviados" folder (`screens/Sent.tsx`): the checks
// the core will make, done here first so the form can point at the field without going to the network, the texts of
// each state and the shortcuts. No React, so they can be tested with `node --test`.
//
// The checks repeat those of the core (`src-tauri/src/mail/directory.rs`, `parse_address`, and `mail/e2e.rs`,
// `is_subject`, `is_body` and the length of the whole mail). The core checks again when sending: these only save a
// round trip and say which field to fix.
import type { AddressView } from './bindings/AddressView.ts';
import type { SendError } from './bindings/SendError.ts';
import type { SentFailureView } from './bindings/SentFailureView.ts';
import type { SentStatusView } from './bindings/SentStatusView.ts';
import type { IconName } from '@nightmail/icons';
import { describeError } from './errors.ts';
import { formatDateTime } from './format.ts';
import { t } from './i18n/index.ts';

/** Largest whole mail, signature included (`MAX_MAIL_LENGTH`): the same 25 MiB the server accepts. */
export const MAIL_LIMIT = 25 * 1024 * 1024;
/** What the mail takes besides its four variable fields (`FIXED_LENGTH` in `mail/e2e.rs`). */
export const MAIL_FIXED = 13 + 1 + 16 + 8 + 2 * (32 + 1) + 2 + 4 + 64;
/** Longest subject, in UTF-8 bytes (`MAX_SUBJECT_LENGTH`). */
export const SUBJECT_LIMIT = 1024;
/** Longest local part of an address (`MAX_LOCAL_LENGTH`). */
const LOCAL_LIMIT = 64;

/** The mail being written. `fromKey`: the `addrKey` (hex) of the address it goes from. */
export interface Draft {
  fromKey: string;
  to: string;
  subject: string;
  body: string;
}

export const EMPTY_DRAFT: Draft = { fromKey: '', to: '', subject: '', body: '' };

/** The fields of the form, in the order they are seen (the first one with a problem receives focus). */
export const FIELDS = ['from', 'to', 'subject', 'body'] as const;
export type ComposeField = (typeof FIELDS)[number];

/** A problem of a field: a code of the core (its text is that of `errors.ts`) or the empty recipient. */
export type Problem = SendError['code'] | 'empty';
export type Problems = Partial<Record<ComposeField, Problem>>;

/** `id` of "Nuevo mensaje" in the sidebar: focus returns there when a new message is discarded. */
export const NEW_MESSAGE_ID = 'nm-nuevo-mensaje';

/** Bytes the text takes in UTF-8 (what the core counts), without building it. A lone surrogate counts as the
 *  replacement character it becomes on the way (3 bytes). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** Characters that change how a text looks without being seen (`is_deceptive` in `mail/e2e.rs`): C1 controls, the
 *  bidirectional marks, embeddings, overrides and isolates, and the invisible spaces and operators. ZWNJ and ZWJ
 *  (U+200C, U+200D) are allowed. */
function isDeceptive(c: number): boolean {
  return (
    (c >= 0x80 && c <= 0x9f) ||
    c === 0x61c ||
    c === 0x200b ||
    c === 0x200e ||
    c === 0x200f ||
    (c >= 0x202a && c <= 0x202e) ||
    (c >= 0x2060 && c <= 0x206f) ||
    c === 0xfeff
  );
}

/** The subject is a single line, within its limit and with no hidden characters (`is_subject`). */
export function subjectOk(subject: string): boolean {
  if (utf8Length(subject) > SUBJECT_LIMIT) return false;
  for (let i = 0; i < subject.length; i++) {
    const c = subject.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || c === 0x2028 || c === 0x2029 || isDeceptive(c)) return false;
  }
  return true;
}

/** The body has no hidden characters: tab and line breaks are the only controls, and a byte order mark only as the
 *  very first character (`is_body`). */
export function bodyOk(body: string): boolean {
  const start = body.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (let i = start; i < body.length; i++) {
    const c = body.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f || isDeceptive(c)) return false;
  }
  return true;
}

/** Is `text` an address of `domain`, as the core reads it (`parse_address`)? Surrounding spaces are ignored and capitals
 *  do not matter. Without a known domain (`null`), only the form is checked. */
export function recipientProblem(text: string, domain: string | null): Problem | null {
  const trimmed = text.trim();
  if (trimmed === '') return 'empty';
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed.charCodeAt(i);
    if (c <= 0x20 || c >= 0x7f) return 'recipientInvalid';
  }
  const lower = trimmed.toLowerCase();
  const at = lower.indexOf('@');
  const local = lower.slice(0, at);
  const host = lower.slice(at + 1);
  if (at <= 0 || host === '' || host.includes('@')) return 'recipientInvalid';
  if (domain !== null && host !== domain.toLowerCase()) return 'recipientForeignDomain';
  if (local.length > LOCAL_LIMIT || !/^[a-z0-9._-]+$/.test(local)) return 'recipientInvalid';
  return null;
}

/** The size of the whole mail as the core counts it: the fixed part, both addresses, the subject and the body. */
export function mailSize(draft: Pick<Draft, 'to' | 'subject' | 'body'>, from: string): number {
  return MAIL_FIXED + utf8Length(from) + utf8Length(draft.to.trim().toLowerCase()) + utf8Length(draft.subject) + utf8Length(draft.body);
}

/** "25 MB": the limit, as the size counter says it. */
export const limitText = (): string => `${MAIL_LIMIT / (1024 * 1024)} MB`;

/** What is wrong in each field (nothing if it can be sent). `from`: the address chosen, or `null` if it is not one of
 *  ours that can send. */
export function checkDraft(draft: Draft, domain: string | null, from: string | null): Problems {
  const problems: Problems = {};
  if (from === null) problems.from = 'senderUnavailable';
  const to = recipientProblem(draft.to, domain);
  if (to !== null) problems.to = to;
  if (!subjectOk(draft.subject)) problems.subject = 'subjectInvalid';
  if (mailSize(draft, from ?? '') > MAIL_LIMIT) problems.body = 'messageTooLarge';
  else if (!bodyOk(draft.body)) problems.body = 'bodyInvalid';
  return problems;
}

/** The first field with a problem, in the order they are seen. */
export const firstProblem = (problems: Problems): ComposeField | null => FIELDS.find((f) => problems[f] !== undefined) ?? null;

/** The text of a field's problem, in the current language. */
export function problemText(problem: Problem): string {
  return problem === 'empty' ? t().screensMail.compose.toEmpty : describeError({ code: problem });
}

/** The field an error of `send_mail` belongs to (it is shown under it), or `null`: it goes above the buttons. */
export function sendErrorField(code: string | null): ComposeField | null {
  switch (code) {
    case 'senderUnavailable':
      return 'from';
    case 'recipientInvalid':
    case 'recipientForeignDomain':
    case 'recipientNotFound':
    case 'recipientUnusable':
      return 'to';
    case 'subjectInvalid':
      return 'subject';
    case 'bodyInvalid':
    case 'messageTooLarge':
      return 'body';
    default:
      return null;
  }
}

/** Our addresses that can send: those with a known name (a restored one without it has no address to write). */
export function senderAddresses(addresses: readonly AddressView[]): AddressView[] {
  return addresses.filter((a) => a.display !== '');
}

/** The address a new message goes from: `preferred` (the inbox in view, or the one that received the message being
 *  answered) if it can send, otherwise the first one. Empty if there is none. */
export function pickFrom(addresses: readonly AddressView[], preferred: string | null): string {
  const usable = senderAddresses(addresses);
  if (preferred !== null && usable.some((a) => a.addrKey === preferred)) return preferred;
  return usable[0]?.addrKey ?? '';
}

/** Has anything been written since the form opened (`seed`)? Then discarding asks first. Spaces do not count. */
export function hasContent(draft: Draft, seed: Draft): boolean {
  return draft.to.trim() !== seed.to.trim() || draft.subject.trim() !== seed.subject.trim() || draft.body.trim() !== seed.body.trim();
}

/** The field that receives focus on opening: the first one still empty (a reply already carries "Para" and "Asunto"). */
export function firstFocus(draft: Pick<Draft, 'to' | 'subject'>): ComposeField {
  if (draft.to.trim() === '') return 'to';
  if (draft.subject.trim() === '') return 'subject';
  return 'body';
}

/** What is needed from a key press (a `KeyboardEvent` satisfies it). */
export interface ComposeKey {
  key: string;
  defaultPrevented: boolean;
  isComposing: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/** Ctrl+Enter (Cmd+Enter on a Mac) sends from any field; Esc with no modifiers discards (it asks first if anything was
 *  written). Not while an input method is composing a character, nor if someone else already handled the key. */
export function composeKey(e: ComposeKey): 'send' | 'cancel' | null {
  if (e.defaultPrevented || e.isComposing) return null;
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.altKey) return 'send';
  if (e.key === 'Escape' && !(e.altKey || e.ctrlKey || e.metaKey || e.shiftKey)) return 'cancel';
  return null;
}

/** The address of a received message's sender: that inside `<...>` or the text itself (`null` if there is none). */
export function senderOf(from: string | null): string | null {
  const text = from?.trim() ?? '';
  if (text === '') return null;
  if (text.endsWith('>')) {
    const open = text.lastIndexOf('<');
    if (open !== -1) return text.slice(open + 1, -1).trim() || null;
  }
  return text;
}

/** Can a received message be answered? Only if its sender is a NightMail address (the one the reply goes to, in
 *  lowercase). Otherwise, why not: another service (`external`) or an address that cannot be read (`unknown`). */
export type ReplyTarget = { ok: true; to: string } | { ok: false; reason: 'external' | 'unknown' };

export function replyTarget(from: string | null, domain: string | null): ReplyTarget {
  const address = senderOf(from);
  if (address === null || domain === null) return { ok: false, reason: 'unknown' };
  const problem = recipientProblem(address, domain);
  if (problem === null) return { ok: true, to: address.toLowerCase() };
  return { ok: false, reason: problem === 'recipientForeignDomain' ? 'external' : 'unknown' };
}

/** What "Responder" hands over: the address that received the message (the reply goes from it, if it can still send),
 *  the sender's address and the subject with "Re:". */
export interface ReplySeed {
  addrKey: string;
  to: string;
  subject: string;
}

/** Why "Responder" does not work, in the current language. */
export function replyBlockedText(reason: 'external' | 'unknown'): string {
  const words = t().screensMail.reader;
  return reason === 'external' ? words.replyExternal : words.replyUnknown;
}

/** The subject of a reply: "Re: " in front, never twice ("Re: Re: ..."), with any capitals or spaces before the colon. */
export function replySubject(subject: string | null): string {
  const text = (subject ?? '').trim();
  if (/^re\s*:/i.test(text)) return text;
  return text === '' ? 'Re:' : `Re: ${text}`;
}

// --- "Enviados" ---------------------------------------------------------------------------------------------------

/** The icon of each delivery state (design/icons): in progress, done, not delivered. */
const STATUS_ICON: Record<SentStatusView, IconName> = { queued: 'espera', sent: 'checkmark', failed: 'exclamation-circle' };

export const statusIcon = (status: SentStatusView): IconName => STATUS_ICON[status];

/** The state in words ("En cola", "Enviado", "No enviado"). */
export function statusText(status: SentStatusView): string {
  return t().screensMail.sent.status[status];
}

/** Why a delivery failed, in plain words. A reason this version does not know reads as the generic one. */
export function sentFailureText(failure: SentFailureView | null): string {
  const texts = t().screensMail.sent.failure;
  return failure !== null && Object.hasOwn(texts, failure) ? texts[failure] : texts.failed;
}

/** The reasons that may clear by themselves (the server, the network, the registry, a full mailbox, a pause asked
 *  for): only with them is retrying suggested. Retrying to an address that does not exist or with a mail too large repeats the same. */
const RETRY_HELPS: readonly SentFailureView[] = ['mailboxFull', 'rateLimited', 'network', 'chainUnavailable', 'failed'];

/** Is retrying worth it now? Not if it is already sent, nor while the server asked to wait (`retryAt`). */
export function canRetry(view: { status: SentStatusView; retryAt: number | null }, nowSecs: number): boolean {
  return view.status !== 'sent' && !(view.retryAt !== null && view.retryAt > nowSecs);
}

/** What can be done with a message that did not go out: wait until `retryAt` (the time if it is today, the date
 *  otherwise), retry, or nothing. */
export function sentActionText(view: { status: SentStatusView; failure: SentFailureView | null; retryAt: number | null }, now: Date): string | null {
  const words = t().screensMail.sent;
  if (view.status === 'sent') return null;
  const nowSecs = Math.floor(now.getTime() / 1000);
  if (view.retryAt !== null && view.retryAt > nowSecs) {
    const at = new Date(view.retryAt * 1000);
    const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
    const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    return sameDay ? words.retryAtTime(time) : words.retryAtDate(formatDateTime(view.retryAt));
  }
  if (view.status === 'queued') return words.queuedNote;
  return view.failure !== null && RETRY_HELPS.includes(view.failure) ? words.retryLater : null;
}

/** The subject in the list and the reader: "(sin asunto)" if there is none. */
export function sentSubject(subject: string): string {
  return subject.trim() === '' ? t().screensMail.sent.noSubject : subject;
}

/** Where the app goes after `send_mail` answers: if it went out, back to the list it came from; otherwise to
 *  "Enviados", with the message open (its state says why and offers to retry). */
export function afterSend(status: SentStatusView): 'list' | 'sent' {
  return status === 'sent' ? 'list' : 'sent';
}
