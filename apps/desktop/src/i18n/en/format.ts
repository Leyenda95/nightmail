// English texts of the `format` namespace.
// Same shape as `es/format.ts`: `tsc -b` fails if a key is missing or extra.
import type { Messages } from '../index.ts';
import { plural } from '../locale.ts';

/** "1 and 3", "1, 3, and 5" (serial comma, US English). */
function list(numbers: readonly number[]): string {
  if (numbers.length <= 1) return numbers.join('');
  if (numbers.length === 2) return `${numbers[0]} and ${numbers[1]}`;
  return `${numbers.slice(0, -1).join(', ')}, and ${numbers[numbers.length - 1]}`;
}

export default {
  // format.ts: short dates of the list and the day of addresses (by hand, as in Spanish). US order:
  // "Nov 14", "Nov 14, 2025".
  months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  weekdays: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  yesterday: 'Yesterday',
  dayMonth: (day: number, month: string): string => `${month} ${day}`,
  dayMonthYear: (day: number, month: string, year: number): string => `${month} ${day}, ${year}`,
  // format.ts: figures. "1,234.56".
  thousandsSeparator: ',',
  decimalSeparator: '.',
  rawUnits: (units: string): string => `${units} (units)`,
  percent: (n: number): string => `${n}%`,
  // format.ts: sender.
  unknownSender: '(unknown sender)',
  noAddress: (text: string): string => `(no address) "${text}"`,
  // format.ts: slots, seed phrase and restore.
  slotInCreation: (kind: 'mailbox' | 'alias'): string => `${kind === 'mailbox' ? 'mailbox' : 'alias'} being created`,
  seedWordCount: (n: number, total: number): string => `${n} of ${total} words`,
  recovery: {
    bonos: 'Vouchers',
    addresses: 'Addresses',
    burned: 'Slots no longer usable',
    conflicts: "Data that didn't match",
  },
  // format.ts: attachments.
  inlineShown: 'Image in the message (already shown above)',
  unnamedAttachment: 'Unnamed',
  fileType: 'File',
  textType: 'Text',
  // seedCheck.ts
  invalidWords: (positions: readonly number[]): string =>
    positions.length === 1
      ? `Word ${positions[0]} isn't valid. Correct it and try again.`
      : `Words ${list(positions)} aren't valid. Correct them and try again.`,
  // images.ts
  remoteImages: (n: number): string =>
    `${plural(n, { one: '1 remote image blocked', other: `${n} remote images blocked` }, 'en')}. The sender doesn't know you've opened this message.`,
  // links.ts
  invalidLink: '(invalid link)',
} satisfies Messages['format'];
