// No text in the app comforts with "no se ha cambiado / perdido / tocado nada". Money sentences
// ("No se ha pagado nada.") are still allowed: they answer "have I been charged?".
// The rules hold in both languages (the Spanish word rules read everything except `i18n/en/`, the
// English ones only `i18n/en/`), and outside `src/i18n/` no hand-written text remains.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

/** Paths always with "/" (also on Windows), so folder filters (`/i18n/en/`, `/bindings/`) work the same. */
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? files(p) : /\.tsx?$/.test(e.name) ? [p.split(sep).join('/')] : [];
  });
}

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const SRC = join(import.meta.dirname, '../src');
/** The English texts: the Spanish word guards do not read them, the English ones read only them. */
const isEnglish = (f: string) => f.includes('/i18n/en/');

test('the app texts carry no comforting phrases', () => {
  // "Sigue guardada. Repetirla no paga..." (stillPending) is about money and does not fall: only "sigue(n) [guardado y] cifrado(s)".
  const bad =
    /no (se )?ha (cambiado|perdido|tocado|borrado|enviado|guardado) nada|\bno cambian?\b|siguen funcionando|\bsiguen? (guardad[oa]s? y )?cifrad/i;
  for (const f of files(SRC)) {
    if (f.includes('/bindings/') || isEnglish(f)) continue;
    assert.doesNotMatch(stripComments(readFileSync(f, 'utf8')), bad, f);
  }
});

// The light is seen, not named. Any form of "encender", "brillar" or "apagar", "luces" and "la/tu/su/una luz".
// `\w` does not cover accents: hence the stems go without them ("enciénd..." separately). Comments do not count, and the
// light's code modes ('encendida', 'apagada', in loose quotes) are removed before searching.
const LIGHT = /\b(encend|enciend|enciénd|brill|apag)\w*|\bluces\b|\b(la|tu|su|una) luz\b/i;
const codeModes = (s: string) => s.replace(/(['"])(encendida|apagada)\1/g, '');

test('the light guard catches the variants and not the code names', () => {
  for (const s of ['Dirección encendida', 'Enciende tu primera', 'enciéndela', 'Brilla por su cuenta', 'brilló', 'se apagará', 'Tus luces', 'verás su luz']) {
    assert.match(s, LIGHT, s);
  }
  for (const s of ["<Luz mode={x ? 'late' : 'apagada'} />", "mode = 'encendida'", 'nm-luz nm-luz--late', 'luzClass(mode)', 'Lumbre']) {
    assert.doesNotMatch(codeModes(s), LIGHT, s);
  }
});

test('the app texts do not name the light', () => {
  for (const f of files(SRC)) {
    if (f.includes('/bindings/') || isEnglish(f)) continue;
    assert.doesNotMatch(codeModes(stripComments(readFileSync(f, 'utf8'))), LIGHT, f);
  }
});

// Rule: no visible text carries ";", "//" or the em dash (they read as machine-written). The real texts are read with
// the TypeScript parser (strings, templates and JSX text; comments do not count). What is code (CSS, the CSP, URLs, a
// `split(';')`) does not fall: a text's ";" comes after a letter, a digit, a closing mark or a quote and before a
// space or the end of the chunk, and a text's "//" stands alone, not after "http:".
const PROSE_SEMICOLON = /[\p{L}\p{N})»…'"];(\s|$)/u;
// After a substitution (`${...}`, `{...}`) or a JSX tag the next chunk starts with the sentence's ";".
const LEADING_SEMICOLON = /^\s*;(\s|$)/;
const PROSE_SLASHES = /(^|\s)\/\/(\s|$)/;
const EM_DASH = /—/;
// And the en dash " – ": whoever cannot put the em dash puts it instead. In both languages.
const EN_DASH = /–/;
// CSS ("margin: 0; padding: 0") or CSP ("default-src 'none'; img-src ..."): each chunk between ";" is a declaration.
const DECLARATION = String.raw`\s*(?:[a-z-]+\s*:[^;]*|[a-z]+(?:-[a-z]+)+\s[^;]*)`;
const CODE = new RegExp(String.raw`^(?:${DECLARATION};)*${DECLARATION};?\s*$`);

function isFaulty(node: ts.StringLiteral | ts.TemplateLiteralLikeNode | ts.JsxText): boolean {
  const text = node.text;
  const follows = ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node);
  return (
    (PROSE_SEMICOLON.test(text) && !CODE.test(text)) ||
    (follows && LEADING_SEMICOLON.test(text)) ||
    PROSE_SLASHES.test(text) ||
    EM_DASH.test(text) ||
    EN_DASH.test(text)
  );
}

/** The texts of `code` (strings, templates and JSX text), without comments or import paths. */
function proseNodes(file: string, code: string): (ts.StringLiteral | ts.TemplateLiteralLikeNode | ts.JsxText)[] {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: (ts.StringLiteral | ts.TemplateLiteralLikeNode | ts.JsxText)[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateLiteralToken(node) || ts.isJsxText(node)) {
      out.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** The texts of `code` that break the rule. */
const proseFaults = (file: string, code: string): string[] => proseNodes(file, code).filter(isFaulty).map((n) => n.text);

/** The texts of `code` that match `re`. */
const textsMatching = (file: string, code: string, re: RegExp): string[] =>
  proseNodes(file, code)
    .filter((n) => re.test(n.text))
    .map((n) => n.text);

/** The app's texts (outside `bindings/`) that match `re`, with their file. */
function appTextsMatching(re: RegExp): string[] {
  const sources = files(join(import.meta.dirname, '../src')).filter((f) => !f.includes('/bindings/'));
  assert.ok(sources.length > 0, 'the app files were read');
  return sources.flatMap((f) => textsMatching(f, readFileSync(f, 'utf8'), re).map((t) => `${f}: ${t}`));
}

// "ronda" is contract jargon (it says how long it usually takes, without rounds or their numbers) and the
// section of what did not finish being created is called "En proceso", not "A medias".
const ROUND = /\brondas?\b/i;
const HALF_DONE = /\ba\s+medias\b/i;
// And the mailbox's second step is "activar" the name: no form of "revelar" (revelando, revelado, revélalo...).
const REVEAL = /\brev[eé]l/i;

test('the "ronda", "a medias" and "revelar" guards catch every kind of text and not comments', () => {
  const found = (code: string, re: RegExp) => textsMatching('caso.tsx', code, re).length > 0;
  const cases: [string, RegExp][] = [
    ['la ronda 7', ROUND],
    ['Dos rondas', ROUND],
    ['A medias', HALF_DONE],
    ['a  medias', HALF_DONE],
    ['Revelando el nombre', REVEAL],
    ['falta revelarlo', REVEAL],
    ['Revélalo', REVEAL],
  ];
  const tick = '`';
  for (const [words, re] of cases) {
    assert.ok(found(`const t = ${JSON.stringify(words)};`, re), `literal: ${words}`);
    assert.ok(found(`const t = ${tick}${words}${tick};`, re), `template: ${words}`);
    assert.ok(found(`const t = ${tick}x \${n} ${words}${tick};`, re), `template chunk: ${words}`);
    assert.ok(found(`const t = <p>{n} ${words}</p>;`, re), `JSX: ${words}`);
    assert.ok(!found(`// ${words}\nconst t = 1;`, re), `comment: ${words}`);
  }
  assert.ok(!found("const t = 'redonda';", ROUND));
  assert.ok(!found("const t = 'remedias';", HALF_DONE));
  assert.ok(!found("const t = 'Activando el nombre';", REVEAL));
});

test('no app text says "revelar"', () => {
  assert.deepEqual(appTextsMatching(REVEAL), []);
});

test('no app text talks about "rondas"', () => {
  assert.deepEqual(appTextsMatching(ROUND), []);
});

test('no app text says "a medias"', () => {
  assert.deepEqual(appTextsMatching(HALF_DONE), []);
});

test('the ";", "//" and "—" guard catches prose and lets code pass', () => {
  const faulty = (code: string) => proseFaults('caso.tsx', code).length > 0;
  const literal = (s: string) => `const t = ${JSON.stringify(s)};`;
  const prose = [
    'Termina la restauración; después podrás',
    'arráncala;',
    '(el indexer no contesta); la',
    'Pulsa "Actualizar"; luego',
    "Pulsa 'Actualizar'; luego",
    'uno // otro',
    'uno — otro',
    'uno – otro',
    // And in English.
    'Try again; then wait',
    "It's saved;",
    'Press "Refresh"; then',
    'one // two',
    'one — two',
    'one – two',
    'one–two',
  ];
  for (const s of prose) assert.ok(faulty(literal(s)), s);
  // The ";" right after a substitution or a tag, and the dash written as an entity in JSX (the parser decodes it).
  const split = [
    'const t = `termínalo con ${b}; si no`;',
    'const t = <p>Hay {n}; vuelve</p>;',
    'const t = <p><b>esto</b>; vuelve</p>;',
    'const t = <p>uno &mdash; otro</p>;',
    'const t = <p title="uno &mdash; otro" />;',
    'const t = <p>one &ndash; two</p>;',
    'const t = `finish it with ${b}; if not`;',
    'const t = <p>There are {n}; go back</p>;',
  ];
  for (const code of split) assert.ok(faulty(code), code);
  const code = [
    ';',
    ';base64,',
    "default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'",
    'img{max-width:100%;height:auto}',
    'margin: 0; padding: 0',
    'display: block; color: red',
    'http://',
    '://',
  ];
  for (const s of code) assert.ok(!faulty(literal(s)), s);
  assert.ok(!faulty('const t = `data:${mime};base64,${data}`;'));
});

test('no app text carries ";", "//", "—" or "–" (Spanish and English)', () => {
  const sources = files(SRC);
  // The guard reaches both dictionaries.
  for (const dir of ['/i18n/es/', '/i18n/en/']) assert.ok(sources.some((f) => f.includes(dir)), dir);
  for (const f of sources) {
    if (f.includes('/bindings/')) continue;
    assert.deepEqual(proseFaults(f, readFileSync(f, 'utf8')), [], f);
  }
});

// --- English: the same rules as in Spanish, with their words -------------------------------

/** Is `node` a text that is not shown? An object or type key, or a literal type ("'de pago' | 'gratis'"). */
function isKey(node: ts.Node): boolean {
  const p = node.parent;
  if (!p) return false;
  if (ts.isLiteralTypeNode(p) || ts.isComputedPropertyName(p)) return true;
  return (
    (ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isEnumMember(p)) &&
    p.name === node
  );
}

/** The texts of `code` that can be shown (without keys or types). */
const visibleTexts = (file: string, code: string): string[] =>
  proseNodes(file, code)
    .filter((n) => !isKey(n))
    .map((n) => n.text);

/** The texts of the English dictionaries, with their file. */
function englishTexts(): { file: string; text: string }[] {
  const sources = files(SRC).filter(isEnglish);
  assert.ok(sources.length > 0, 'the English dictionaries were read');
  return sources.flatMap((file) => visibleTexts(file, readFileSync(file, 'utf8')).map((text) => ({ file, text })));
}

// Comfort: "nothing was changed / lost...", "doesn't change", "keeps working", "still encrypted" (the Spanish "no cambia", "siguen
// funcionando" and "sigue cifrado"). Money sentences ("Nothing has been paid.") are still allowed.
const EN_CONSOLATION =
  /\bnothing (was|has been|got|is) (changed|lost|touched|deleted|sent|saved)\b|\b(doesn't|don't|does not|do not|won't|will not) change\b|\b(keeps?|still) working\b|\bstill works?\b|\b(still|stays?|remains?) (saved and )?encrypted\b/i;
// The light is seen, not named: "light(s)", "lit", "glow", "shine", "switch/turn on/off". "lightweight",
// "highlight" and "Switch to the paid plan" do not fall.
const EN_LIGHT = /\b(lights?|lit|glow\w*|shin(e|es|ing|y)|shone|(switch|turn)(es|ed|ing|s)? (it |them )?(on|off))\b/i;
// The only exception: the name of the light theme in Settings ("Light", like "Claro").
const EN_LIGHT_ALLOWED = new Set(['Light']);
const EN_ROUND = /\brounds?\b/i;
const EN_HALF_DONE = /\bhalf[- ]?(done|finished|made)\b|\bhalfway\b/i;
const EN_REVEAL = /\breveal/i;

test('the English word guards catch what they should and let look-alikes pass', () => {
  const hits: [string, RegExp][] = [
    ['Nothing was changed.', EN_CONSOLATION],
    ['Nothing has been lost', EN_CONSOLATION],
    ["Your mail doesn't change", EN_CONSOLATION],
    ['The rest keeps working', EN_CONSOLATION],
    ['Your messages are still encrypted', EN_CONSOLATION],
    ['still saved and encrypted', EN_CONSOLATION],
    ['Your lights', EN_LIGHT],
    ['It lit up', EN_LIGHT],
    ['It glows', EN_LIGHT],
    ['glowing', EN_LIGHT],
    ['It shines on its own', EN_LIGHT],
    ['switch it on', EN_LIGHT],
    ['It turned off', EN_LIGHT],
    ['the light', EN_LIGHT],
    ['round 7', EN_ROUND],
    ['Two rounds', EN_ROUND],
    ['Half-done', EN_HALF_DONE],
    ['half done', EN_HALF_DONE],
    ['halfway', EN_HALF_DONE],
    ['Revealing the name', EN_REVEAL],
    ['reveal it', EN_REVEAL],
  ];
  for (const [s, re] of hits) assert.match(s, re, s);
  const misses: [string, RegExp][] = [
    ['Nothing has been paid.', EN_CONSOLATION],
    ['Nothing has been paid or sent this time.', EN_CONSOLATION],
    ["It's still saved. Repeating it won't pay twice.", EN_CONSOLATION],
    ['lightweight', EN_LIGHT],
    ['highlight', EN_LIGHT],
    ['Switch to the paid plan', EN_LIGHT],
    ['Turn back', EN_LIGHT],
    ['around', EN_ROUND],
    ['background', EN_ROUND],
    ['half of it', EN_HALF_DONE],
    ['Activating the name', EN_REVEAL],
  ];
  for (const [s, re] of misses) assert.doesNotMatch(s, re, s);
  // Keys ("'stale-reservation': ...") and types are not shown texts. Comments are not either.
  const code = "const x = { 'stale-reservation': 'too late', 'wrong-reveal': 'no match' };\n// round\ntype K = 'round';";
  assert.deepEqual(visibleTexts('caso.ts', code), ['too late', 'no match']);
});

test('no English text comforts, names the light, or says "round", "half-done" or "reveal"', () => {
  const bad = englishTexts().filter(
    ({ text }) =>
      EN_CONSOLATION.test(text) ||
      (EN_LIGHT.test(text) && !EN_LIGHT_ALLOWED.has(text)) ||
      EN_ROUND.test(text) ||
      EN_HALF_DONE.test(text) ||
      EN_REVEAL.test(text),
  );
  assert.deepEqual(bad, []);
});

// Nothing from Spanish leaks into English: no accents, no "ñ", no "¿ ¡", no guillemets. Only "Español", which the language
// selector always writes in its own language.
const SPANISH_MARKS = /[áéíóúüñÁÉÍÓÚÜÑ¿¡«»]/;
const SPANISH_ALLOWED = new Set(['Español']);

test('the English dictionaries carry no Spanish letters or quotes', () => {
  assert.match('¿Seguro?', SPANISH_MARKS);
  assert.match('«Archivo»', SPANISH_MARKS);
  assert.match('Contraseña', SPANISH_MARKS);
  assert.doesNotMatch('"Archive"', SPANISH_MARKS);
  const bad = englishTexts().filter(({ text }) => SPANISH_MARKS.test(text) && !SPANISH_ALLOWED.has(text));
  assert.deepEqual(bad, []);
});

// --- Hand-written texts outside `src/i18n/` -----------------------------------------------------------------

/** JSX attributes that are read or heard: a fixed text in them does not change language. */
const LABEL_ATTRS = new Set([
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'title',
  'placeholder',
  'alt',
  'label',
  'legend',
  'note',
]);
/** The same in both languages: brands, units and proper names (glossary: NIGHT, DUST, NightMail token, Night Plus,
 *  Midnight, NightMail, Proof server are not translated, see `src/i18n/brand.ts`). "de pago" is the bono type code in
 *  `payment.ts` (not shown). */
const SAME_IN_BOTH = new Set([
  'NightMail',
  'Midnight',
  'NIGHT',
  'DUST',
  'NightMail token',
  'Night Plus',
  'Proof server',
  'Aa',
  'B',
  'KB',
  'MB',
  'de pago',
]);
/** A list of CSS classes: each word carries a hyphen ("nm-btn", "button-small", "w-full") or is a bare class. */
const CLASS_WORD = /^(?:[a-z]\w*(?:-|__)[\w-]*|button|field)$/;
const isClassList = (s: string) => s.trim() !== '' && s.trim().split(/\s+/).every((w) => CLASS_WORD.test(w));
/** Code and not prose: CSS or CSP (`CODE`), rules with braces, HTML, a media query or a URL. */
const isCodeText = (s: string) =>
  CODE.test(s) || /[{}<>]/.test(s) || /^\([a-z-]+\s*:[^)]*\)$/.test(s) || /^[a-z][a-z+.-]*:\/\//.test(s) || isClassList(s);
/** The BIP-39 word list of `seedCheck.ts`: the phrase's words, in English in both languages. */
const isWordList = (s: string) => s.startsWith('abandon ability able about ');

/** DOM methods whose argument is a CSS selector, not a text. */
const SELECTOR_CALLS = /\.(querySelector|querySelectorAll|matches|closest)$/;

/** Is `node` inside a log (`console.*`), a `new ...Error(...)` (logs stay in Spanish) or
 *  the selector of `querySelector`/`matches`/`closest`? A call like `setError(...)` or `describeError(...)` does NOT count:
 *  what it receives can end up on screen. */
function isDeveloperText(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isCallExpression(n) && /^console\./.test(n.expression.getText())) return true;
    if (ts.isNewExpression(n) && /^([A-Z]\w*)?Error$/.test(n.expression.getText())) return true;
    if (ts.isCallExpression(n) && SELECTOR_CALLS.test(n.expression.getText())) return true;
    if (ts.isStatement(n) || ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) return false;
  }
  return false;
}

/** JSX attributes that carry code and not text: classes, types, icon and tone names, paths, ids, measures, the
 *  SVG ones... The others (`intro`, `title`, `text`, a new one of a component) are read as text that may be shown. */
const CODE_ATTRS = new Set([
  'className', 'class', 'role', 'type', 'name', 'icon', 'tone', 'mode', 'state', 'size', 'dir', 'where', 'columns', 'paso',
  'id', 'key', 'ref', 'href', 'src', 'srcDoc', 'rel', 'target', 'sandbox', 'allow', 'referrerPolicy', 'loading', 'decoding',
  'lang', 'htmlFor', 'form', 'method', 'action', 'autoComplete', 'inputMode', 'enterKeyHint', 'spellCheck',
  'autoCapitalize', 'autoCorrect', 'accept', 'pattern', 'tabIndex', 'style', 'width', 'height', 'min', 'max', 'step',
  // SVG.
  'd', 'viewBox', 'xmlns', 'fill', 'stroke', 'strokeWidth', 'strokeLinecap', 'strokeLinejoin', 'fillRule', 'clipRule',
  'points', 'transform', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'focusable', 'preserveAspectRatio',
]);
/** Does attribute `name` carry code? Those in `CODE_ATTRS`, the `data-*`, the `on...` and the `aria-*` that are not read
 *  (`aria-hidden`, `aria-live`, `aria-controls`...: states and ids). */
const isCodeAttr = (name: string) =>
  CODE_ATTRS.has(name) || name.startsWith('data-') || /^on[A-Z]/.test(name) || (name.startsWith('aria-') && !LABEL_ATTRS.has(name));

/** Does JSX show it? If `node` (a string) reaches a JSX `{...}` as its value (directly, in parentheses, in a branch
 *  of `?:`, on one side of `??` or `||`, or to the right of `&&`), it returns where: the attribute name, or `''` if it is a
 *  child (`<p>{busy ? 'Saving' : 'Save'}</p>`). If not (a `?:` condition, a function argument), `null`. */
function jsxSlot(node: ts.Node): string | null {
  let n = node;
  for (let p = n.parent; p; n = p, p = p.parent) {
    if (ts.isParenthesizedExpression(p)) continue;
    if (ts.isConditionalExpression(p) && p.condition !== n) continue;
    if (ts.isBinaryExpression(p)) {
      const op = p.operatorToken.kind;
      if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) continue;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken && p.right === n) continue;
      return null;
    }
    if (ts.isJsxExpression(p)) return p.parent && ts.isJsxAttribute(p.parent) ? p.parent.name.getText() : '';
    return null;
  }
  return null;
}

/** Does it look like prose? Letters with a space between words (or stuck to a substitution, and no line breaks: a
 *  PNG's signature is not prose), or a Spanish mark. A lone word without an accent ("Retry") does not: the heuristic cannot tell it
 *  from a code ('mailbox'). */
const looksLikeProse = (text: string) =>
  (/\p{L}/u.test(text) && /\S[ \u00a0]+\S|\p{L}[ \u00a0]+$|^[ \u00a0]+\p{L}/u.test(text)) || SPANISH_MARKS.test(text);

/** The texts shown or heard that are hand-written in `code` (they should come from `t()`), with their line. */
function hardcodedTexts(file: string, code: string): string[] {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const hit = (node: ts.Node, text: string) => out.push(`${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${text}`);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isJsxText(node)) {
      const text = node.text.trim();
      if (/\p{L}/u.test(text) && !SAME_IN_BOTH.has(text)) hit(node, text);
    } else if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
      // Quoted: the code ones (`className="..."`, `href="..."`) do not count. In those that are read (`LABEL_ATTRS`) a
      // single word falls too; in the others (`intro="..."`, a new one of a component), prose.
      const name = node.name.getText();
      const text = node.initializer.text.trim();
      const shown = LABEL_ATTRS.has(name) ? /\p{L}/u.test(text) : looksLikeProse(text) && !isCodeText(text);
      if (!isCodeAttr(name) && shown && !SAME_IN_BOTH.has(text)) hit(node, text);
      return;
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateLiteralToken(node)) {
      const text = node.text;
      const slot = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? jsxSlot(node) : null;
      if (slot !== null) {
        // JSX shows it (`title={open ? 'Close' : 'Open'}`, `{busy ? 'Saving' : 'Save'}`): a single word falls too,
        // except in a code attribute (`className={on ? 'nm-a' : 'nm-b'}`) or if it is code or a brand.
        const shown = text.trim();
        if (!isCodeAttr(slot) && /\p{L}/u.test(shown) && !SAME_IN_BOTH.has(shown) && !isCodeText(shown)) hit(node, text);
      } else if (looksLikeProse(text) && !isKey(node) && !SAME_IN_BOTH.has(text.trim()) && !isCodeText(text) && !isWordList(text) && !isDeveloperText(node)) {
        hit(node, text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

test('the hand-written text guard catches prose and lets code and brands pass', () => {
  const found = (code: string) => hardcodedTexts('caso.tsx', code).length > 0;
  const prose = [
    'const t = <p>Hola</p>;',
    'const t = <p>{n} messages</p>;',
    'const t = <button aria-label="Cerrar" />;',
    'const t = <input placeholder="Search" />;',
    'const t = <img alt="The night" />;',
    'const t = <Campo label="Password" />;',
    "const t = 'Try again';",
    "const t = 'Sí';",
    'const t = `${n} mensajes`;',
    'const t = `Hay ${n}`;',
    "const t = { title: 'Retry now' };",
    "const t = cond ? 'sin pagar' : 'gratis';",
    "setError('Hola mundo');",
    "const t = <button aria-label={'Close'} />;",
    "const t = <button title={`Close`} />;",
    // Any attribute that is not code, and a lone word that JSX shows.
    'const t = <Page intro="Cada dirección es independiente" />;',
    'const t = <Page intro="Each address is separate" />;',
    "const t = <button title={open ? 'Close' : 'Open'} />;",
    "const t = <p>{busy ? 'Saving' : 'Save'}</p>;",
    "const t = <p>{name ?? 'Unnamed'}</p>;",
    "const t = <p>{name || ('Unnamed')}</p>;",
    "const t = <p>{busy && 'Saving'}</p>;",
    "const t = <Tag text={x ? y : 'Ready'} />;",
  ];
  for (const code of prose) assert.ok(found(code), code);
  const code = [
    'const t = <p>{t().inbox.empty}</p>;',
    'const t = <p>NIGHT</p>;',
    'const t = <p> · </p>;',
    'const t = <Logo alt="NightMail" />;',
    'const t = <img alt="" />;',
    'const t = <PartTitle label="Proof server" />;',
    'const t = <a className="button button-small nm-btn" href="https://example.org/a b" />;',
    "const c = 'nm-luz nm-luz--late';",
    'const c = `nm-punto nm-punto--${tone}`;',
    "const c = 'field w-full';",
    "const c = 'margin: 0; padding: 0';",
    "const c = 'body{margin:16px;font:15px/1.55 system-ui}';",
    "const q = '(prefers-color-scheme: dark)';",
    "console.warn('no se pudo leer la preferencia', e);",
    "throw new Error('estado imposible del núcleo');",
    "const e = new TypeError('no es un número');",
    "const b = root.querySelector('button[aria-busy] .nm-btn');",
    "if (el.matches('a, button')) go();",
    "const c = el.closest('.nm-fila .nm-lista');",
    "const t = <a href={'https://example.org'} className={'nm-a nm-b'} />;",
    '// Hola mundo\nconst t = 1;',
    "const x = { 'Hola mundo': 1 };",
    "type K = 'de pago' | 'gratis';",
    "import x from 'algo raro.ts';",
    // Code attributes, with quotes or braces (also through `?:`), and a `?:` condition is not what is seen.
    "const t = <Icon name={open ? 'chevron-up' : 'chevron-down'} className={on ? 'activa' : 'quieta'} />;",
    "const t = <Luz mode={x ? 'late' : 'apagada'} tone={ok ? 'exito' : 'peligro'} />;",
    'const t = <input type={shown ? "text" : "password"} role="button group" autoComplete="new password" />;',
    'const t = <svg viewBox="0 0 24 24"><path d="M12 2 L4 5 v6 c0 5 3 9 8 11" fill="none" /></svg>;',
    "const t = <p data-nm-abandon=\"una cosa\" aria-hidden=\"true\" aria-live={x ? 'polite' : 'off'} />;",
    "const t = <p>{kind === 'mailbox' ? n : m}</p>;",
    "const t = <p>{f('mailbox')}</p>;",
    "const t = <p>{x ? 'nm-a nm-b' : null}</p>;",
  ];
  for (const c of code) assert.ok(!found(c), c);
});

test('no text that is seen or heard is hand-written outside src/i18n/ (everything goes through t())', () => {
  const sources = files(SRC).filter((f) => !f.includes('/bindings/') && !f.includes('/i18n/'));
  assert.ok(sources.some((f) => f.endsWith('.tsx')) && sources.some((f) => f.endsWith('.ts')), 'reads .ts and .tsx');
  const bad = sources.flatMap((f) => hardcodedTexts(f, readFileSync(f, 'utf8')).map((s) => `${f}:${s}`));
  assert.deepEqual(
    bad,
    [],
    'Hand-written text outside src/i18n/: move it to the dictionaries (src/i18n/{es,en}/) and read it with t(). If it is ' +
      'code or a brand that is the same in both languages, add it to SAME_IN_BOTH (or to isCodeText / isDeveloperText) in ' +
      'test/textos.test.ts, with a comment that says why.',
  );
});

// --- The tests pin the language --------------------------------------------------------------------------------

test('every test file (except i18n.test.ts) imports ./idioma-es.ts first', () => {
  const dir = import.meta.dirname;
  const tests = readdirSync(dir).filter((f) => f.endsWith('.test.ts') && f !== 'i18n.test.ts');
  assert.ok(tests.length > 1);
  const bad = tests.filter((f) => {
    const source = ts.createSourceFile(f, readFileSync(join(dir, f), 'utf8'), ts.ScriptTarget.Latest, true);
    const first = source.statements.find(ts.isImportDeclaration);
    return !first || !ts.isStringLiteral(first.moduleSpecifier) || first.moduleSpecifier.text !== './idioma-es.ts' || first.importClause !== undefined;
  });
  assert.deepEqual(bad, []);
});
