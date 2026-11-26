// Deploys TestToken and NightMailRegistry with the operator wallet.
//   NIGHTMAIL_NETWORK=undeployed npm run deploy-contracts -w apps/server [-- --price 100]
// Idempotent: if already deployed, it only prints what was recorded. Resumable without orphaned
// contracts: an unconfirmed deployment from an earlier attempt is adopted if it reached the chain,
// resent if it expired without landing, and if it still might land the command stops and says how
// long to wait (see chain/deploy.ts). Requires the contracts compiled with keys
// (`npm run compile -w contracts`) and the payer process stopped (the wallet allows one holder at a time).
import { parseArgs } from 'node:util';
import { loadConfig, redactUrl } from '../config.ts';
import { installOutputRedaction } from '../redact.ts';
import { WalletInUseError } from '../wallet/storage.ts';
import { balancesLine, ensureSpendableDust, openOperatorWallet, type OperatorWallet } from '../wallet/operatorWallet.ts';
import { causes, openChain } from '../chain/midnight.ts';
import { DeployInProgressError, deployNightMail, DeployPendingError } from '../chain/deploy.ts';

const { values } = parseArgs({ options: { price: { type: 'string', default: '100' } } });
if (!/^[1-9][0-9]{0,19}$/.test(values.price) || BigInt(values.price) >= 2n ** 64n) {
  console.error('[deploy] --price must be an integer between 1 and 2^64-1 (units of the payment token)');
  process.exit(2);
}
const price = BigInt(values.price);

const config = loadConfig();
installOutputRedaction(config.secrets);

let wallet: OperatorWallet | null = null;
try {
  console.log(`[deploy] network ${config.network}, indexer ${redactUrl(config.indexer)}, price ${price}`);
  wallet = await openOperatorWallet(config);
  console.log(`[deploy] ${balancesLine(await ensureSpendableDust(wallet))}`);
  const chain = await openChain(config, wallet);
  const d = await deployNightMail(chain, { dataDir: config.dataDir, network: config.network, price });
  console.log(`[deploy] TestToken        ${d.token.address} (color ${d.token.color})`);
  console.log(`[deploy] NightMailRegistry ${d.registry.address} (initial price ${d.registry.initialPrice})`);
  console.log(`[deploy] recorded in ${config.dataDir}/contracts.json`);
  console.log('[deploy] BACK UP maintenance-key-registry and operator-sk from that folder:');
  console.log('[deploy] without them the phase-2 circuits cannot be added and bonos cannot be issued.');
  process.exitCode = 0;
} catch (err) {
  if (err instanceof WalletInUseError) {
    console.error('[deploy] the operator wallet is in use (is the payer running?): tools/operator-wallet-service.sh stop');
  } else if (err instanceof DeployInProgressError) {
    console.error('[deploy] another deploy-contracts is already running with this data folder; nothing was sent:', err.message);
  } else if (err instanceof DeployPendingError) {
    console.error('[deploy] not finished, nothing was sent:', err.message);
  } else {
    console.error('[deploy] failed:', causes(err).slice(0, 1200));
  }
  process.exitCode = 1;
} finally {
  if (wallet) await Promise.race([wallet.close(), new Promise((r) => setTimeout(r, 10_000))]);
}
process.exit();
