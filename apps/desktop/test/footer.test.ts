// Reader footer: attachment labels and guards on links and attachments. `node --test test/*.test.ts`.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { attachmentName, attachmentRows, inlineShown } from '../src/format.ts';

const att = (name: string | null, contentType: string, size: number) => ({ name, contentType, size });
/** Inline image with `size` bytes (base64 of zeros). */
const img = (mime: string, size: number) => ({ cid: 'c', mime, data: Buffer.alloc(size).toString('base64') });

// ---------------------------------------------------------------- name

test('attachmentName: no bidi, invisible or control characters, collapsed spaces', () => {
  // The classic: U+202E reverses the end and "factura<RLO>fdp.exe" looks like "facturaexe.pdf".
  assert.equal(attachmentName('factura\u{202E}fdp.exe'), 'facturafdp.exe');
  assert.equal(attachmentName('a\u{200B}b\u{0007}c\u{FEFF}.txt'), 'abc.txt');
  assert.equal(attachmentName('  informe \n\t final.pdf '), 'informe final.pdf');
});

test('attachmentName: only the last segment of a path, no trailing dots or spaces, empty → unnamed', () => {
  assert.equal(attachmentName('../../etc/passwd'), 'passwd');
  assert.equal(attachmentName('C:\\Windows\\System32\\evil.dll'), 'evil.dll');
  assert.equal(attachmentName('virus.exe. . .'), 'virus.exe');
  assert.equal(attachmentName('..'), null);
  assert.equal(attachmentName('carpeta/'), null);
  assert.equal(attachmentName('\u{202E}\u{200B}'), null);
  assert.equal(attachmentName('   '), null);
  assert.equal(attachmentName(null), null);
  assert.equal(attachmentName('.bashrc'), '.bashrc');
});

test('attachmentName: a long name is shortened in the middle and the real extension stays visible', () => {
  const padded = attachmentName(`factura.pdf${'_'.repeat(200)}.exe`) ?? '';
  assert.equal([...padded].length, 60);
  assert.ok(padded.startsWith('factura.pdf'));
  assert.ok(padded.endsWith('….exe'), padded);
  const noExt = attachmentName('x'.repeat(100)) ?? '';
  assert.equal([...noExt].length, 60);
  assert.ok(noExt.includes('…'));
  assert.equal(attachmentName('corto.pdf'), 'corto.pdf');
});

// ---------------------------------------------------------------- rows

test("attachmentRows: the declared type only counts if the name's extension agrees", () => {
  const [pdf, fake, doubled, docx] = attachmentRows(
    [
      att('albaran-2031.pdf', 'application/pdf', 49_459),
      att('foto.jpg.exe', 'image/jpeg', 1000),
      att('factura.pdf.scr', 'application/pdf; name="factura.pdf"', 2048),
      att('informe.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 512),
    ],
    [],
  );
  assert.deepEqual(pdf, { name: 'albaran-2031.pdf', muted: false, icon: 'file-pdf', meta: 'PDF · 48,3 KB' });
  // What decides how the system would open it is the extension: neither an image icon nor "JPEG".
  assert.deepEqual(fake, { name: 'foto.jpg.exe', muted: false, icon: 'file', meta: 'EXE · 1000 B' });
  assert.deepEqual(doubled, { name: 'factura.pdf.scr', muted: false, icon: 'file', meta: 'SCR · 2,0 KB' });
  assert.deepEqual(docx, { name: 'informe.docx', muted: false, icon: 'file', meta: 'DOCX · 512 B' });
});

test('attachmentRows: with a dot in the name, never the declared type, no invisible marks after the extension', () => {
  const rows = attachmentRows(
    [
      att('virus.exe\u{034F}', 'application/pdf', 10),
      att('virus.exe\u{FE0F}', 'application/pdf', 10),
      att('virus.exe™', 'application/pdf', 10),
      att('a.bbbbbbbbbbbb', 'application/pdf', 10),
      att('.pdf', 'application/pdf', 10),
    ],
    [],
  );
  assert.deepEqual(rows[0], { name: 'virus.exe', muted: false, icon: 'file', meta: 'EXE · 10 B' });
  assert.deepEqual(rows[1], { name: 'virus.exe', muted: false, icon: 'file', meta: 'EXE · 10 B' });
  assert.deepEqual(rows[2], { name: 'virus.exe™', muted: false, icon: 'file', meta: 'EXE™ · 10 B' });
  assert.deepEqual(rows[3], { name: 'a.bbbbbbbbbbbb', muted: false, icon: 'file', meta: 'BBBBBBBBB… · 10 B' });
  // A leading dot is an extension too: ".pdf" matches the type.
  assert.equal(rows[4]?.meta, 'PDF · 10 B');
  assert.equal(attachmentName('x\u{3164}\u{115F}y\u{E0100}.txt'), 'xy.txt');
});

test('attachmentRows: without a name, the declared type, capitals and type parameters do not matter', () => {
  const [a, b, c] = attachmentRows([att(null, 'APPLICATION/PDF', 10), att(null, 'application/x-raro', 10), att('LEEME', 'text/plain', 10)], []);
  assert.deepEqual(a, { name: 'Sin nombre', muted: true, icon: 'file-pdf', meta: 'PDF · 10 B' });
  assert.deepEqual(b, { name: 'Sin nombre', muted: true, icon: 'file', meta: 'Archivo · 10 B' });
  assert.deepEqual(c, { name: 'LEEME', muted: false, icon: 'file', meta: 'Texto · 10 B' });
});

test('attachmentRows: the inline image already shown above is labelled as such (same type and size, once each)', () => {
  const rows = attachmentRows(
    [att(null, 'image/png', 1126), att(null, 'image/png', 1126), att(null, 'image/gif', 1126), att('logo.png', 'image/png', 1126)],
    [img('image/png', 1126), img('image/gif', 99)],
  );
  assert.deepEqual(rows[0], { name: inlineShown(), muted: true, icon: 'file-image', meta: 'PNG · 1,1 KB' });
  // There was only one PNG in view: the second is not "above".
  assert.equal(rows[1]?.name, 'Sin nombre');
  // Another size: it is not the same.
  assert.equal(rows[2]?.name, 'Sin nombre');
  // With a name, the name is shown.
  assert.equal(rows[3]?.name, 'logo.png');
  // With no images in view (text, or the image did not decode) it never says "ya se ve arriba".
  assert.equal(attachmentRows([att(null, 'image/png', 1126)], [])[0]?.name, 'Sin nombre');
});

// ---------------------------------------------------------------- guards in the sources

function sources(dir = new URL('../src/', import.meta.url), prefix = ''): [name: string, text: string][] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return entry.name === 'bindings' ? [] : sources(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`);
    return /\.tsx?$/.test(entry.name) ? [[prefix + entry.name, readFileSync(new URL(entry.name, dir), 'utf8')] as [string, string]] : [];
  });
}
const source = (name: string) => sources().find(([n]) => n === name)?.[1] ?? '';

test('the app never navigates its window nor opens anything on its own: no window.open, no location, no <a href>', () => {
  const all = sources();
  assert.ok(all.length > 30, 'the sources were not read');
  const offenders = all
    .filter(([, text]) =>
      /\b(?:window|globalThis|self|top|parent)\s*\.\s*open\s*\(|\blocation\s*\.\s*(?:href|assign|replace)\b|\blocation\s*=|<a\b[^>]*\bhref=|target=["'{]_blank|createElement\(\s*['"`]a['"`]/.test(text),
    )
    .map(([name]) => name);
  assert.deepEqual(offenders, []);
});

test('the open_link command is only named in api.ts (nobody invokes it directly, skipping the dialog)', () => {
  const named = sources()
    // Single or double quotes, or a template inside `invoke(...)` (in comments it goes between backticks).
    .filter(([name, text]) => name !== 'api.ts' && /['"]open_link['"]|invoke\s*(?:<[^>]*>)?\s*\(\s*`open_link`/.test(text))
    .map(([name]) => name);
  assert.deepEqual(named, []);
});

test('a link only opens from the confirmation, with the URL the core returned (inspect_link → open_link)', () => {
  const users = sources()
    .filter(([name, text]) => name !== 'api.ts' && /\bopenLink\(/.test(text))
    .map(([name]) => name);
  assert.deepEqual(users, ['screens/MessageLinks.tsx']);
  const links = source('screens/MessageLinks.tsx');
  // A single call, with `info.url` (the one normalised by the core), never with the mail's `href`.
  assert.equal(links.match(/\bopenLink\(/g)?.length, 1);
  assert.match(links, /api\.openLink\(info\.url\)/);
  assert.match(links, /api\.inspectLink\(link\.href\)/);
  // And the confirmation is a dialog with the whole URL.
  const confirm = links.match(/function ConfirmOpen[\s\S]*?\n}\n/)?.[0] ?? '';
  assert.match(confirm, /<Dialogo\b/);
  assert.match(confirm, /<FullUrl info=\{info\} \/>/);
  assert.match(confirm, /textHostMismatch\(link\.text, info\.host\)/);
  assert.match(confirm, /!info\.secure/);
});

test('the confirmation: "Cancelar" goes first (it takes focus) and "Abrir" is not the bright button', () => {
  const confirm = source('screens/MessageLinks.tsx').match(/function ConfirmOpen[\s\S]*?\n}\n/)?.[0] ?? '';
  const cancel = confirm.indexOf('words.cancel');
  const open = confirm.indexOf('words.openInBrowser');
  assert.ok(cancel > 0 && open > cancel, 'Cancelar must come before Abrir');
  assert.doesNotMatch(confirm, /solid-norm/);
});

test("the confirmation: the core's host on its own line and the warnings go BEFORE the URL (a long URL does not hide them)", () => {
  const confirm = source('screens/MessageLinks.tsx').match(/function ConfirmOpen[\s\S]*?\n}\n/)?.[0] ?? '';
  assert.match(confirm, /\{words\.goesTo\} <strong[^>]*>\{info\.host\}<\/strong>/);
  const host = confirm.indexOf('words.goesTo');
  const warning = confirm.indexOf('<Aviso');
  const url = confirm.indexOf('<FullUrl');
  assert.ok(host > 0 && warning > host && url > warning, `orden: host ${host}, avisos ${warning}, URL ${url}`);
  assert.equal(confirm.lastIndexOf('<Aviso') < url, true);
  const css = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.nm-dialogo \.nm-copiable \{ max-block-size: 8rem; overflow: auto; \}/);
});

test('attachments are only shown: no buttons, no core calls, no downloads, no declared type as is', () => {
  const view = source('screens/Attachments.tsx');
  assert.ok(view.length > 0, 'screens/Attachments.tsx not found');
  assert.doesNotMatch(view, /<button|onClick|\bapi\b|invoke|download|createObjectURL|href|contentType/);
  assert.match(view, /attachmentRows\(/);
  // The name is written by the sender: isolated and left to right (the real extension always on the right).
  assert.match(view, /<bdi dir="ltr"[^>]*>\{row\.name\}<\/bdi>/);
});

test('"ya se ve arriba" only with the images that are shown: those that decoded and with the HTML in view', () => {
  const reader = source('screens/Reader.tsx');
  assert.match(reader, /const shownImages = papel && images !== null \? images : NO_IMAGES;/);
  assert.match(reader, /<Attachments attachments=\{detail\.attachments\} shownImages=\{view\.shownImages\} \/>/);
  // The provisional footer is gone.
  assert.doesNotMatch(reader, /nm-lector__pie/);
});
