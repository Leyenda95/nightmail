// Tests of the interface's pure logic (no DOM): `node --test test/*.test.ts`.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { describeError, ERROR_CODES, errorParts, isBadConfig, isBootFailure, isProfileInUse, joinParts } from '../src/errors.ts';
import { senderAddress, formatDateTime, formatDust, formatNight, formatSize, recoveryFacts, seedWordCount, seedWords, slotKindName, slotLabel } from '../src/format.ts';
import type { Progress } from '../src/bindings/Progress.ts';
import type { WalletView } from '../src/bindings/WalletView.ts';
import { cannotPay, dustSetupLine, faucetBlocked } from '../src/payment.ts';
import { buildSrcDoc, cidImage, isAllowedImageSrc, isCidSrc, isRiskyCss, READER_CSP } from '../src/srcdoc.ts';
import { progressParts } from '../src/progress.ts';
import { prefs } from '../src/prefs.ts';

test('errorParts: what happened, what is still safe and what you can do, in that order', () => {
  assert.deepEqual(errorParts({ code: 'wrongPassword' }), {
    what: 'Contraseña incorrecta.',
    safe: null,
    action: 'Vuelve a intentarlo.',
  });
  // Whoever consumes a text today receives the three parts in a row, in that order.
  assert.equal(describeError({ code: 'wrongPassword' }), 'Contraseña incorrecta. Vuelve a intentarlo.');
  assert.equal(joinParts({ what: 'Qué.', safe: null, action: 'Haz.' }), 'Qué. Haz.');
  assert.equal(joinParts({ what: 'Qué.', safe: 'A salvo.', action: null }), 'Qué. A salvo.');
});

test('describeError: simple codes and those of the three layers', () => {
  assert.match(describeError({ code: 'nameTaken' }), /en uso/);
  assert.match(describeError({ code: 'midnightTimeout' }), /Midnight/);
  // It passes by itself (the app retries): without "en esta versión de la app".
  assert.doesNotMatch(describeError({ code: 'midnightUnavailable' }), /versión/);
  assert.match(describeError({ code: 'midnightUnavailable' }), /Midnight/);
});

test('describeError: variants with data', () => {
  assert.match(describeError({ code: 'rateLimited', retryAfterS: 30 }), /dentro de 30 s\./);
  assert.match(describeError({ code: 'rateLimited', retryAfterS: 3600 }), /dentro de 60 min\./, 'an hour is not given in seconds');
  assert.match(describeError({ code: 'nameRejected', reason: 'reserved' }), /reservado/);
  assert.match(describeError({ code: 'insufficientFunds', asset: 'dust' }), /DUST/);
  assert.match(describeError({ code: 'midnightError', rpcCode: -32000 }), /-32000/);
  assert.match(describeError({ code: 'bonoNotReady', usableAt: null }), /aún no/);
  assert.match(describeError({ code: 'insufficientFunds', asset: 'token' }), /saldo/);
  assert.ok(describeError({ code: 'bonoNotReady', usableAt: 1_800_000_000 }).includes(formatDateTime(1_800_000_000)));
  assert.match(describeError({ code: 'callRejected', reason: 'address-taken' }), /otra dirección/);
  assert.match(describeError({ code: 'wallet', reason: 'not-synced' }), /sincroniz/);
});

test('describeError: too many attempts, with the wait in seconds or minutes', () => {
  const text = (wait: string) => `Demasiados intentos. Espera ${wait} y vuelve a probar.`;
  assert.equal(describeError({ code: 'tooManyAttempts', waitSecs: 30 }), text('30 s'));
  assert.equal(describeError({ code: 'tooManyAttempts', waitSecs: 60 }), text('60 s'));
  assert.equal(describeError({ code: 'tooManyAttempts', waitSecs: 120 }), text('2 min'));
  assert.equal(describeError({ code: 'tooManyAttempts', waitSecs: 900 }), text('15 min'));
  assert.equal(describeError({ code: 'tooManyAttempts', waitSecs: 95 }), text('2 min'), 'rounds up');
  for (const waitSecs of [undefined, 'xyz', -5, Number.NaN]) {
    assert.equal(describeError({ code: 'tooManyAttempts', waitSecs }), text('un momento'), String(waitSecs));
  }
});

test('describeError: an unknown reason or value does not leak into the text', () => {
  for (const reason of ['motivo-nuevo', 'toString', '__proto__', undefined, 7]) {
    for (const code of ['nameRejected', 'callRejected', 'wallet']) {
      assert.doesNotMatch(describeError({ code, reason }), /undefined|function|object|motivo-nuevo|\b7\b/, `${code} ${String(reason)}`);
    }
  }
  assert.doesNotMatch(describeError({ code: 'rateLimited', retryAfterS: 'xyz' }), /xyz|NaN|undefined/);
  assert.doesNotMatch(describeError({ code: 'rateLimited', retryAfterS: -5 }), /-5|NaN/);
  assert.doesNotMatch(describeError({ code: 'insufficientFunds', asset: 'xyz' }), /xyz|undefined/);
  assert.doesNotMatch(describeError({ code: 'midnightError' }), /undefined|NaN/);
});

test('describeError: never returns raw text', () => {
  const generic = 'Ha ocurrido un error inesperado. Vuelve a intentarlo.';
  assert.equal(describeError(new Error('internal secret')), generic);
  assert.equal(describeError('boom'), generic);
  assert.equal(describeError(null), generic);
  assert.equal(describeError({ code: 'codigoNuevo' }), generic);
  assert.equal(describeError({ code: 'toString' }), generic);
  assert.equal(describeError({ code: 'internal' }), generic);
  // Of what is not known, nothing is claimed to still be safe.
  assert.equal(errorParts({ code: 'codigoNuevo' }).safe, null);
});

// --- What the bindings generated by the core say. They are read as text: the tests do not go through `tsc`, so the
// exhaustiveness of `src`'s `Record`s does not protect them; this does (a new code without text fails the tests).
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
/** The values of a tagged union (`{ "code": "..." } | ...`). */
const tagged = (path: string, tag: string) => [...source(path).matchAll(new RegExp(`"${tag}": "(\\w+)"`, 'g'))].map((m) => m[1]);
/** The values of a union of strings (`export type X = "a" | "b";`). */
const union = (name: string) =>
  [...source(`../../midnight-sidecar/src/protocol/${name}.ts`).split('export type')[1].matchAll(/"([\w-]+)"/g)].map((m) => m[1]);

const CORE_CODES = ['CoreError', 'OrchError', 'CommandError', 'LinkError', 'SendError'].flatMap((n) => tagged(`../src/bindings/${n}.ts`, 'code'));
const REASONS: Record<string, string[]> = {
  nameRejected: union('NameProblem'),
  callRejected: union('CallProblem'),
  wallet: union('WalletProblem'),
};
const ASSETS = union('FundsAsset');

/** All the variants of a code: each reason in the bindings (and one this version does not know), with and without data. */
function samples(code: string): Record<string, unknown>[] {
  if (Object.hasOwn(REASONS, code)) return [...REASONS[code], 'motivo-nuevo'].map((reason) => ({ code, reason }));
  if (code === 'insufficientFunds') return [...ASSETS, 'saldo-nuevo'].map((asset) => ({ code, asset }));
  if (code === 'bonoNotReady') return [null, 1_800_000_000].map((usableAt) => ({ code, usableAt }));
  if (code === 'rateLimited') return [30, 3600].map((retryAfterS) => ({ code, retryAfterS }));
  if (code === 'midnightError') return [{ code, rpcCode: -32000 }, { code }];
  return [{ code }];
}
const ALL_ERRORS = ERROR_CODES.flatMap(samples);

test('errors: the table covers exactly the codes and reasons of the core bindings', () => {
  assert.equal(new Set(ERROR_CODES).size, ERROR_CODES.length);
  assert.deepEqual([...ERROR_CODES].sort(), [...new Set(CORE_CODES)].sort());
  assert.ok(CORE_CODES.length > 50 && REASONS.callRejected.length >= 8 && ASSETS.length >= 2, 'the bindings were read');
  // Each known reason has its text: it does not fall into that of "motivo que esta versión no conoce".
  for (const [code, reasons] of Object.entries(REASONS)) {
    const unknown = errorParts({ code, reason: 'motivo-nuevo' }).what;
    for (const reason of reasons) {
      // `other` IS the text for the unknown in `callRejected`.
      if (reason !== 'other') assert.notEqual(errorParts({ code, reason }).what, unknown, `${code} ${reason}`);
    }
  }
  for (const asset of ASSETS) {
    assert.notEqual(errorParts({ code: 'insufficientFunds', asset }).what, errorParts({ code: 'insufficientFunds', asset: 'x' }).what, asset);
  }
});

// The ONLY "safe" sentences that speak of sending, paying, charging or issuing, and with what scope (a whitelist: a code
// that starts saying it, or changes the scope, must enter here with its reason). Any other
// error can arrive after a payment or with the outcome unknown.
const MONEY_SAFE: Record<string, string[]> = {
  // Fails when starting the connection: true of NOW (a payment from another session may remain pending).
  sidecarTooOld: ['Ahora no se ha enviado ni pagado nada.'],
  // The service checks before creating the request: it holds for THAT attempt (an earlier one may have been charged).
  captchaFailed: ['Con este intento no se ha emitido ningún bono.'],
  paymentFailed: ['Este intento no ha cobrado nada.'],
  // Before building the payment, and it is only built with no other for the same bono that could land: absolute.
  priceChanged: ['No se ha pagado nada.'],
  insufficientFunds: ['No se ha pagado nada.'],
  // Reasons the wallet gives before building anything.
  wallet: ['Este intento no ha pagado nada.'],
};

test('errorParts: only the allowlist says nothing was sent, paid, charged or issued, and with its scope', () => {
  const found: Record<string, string[]> = {};
  for (const e of ALL_ERRORS) {
    const safe = errorParts(e).safe;
    if (safe === null || !/\b(enviado|pagado|cobrado|emitido)\b/i.test(safe)) continue;
    const code = e.code as string;
    found[code] = [...new Set([...(found[code] ?? []), safe])];
  }
  assert.deepEqual(found, MONEY_SAFE);
  // Within a code, only the variants that guarantee it.
  assert.equal(errorParts({ code: 'wallet', reason: 'not-open' }).safe, null, 'it also fails on save, already sent');
  assert.equal(errorParts({ code: 'wallet', reason: 'motivo-nuevo' }).safe, null);
  assert.equal(errorParts({ code: 'insufficientFunds', asset: 'saldo-nuevo' }).safe, null);
  for (const reason of ['already-open', 'in-use', 'not-synced']) {
    assert.equal(errorParts({ code: 'wallet', reason }).safe, 'Este intento no ha pagado nada.', reason);
  }
  // Busy with another program: it explains what to do instead of just inviting a repeat.
  assert.equal(
    errorParts({ code: 'wallet', reason: 'in-use' }).action,
    'Si hay otra ventana de NightMail abierta, ciérrala. Si no hay ninguna, espera un momento y vuelve a intentarlo. Si se repite, reinicia el equipo.',
  );
  assert.equal(errorParts({ code: 'wallet', reason: 'not-synced' }).action, 'Vuelve a intentarlo en un momento.');
  // No comforting sentences: these can arrive while waiting for a payment ALREADY sent, and "no se ha perdido" is not said either.
  for (const code of ['clock', 'staleState', 'serviceUnavailable', 'rateLimited']) assert.equal(errorParts({ code }).safe, null, code);
  assert.equal(
    describeError({ code: 'serviceUnavailable' }),
    'El servicio no está disponible ahora mismo. Vuelve a intentarlo en unos minutos.',
  );
});

test('an unresponsive NightMail server is called by its name, apart from a busy service', () => {
  assert.equal(describeError({ code: 'serverUnreachable' }), 'El servidor de NightMail no responde. Vuelve a intentarlo en unos minutos.');
  assert.equal(errorParts({ code: 'serverUnreachable' }).safe, null, 'it may have been sent before it stopped answering');
  const waiting = progressParts({ stage: 'serverUnreachable' });
  assert.deepEqual(waiting, { stage: 'No se puede contactar con el servidor de NightMail', note: 'Se vuelve a probar tras una pausa.' });
  assert.notEqual(progressParts({ stage: 'retrying' }).stage, waiting.stage);
});

// "Esperando a que...", like the other waiting stages, instead of "Se espera a que...".
test('the "Enviando a Midnight" note says it is waiting for its confirmation', () => {
  assert.deepEqual(progressParts({ stage: 'relaying' }), {
    stage: 'Enviando a Midnight',
    note: 'Esperando a que Midnight confirme la operación.',
  });
});

test('errorParts: with nothing certain to reassure, that part is omitted, what is doubtful is said as doubtful', () => {
  assert.equal(errorParts({ code: 'internal' }).safe, null);
  // It only invites a repeat of what can work on repeating (core: `may_clear_by_itself`): a contract rejection repeats.
  assert.equal(errorParts({ code: 'callRejected', reason: 'no-slots-left' }).action, null);
  assert.equal(errorParts({ code: 'aliasSuffixTaken' }).action, null);
  // Without a "what to do", the reason must not suggest that waiting fixes it.
  assert.doesNotMatch(errorParts({ code: 'callRejected', reason: 'not-a-bono' }).what, /todavía|aún/);
  assert.match(errorParts({ code: 'badReceipt' }).what, /No sabemos/);
  // A store failure promises nothing about what was stored.
  assert.equal(errorParts({ code: 'store' }).safe, null);
});

// `stillPending` also arrives when YOUR operation had not even started (the bono is claimed by another payment
// method). The text does not say yours stayed pending, and gives the way out.
test('errorParts: `stillPending` talks about the pending operation, not yours, and says how to get out', () => {
  assert.deepEqual(errorParts({ code: 'stillPending' }), {
    what: 'Hay una operación pendiente que todavía no se ve terminada en Midnight.',
    safe: 'Sigue guardada. Repetirla no paga ni gasta dos veces.',
    action:
      'Espera unos minutos y vuelve a intentarlo. Si es un pago y quieres hacerlo de otra forma, cancela antes el pago pendiente.',
  });
});

test('errorParts: what the core does not guarantee is not promised', () => {
  // The time is not enough: the core may also require later issues.
  const at = formatDateTime(1_800_000_000);
  assert.equal(errorParts({ code: 'bonoNotReady', usableAt: 1_800_000_000 }).what, `Tu bono no se puede usar antes del ${at}.`);
  // It also appears with no plan at all.
  assert.equal(errorParts({ code: 'noFreeSlot' }).what, 'No tienes huecos libres para crear direcciones.');
  // It can arrive on finishing an already reserved mailbox: it does not say that no slot was used.
  assert.equal(errorParts({ code: 'nameRejected', reason: 'invalid' }).safe, null);
});

test('errors: every code has its own text and its joined text is its parts', () => {
  for (const e of ALL_ERRORS) {
    const [parts, label] = [errorParts(e), JSON.stringify(e)];
    assert.equal(describeError(e), joinParts(parts), label);
    if (e.code !== 'internal') assert.notEqual(parts.what, errorParts(null).what, label);
    for (const part of [parts.what, parts.safe, parts.action]) {
      if (part !== null) assert.match(part, /^[A-ZÁÉÍÓÚÑ¿«].*\.$/, `${label}: full sentence, with capital and full stop: ${part}`);
    }
  }
});

test('errors: literal, no exclamations and with the brand vocabulary', () => {
  for (const e of ALL_ERRORS) {
    const [text, label] = [describeError(e), JSON.stringify(e)];
    assert.doesNotMatch(text, /[!¡]/, label);
    assert.doesNotMatch(text, /\b(luz|luces|luciérnaga)|encend|apag|brill/i, `${label}: no light metaphors`);
    assert.doesNotMatch(text, /frase de recuperación/i, label);
    assert.doesNotMatch(text.replaceAll('frase semilla', ''), /semilla/i, `${label}: "frase semilla" always`);
    assert.doesNotMatch(text, /árbol|quemad|nullifier|sidecar|indexer|relayer|issuer|sufijo|\bhoja\b/i, `${label}: no jargon`);
    assert.doesNotMatch(text, /\busted\b|\bsu (correo|cuenta|frase)\b/i, `${label}: tuteo`);
    assert.doesNotMatch(text, /undefined|NaN|motivo-nuevo|saldo-nuevo/, `${label}: nothing raw`);
  }
});

// --- Errors in English. The rest of this file is in Spanish (`./idioma-es.ts`).

/** Runs `body` with the app in English and restores the previous language. */
function inEnglish(body: () => void): void {
  const before = prefs.get().locale;
  try {
    prefs.setLocale('en');
    body();
  } finally {
    prefs.setLocale(before);
  }
}

/** The "safe" sentences in English that speak of sending, paying, charging or issuing: the same as `MONEY_SAFE`, code by
 *  code, and with the same scope (no more and no less than Spanish). */
const MONEY_SAFE_EN: Record<string, string[]> = {
  sidecarTooOld: ['Nothing has been paid or sent this time.'],
  captchaFailed: ['No voucher has been issued with this attempt.'],
  paymentFailed: ["This attempt hasn't charged anything."],
  priceChanged: ['Nothing has been paid.'],
  insufficientFunds: ['Nothing has been paid.'],
  wallet: ["This attempt hasn't paid anything."],
};

test('English errors: each part is present or missing in the same cases as in Spanish', () => {
  const spanish = ALL_ERRORS.map((e) => errorParts(e));
  inEnglish(() => {
    ALL_ERRORS.forEach((e, i) => {
      const [en, es, label] = [errorParts(e), spanish[i], JSON.stringify(e)];
      assert.notEqual(en.what, es.what, `${label}: traducido`);
      assert.equal(en.safe === null, es.safe === null, `${label}: "safe" in both or in neither`);
      assert.equal(en.action === null, es.action === null, `${label}: "what to do" in both or in neither`);
      assert.equal(describeError(e), joinParts(en), label);
      for (const part of [en.what, en.safe, en.action]) {
        if (part !== null) assert.match(part, /^[A-Z].*\.$/, `${label}: full sentence, with capital and full stop: ${part}`);
      }
    });
  });
});

test('English errors: only the allowlist talks about money, and in the same codes as in Spanish', () => {
  assert.deepEqual(Object.keys(MONEY_SAFE_EN).sort(), Object.keys(MONEY_SAFE).sort());
  inEnglish(() => {
    const found: Record<string, string[]> = {};
    for (const e of ALL_ERRORS) {
      const safe = errorParts(e).safe;
      if (safe === null || !/\b(sent|paid|charged|issued|pay|spend)\b/i.test(safe)) continue;
      const code = e.code as string;
      found[code] = [...new Set([...(found[code] ?? []), safe])];
    }
    // `stillPending` speaks of paying twice (not of what was paid): the Spanish one does not enter `MONEY_SAFE` either.
    assert.deepEqual(found, { ...MONEY_SAFE_EN, stillPending: ["It's still saved. Repeating it won't pay twice or spend twice."] });
    assert.equal(errorParts({ code: 'wallet', reason: 'not-open' }).safe, null, 'it also fails on save, already sent');
    assert.equal(errorParts({ code: 'insufficientFunds', asset: 'saldo-nuevo' }).safe, null);
  });
});

test('English errors: waits, reasons and values are said with their grammar', () => {
  inEnglish(() => {
    assert.deepEqual(errorParts({ code: 'wrongPassword' }), { what: 'Wrong password.', safe: null, action: 'Try again.' });
    assert.equal(describeError({ code: 'tooManyAttempts', waitSecs: 30 }), 'Too many attempts. Wait 30 s and try again.');
    assert.equal(describeError({ code: 'tooManyAttempts', waitSecs: 95 }), 'Too many attempts. Wait 2 min and try again.');
    assert.equal(describeError({ code: 'tooManyAttempts', waitSecs: 'xyz' }), 'Too many attempts. Wait a moment and try again.');
    assert.equal(errorParts({ code: 'rateLimited', retryAfterS: 3600 }).action, 'Try again in 60 min.');
    assert.equal(errorParts({ code: 'nameRejected', reason: 'invalid' }).what, "That name isn't valid.");
    assert.equal(errorParts({ code: 'nameRejected', reason: 'alias-form' }).what, 'That name looks like an alias.');
    assert.equal(errorParts({ code: 'nameRejected', reason: 'reserved' }).what, 'That name is reserved.');
    assert.equal(errorParts({ code: 'nameRejected', reason: 'motivo-nuevo' }).what, "That name isn't allowed.");
    assert.equal(
      errorParts({ code: 'callRejected', reason: 'motivo-nuevo' }).what,
      "The operation can't be done: it didn't pass a check.",
    );
    assert.equal(errorParts({ code: 'callRejected', reason: 'no-slots-left' }).action, null);
    // Without a "what to do", the reason does not suggest that waiting fixes it.
    assert.doesNotMatch(errorParts({ code: 'callRejected', reason: 'not-a-bono' }).what, /\b(yet|still)\b/);
    assert.equal(errorParts({ code: 'wallet', reason: 'motivo-nuevo' }).what, "The payment wallet isn't available: unknown reason.");
    assert.equal(describeError({ code: 'midnightError', rpcCode: -32000 }), 'Midnight returned an error (code -32000). Try again.');
    assert.equal(describeError({ code: 'midnightError', rpcCode: 1.5 }), 'Midnight returned an error. Try again.');
    const at = formatDateTime(1_800_000_000);
    assert.equal(errorParts({ code: 'bonoNotReady', usableAt: 1_800_000_000 }).what, `Your voucher can't be used before ${at}.`);
    assert.equal(describeError(new Error('internal secret')), 'An unexpected error occurred. Try again.');
    assert.equal(describeError({ code: 'internal' }), 'An unexpected error occurred. Try again.');
  });
});

test('English errors: glossary vocabulary and nothing in Spanish or raw', () => {
  inEnglish(() => {
    for (const e of ALL_ERRORS) {
      const [text, label] = [describeError(e), JSON.stringify(e)];
      assert.doesNotMatch(text, /[!¡¿áéíóúñ«»]/i, label);
      assert.doesNotMatch(text, /\bbono|seed|\bround|reveal|halfway|half-done|still encrypted|keep working/i, label);
      assert.doesNotMatch(text, /\bnothing (was|has been) (changed|lost|deleted|sent)\b/i, `${label}: no comforting phrases`);
      assert.doesNotMatch(text, /\b(light|lights|glow|shine)\b|\b(switch|turn)(ed)? (on|off)\b/i, `${label}: no light metaphors`);
      assert.doesNotMatch(text, /sidecar|indexer|relayer|issuer|nullifier|suffix/i, `${label}: no jargon`);
      assert.doesNotMatch(text, /undefined|NaN|motivo-nuevo|saldo-nuevo/, `${label}: nothing raw`);
    }
  });
  assert.equal(describeError({ code: 'wrongPassword' }), 'Contraseña incorrecta. Vuelve a intentarlo.', 'Spanish is back');
});

test('formatNight: smallest units → NIGHT', () => {
  assert.equal(formatNight('5000000000'), '5.000 NIGHT');
  assert.equal(formatNight('5000500000'), '5.000,5 NIGHT');
  assert.equal(formatNight('12345500000'), '12.345,5 NIGHT');
  assert.equal(formatNight('1'), '0,000001 NIGHT');
  assert.equal(formatNight('0'), '0 NIGHT');
  assert.equal(formatNight('123456789012345678901234567890'), '123.456.789.012.345.678.901.234,56789 NIGHT');
  assert.equal(formatNight('-5'), '-5 (unidades)', 'anything that is not an unsigned integer is not converted');
});

test('formatDust: Specks → DUST (10^15), with at most 2 decimals and never rounded up', () => {
  assert.equal(formatDust('5000000000000000'), '5 DUST');
  assert.equal(formatDust('12345500000000000000'), '12.345,5 DUST');
  assert.equal(formatDust('1999999999999999'), '1,99 DUST', 'it is cut, never shows more than there is');
  assert.equal(formatDust('10000000000000'), '0,01 DUST');
  assert.equal(formatDust('9999999999999'), '0 DUST', 'less than the last digit shown');
  assert.equal(formatDust('0'), '0 DUST');
  assert.equal(formatDust('x'), 'x (unidades)', 'anything that is not an unsigned integer is not converted');
});

test('seedWords and seedWordCount: words in order, separated by any whitespace', () => {
  assert.deepEqual(seedWords('  lumber\tpencil\n\nharbor  '), ['lumber', 'pencil', 'harbor']);
  assert.deepEqual(seedWords(''), []);
  assert.deepEqual(seedWords('   '), []);
  assert.equal(seedWordCount(''), '0 de 24 palabras');
  assert.equal(seedWordCount('a b c d e f g h i j k l m n o p q '), '17 de 24 palabras', 'the trailing space does not count');
  assert.equal(seedWordCount(Array(24).fill('w').join(' ')), '24 de 24 palabras');
});

test('recoveryFacts: bonos and addresses always, the odd ones only if not zero and without jargon', () => {
  const report = { bonos: 1, addresses: 3, burned: 0, conflicts: 0 };
  assert.deepEqual(recoveryFacts(report), [
    ['Bonos', 1],
    ['Direcciones', 3],
  ]);
  assert.deepEqual(recoveryFacts({ ...report, bonos: 0, addresses: 0 }), [
    ['Bonos', 0],
    ['Direcciones', 0],
  ]);
  // Each is decided by its own value.
  assert.deepEqual(recoveryFacts({ ...report, burned: 2 }), [
    ['Bonos', 1],
    ['Direcciones', 3],
    ['Huecos que ya no sirven', 2],
  ]);
  assert.deepEqual(recoveryFacts({ ...report, conflicts: 1 }), [
    ['Bonos', 1],
    ['Direcciones', 3],
    ['Datos que no coincidían', 1],
  ]);
  assert.deepEqual(recoveryFacts({ ...report, burned: 2, conflicts: 1 }), [
    ['Bonos', 1],
    ['Direcciones', 3],
    ['Huecos que ya no sirven', 2],
    ['Datos que no coincidían', 1],
  ]);
  for (const [label] of recoveryFacts({ ...report, burned: 2, conflicts: 1 })) {
    assert.doesNotMatch(label, /quemad|conflicto|árbol|nullifier/i, label);
  }
});

test('slotKindName and slotLabel: mailbox or alias, "en creación" and without a number', () => {
  assert.equal(slotKindName({ kind: 'mailbox' }), 'buzón');
  assert.equal(slotKindName({ kind: 'alias' }), 'alias');
  assert.equal(slotLabel({ n: 0, kind: 'mailbox', j: 0 }), 'buzón en creación');
  assert.equal(slotLabel({ n: 2, kind: 'alias', j: 3 }), 'alias en creación');
  // No number or bono: nothing that looks like a quota count ("0/3", "0 de 3").
  assert.doesNotMatch(slotLabel({ n: 1, kind: 'alias', j: 19 }), /\d/);
});

test('cannotPay and faucetBlocked: a payment that cannot go through is not confirmed', () => {
  const wallet: WalletView = {
    unshieldedAddress: null, night: '5000000000', dust: '1', dustReady: true, token: '100', faucet: true, dustSetup: 'idle',
  };
  assert.equal(cannotPay('100', wallet), null);
  assert.equal(cannotPay('100', { ...wallet, dustReady: false }), null, 'with NIGHT, DUST is waited for');
  assert.match(cannotPay('101', wallet)!, /insuficiente.*100.*101/);
  assert.match(cannotPay('100000000000000000000', wallet)!, /insuficiente/, 'BigInt, no rounding');
  assert.match(cannotPay('100', { ...wallet, dustReady: false, night: '0' })!, /NIGHT/);
  assert.match(cannotPay('1e3', wallet)!, /No se pudo leer/);
  assert.equal(faucetBlocked(wallet), false);
  assert.equal(faucetBlocked({ ...wallet, dustReady: false, night: '0' }), true);
  assert.equal(faucetBlocked({ ...wallet, night: '0' }), false, 'with DUST there is already a fee');
});

test('dustSetupLine: the background registration line next to DUST, only when there is something to say', () => {
  assert.equal(dustSetupLine('idle'), null);
  assert.deepEqual(dustSetupLine('activating'), { icon: 'espera', text: 'Activando la generación de DUST' });
  const failed = dustSetupLine('failed')!;
  assert.equal(failed.icon, 'pause');
  assert.equal(
    failed.text,
    'No se ha podido activar la generación de DUST. Se volverá a intentar cuando vuelvas a abrir la aplicación.',
    'says when it will be retried',
  );
});

test('describeError: no test token (named "NightMail token")', () => {
  assert.match(describeError({ code: 'noTestToken' }), /NightMail token/);
  assert.doesNotMatch(describeError({ code: 'noTestToken' }), /TestToken/);
});

test('isBadConfig', () => {
  assert.equal(isBadConfig({ code: 'badConfig' }), true);
  assert.equal(isBadConfig({ code: 'internal' }), false);
  assert.equal(isBadConfig(undefined), false);
});

test('isProfileInUse and isBootFailure: which startup failures have their own screen or are not retried', () => {
  // A profile open in another window has its own screen, it is not a disk failure.
  assert.equal(isProfileInUse({ code: 'profileInUse' }), true);
  assert.equal(isBootFailure({ code: 'profileInUse' }), false);
  // Disk or permissions when taking the profile: the core was not mounted and retrying is useless.
  assert.equal(isBootFailure({ code: 'storage' }), true);
  assert.equal(isBootFailure({ code: 'insecureFiles' }), true);
  // An error with no code (a failed call) can be retried and is not "perfil en uso".
  for (const e of [new Error('ipc'), undefined, { code: 'internal' }]) {
    assert.equal(isBootFailure(e), false, String(e));
    assert.equal(isProfileInUse(e), false, String(e));
  }
});

test('senderAddress: always the address', () => {
  assert.equal(senderAddress('Ana <ana@x.org>'), 'ana@x.org');
  assert.equal(senderAddress('"ceo@banco.com" <evil@x.org>'), 'evil@x.org');
  assert.equal(senderAddress('ana@x.org'), 'ana@x.org');
  assert.equal(senderAddress(null), '(remitente desconocido)');
  assert.equal(senderAddress('   '), '(remitente desconocido)');
  assert.equal(senderAddress('Ana <>'), '(sin dirección) "Ana <>"');
  assert.equal(senderAddress('"Ana" <>'), '(sin dirección) "\'Ana\' <>"');
  assert.equal(senderAddress('Ana Pérez'), '(sin dirección) "Ana Pérez"');
  assert.equal(senderAddress('Ana <a@b@c>'), '(sin dirección) "Ana <a@b@c>"');
  assert.equal(senderAddress('Ana <ana@x.org> extra'), '(sin dirección) "Ana <ana@x.org> extra"');
});

test('srcdoc: the CSP goes first and allows nothing remote', () => {
  const doc = buildSrcDoc('<p>hola</p>');
  assert.ok(doc.startsWith('<meta http-equiv="Content-Security-Policy"'));
  assert.match(doc, /x-dns-prefetch-control" content="off"/);
  assert.ok(doc.endsWith('<p>hola</p>'));
  assert.match(READER_CSP, /default-src 'none'/);
  assert.match(READER_CSP, /img-src data: cid:/);
  assert.doesNotMatch(READER_CSP, /https?:|script-src/);
});

test('isAllowedImageSrc: only base64 data: of png, jpeg, gif or webp (never SVG)', () => {
  for (const ok of [
    'data:image/png;base64,AAAA',
    ' DATA:image/PNG;BASE64,AAAA',
    'data:image/jpeg;base64,AAAA',
    'data:image/gif;base64,AAAA',
    'data:image/webp;base64,AAAA',
  ]) {
    assert.equal(isAllowedImageSrc(ok), true, ok);
  }
  for (const bad of [
    'https://track.me/p.gif',
    '//track.me/p.gif',
    'cid:abc',
    'data:image/svg+xml;base64,PHN2Zy8+',
    'data:image/svg+xml,<svg/>',
    'data:text/html;base64,PGI+',
    'data:image/png,AAAA',
    'data:image/png;charset=x;base64,AAAA',
    'data:image/pngx;base64,AAAA',
    'data:audio/mpeg;base64,AAAA',
  ]) {
    assert.equal(isAllowedImageSrc(bad), false, bad);
  }
});

test('sizes', () => {
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(2048), '2.0 KB');
});

const STAGES: Progress[] = [
  { stage: 'queued' },
  { stage: 'requestingBono' },
  { stage: 'waitingIssuer' },
  { stage: 'waitingInclusion' },
  { stage: 'bonoReady', n: 2 },
  { stage: 'walletSyncing' },
  { stage: 'registeringDust' },
  { stage: 'paying' },
  { stage: 'proving' },
  { stage: 'relaying' },
  { stage: 'retrying' },
  { stage: 'waitingDust' },
  { stage: 'serverUnreachable' },
  { stage: 'walletStateDiscarded' },
  { stage: 'addressReady' },
  { stage: 'recovering', n: 2 },
];

test('progress: the stage is a heading (initial capital, no full stop) and the reason goes apart', () => {
  const titles = new Set<string>();
  for (const p of STAGES) {
    const { stage, note } = progressParts(p);
    assert.match(stage, /^[A-ZÁÉÍÓÚÑ]/, `${p.stage}: initial capital`);
    assert.doesNotMatch(stage, /[.:;!¡]$|[!¡]/, `${p.stage}: no final full stop or exclamations`);
    if (note !== null) assert.match(note, /^[A-ZÁÉÍÓÚÑ].*\.$/, `${p.stage}: the note is full sentences`);
    titles.add(stage);
  }
  assert.equal(titles.size, STAGES.length, 'every stage has its text');
});

test('progress: there is text for exactly the stages of the core bindings', () => {
  const stages = tagged('../src/bindings/Progress.ts', 'stage');
  assert.ok(stages.length >= 16, 'the binding was read');
  assert.deepEqual(STAGES.map((p) => p.stage as string).sort(), [...stages].sort());
  for (const stage of stages) {
    // "En marcha" is the text of a stage this version does not know.
    assert.notEqual(progressParts({ stage, n: 2, round: 7 } as unknown as Progress).stage, 'En marcha', stage);
  }
});

test('progress: texts of the stages with data and of the slow ones', () => {
  // The bono enters the chain and stays "confirmado", not "listo": it may not be usable yet.
  assert.equal(progressParts({ stage: 'bonoReady', n: 2 }).stage, 'Bono confirmado');
  // `n` is the start of a batch of candidates, not a bono that exists: the headline does not show it.
  assert.equal(progressParts({ stage: 'recovering', n: 64 }).stage, 'Buscando tus bonos en Midnight');
  assert.match(progressParts({ stage: 'recovering', n: 64 }).note!, /frase semilla/);
  assert.equal(progressParts({ stage: 'addressReady' }).note, null);
});

test('progress: the notes explain the wait without promising what the core does not guarantee', () => {
  const note = (stage: string) => progressParts({ stage } as unknown as Progress).note!;
  // Where it is computed and why it takes long, without committing to a duration.
  assert.deepEqual(progressParts({ stage: 'proving' }), {
    stage: 'Generando la prueba',
    note: 'Se calcula en este dispositivo, con datos recién leídos de Midnight. Es un cálculo pesado: por eso tarda.',
  });
  assert.doesNotMatch(note('proving'), /segundo|minuto|suele/i);
  // The payment may wait half an hour or more to enter the chain: "minutos" is not said either.
  assert.equal(
    note('paying'),
    'Midnight tiene que confirmar el pago y la confirmación puede tardar. Mientras tanto, puedes seguir leyendo tu correo.',
  );
  assert.doesNotMatch(note('paying'), /minuto/i);
  // Registration may wait up to half an hour: no "un poco" or "minutos".
  assert.doesNotMatch(note('registeringDust'), /un poco|minuto/i);
  // It is also emitted when the service DID answer ("ocupado").
  assert.equal(note('retrying'), 'Un servicio no ha podido atender la petición. Se vuelve a probar tras una pausa.');
  // It is also emitted if what was unreadable was only the purchase journal: it is not said that it resyncs entirely.
  assert.deepEqual(progressParts({ stage: 'walletStateDiscarded' }), {
    stage: 'Recuperando los datos de la cartera',
    note: 'Parte de los datos guardados de la cartera no se ha podido usar. Puede tardar más que otras veces.',
  });
});

test('progress: no figures that do not come from the code and no jargon, an unknown stage does not break', () => {
  for (const p of STAGES) {
    const { stage, note } = progressParts(p);
    // The only figures are the stage's data (round, bono): no invented duration.
    assert.doesNotMatch(note ?? '', /\d/, `${p.stage}: note without figures`);
    assert.doesNotMatch(`${stage} ${note ?? ''}`, /árbol|emisor|sidecar|indexer|relayer|\bhoja\b/i, `${p.stage}: no jargon`);
    assert.doesNotMatch(`${stage} ${note ?? ''}`.replaceAll('frase semilla', ''), /semilla/i, p.stage);
  }
  assert.deepEqual(progressParts({ stage: 'etapaNueva' } as unknown as Progress), { stage: 'En marcha', note: null });
  assert.deepEqual(progressParts({ stage: 'toString' } as unknown as Progress), { stage: 'En marcha', note: null });
});

test('isRiskyCss: a "/*" inside a string hides nothing (it checks the raw CSS AND the CSS without comments)', () => {
  for (const css of [
    'content:"/*";background:url(https://evil.example/a);color:"*/"',
    "content:'/*';background:url(https://evil.example/b)",
    'p::before{content:"/*"} div{background:url(https://evil.example/d)}',
    '@font-face{font-family:f;src:local("/*"),url(https://evil.example/f.woff)}',
    'a{content:"/*"} @import "https://evil.example/i.css"; b{content:"*/"}',
  ]) {
    assert.equal(isRiskyCss(css), true, css);
  }
});

test('isRiskyCss: url(), @import, image-set(), src(), expression() and escapes, with or without comments', () => {
  for (const css of [
    'background:url(x)',
    'background:URL(x)',
    '@import "a.css"',
    '@IMPORT url(a)',
    'background-image:-webkit-image-set("a" 1x)',
    '@font-face{src(x)}',
    'width:expression(alert(1))',
    'background:\\75rl(x)',
    '@im/**/port "a.css"',
    'u/* */rl(x)',
    // Crude on purpose: a comment that says `url(` also counts.
    'p{margin:0}/* url( */',
  ]) {
    assert.equal(isRiskyCss(css), true, css);
  }
  for (const css of ['color:red', 'font: 12px/1.5 sans-serif', 'p{margin:0}/* nota */', 'a{content:"→"}', '']) {
    assert.equal(isRiskyCss(css), false, css);
  }
});

test('cidImage: only delivered cid:, with the list type and clean base64', () => {
  const images = [
    { cid: 'logo@x', mime: 'image/png', data: 'cG5n' },
    { cid: 'raro@x', mime: 'image/svg+xml', data: 'PHN2Zy8+' },
    { cid: 'sucio@x', mime: 'image/gif', data: 'R0l"GOD' },
  ];
  assert.equal(cidImage('cid:logo@x', images), images[0]);
  assert.equal(cidImage(' CID:<logo@x> ', images), images[0]);
  assert.equal(cidImage('cid:LOGO@x', images), null);
  assert.equal(cidImage('cid:otro@x', images), null);
  assert.equal(cidImage('cid:raro@x', images), null);
  assert.equal(cidImage('cid:sucio@x', images), null);
  assert.equal(cidImage('https://x/logo.png', images), null);
  assert.equal(cidImage('cid:logo@x', []), null);
  assert.equal(isCidSrc(' cid:a'), true);
  assert.equal(isCidSrc('data:image/png;base64,AA'), false);
});

test('formatDateTime: date and time without seconds, and it is the one the bono error uses', () => {
  // "dd/mm/yyyy, hh:mm": two hour groups, without a third (seconds).
  assert.match(formatDateTime(1_800_000_000), /^\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}$/);
  assert.match(describeError({ code: 'bonoNotReady', usableAt: 1_800_000_000 }), /antes del \d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}\./);
});
