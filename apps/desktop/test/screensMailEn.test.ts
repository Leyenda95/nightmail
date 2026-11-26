// Texts of the mail screens: both languages say the same and the part with data works.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DICTIONARIES } from '../src/i18n/index.ts';
import { cappedNote } from '../src/inbox.ts';
import { prefs } from '../src/prefs.ts';

const en = DICTIONARIES.en.screensMail;
const es = DICTIONARIES.es.screensMail;

test('en screensMail: texts with data', () => {
  assert.equal(en.inbox.selectRow('Hi'), 'Select: Hi');
  assert.equal(en.attachments.title(2), 'Attachments (2)');
  assert.equal(en.links.title(3), 'Links in this message (3)');
  assert.equal(en.links.more(4), '4 more not shown.');
  assert.equal(en.links.mismatchStart + 'a.com' + en.links.mismatchEnd('b.com'), 'The link text says “a.com”, but it actually goes to “b.com”.');
  assert.equal(en.sidebar.unreadSr(5), ', 5 unread');
  assert.equal(en.reader.backPrefix(true) + 'Archive', 'Back to Archive');
});

test('en screensMail: the capped inbox joins the note with its sentence', () => {
  try {
    prefs.setLocale('en');
    assert.equal(en.inbox.emptyCapped(cappedNote()), 'Showing the 500 most recent messages. There may be older mail for this address.');
    prefs.setLocale('es');
    assert.equal(es.inbox.emptyCapped(cappedNote()), 'Se ven los 500 mensajes más recientes. Puede haber correo de esta dirección más antiguo.');
  } finally {
    prefs.setLocale('es');
  }
});

test('es screensMail: the usual Spanish', () => {
  assert.equal(es.links.mismatchStart + 'a.com' + es.links.mismatchEnd('b.com'), 'El texto del enlace dice «a.com», pero en realidad lleva a «b.com».');
  assert.equal(es.reader.backPrefix(true), 'Volver al ');
  assert.equal(es.reader.backPrefix(false), 'Volver a la ');
  assert.equal(es.attachments.title(2), 'Adjuntos (2)');
  assert.equal(es.sidebar.unreadSr(5), ', 5 sin leer');
});
