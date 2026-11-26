import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { startUpkeep } from '../src/issuer/upkeep.ts';
import { IssuerStore, type BonoRequest } from '../src/issuer/store.ts';
import { MEMORY, openDatabase } from '../src/storage/db.ts';
import { capturingLogger } from './smtp-helpers.ts';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

const row = (id: string, extra: Partial<BonoRequest>): BonoRequest => ({
  id, plan: 'free', period: null, state: 'pending', insertBy: NOW / 1000 + 3900, signature: Buffer.alloc(64), createdAt: NOW, ...extra,
});

function setup(t: TestContext, warnPending = 2) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const store = new IssuerStore(openDatabase(MEMORY));
  const logs: string[] = [];
  let clock = NOW;
  const upkeep = startUpkeep({ store, log: capturingLogger(logs), now: () => clock, warnPending });
  t.after(() => upkeep.stop());
  return {
    store, logs, upkeep,
    advance: (ms: number) => { clock += ms; t.mock.timers.tick(ms); },
    warns: () => logs.filter((l) => l.startsWith('warn ')),
  };
}

test('purges issued requests older than 7 days on start and every 24 h', (t) => {
  const store = new IssuerStore(openDatabase(MEMORY));
  store.create(row('01'.repeat(32), { state: 'issued', createdAt: NOW - 8 * DAY }));
  store.create(row('02'.repeat(32), { state: 'issued', createdAt: NOW - 6 * DAY - 1 }));
  t.mock.timers.enable({ apis: ['setInterval'] });
  const logs: string[] = [];
  let clock = NOW;
  const upkeep = startUpkeep({ store, log: capturingLogger(logs), now: () => clock, warnPending: 50 });
  t.after(() => upkeep.stop());
  assert.equal(store.get('01'.repeat(32)), undefined);
  assert.equal(store.get('02'.repeat(32))?.state, 'issued');
  assert.ok(logs.some((l) => l.startsWith('info ') && l.includes('purged 1')));
  clock += DAY;
  t.mock.timers.tick(DAY);
  assert.equal(store.get('02'.repeat(32)), undefined);
});

test('with nothing unusual it does not warn', (t) => {
  const s = setup(t);
  s.store.create(row('01'.repeat(32), {}));
  s.advance(10 * 60_000);
  assert.deepEqual(s.warns(), []);
});

test('warns periodically if there are too many pending', (t) => {
  const s = setup(t, 2);
  for (const p of ['01', '02', '03']) s.store.create(row(p.repeat(32), {}));
  s.advance(10 * 60_000);
  assert.equal(s.warns().length, 1);
  assert.ok(s.warns()[0]!.includes('3 pending'));
  s.advance(10 * 60_000);
  assert.equal(s.warns().length, 2);
});

test('warns if there are receipts past their insertion deadline (broken promise)', (t) => {
  const s = setup(t, 50);
  s.store.create(row('01'.repeat(32), { insertBy: NOW / 1000 + 60 }));
  s.store.create(row('02'.repeat(32), { insertBy: NOW / 1000 + 60, state: 'issued' }));
  s.advance(10 * 60_000);
  assert.equal(s.warns().length, 1);
  assert.ok(s.warns()[0]!.includes('1 receipt'));
});

test('if the database fails during the check, it warns without details and moves on', (t) => {
  const s = setup(t);
  s.store.countPending = () => { throw new Error('disk /secret'); };
  s.advance(10 * 60_000);
  assert.equal(s.warns().length, 1);
  assert.ok(!s.logs.join('\n').includes('/secret'));
});

test('stop: no more checks', (t) => {
  const s = setup(t, 0);
  s.store.create(row('01'.repeat(32), {}));
  s.upkeep.stop();
  s.advance(DAY);
  assert.deepEqual(s.warns(), []);
});
