import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { startRoundTicker, type RoundState } from '../src/issuer/round-ticker.ts';
import type { AdvanceOutcome } from '../src/issuer/payer-client.ts';
import { capturingLogger } from './smtp-helpers.ts';
import { gate } from './issuer-gate.ts';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const MIN = 60_000;

type Options = { intervalMs?: number; maxAdvancesPerHour?: number };

/**
 * Simulated registry: `round` and `waiting` are set by hand. By default a successful advance bumps the round
 * (like the contract), but reads only see it when `fresh` (otherwise it simulates a lagging RegistrySync).
 */
function setup(t: TestContext, advance: (state: { round: bigint }) => Promise<AdvanceOutcome>, options: Options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const logs: string[] = [];
  const state = { round: 5n, waiting: true };
  let clock = 1_800_000_000_000;
  let calls = 0;
  let read: () => Promise<RoundState> = async () => ({ ...state });
  const ticker = startRoundTicker({
    payer: { advanceRound: () => { calls++; return advance(state); } },
    readRoundState: () => read(),
    log: capturingLogger(logs),
    now: () => clock,
    ...options,
  });
  t.after(() => ticker.stop());
  return {
    ticker, logs, state,
    calls: () => calls,
    setRead: (fn: () => Promise<RoundState>) => { read = fn; },
    tick: async (ms = 30_000) => { clock += ms; t.mock.timers.tick(ms); await flush(); },
    warns: (text: string) => logs.filter((l) => l.startsWith('warn ') && l.includes(text)).length,
  };
}

const advancing = async (state: { round: bigint }): Promise<AdvanceOutcome> => {
  state.round += 1n;
  return { status: 'advanced', round: Number(state.round) };
};

test('with no reservations waiting it does not advance the round (each advance costs DUST and takes the payer queue)', async (t) => {
  const s = setup(t, advancing);
  s.state.waiting = false;
  await s.tick();
  await s.tick();
  assert.equal(s.calls(), 0);
});

test('with reservations waiting it advances on every tick (30 s by default, chained timer)', async (t) => {
  const s = setup(t, advancing);
  await s.tick(29_999);
  assert.equal(s.calls(), 0);
  await s.tick(1);
  assert.equal(s.calls(), 1);
  await s.tick();
  assert.equal(s.calls(), 2);
  assert.ok(s.logs.some((l) => l.startsWith('info ') && l.includes('7')));
});

test('the interval can be changed', async (t) => {
  const s = setup(t, advancing, { intervalMs: 1000 });
  await s.tick(1000);
  assert.equal(s.calls(), 1);
});

test('stale read: after advancing in round r, ignores reads with round <= r until it changes', async (t) => {
  const s = setup(t, async () => ({ status: 'advanced', round: 6 }));
  await s.tick();
  assert.equal(s.calls(), 1);
  for (let i = 0; i < 10; i++) await s.tick();
  assert.equal(s.calls(), 1, 'the read is still at 5: no new advance');
  s.state.round = 4n;
  await s.tick();
  assert.equal(s.calls(), 1, 'an even older read neither');
  s.state.round = 6n;
  await s.tick();
  assert.equal(s.calls(), 2);
});

test('unknown advance: waits for the round to change or for validUntil to pass (with a margin), never earlier', async (t) => {
  const answers: AdvanceOutcome[] = [{ status: 'unknown', validUntil: 1_800_000_030_000 + 10 * MIN }];
  const s = setup(t, async () => answers.shift() ?? { status: 'advanced', round: 6 });
  await s.tick();
  assert.equal(s.calls(), 1);
  assert.equal(s.warns('unknown'), 1);
  for (let i = 0; i < 20; i++) await s.tick();
  assert.equal(s.calls(), 1, 'not yet at 10 min (1 min margin)');
  await s.tick();
  await s.tick();
  assert.equal(s.calls(), 2, 'after validUntil + 1 min the round is still 5: the submission did not land, it is requested again');
});

test('unknown advance and the round changes before validUntil: continues with the new one', async (t) => {
  const answers: AdvanceOutcome[] = [{ status: 'unknown', validUntil: 1_800_000_030_000 + 30 * MIN }];
  const s = setup(t, async () => answers.shift() ?? { status: 'advanced', round: 7 });
  await s.tick();
  await s.tick();
  assert.equal(s.calls(), 1);
  s.state.round = 6n;
  await s.tick();
  assert.equal(s.calls(), 2);
});

test('unknown advance without validUntil (cut, 5xx): waits 31 min', async (t) => {
  const answers: AdvanceOutcome[] = [{ status: 'unknown' }];
  const s = setup(t, async () => answers.shift() ?? { status: 'advanced', round: 6 });
  await s.tick();
  for (let i = 0; i < 61; i++) await s.tick();
  assert.equal(s.calls(), 1, 'not yet at 30.5 min');
  await s.tick();
  assert.equal(s.calls(), 2);
});

test('a failed advance (not submitted) is requested again on the next tick, not right away', async (t) => {
  const answers: AdvanceOutcome[] = [{ status: 'failed' }];
  const s = setup(t, async (state) => answers.shift() ?? advancing(state));
  await s.tick();
  await flush();
  assert.equal(s.calls(), 1, 'no immediate retry');
  assert.equal(s.warns('failed'), 1);
  await s.tick();
  assert.equal(s.calls(), 2);
});

test('does not request another advance while one is in flight', async (t) => {
  const g = gate<AdvanceOutcome>();
  const s = setup(t, () => g.promise);
  await s.tick();
  await s.tick();
  await s.tick();
  assert.equal(s.calls(), 1);
  s.state.round = 6n;
  g.resolve({ status: 'advanced', round: 6 });
  await flush();
  await s.tick();
  assert.equal(s.calls(), 2);
});

test('hourly advance cap: when reached, warns ONCE and does not advance until it leaves the window', async (t) => {
  const s = setup(t, advancing, { maxAdvancesPerHour: 2 });
  await s.tick();
  await s.tick();
  assert.equal(s.calls(), 2);
  for (let i = 0; i < 10; i++) await s.tick();
  assert.equal(s.calls(), 2);
  assert.equal(s.warns('per hour'), 1);
  for (let i = 0; i < 109; i++) await s.tick();
  assert.equal(s.calls(), 3, 'one hour after the first advance another window opens');
  await s.tick();
  await s.tick();
  await s.tick();
  assert.equal(s.calls(), 4, 'and hits the cap again');
  assert.equal(s.warns('per hour'), 2);
});

test('if the round state cannot be read, it does not advance and warns (without the error message)', async (t) => {
  const s = setup(t, advancing);
  s.setRead(async () => { throw new Error('secret /path'); });
  await s.tick();
  assert.equal(s.calls(), 0);
  assert.ok(s.logs.some((l) => l.startsWith('warn ')));
  assert.ok(!s.logs.join('\n').includes('/path'));
  s.setRead(async () => ({ ...s.state }));
  await s.tick();
  assert.equal(s.calls(), 1, 'still alive');
});

test('if the advance throws (it should not), it is logged and stays alive', async (t) => {
  let n = 0;
  const s = setup(t, async (state) => { if (n++ === 0) throw new Error('x /secret'); return advancing(state); });
  await s.tick();
  await s.tick();
  assert.equal(s.calls(), 2);
  assert.ok(!s.logs.join('\n').includes('/secret'));
});

test('stop: does nothing anymore, not even with reservations', async (t) => {
  const s = setup(t, advancing);
  s.ticker.stop();
  await s.tick();
  assert.equal(s.calls(), 0);
});

test('stop during a read: does not schedule itself again', async (t) => {
  const g = gate<RoundState>();
  const s = setup(t, advancing);
  s.setRead(() => g.promise);
  await s.tick();
  s.ticker.stop();
  g.resolve({ round: 5n, waiting: true });
  await flush();
  await s.tick();
  await s.tick();
  assert.equal(s.calls(), 0);
});
