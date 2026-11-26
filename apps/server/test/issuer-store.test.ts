import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDatabase, MEMORY } from '../src/storage/db.ts';
import { IssuerStore, type BonoRequest } from '../src/issuer/store.ts';
import { tempDir } from './temp-dir.ts';

const request = (id: string, extra: Partial<BonoRequest> = {}): BonoRequest => ({
  id, plan: 'free', period: null, state: 'pending', insertBy: 5000, signature: Buffer.alloc(64, 1), createdAt: 1000, ...extra,
});

test('store: creates and reads a request as is', () => {
  const store = new IssuerStore(openDatabase(MEMORY));
  const row = request('aa'.repeat(32), { plan: 'paid', period: 'annual' });
  assert.equal(store.get(row.id), undefined);
  store.create(row);
  assert.deepEqual(store.get(row.id), row);
});

test('store: the id is unique (creating twice fails)', () => {
  const store = new IssuerStore(openDatabase(MEMORY));
  store.create(request('aa'.repeat(32)));
  assert.throws(() => store.create(request('aa'.repeat(32))));
});

test('store: setState changes the state and pending() returns only the pending ones, in arrival order', () => {
  const store = new IssuerStore(openDatabase(MEMORY));
  store.create(request('01'.repeat(32), { createdAt: 3 }));
  store.create(request('02'.repeat(32), { createdAt: 1 }));
  store.create(request('03'.repeat(32), { createdAt: 2 }));
  store.setState('03'.repeat(32), 'issued');
  assert.deepEqual(store.pending().map((r) => r.id), ['02'.repeat(32), '01'.repeat(32)]);
  assert.equal(store.get('03'.repeat(32))?.state, 'issued');
});

test('store: requeue sets it back to pending and renews the receipt', () => {
  const store = new IssuerStore(openDatabase(MEMORY));
  const id = '01'.repeat(32);
  store.create(request(id, { state: 'failed' }));
  store.requeue(id, 9000, Buffer.alloc(64, 2));
  assert.deepEqual(store.get(id), request(id, { insertBy: 9000, signature: Buffer.alloc(64, 2) }));
});

test('store: survives reopening the database and stores no IP', (t) => {
  const file = path.join(tempDir(t), 'issuer.sqlite');
  const db = openDatabase(file);
  new IssuerStore(db).create(request('aa'.repeat(32)));
  db.close();
  const reopened = openDatabase(file);
  const store = new IssuerStore(reopened);
  assert.equal(store.get('aa'.repeat(32))?.state, 'pending');
  const columns = reopened.prepare("SELECT name FROM pragma_table_info('bono_requests')").all().map((c) => String(c['name']));
  assert.ok(!columns.some((c) => /ip|addr|host/i.test(c)), columns.join(','));
});

test('store: countPending and countOverdue (pending ones whose receipt deadline has passed)', () => {
  const store = new IssuerStore(openDatabase(MEMORY));
  store.create(request('01'.repeat(32), { insertBy: 100 }));
  store.create(request('02'.repeat(32), { insertBy: 300 }));
  store.create(request('03'.repeat(32), { insertBy: 100, state: 'issued' }));
  store.create(request('04'.repeat(32), { insertBy: 100, state: 'failed' }));
  assert.equal(store.countPending(), 2);
  assert.equal(store.countOverdue(200), 1);
  assert.equal(store.countOverdue(100), 0);
});

test('store: purgeIssued deletes only issued requests created before the given time and says how many', () => {
  const store = new IssuerStore(openDatabase(MEMORY));
  store.create(request('01'.repeat(32), { createdAt: 1000, state: 'issued' }));
  store.create(request('02'.repeat(32), { createdAt: 5000, state: 'issued' }));
  store.create(request('03'.repeat(32), { createdAt: 1000, state: 'pending' }));
  store.create(request('04'.repeat(32), { createdAt: 1000, state: 'failed' }));
  assert.equal(store.purgeIssued(5000), 1);
  assert.equal(store.get('01'.repeat(32)), undefined);
  assert.deepEqual(['02', '03', '04'].map((p) => store.get(p.repeat(32))?.state), ['issued', 'pending', 'failed']);
  assert.equal(store.purgeIssued(5000), 0);
});
