import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type RegistryAddress, type RegistryAt, ResolutionIndex } from '@nightmail/midnight';
import { silentLogger } from '../src/log.ts';
import {
  type ActionNotice, CIRCUITS_NOT_READ, RegistrySync, sleep, waitForHead,
} from '../src/registry/sync.ts';
import { alias, blockHashOf as hashOf, mailbox, registryAt, sameSuffixKey } from './mail-fixtures.ts';

const call = (height: number, entryPoint: string | null = 'createAlias'): ActionNotice => ({ height, hash: hashOf(height), entryPoint });

/** A fake chain: at each height, the addresses entering that block. */
function chain(blocks: Record<number, RegistryAddress[]>) {
  const fetches: number[] = [];
  const failures = new Map<number, unknown[]>();
  const stateAt = (height: number): RegistryAt => {
    return registryAt(height, Object.entries(blocks).filter(([h]) => Number(h) <= height).flatMap(([, entries]) => entries));
  };
  return {
    fetches,
    /** The next read of that height fails with `error` (or returns `value` if given). */
    failNext: (height: number, error: unknown) => failures.set(height, [...(failures.get(height) ?? []), error]),
    fetchAt: async (height: number) => {
      fetches.push(height);
      const failure = failures.get(height)?.shift();
      if (failure === null) return null;
      if (failure instanceof Error) throw failure;
      if (failure !== undefined) return failure as RegistryAt;
      return stateAt(height);
    },
    stateAt,
  };
}

/** Liveness signal on the subscription (between actions); `{ tick: ms }` advances the clock. */
const ALIVE = 'alive';
type FeedItem = ActionNotice | Error | typeof ALIVE | { tick: number };

type Start = { index?: ResolutionIndex; cursor?: number; fetched?: number };

function harness(blocks: Record<number, RegistryAddress[]>, start: Start = {}) {
  const net = chain(blocks);
  const saved: string[] = [];
  const logs: string[] = [];
  const index = start.index ?? new ResolutionIndex();
  const subscriptions: number[] = [];
  const waits: number[] = [];
  /** How many more times each save path will fail (disk full, database busy...). */
  const saveFailures = { index: 0, cursor: 0 };
  const clock = { now: 1_000_000 };
  const health: boolean[] = [];
  let feeds: FeedItem[][] = [];
  const controller = new AbortController();
  const failSave = (kind: 'index' | 'cursor') => {
    if (saveFailures[kind] === 0) return;
    saveFailures[kind]--;
    throw new Error('disk I/O error');
  };
  const sync = new RegistrySync({
    index,
    cursor: start.cursor ?? -1,
    fetched: start.fetched ?? -1,
    store: {
      saveIndex: (i, cursor) => {
        failSave('index');
        saved.push(`index@${cursor}(${i.size})`);
      },
      saveCursor: (cursor) => { failSave('cursor'); saved.push(`cursor@${cursor}`); },
    },
    // Each subscription delivers the next list; when none remain, it aborts (end of test).
    source: async function* (fromHeight, _signal, alive) {
      subscriptions.push(fromHeight);
      const feed = feeds.shift();
      if (!feed) return controller.abort();
      for (const item of feed) {
        if (item instanceof Error) throw item;
        if (item === ALIVE) alive();
        else if ('tick' in item) clock.now += item.tick;
        else yield item;
        health.push(sync.healthy());
      }
    },
    fetchAt: net.fetchAt,
    log: { info: (m) => logs.push(`info ${m}`), warn: (m) => logs.push(`warn ${m}`), debug: () => {} },
    backoff: { initialMs: 10, maxMs: 40 },
    sleep: async (ms) => { waits.push(ms); },
    staleAfterMs: 1000,
    now: () => clock.now,
  });
  return {
    sync, index, net, saved, logs, subscriptions, waits, saveFailures, clock, health,
    run: (...lists: FeedItem[][]) => { feeds = lists; return sync.run(controller.signal); },
  };
}

test('adds the addresses block by block, reading the state only where one could have landed', async () => {
  const juan = mailbox('juan.perez');
  const nube = alias();
  const h = harness({ 5: [nube.entry], 9: [juan.entry] });
  await h.run([call(3, null), call(4, 'issueBono'), call(5, 'createAlias'), call(6, 'issueBono'), call(9, 'registerMailbox')]);
  assert.deepEqual(h.net.fetches, [5, 9]);
  assert.deepEqual(h.index.resolve(nube.localPart), nube.entry);
  assert.deepEqual(h.index.resolve('juan.perez'), juan.entry);
  assert.deepEqual(h.saved, ['cursor@3', 'cursor@4', 'index@5(1)', 'cursor@6', 'index@9(2)']);
  assert.deepEqual(h.sync.status, { cursor: 9, fetched: 9, addresses: 2, healthy: true });
  assert.deepEqual(h.logs, [
    'info registry sync: block 5, 1 new address(es), 1 in total (state of 1000 bytes)',
    'info registry sync: block 9, 1 new address(es), 2 in total (state of 1000 bytes)',
  ]);
});

test('circuits that touch no addresses do not read the state, any other does', async () => {
  assert.deepEqual([...CIRCUITS_NOT_READ].sort(), ['buyBono', 'issueBono', 'setPrice']);
  const h = harness({});
  const quiet = [...CIRCUITS_NOT_READ].map((entryPoint, i) => call(10 + i, entryPoint));
  await h.run([...quiet, call(20, null), call(30, 'createAlias'), call(31, 'registerMailbox'), call(32, 'circuitoDelFuturo')]);
  assert.deepEqual(h.net.fetches, [30, 31, 32]);
});

test('a block without new addresses goes to the debug log, not to info', async () => {
  const h = harness({});
  const logs: string[] = [];
  const sync = new RegistrySync({
    index: new ResolutionIndex(), cursor: -1, fetched: -1, store: { saveIndex: () => {}, saveCursor: () => {} },
    source: async function* () {}, fetchAt: h.net.fetchAt,
    log: { info: (m) => logs.push(`info ${m}`), warn: () => {}, debug: (m) => logs.push(`debug ${m}`) },
  });
  await sync.process(call(3, 'registerMailbox'));
  assert.deepEqual(logs, ['debug registry sync: block 3, no new addresses (state of 1000 bytes)']);
});

test('several actions in the same block: the state is read only once', async () => {
  const [a, b] = [alias(), alias()];
  const h = harness({ 7: [a.entry, b.entry] });
  await h.run([call(7), call(7), call(7, 'registerMailbox'), call(8, 'issueBono')]);
  assert.deepEqual(h.net.fetches, [7]);
  assert.equal(h.index.size, 2);
});

test('an action that creates addresses in a block that already moved the height (an issuance before) is still read', async () => {
  const nube = alias();
  const h = harness({ 7: [nube.entry] });
  await h.run([call(7, 'issueBono'), call(7, 'createAlias')]);
  assert.deepEqual(h.net.fetches, [7]);
  assert.deepEqual(h.index.resolve(nube.localPart), nube.entry);
  assert.deepEqual(h.saved, ['cursor@7', 'index@7(1)']);
});

test('the suffix belongs to the first in chain order, a tie in the same block blocks it', async () => {
  const first = alias();
  const late = alias(sameSuffixKey(first.addrKey));
  const tiedA = alias();
  const tiedB = alias(sameSuffixKey(tiedA.addrKey));
  const h = harness({ 5: [first.entry], 6: [late.entry], 8: [tiedA.entry, tiedB.entry] });
  await h.run([call(5), call(6), call(8), call(8)]);
  assert.deepEqual(h.index.resolve(first.localPart), first.entry);
  assert.equal(h.index.resolve(late.localPart), undefined);
  assert.equal(h.index.resolve(tiedA.localPart), undefined);
  assert.equal(h.index.resolve(tiedB.localPart), undefined);
  assert.equal(h.index.size, 4);
});

test('a failed transaction does not change the state: nothing gets in and it moves on to the next block', async () => {
  const nube = alias();
  const h = harness({ 9: [nube.entry] });
  await h.run([call(5, 'createAlias'), call(9, 'createAlias')]); // the block 5 call failed: no addresses there
  assert.deepEqual(h.net.fetches, [5, 9]);
  assert.deepEqual(h.saved, ['index@5(0)', 'index@9(1)']);
});

test('when the subscription drops it resumes from the last height (inclusive) without repeating reads', async () => {
  const [a, b] = [alias(), alias()];
  const h = harness({ 5: [a.entry], 9: [b.entry] });
  await h.run(
    [call(5), call(6, 'issueBono')],
    [call(6, 'issueBono'), call(9)], // redelivery of block 6
    [call(9), call(9, 'issueBono')], // redelivery of block 9
  );
  assert.deepEqual(h.subscriptions, [0, 6, 9, 9]);
  assert.deepEqual(h.net.fetches, [5, 9]);
  assert.deepEqual(h.saved, ['index@5(1)', 'cursor@6', 'index@9(2)']);
});

test('resumes from what was stored: does not reread what was already in the index', async () => {
  const old = alias();
  const fresh = alias();
  const index = new ResolutionIndex();
  index.addBlock(5, [old.entry]);
  const h = harness({ 5: [old.entry], 12: [fresh.entry] }, { index, cursor: 8, fetched: 5 });
  await h.run([call(8, 'issueBono'), call(12)]);
  assert.deepEqual(h.subscriptions, [8, 12]);
  assert.deepEqual(h.net.fetches, [12]);
  assert.equal(h.index.size, 2);
});

test('a re-emitted action in a hard fork (another block, same state) adds nothing', async () => {
  const nube = alias();
  const h = harness({ 5: [nube.entry] });
  await h.run([call(5), call(40, 'createAlias')]);
  assert.deepEqual(h.net.fetches, [5, 40]);
  assert.equal(h.index.size, 1);
  assert.deepEqual(h.sync.status, { cursor: 40, fetched: 40, addresses: 1, healthy: true });
});

test('an action older than what was already read is ignored: a block is never added out of order', async () => {
  const h = harness({});
  await h.run([call(9), call(7), call(9)]);
  assert.deepEqual(h.net.fetches, [9]);
  assert.deepEqual(h.sync.status, { cursor: 9, fetched: 9, addresses: 0, healthy: true });
});

test('if a block cannot be read, it neither advances nor skips: it retries with a growing wait', async () => {
  const [a, b] = [alias(), alias()];
  const h = harness({ 5: [a.entry], 6: [b.entry] });
  for (let i = 0; i < 4; i++) h.net.failNext(5, new Error('indexer: bad contract state'));
  await h.run([call(4, 'issueBono'), call(5), call(6)], [call(4, 'issueBono'), call(5)], [call(5)], [call(5)], [call(5), call(6)]);
  assert.deepEqual(h.net.fetches, [5, 5, 5, 5, 5, 6], 'block 6 is not read until block 5 has been read');
  assert.deepEqual(h.subscriptions, [0, 4, 4, 4, 4, 6], 'always from the last processed block');
  assert.deepEqual(h.waits, [10, 20, 40, 40, 10], 'the wait doubles up to the cap (a redelivery does not reset it) and goes back to the minimum on progress');
  assert.deepEqual(h.index.resolve(a.localPart), a.entry);
  assert.deepEqual(h.index.resolve(b.localPart), b.entry);
  assert.deepEqual(h.saved, ['cursor@4', 'index@5(1)', 'index@6(2)']);
  assert.deepEqual(h.logs.filter((l) => l.startsWith('warn')), [10, 20, 40, 40].map((delay) =>
    `warn registry sync: stopped at block 4, retrying in ${delay} ms (Error: indexer: bad contract state)`));
});

test('with no registry in that block, or another block at that height, it does not advance either', async () => {
  const nube = alias();
  const h = harness({ 5: [nube.entry] });
  h.net.failNext(5, null);
  h.net.failNext(5, { ...h.net.stateAt(5), blockHash: 'ff'.repeat(32) });
  await h.run([call(5)], [call(5)], [call(5)]);
  assert.deepEqual(h.net.fetches, [5, 5, 5]);
  assert.deepEqual(h.saved, ['index@5(1)'], 'only the good read was stored');
  assert.equal(h.index.size, 1);
});

test('if saving the index fails, it does not advance: the redelivery rereads the block and no later height is stored first', async () => {
  const [a, b] = [alias(), alias()];
  const h = harness({ 5: [a.entry], 9: [b.entry] });
  h.saveFailures.index = 1;
  await h.run(
    [call(5), call(7, 'issueBono'), call(9)], // block 5 could not be saved: the subscription is cut there
    [call(5), call(7, 'issueBono'), call(9)],
  );
  assert.deepEqual(h.subscriptions, [0, 0, 9], 'resumes from before block 5');
  assert.deepEqual(h.net.fetches, [5, 5, 9]);
  assert.deepEqual(h.saved, ['index@5(1)', 'cursor@7', 'index@9(2)']);
  assert.deepEqual(h.sync.status, { cursor: 9, fetched: 9, addresses: 2, healthy: true });
  assert.ok(h.logs.includes('warn registry sync: stopped at block -1, retrying in 10 ms (Error: disk I/O error)'));
});

test('if saving the height fails, it does not advance either', async () => {
  const nube = alias();
  const h = harness({ 9: [nube.entry] });
  h.saveFailures.cursor = 1;
  await h.run([call(4, 'issueBono'), call(9)], [call(4, 'issueBono'), call(9)]);
  assert.deepEqual(h.subscriptions, [0, 0, 9]);
  assert.deepEqual(h.saved, ['cursor@4', 'index@9(1)']);
});

test('health: healthy with progress or pongs, stops being so after staleAfterMs without them or with a stuck block, even if the previous one is redelivered', async () => {
  const nube = alias();
  const h = harness({ 5: [nube.entry] });
  h.net.failNext(5, new Error('indexer: bad contract state'));
  await h.run(
    [{ tick: 1000 }, { tick: 1 }, ALIVE, { tick: 1000 }, ALIVE, call(4, 'issueBono'), { tick: 1001 }],
    [ALIVE, call(4, 'issueBono'), call(5)], // redelivery of 4 (not progress) and block 5 cannot be read
    // Stuck: neither pongs nor redeliveries of block 4 on each retry keep it healthy.
    [ALIVE, call(4, 'issueBono'), { tick: 1001 }, ALIVE, call(4, 'issueBono')],
    [ALIVE, call(4, 'issueBono'), call(5), { tick: 1000 }],
  );
  assert.deepEqual(h.health, [
    true, // 1000 ms since start: exactly at the limit
    false, // 1 ms more: no longer
    true, true, // a pong recovers it; exactly at the limit it is still healthy
    true, true, // another pong and an advance
    false, // 1001 ms with nothing
    true, true, // a pong and the redelivery (reading block 5 fails before recording anything else)
    true, true, // stuck: still healthy during the margin...
    false, false, false, // ...and after it, despite pongs and redeliveries
    false, false, true, true, // only progress (finally reading block 5) unsticks it
  ]);
});

test('a subscription failure is also retried, without losing what was processed', async () => {
  const nube = alias();
  const h = harness({ 5: [nube.entry] });
  await h.run([call(5), new Error('socket closed')], [call(5), call(6, 'issueBono')]);
  assert.deepEqual(h.subscriptions, [0, 5, 6]);
  assert.deepEqual(h.net.fetches, [5]);
  assert.deepEqual(h.waits, [10, 10]);
});

test('block 0 is a valid height', async () => {
  const h = harness({});
  assert.equal(await h.sync.process(call(0, 'issueBono')), true);
  assert.equal(await h.sync.process(call(0, 'issueBono')), false, 'the redelivery does not advance');
  assert.deepEqual(h.sync.status, { cursor: 0, fetched: -1, addresses: 0, healthy: true });
  assert.equal(await h.sync.process(call(0)), true);
  assert.deepEqual(h.net.fetches, [0]);
  assert.deepEqual(h.saved, ['cursor@0', 'index@0(0)']);
});

test('an action without a valid height is a subscription error', async () => {
  const h = harness({});
  for (const height of [-1, 1.5, Number.NaN, '7' as unknown as number]) {
    await assert.rejects(h.sync.process({ height, hash: hashOf(0), entryPoint: 'createAlias' }), /valid block height/);
  }
  assert.deepEqual(h.net.fetches, []);
});

test('run ends when the signal is aborted, also during a wait', async () => {
  const controller = new AbortController();
  const sync = new RegistrySync({
    index: new ResolutionIndex(), cursor: -1, fetched: -1,
    store: { saveIndex: () => {}, saveCursor: () => {} },
    source: async function* () { throw new Error('indexer down'); },
    fetchAt: async () => null,
    log: silentLogger,
    backoff: { initialMs: 60_000, maxMs: 60_000 },
  });
  const running = sync.run(controller.signal);
  setTimeout(() => controller.abort(), 20);
  await running; // with the real 60 s wait, it only returns if aborting cuts it short
});

test('aborting while the subscription runs reports no failure', async () => {
  const controller = new AbortController();
  const warnings: string[] = [];
  const sync = new RegistrySync({
    index: new ResolutionIndex(), cursor: -1, fetched: -1,
    store: { saveIndex: () => {}, saveCursor: () => {} },
    source: async function* () {
      yield call(3, 'issueBono');
      controller.abort();
      throw new Error('socket closed by abort');
    },
    fetchAt: async () => null,
    log: { ...silentLogger, warn: (m) => warnings.push(m) },
  });
  await sync.run(controller.signal);
  assert.deepEqual(warnings, []);
  assert.equal(sync.status.cursor, 3);
});

test('sleep: waits as asked and aborting cuts it short', async () => {
  const t0 = performance.now();
  await sleep(30, new AbortController().signal);
  assert.ok(performance.now() - t0 >= 25);
  const aborted = new AbortController();
  aborted.abort();
  const t1 = performance.now();
  await sleep(60_000, aborted.signal);
  assert.ok(performance.now() - t1 < 1000);
});

test('waitForHead: waits until the index has all the addresses on chain', async () => {
  const [a, b] = [alias(), mailbox('juan.perez')];
  const index = new ResolutionIndex();
  index.addBlock(1, [a.entry]);
  const head = chain({ 1: [a.entry], 2: [b.entry] }).stateAt(2);
  let polls = 0;
  await waitForHead(index, async () => head, {
    signal: new AbortController().signal, log: silentLogger, pollMs: 7,
    sleep: async (ms) => {
      assert.equal(ms, 7);
      if (++polls === 3) index.addBlock(2, [b.entry]);
    },
  });
  assert.equal(polls, 3);
});

test('waitForHead: with the index up to date it does not wait, with no registry at that address it throws', async () => {
  const a = alias();
  const index = new ResolutionIndex();
  index.addBlock(1, [a.entry]);
  const options = { signal: new AbortController().signal, log: silentLogger, sleep: async () => assert.fail('must not wait') };
  await waitForHead(index, async () => chain({ 1: [a.entry] }).stateAt(1), options);
  await waitForHead(new ResolutionIndex(), async () => chain({}).stateAt(1), options);
  await assert.rejects(waitForHead(index, async () => null, options), /no registry contract/);
});

test('waitForHead: while waiting, warns now and then with the sync progress', async () => {
  const [a, b] = [alias(), mailbox('juan.perez')];
  const index = new ResolutionIndex();
  const head = chain({ 1: [a.entry], 2: [b.entry] }).stateAt(2);
  const warnings: string[] = [];
  let polls = 0;
  await waitForHead(index, async () => head, {
    signal: new AbortController().signal, log: { ...silentLogger, warn: (m) => warnings.push(m) },
    pollMs: 10, reportEveryMs: 30, progress: () => `progress ${polls}`,
    sleep: async () => {
      if (++polls === 7) index.addBlock(2, [a.entry, b.entry]);
    },
  });
  assert.deepEqual(warnings, [
    'registry sync: still waiting for 2 address(es) of block 2 (progress 3)',
    'registry sync: still waiting for 2 address(es) of block 2 (progress 6)',
  ]);
});

test('waitForHead: aborting cuts the wait short', async () => {
  const controller = new AbortController();
  const head = chain({ 1: [alias().entry] }).stateAt(1);
  const waiting = waitForHead(new ResolutionIndex(), async () => head, { signal: controller.signal, log: silentLogger, pollMs: 5 });
  setTimeout(() => controller.abort(), 20);
  await waiting;
});

test('waitForHead: with a report interval shorter than the wait, warns on every wait', async () => {
  const a = alias();
  const index = new ResolutionIndex();
  const head = chain({ 1: [a.entry] }).stateAt(1);
  const warnings: string[] = [];
  let polls = 0;
  await waitForHead(index, async () => head, {
    signal: new AbortController().signal, log: { ...silentLogger, warn: (m) => warnings.push(m) }, pollMs: 10, reportEveryMs: 2,
    sleep: async () => { if (++polls === 3) index.addBlock(1, [a.entry]); },
  });
  assert.equal(warnings.length, 2, 'after the 1st and 2nd wait (by the 3rd it is up to date)');
});
