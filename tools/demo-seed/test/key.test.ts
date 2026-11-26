import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { BadKeyError, loadOrCreateKey } from "../src/key.ts";

// The platform is passed in, so both branches are tested on any OS.
it("on Windows the 0600 check is skipped (it does not exist there), but the size check is not; on Linux an open key is not used", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "demo-seed-key-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const open = path.join(dir, "abierta.key");
  writeFileSync(open, Buffer.alloc(32, 7));
  chmodSync(open, 0o644);
  assert.deepEqual(loadOrCreateKey(open, "win32"), Buffer.alloc(32, 7));
  assert.throws(() => loadOrCreateKey(open, "linux"), (e: unknown) => e instanceof BadKeyError && /must be 600/.test(String(e)));
  const short = path.join(dir, "corta.key");
  writeFileSync(short, Buffer.alloc(5));
  assert.throws(() => loadOrCreateKey(short, "win32"), /must be 32 bytes/);
});
