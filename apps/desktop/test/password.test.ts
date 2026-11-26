// Password rules (creating and changing) and where each error goes when changing it.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeError } from '../src/errors.ts';
import { changeErrorPlace, changeProblem, pairMismatch, pairReady, mismatchText, notChangedText } from '../src/screens/password.ts';

test('the pair: not empty and typed the same twice, the mismatch notice only once the repetition is typed', () => {
  assert.equal(pairReady('', ''), false);
  assert.equal(pairReady('a', ''), false);
  assert.equal(pairReady('a', 'b'), false);
  assert.equal(pairReady('a', 'a'), true);
  assert.equal(pairMismatch('abc', ''), false);
  assert.equal(pairMismatch('abc', 'ab'), true);
  assert.equal(pairMismatch('abc', 'abc'), false);
});

test('change: what is missing is flagged on its field, in order', () => {
  const ok = { current: 'vieja', next: 'nueva', repeat: 'nueva' };
  assert.equal(changeProblem(ok), null);
  assert.deepEqual(changeProblem({ ...ok, current: '' }), { field: 'current', message: 'Escribe tu contraseña actual.' });
  assert.deepEqual(changeProblem({ ...ok, next: '', repeat: '' }), { field: 'next', message: 'Escribe la contraseña nueva.' });
  assert.deepEqual(changeProblem({ ...ok, repeat: '' }), { field: 'repeat', message: 'Repite la contraseña nueva.' });
  assert.deepEqual(changeProblem({ ...ok, repeat: 'nuev' }), { field: 'repeat', message: mismatchText() });
  assert.deepEqual(changeProblem({ current: 'igual', next: 'igual', repeat: 'igual' }), {
    field: 'next',
    message: 'La contraseña nueva es igual a la actual.',
  });
});

test('change: a wrong current password goes to its field with the usual text', () => {
  const e = { code: 'wrongPassword' };
  assert.deepEqual(changeErrorPlace('wrongPassword', describeError(e)), {
    field: 'current',
    message: 'Contraseña incorrecta. Vuelve a intentarlo.',
  });
  assert.equal(changeErrorPlace('emptyPassword', describeError({ code: 'emptyPassword' })).field, 'next');
});

test('change: any other error goes apart and starts by saying the password has not changed', () => {
  for (const code of ['storage', 'insecureFiles', 'outOfMemory', 'notUnlocked', 'internal', 'tooManyAttempts']) {
    const placed = changeErrorPlace(code, describeError({ code, waitSecs: 30 }));
    assert.equal(placed.field, null, code);
    assert.ok(placed.message.startsWith(`${notChangedText()} `), code);
    assert.ok(placed.message.length > notChangedText().length + 10, code);
  }
});

test('the usual Spanish: no match and not changed', () => {
  assert.equal(mismatchText(), 'Las contraseñas no coinciden.');
  assert.equal(notChangedText(), 'No se ha cambiado la contraseña.');
});
