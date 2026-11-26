// Address text of an alias: words(addrKey) + "." + base32(trunc(addrKey, 60 bits)).
//
// Provisional format (the contract does not define the words or the alphabet):
// - suffix: the first 60 bits of addrKey (big-endian) in lowercase Crockford base32
//   (0-9 and a-z without i, l, o, u), 12 characters. Crockford rather than RFC 4648 base32 so that
//   all ten digits can appear;
// - words: 2 from the English BIP39 list (2048 ASCII words of 3 to 8 letters), taken from the next
//   22 bits of addrKey (11 per word), joined with '.'. Example (the vectors' aliasKey): `around.rubber.hc9n6db283sn`.
// The words derive from addrKey, so the full text is fixed per alias and the server checks all of it
// (see the alias rule in resolution.ts). Changing this format changes the text of existing aliases.
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { InvalidInput } from './input.ts';

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';
export const SUFFIX_CHARS = 12;
const WORDS = 2;
const WORD_BITS = 11n;

/**
 * Alias shape: anything ending in '.' plus 12 letters or digits (case-insensitive). Deliberately much
 * broader than real alias texts (a reversible default): anything that looks like an alias resolves
 * only as an alias, and nobody can register a mailbox with that shape.
 */
const ALIAS_SHAPE = /\.[0-9a-z]{12}$/;

/** The first 88 bits of addrKey: 60 for the suffix and 22 for the words. */
function head(addrKey: Uint8Array): bigint {
  if (!(addrKey instanceof Uint8Array) || addrKey.length !== 32) throw new InvalidInput('addrKey: expected 32 bytes');
  return BigInt('0x' + Buffer.from(addrKey.subarray(0, 11)).toString('hex'));
}

/** Alias suffix: the first 60 bits of addrKey in Crockford base32. */
export function aliasSuffix(addrKey: Uint8Array): string {
  const bits = head(addrKey) >> 28n;
  let out = '';
  for (let i = SUFFIX_CHARS - 1; i >= 0; i--) out += CROCKFORD[Number((bits >> BigInt(5 * i)) & 31n)];
  return out;
}

/** Alias words (provisional): 2 BIP39 words from bits 60-81 of addrKey. */
export function aliasWords(addrKey: Uint8Array): string[] {
  const bits = head(addrKey) >> 6n;
  const words: string[] = [];
  for (let i = WORDS - 1; i >= 0; i--) words.push(wordlist[Number((bits >> (WORD_BITS * BigInt(i))) & 2047n)]);
  return words;
}

/** Full local part of the alias: `word.word.suffix`. */
export const aliasAddress = (addrKey: Uint8Array): string => [...aliasWords(addrKey), aliasSuffix(addrKey)].join('.');

/** Does it have the alias shape? (case-insensitive) */
export const isAliasShaped = (localPart: string): boolean => ALIAS_SHAPE.test(localPart.toLowerCase());

/** Suffix of an alias-shaped local part (its last 12 characters). */
export const suffixOf = (localPart: string): string => localPart.slice(-SUFFIX_CHARS);
