import { test, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BARRIER_ID, JOURNAL_FILE, LOST_JOURNAL_BARRIER_MS, PRUNE_AFTER_MS, STATE_FILE, UnreadableFile, WalletFiles, seal, unseal,
  type Purchase, type SavedWallet,
} from '../src/walletFiles.ts';
import { AppError, codes } from '../src/codes.ts';

const key = () => new Uint8Array(32).fill(7);
const otherKey = () => new Uint8Array(32).fill(8);
const saved = (address = 'addr-1'): SavedWallet => ({ address, shielded: 's', unshielded: 'u', dust: 'd' });
const purchase = (id = 'p1'): Purchase => ({ id, contractAddress: 'ab'.repeat(32), txHash: 'cd'.repeat(32), ttl: 1_700_000_000_000 });

let root: string;
let dir: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'nm-wallet-files-'));
  dir = path.join(root, 'state');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const badFiles = (name: string) => readdirSync(dir).filter((f) => f.startsWith(`${name}.bad-`));

test('seal and unseal round-trip', () => {
  const value = { a: 1, b: ['x', null], c: { d: true } };
  assert.deepEqual(unseal(key(), 'f.enc', seal(key(), 'f.enc', value)), value);
});

test('seal uses a different nonce each time', () => {
  assert.notEqual(seal(key(), 'f.enc', 1), seal(key(), 'f.enc', 1));
});

test('unseal fails with another key, another file name (AAD) or tampered ciphertext', () => {
  const sealed = seal(key(), 'a.enc', { x: 1 });
  assert.throws(() => unseal(otherKey(), 'a.enc', sealed), UnreadableFile);
  assert.throws(() => unseal(key(), 'b.enc', sealed), UnreadableFile);
  const parsed = JSON.parse(sealed);
  const flipped = (parsed.ct.at(0) === '0' ? '1' : '0') + parsed.ct.slice(1);
  assert.throws(() => unseal(key(), 'a.enc', JSON.stringify({ ...parsed, ct: flipped })), UnreadableFile);
  assert.throws(() => unseal(key(), 'a.enc', JSON.stringify({ ...parsed, ct: parsed.ct.slice(0, -2) })), UnreadableFile);
});

test('unseal fails with invalid JSON, a different version or non-text fields', () => {
  const parsed = JSON.parse(seal(key(), 'a.enc', 1));
  for (const bad of ['no es json', '{}', '[]', JSON.stringify({ ...parsed, v: 2 }), JSON.stringify({ ...parsed, nonce: 5 }),
    JSON.stringify({ ...parsed, ct: '' }), JSON.stringify({ ...parsed, ct: 7 })]) {
    assert.throws(() => unseal(key(), 'a.enc', bad), UnreadableFile);
  }
});

test('WalletFiles rejects a relative folder and a key that is not 32 bytes long', () => {
  assert.throws(() => new WalletFiles('relativa/dir', key()), /absolute/);
  assert.throws(() => new WalletFiles(dir, new Uint8Array(31)), /32 bytes/);
  assert.throws(() => new WalletFiles(dir, new Uint8Array(33)), /32 bytes/);
});

test('WalletFiles creates the folder with 0700 and the files with 0600', { skip: process.platform === 'win32' }, () => {
  const files = new WalletFiles(dir, key());
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  files.writeWallet(saved());
  files.writeJournal([purchase()]);
  for (const name of [STATE_FILE, JOURNAL_FILE]) assert.equal(statSync(path.join(dir, name)).mode & 0o777, 0o600);
});

test('readWallet without a file gives null and sets nothing aside', () => {
  const files = new WalletFiles(dir, key());
  assert.equal(files.readWallet('addr-1'), null);
  assert.equal(files.discarded, false);
});

test('readWallet returns the stored state of that wallet', () => {
  const files = new WalletFiles(dir, key());
  files.writeWallet(saved());
  assert.deepEqual(new WalletFiles(dir, key()).readWallet('addr-1'), saved());
  assert.equal(files.discarded, false);
});

test('readWallet of another wallet gives null and sets the file aside', () => {
  const files = new WalletFiles(dir, key());
  files.writeWallet(saved('addr-1'));
  assert.equal(files.readWallet('addr-2'), null);
  assert.equal(files.discarded, true);
  assert.equal(badFiles(STATE_FILE).length, 1);
  assert.ok(!readdirSync(dir).includes(STATE_FILE));
});

test('readWallet with a file encrypted with another key sets it aside', () => {
  new WalletFiles(dir, otherKey()).writeWallet(saved());
  const files = new WalletFiles(dir, key());
  assert.equal(files.readWallet('addr-1'), null);
  assert.equal(files.discarded, true);
  assert.equal(badFiles(STATE_FILE).length, 1);
});

test('readWallet with a corrupt file or content that is not a state sets it aside', () => {
  writeFileSync(path.join(new WalletFiles(dir, key()).dir, STATE_FILE), 'basura');
  const files = new WalletFiles(dir, key());
  assert.equal(files.readWallet('addr-1'), null);
  assert.equal(badFiles(STATE_FILE).length, 1);

  files.writeWallet({ address: 'addr-1' } as unknown as SavedWallet);
  assert.equal(files.readWallet('addr-1'), null);
  assert.equal(badFiles(STATE_FILE).length, 2);
});

test('discardWallet sets the state aside and marks discarded', () => {
  const files = new WalletFiles(dir, key());
  files.writeWallet(saved());
  files.discardWallet();
  assert.equal(files.discarded, true);
  assert.equal(badFiles(STATE_FILE).length, 1);
  assert.equal(files.readWallet('addr-1'), null);
});

test('discardWallet without a file does not fail', () => {
  const files = new WalletFiles(dir, key());
  files.discardWallet();
  assert.equal(badFiles(STATE_FILE).length, 0);
});

test('the journal round-trips and is empty without a file', () => {
  const files = new WalletFiles(dir, key());
  const now = 1_700_000_000_000;
  assert.deepEqual(files.readJournal(now), []);
  const list = [purchase('p1'), purchase('p2')];
  files.writeJournal(list, now);
  assert.deepEqual(files.readJournal(now), list);
  assert.equal(files.discarded, false);
  assert.deepEqual(badFiles(JOURNAL_FILE), []);
});

test('writeJournal prunes what expired PRUNE_AFTER_MS ago or more', () => {
  const files = new WalletFiles(dir, key());
  const now = 1_700_000_000_000;
  const at = (id: string, ttl: number) => ({ ...purchase(id), ttl });
  files.writeJournal([at('old', now - PRUNE_AFTER_MS), at('edge', now - PRUNE_AFTER_MS + 1), at('future', now + 1000)], now);
  assert.deepEqual(files.readJournal(now).map((p) => p.id), ['edge', 'future']);
});

/** Writes `value` as is into the journal file (bypassing writeJournal). */
const writeRawJournal = (value: unknown) => writeFileSync(path.join(dir, JOURNAL_FILE), seal(key(), JOURNAL_FILE, value));

const isBarrier = (list: Purchase[], now: number) =>
  assert.deepEqual(list, [{ id: BARRIER_ID, contractAddress: '*', txHash: '', ttl: now + LOST_JOURNAL_BARRIER_MS }]);

test('a journal with malformed entries is set aside and leaves a persisted barrier', () => {
  const files = new WalletFiles(dir, key());
  const now = 1_700_000_000_000;
  const bads = [{ not: 'a list' }, [purchase(), { id: 'x' }], [{ ...purchase(), ttl: 1.5 }], [{ ...purchase(), txHash: 3 }]];
  bads.forEach((bad, i) => {
    new WalletFiles(dir, key()); // ensures the folder
    writeRawJournal(bad);
    isBarrier(files.readJournal(now), now);
    assert.equal(badFiles(JOURNAL_FILE).length, i + 1);
    // the barrier was written: another read returns it without setting anything else aside
    isBarrier(files.readJournal(now), now);
    assert.equal(badFiles(JOURNAL_FILE).length, i + 1);
  });
  assert.equal(files.discarded, true);
});

test('a journal encrypted with another key is set aside and leaves a barrier', () => {
  const now = 1_700_000_000_000;
  new WalletFiles(dir, otherKey()).writeJournal([purchase()], now - 1000);
  const files = new WalletFiles(dir, key());
  isBarrier(files.readJournal(now), now);
  assert.equal(files.discarded, true);
  assert.equal(badFiles(JOURNAL_FILE).length, 1);
  isBarrier(files.readJournal(now), now);
});

test('a journal with garbage leaves a barrier', () => {
  const files = new WalletFiles(dir, key());
  writeFileSync(path.join(dir, JOURNAL_FILE), 'basura');
  isBarrier(files.readJournal(5), 5);
  assert.equal(badFiles(JOURNAL_FILE).length, 1);
});

test('readWallet of an unreadable state does not create a barrier in the journal', () => {
  const files = new WalletFiles(dir, key());
  writeFileSync(path.join(dir, STATE_FILE), 'basura');
  assert.equal(files.readWallet('addr-1'), null);
  assert.equal(files.discarded, true);
  assert.deepEqual(files.readJournal(), []);
  assert.deepEqual(badFiles(JOURNAL_FILE), []);
});

test('one file cannot pass for the other (the name goes in the AAD)', () => {
  const files = new WalletFiles(dir, key());
  files.writeJournal([purchase()]);
  writeFileSync(path.join(dir, STATE_FILE), readFileSync(path.join(dir, JOURNAL_FILE)));
  assert.equal(files.readWallet('addr-1'), null);
  assert.equal(badFiles(STATE_FILE).length, 1);
});

test('after wipe() reading or writing gives WALLET_UNAVAILABLE not-open and nothing is set aside', () => {
  const files = new WalletFiles(dir, key());
  files.writeWallet(saved());
  files.writeJournal([{ ...purchase(), ttl: Date.now() + 60_000 }]);
  files.wipe();
  const notOpen = (e: unknown) => e instanceof AppError && e.code === codes.WALLET_UNAVAILABLE
    && (e.data as { reason: string }).reason === 'not-open';
  assert.throws(() => files.readWallet('addr-1'), notOpen);
  assert.throws(() => files.readJournal(), notOpen);
  assert.throws(() => files.writeWallet(saved()), notOpen);
  assert.throws(() => files.writeJournal([]), notOpen);
  assert.equal(files.discarded, false);
  assert.deepEqual(badFiles(STATE_FILE), []);
  assert.deepEqual(badFiles(JOURNAL_FILE), []);
  assert.deepEqual(readdirSync(dir).sort(), [JOURNAL_FILE, STATE_FILE]);
  // the file is still intact for whoever has the key
  assert.deepEqual(new WalletFiles(dir, key()).readWallet('addr-1'), saved());
});

test('WalletFiles keeps its own copy of the key', () => {
  const k = key();
  const files = new WalletFiles(dir, k);
  files.writeWallet(saved());
  k.fill(0);
  assert.deepEqual(files.readWallet('addr-1'), saved());
});
