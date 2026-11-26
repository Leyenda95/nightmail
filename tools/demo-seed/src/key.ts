// Key for the filler bono ids (see bonoId): 32 random bytes in a 0600 file, created on first use.
// It lets seeding resume without duplicates; losing it breaks nothing (a new run would issue new bonos).
import { randomBytes } from "node:crypto";
import { closeSync, fstatSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";

export const KEY_BYTES = 32;

export class BadKeyError extends Error {}

/** Creates the file only if missing, already 0600, and fsyncs it before use (a crash cannot leave a different key). */
function create(file: string): void {
  const fd = openSync(file, "wx", 0o600);
  try {
    writeSync(fd, randomBytes(KEY_BYTES));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Windows has no Unix permissions (Node always reports 0666), so the 0600 check is skipped there; the size check is not. */
export function loadOrCreateKey(file: string, platform: NodeJS.Platform = process.platform): Buffer {
  try {
    create(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const fd = openSync(file, "r");
  try {
    const mode = fstatSync(fd).mode & 0o777;
    if (platform !== "win32" && mode & 0o077) {
      throw new BadKeyError(`${file} has permissions ${mode.toString(8)}: must be 600 (chmod 600 ${file})`);
    }
    const key = readFileSync(fd);
    if (key.length !== KEY_BYTES) throw new BadKeyError(`${file} is not a demo-seed key (must be ${KEY_BYTES} bytes)`);
    return key;
  } finally {
    closeSync(fd);
  }
}
