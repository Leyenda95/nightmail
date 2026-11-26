// The app only names icons that exist in its own set (design/icons): `node --test test/*.test.ts`.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ICONS } from '../../../design/icons/icons.ts';
import { AVISO_TONES, avisoIcon } from '../src/pieces.ts';

const srcDir = new URL('../src/', import.meta.url);

function sources(): [string, string][] {
  return readdirSync(srcDir, { recursive: true, encoding: 'utf8' })
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => [name.replaceAll('\\', '/'), readFileSync(new URL(name, srcDir), 'utf8')]);
}

const literals = (text: string) => [...text.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2] ?? '');

/** Every icon name the code can pass to `Icon`, fixed or chosen at run time. */
function usedNames(): Set<string> {
  const names = new Set<string>();
  for (const [, text] of sources()) {
    // <Icon name="x" />
    for (const m of text.matchAll(/<Icon\s+name="([^"]*)"/g)) names.add(m[1] ?? '');
    // <Icon name={cond ? 'x' : 'y'} />: the two branches, not what the condition compares
    for (const m of text.matchAll(/<Icon\s+name=\{([^}]*)\}/g)) {
      for (const b of (m[1] ?? '').matchAll(/[?:]\s*'([^']*)'/g)) names.add(b[1] ?? '');
    }
    // Menu items: <MenuItem icon="x" />
    for (const m of text.matchAll(/\bicon="([^"]*)"/g)) names.add(m[1] ?? '');
    // Values and types of `icon` fields: `icon: 'x'` and `icon: 'x' | 'y'`
    for (const m of text.matchAll(/\bicon:\s*('[^']*'(?:\s*\|\s*'[^']*')*)/g)) literals(m[1] ?? '').forEach((n) => names.add(n));
    // Named unions of icons: `type AttachmentIcon = 'x' | 'y'`
    for (const m of text.matchAll(/\btype\s+\w*Icon\s*=\s*('[^']*'(?:\s*\|\s*'[^']*')*)/g)) literals(m[1] ?? '').forEach((n) => names.add(n));
  }
  for (const tone of AVISO_TONES) names.add(avisoIcon(tone));
  return names;
}

test('every icon the app names exists in our own set in design/icons', () => {
  const used = usedNames();
  // The search must find the icons that are known to be used, fixed and chosen at run time.
  for (const known of ['arrows-rotate', 'espera', 'pause', 'file-pdf', 'squares', 'minus', 'at', 'exclamation-triangle-filled']) {
    assert.ok(used.has(known), `no use of "${known}" was found`);
  }
  assert.ok(used.size >= 30, `only ${used.size} names were found`);
  assert.deepEqual([...used].filter((name) => !(name in ICONS)).sort(), []);
});

test('the Icon component reads our own set and does not depend on another icon set', () => {
  const icon = sources().find(([name]) => name === 'components/Icon.tsx')?.[1] ?? '';
  assert.match(icon, /from '@nightmail\/icons'/);
  assert.doesNotMatch(icon, /from '@(?!nightmail\/)|<use\b/);
});
