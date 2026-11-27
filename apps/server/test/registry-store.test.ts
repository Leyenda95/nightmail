import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResolutionIndex } from '@nightmail/midnight';
import { MEMORY, openDatabase } from '../src/storage/db.ts';
import { RegistryStore, WrongContract } from '../src/registry/store.ts';
import { alias, mailbox, sameSuffixKey } from './mail-fixtures.ts';

const CONTRACT = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);

test('a new database starts with no addresses and no height', () => {
  const store = new RegistryStore(openDatabase(MEMORY), CONTRACT);
  const { index, cursor, fetched, problem } = store.load();
  assert.equal(index.size, 0);
  assert.equal(cursor, -1);
  assert.equal(fetched, -1);
  assert.equal(problem, undefined);
});

test('stores the whole index and the height, and gets them back as is on reopen', () => {
  const db = openDatabase(MEMORY);
  const store = new RegistryStore(db, CONTRACT);
  const juan = mailbox('juan.perez');
  const first = alias();
  const one = alias();
  const two = alias(sameSuffixKey(one.addrKey));
  const index = new ResolutionIndex();
  index.addBlock(5, [juan.entry, first.entry]);
  index.addBlock(9, [one.entry, two.entry]); // tie: that suffix becomes blocked
  store.saveIndex(index, 12);

  const reopened = new RegistryStore(db, CONTRACT).load();
  assert.equal(reopened.cursor, 12);
  assert.equal(reopened.fetched, 9, 'the last height whose state was read');
  assert.equal(reopened.index.size, 4);
  assert.deepEqual(reopened.index.resolve('Juan.Perez'), juan.entry);
  assert.deepEqual(reopened.index.resolve(first.localPart), first.entry, 'suffix → addrKey');
  assert.equal(reopened.index.resolve(one.localPart), undefined, 'blocked suffixes stay blocked');
  assert.deepEqual(reopened.index.exportState(), index.exportState());
});

test('a round left by an earlier version (the round-based reveal) is ignored: the index is still valid', () => {
  const db = openDatabase(MEMORY);
  const store = new RegistryStore(db, CONTRACT);
  const index = new ResolutionIndex();
  index.addBlock(5, [alias().entry]);
  store.saveIndex(index, 6);
  db.prepare("INSERT INTO registry_meta (key, value) VALUES ('round', ?)").run('{"round":"5","waiting":true}');
  const loaded = store.load();
  assert.deepEqual([loaded.index.size, loaded.cursor, loaded.problem], [1, 6, undefined]);
  assert.ok(!('round' in loaded));
});

test('saveCursor only moves the height, the stored index does not change', () => {
  const db = openDatabase(MEMORY);
  const store = new RegistryStore(db, CONTRACT);
  const index = new ResolutionIndex();
  index.addBlock(5, [alias().entry]);
  store.saveIndex(index, 5);
  index.addBlock(6, [alias().entry]); // not saved yet
  store.saveCursor(40);
  const reopened = new RegistryStore(db, CONTRACT).load();
  assert.equal(reopened.cursor, 40);
  assert.equal(reopened.index.size, 1);
});

test('with a stored height but no index (no blocks with addresses yet) it resumes from that height', () => {
  const db = openDatabase(MEMORY);
  new RegistryStore(db, CONTRACT).saveCursor(40);
  const { index, cursor, fetched, problem } = new RegistryStore(db, CONTRACT).load();
  assert.equal(index.size, 0);
  assert.equal(cursor, 40);
  assert.equal(fetched, -1);
  assert.equal(problem, undefined);
});

test('a database of another contract is not used: the boxes of one deployment are not valid for another', () => {
  const db = openDatabase(MEMORY);
  new RegistryStore(db, CONTRACT);
  assert.throws(() => new RegistryStore(db, OTHER), WrongContract);
  new RegistryStore(db, CONTRACT); // the same contract is fine
});

test('rejects a malformed contract address', () => {
  for (const bad of ['', 'AB'.repeat(32), 'ab'.repeat(31), `${'ab'.repeat(32)}00`]) {
    assert.throws(() => new RegistryStore(openDatabase(MEMORY), bad), /contract address/);
  }
});

for (const [what, value] of [
  ['broken JSON', '{"version":1,'],
  ['another state version', JSON.stringify({ version: 2, lastHeight: -1, addresses: [], suffixes: [], blocked: [], claimedAtLastHeight: [] })],
  ['inconsistent state', JSON.stringify({ version: 1, lastHeight: 3, addresses: [], suffixes: [{ suffix: '0'.repeat(12), addrKey: 'ab'.repeat(32) }], blocked: [], claimedAtLastHeight: [] })],
] as const) {
  test(`an unreadable stored index (${what}) is discarded whole: it syncs again from the deployment`, () => {
    const db = openDatabase(MEMORY);
    const store = new RegistryStore(db, CONTRACT);
    store.saveIndex(new ResolutionIndex(), 77);
    db.prepare("UPDATE registry_meta SET value = ? WHERE key = 'index'").run(value);
    const { index, cursor, problem } = store.load();
    assert.equal(index.size, 0);
    assert.equal(cursor, -1, 'the height is not kept: all blocks must be replayed');
    assert.equal(problem, 'saved index unreadable');
    const rows = db.prepare('SELECT key FROM registry_meta ORDER BY key').all() as { key: string }[];
    assert.deepEqual(rows.map((r) => r.key), ['contract', 'cursor.discarded', 'index.discarded'], 'the unreadable data is set aside, not deleted');
    assert.equal(store.load().problem, undefined, 'the next start does not discard it again');
  });
}

test('a stored height that is not a valid integer also forces starting from scratch', () => {
  for (const bad of ['x', '-2', '1.5', '9007199254740993']) {
    const db = openDatabase(MEMORY);
    const store = new RegistryStore(db, CONTRACT);
    const index = new ResolutionIndex();
    index.addBlock(5, [alias().entry]);
    store.saveIndex(index, 5);
    db.prepare("UPDATE registry_meta SET value = ? WHERE key = 'cursor'").run(bad);
    const loaded = store.load();
    assert.equal(loaded.cursor, -1, bad);
    assert.equal(loaded.index.size, 0, bad);
    assert.equal(loaded.problem, 'saved index unreadable');
  }
});

test('the stored height never falls behind the latest one of the index', () => {
  const db = openDatabase(MEMORY);
  const store = new RegistryStore(db, CONTRACT);
  const index = new ResolutionIndex();
  index.addBlock(8, [alias().entry]);
  store.saveIndex(index, 8);
  db.prepare("UPDATE registry_meta SET value = '7' WHERE key = 'cursor'").run();
  assert.equal(store.load().problem, 'saved index unreadable', 'a cursor older than the index is inconsistent');
  db.prepare("UPDATE registry_meta SET value = '8' WHERE key = 'cursor'").run();
  assert.equal(store.load().problem, undefined);
});
