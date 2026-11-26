// Private files on disk: 0700 directory, atomic writes with fsync, and a single-instance lock.
// Used by the operator wallet (apps/server) and the sidecar's embedded wallet. No SDK dependencies.
//
// Rules:
// - The directory must be 0700, otherwise refuse to continue (like ssh).
// - An unreadable file is set aside (`.bad-<date>`), never overwritten.
// - Writes are atomic (temp file + rename) and fsynced.
import {
  closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export class InsecurePermissionsError extends Error {}
export class WalletInUseError extends Error {}

export const FILE_NAME_RE = /^[a-z0-9][a-z0-9.-]*$/;

export function fileMode(p: string): number {
  return statSync(p).mode & 0o777;
}

/**
 * Windows has no Unix modes: Node always reports 0666 or 0777 and `chmod` only toggles read-only. The check is
 * skipped there; who can read the directory is decided by Windows ACLs, which this does not inspect.
 */
export function hasUnixModes(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32';
}

/** Creates the directory (0700) if missing and checks nobody else can read it (except on Windows, see hasUnixModes). */
export function ensurePrivateDir(dir: string, platform: NodeJS.Platform = process.platform): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (hasUnixModes(platform) && fileMode(dir) & 0o077) {
    throw new InsecurePermissionsError(`${dir} must be accessible only by its owner (chmod 700); it is ${fileMode(dir).toString(8)}`);
  }
}

/** Process identity that stays unique even if the pid is reused: pid + process start + system boot. */
type ProcessId = { pid: number; start: string; boot: string };

export function readOptional(file: string): string | null {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

function processStart(pid: number): string | null {
  const stat = readOptional(`/proc/${pid}/stat`);
  if (!stat) return null;
  // Field 22 (starttime) comes after the parenthesized name, which may contain spaces.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return fields[19] ?? null;
}

function bootId(): string {
  return readOptional('/proc/sys/kernel/random/boot_id') ?? 'unknown';
}

export function currentProcessId(pid = process.pid): ProcessId {
  return { pid, start: processStart(pid) ?? 'unknown', boot: bootId() };
}

/**
 * Does a process with this pid exist? Also works on Windows. `kill(pid, 0)` sends nothing, it only probes. EPERM
 * means it exists but belongs to another user, so it counts as alive.
 */
export function pidExists(
  pid: number, kill: (pid: number, signal: number) => void = (p, s) => { process.kill(p, s); },
): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Extra lock data on Windows, where there is no /proc. Reboots are detected without relying on the wall clock, and
 * pid reuse via the process creation time, which Windows keeps fixed.
 * - `winStart`: when this process started (ms since 1970), recorded by Node at start-up (`performance.timeOrigin`).
 * - `winUptime`: system uptime in seconds when the lock was taken.
 */
type WindowsMarks = { winStart: number; winUptime: number };
type LockOwner = ProcessId & Partial<WindowsMarks>;

/** The lock's view of Windows. Injected in tests to simulate reboots and reused pids. */
export type WindowsProbe = {
  /** When this process started (ms since 1970). */
  ownStart: number;
  /** System uptime in seconds. Only grows until the next reboot. */
  uptime: () => number;
  /** When process `pid` started (ms since 1970), or `null` if unknown. */
  processStart: (pid: number) => number | null;
};

/** Tolerance when comparing a process creation time with the stored one; beyond it, it is a different process. */
export const REUSED_PID_MARGIN_MS = 5000;

// Set by Node when the process is created, not when this module loads, so a clock change during start-up does not move it.
const OWN_START = performance.timeOrigin;

/**
 * Creation time of a Windows process, queried via PowerShell (ships with Windows, no new dependencies).
 * It takes a few tenths of a second, so it is only asked when an existing lock's pid is still alive.
 * If PowerShell does not answer, fails or is denied (another user's process), returns `null` and the lock is honored.
 */
export function windowsProcessStart(pid: number): number | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    // Full path, so a `powershell.exe` planted in the working directory or on PATH is never run instead.
    // If it does not exist, execFileSync fails, the result is `null` and the lock is honored.
    const root = process.env.SystemRoot || 'C:\\Windows';
    const out = execFileSync(path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `try { [DateTimeOffset]::new((Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime()).ToUnixTimeMilliseconds() } catch { exit 1 }`,
    ], { encoding: 'utf8', windowsHide: true, timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return /^\d+$/.test(out) ? Number(out) : null;
  } catch {
    return null;
  }
}

export const realWindowsProbe: WindowsProbe = { ownStart: OWN_START, uptime: () => os.uptime(), processStart: windowsProcessStart };

/**
 * Is the lock holder still alive on Windows? It is only considered dead given evidence, otherwise the lock is honored:
 * - the pid no longer exists;
 * - the machine rebooted: uptime is lower than when the lock was taken;
 * - the pid belongs to another program: that process started clearly after the lock was taken.
 * A legacy lock without `winStart` or `winUptime` only requires the pid to exist.
 */
function isLiveOnWindows(owner: LockOwner, probe: WindowsProbe): boolean {
  if (!pidExists(owner.pid)) return false;
  if (typeof owner.winUptime === 'number' && probe.uptime() < owner.winUptime) return false;
  if (typeof owner.winStart !== 'number') return true;
  // Our own pid: same process only if the start time matches (otherwise an earlier process had this pid).
  if (owner.pid === process.pid) return owner.winStart === probe.ownStart;
  const started = probe.processStart(owner.pid);
  return started === null || started <= owner.winStart + REUSED_PID_MARGIN_MS;
}

/** Alive only if a process with that pid exists, started at the same instant and within the same system boot. */
function isSameLiveProcess(owner: LockOwner, platform: NodeJS.Platform, probe: WindowsProbe): boolean {
  if (platform === 'win32') return isLiveOnWindows(owner, probe);
  return owner.boot === bootId() && processStart(owner.pid) === owner.start;
}

/** "Wallet in use" message. On Windows it also says what to do, since the process is harder to identify there. */
function inUseMessage(what: string, pid: number, platform: NodeJS.Platform): string {
  const base = `${what} already in use by process ${pid}`;
  if (platform !== 'win32') return base;
  // Deleting the file by hand is not suggested: the sidecar shows up as node.exe and the lock may belong to an open window.
  return `${base}. Close the other NightMail window. If the message persists, restart the computer`;
}

/**
 * Single-instance lock: two processes with the same seed would clobber each other's
 * state and pick the same coins. Returns the release function.
 *
 * - The file is published complete (temp file + `link`), so it is never seen empty.
 * - A pid reused after a WSL restart does not block: the process start time and the
 *   system `boot_id` are compared too.
 * - It cannot be acquired twice within the same process either.
 * - On Windows, without /proc, the `WindowsMarks` fields are used (see isLiveOnWindows).
 */
export function acquireLock(
  dir: string, what = 'operator wallet', platform: NodeJS.Platform = process.platform, probe: WindowsProbe = realWindowsProbe,
): () => void {
  const file = path.join(dir, 'lock');
  const me: LockOwner = platform === 'win32'
    ? { ...currentProcessId(), winStart: probe.ownStart, winUptime: probe.uptime() }
    : currentProcessId();
  for (let attempt = 0; attempt < 3; attempt++) {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(me), { mode: 0o600, flag: 'wx' });
    try {
      linkSync(tmp, file); // atomic: fails with EEXIST if the lock is held
      return () => {
        const raw = readOptional(file);
        if (raw && raw === JSON.stringify(me)) unlinkSync(file);
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    } finally {
      unlinkSync(tmp);
    }
    const raw = readOptional(file);
    let owner: LockOwner | null = null;
    try {
      owner = JSON.parse(raw ?? 'null') as LockOwner | null;
    } catch {
      owner = null;
    }
    if (owner && typeof owner.pid === 'number' && isSameLiveProcess(owner, platform, probe)) {
      throw new WalletInUseError(inUseMessage(what, owner.pid, platform));
    }
    // Stale (or legacy pid-only format): move it away with an atomic rename and retry. If another process
    // replaced it meanwhile, the file has changed: leave it alone and check again.
    if (readOptional(file) !== raw) continue;
    try {
      renameSync(file, `${file}.stale-${process.pid}-${Date.now()}`);
    } catch {
      /* another start-up already moved it */
    }
  }
  throw new WalletInUseError(`could not acquire the ${what} lock`);
}

/** Sets a file aside instead of deleting or overwriting it (`<file>.bad-<date>`). Returns the new path. */
export function setAsideFile(file: string): string | null {
  if (!existsSync(file)) return null;
  // Unique name, so two files set aside in the same millisecond do not collide.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let dest = `${file}.bad-${stamp}`;
  for (let n = 1; existsSync(dest); n++) dest = `${file}.bad-${stamp}-${n}`;
  renameSync(file, dest);
  return dest;
}

/** Atomic write (temp file + rename) with fsync and mode 0600, so a crash never leaves the file empty. */
export function writePrivateFile(dir: string, name: string, content: string | Uint8Array): void {
  if (!FILE_NAME_RE.test(name)) throw new Error(`Invalid file name: ${name}`);
  const file = path.join(dir, name);
  const tmp = `${file}.tmp`;
  rmSync(tmp, { force: true }); // a leftover temp file would keep its old mode, so always create a fresh one
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    // writeFileSync on a descriptor writes everything (retrying short writes). If the disk is full
    // it throws, so the rename never publishes a truncated file.
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  fsyncDir(dir);
}

/**
 * Windows does not allow fsync on a directory from Node (EPERM). There it is not a failure, the file was already
 * fsynced. Only that case is tolerated, and only on Windows; on Linux EPERM still warns.
 */
export function isDirFsyncUnsupported(err: unknown, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && (err as NodeJS.ErrnoException | null)?.code === 'EPERM';
}

/** Persists the directory entry (new or renamed file); without it, a power loss can lose the entry. */
export function fsyncDir(
  dir: string, platform: NodeJS.Platform = process.platform, sync: (fd: number) => void = fsyncSync,
): void {
  try {
    const dfd = openSync(dir, 'r');
    try {
      sync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch (err) {
    if (isDirFsyncUnsupported(err, platform)) return;
    // The file is already written; only persisting the directory entry failed.
    console.warn('[storage] could not fsync the data directory:', (err as Error).message);
  }
}
