// Pure rules of the reader and guards on how mail is painted: `node --test test/*.test.ts`.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { bodyKind, canToggle, focusTarget, usableText } from '../src/reader.ts';

const base = { unreadable: false, hasHtml: false, hasText: false, asText: false };

test('bodyKind: HTML on the paper, without HTML the text, with nothing the empty notice', () => {
  assert.equal(bodyKind({ ...base, hasHtml: true, hasText: true }), 'papel');
  assert.equal(bodyKind({ ...base, hasHtml: true }), 'papel');
  assert.equal(bodyKind({ ...base, hasText: true }), 'texto');
  assert.equal(bodyKind(base), 'vacio');
});

test('bodyKind: "Ver como texto" only changes something if there is text to show', () => {
  assert.equal(bodyKind({ ...base, hasHtml: true, hasText: true, asText: true }), 'texto');
  assert.equal(bodyKind({ ...base, hasHtml: true, asText: true }), 'papel');
  assert.equal(bodyKind({ ...base, hasText: true, asText: true }), 'texto');
  assert.equal(bodyKind({ ...base, asText: true }), 'vacio');
});

test('bodyKind: an unreadable message shows no body, whatever it carries', () => {
  assert.equal(bodyKind({ ...base, unreadable: true }), 'ilegible');
  assert.equal(bodyKind({ unreadable: true, hasHtml: true, hasText: true, asText: true }), 'ilegible');
});

test('canToggle: the toggle button only exists with both versions and a readable message', () => {
  assert.equal(canToggle({ ...base, hasHtml: true, hasText: true }), true);
  assert.equal(canToggle({ ...base, hasHtml: true, hasText: true, asText: true }), true);
  assert.equal(canToggle({ ...base, hasHtml: true }), false);
  assert.equal(canToggle({ ...base, hasText: true }), false);
  assert.equal(canToggle(base), false);
  assert.equal(canToggle({ unreadable: true, hasHtml: true, hasText: true, asText: false }), false);
});

test('usableText: the text as is, or nothing if missing or blank', () => {
  assert.equal(usableText('  hola\n'), '  hola\n');
  assert.equal(usableText(''), null);
  assert.equal(usableText(' \n\t '), null);
  assert.equal(usableText(null), null);
});

test('focusTarget: with mail in view focus goes to the body (B3: Page Down scrolls it), otherwise it stays on the reader', () => {
  assert.equal(focusTarget('papel'), 'cuerpo');
  assert.equal(focusTarget('texto'), 'cuerpo');
  assert.equal(focusTarget('ilegible'), 'lector');
  assert.equal(focusTarget('vacio'), 'lector');
  assert.equal(focusTarget(null), 'lector');
});

// ---- Guards: a mail's HTML can only reach the screen through the reader's sandbox iframe.

/** All the sources in `src/` (without the generated types), with their relative path. */
function sources(dir = new URL('../src/', import.meta.url), prefix = ''): [name: string, text: string][] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return entry.name === 'bindings' ? [] : sources(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`);
    return /\.tsx?$/.test(entry.name) ? [[prefix + entry.name, readFileSync(new URL(entry.name, dir), 'utf8')] as [string, string]] : [];
  });
}

test("there is only one iframe in the app: the reader's, with an empty sandbox, no permissions and only srcDoc", () => {
  const frames = sources().flatMap(([name, text]) => (text.match(/<iframe\b[^>]*>/g) ?? []).map((tag) => ({ name, tag })));
  assert.equal(frames.length, 1, JSON.stringify(frames));
  const [{ name, tag }] = frames as [{ name: string; tag: string }];
  assert.equal(name, 'screens/Reader.tsx');
  // `sandbox=""`: no scripts, no same origin, no forms, no new windows and no navigating the window.
  assert.match(tag, /\ssandbox=""/);
  assert.doesNotMatch(tag, /allow/i);
  assert.doesNotMatch(tag, /\ssrc=/);
  assert.match(tag, /\ssrcDoc=\{srcDoc\}/);
});

test('the iframe srcDoc only comes from the sanitizer + buildSrcDoc', () => {
  const reader = sources().find(([name]) => name === 'screens/Reader.tsx')?.[1] ?? '';
  // A single `srcDoc` factory in the reader, and it receives what the sanitiser returns (`html: clean`).
  assert.equal(reader.match(/\bcleanToSrcDoc\(/g)?.length, 1);
  assert.equal(reader.match(/\bsanitizeHtml\(/g)?.length, 1);
  assert.match(reader, /\{ html: clean, [^}]*\} = sanitizeHtml\(/);
  assert.match(reader, /cleanToSrcDoc\(clean\)/);
});

test('no screen injects HTML on its own (no dangerouslySetInnerHTML nor innerHTML with outside content)', () => {
  const all = sources();
  assert.ok(all.length > 30, 'the sources were not read');
  const inner = all.filter(([, text]) => /dangerouslySetInnerHTML|\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write|createContextualFragment|\.srcdoc\s*=|createElement\(\s*['"`](?:iframe|frame|object|embed)['"`]/i.test(text)).map(([name]) => name);
  // The only exception: the icon markup, from the files of design/icons bundled with the app.
  assert.deepEqual(inner, ['components/Icon.tsx']);
});
