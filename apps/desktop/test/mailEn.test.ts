// English texts of the list and selection: plurals and word order.
// Each test file runs in its own process: here the language is set to `en` and does not affect the others.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { archiveHeading, cappedNote, listHeading } from '../src/inbox.ts';
import { prefs } from '../src/prefs.ts';
import { bulkFlags, deleteBody, deleteButton, deleteTitle, doneText, selectedText } from '../src/selection.ts';
import { addressesNote, mailDownText, midnightLine, partLine, planName, serverLine, serviceLine, sideAddress } from '../src/sidebar.ts';
import { t } from '../src/i18n/index.ts';
import { copyStatus } from '../src/pieces.ts';

prefs.setLocale('en');

test('en selection: plurals', () => {
  assert.equal(selectedText(1), '1 selected');
  assert.equal(selectedText(12), '12 selected');
  assert.equal(doneText('borrar', 1), '1 message deleted.');
  assert.equal(doneText('borrar', 12), '12 messages deleted.');
  assert.equal(doneText('archivar', 3), '3 messages archived.');
  assert.equal(doneText('sacar', 1), '1 message unarchived.');
  assert.equal(doneText('sacar', 4), '4 messages unarchived.');
  assert.equal(deleteTitle(1), 'Delete this message?');
  assert.equal(deleteTitle(12), 'Delete 12 messages?');
  assert.equal(deleteButton(1), 'Delete message');
  assert.equal(deleteButton(2), 'Delete 2 messages');
  assert.match(deleteBody(1), /^It will no longer/);
  assert.match(deleteBody(3), /^They will no longer/);
  assert.deepEqual(bulkFlags('borrar'), { deleted: true });
});

test('en inbox: headings, archive count and note', () => {
  assert.deepEqual(listHeading(null, 0), { title: 'Inbox', sub: 'all your addresses', mono: false });
  assert.equal(listHeading(null, 3).sub, '3 unread · all your addresses');
  assert.equal(listHeading({ display: 'ana@x.io', slot: { kind: 'mailbox', index: 0 } } as never, 0).sub, '@x.io · mailbox');
  assert.deepEqual(archiveHeading(0), { title: 'Archive', sub: 'No archived messages', mono: false });
  assert.equal(archiveHeading(1).sub, '1 archived message');
  assert.equal(archiveHeading(7).sub, '7 archived messages');
  assert.equal(archiveHeading(null).sub, '');
  assert.equal(cappedNote(), 'Showing the 500 most recent messages.');
});

test('en sidebar: addresses, plan, status words', () => {
  assert.equal(sideAddress({ display: '', slot: { kind: 'alias', index: 0 } } as never).text, 'Unnamed alias');
  assert.equal(sideAddress({ display: '', slot: { kind: 'mailbox', index: 0 } } as never).text, 'Unnamed mailbox');
  assert.equal(addressesNote(0), "You don't have any yet.");
  assert.equal(addressesNote(1), 'Only you know this address is yours.');
  assert.equal(addressesNote(3), 'Only you know these addresses are yours.');
  assert.equal(planName({ bonos: [] } as never), null);
  assert.equal(partLine(true).text, 'responding');
  assert.equal(partLine(false).text, 'not responding');
  assert.equal(partLine(null, true).text, 'checking');
  assert.equal(midnightLine({ state: 'down' } as never, { failed: false, health: null } as never).text, 'down');
  assert.equal(serverLine({ failed: false, health: { mailbox: true, issuer: false, relayer: false } } as never).text, 'partially available');
  assert.equal(serviceLine({ tone: 'ok', text: '' }, { tone: 'ok', text: '' }).text, 'operational');
  assert.ok(mailDownText().length <= 100);
});

test('en: copy status and blocked image text', () => {
  assert.equal(copyStatus('ok'), 'Copied');
  assert.match(copyStatus('fail'), /Ctrl\+C/);
  assert.equal(t().mail.imageUnavailable, 'image not available');
});
