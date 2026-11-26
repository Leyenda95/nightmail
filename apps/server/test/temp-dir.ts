// Private (0700) temporary directory for a test, removed afterwards.
import type { TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function tempDir(t: TestContext, prefix = 'nm-test-'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
