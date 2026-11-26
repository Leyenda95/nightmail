// Local storage for the operator wallet: seed, single-instance lock and synced state.
// No SDK dependencies, so it is testable.
//
// - The directory must be 0700 and the seed 0600, otherwise it refuses to continue (like ssh).
// - The seed is created exclusively (`wx`) and never overwritten.
// - Unreadable state, or state from another wallet, is set aside (`.bad-<date>`), never overwritten.
// - State is written atomically, with fsync.
//
// The generic parts (private directory, lock, atomic write) live in @nightmail/midnight, shared
// with the sidecar's embedded wallet.
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import {
  ensurePrivateDir, FILE_NAME_RE, fileMode, fsyncDir, hasUnixModes, InsecurePermissionsError, setAsideFile, writePrivateFile,
} from '@nightmail/midnight';

export {
  acquireLock, currentProcessId, ensurePrivateDir, InsecurePermissionsError, WalletInUseError, writePrivateFile,
} from '@nightmail/midnight';

const SECRET_RE = /^[0-9a-f]{64}$/;

/** Reads the seed or creates it exclusively. Validates format and permissions. */
export function loadOrCreateSeed(dir: string, generate: () => Uint8Array): { seed: Buffer; created: boolean } {
  const { value, created } = loadOrCreateSecret(dir, 'seed', generate);
  return { seed: value, created };
}

/**
 * Reads a 32-byte secret (hex, in file `name`) or creates it exclusively; it is never overwritten.
 * Same rules as the seed: directory 0700, file 0600, valid format. Used for the seed, the operator
 * secret and the contracts' maintenance keys. On Windows permissions are not checked (they do not
 * exist there, see hasUnixModes); the format still is.
 */
export function loadOrCreateSecret(
  dir: string, name: string, generate: () => Uint8Array, platform: NodeJS.Platform = process.platform,
): { value: Buffer; created: boolean } {
  if (!FILE_NAME_RE.test(name)) throw new Error(`Invalid secret name: ${name}`);
  ensurePrivateDir(dir, platform);
  const file = path.join(dir, name);
  let created = false;
  if (!existsSync(file)) {
    try {
      const hex = Buffer.from(generate()).toString('hex');
      const fd = openSync(file, 'wx', 0o600);
      try {
        writeSync(fd, hex);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      fsyncDir(dir, platform);
      created = true;
    } catch (err) {
      // Another instance created it concurrently: use that one.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  if (hasUnixModes(platform) && fileMode(file) & 0o077) {
    throw new InsecurePermissionsError(`${file} must be readable only by its owner (chmod 600)`);
  }
  const hex = readFileSync(file, 'utf8').trim();
  if (!SECRET_RE.test(hex)) throw new Error(`${file} is not a valid ${name} (expected 64 hex characters)`);
  return { value: Buffer.from(hex, 'hex'), created };
}

export type SavedState = { version: 1; address: string; shielded: string; unshielded: string; dust: string };

const STATE_FILE = 'wallet-state-v1.json';

/** Sets the saved state aside instead of deleting or overwriting it. Returns the new path. */
export function setAsideState(dir: string, reason: string): string | null {
  const dest = setAsideFile(path.join(dir, STATE_FILE));
  if (dest) console.warn(`[wallet] saved state set aside (${reason}): ${path.basename(dest)}`);
  return dest;
}

/** Reads the saved state. If unreadable or from another wallet, sets it aside and returns null. */
export function readState(dir: string, address: string): SavedState | null {
  const file = path.join(dir, STATE_FILE);
  if (!existsSync(file)) return null;
  let parsed: Partial<SavedState>;
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    // `null`, an array or a number are unreadable too (field access would otherwise throw).
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
    parsed = raw as Partial<SavedState>;
  } catch {
    setAsideState(dir, 'unreadable');
    return null;
  }
  const parts = typeof parsed.shielded === 'string' && typeof parsed.unshielded === 'string' && typeof parsed.dust === 'string';
  // Older format (no version or address). It comes from the same directory, hence the same seed:
  // accept it, and the next save rewrites it in the current format.
  if (parts && parsed.version === undefined && parsed.address === undefined) {
    console.log('[wallet] migrating saved state from the previous format');
    return { version: 1, address, shielded: parsed.shielded!, unshielded: parsed.unshielded!, dust: parsed.dust! };
  }
  if (parsed.version !== 1 || !parts) {
    setAsideState(dir, 'unknown format');
    return null;
  }
  if (parsed.address !== address) {
    setAsideState(dir, 'belongs to another wallet');
    return null;
  }
  return parsed as SavedState;
}

export function writeState(dir: string, state: SavedState): void {
  writePrivateFile(dir, STATE_FILE, JSON.stringify(state));
}
