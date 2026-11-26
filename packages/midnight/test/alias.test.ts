// Alias texts (provisional format, see src/alias.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { aliasAddress, aliasSuffix, aliasWords, InvalidInput, isAliasShaped, suffixOf } from '../src/index.ts';

const v = JSON.parse(readFileSync(new URL('../../test-vectors/contract/registry.json', import.meta.url), 'utf8'));

/** addrKey whose first 88 bits are suffix (60) ‖ word 1 (11) ‖ word 2 (11), with the rest set to ones. */
function keyWith(suffix: bigint, w1: bigint, w2: bigint): Uint8Array {
  const head = (suffix << 28n) | (w1 << 17n) | (w2 << 6n) | 0x3fn;
  const key = new Uint8Array(32).fill(0xff);
  key.set(Buffer.from(head.toString(16).padStart(22, '0'), 'hex'));
  return key;
}

test('the suffix is the first 60 bits in Crockford base32, most significant first', () => {
  assert.equal(aliasSuffix(keyWith(0n, 0n, 0n)), '000000000000');
  assert.equal(aliasSuffix(keyWith(1n, 2047n, 2047n)), '000000000001', 'the following bits do not count');
  assert.equal(aliasSuffix(keyWith(31n << 55n, 0n, 0n)), 'z00000000000');
  assert.equal(aliasSuffix(keyWith(0x0123456789abcdefn >> 4n, 0n, 0n)), '04hmasw9nf6y');
  assert.equal(aliasSuffix(new Uint8Array(32).fill(0xff)), 'zzzzzzzzzzzz');
});

test('the words come from the next 22 bits, 11 per word (English BIP39 list)', () => {
  assert.deepEqual(aliasWords(keyWith(0n, 0n, 0n)), ['abandon', 'abandon']);
  assert.deepEqual(aliasWords(keyWith((1n << 60n) - 1n, 1n, 2047n)), ['ability', 'zoo']);
  assert.deepEqual(aliasWords(keyWith(0n, 2047n, 3n)), ['zoo', 'about']);
});

test('full text: word.word.suffix (snapshot of the aliasKey vector)', () => {
  assert.equal(aliasAddress(keyWith(1n, 1n, 2047n)), 'ability.zoo.000000000001');
  const key = new Uint8Array(Buffer.from(v.aliasKey, 'hex'));
  const text = aliasAddress(key);
  assert.equal(text, 'around.rubber.hc9n6db283sn'); // cross-checked independently in Python
  assert.ok(isAliasShaped(text));
  assert.equal(suffixOf(text), aliasSuffix(key));
});

test('addrKey of another size is rejected', () => {
  assert.throws(() => aliasAddress(new Uint8Array(31)), InvalidInput);
  assert.throws(() => aliasSuffix('ab' as unknown as Uint8Array), InvalidInput);
});

test('alias shape: anything ending in "." and 12 letters or digits, with any prefix', () => {
  const shaped = ['ability.zoo.000000000001', 'a.b.c.zzzzzzzzzzzz', 'nube.verde.k7m2q9xa4b3c', 'x.iiiiiiiiiiii',
    '.zzzzzzzzzzzz', 'ab1.zzzzzzzzzzzz', 'ab-c.zzzzzzzzzzzz', 'ab..zzzzzzzzzzzz', 'juan_perez.ABCDEFGHIJKL', 'Ab.ZZZZZZZZZZZZ'];
  for (const s of shaped) assert.ok(isAliasShaped(s), s);
  const notShaped = ['juan.perez', 'zzzzzzzzzzzz', 'ab.zzzzzzzzzzz', 'ab.zzzzzzzzzzzzz', 'ab.zzzzzzzzzzz_',
    'ab.zzzzzzzzzzzz\n', 'abzzzzzzzzzzzz', 'ab.zzzzzz-zzzzz'];
  for (const s of notShaped) assert.ok(!isAliasShaped(s), s);
});

test('property: the text of any addrKey has alias shape (5000 random keys)', () => {
  for (let i = 0; i < 5000; i++) {
    const text = aliasAddress(new Uint8Array(randomBytes(32)));
    assert.ok(isAliasShaped(text), text);
    assert.match(text, /^[a-z]+\.[a-z]+\.[0-9a-hjkmnp-tv-z]{12}$/);
  }
});

test('the 2048 words of the list are distinct and only [a-z]+', () => {
  assert.equal(wordlist.length, 2048);
  assert.equal(new Set(wordlist).size, 2048);
  for (const w of wordlist) assert.match(w, /^[a-z]+$/);
});
