// Private directory and directory fsync on Windows. The platform is passed as an argument, so both branches
// (Windows and Linux) are tested on any OS without touching `process.platform`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  acquireLock, currentProcessId, ensurePrivateDir, fsyncDir, hasUnixModes, InsecurePermissionsError, isDirFsyncUnsupported, pidExists,
  realWindowsProbe, REUSED_PID_MARGIN_MS, WalletInUseError, windowsProcessStart, type WindowsProbe,
} from '../src/index.ts';

/** Directory open to others (0755). On Windows `chmod` has no effect on this: Node always sees 0666 or 0777. */
function openDir(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(path.join(tmpdir(), 'nm-private-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'datos');
  ensurePrivateDir(dir, 'win32');
  chmodSync(dir, 0o755);
  return dir;
}

const errno = (code: string) => Object.assign(new Error(`${code}: fsync`), { code });

test('Unix permissions are checked on Linux and macOS, not on Windows', () => {
  assert.equal(hasUnixModes('linux'), true);
  assert.equal(hasUnixModes('darwin'), true);
  assert.equal(hasUnixModes('win32'), false);
});

test('ensurePrivateDir on Windows does not check the mode: an open folder is not an error', (t) => {
  const dir = openDir(t);
  assert.doesNotThrow(() => ensurePrivateDir(dir, 'win32'));
});

test('ensurePrivateDir on Linux still refuses a folder open to others', (t) => {
  const dir = openDir(t);
  assert.throws(() => ensurePrivateDir(dir, 'linux'), (e: unknown) => e instanceof InsecurePermissionsError && /chmod 700/.test(String(e)));
});

test('folder fsync is only given up as impossible with EPERM and on Windows', () => {
  assert.equal(isDirFsyncUnsupported(errno('EPERM'), 'win32'), true);
  assert.equal(isDirFsyncUnsupported(errno('EPERM'), 'linux'), false);
  assert.equal(isDirFsyncUnsupported(errno('EIO'), 'win32'), false);
  assert.equal(isDirFsyncUnsupported(null, 'win32'), false);
});

test('fsyncDir: EPERM on Windows is silent: on Linux, or with another error, it warns', (t) => {
  const dir = openDir(t);
  const warn = t.mock.method(console, 'warn', () => {});
  fsyncDir(dir, 'win32', () => { throw errno('EPERM'); });
  assert.equal(warn.mock.callCount(), 0, 'on Windows it is not a failure');
  fsyncDir(dir, 'linux', () => { throw errno('EPERM'); });
  fsyncDir(dir, 'win32', () => { throw errno('EIO'); });
  assert.equal(warn.mock.callCount(), 2);
});

test('pidExists: the own process exists: an invalid pid does not: EPERM (another user) counts as alive', () => {
  assert.equal(pidExists(process.pid), true);
  for (const pid of [0, -1, Number.NaN, 1.5]) assert.equal(pidExists(pid), false, String(pid));
  assert.equal(pidExists(1234, () => { throw errno('ESRCH'); }), false);
  assert.equal(pidExists(1234, () => { throw errno('EPERM'); }), true);
});

// The lock on Windows (no /proc) only counts while the pid exists. Tested on any OS.
test('acquireLock on Windows: not twice in the same process, nor with another one alive: an already dead pid is recovered', async (t) => {
  const dir = openDir(t);
  const lock = path.join(dir, 'lock');
  const release = acquireLock(dir, 'wallet', 'win32');
  assert.throws(() => acquireLock(dir, 'wallet', 'win32'), WalletInUseError);
  release();
  assert.equal(existsSync(lock), false);

  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  const exited = new Promise((r) => child.once('exit', r));
  try {
    await new Promise((r) => child.once('spawn', r));
    // What that process would write on Windows: without /proc, start and boot are "unknown".
    writeFileSync(lock, JSON.stringify({ pid: child.pid, start: 'unknown', boot: 'unknown' }));
    assert.throws(() => acquireLock(dir, 'wallet', 'win32'), WalletInUseError, 'another live process: it is respected');
  } finally {
    child.kill();
  }
  await exited;
  acquireLock(dir, 'wallet', 'win32')();
  assert.equal(existsSync(lock), false, 'dead pid: it is recovered');
});

/** A child process that stays alive for the test, so its pid really exists. */
async function liveChild(t: { after: (fn: () => Promise<void>) => void }): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  t.after(async () => { child.kill(); await exited; });
  await new Promise((r) => child.once('spawn', r));
  return child.pid!;
}

const NOW = Date.now();
/** Simulated Windows: uptime is `uptime` seconds and each pid started at the time given by `starts`. */
function fakeWindows(starts: Record<number, number | null> = {}, uptime = 1000): WindowsProbe & { asked: number[] } {
  const asked: number[] = [];
  return {
    asked, ownStart: NOW - 60_000, uptime: () => uptime,
    processStart: (pid) => { asked.push(pid); return starts[pid] ?? null; },
  };
}
const lockOf = (dir: string) => path.join(dir, 'lock');
const writeLock = (dir: string, owner: object) => writeFileSync(lockOf(dir), JSON.stringify(owner));
const winOwner = (pid: number, winStart: number, winUptime: number) => ({ pid, start: 'unknown', boot: 'unknown', winStart, winUptime });

test('acquireLock on Windows stores when the process started and how long the machine had been on', (t) => {
  const dir = openDir(t);
  const probe = fakeWindows();
  const release = acquireLock(dir, 'wallet', 'win32', probe);
  assert.deepEqual(JSON.parse(readFileSync(lockOf(dir), 'utf8')), { ...currentProcessId(), winStart: probe.ownStart, winUptime: 1000 });
  release();
  assert.equal(existsSync(lockOf(dir)), false);
});

test('acquireLock on Windows: after a reboot, a lock whose pid is now used by another program is recovered on its own', async (t) => {
  const dir = openDir(t);
  const pid = await liveChild(t);
  // Taken at 5000 s of uptime and now uptime is 1000 s, so the machine rebooted in between.
  writeLock(dir, winOwner(pid, NOW - 3_600_000, 5000));
  const probe = fakeWindows({ [pid]: NOW - 30_000 });
  acquireLock(dir, 'wallet', 'win32', probe)();
  assert.deepEqual(probe.asked, [], 'the reboot is enough, without asking PowerShell');
});

test('acquireLock on Windows: a pid reused by another program (started later) is recovered on its own', async (t) => {
  const dir = openDir(t);
  const pid = await liveChild(t);
  writeLock(dir, winOwner(pid, NOW - 600_000, 500));
  const probe = fakeWindows({ [pid]: NOW - 600_000 + REUSED_PID_MARGIN_MS + 1 });
  acquireLock(dir, 'wallet', 'win32', probe)();
  assert.deepEqual(probe.asked, [pid]);
});

test('acquireLock on Windows: two live instances still block, also if the start time is unknown', async (t) => {
  const dir = openDir(t);
  const pid = await liveChild(t);
  writeLock(dir, winOwner(pid, NOW - 600_000, 500));
  for (const started of [NOW - 600_000, NOW - 600_100, NOW - 600_000 + REUSED_PID_MARGIN_MS, null]) {
    assert.throws(() => acquireLock(dir, 'wallet', 'win32', fakeWindows({ [pid]: started })), WalletInUseError, String(started));
  }
  // Not within the same process either, and without asking PowerShell.
  rmSync(lockOf(dir));
  const probe = fakeWindows();
  const release = acquireLock(dir, 'wallet', 'win32', probe);
  assert.throws(() => acquireLock(dir, 'wallet', 'win32', probe), WalletInUseError);
  assert.deepEqual(probe.asked, []);
  release();
});

test('acquireLock on Windows: a lock from a previous process with our same pid is recovered', (t) => {
  const dir = openDir(t);
  const probe = fakeWindows();
  writeLock(dir, winOwner(process.pid, probe.ownStart - 3_600_000, 500));
  acquireLock(dir, 'wallet', 'win32', probe)();
});

test('acquireLock on Windows: an old lock, without the new marks, is treated as before (it is enough that the pid exists)', async (t) => {
  const dir = openDir(t);
  const pid = await liveChild(t);
  // Even if the machine looks freshly booted and the pid seems to be another program, without marks there is nothing to compare.
  const probe = fakeWindows({ [pid]: NOW }, 1);
  writeLock(dir, { pid, start: 'unknown', boot: 'unknown' });
  assert.throws(() => acquireLock(dir, 'wallet', 'win32', probe), WalletInUseError);
  writeLock(dir, { pid });
  assert.throws(() => acquireLock(dir, 'wallet', 'win32', probe), WalletInUseError);
  assert.deepEqual(probe.asked, []);
});

test('the "in use" notice explains on Windows what to do (without suggesting deleting the file), on Linux it does not change', async (t) => {
  const dir = openDir(t);
  const pid = await liveChild(t);
  writeLock(dir, winOwner(pid, NOW, 500));
  assert.throws(() => acquireLock(dir, 'wallet', 'win32', fakeWindows({ [pid]: NOW })), (e: unknown) =>
    e instanceof WalletInUseError && e.message.startsWith(`wallet already in use by process ${pid}. Close the other NightMail window.`)
    && e.message.endsWith('If the message persists, restart the computer') && !e.message.includes('delete'));
  if (process.platform !== 'linux') return; // on Linux the holder is identified through /proc
  writeLock(dir, currentProcessId(pid));
  assert.throws(() => acquireLock(dir, 'wallet', 'linux'), (e: unknown) =>
    e instanceof WalletInUseError && e.message === `wallet already in use by process ${pid}`);
});

test('acquireLock on Linux does not change: the lock carries no Windows marks and nothing is asked', { skip: process.platform !== 'linux' }, (t) => {
  const dir = openDir(t);
  const probe = fakeWindows();
  const release = acquireLock(dir, 'wallet', 'linux', probe);
  assert.deepEqual(JSON.parse(readFileSync(lockOf(dir), 'utf8')), { ...currentProcessId(), host: hostname() });
  assert.throws(() => acquireLock(dir, 'wallet', 'linux', probe), WalletInUseError);
  release();
  // With Windows marks and our own pid from another boot, it is recovered through /proc as usual.
  writeLock(dir, { ...winOwner(process.pid, probe.ownStart, 1e9), start: 'other', boot: 'other' });
  acquireLock(dir, 'wallet', 'linux', probe)();
  assert.deepEqual(probe.asked, []);
});

test('acquireLock: if another process changes the lock while it is being judged, the new one is not removed', async (t) => {
  const dir = openDir(t);
  const pid = await liveChild(t);
  writeLock(dir, winOwner(pid, NOW - 600_000, 500));
  const fresh = winOwner(pid, NOW - 1000, 500);
  const probe = fakeWindows();
  // First probe: the pid looks like another program (the old lock is stale), but meanwhile another process moved it
  // away and took a new, live one. Second probe: that new holder started at the expected time.
  probe.processStart = (p) => {
    probe.asked.push(p);
    if (probe.asked.length === 1) {
      writeLock(dir, fresh);
      return NOW;
    }
    return NOW - 1000;
  };
  assert.throws(() => acquireLock(dir, 'wallet', 'win32', probe), WalletInUseError);
  assert.deepEqual(JSON.parse(readFileSync(lockOf(dir), 'utf8')), fresh, 'the new lock is still in place');
  assert.deepEqual(probe.asked, [pid, pid]);
});

test('real acquireLock between two processes: the lock of a live child is respected and, when it dies, recovered', async (t) => {
  const dir = openDir(t);
  const src = pathToFileURL(path.join(import.meta.dirname, '../src/privateFiles.ts')).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', [
    `const { acquireLock } = await import(${JSON.stringify(src)});`,
    `acquireLock(${JSON.stringify(dir)}, 'wallet');`,
    `console.log('ok');`,
    'setTimeout(() => {}, 30000);',
  ].join('\n')], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  t.after(async () => { child.kill(); await exited; });
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (d: Buffer) => { if (d.toString().includes('ok')) resolve(); });
    child.once('exit', (code) => reject(new Error(`the child exited before taking the lock (${code})`)));
  });
  assert.throws(() => acquireLock(dir, 'wallet'), (e: unknown) => e instanceof WalletInUseError && e.message.includes(String(child.pid)));
  // Dies without releasing it (like a crash): the file stays but no longer belongs to anyone.
  child.kill();
  await exited;
  assert.equal(existsSync(lockOf(dir)), true);
  acquireLock(dir, 'wallet')();
  assert.equal(existsSync(lockOf(dir)), false);
});

// The real PowerShell query: Windows only.
test('on Windows, the own start time is set by Node at process creation and matches the one Windows gives', { skip: process.platform !== 'win32' }, () => {
  assert.equal(realWindowsProbe.ownStart, performance.timeOrigin);
  const started = windowsProcessStart(process.pid);
  assert.ok(started !== null && Math.abs(realWindowsProbe.ownStart - started) < 1000, `${realWindowsProbe.ownStart} / ${started}`);
});

test('windowsProcessStart gives the real creation time of the process, and null if it does not exist', { skip: process.platform !== 'win32' }, async (t) => {
  const before = Date.now();
  const pid = await liveChild(t);
  const started = windowsProcessStart(pid);
  assert.ok(started !== null && started >= before - 2000 && started <= Date.now(), String(started));
  assert.equal(windowsProcessStart(0), null);
  assert.equal(windowsProcessStart(2 ** 31 - 1), null);
});

test('real acquireLock on Windows: a live child blocks, and the same pid with an earlier start does not', { skip: process.platform !== 'win32' }, async (t) => {
  const dir = openDir(t);
  const pid = await liveChild(t);
  const started = windowsProcessStart(pid)!;
  writeLock(dir, winOwner(pid, started, 1));
  assert.throws(() => acquireLock(dir, 'wallet'), WalletInUseError);
  writeLock(dir, winOwner(pid, started - 3_600_000, 1));
  acquireLock(dir, 'wallet')();
});

test('acquireLock on Linux: a lock from another host (another container) is honored, even if its pid looks dead here', { skip: process.platform !== 'linux' }, (t) => {
  const dir = openDir(t);
  // pid 1 started at another instant: from the same host it would be stale.
  const stale = { pid: 1, start: 'other', boot: currentProcessId().boot };
  writeLock(dir, { ...stale, host: `${hostname()}-other` });
  assert.throws(() => acquireLock(dir, 'wallet', 'linux'), (e: unknown) =>
    e instanceof WalletInUseError && e.message === `wallet already in use by process 1 on host ${hostname()}-other`);
  writeLock(dir, { ...stale, host: hostname() });
  acquireLock(dir, 'wallet', 'linux')();
  writeLock(dir, stale);
  acquireLock(dir, 'wallet', 'linux')();
  assert.equal(existsSync(lockOf(dir)), false, 'same host or no host recorded: stale, recovered as before');
});

test('acquireLock on Linux: a lock from an earlier boot is stale, also when it was taken on another host', { skip: process.platform !== 'linux' }, (t) => {
  const dir = openDir(t);
  writeLock(dir, { pid: 1, start: 'other', boot: 'an-earlier-boot', host: `${hostname()}-other` });
  acquireLock(dir, 'wallet', 'linux')();
  assert.equal(existsSync(lockOf(dir)), false, 'recovered, then released');
});
