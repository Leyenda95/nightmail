// Pure rules of the base pieces: `node --test test/*.test.ts`.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { AVISO_TONES, avisoClass, avisoIcon, avisoRole, classes, describedBy, INFO_TIP_IDLE, infoTip, LUZ_MODES, luzClass, TAG_TONES, tagClass } from '../src/pieces.ts';

// `app.css` without comments: a class "exists" if some selector names it whole.
const css = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const missing = (names: Iterable<string>) => [...new Set(names)].filter((name) => !new RegExp(`\\.${name}(?![\\w-])`).test(css));

test('the classes the rules build (tones, light, tags) all exist in app.css', () => {
  const made = [
    ...AVISO_TONES.flatMap((tone) => [avisoClass(tone), avisoClass(tone, true)]),
    // One position more than there are rhythms, to pass through the wrap to the first.
    ...LUZ_MODES.flatMap((mode) => [0, 1, 2, 3, 4, 5].map((rhythm) => luzClass(mode, rhythm))),
    tagClass(),
    ...TAG_TONES.map((tone) => tagClass(tone)),
  ];
  assert.deepEqual(missing(made.flatMap((list) => list.split(' '))), []);
  // The checker itself tells apart a class that is not there (and is not satisfied with a prefix).
  assert.deepEqual(missing(['nm-luz--late-6', 'nm-avis']), ['nm-luz--late-6', 'nm-avis']);
});

test('the nm-* classes written by hand in the pieces, in App.tsx and in the screens all exist in app.css', () => {
  const dir = new URL('../src/components/', import.meta.url);
  const screens = new URL('../src/screens/', import.meta.url);
  const files = [
    new URL('../src/App.tsx', import.meta.url),
    ...readdirSync(dir).filter((f) => f.endsWith('.tsx')).map((f) => new URL(f, dir)),
    ...readdirSync(screens).filter((f) => f.endsWith('.tsx')).map((f) => new URL(f, screens)),
  ];
  // `data-nm-*` attributes are not classes.
  const written = files.flatMap((file) => readFileSync(file, 'utf8').match(/(?<!data-)\bnm-[a-z0-9]+(?:(?:__|--|-)[a-z0-9]+)*/g) ?? []);
  assert.ok(written.includes('nm-dialogo__pie') && written.includes('nm-centro__caja'), 'the pieces were not read');
  assert.ok(written.includes('nm-portada__caja'), 'the screens were not read');
  assert.deepEqual(missing(written), []);
});

test('avisoClass and tagClass: the base class and, when needed, the tone and stripe ones', () => {
  assert.equal(avisoClass('error'), 'nm-aviso nm-aviso--error');
  assert.equal(avisoClass('info', true), 'nm-aviso nm-aviso--info nm-aviso--franja');
  assert.equal(tagClass(), 'nm-tag');
  assert.equal(tagClass('exito'), 'nm-tag nm-tag--exito');
});

test('classes: joins the present classes and skips the empty ones', () => {
  assert.equal(classes('nm-aviso', 'nm-aviso--error'), 'nm-aviso nm-aviso--error');
  assert.equal(classes('nm-aviso', false, undefined, null, '', 'nm-aviso--franja'), 'nm-aviso nm-aviso--franja');
  assert.equal(classes(), '');
});

test('describedBy: the present messages, or nothing if there are none', () => {
  assert.equal(describedBy('ayuda', 'error'), 'ayuda error');
  assert.equal(describedBy(false, 'error', null), 'error');
  // With no messages the attribute is not written (an `aria-describedby=""` points at nothing).
  assert.equal(describedBy(false, undefined), undefined);
});

test('avisoIcon: each tone has its own icon', () => {
  assert.equal(avisoIcon('error'), 'exclamation-circle');
  assert.equal(avisoIcon('atencion'), 'exclamation-triangle-filled');
  assert.equal(avisoIcon('exito'), 'checkmark-circle');
  assert.equal(avisoIcon('info'), 'info-circle');
});

test('avisoRole: what interrupts is announced at once, the rest waits its turn', () => {
  assert.equal(avisoRole('error'), 'alert');
  assert.equal(avisoRole('atencion'), 'alert');
  assert.equal(avisoRole('exito'), 'status');
  assert.equal(avisoRole('info'), 'status');
});

test('luzClass: on by default, off, working and flash by their class', () => {
  assert.equal(luzClass(), 'nm-luz');
  assert.equal(luzClass('encendida'), 'nm-luz');
  assert.equal(luzClass('apagada'), 'nm-luz nm-luz--apagada');
  assert.equal(luzClass('trabaja'), 'nm-luz nm-luz--trabaja');
  assert.equal(luzClass('destello'), 'nm-luz nm-luz--destello');
});

test('luzClass: each address pulses with its own rhythm, by class (no computed styles)', () => {
  assert.equal(luzClass('late'), 'nm-luz nm-luz--late');
  assert.equal(luzClass('late', 0), 'nm-luz nm-luz--late');
  assert.equal(luzClass('late', 1), 'nm-luz nm-luz--late nm-luz--late-2');
  assert.equal(luzClass('late', 4), 'nm-luz nm-luz--late nm-luz--late-5');
  // There are only five rhythms in app.css: from the sixth address on they repeat.
  assert.equal(luzClass('late', 5), 'nm-luz nm-luz--late');
  assert.equal(luzClass('late', 6), 'nm-luz nm-luz--late nm-luz--late-2');
});

test('luzClass: the rhythm only counts when it pulses, and an odd position does not invent classes', () => {
  assert.equal(luzClass('apagada', 3), 'nm-luz nm-luz--apagada');
  assert.equal(luzClass('late', -1), 'nm-luz nm-luz--late');
  assert.equal(luzClass('late', 2.7), 'nm-luz nm-luz--late nm-luz--late-3');
  assert.equal(luzClass('late', Number.NaN), 'nm-luz nm-luz--late');
});

test('app.css: the unread badge is a rectangle taller than wide (neither pill nor square)', () => {
  const rule = css.match(/\.nm-fila__num \{([^}]*)\}/)?.[1] ?? '';
  // Like the base .navigation-counter-item: 20 px high, 4 px margin each side of the figure
  // (about 15 px wide with one digit) and 4 px radius. No minimum width: it grows sideways with more digits.
  assert.doesNotMatch(rule, /min-inline-size/);
  assert.match(rule, /padding-inline: 0\.25rem;/);
  assert.match(rule, /border-radius: 0\.25rem;/);
  assert.match(rule, /line-height: 1\.25rem;/);
  assert.match(rule, /font-size: 0\.6875rem;/);
  assert.match(rule, /font-weight: var\(--nm-font-weight-bold\);/);
});

test('infoTip: shows on mouse or focus, Escape hides it without removing focus and it comes back after leaving both', () => {
  let s = INFO_TIP_IDLE;
  assert.equal(s.shown, false);
  s = infoTip(s, 'focus');
  assert.equal(s.shown, true, 'with focus on the button');
  s = infoTip(s, 'escape');
  assert.deepEqual([s.shown, s.focused], [false, true], 'Escape hides it and focus stays');
  s = infoTip(s, 'enter');
  assert.equal(s.shown, false, 'hovering does not reopen it while it stays closed');
  s = infoTip(infoTip(s, 'leave'), 'blur');
  assert.equal(s.dismissed, false, 'without mouse or focus the dismissal is forgotten');
  s = infoTip(s, 'enter');
  assert.equal(s.shown, true, 'open with the mouse only');
  s = infoTip(s, 'escape');
  assert.equal(s.shown, false, 'Escape also closes the one opened with the mouse (WCAG 1.4.13)');
  assert.equal(infoTip(s, 'leave').dismissed, false);
  assert.equal(infoTip(INFO_TIP_IDLE, 'escape'), INFO_TIP_IDLE, 'closed, Escape changes nothing');
});

test('the closed explanation class exists in app.css', () => {
  assert.deepEqual(missing(['nm-info--abierta']), []);
});
