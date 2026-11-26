// Pure rules of the reader's link list: `node --test test/*.test.ts`.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeError } from '../src/errors.ts';
import {
  cleanLinkText,
  createLinkCollector,
  destinationLabel,
  extractTextLinks,
  MAX_LINKS,
  splitUrl,
  textHostMismatch,
} from '../src/links.ts';

test('cleanLinkText: no bidi, invisible or control characters, collapsed spaces, cap 80', () => {
  assert.equal(cleanLinkText('  ver\u{202E}exe.gpj   ofertas\u{200B}\n '), 'verexe.gpj ofertas');
  assert.equal(cleanLinkText('a\u{2066}b\u{00AD}c\u{FEFF}d\u{0007}e'), 'abcde');
  assert.equal(cleanLinkText('x\u{E0041}y'), 'xy');
  const long = cleanLinkText('ñ'.repeat(100));
  assert.equal([...long].length, 80);
  assert.ok(long.endsWith('…'));
  assert.equal(cleanLinkText('😀'.repeat(90)).endsWith('😀…'), true);
});

test('createLinkCollector: numbers in order, does not duplicate the same href and counts what goes over the cap', () => {
  const c = createLinkCollector();
  assert.equal(c.add('https://a/', 'A'), 1);
  assert.equal(c.add('https://b/', ' B '), 2);
  assert.equal(c.add('https://a/', 'otro texto'), 1);
  for (let i = 3; i <= MAX_LINKS; i++) c.add(`https://x/${i}`, '');
  assert.equal(c.add('https://lleno/1', ''), null);
  assert.equal(c.add('https://lleno/1', ''), null);
  assert.equal(c.add('https://lleno/2', ''), null);
  assert.equal(c.add('https://a/', ''), 1);
  const { links, omitted } = c.result();
  assert.equal(links.length, MAX_LINKS);
  assert.deepEqual(links[0], { n: 1, href: 'https://a/', text: 'A' });
  assert.deepEqual(links[1], { n: 2, href: 'https://b/', text: 'B' });
  assert.equal(omitted, 2);
});

test('extractTextLinks: only http(s), no trailing punctuation, no duplicates', () => {
  const { links, omitted } = extractTextLinks(
    'Mira https://a.example/x?y=1. Y (http://b.example/p), otra vez https://a.example/x?y=1, ' +
      'pero no ftp://c.example ni mailto:d@e.f ni javascript:alert(1). <https://g.example/q>',
  );
  assert.deepEqual(
    links.map((l) => l.href),
    ['https://a.example/x?y=1', 'http://b.example/p', 'https://g.example/q'],
  );
  assert.deepEqual(links[0], { n: 1, href: 'https://a.example/x?y=1', text: 'https://a.example/x?y=1' });
  assert.equal(omitted, 0);
  assert.deepEqual(extractTextLinks('sin enlaces'), { links: [], omitted: 0 });
});

test('destinationLabel: host for web, the scheme for everything else', () => {
  assert.equal(destinationLabel('https://Bücher.example:8443/x'), 'xn--bcher-kva.example:8443');
  assert.equal(destinationLabel('http://a.example/'), 'a.example');
  assert.equal(destinationLabel('mailto:a@b.c'), 'mailto:');
  assert.equal(destinationLabel('no es url'), '(dirección no válida)');
});

test('textHostMismatch: warns if the text looks like another site', () => {
  assert.equal(textHostMismatch('https://banco.example/login', 'malo.example'), 'banco.example');
  assert.equal(textHostMismatch('Entra en www.Banco.example ya', 'malo.example'), 'www.Banco.example');
  assert.equal(textHostMismatch('soporte@banco.example', 'malo.example'), 'banco.example');
  assert.equal(textHostMismatch('bücher.example', 'malo.example'), 'bücher.example');
  // It matches (uppercase, www., port, punycode) or does not look like an address: no warning.
  assert.equal(textHostMismatch('https://BANCO.example/x', 'banco.example'), null);
  assert.equal(textHostMismatch('www.banco.example', 'banco.example'), null);
  assert.equal(textHostMismatch('banco.example', 'www.banco.example:8443'), null);
  assert.equal(textHostMismatch('bücher.example', 'xn--bcher-kva.example'), null);
  assert.equal(textHostMismatch('Ver ofertas', 'malo.example'), null);
  assert.equal(textHostMismatch('versión 1.5', 'malo.example'), null);
  assert.equal(textHostMismatch('', 'malo.example'), null);
});

test('splitUrl: splits out the host to highlight it', () => {
  assert.deepEqual(splitUrl('https://a.example:8443/x?y', 'a.example:8443'), ['https://', 'a.example:8443', '/x?y']);
  assert.deepEqual(splitUrl('http://[::1]/', '[::1]'), ['http://', '[::1]', '/']);
  assert.equal(splitUrl('https://a.example/', 'b.example'), null);
});

test('describeError: link errors with a fixed message', () => {
  assert.equal(describeError({ code: 'browserFailed' }), 'No se ha podido abrir el navegador.');
  for (const code of ['linkTooLong', 'linkHiddenChars', 'linkMalformed', 'linkScheme', 'linkCredentials']) {
    assert.match(describeError({ code }), /no se abre/, code);
  }
  assert.equal(
    describeError({ code: 'linkLocal' }),
    'Este enlace apunta a tu propio equipo o a una red privada y no se puede abrir desde aquí.',
  );
});

test('textHostMismatch: domain in parentheses, brackets, quotes or stuck to other text', () => {
  for (const text of [
    '(https://banco.example/login)',
    '«banco.example»',
    '"www.banco.example"',
    '[banco.example]',
    'Entra:https://banco.example',
    'Ir a>banco.example',
    '“banco.example”,',
    '{banco.example};',
  ]) {
    assert.match(textHostMismatch(text, 'malo.example') ?? '', /banco\.example$/, text);
  }
  // The path is not taken for a domain, and the same site between punctuation does not warn either.
  assert.equal(textHostMismatch('(https://malo.example/b.html)', 'malo.example'), null);
  assert.equal(textHostMismatch('«www.malo.example»', 'malo.example'), null);
  assert.equal(textHostMismatch('Ver (ofertas)', 'malo.example'), null);
});

test('extractTextLinks: the trailing ) stays if it has a match inside the URL', () => {
  const { links } = extractTextLinks(
    'Mira https://b.example/a(b) y (https://c.example/d) o [https://e.example/f] y https://g.example/h_(i)).',
  );
  assert.deepEqual(
    links.map((l) => l.href),
    ['https://b.example/a(b)', 'https://c.example/d', 'https://e.example/f', 'https://g.example/h_(i)'],
  );
});

test('textHostMismatch: a URL inside the query or the fragment does not hide the visible domain', () => {
  for (const text of [
    'https://banco.example/?r=https://malo.example/',
    'https://banco.example/login#https://malo.example',
    'banco.example/x?u=a://malo.example',
  ]) {
    assert.equal(textHostMismatch(text, 'malo.example'), 'banco.example', text);
  }
  assert.equal(textHostMismatch('https://banco.example/r?u=https://otro.example/x', 'banco.example'), null);
});
