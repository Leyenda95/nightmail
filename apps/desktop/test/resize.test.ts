// List width with three panels: `node --test test/*.test.ts`.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  clampListWidth,
  LIST_WIDTH_DEFAULT,
  LIST_WIDTH_MAX,
  LIST_WIDTH_MIN,
  listWidthMax,
  listWidthStyle,
  parseListWidth,
  READER_MIN_REM,
  stepListWidth,
  widthFromPointer,
} from '../src/resize.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('the limits are the planned ones: 20.5 by default, 17 to 40, and the reader with at least 24', () => {
  assert.equal(LIST_WIDTH_DEFAULT, 20.5);
  assert.equal(LIST_WIDTH_MIN, 17);
  assert.equal(LIST_WIDTH_MAX, 40);
  assert.equal(READER_MIN_REM, 24);
});

test('parseListWidth: only a number within range, anything else gives the default', () => {
  for (const ok of ['17', '20.5', '33', '40', ' 25 ', 25.5]) assert.equal(parseListWidth(ok), Number(ok));
  const bad = [null, undefined, '', ' ', 'abc', '16.9', '40.1', '-20', '1e1', '0x14', 'NaN', 'Infinity', '20,5', '20rem', {}, [], true, NaN, 100];
  for (const raw of bad) assert.equal(parseListWidth(raw), LIST_WIDTH_DEFAULT, String(raw));
});

test('clampListWidth: clamps to [17, cap], rounds to 1/16 rem and a non-number gives the default', () => {
  assert.equal(clampListWidth(5), 17);
  assert.equal(clampListWidth(99), 40);
  assert.equal(clampListWidth(30, 28), 28);
  assert.equal(clampListWidth(30, 10), 17, 'a cap below the minimum does not go below the minimum');
  assert.equal(clampListWidth(22.3), 22.3125);
  assert.equal(clampListWidth(NaN), LIST_WIDTH_DEFAULT);
  assert.equal(clampListWidth(Infinity), LIST_WIDTH_DEFAULT);
  assert.equal(clampListWidth('30' as never), LIST_WIDTH_DEFAULT);
});

test('listWidthMax: leaves 24 rem to the reader, not above 40 nor below 17, without a measure 40', () => {
  assert.equal(listWidthMax(80 * 16, 16), 40);
  assert.equal(listWidthMax(54 * 16, 16), 30);
  assert.equal(listWidthMax(54 * 20, 20), 30, 'in rem: follows the font size');
  assert.equal(listWidthMax(30 * 16, 16), 17);
  for (const [panel, root] of [[undefined, 16], [800, undefined], [0, 16], [800, 0], [NaN, 16], [800, Infinity]]) {
    assert.equal(listWidthMax(panel, root), 40);
  }
});

test('stepListWidth: ← / → by 1 rem, Home and End to the ends, and nothing with other keys', () => {
  assert.equal(stepListWidth(20.5, 'ArrowRight'), 21.5);
  assert.equal(stepListWidth(20.5, 'ArrowLeft'), 19.5);
  assert.equal(stepListWidth(20.5, 'ArrowUp'), 21.5);
  assert.equal(stepListWidth(20.5, 'ArrowDown'), 19.5);
  assert.equal(stepListWidth(17.5, 'ArrowLeft'), 17);
  assert.equal(stepListWidth(39.5, 'ArrowRight'), 40);
  assert.equal(stepListWidth(30, 'ArrowRight', 30), 30, 'at the panel cap, it does not go past');
  assert.equal(stepListWidth(25, 'Home'), 17);
  assert.equal(stepListWidth(25, 'End'), 40);
  assert.equal(stepListWidth(25, 'End', 32), 32);
  for (const key of ['Enter', ' ', 'Tab', 'Escape', 'a', 'PageUp']) assert.equal(stepListWidth(25, key), null, key);
});

test("widthFromPointer: from the list's left edge to the pointer, in rem and clamped", () => {
  assert.equal(widthFromPointer(248 + 400, 248, 16), 25);
  assert.equal(widthFromPointer(248 + 400, 248, 20), 20);
  assert.equal(widthFromPointer(248 + 10, 248, 16), 17);
  assert.equal(widthFromPointer(248 + 2000, 248, 16), 40);
  assert.equal(widthFromPointer(248 + 2000, 248, 16, 31), 31);
  assert.equal(widthFromPointer(500, 248, 0), LIST_WIDTH_DEFAULT);
});

test('listWidthStyle: the variable only with three panels, always within range', () => {
  assert.deepEqual(listWidthStyle(true, 25), { '--nm-lista-ancho': '25rem' });
  assert.deepEqual(listWidthStyle(true, 99), { '--nm-lista-ancho': '40rem' });
  assert.equal(listWidthStyle(false, 25), undefined);
});

test('app.css reads the variable with the same limits as resize.ts, and two panels override it', () => {
  const css = read('../src/styles/app.css');
  assert.match(css, /\.nm-paneles \{[^}]*grid-template-columns: clamp\(17rem, var\(--nm-lista-ancho, 20\.5rem\), calc\(100% - 24rem\)\)/);
  assert.match(css, /\.nm-paneles--dos \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(css, /\.nm-arrastrando \.nm-papel iframe \{ pointer-events: none; \}/);
  // WebKitGTK 2.52 only understands the prefix; the cursor is forced over the whole window (the base stylesheet sets its own on buttons).
  const dragging = css.match(/\.nm-arrastrando, \.nm-arrastrando \* \{([^}]*)\}/)?.[1] ?? '';
  assert.match(dragging, /cursor: col-resize !important/);
  assert.match(dragging, /-webkit-user-select: none !important/);
  assert.match(dragging, /(^|[^-])user-select: none !important/);
  assert.match(css, /\.nm-tirador \{[^}]*-webkit-user-select: none/);
});

test('Inbox.tsx puts the drag class on <html> and also removes it if the handle unmounts mid-drag', () => {
  const src = read('../src/screens/Inbox.tsx');
  assert.match(src, /const DRAGGING = 'nm-arrastrando'/);
  assert.equal(src.match(/document\.documentElement\.classList\.remove\(DRAGGING\)/g)?.length, 2, 'on release and on unmount');
});
