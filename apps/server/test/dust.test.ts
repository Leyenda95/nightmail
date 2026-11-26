// ensureSpendableDust with a fake wallet: registers NIGHT only once, then waits for DUST.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ledger from '@midnightntwrk/ledger-v9';
import { ensureSpendableDust, registerNightForDust } from '../src/wallet/operatorWallet.ts';

const withDust = (n: number) => ({ dust: { availableCoins: Array(n).fill({}) } }) as any;

function fakeWallet(states: number[]) {
  let i = 0;
  return { facade: { waitForSyncedState: async () => withDust(states[Math.min(i++, states.length - 1)]!) } } as any;
}

function deps(first: number, over: Partial<Parameters<typeof ensureSpendableDust>[1]> = {}) {
  const calls = { register: 0, sleeps: 0 };
  return {
    calls,
    deps: {
      sync: async () => withDust(first),
      register: async () => { calls.register++; return true; },
      sleep: async () => { calls.sleeps++; },
      waitMs: 1,
      maxWaits: 5,
      ...over,
    },
  };
}

test('with spendable DUST it neither registers nor waits', async () => {
  const { calls, deps: d } = deps(2);
  const state = await ensureSpendableDust(fakeWallet([2]), d);
  assert.equal(state.dust.availableCoins.length, 2);
  assert.deepEqual(calls, { register: 0, sleeps: 0 });
});

test('without DUST it registers the NIGHT once and waits until it appears', async () => {
  const { calls, deps: d } = deps(0);
  const state = await ensureSpendableDust(fakeWallet([0, 0, 1]), d);
  assert.equal(state.dust.availableCoins.length, 1);
  assert.deepEqual(calls, { register: 1, sleeps: 3 });
});

test('if the DUST does not arrive, it gives up after the maximum number of waits', async () => {
  const { calls, deps: d } = deps(0);
  await assert.rejects(ensureSpendableDust(fakeWallet([0]), d), /No spendable DUST/);
  assert.equal(calls.register, 1);
  assert.equal(calls.sleeps, 5);
});

// registerNightForDust: the spending part runs in the exclusive section (the payer's single queue); the wait runs outside it.
function registeringWallet(events: string[], coins: { registered: boolean; night?: boolean }[]) {
  const nightRaw = ledger.unshieldedToken().raw;
  const utxo = (c: { registered: boolean; night?: boolean }) => ({
    utxo: { type: c.night === false ? 'other-token' : nightRaw },
    meta: { registeredForDustGeneration: c.registered },
  });
  const step = (name: string, value?: unknown) => async (...args: unknown[]) => { events.push(name); void args; return value; };
  return {
    state: { unshielded: { availableCoins: coins.map(utxo) } } as any,
    wallet: {
      keystore: { getPublicKey: () => 'pk', signData: () => 'sig' },
      facade: {
        estimateRegistration: async (pending: unknown[]) => { events.push(`estimate ${pending.length}`); return { fee: 5n }; },
        waitForGeneratedDust: step('wait'),
        registerNightUtxosForDustGeneration: step('register', { recipe: true }),
        finalizeRecipe: step('finalize', { finalized: true }),
        submitTransaction: step('submit', 'tx-id'),
      },
    } as any,
  };
}

test('registerNightForDust: with no NIGHT to register it does nothing', async () => {
  const events: string[] = [];
  const { wallet, state } = registeringWallet(events, [{ registered: true }, { registered: false, night: false }]);
  assert.equal(await registerNightForDust(wallet, state, async (spend) => { events.push('exclusive'); return spend(); }), false);
  assert.deepEqual(events, []);
});

test('registerNightForDust: waits for DUST outside and registers, finalizes and submits inside the exclusive section', async () => {
  const events: string[] = [];
  const { wallet, state } = registeringWallet(events, [{ registered: false }, { registered: true }, { registered: false }]);
  const done = await registerNightForDust(wallet, state, async (spend) => {
    events.push('exclusive start');
    const result = await spend();
    events.push('exclusive end');
    return result;
  });
  assert.equal(done, true);
  assert.deepEqual(events, ['estimate 2', 'wait', 'exclusive start', 'register', 'finalize', 'submit', 'exclusive end']);
  // Without an exclusive section (deploy, devnet tests) it does the same steps directly.
  events.length = 0;
  assert.equal(await registerNightForDust(wallet, state), true);
  assert.deepEqual(events, ['estimate 2', 'wait', 'register', 'finalize', 'submit']);
});

test('registerNightForDust: if the exclusive section does not admit it (queue full), it fails without spending anything', async () => {
  const events: string[] = [];
  const { wallet, state } = registeringWallet(events, [{ registered: false }]);
  await assert.rejects(registerNightForDust(wallet, state, async () => { throw new Error('queue full'); }), /queue full/);
  assert.deepEqual(events, ['estimate 1', 'wait']);
});
