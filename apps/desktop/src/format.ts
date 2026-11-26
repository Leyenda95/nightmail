// Pure presentation functions.
import type { RecoveryReport } from './bindings/RecoveryReport.ts';
import type { SlotId } from './bindings/SlotId.ts';
import { t } from './i18n/index.ts';
import { currentLocale, LOCALE_TAGS } from './i18n/locale.ts';
import { base64Bytes } from './images.ts';
import { stripHidden } from './links.ts';

/** Does it look like an address? Exactly one `@`, no spaces or `<`/`>`, with something on each side. */
function looksLikeAddress(value: string): boolean {
  return /^[^@\s<>]+@[^@\s<>]+$/.test(value);
}

/**
 * The sender's address. `from` arrives as `Name <address>` or just the address; the address is always shown
 * (a display name can be forged). If there is no well-formed address, "(sin dirección)" is shown in quotes:
 * a bare name is never presented as if it were the address. Only the last `<addr>` counts, and only if it
 * closes the string.
 */
export function senderAddress(from: string | null): string {
  if (from == null || from.trim() === '') return t().format.unknownSender;
  const text = from.trim();
  if (looksLikeAddress(text)) return text;
  if (text.endsWith('>')) {
    const open = text.lastIndexOf('<');
    if (open !== -1) {
      const inner = text.slice(open + 1, -1).trim();
      if (looksLikeAddress(inner)) return inner;
    }
  }
  return t().format.noAddress(text.replaceAll('"', "'"));
}

/** The system time zone, re-read at most every `TIME_ZONE_TTL_MS`: reading it costs ~34 µs (it builds a
 *  formatter), and a 500-row list would ask for it 500 times per paint. A zone change shows up within a minute. */
const TIME_ZONE_TTL_MS = 60_000;
let zoneCache: { zone: string; at: number } | null = null;
function systemTimeZone(now: number): string {
  if (!zoneCache || now - zoneCache.at >= TIME_ZONE_TTL_MS || now < zoneCache.at) {
    zoneCache = { zone: new Intl.DateTimeFormat().resolvedOptions().timeZone, at: now };
  }
  return zoneCache.zone;
}

/** One date formatter per language and time zone, created on first use (never when the module loads) and kept in
 *  `cache`. The key carries the system zone (`systemTimeZone`): if it changes while the app is open, a new
 *  formatter is built rather than using the time of the old zone. Hours are always 24 h: `hourCycle: 'h23'` and
 *  not `hour12: false`, which in en-US can give "24:05". */
function dateFormatter(cache: Map<string, Intl.DateTimeFormat>, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const locale = currentLocale();
  const timeZone = systemTimeZone(Date.now());
  const key = `${locale} ${timeZone}`;
  let formatter = cache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(LOCALE_TAGS[locale], { ...options, timeZone, hourCycle: 'h23' });
    cache.set(key, formatter);
  }
  return formatter;
}

const receivedFormatters = new Map<string, Intl.DateTimeFormat>();

/** Full date and time, with seconds: "20/11/2026, 10:42:00" (es), "11/20/2026, 10:42:00" (en). The same pieces as
 *  `toLocaleString` without options: in Spanish it matches `toLocaleString('es-ES')`. */
export function formatReceived(secs: number): string {
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  };
  return dateFormatter(receivedFormatters, options).format(new Date(secs * 1000));
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Percentage: "115 %" (es, with a space), "115%" (en). */
export function formatPercent(n: number): string {
  return t().format.percent(n);
}

/** NIGHT decimals: 1 NIGHT = 10^6 base units (STAR). */
const NIGHT_DECIMALS = 6;
/** DUST decimals: 1 DUST = 10^15 Specks. The SDK does not export it: it comes from `nightDustRatio` (5·10^9 Specks
 *  per STAR, `LedgerParameters.initialParameters()` of ledger-v9), which is the 5 DUST per NIGHT of the tokenomics. */
const DUST_DECIMALS = 15;
/** DUST decimals shown. The rest changes every second (it is generated continuously). */
const DUST_SHOWN = 2;

/**
 * Amount in base units (decimal, may not fit in a `number`) to "5.000,5 NIGHT" (es), "5,000.5 NIGHT" (en).
 * No trailing zeros; with `shown` < `decimals` extra digits are cut (never rounded up). A string that is not an
 * unsigned integer is shown as is (an amount is never invented). The arithmetic is the same in both languages
 * (strings and `BigInt`): the language only picks the separators. The result is for reading only, nothing
 * converts it back into an amount (amounts always travel in base units).
 */
function formatUnits(units: string, decimals: number, shown: number, symbol: string): string {
  const words = t().format;
  if (!/^\d+$/.test(units)) return words.rawUnits(units);
  const padded = units.padStart(decimals + 1, '0');
  // Always group thousands, 4-digit numbers too (es-ES `toLocaleString` does not group "5000" but does "12.345").
  const whole = BigInt(padded.slice(0, -decimals)).toString().replace(/\B(?=(\d{3})+$)/g, words.thousandsSeparator);
  const fraction = padded.slice(-decimals, padded.length - decimals + shown).replace(/0+$/, '');
  return `${whole}${fraction ? `${words.decimalSeparator}${fraction}` : ''} ${symbol}`;
}

/** NIGHT in base units to "5.000,5 NIGHT", with all its decimals. */
export function formatNight(units: string): string {
  return formatUnits(units, NIGHT_DECIMALS, NIGHT_DECIMALS, 'NIGHT');
}

/** DUST in Specks to "12.345,5 DUST", with at most 2 decimals. */
export function formatDust(specks: string): string {
  return formatUnits(specks, DUST_DECIMALS, DUST_SHOWN, 'DUST');
}

/** A slot that has no name yet, labelled by what it is ("alias en creación"). No number on purpose: "alias 0/3"
 *  and "alias n.º 4" read like a quota or an order the person cannot see. Several slots may say the same, so
 *  nothing may use this label as a key: the key is slotKey. */
export function slotLabel(slot: Pick<SlotId, 'kind'>): string {
  return t().format.slotInCreation(slot.kind);
}

/** Words of a seed phrase (24-word BIP-39). */
const SEED_WORDS = 24;

/** The words of a seed phrase, in order: split on any whitespace, no empties. */
export function seedWords(phrase: string): string[] {
  return phrase.split(/\s+/).filter((w) => w !== '');
}

/** Help under the phrase field when restoring: how many words are typed ("17 de 24 palabras"). */
export function seedWordCount(phrase: string): string {
  return t().format.seedWordCount(seedWords(phrase).length, SEED_WORDS);
}

/** A row of the restore report: what it is and how many. */
export type RecoveryFact = readonly [label: string, count: number];

/**
 * What "Restauración terminada" shows: bonos and addresses always; the slots that are no longer usable and the data
 * that did not match, only if they are not zero (no jargon and no frightening zeros).
 */
export function recoveryFacts(report: Pick<RecoveryReport, 'bonos' | 'addresses' | 'burned' | 'conflicts'>): RecoveryFact[] {
  const words = t().format.recovery;
  const facts: RecoveryFact[] = [
    [words.bonos, report.bonos],
    [words.addresses, report.addresses],
  ];
  if (report.burned !== 0) facts.push([words.burned, report.burned]);
  if (report.conflicts !== 0) facts.push([words.conflicts, report.conflicts]);
  return facts;
}

/** "buzón" or "alias", without the slot number. */
export function slotKindName(slot: Pick<SlotId, 'kind'>): string {
  return t().mail.slotKind(slot.kind);
}

// Months and weekdays are written by hand (in `i18n/*/format.ts`) rather than via `Intl`, so the result does not
// depend on the system's language data (nor on a dot after the month).
const DAY_MS = 86_400_000;

/** Calendar days (local time) from `d` to `now`: 0 today, 1 yesterday, negative if in the future. Rounded because of clock changes. */
function daysBefore(d: Date, now: Date): number {
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  return Math.round((start(now) - start(d)) / DAY_MS);
}

/** Short date of the list: "10:42" today (24 h in both languages), "ayer", "lun" this week, "14 nov" this year,
 *  "14 nov 2025" before (in English "yesterday", "Mon", "Nov 14", "Nov 14, 2025"). A future date (sender's clock
 *  ahead) is given with day and month, never as "ayer". */
export function formatShortDate(secs: number, now: Date = new Date()): string {
  const words = t().format;
  const d = new Date(secs * 1000);
  const days = daysBefore(d, now);
  if (days === 0) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (days === 1) return words.yesterday;
  if (days > 1 && days < 7) return words.weekdays[d.getDay()] ?? '';
  const month = words.months[d.getMonth()] ?? '';
  return d.getFullYear() === now.getFullYear()
    ? words.dayMonth(d.getDate(), month)
    : words.dayMonthYear(d.getDate(), month, d.getFullYear());
}

/** Label for the unnamed attachment that is the inline image already visible in the mail. */
export function inlineShown(): string {
  return t().format.inlineShown;
}
const MAX_NAME = 60;

export type AttachmentIcon = 'file-pdf' | 'file-image' | 'file';

/** What is shown for an attachment: name (or label, `muted`), icon and "PDF · 48,3 KB". */
export interface AttachmentRow {
  name: string;
  muted: boolean;
  icon: AttachmentIcon;
  meta: string;
}

interface AttachmentType {
  label: string;
  icon: AttachmentIcon;
}

// Recognised types, with their extensions. A `Map`: an odd type never touches the prototype.
// A `null` label is a word ("Texto", "Text"): it is read in the language of the moment, not when the module loads.
const KNOWN_TYPES = new Map<string, { label: string | null; icon: AttachmentIcon; exts: readonly string[] }>([
  ['application/pdf', { label: 'PDF', icon: 'file-pdf', exts: ['pdf'] }],
  ['image/png', { label: 'PNG', icon: 'file-image', exts: ['png'] }],
  ['image/jpeg', { label: 'JPEG', icon: 'file-image', exts: ['jpg', 'jpeg', 'jpe'] }],
  ['image/gif', { label: 'GIF', icon: 'file-image', exts: ['gif'] }],
  ['image/webp', { label: 'WebP', icon: 'file-image', exts: ['webp'] }],
  ['text/plain', { label: null, icon: 'file', exts: ['txt', 'text'] }],
]);

/** `type/subtype` in lowercase, without parameters (`; name=...`). */
function mimeEssence(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase();
}

// Invisible marks and fillers that `stripHidden` does not remove (they do not fake the order, but hide letters after
// the extension): CGJ, Hangul and Khmer fillers, variation selectors (Mongolian and supplementary ones too).
// Code point ranges rather than a regex class: some are combining marks (`no-misleading-character-class`).
const INVISIBLE_IN_NAME: [number, number][] = [
  [0x034f, 0x034f],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xffa0, 0xffa0],
  [0xe0100, 0xe01ef],
];
const MAX_SUFFIX = 10;

function isInvisible(char: string): boolean {
  const cp = char.codePointAt(0) ?? 0;
  return INVISIBLE_IN_NAME.some(([from, to]) => cp >= from && cp <= to);
}

/** Clean name: without what falsifies what is seen (bidi, zero width, controls, invisible marks and fillers), only
 *  the last piece of a path, with collapsed spaces and no trailing dots or spaces (`virus.exe.`). `null` if nothing
 *  is left. */
function cleanName(raw: string): string | null {
  const visible = [...stripHidden(raw)].filter((c) => !isInvisible(c)).join('');
  const base = visible.split(/[/\\]/).at(-1) ?? '';
  const name = base.replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  return name === '' ? null : name;
}

/** What follows the last dot (the real extension, whatever it is; also after a leading dot), or `null`. */
function suffixOf(name: string): string | null {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? null : name.slice(dot + 1);
}

/** A long name is shortened IN THE MIDDLE: the extension, which decides how it would open, stays visible. */
function shortenName(name: string): string {
  const chars = [...name];
  if (chars.length <= MAX_NAME) return name;
  const suffix = suffixOf(name);
  const tail = suffix !== null && [...suffix].length <= MAX_SUFFIX ? [...`.${suffix}`] : chars.slice(-8);
  return `${chars.slice(0, MAX_NAME - 1 - tail.length).join('')}…${tail.join('')}`;
}

/** Name of an attachment as shown (written by the sender, so untrusted), or `null` if it has none. The UI uses
 *  `attachmentRows`; this stays exported because the tests exercise the same pieces through it. */
export function attachmentName(raw: string | null): string | null {
  const name = raw == null ? null : cleanName(raw);
  return name === null ? null : shortenName(name);
}

/** The declared type is untrusted: with a dot in the name it only counts if the extension agrees; otherwise the
 *  extension rules (it decides how the system would open it), whatever it is. Without a dot, the declared type, if known. */
function attachmentType(contentType: string, suffix: string | null): AttachmentType {
  const found = KNOWN_TYPES.get(mimeEssence(contentType));
  const known: AttachmentType | undefined = found && { label: found.label ?? t().format.textType, icon: found.icon };
  if (suffix === null) return known ?? { label: t().format.fileType, icon: 'file' };
  if (known && found?.exts.includes(suffix.toLowerCase())) return known;
  const chars = [...suffix.toUpperCase()];
  const label = chars.length > MAX_SUFFIX ? `${chars.slice(0, MAX_SUFFIX - 1).join('')}…` : chars.join('');
  // Never empty: `cleanName` strips trailing dots.
  return { label, icon: 'file' };
}

/** The inline images visible in the mail, to recognise their duplicate attachment (unnamed, same type and size). */
interface ShownImage {
  mime: string;
  data: string;
}

/** Rows of "Attachments". `shown` are the inline images actually visible (each pairs with one attachment). */
export function attachmentRows(
  attachments: readonly { name: string | null; contentType: string; size: number }[],
  shown: readonly ShownImage[],
): AttachmentRow[] {
  const words = t().format;
  const unmatched = shown.map((image) => ({ mime: image.mime, size: base64Bytes(image.data)?.length ?? -1 }));
  return attachments.map(({ name: raw, contentType, size }) => {
    const clean = raw == null ? null : cleanName(raw);
    const type = attachmentType(contentType, clean === null ? null : suffixOf(clean));
    // `formatSize` gives the decimal point; here the language's own goes ("48,3 KB" in Spanish, "48.3 KB" in English).
    const meta = `${type.label} · ${formatSize(size).replace('.', words.decimalSeparator)}`;
    if (clean !== null) return { name: shortenName(clean), muted: false, icon: type.icon, meta };
    const mime = mimeEssence(contentType);
    const i = unmatched.findIndex((image) => image.mime === mime && image.size === size);
    if (i === -1) return { name: words.unnamedAttachment, muted: true, icon: type.icon, meta };
    unmatched.splice(i, 1);
    return { name: words.inlineShown, muted: true, icon: 'file-image', meta };
  });
}

/** A day, in local time and without time of day: "18 nov 2026", "Nov 18, 2026" (the creation date of an address). By
 *  hand, like the list's short date: it does not depend on the system's language data. */
export function formatDay(secs: number): string {
  const words = t().format;
  const d = new Date(secs * 1000);
  return words.dayMonthYear(d.getDate(), words.months[d.getMonth()] ?? '', d.getFullYear());
}

/** "Buzón" or "Alias", as a label. */
export function slotKindTitle(slot: Pick<SlotId, 'kind'>): string {
  const name = slotKindName(slot);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Mail domain, taken from the addresses that exist (they all share one; the UI has no other way to know it). The
 * list runs from oldest to newest and the newest wins (if the domain changed, that is the current one). `null` if
 * none has a name yet: then the field goes without a suffix, never with an invented one.
 */
export function mailDomain(addresses: readonly { display: string }[]): string | null {
  for (const { display } of [...addresses].reverse()) {
    const at = display.lastIndexOf('@');
    if (at > 0 && at < display.length - 1) return display.slice(at + 1);
  }
  return null;
}

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

/** Local date and time without seconds, the same across the app: "19/11/2026, 19:28" (es), "11/19/2026, 19:28" (en). */
export function formatDateTime(secs: number): string {
  const options: Intl.DateTimeFormatOptions = {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  };
  return dateFormatter(dateTimeFormatters, options).format(new Date(secs * 1000));
}
