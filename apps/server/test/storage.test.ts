import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  acquireLock, currentProcessId, ensurePrivateDir, InsecurePermissionsError, loadOrCreateSecret, loadOrCreateSeed,
  readState, WalletInUseError, writePrivateFile, writeState,
} from '../src/wallet/storage.ts';

const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'nm-wallet-'));
  chmodSync(d, 0o700);
  return path.join(d, 'operator');
};
const perms = (p: string) => (statSync(p).mode & 0o777).toString(8);
const seed32 = () => new Uint8Array(32).fill(7);

test('creates the seed with 0600 in a 0700 directory and does not overwrite it', () => {
  const dir = tmp();
  const a = loadOrCreateSeed(dir, seed32);
  assert.equal(a.created, true);
  assert.equal(perms(dir), '700');
  assert.equal(perms(path.join(dir, 'seed')), '600');
  const b = loadOrCreateSeed(dir, () => new Uint8Array(32).fill(9));
  assert.equal(b.created, false);
  assert.deepEqual(b.seed, a.seed, 'an existing seed is never regenerated');
});

test('rejects a seed with an invalid format', () => {
  const dir = tmp();
  ensurePrivateDir(dir);
  writeFileSync(path.join(dir, 'seed'), 'zz-no-es-hex', { mode: 0o600 });
  assert.throws(() => loadOrCreateSeed(dir, seed32), /not a valid seed/);
});

test('on Windows permissions are not checked (they do not exist there), but the format is', () => {
  const dir = tmp();
  loadOrCreateSecret(dir, 'operator-sk', seed32, 'win32');
  chmodSync(path.join(dir, 'operator-sk'), 0o644);
  chmodSync(dir, 0o755);
  const again = loadOrCreateSecret(dir, 'operator-sk', () => new Uint8Array(32).fill(9), 'win32');
  assert.equal(again.created, false);
  assert.deepEqual(again.value, Buffer.from(seed32()));
  writeFileSync(path.join(dir, 'roto'), 'xx', { mode: 0o600 });
  assert.throws(() => loadOrCreateSecret(dir, 'roto', seed32, 'win32'), /not a valid roto/);
});

test('refuses to continue with insecure permissions', () => {
  const dir = tmp();
  loadOrCreateSeed(dir, seed32);
  chmodSync(path.join(dir, 'seed'), 0o644);
  assert.throws(() => loadOrCreateSeed(dir, seed32), InsecurePermissionsError);
  chmodSync(path.join(dir, 'seed'), 0o600);
  chmodSync(dir, 0o755);
  assert.throws(() => loadOrCreateSeed(dir, seed32), InsecurePermissionsError);
});

test('named secrets: 0600, never overwritten and each one independent', () => {
  const dir = tmp();
  const a = loadOrCreateSecret(dir, 'operator-sk', seed32);
  assert.equal(a.created, true);
  assert.equal(perms(path.join(dir, 'operator-sk')), '600');
  const again = loadOrCreateSecret(dir, 'operator-sk', () => new Uint8Array(32).fill(9));
  assert.equal(again.created, false);
  assert.deepEqual(again.value, a.value);
  const other = loadOrCreateSecret(dir, 'maintenance-key-registry', () => new Uint8Array(32).fill(9));
  assert.notDeepEqual(other.value, a.value);
  assert.throws(() => loadOrCreateSecret(dir, '../fuera', seed32), /Invalid secret name/);
  writeFileSync(path.join(dir, 'roto'), 'xx', { mode: 0o600 });
  assert.throws(() => loadOrCreateSecret(dir, 'roto', seed32), /not a valid roto/);
});

test('if another instance creates the secret at the same time, its secret is used and not overwritten', () => {
  const dir = tmp();
  ensurePrivateDir(dir);
  const theirs = 'ab'.repeat(32);
  const mine = loadOrCreateSecret(dir, 'operator-sk', () => {
    writeFileSync(path.join(dir, 'operator-sk'), theirs, { mode: 0o600 }); // the other instance wins
    return new Uint8Array(32).fill(1);
  });
  assert.equal(mine.created, false);
  assert.equal(mine.value.toString('hex'), theirs);
});

test('a state with version 1 but incomplete is set aside', () => {
  const dir = tmp();
  ensurePrivateDir(dir);
  writeFileSync(path.join(dir, 'wallet-state-v1.json'), JSON.stringify({ version: 1, address: 'mn_addr', shielded: 's', unshielded: 'u' }));
  assert.equal(readState(dir, 'mn_addr'), null);
  assert.ok(readdirSync(dir).some((f) => f.startsWith('wallet-state-v1.json.bad-')), 'set aside, not deleted');
});

test('writePrivateFile writes atomically with 0600 permissions and replaces the previous one', () => {
  const dir = tmp();
  ensurePrivateDir(dir);
  writePrivateFile(dir, 'contracts.json', '{"a":1}');
  assert.equal(readFileSync(path.join(dir, 'contracts.json'), 'utf8'), '{"a":1}');
  assert.equal(perms(path.join(dir, 'contracts.json')), '600');
  writePrivateFile(dir, 'contracts.json', '{"a":2}');
  assert.equal(readFileSync(path.join(dir, 'contracts.json'), 'utf8'), '{"a":2}');
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no temporaries');
  assert.throws(() => writePrivateFile(dir, 'a/b', 'x'), /Invalid file name/);
  // An old temp file with open permissions does not leak them to the new file.
  writeFileSync(path.join(dir, 'contracts.json.tmp'), 'viejo', { mode: 0o644 });
  writePrivateFile(dir, 'contracts.json', '{"a":3}');
  assert.equal(perms(path.join(dir, 'contracts.json')), '600');
});

test('lock: cannot be opened twice, not even in the same process', () => {
  const dir = tmp();
  ensurePrivateDir(dir);
  const release = acquireLock(dir);
  assert.equal(perms(path.join(dir, 'lock')), '600');
  assert.throws(() => acquireLock(dir), WalletInUseError);
  release();
  assert.equal(existsSync(path.join(dir, 'lock')), false);
  acquireLock(dir)(); // once released it can be taken again
});

test('lock held by another live process: respected', async () => {
  const dir = tmp();
  ensurePrivateDir(dir);
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  try {
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(path.join(dir, 'lock'), JSON.stringify(currentProcessId(child.pid!)));
    assert.throws(() => acquireLock(dir), WalletInUseError);
  } finally {
    child.kill();
  }
});

test('orphaned lock, reused pid or old format: recovered', () => {
  const dir = tmp();
  ensurePrivateDir(dir);
  const lock = path.join(dir, 'lock');
  const cases = [
    JSON.stringify({ ...currentProcessId(process.ppid), start: 'otro-arranque' }), // live pid but reused
    JSON.stringify({ ...currentProcessId(process.ppid), boot: 'otro-boot' }), // from an earlier WSL boot
    '999999999', // legacy format: pid only
    '', // empty
  ];
  for (const content of cases) {
    writeFileSync(lock, content);
    const release = acquireLock(dir);
    release();
    assert.equal(existsSync(lock), false, `caso: ${JSON.stringify(content)}`);
  }
});

test('state: round trip, 0600 and no .tmp', () => {
  const dir = tmp();
  ensurePrivateDir(dir);
  const state = { version: 1 as const, address: 'addr1', shielded: 's', unshielded: 'u', dust: 'd' };
  writeState(dir, state);
  assert.deepEqual(readState(dir, 'addr1'), state);
  assert.equal(perms(path.join(dir, 'wallet-state-v1.json')), '600');
  assert.ok(!readdirSync(dir).some((f) => f.endsWith('.tmp')));
});

test('unreadable state or one from another wallet: set aside, not overwritten', () => {
  const dir = tmp();
  ensurePrivateDir(dir);
  writeFileSync(path.join(dir, 'wallet-state-v1.json'), '{roto');
  assert.equal(readState(dir, 'addr1'), null);
  writeState(dir, { version: 1, address: 'otra', shielded: 's', unshielded: 'u', dust: 'd' });
  assert.equal(readState(dir, 'addr1'), null);
  const bad = readdirSync(dir).filter((f) => f.includes('.bad-'));
  assert.equal(bad.length, 2, `both set-aside states are kept: ${bad}`);
  assert.equal(readFileSync(path.join(dir, bad.sort()[0]), 'utf8'), '{roto');
});

test('null, array or number state: set aside without throwing', () => {
  const dir = tmp();
  ensurePrivateDir(dir);
  for (const content of ['null', '[]', '42']) {
    writeFileSync(path.join(dir, 'wallet-state-v1.json'), content);
    assert.equal(readState(dir, 'addr1'), null, content);
  }
  assert.equal(readdirSync(dir).filter((f) => f.includes('.bad-')).length, 3);
});

test('state in the old format: migrated', () => {
  const dir = tmp();
  ensurePrivateDir(dir);
  writeFileSync(path.join(dir, 'wallet-state-v1.json'), JSON.stringify({ shielded: 's', unshielded: 'u', dust: 'd' }));
  assert.deepEqual(readState(dir, 'addr1'), { version: 1, address: 'addr1', shielded: 's', unshielded: 'u', dust: 'd' });
});
