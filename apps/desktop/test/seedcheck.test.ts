// Which words of the phrase do not exist on restore: the core only says "frase no válida".
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BIP39_WORDS, invalidWordPositions, phraseProblem } from '../src/seedCheck.ts';

test('the list has the 2048 standard words', () => {
  assert.equal(BIP39_WORDS.size, 2048);
  assert.ok(BIP39_WORDS.has('abandon') && BIP39_WORDS.has('zoo'));
});

test('positions (from 1) of the words that do not exist, capitals and extra spaces do not count', () => {
  assert.deepEqual(invalidWordPositions('abandon ability able'), []);
  assert.deepEqual(invalidWordPositions('  Abandon\n abilty   able  '), [2]);
  assert.deepEqual(invalidWordPositions('xx ability yy'), [1, 3]);
  assert.deepEqual(invalidWordPositions(''), []);
});

test('message: one word, several, or nothing to point out', () => {
  assert.equal(phraseProblem('abandon abilty able'), 'La palabra 2 no es válida. Corrígela y vuelve a intentarlo.');
  assert.equal(phraseProblem('xx ability yy'), 'Las palabras 1 y 3 no son válidas. Corrígelas y vuelve a intentarlo.');
  assert.equal(phraseProblem('xx able yy about zz'), 'Las palabras 1, 3 y 5 no son válidas. Corrígelas y vuelve a intentarlo.');
  assert.equal(phraseProblem('abandon ability able'), null);
});
