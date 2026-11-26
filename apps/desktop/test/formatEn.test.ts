// Dates, figures and plurals in English, and that Spanish does not change when switching between languages.
// Each test file runs in its own process: here the language is set to `en` and does not affect the others.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  attachmentRows,
  formatDateTime,
  formatDay,
  formatDust,
  formatNight,
  formatPercent,
  formatReceived,
  formatShortDate,
  formatSize,
  inlineShown,
  recoveryFacts,
  senderAddress,
  seedWordCount,
  slotKindName,
  slotKindTitle,
  slotLabel,
} from '../src/format.ts';
import type { Locale } from '../src/i18n/locale.ts';
import { remoteImagesNote } from '../src/images.ts';
import { destinationLabel } from '../src/links.ts';
import { prefs } from '../src/prefs.ts';
import { phraseProblem } from '../src/seedCheck.ts';

prefs.setLocale('en');

const secs = (d: Date) => d.getTime() / 1000;
const NOW = new Date(2026, 10, 20, 12, 0);

/** Runs `fn` with another language and returns to English. */
function inLocale<T>(locale: Locale, fn: () => T): T {
  prefs.setLocale(locale);
  try {
    return fn();
  } finally {
    prefs.setLocale('en');
  }
}

test('en formatShortDate: 24 h today, «Yesterday», short weekday, «Nov 14» and «Nov 14, 2025»', () => {
  assert.equal(formatShortDate(secs(new Date(2026, 10, 20, 10, 42)), NOW), '10:42');
  assert.equal(formatShortDate(secs(new Date(2026, 10, 20, 0, 5)), NOW), '00:05');
  assert.equal(formatShortDate(secs(new Date(2026, 10, 20, 23, 59)), new Date(2026, 10, 20, 23, 59, 30)), '23:59');
  assert.equal(formatShortDate(secs(new Date(2026, 10, 19, 23, 59)), NOW), 'Yesterday');
  assert.equal(formatShortDate(secs(new Date(2026, 10, 16, 9, 0)), NOW), 'Mon');
  assert.equal(formatShortDate(secs(new Date(2026, 10, 14, 9, 0)), NOW), 'Sat');
  assert.equal(formatShortDate(secs(new Date(2026, 10, 13, 9, 0)), NOW), 'Nov 13');
  assert.equal(formatShortDate(secs(new Date(2026, 0, 3, 9, 0)), NOW), 'Jan 3');
  assert.equal(formatShortDate(secs(new Date(2025, 10, 20, 9, 0)), NOW), 'Nov 20, 2025');
  // Future: never "yesterday" nor a weekday.
  assert.equal(formatShortDate(secs(new Date(2026, 10, 22, 9, 0)), NOW), 'Nov 22');
  assert.equal(formatShortDate(secs(new Date(2027, 0, 2, 9, 0)), NOW), 'Jan 2, 2027');
});

test('en formatDay: «Nov 18, 2026», in local time', () => {
  assert.equal(formatDay(secs(new Date(2026, 10, 18, 23, 59))), 'Nov 18, 2026');
  assert.equal(formatDay(secs(new Date(2025, 0, 1, 0, 0))), 'Jan 1, 2025');
});

test('en formatDateTime and formatReceived: US order, 24-hour clock, never AM/PM nor «24:»', () => {
  assert.equal(formatDateTime(secs(new Date(2026, 10, 19, 19, 28, 45))), '11/19/2026, 19:28');
  assert.equal(formatDateTime(secs(new Date(2026, 10, 20, 0, 5))), '11/20/2026, 00:05');
  assert.equal(formatReceived(secs(new Date(2026, 10, 19, 19, 28, 45))), '11/19/2026, 19:28:45');
  assert.equal(formatReceived(secs(new Date(2026, 10, 20, 0, 5, 7))), '11/20/2026, 00:05:07');
  for (let h = 0; h < 24; h += 1) {
    const text = formatDateTime(secs(new Date(2026, 5, 1, h, 30)));
    assert.equal(text, `06/01/2026, ${String(h).padStart(2, '0')}:30`);
    assert.doesNotMatch(formatReceived(secs(new Date(2026, 5, 1, h, 30))), /AM|PM|24:/);
  }
});

test('es dates stay exactly as before, also after switching language back and forth', () => {
  const at = secs(new Date(2026, 10, 19, 19, 28, 45));
  const midnight = secs(new Date(2026, 10, 20, 0, 5, 7));
  inLocale('es', () => {
    assert.equal(formatDateTime(at), '19/11/2026, 19:28');
    assert.equal(formatReceived(at), new Date(at * 1000).toLocaleString('es-ES'));
    assert.equal(formatReceived(midnight), new Date(midnight * 1000).toLocaleString('es-ES'));
    assert.equal(formatShortDate(secs(new Date(2026, 10, 19, 9, 0)), NOW), 'ayer');
    assert.equal(formatDay(secs(new Date(2026, 10, 18))), '18 nov 2026');
  });
  assert.equal(formatDateTime(at), '11/19/2026, 19:28');
  inLocale('es', () => assert.equal(formatDateTime(at), '19/11/2026, 19:28'));
});

test('en NIGHT and DUST: «,» for thousands and «.» for decimals, same arithmetic as Spanish', () => {
  assert.equal(formatNight('5000000000'), '5,000 NIGHT');
  assert.equal(formatNight('5000500000'), '5,000.5 NIGHT');
  assert.equal(formatNight('12345500000'), '12,345.5 NIGHT');
  assert.equal(formatNight('1'), '0.000001 NIGHT');
  assert.equal(formatNight('0'), '0 NIGHT');
  assert.equal(formatNight('123456789012345678901234567890'), '123,456,789,012,345,678,901,234.56789 NIGHT');
  assert.equal(formatNight('-5'), '-5 (units)');
  assert.equal(formatDust('12345500000000000000'), '12,345.5 DUST');
  assert.equal(formatDust('1999999999999999'), '1.99 DUST', 'cut, never rounded up');
  assert.equal(formatDust('10000000000000'), '0.01 DUST');
  assert.equal(formatDust('9999999999999'), '0 DUST');
  assert.equal(formatDust('x'), 'x (units)');
  // The same figures in both languages: only the separators change.
  for (const units of ['1', '999', '1000000', '5000500000', '123456789012345678901234567890']) {
    const en = formatNight(units);
    const es = inLocale('es', () => formatNight(units));
    assert.equal(en.replace(/[,.]/g, (c) => (c === ',' ? '.' : ',')), es, units);
  }
});

test('en sizes and percentages', () => {
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(2048), '2.0 KB');
  assert.equal(formatSize(5 * 1024 * 1024), '5.0 MB');
  const att = (name: string | null, contentType: string, size: number) => ({ name, contentType, size });
  assert.equal(attachmentRows([att('a.pdf', 'application/pdf', 49_459)], [])[0]?.meta, 'PDF · 48.3 KB');
  assert.equal(inLocale('es', () => attachmentRows([att('a.pdf', 'application/pdf', 49_459)], [])[0]?.meta), 'PDF · 48,3 KB');
  assert.equal(formatPercent(115), '115%');
  assert.equal(inLocale('es', () => formatPercent(115)), '115 %');
});

test('en attachment labels: unnamed, file, text, inline image', () => {
  const att = (name: string | null, contentType: string, size: number) => ({ name, contentType, size });
  const [a, b, c] = attachmentRows(
    [att(null, 'application/pdf', 10), att(null, 'application/x-foo', 10), att('README', 'text/plain', 10)],
    [],
  );
  assert.deepEqual(a, { name: 'Unnamed', muted: true, icon: 'file-pdf', meta: 'PDF · 10 B' });
  assert.deepEqual(b, { name: 'Unnamed', muted: true, icon: 'file', meta: 'File · 10 B' });
  assert.deepEqual(c, { name: 'README', muted: false, icon: 'file', meta: 'Text · 10 B' });
  assert.equal(inlineShown(), 'Image in the message (already shown above)');
  assert.equal(inLocale('es', inlineShown), 'Imagen del mensaje (ya se ve arriba)');
});

test('en plurals: remote images, invalid words', () => {
  assert.equal(remoteImagesNote(0), null);
  assert.equal(remoteImagesNote(1), "1 remote image blocked. The sender doesn't know you've opened this message.");
  assert.equal(remoteImagesNote(2), "2 remote images blocked. The sender doesn't know you've opened this message.");
  assert.equal(phraseProblem('abandon abilty able'), "Word 2 isn't valid. Correct it and try again.");
  assert.equal(phraseProblem('xx ability yy'), "Words 1 and 3 aren't valid. Correct them and try again.");
  assert.equal(phraseProblem('xx able yy about zz'), "Words 1, 3, and 5 aren't valid. Correct them and try again.");
  assert.equal(phraseProblem('abandon ability able'), null);
});

test('en words: sender, slots, recovery phrase count, recovery report, links', () => {
  assert.equal(senderAddress(null), '(unknown sender)');
  assert.equal(senderAddress('"Ana" <>'), '(no address) "\'Ana\' <>"');
  assert.equal(senderAddress('Ana <ana@x.org>'), 'ana@x.org');
  assert.equal(slotKindName({ kind: 'mailbox' }), 'mailbox');
  assert.equal(slotKindTitle({ kind: 'mailbox' }), 'Mailbox');
  assert.equal(slotKindTitle({ kind: 'alias' }), 'Alias');
  assert.equal(slotLabel({ kind: 'mailbox' }), 'mailbox being created');
  assert.equal(slotLabel({ kind: 'alias' }), 'alias being created');
  assert.equal(seedWordCount('a b c'), '3 of 24 words');
  assert.deepEqual(recoveryFacts({ bonos: 1, addresses: 3, burned: 2, conflicts: 1 }), [
    ['Vouchers', 1],
    ['Addresses', 3],
    ['Slots no longer usable', 2],
    ["Data that didn't match", 1],
  ]);
  assert.equal(destinationLabel('no es url'), '(invalid link)');
  assert.equal(destinationLabel('https://a.example/x'), 'a.example');
});
