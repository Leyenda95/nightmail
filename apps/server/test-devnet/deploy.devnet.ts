// Resumable deployment on the devnet (npm run test:devnet -w apps/server): what the fake chain in
// test/deploy.test.ts cannot check. That the precomputed address is the real one, that the hash and expiry
// recorded before submitting match the transaction that lands on chain, and that the indexer time decides
// between waiting and redeploying.
// Uses the wallet in .data/operator/undeployed but a temporary data directory for the deployment, so
// .data/operator/undeployed/contracts.json is untouched. Needs the devnet running, the contracts compiled
// with keys and the payer stopped.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { ensureSpendableDust, openOperatorWallet, type OperatorWallet } from '../src/wallet/operatorWallet.ts';
import { causes, newSigningKey, openChain, refusedByNode, type Chain } from '../src/chain/midnight.ts';
import { deployNightMail, DeployPendingError, EXPIRY_MARGIN_MS } from '../src/chain/deploy.ts';
import { registryWitnesses } from '../src/chain/registry.ts';
import { ensurePrivateDir, writePrivateFile } from '../src/wallet/storage.ts';

const config = loadConfig('undeployed');
let wallet: OperatorWallet;
let chain: Chain;
let deployedToken: string; // the one from the first test

const tempDataDir = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'nm-deploy-devnet-'));
  chmodSync(d, 0o700);
  const dir = path.join(d, 'operator');
  ensurePrivateDir(dir);
  return dir;
};
const progress = (dir: string) => JSON.parse(readFileSync(path.join(dir, 'contracts.json'), 'utf8'));
const deploy = (c: any, dir: string) => deployNightMail(c, { dataDir: dir, network: 'undeployed', price: 100n });

/** Hash of the transaction that deployed the contract, according to the indexer. */
async function deployTxHash(address: string): Promise<string> {
  const res = await fetch(config.indexer, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: `{ contractAction(address: "${address}") { transaction { hash } } }` }),
  });
  return ((await res.json()) as any).data.contractAction.transaction.hash;
}

/** The real chain, but with `deploy` of contract `name` replaced by `wrap`. */
function withDeploy(name: string, wrap: (deploy: (...a: any[]) => Promise<any>) => (...a: any[]) => Promise<any>) {
  return {
    ...chain,
    contract: async (n: any, w?: any) => {
      const c = await chain.contract(n, w);
      return n === name ? { ...c, deploy: wrap(c.deploy) } : c;
    },
  };
}

before(async () => {
  wallet = await openOperatorWallet(config);
  await ensureSpendableDust(wallet);
  chain = await openChain(config, wallet);
});

after(async () => {
  if (wallet) await wallet.close();
});

test('the submit response is lost: what was recorded before submitting is what lands, and the retry adopts it', async () => {
  const dir = tempDataDir();
  const sentAt = Date.now();
  // Really submits, then "crashes" without returning anything.
  const lossy = withDeploy('token', (real) => async (...a) => {
    const r = await real(...a);
    assert.ok(r.outcome.ok, `${r.outcome.status}: ${r.outcome.error}`);
    throw new Error('response lost');
  });
  await assert.rejects(deploy(lossy, dir), /response lost/);
  const sent = progress(dir).pending.token;
  assert.match(sent.address, /^[0-9a-f]{64}$/);
  const token = await chain.contract('token');
  assert.ok(await token.exists(sent.address), 'the precomputed address is that of the deployed contract');
  assert.equal(await deployTxHash(sent.address), sent.txHash, 'the recorded hash is that of the included transaction');
  const validUntil = Date.parse(sent.validUntil);
  // Both intents (deploy and wallet) expire after 30 min, so there is no need to wait the full hour of ttlSeconds.
  assert.ok(validUntil > sentAt + 29 * 60_000 && validUntil <= Date.now() + 30 * 60_000, `30 min expiry: ${sent.validUntil}`);

  const d = await deploy(chain, dir);
  assert.equal(d.token.address, sent.address, 'adopted, not deployed again');
  assert.ok(await (await chain.contract('registry', registryWitnesses())).exists(d.registry.address));
  assert.equal(progress(dir).pending, undefined);
  deployedToken = d.token.address;
});

// To trigger a real pool rejection an already expired transaction is submitted (the node rejects it with
// 1010 "Custom error: 228"). Resubmitting an already included one does not work: the wallet treats it as fine.
test('the real node pool rejection (1010) is classified as a rejection and the wallet does not keep the DUST', async () => {
  const coins = async () => ((await wallet.facade.waitForSyncedState()) as any).dust.availableCoins.length;
  const token = await chain.contract('token');
  const p = await token.prepare(deployedToken, 'mint', {}, [5n, new Uint8Array(randomBytes(32))]);
  const before = await coins();
  const handle = wallet.facade.adoptTransaction(p.bytes, 'Unbound');
  const recipe = await wallet.facade.balanceUnboundTransaction(handle, { ttl: new Date(Date.now() - 5 * 60_000), tokenKindsToBalance: ['dust'] });
  const finalized = await wallet.facade.finalizeRecipe(await wallet.facade.signRecipe(recipe, wallet.keystore.signDataAsync));
  try {
    const refusal = await Promise.race([
      wallet.facade.submitTransaction(finalized).then(() => 'accepted', (e: unknown) => e),
      new Promise((r) => setTimeout(() => r('no answer'), 120_000)),
    ]);
    assert.equal(typeof refusal, 'object', `expected a rejection, not ${String(refusal)}`);
    assert.match(causes(refusal), /RpcError: 1010: Invalid Transaction/);
    assert.equal(refusedByNode(refusal), true, causes(refusal));
  } finally {
    // In case the wallet did not release it: a dangling reservation would leave the wallet without DUST.
    await wallet.facade.revertTransaction(finalized, 'test').catch(() => {});
  }
  assert.equal(await coins(), before, 'the reserved DUST comes back');
});

test('if the submission cannot be recorded, it is not submitted and the wallet immediately gets back the DUST it reserved', async () => {
  const coins = async () => ((await wallet.facade.waitForSyncedState()) as any).dust.availableCoins.length;
  const before = await coins();
  const token = await chain.contract('token');
  const r = await token.deploy(newSigningKey(), [], () => { throw new Error('disk full'); });
  assert.deepEqual([r.outcome.status, r.outcome.error], ['record-error', 'disk full']);
  assert.equal(await token.exists(r.address), false, 'not submitted');
  assert.equal(await coins(), before, 'no dangling reservations (otherwise the wallet runs out of DUST until it expires)');
});

test('a recorded submission that is not on chain: waits while it can still land, once expired deploys another', async () => {
  const dir = tempDataDir();
  const ghost = { address: randomBytes(32).toString('hex'), txHash: randomBytes(32).toString('hex') };
  const now = (await chain.indexedTime()).getTime();
  const write = (validUntil: number) => writePrivateFile(dir, 'contracts.json', JSON.stringify({
    network: 'undeployed', pending: { token: { ...ghost, validUntil: new Date(validUntil).toISOString() } },
  }));
  write(now + 3600_000);
  await assert.rejects(deploy(chain, dir), DeployPendingError);
  assert.deepEqual(progress(dir).pending.token.address, ghost.address, 'left untouched');

  write(now - EXPIRY_MARGIN_MS - 60_000);
  // The token is enough: the registry run is cut before it is submitted.
  const stop = withDeploy('registry', () => async () => { throw new Error('stopped by the test'); });
  await assert.rejects(deploy(stop, dir), /parada del test/);
  const d = progress(dir);
  assert.notEqual(d.token.address, ghost.address);
  assert.ok(await (await chain.contract('token')).exists(d.token.address), 'deployed again');
});
