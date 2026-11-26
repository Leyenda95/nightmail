// The sidecar's embedded wallet (wallet.*) on the local devnet, with the real sidecar as a process (npm run test:devnet -w
// apps/midnight-sidecar). The test plays the core: it opens the wallet with a user seed (stored in
// .data/sidecar-devnet/ to reuse state and funds across runs), funds it with NIGHT from the operator
// wallet (as the NIGHT faucet would), registers the NIGHT for DUST, mints TestToken with the faucet and
// checks the balance, closing, and reopening with the state restored.
//
// It needs the devnet running, the contracts deployed (.data/operator/undeployed/contracts.json) and the operator
// wallet free (if the payer holds it, it waits). Do not run alongside other devnet tests (they share the devnet
// and the operator wallet).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, REPO_ROOT } from '../../server/src/config.ts';
import { openOperatorWallet, type OperatorWallet } from '../../server/src/wallet/operatorWallet.ts';
import { parseUndeployedAddress, sendNight } from '../../server/src/wallet/sendNight.ts';
import { WalletInUseError } from '../../server/src/wallet/storage.ts';
import { eventually, rpcError, seconds, Sidecar } from './sidecar-process.ts';

const WALLET_UNAVAILABLE = -32013;
const INSUFFICIENT_FUNDS = -32014;
// 5,000 NIGHT: with 50, the DUST they generate takes ~15 min to cover the registration fee and afterwards is not enough
// to pay a transaction (seen on the devnet).
const FUNDING = 5_000_000_000n;
const MINT = 1_000n;

const config = loadConfig('undeployed');
const dataDir = path.join(REPO_ROOT, '.data', 'sidecar-devnet');
const stateDir = path.join(dataDir, 'wallet');
const contracts = JSON.parse(readFileSync(path.join(config.dataDir, 'contracts.json'), 'utf8'));
const timings: string[] = [];

/** Seed and state key of the devnet's "user": created once and reused. */
function userSecrets(): { seed: string; stateKey: string } {
  const file = path.join(dataDir, 'secrets.json');
  if (!existsSync(file)) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ seed: randomBytes(32).toString('hex'), stateKey: randomBytes(32).toString('hex') }), { mode: 0o600, flag: 'wx' });
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

async function timed<T>(label: string, run: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await run();
  } finally {
    timings.push(`${label.padEnd(30)} ${seconds(performance.now() - t0)}`);
  }
}

async function openOperatorWhenFree(): Promise<OperatorWallet> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await openOperatorWallet(config);
    } catch (e) {
      if (!(e instanceof WalletInUseError) || attempt >= 120) throw e;
      if (attempt % 6 === 0) console.log('operator wallet is in use: waiting…');
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

/** Sends NIGHT from the operator wallet to the user's unshielded address. */
async function fundWithNight(address: string, amount: bigint): Promise<void> {
  const operator = await openOperatorWhenFree();
  try {
    await sendNight(operator, parseUndeployedAddress(address), amount);
  } finally {
    await operator.close();
  }
}

let sidecar: Sidecar;
const secrets = userSecrets();
const open = () => sidecar.call('wallet.open', { ...secrets, stateDir });

before(async () => {
  ({ sidecar } = await Sidecar.start());
});

after(async () => {
  await sidecar?.call('wallet.close', {}).catch(() => {});
  assert.equal(await sidecar?.close(), 0, 'the sidecar exits cleanly');
  console.log(`\nTimings (embedded wallet):\n${timings.join('\n')}`);
});

test('before opening, the wallet is not available', async () => {
  const e = await rpcError(sidecar.call('wallet.balance', {}));
  assert.equal(e.code, WALLET_UNAVAILABLE);
  assert.deepEqual(e.data, { reason: 'not-open' });
});

test('opens, syncs, gets funded, registers DUST and mints TestToken', { timeout: 60 * 60_000 }, async () => {
  const opened = await timed('wallet.open', open);
  assert.match(opened.unshieldedAddress, /^mn_addr_undeployed1/);
  assert.match(opened.shieldedAddress, /^mn_shield-addr_undeployed1/);
  assert.equal(opened.stateDiscarded, false);
  assert.deepEqual((await rpcError(open())).data, { reason: 'already-open' });

  let balance = await timed('wallet.sync', () => sidecar.call('wallet.sync', {}));
  assert.equal(balance.synced, true);
  if (BigInt(balance.night) < FUNDING) {
    const night = BigInt(balance.night);
    await timed('NIGHT from the operator', () => fundWithNight(opened.unshieldedAddress, FUNDING));
    balance = await eventually('the NIGHT reaches the wallet', () => sidecar.call('wallet.balance', {}),
      (b: any) => BigInt(b.night) >= night + FUNDING, 90, 2000);
  }
  // Registers the NIGHT that does not generate DUST yet (false if everything was already registered).
  const { registered } = await timed('wallet.registerDust', () => sidecar.call('wallet.registerDust', {}));
  if (registered || balance.dustCoins === 0) {
    balance = await eventually('spendable DUST available', () => sidecar.call('wallet.balance', {}), (b: any) => b.dustCoins > 0, 90, 5000);
  }
  assert.equal((await sidecar.call('wallet.registerDust', {})).registered, false, 'no unregistered NIGHT left');

  const colorTokens = (b: any) => BigInt(b.tokens.find((t: any) => t.color === contracts.token.color)?.amount ?? '0');
  const before = colorTokens(balance);
  // Just registered, DUST grows over time: until it covers the fee, INSUFFICIENT_FUNDS dust.
  const minted = await timed('wallet.faucet (with DUST waits)', async () => {
    for (let i = 0; ; i++) {
      try {
        return await sidecar.call('wallet.faucet', { tokenAddress: contracts.token.address, amount: MINT.toString() });
      } catch (e: any) {
        if (e.code !== INSUFFICIENT_FUNDS || e.data?.asset !== 'dust' || i >= 30) throw e;
        await new Promise((r) => setTimeout(r, 30_000));
      }
    }
  });
  assert.match(minted.txId, /^[0-9a-f]+$/);
  await eventually('the minted TestToken reaches the wallet', () => sidecar.call('wallet.balance', {}),
    (b: any) => colorTokens(b) === before + MINT, 90, 2000);
});

test('closes saving the state and reopens restoring it', { timeout: 30 * 60_000 }, async () => {
  const before = await sidecar.call('wallet.balance', {});
  await sidecar.call('wallet.close', {});
  assert.deepEqual((await rpcError(sidecar.call('wallet.balance', {}))).data, { reason: 'not-open' });
  const reopened = await timed('wallet.open (restored)', open);
  assert.equal(reopened.restored, true);
  const after = await timed('wallet.sync (restored)', () => sidecar.call('wallet.sync', {}));
  assert.deepEqual(after.tokens, before.tokens);
});
