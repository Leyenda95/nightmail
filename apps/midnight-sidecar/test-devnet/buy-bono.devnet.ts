// wallet.buyBono on the local devnet with the real sidecar as a process (npm run test:devnet -w apps/midnight-sidecar):
// buys a paid bono with TestToken from the embedded wallet and checks it is idempotent (a retry with the
// same `id`, even after cancelling midway, does not pay again).
//
// It uses the user wallet of wallet.devnet.ts (.data/sidecar-devnet/): run that one first (it funds it and registers
// DUST). If it lacks TestToken, it mints with the faucet. Do not run alongside other devnet tests
// (they share the devnet and the operator wallet).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, REPO_ROOT } from '../../server/src/config.ts';
import { CALL_REJECTED, eventually, rpcError, seconds, Sidecar } from './sidecar-process.ts';

const CANCELLED = -32004;
const NO_EXPIRY = 2 ** 32 - 1;
const config = loadConfig('undeployed');
const contracts = JSON.parse(readFileSync(path.join(config.dataDir, 'contracts.json'), 'utf8'));
const R: string = contracts.registry.address;
const dataDir = path.join(REPO_ROOT, '.data', 'sidecar-devnet');
const secrets = JSON.parse(readFileSync(path.join(dataDir, 'secrets.json'), 'utf8'));
const timings: string[] = [];

let sidecar: Sidecar;
let price: bigint;

const tokens = async () => {
  const b = await sidecar.call('wallet.balance', {});
  return BigInt(b.tokens.find((t: any) => t.color === contracts.token.color)?.amount ?? '0');
};

/** Leaf of the paid bono with that id (using the contract's pure circuits, via the sidecar). */
async function leafOf(id: string): Promise<string> {
  const { results } = await sidecar.call('contract.hashes', { contractAddress: R, ops: [{ op: 'leaf', id, plan: 'paid', validUntil: NO_EXPIRY }] });
  return results[0];
}

async function positionOf(id: string): Promise<number | null> {
  const { positions } = await sidecar.call('contract.findBonos', { contractAddress: R, leaves: [await leafOf(id)] });
  return positions[0];
}

async function buy(id: string, amount = price) {
  const t0 = performance.now();
  try {
    return await sidecar.call('wallet.buyBono', { contractAddress: R, id, amount: amount.toString() });
  } finally {
    timings.push(`wallet.buyBono ${id.slice(0, 8)}…`.padEnd(30) + seconds(performance.now() - t0));
  }
}

before(async () => {
  ({ sidecar } = await Sidecar.start());
  await sidecar.call('wallet.open', { ...secrets, stateDir: path.join(dataDir, 'wallet') });
  const b = await sidecar.call('wallet.sync', {});
  assert.ok(b.dustCoins > 0, 'the user wallet has no DUST: run wallet.devnet.ts first');
  price = BigInt((await sidecar.call('contract.snapshot', { contractAddress: R, limit: 1 })).price);
  if ((await tokens()) < 3n * price) {
    const before = await tokens();
    await sidecar.call('wallet.faucet', { tokenAddress: contracts.token.address, amount: (5n * price).toString() });
    await eventually('the minted TestToken arrives', tokens, (t) => t >= before + 5n * price, 90, 2000);
  }
});

after(async () => {
  await sidecar?.call('wallet.close', {}).catch(() => {});
  assert.equal(await sidecar?.close(), 0, 'the sidecar exits cleanly');
  console.log(`\nTiempos (buyBono):\n${timings.join('\n')}`);
});

test('an amount that is not the price is rejected locally without charging', async () => {
  const before = await tokens();
  const e = await rpcError(buy(randomBytes(32).toString('hex'), price + 1n));
  assert.equal(e.code, CALL_REJECTED);
  assert.deepEqual(e.data, { reason: 'wrong-amount' });
  assert.equal(await tokens(), before);
});

test('buys a bono and a retry with the same id does not pay again', { timeout: 30 * 60_000 }, async () => {
  const id = randomBytes(32).toString('hex');
  const before = await tokens();
  const first = await buy(id);
  assert.equal(first.alreadyIncluded, false);
  assert.notEqual(await positionOf(id), null, 'the leaf is in the tree');
  const again = await buy(id);
  assert.equal(again.alreadyIncluded, true);
  await eventually('the wallet sees the payment', tokens, (t) => t === before - price, 30, 2000);
});

test('cancelled mid-wait, the retry waits for the same purchase and does not pay twice', { timeout: 30 * 60_000 }, async () => {
  const id = randomBytes(32).toString('hex');
  const before = await tokens();
  const { id: requestId, result } = sidecar.request('wallet.buyBono', { contractAddress: R, id, amount: price.toString() });
  // Cancel a few seconds after paying (the transaction has already been sent or is about to be).
  sidecar.onNotification = (n) => {
    if (n.method === 'progress' && n.params.requestId === requestId && n.params.stage === 'paying') {
      setTimeout(() => sidecar.cancel(requestId), 4000);
    }
  };
  const outcome = await result.then(() => 'done', (e) => e.code);
  sidecar.onNotification = () => {};
  assert.ok(outcome === 'done' || outcome === CANCELLED, `resultado: ${outcome}`);
  const retry = await buy(id);
  assert.equal(retry.alreadyIncluded, true, 'the retry does not buy again');
  assert.notEqual(await positionOf(id), null);
  await eventually('the wallet sees ONE payment', tokens, (t) => t === before - price, 30, 2000);
});
