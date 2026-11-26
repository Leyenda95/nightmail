// Sends NIGHT from the operator wallet to an unshielded address on the local devnet (undeployed).
//   npm run send-night -w apps/server -- <mn_addr_undeployed1…> <amount in NIGHT, e.g. 5000 or 0,5>
// Local devnet only. Requires the payer stopped: the operator wallet allows one holder at a time and the payer keeps
// it while running (if it holds it, the command says so and sends nothing). Exit codes: 0 sent, 1 send failed,
// 2 invalid arguments or environment (no wallet is opened).
import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, REPO_ROOT } from '../config.ts';
import { installOutputRedaction } from '../redact.ts';
import { WalletInUseError } from '../wallet/storage.ts';
import { openOperatorWallet, type OperatorWallet } from '../wallet/operatorWallet.ts';
import {
  formatNight, isLinkedWorktree, parseSendNightArgs, SendNightInputError, sendNight, walletInUseMessage, type SendNightRequest,
} from '../wallet/sendNight.ts';

/** How long to wait for the wallet to close (final save, SDK stop, lock release). */
const CLOSE_TIMEOUT_MS = 30_000;

/**
 * Closes the wallet waiting at most CLOSE_TIMEOUT_MS (like closeOnShutdown in operator-wallet.ts). A failure or delay
 * is only reported and does not change the send result. If the lock is not released, it is orphaned on exit and the
 * next opener removes it (acquireLock checks whether its process is still alive).
 */
async function closeWallet(wallet: OperatorWallet): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), CLOSE_TIMEOUT_MS); });
  try {
    const isLate = await Promise.race([wallet.close().then(() => false), late]);
    if (isLate) console.error(`Warning: the operator wallet did not finish closing within ${CLOSE_TIMEOUT_MS / 1000} s, exiting anyway.`);
  } catch (err) {
    console.error(`Warning: error closing the operator wallet: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

const args = process.argv.slice(2);
let request: SendNightRequest;
try {
  request = parseSendNightArgs(args, process.env['NIGHTMAIL_NETWORK']);
} catch (err) {
  if (!(err instanceof SendNightInputError)) throw err;
  console.error(err.message);
  process.exit(2);
}
// The wallet directory comes from the checkout the command runs in (REPO_ROOT/.data), not from the payer.
// Before any wallet is opened, reject:
//  - a linked git worktree (`.git` is a file): any command ever run there (fund-night, operator-wallet,
//    deploy-contracts, the sidecar devnet test) may have created another wallet in its .data with the same genesis
//    seed; its lock cannot see the main checkout's payer, and both would spend the same coins;
//  - a directory without an operator seed (opening it would create a new wallet).
// A separate clone (`git clone`, with its own .data) is not detected; nothing here can guarantee that.
if (isLinkedWorktree(REPO_ROOT)) {
  console.error(`This checkout (${REPO_ROOT}) is a git worktree, with its own operator wallet that the payer does not see.`);
  console.error('Run the command from the main checkout of the repository (usually ~/nightmail).');
  process.exit(2);
}
const config = loadConfig('undeployed');
installOutputRedaction(config.secrets);
if (!existsSync(path.join(config.dataDir, 'seed'))) {
  console.error(`Operator wallet not found in ${config.dataDir}.`);
  console.error('Run the command from the repository checkout that started the devnet and the payer (usually ~/nightmail).');
  process.exit(2);
}

console.log(`Sending ${formatNight(request.amount)} to ${args[0]} (local devnet).`);
console.log('Opening the operator wallet…');
let wallet: OperatorWallet | null = null;
try {
  wallet = await openOperatorWallet(config);
  const txId = await sendNight(wallet, request.receiver, request.amount, (step) => console.log(step));
  console.log(`Done: transaction submitted. Transaction id: ${txId}`);
  console.log('The NIGHT shows up in the destination wallet within a few seconds, once it is in a block.');
  process.exitCode = 0;
} catch (err) {
  console.error(err instanceof WalletInUseError
    ? walletInUseMessage(err.message)
    : `Could not send the NIGHT: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (wallet) await closeWallet(wallet);
}
// The SDK leaves timers running (same as in deploy-contracts and fund-night).
process.exit();
