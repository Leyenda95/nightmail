// Scrollbars: WebKitGTK's native one repaints endlessly without a GPU; app.css resets to `auto` what the base stylesheet sets
// so its `::-webkit-scrollbar` rules apply, and the mail paper carries its own.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PAPER_SHEET } from '../src/srcdoc.ts';

test('app.css overrides scrollbar-width and scrollbar-color from the base stylesheet', () => {
  const css = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(
    css,
    /@supports \(scrollbar-width: auto\) \{\s*html:not\(\.feature-scrollbars-off\) body,\s*html:not\(\.feature-scrollbars-off\) body \* \{ scrollbar-width: auto !important; scrollbar-color: auto !important; \}/,
  );
});

test('the mail paper uses ::-webkit-scrollbar and not the standard properties', () => {
  assert.match(PAPER_SHEET, /::-webkit-scrollbar\{width:10px;height:10px\}/);
  assert.match(PAPER_SHEET, /::-webkit-scrollbar-thumb\{/);
  assert.doesNotMatch(PAPER_SHEET, /scrollbar-(width|color)/);
});
