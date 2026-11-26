// Writing and sending mail, and "Enviados": the checks before sending, the texts of each error and state in both
// languages, "Re:", the shortcuts and where the app goes after sending. `node --test test/*.test.ts`.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { AddressView } from '../src/bindings/AddressView.ts';
import {
  afterSend,
  bodyOk,
  canRetry,
  checkDraft,
  composeKey,
  EMPTY_DRAFT,
  firstFocus,
  firstProblem,
  hasContent,
  limitText,
  MAIL_FIXED,
  MAIL_LIMIT,
  mailSize,
  pickFrom,
  problemText,
  recipientProblem,
  replyBlockedText,
  replySubject,
  replyTarget,
  sendErrorField,
  senderOf,
  sentActionText,
  sentFailureText,
  sentSubject,
  statusIcon,
  statusText,
  subjectOk,
  utf8Length,
  type ComposeKey,
} from '../src/compose.ts';
import { describeError } from '../src/errors.ts';
import { DICTIONARIES } from '../src/i18n/index.ts';
import { prefs } from '../src/prefs.ts';

const DOMAIN = 'nightmail.local';

test('the recipient is checked like the core does: form first, then the domain, then the name', () => {
  assert.equal(recipientProblem('ana@nightmail.local', DOMAIN), null);
  assert.equal(recipientProblem('  Ana.Perez_1-x@NightMail.Local  ', DOMAIN), null);
  assert.equal(recipientProblem('', DOMAIN), 'empty');
  assert.equal(recipientProblem('   ', DOMAIN), 'empty');
  for (const bad of ['ana', 'ana@', '@nightmail.local', 'a@b@nightmail.local', 'ana pérez@nightmail.local', 'añá@nightmail.local', 'ana+x@nightmail.local']) {
    assert.equal(recipientProblem(bad, DOMAIN), 'recipientInvalid', bad);
  }
  assert.equal(recipientProblem(`${'a'.repeat(64)}@nightmail.local`, DOMAIN), null);
  assert.equal(recipientProblem(`${'a'.repeat(65)}@nightmail.local`, DOMAIN), 'recipientInvalid');
  // Another domain is said as such, also when the name would not be valid either (the core checks the domain first).
  assert.equal(recipientProblem('ana@gmail.com', DOMAIN), 'recipientForeignDomain');
  assert.equal(recipientProblem('ana+x@gmail.com', DOMAIN), 'recipientForeignDomain');
  // Without a known domain, only the form.
  assert.equal(recipientProblem('ana@gmail.com', null), null);
});

test('subject and body: hidden characters and the limits of the core', () => {
  assert.ok(subjectOk('Hola, ¿qué tal? 👋'));
  assert.ok(subjectOk('a'.repeat(1024)));
  assert.ok(!subjectOk('a'.repeat(1025)));
  assert.ok(!subjectOk('ñ'.repeat(513)), 'counted in UTF-8 bytes');
  for (const c of ['\n', '\t', '\u007f', '\u0085', '​', '‮', '⁦', ' ', '﻿']) assert.ok(!subjectOk(`a${c}b`), JSON.stringify(c));
  // ZWNJ and ZWJ are allowed (scripts and emoji need them).
  assert.ok(subjectOk('a‌b‍b'));
  assert.ok(bodyOk('Línea 1\r\nLínea 2\n\tsangría'));
  assert.ok(bodyOk('﻿empieza con BOM'));
  assert.ok(!bodyOk('a﻿b'));
  for (const c of ['\u0000', '\u0007', '\u007f', '\u009f', '؜', '‎', '⁠']) assert.ok(!bodyOk(`a${c}b`), JSON.stringify(c));
});

test('the size counts UTF-8 bytes of the whole mail', () => {
  assert.equal(utf8Length('abc'), 3);
  assert.equal(utf8Length('ñ'), 2);
  assert.equal(utf8Length('€'), 3);
  assert.equal(utf8Length('👋'), 4);
  assert.equal(utf8Length('\ud800'), 3);
  assert.equal(MAIL_FIXED, 174);
  assert.equal(mailSize({ to: ' Ana@NightMail.Local ', subject: 'Hola', body: 'ñ' }, 'yo@nightmail.local'), 174 + 18 + 19 + 4 + 2);
  assert.equal(limitText(), '25 MB');
  const from = 'yo@nightmail.local';
  const fits = MAIL_LIMIT - mailSize({ to: 'ana@nightmail.local', subject: '', body: '' }, from);
  const draft = { fromKey: 'k', to: 'ana@nightmail.local', subject: '', body: 'a'.repeat(fits) };
  assert.deepEqual(checkDraft(draft, DOMAIN, from), {});
  assert.deepEqual(checkDraft({ ...draft, body: `${draft.body}a` }, DOMAIN, from), { body: 'messageTooLarge' });
});

test('checkDraft: each field with its problem, and focus goes to the first one in view', () => {
  const ok = { fromKey: 'k', to: 'ana@nightmail.local', subject: 'Hola', body: 'Texto' };
  assert.deepEqual(checkDraft(ok, DOMAIN, 'yo@nightmail.local'), {});
  const bad = checkDraft({ ...EMPTY_DRAFT, subject: 'a‮b', body: 'x​y' }, DOMAIN, null);
  assert.deepEqual(bad, { from: 'senderUnavailable', to: 'empty', subject: 'subjectInvalid', body: 'bodyInvalid' });
  assert.equal(firstProblem(bad), 'from');
  assert.equal(firstProblem({ body: 'bodyInvalid', to: 'empty' }), 'to');
  assert.equal(firstProblem({}), null);
});

test('send_mail errors go under their field; the rest above the buttons', () => {
  assert.equal(sendErrorField('senderUnavailable'), 'from');
  for (const code of ['recipientInvalid', 'recipientForeignDomain', 'recipientNotFound', 'recipientUnusable']) assert.equal(sendErrorField(code), 'to', code);
  assert.equal(sendErrorField('subjectInvalid'), 'subject');
  assert.equal(sendErrorField('bodyInvalid'), 'body');
  assert.equal(sendErrorField('messageTooLarge'), 'body');
  for (const code of ['registryUnavailable', 'registryStale', 'registryClock', 'serverTimeUnavailable', 'locked', null]) assert.equal(sendErrorField(code), null, String(code));
});

/** The codes of `SendError`, read from the binding the core generates. */
const SEND_CODES = [...readFileSync(new URL('../src/bindings/SendError.ts', import.meta.url), 'utf8').matchAll(/"code": "(\w+)"/g)].map((m) => m[1]);
const FAILURES = [...readFileSync(new URL('../src/bindings/SentFailureView.ts', import.meta.url), 'utf8').split('export type')[1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
/** No ";", "//" nor dashes (app texts use a full stop or a comma), and no comforting sentence about what was not sent. */
const FORBIDDEN = /;|\/\/|—|–|no se ha enviado nada|nothing (was|has been) sent/i;

function inBoth(fn: () => void) {
  try {
    for (const locale of ['es', 'en'] as const) {
      prefs.setLocale(locale);
      fn();
    }
  } finally {
    prefs.setLocale('es');
  }
}

test('every send error has its own text in Spanish and English, never the generic one', () => {
  assert.equal(SEND_CODES.length, 12, 'the binding was read');
  inBoth(() => {
    const generic = describeError({ code: 'codigoNuevo' });
    for (const code of SEND_CODES) {
      const text = describeError({ code });
      assert.notEqual(text, generic, code);
      assert.doesNotMatch(text, FORBIDDEN, code);
    }
  });
  assert.equal(describeError({ code: 'recipientNotFound' }), 'No se ha encontrado esa dirección en NightMail. Comprueba que está bien escrita.');
  assert.equal(describeError({ code: 'recipientForeignDomain' }), 'Por ahora solo se puede enviar a direcciones de NightMail. Comprueba lo que va después de la arroba (@).');
  assert.equal(problemText('empty'), 'Escribe la dirección de destino.');
  assert.equal(problemText('recipientInvalid'), 'Esa dirección no es válida. Comprueba que está bien escrita.');
});

test('every delivery failure and state has its text in both languages', () => {
  assert.equal(FAILURES.length, 8, 'the binding was read');
  inBoth(() => {
    const texts = FAILURES.map((f) => sentFailureText(f as never));
    assert.equal(new Set(texts).size, texts.length, 'one different text per reason');
    for (const text of texts) assert.doesNotMatch(text, FORBIDDEN);
    for (const status of ['queued', 'sent', 'failed'] as const) assert.ok(statusText(status).trim(), status);
  });
  // A reason this version does not know reads as the generic one, never raw.
  assert.equal(sentFailureText('motivo-nuevo' as never), sentFailureText('failed'));
  assert.equal(sentFailureText(null), sentFailureText('failed'));
});

test('states of the list: icon and word for each, and the subject when there is none', () => {
  assert.equal(statusIcon('queued'), 'espera');
  assert.equal(statusIcon('sent'), 'checkmark');
  assert.equal(statusIcon('failed'), 'exclamation-circle');
  assert.equal(statusText('queued'), 'En cola');
  assert.equal(statusText('sent'), 'Enviado');
  assert.equal(statusText('failed'), 'No enviado');
  assert.equal(sentSubject(''), '(sin asunto)');
  assert.equal(sentSubject('  '), '(sin asunto)');
  assert.equal(sentSubject('Hola'), 'Hola');
});

test('retrying: not while sent nor before the time the server asked for, which is said in words', () => {
  const now = new Date(2026, 10, 24, 12, 0);
  const secs = Math.floor(now.getTime() / 1000);
  const failed = { status: 'failed' as const, failure: 'network' as const, retryAt: null };
  assert.ok(canRetry(failed, secs));
  assert.ok(canRetry({ ...failed, status: 'queued' }, secs));
  assert.ok(!canRetry({ ...failed, status: 'sent' }, secs));
  assert.ok(!canRetry({ ...failed, retryAt: secs + 60 }, secs));
  assert.ok(canRetry({ ...failed, retryAt: secs - 1 }, secs));
  assert.equal(sentActionText(failed, now), 'Puedes volver a intentarlo con el botón Reintentar.');
  const later = Math.floor(new Date(2026, 10, 24, 12, 5).getTime() / 1000);
  assert.equal(sentActionText({ ...failed, failure: 'rateLimited', retryAt: later }, now), 'Podrás reintentarlo a partir de las 12:05.');
  const tomorrow = Math.floor(new Date(2026, 10, 25, 0, 10).getTime() / 1000);
  assert.match(sentActionText({ ...failed, retryAt: tomorrow }, now) ?? '', /^Podrás reintentarlo a partir del 25\/11\/2026, 00:10\.$/);
  // Retrying to an address that does not exist, or with a mail too large, gives the same: it is not suggested.
  assert.equal(sentActionText({ ...failed, failure: 'noRecipient' }, now), null);
  assert.equal(sentActionText({ ...failed, failure: 'tooLarge' }, now), null);
  assert.match(sentActionText({ status: 'queued', failure: null, retryAt: null }, now) ?? '', /todavía no ha salido/);
  assert.equal(sentActionText({ status: 'sent', failure: null, retryAt: null }, now), null);
});

test('after sending: back to the list if it went out, to "Enviados" if not', () => {
  assert.equal(afterSend('sent'), 'list');
  assert.equal(afterSend('failed'), 'sent');
  assert.equal(afterSend('queued'), 'sent');
});

test('"Re:" goes in front once, whatever its capitals or spaces', () => {
  assert.equal(replySubject('Hola'), 'Re: Hola');
  assert.equal(replySubject('  Hola  '), 'Re: Hola');
  assert.equal(replySubject('Re: Hola'), 'Re: Hola');
  assert.equal(replySubject('RE: Hola'), 'RE: Hola');
  assert.equal(replySubject('re : Hola'), 're : Hola');
  assert.equal(replySubject('Re:Hola'), 'Re:Hola');
  assert.equal(replySubject('Respuesta'), 'Re: Respuesta');
  assert.equal(replySubject(null), 'Re:');
  assert.equal(replySubject(''), 'Re:');
});

test('"Responder" only to a NightMail sender, and why not otherwise', () => {
  assert.equal(senderOf('Ana <Ana@NightMail.local>'), 'Ana@NightMail.local');
  assert.equal(senderOf(' ana@nightmail.local '), 'ana@nightmail.local');
  assert.equal(senderOf(null), null);
  assert.equal(senderOf('  '), null);
  assert.deepEqual(replyTarget('Ana <Ana@NightMail.local>', DOMAIN), { ok: true, to: 'ana@nightmail.local' });
  assert.deepEqual(replyTarget('bob@gmail.com', DOMAIN), { ok: false, reason: 'external' });
  assert.deepEqual(replyTarget('"Bob" <bob@gmail.com>', DOMAIN), { ok: false, reason: 'external' });
  assert.deepEqual(replyTarget(null, DOMAIN), { ok: false, reason: 'unknown' });
  assert.deepEqual(replyTarget('Alguien sin dirección', DOMAIN), { ok: false, reason: 'unknown' });
  assert.deepEqual(replyTarget('ana@nightmail.local', null), { ok: false, reason: 'unknown' });
  assert.equal(replyBlockedText('external'), 'Solo se puede responder a direcciones de NightMail.');
  assert.match(replyBlockedText('unknown'), /no se conoce la dirección/);
});

const addr = (addrKey: string, display: string): AddressView => ({ addrKey, display, slot: { kind: 'mailbox', n: 0, j: 0 } as AddressView['slot'], name: null, createdAt: 0 });

test('"De": the inbox in view or the one that received the message, if it can send, otherwise the first one', () => {
  const list = [addr('a', 'ana@nightmail.local'), addr('b', ''), addr('c', 'x7@nightmail.local')];
  assert.equal(pickFrom(list, 'c'), 'c');
  assert.equal(pickFrom(list, null), 'a');
  // A restored address without its name has no address to write: it cannot send.
  assert.equal(pickFrom(list, 'b'), 'a');
  assert.equal(pickFrom(list, 'gone'), 'a');
  assert.equal(pickFrom([], 'a'), '');
  assert.equal(pickFrom([addr('b', '')], null), '');
});

test('discarding asks only if something was written since opening; focus goes to the first empty field', () => {
  const seed = { fromKey: 'a', to: 'ana@nightmail.local', subject: 'Re: Hola', body: '' };
  assert.ok(!hasContent(seed, seed));
  assert.ok(!hasContent({ ...seed, fromKey: 'b', body: '   \n' }, seed));
  assert.ok(hasContent({ ...seed, body: 'Gracias' }, seed));
  assert.ok(hasContent({ ...seed, to: 'otra@nightmail.local' }, seed));
  assert.ok(hasContent({ ...EMPTY_DRAFT, subject: 'x' }, EMPTY_DRAFT));
  assert.equal(firstFocus(EMPTY_DRAFT), 'to');
  assert.equal(firstFocus({ to: 'ana@nightmail.local', subject: '' }), 'subject');
  assert.equal(firstFocus(seed), 'body');
});

const key = (k: Partial<ComposeKey>): ComposeKey => ({ key: '', defaultPrevented: false, isComposing: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...k });

test('shortcuts: Ctrl+Enter or Cmd+Enter send, Esc discards', () => {
  assert.equal(composeKey(key({ key: 'Enter', ctrlKey: true })), 'send');
  assert.equal(composeKey(key({ key: 'Enter', metaKey: true })), 'send');
  assert.equal(composeKey(key({ key: 'Enter', ctrlKey: true, shiftKey: true })), 'send');
  assert.equal(composeKey(key({ key: 'Enter' })), null, 'a plain Enter is a new line');
  assert.equal(composeKey(key({ key: 'Enter', ctrlKey: true, altKey: true })), null);
  assert.equal(composeKey(key({ key: 'Enter', ctrlKey: true, isComposing: true })), null);
  assert.equal(composeKey(key({ key: 'Escape' })), 'cancel');
  assert.equal(composeKey(key({ key: 'Escape', shiftKey: true })), null);
  assert.equal(composeKey(key({ key: 'Escape', defaultPrevented: true })), null);
  assert.equal(composeKey(key({ key: 'a', ctrlKey: true })), null);
});

test('the texts of writing and "Enviados" say the same in English and carry their data', () => {
  const en = DICTIONARIES.en.screensMail;
  const es = DICTIONARIES.es.screensMail;
  assert.equal(es.compose.toHelp(DOMAIN), 'Una dirección de NightMail, por ejemplo nombre@nightmail.local.');
  assert.equal(en.compose.toHelp(DOMAIN), 'A NightMail address, for example name@nightmail.local.');
  assert.equal(es.compose.size('1.2 KB', '25 MB'), 'Tamaño: 1.2 KB de 25 MB');
  assert.equal(en.compose.size('1.2 KB', '25 MB'), 'Size: 1.2 KB of 25 MB');
  assert.equal(es.sent.count(1), '1 mensaje');
  assert.equal(es.sent.count(3), '3 mensajes');
  assert.equal(en.sent.count(1), '1 message');
  assert.equal(en.sent.count(3), '3 messages');
  assert.equal(en.sent.retryAtTime('12:05'), 'You can retry from 12:05.');
  for (const words of [en.compose, es.compose, en.sent, es.sent]) {
    for (const value of Object.values(words)) {
      if (typeof value === 'string') assert.doesNotMatch(value, FORBIDDEN, value);
    }
  }
});
