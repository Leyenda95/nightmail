// Resolution index: the required rules of `ResolutionIndex.resolve`, with the block as the unit of order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pureCircuits } from '@nightmail/contracts/managed/registry/contract/index.js';
import {
  addrKey, aliasAddress, InvalidInput, Kind, type RegistryAddress, RESOLUTION_INDEX_STATE_VERSION, ResolutionIndex, toHex,
} from '../src/index.ts';

const fill = (byte: number) => byte.toString(16).padStart(2, '0').repeat(32);
const entry = (key: string, kind: Kind, tag = 1): RegistryAddress => ({
  addrKey: key, encPk: fill(tag), authPk: fill(tag + 1), kind,
  nameCipher: kind === Kind.mailbox ? fill(tag + 2).repeat(4).slice(0, 208) : '00'.repeat(104), slotNul: fill(tag + 3),
});
const mailbox = (name: string, tag = 1) => entry(toHex(addrKey(name)), Kind.mailbox, tag);
/** Mailbox with any name, bypassing the app's rules (the contract accepts it, as an attacker would do). */
function rawMailbox(name: string, tag = 1): RegistryAddress {
  const bytes = new Uint8Array(64);
  bytes.set(Buffer.from(name, 'ascii'));
  return entry(toHex(pureCircuits.addressKey(bytes)), Kind.mailbox, tag);
}
/** Alias addrKey whose first 88 bits are `head` (22 hex characters) and the rest `rest`. */
const aliasKeyWith = (head: string, rest = 'cd') => head + rest.repeat(21);
const textOf = (e: RegistryAddress) => aliasAddress(Buffer.from(e.addrKey, 'hex'));

/** Index with one block per record, in that order. */
function oneByBlock(...entries: RegistryAddress[]): ResolutionIndex {
  const index = new ResolutionIndex();
  entries.forEach((e, height) => index.addBlock(height, [e]));
  return index;
}

const HEAD = '0123456789abcdef012345';
const first = entry(aliasKeyWith(HEAD), Kind.alias, 1);
// same 60 suffix bits, different words
const sameSuffix = entry(aliasKeyWith(HEAD.slice(0, 15) + (parseInt(HEAD[15], 16) ^ 0xf).toString(16) + HEAD.slice(16)), Kind.alias, 2);
// same full text (same 82 bits), different addrKey
const sameText = entry(aliasKeyWith(HEAD, 'ef'), Kind.alias, 3);

test('the test records collide as expected', () => {
  assert.equal(textOf(first).slice(-12), textOf(sameSuffix).slice(-12));
  assert.notEqual(textOf(first), textOf(sameSuffix));
  assert.equal(textOf(first), textOf(sameText));
});

test('a mailbox is resolved by its normalized name (case-insensitive)', () => {
  const juan = mailbox('juan.perez');
  const index = oneByBlock(juan);
  assert.equal(index.resolve('juan.perez'), juan);
  assert.equal(index.resolve('Juan.PEREZ'), juan);
  assert.equal(index.resolve('juan.perez2'), undefined);
  assert.equal(index.get(juan.addrKey), juan);
});

test('an alias is resolved by its exact full text (case-insensitive)', () => {
  const index = oneByBlock(first);
  const text = textOf(first);
  assert.equal(index.resolve(text), first);
  assert.equal(index.resolve(text.toUpperCase()), first);
  const [w1, w2, suffix] = text.split('.');
  assert.equal(index.resolve(`${w2}.${w1}.${suffix}`), undefined, 'same suffix, other words');
  assert.equal(index.resolve(`${w1}.${suffix}`), undefined, 'one word missing');
  assert.equal(index.resolve(`x.${w1}.${w2}.${suffix}`), undefined, 'one word too many');
  assert.equal(index.resolve(`.${suffix}`), undefined, 'only the suffix');
});

test('rule 1: what has alias shape NEVER falls back to H(name), even if there is a mailbox with that name', () => {
  const victim = entry(aliasKeyWith('fedcba9876543210fedcba'), Kind.alias, 10);
  const text = textOf(victim);
  const attacker = rawMailbox(text, 20); // the contract accepts it (covered by the contract tests)
  assert.equal(oneByBlock(attacker, victim).resolve(text), victim);
  assert.equal(oneByBlock(attacker).resolve(text), undefined, 'without the alias: it does not exist');
  const wrongAlphabet = `${text.slice(0, -12)}iiiiiiiiiiii`;
  assert.equal(oneByBlock(rawMailbox(wrongAlphabet)).resolve(wrongAlphabet), undefined);
  const anyPrefix = 'juan_perez.abcdefghijkl';
  assert.equal(oneByBlock(rawMailbox(anyPrefix)).resolve(anyPrefix), undefined, 'cualquier prefijo');
});

test('rule 2: the suffix belongs to the first in block order', () => {
  const index = oneByBlock(first, sameSuffix, sameText);
  assert.equal(index.resolve(textOf(first)), first);
  assert.equal(index.resolve(textOf(sameSuffix)), undefined, 'the one from a later block is not indexed');
  assert.equal(index.get(sameSuffix.addrKey), sameSuffix, 'but its slot exists by addrKey');
  assert.equal(oneByBlock(sameSuffix, first).resolve(textOf(sameSuffix)), sameSuffix, 'the order decides');
  assert.equal(oneByBlock(sameText, first).resolve(textOf(first)), sameText);
});

test('tie in the same block: none is indexed and the suffix is blocked', () => {
  const index = new ResolutionIndex();
  index.addBlock(5, [sameSuffix, first]);
  assert.equal(index.resolve(textOf(first)), undefined);
  assert.equal(index.resolve(textOf(sameSuffix)), undefined);
  assert.equal(index.size, 2, 'both slots exist by addrKey');
  index.addBlock(6, [sameText]);
  assert.equal(index.resolve(textOf(sameText)), undefined, 'blocked for the following ones too');
  // another alias in the same block with a free suffix is indexed
  const other = entry(aliasKeyWith('00000000000000000000aa'), Kind.alias, 7);
  const index2 = new ResolutionIndex();
  index2.addBlock(1, [first, sameSuffix, other]);
  assert.equal(index2.resolve(textOf(other)), other);
  // an already indexed suffix is not blocked by a later tie
  const index3 = oneByBlock(first);
  index3.addBlock(9, [sameSuffix, sameText]);
  assert.equal(index3.resolve(textOf(first)), first);
});

test('addBlock is idempotent: redelivering a block (inclusive offsets, hard fork) changes nothing', () => {
  const index = new ResolutionIndex();
  index.addBlock(3, [first, sameSuffix]);
  index.addBlock(3, [first, sameSuffix]);
  index.addBlock(4, [{ ...first, encPk: fill(99) }]);
  assert.equal(index.size, 2);
  assert.equal(index.get(first.addrKey), first, 'what was already seen is not replaced');
  assert.equal(index.resolve(textOf(first)), undefined, 'the block remains');
  const once = new ResolutionIndex();
  once.addBlock(3, [first]);
  once.addBlock(3, [first]);
  once.addBlock(3, [first, first]);
  assert.equal(once.resolve(textOf(first)), first, 'redelivering an alias does not turn it into a tie');
});

test('addBlock rejects heights going backwards and changes nothing if a record is invalid', () => {
  const index = oneByBlock(mailbox('ana'), mailbox('juan'));
  assert.throws(() => index.addBlock(0, [mailbox('luis')]), InvalidInput);
  assert.throws(() => index.addBlock(1.5, []), InvalidInput);
  assert.throws(() => index.addBlock(5, [first, entry('zz', Kind.alias)]), InvalidInput);
  assert.throws(() => index.addBlock(5, [mailbox('luis'), entry('AB'.repeat(32), Kind.mailbox)]), InvalidInput);
  assert.equal(index.size, 2);
  assert.equal(index.resolve(textOf(first)), undefined);
  assert.equal(index.resolve('luis'), undefined);
  index.addBlock(1, [first]); // the height did not advance with the rejected blocks
  assert.equal(index.resolve(textOf(first)), first);
});

test('the suffix index only has aliases and the name lookup only returns mailboxes', () => {
  const box = mailbox('ana');
  assert.equal(oneByBlock(box).resolve(textOf(box)), undefined, 'a mailbox does not occupy a suffix');
  assert.equal(oneByBlock(entry(toHex(addrKey('ana')), Kind.alias)).resolve('ana'), undefined);
  const a = entry(aliasKeyWith(box.addrKey.slice(0, 22)), Kind.alias);
  assert.equal(oneByBlock(box, a).resolve(textOf(a)), a, 'an earlier mailbox with the same suffix does not take it away');
});

test('reserved names are not delivered even if registered', () => {
  const admin = rawMailbox('admin');
  const index = oneByBlock(admin);
  for (const local of ['admin', 'Admin', 'ADMIN']) assert.equal(index.resolve(local), undefined, local);
  assert.equal(index.get(admin.addrKey), admin);
});

test('invalid or too long local parts are not resolved (and do not throw)', () => {
  const index = oneByBlock(mailbox('juan.perez'), mailbox('k'), mailbox('a'.repeat(64)));
  for (const bad of ['', ' ', 'juan perez', 'juan..perez', 'juan+news', 'josé', 'K', 'juan.perez\n', 'a'.repeat(65),
    'x'.repeat(100_000)]) {
    assert.equal(index.resolve(bad), undefined, JSON.stringify(bad).slice(0, 30));
  }
  assert.equal(index.resolve(undefined as unknown as string), undefined);
  assert.equal(index.resolve('k')?.addrKey, toHex(addrKey('k')));
  assert.equal(index.resolve('a'.repeat(64))?.addrKey, toHex(addrKey('a'.repeat(64))), '64 characters is fine');
});

test('an alias from a LATER block with an already taken suffix blocks nobody', () => {
  const index = oneByBlock(first);
  index.addBlock(7, [sameSuffix]);
  index.addBlock(8, [sameText]);
  assert.equal(index.resolve(textOf(first)), first);
  assert.deepEqual(index.exportState().blocked, []);
  assert.equal(index.resolve(textOf(sameSuffix)), undefined);
});

test('the same block in two calls (same height) is a tie: it blocks the suffix', () => {
  const index = new ResolutionIndex();
  index.addBlock(5, [first]);
  assert.equal(index.resolve(textOf(first)), first);
  index.addBlock(5, [sameSuffix]);
  assert.equal(index.resolve(textOf(first)), undefined, 'A does not win by arriving in the first call');
  assert.deepEqual(index.exportState().blocked, [textOf(first).slice(-12)]);
  // at the next height it is no longer a tie
  const later = new ResolutionIndex();
  later.addBlock(5, [first]);
  later.addBlock(6, [sameSuffix]);
  assert.equal(later.resolve(textOf(first)), first);
  // redelivering A at the same height does not block it
  const again = new ResolutionIndex();
  again.addBlock(5, [first]);
  again.addBlock(5, [first]);
  assert.equal(again.resolve(textOf(first)), first);
});

test('addBlock rechaza alturas negativas', () => {
  for (const h of [-1, -5, Number.NaN, Infinity]) assert.throws(() => new ResolutionIndex().addBlock(h, []), InvalidInput, String(h));
  assert.doesNotThrow(() => new ResolutionIndex().addBlock(0, []));
});

// --- Saved state ---------------------------------------------------------------------------------

/** An index with everything: mailboxes, aliases, a blocked suffix and one newly claimed at the last height. */
function busyIndex(): ResolutionIndex {
  const other = entry(aliasKeyWith('00000000000000000000aa'), Kind.alias, 7);
  const index = new ResolutionIndex();
  index.addBlock(1, [mailbox('juan.perez'), first]);
  index.addBlock(2, [sameSuffix]);
  index.addBlock(3, [entry(aliasKeyWith('fedcba9876543210fedcba'), Kind.alias, 8), entry(aliasKeyWith('fedcba9876543210fedcba', 'ef'), Kind.alias, 9)]);
  index.addBlock(4, [other, rawMailbox('admin')]);
  return index;
}

test('exportState / restore: JSON round trip with the same behavior', () => {
  const index = busyIndex();
  const saved = JSON.stringify(index.exportState());
  const restored = ResolutionIndex.restore(JSON.parse(saved));
  assert.deepEqual(restored.exportState(), index.exportState());
  assert.equal(restored.size, index.size);
  const s = index.exportState();
  assert.equal(s.version, RESOLUTION_INDEX_STATE_VERSION);
  assert.equal(s.lastHeight, 4);
  assert.equal(s.blocked.length, 1);
  assert.equal(s.claimedAtLastHeight.length, 1);
  for (const local of [textOf(first), 'juan.perez', textOf(sameSuffix), 'admin', textOf(entry(aliasKeyWith('00000000000000000000aa'), Kind.alias, 7))]) {
    assert.deepEqual(restored.resolve(local), index.resolve(local), local);
  }
  // the restored index behaves like the original: same height, tie across two calls
  const twin = entry(aliasKeyWith('00000000000000000000aa', 'ef'), Kind.alias, 10);
  for (const ix of [index, restored]) ix.addBlock(4, [twin]);
  assert.deepEqual(restored.exportState(), index.exportState());
  assert.throws(() => restored.addBlock(3, []), InvalidInput, 'keeps the height');
  assert.deepEqual(ResolutionIndex.restore(new ResolutionIndex().exportState()).exportState(), new ResolutionIndex().exportState());
});

test('restore rejects an inconsistent state or one from another version', () => {
  const good = () => JSON.parse(JSON.stringify(busyIndex().exportState()));
  const suffixOfFirst = textOf(first).slice(-12);
  const broken: ((s: any) => unknown)[] = [
    () => null, () => 'x', (s) => ({ ...s, version: 2 }), (s) => ({ ...s, lastHeight: -2 }), (s) => ({ ...s, lastHeight: 1.5 }),
    (s) => ({ ...s, addresses: 'x' }), (s) => ({ ...s, suffixes: 'x' }), (s) => ({ ...s, blocked: 'x' }),
    (s) => ({ ...s, claimedAtLastHeight: [1] }), (s) => ({ ...s, addresses: [...s.addresses, s.addresses[0]] }),
    (s) => ({ ...s, addresses: [{ ...s.addresses[0], kind: 2 }] }), (s) => ({ ...s, addresses: [null] }),
    (s) => ({ ...s, addresses: [{ ...s.addresses[0], nameCipher: 'ab' }] }),
    (s) => ({ ...s, suffixes: [...s.suffixes, s.suffixes[0]] }), (s) => ({ ...s, suffixes: [{ ...s.suffixes[0], suffix: 'zzzzzzzzzzzz' }] }),
    (s) => ({ ...s, suffixes: [{ suffix: textOf(mailbox('juan.perez')).slice(-12), addrKey: mailbox('juan.perez').addrKey }] }),
    (s) => ({ ...s, suffixes: [null] }), (s) => ({ ...s, blocked: ['ABCDEFGHIJKL'] }), (s) => ({ ...s, blocked: [...s.blocked, ...s.blocked] }),
    (s) => ({ ...s, blocked: [...s.blocked, suffixOfFirst] }), (s) => ({ ...s, claimedAtLastHeight: ['zzzzzzzzzzzz'] }), // no holder
    (s) => ({ ...s, claimedAtLastHeight: [...s.claimedAtLastHeight, ...s.claimedAtLastHeight] }),
  ];
  for (const [i, change] of broken.entries()) assert.throws(() => ResolutionIndex.restore(change(good())), InvalidInput, String(i));
});
