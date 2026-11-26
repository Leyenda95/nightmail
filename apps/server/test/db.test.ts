import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compact, DatabaseInUse, inTransaction, MEMORY, openDatabase } from '../src/storage/db.ts';

function inTempDir(work: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'nightmail-db-'));
  try {
    work(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a database is opened by one process only: the second open fails with DatabaseInUse until the first is closed', () => {
  inTempDir((dir) => {
    const file = path.join(dir, 'mail.sqlite');
    const first = openDatabase(file);
    assert.throws(() => openDatabase(file), DatabaseInUse);
    assert.throws(() => openDatabase(file), DatabaseInUse, 'and keeps failing');
    first.close();
    openDatabase(file).close();
  });
});

test('an existing directory with other permissions ends up 0700, the file is created 0600', () => {
  inTempDir((dir) => {
    const folder = path.join(dir, 'server');
    mkdirSync(folder, { mode: 0o755 });
    chmodSync(folder, 0o755);
    const file = path.join(folder, 'mail.sqlite');
    openDatabase(file).close();
    assert.equal(statSync(folder).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });
});

test('compact rewrites the database in key order: the arrival order is no longer visible in the file', () => {
  inTempDir((dir) => {
    const file = path.join(dir, 'mail.sqlite');
    const db = openDatabase(file);
    db.exec('CREATE TABLE t (k INTEGER PRIMARY KEY, v BLOB NOT NULL) STRICT');
    // Inserted interleaved (2, 1, 4, 3...), each row large enough (8 KiB) to need overflow pages.
    const marker = (k: number) => Buffer.alloc(8192, `<${String(k).padStart(3, '0')}>`);
    for (const k of [2, 1, 4, 3, 6, 5]) inTransaction(db, () => db.prepare('INSERT INTO t VALUES (?, ?)').run(k, marker(k)));
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const order = () => {
      const bytes = readFileSync(file);
      return [1, 2, 3, 4, 5, 6].sort((a, b) => bytes.indexOf(`<00${a}>`) - bytes.indexOf(`<00${b}>`));
    };
    // SQLite may lay pages out in forward or reverse order; what matters is whether they follow key or arrival.
    const byKey = (seen: number[]) => [[1, 2, 3, 4, 5, 6], [6, 5, 4, 3, 2, 1]].some((o) => o.every((k, i) => seen[i] === k));
    const byArrival = (seen: number[]) => [[2, 1, 4, 3, 6, 5], [5, 6, 3, 4, 1, 2]].some((o) => o.every((k, i) => seen[i] === k));
    const before = order();
    assert.ok(byArrival(before) && !byKey(before), `before: the file follows arrival order (${before})`);
    compact(db);
    const after = order();
    assert.ok(byKey(after), `after: it depends only on the key (${after})`);
    assert.equal(statSync(`${file}-wal`, { throwIfNoEntry: false })?.size ?? 0, 0, 'and the WAL is empty');
    db.close();
  });
});

test('inTransaction rolls everything back if the work fails', () => {
  const db = openDatabase(MEMORY);
  db.exec('CREATE TABLE t (k INTEGER PRIMARY KEY) STRICT');
  assert.throws(() => inTransaction(db, () => {
    db.prepare('INSERT INTO t VALUES (1)').run();
    throw new Error('a medias');
  }), /a medias/);
  assert.equal((db.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n, 0);
});

test('a file that is not a database fails with its own error, not with DatabaseInUse', () => {
  inTempDir((dir) => {
    const file = path.join(dir, 'mail.sqlite');
    writeFileSync(file, 'esto no es una base de datos SQLite, aunque lo parezca por el nombre del archivo'.repeat(20));
    assert.throws(() => openDatabase(file), (error: Error) => !(error instanceof DatabaseInUse) && /not a database/i.test(error.message));
  });
});
