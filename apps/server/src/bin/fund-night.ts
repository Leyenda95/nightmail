// Sends NIGHT from the operator wallet to an unshielded address (the app's payment wallet, for the demo).
//   NIGHTMAIL_NETWORK=undeployed npm run fund-night -w apps/server -- <mn_addr…> [--night 5000]
// Acts as a NIGHT faucet on the devnet (on preprod the official faucet is a website). Defaults to 5,000 NIGHT: with
// 50, the DUST they generate takes ~15 min to cover the registration fee and then is not enough to pay (seen on the
// devnet). Requires the payer stopped (the operator wallet allows one holder at a time). The transfer itself lives
// in wallet/sendNight.ts, shared with send-night (the manual version).
import { parseArgs } from 'node:util';
import type { UnshieldedAddress } from '@midnightntwrk/wallet-sdk';
import { loadConfig } from '../config.ts';
import { installOutputRedaction } from '../redact.ts';
import { WalletInUseError } from '../wallet/storage.ts';
import { openOperatorWallet, type OperatorWallet } from '../wallet/operatorWallet.ts';
import { parseNightAmount, parseUndeployedAddress, sendNight } from '../wallet/sendNight.ts';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { night: { type: 'string', default: '5000' } } });
if (positionals.length !== 1 || !/^[1-9][0-9]{0,9}$/.test(values.night)) {
  console.error('[fund-night] usage: fund-night <unshielded address> [--night <whole NIGHT, 1..9999999999>]');
  process.exit(2);
}
const config = loadConfig();
installOutputRedaction(config.secrets);
// Devnet only: the server defaults to preprod, where this would spend the tNIGHT that generates the payer's DUST.
if (config.network !== 'undeployed') {
  console.error('[fund-night] only for the local devnet: set NIGHTMAIL_NETWORK=undeployed');
  process.exit(2);
}
const amount = parseNightAmount(values.night);
let receiverAddress: UnshieldedAddress;
try {
  receiverAddress = parseUndeployedAddress(positionals[0]!);
} catch {
  console.error(`[fund-night] not an unshielded address of ${config.network}`);
  process.exit(2);
}

let wallet: OperatorWallet | null = null;
try {
  wallet = await openOperatorWallet(config);
  const tx = await sendNight(wallet, receiverAddress, amount);
  console.log(`[fund-night] sent ${values.night} NIGHT (tx ${tx})`);
  process.exitCode = 0;
} catch (err) {
  console.error(err instanceof WalletInUseError
    ? '[fund-night] the operator wallet is in use (stop the payer first)'
    : `[fund-night] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await wallet?.close();
}
// The SDK leaves timers running (same as in deploy-contracts).
process.exit();
