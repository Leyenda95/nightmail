// Journal of in-flight issuances: the minimum to remember across restarts so the same id is never issued
// twice (a submitted transaction whose outcome is still unknown may yet land in a block).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { IssueJournal, JournalUnreadableError } from '../src/payer/journal.ts';
import { tempDir } from './temp-dir.ts';

const FILE = 'payer-issues.json';
const id = (n: number) => n.toString(16).padStart(64, '0');
const entry = (validUntil: number, plan: 'free' | 'paid' = 'free') => ({ plan, txHash: id(validUntil), validUntil });

test('without a file it starts empty and creates nothing until there is something to record', (t) => {
  const dir = tempDir(t);
  const journal = IssueJournal.open(dir);
  assert.equal(journal.get(id(1)), undefined);
  assert.equal(journal.size, 0);
  journal.delete(id(1)); // deleting a missing id does not write
  assert.deepEqual(readdirSync(dir), []);
});

test('records survive a restart, the file is private (0600) and leaves no temporaries', (t) => {
  const dir = tempDir(t);
  const journal = IssueJournal.open(dir);
  journal.put(id(1), entry(5000, 'paid'), 0);
  journal.put(id(2), entry(6000), 0);
  assert.deepEqual(readdirSync(dir), [FILE]);
  assert.equal(statSync(path.join(dir, FILE)).mode & 0o777, 0o600);
  const reopened = IssueJournal.open(dir);
  assert.deepEqual(reopened.get(id(1)), entry(5000, 'paid'));
  assert.deepEqual(reopened.get(id(2)), entry(6000));
  assert.equal(reopened.size, 2);
  reopened.delete(id(1));
  const again = IssueJournal.open(dir);
  assert.equal(again.get(id(1)), undefined, 'the deletion is saved too');
  assert.deepEqual(again.get(id(2)), entry(6000));
});

test('recording forgets entries that expired before the given instant (they can no longer land in a block)', (t) => {
  const dir = tempDir(t);
  const journal = IssueJournal.open(dir);
  journal.put(id(1), entry(1000), 0);
  journal.put(id(2), entry(2000), 0);
  journal.put(id(3), entry(9000), 2000); // expired: validUntil < 2000
  assert.equal(journal.get(id(1)), undefined);
  assert.deepEqual(journal.get(id(2)), entry(2000), 'the one expiring exactly at that instant is kept');
  assert.equal(IssueJournal.open(dir).size, 2);
});

test('returns copies: changing what was read does not change the journal', (t) => {
  const journal = IssueJournal.open(tempDir(t));
  journal.put(id(1), entry(5000), 0);
  journal.get(id(1))!.validUntil = 1;
  assert.equal(journal.get(id(1))!.validUntil, 5000);
});

test('an unreadable journal or one with invalid data is not ignored: it refuses to continue', (t) => {
  const valid = { version: 1, inFlight: { [id(1)]: entry(5000) } };
  const bad: unknown[] = [
    'no es json',
    null,
    [],
    { version: 2, inFlight: {} },
    { version: 1 },
    { version: 1, inFlight: [] },
    { version: 1, inFlight: { corto: entry(1) } },
    { version: 1, inFlight: { [id(1)]: { ...entry(1), plan: 'gold' } } },
    { version: 1, inFlight: { [id(1)]: { ...entry(1), txHash: 'xyz' } } },
    { version: 1, inFlight: { [id(1)]: { ...entry(1), validUntil: '5000' } } },
    { version: 1, inFlight: { [id(1)]: { ...entry(1), validUntil: -1 } } },
    { version: 1, inFlight: { [id(1)]: null } },
  ];
  for (const content of bad) {
    const dir = tempDir(t);
    writeFileSync(path.join(dir, FILE), typeof content === 'string' ? content : JSON.stringify(content));
    assert.throws(() => IssueJournal.open(dir), JournalUnreadableError, JSON.stringify(content));
    assert.deepEqual(readdirSync(dir), [FILE], 'and does not touch the file');
  }
  const dir = tempDir(t);
  writeFileSync(path.join(dir, FILE), JSON.stringify(valid));
  assert.deepEqual(IssueJournal.open(dir).get(id(1)), entry(5000));
});

test('if it cannot save, recording throws and memory stays as it was (unsaved data does not count)', (t) => {
  const dir = tempDir(t);
  const journal = IssueJournal.open(dir);
  journal.put(id(1), entry(5000), 0);
  rmSync(dir, { recursive: true });
  assert.throws(() => journal.put(id(2), entry(6000), 0));
  assert.equal(journal.get(id(2)), undefined);
  assert.throws(() => journal.put(id(1), entry(7000), 0));
  assert.deepEqual(journal.get(id(1)), entry(5000), 'the previous one for the same id is kept');
  assert.equal(journal.size, 1);
});

test('the file stores the version and the entries by id', (t) => {
  const dir = tempDir(t);
  IssueJournal.open(dir).put(id(7), entry(5000), 0);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, FILE), 'utf8')), { version: 1, inFlight: { [id(7)]: entry(5000) } });
});

test('a journal with an entry that is not an object (number, text, boolean) is not understood', (t) => {
  for (const value of [5, 'texto', true]) {
    const dir = tempDir(t);
    writeFileSync(path.join(dir, FILE), JSON.stringify({ version: 1, inFlight: { [id(1)]: value } }));
    assert.throws(() => IssueJournal.open(dir), JournalUnreadableError, JSON.stringify(value));
  }
});

test('a journal with another version is not understood even if its shape is valid', (t) => {
  const dir = tempDir(t);
  writeFileSync(path.join(dir, FILE), JSON.stringify({ version: 2, inFlight: {} }));
  assert.throws(() => IssueJournal.open(dir), JournalUnreadableError);
});

test('validUntil 0 is valid (lower bound) and -1 is not', (t) => {
  const ok = tempDir(t);
  writeFileSync(path.join(ok, FILE), JSON.stringify({ version: 1, inFlight: { [id(1)]: { plan: 'free', txHash: id(1), validUntil: 0 } } }));
  assert.deepEqual(IssueJournal.open(ok).get(id(1)), { plan: 'free', txHash: id(1), validUntil: 0 });
  const bad = tempDir(t);
  writeFileSync(path.join(bad, FILE), JSON.stringify({ version: 1, inFlight: { [id(1)]: { plan: 'free', txHash: id(1), validUntil: -1 } } }));
  assert.throws(() => IssueJournal.open(bad), JournalUnreadableError);
});
