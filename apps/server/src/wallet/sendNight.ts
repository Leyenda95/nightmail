// Sends NIGHT from the operator wallet to an unshielded address on the local devnet (undeployed), acting as a
// NIGHT faucet (on preprod the official faucet is a website). Used by bin/send-night.ts, bin/fund-night.ts (called
// by the app e2e tests) and the sidecar wallet's devnet test.
//
// External input (arguments, address, amount) is validated here, before any wallet is opened.
import { lstatSync } from 'node:fs';
import path from 'node:path';
import * as ledger from '@midnightntwrk/ledger-v9';
import { MidnightBech32m, UnshieldedAddress } from '@midnightntwrk/wallet-sdk';
import { ensureSpendableDust, type OperatorWallet } from './operatorWallet.ts';

/** 1 NIGHT = 10^6 base units (as in balancesLine in operatorWallet.ts and apps/desktop/src/format.ts). */
const NIGHT_DECIMALS = 6;
/**
 * Largest accepted amount in base units: 2^128 - 1 (fits an unsigned 128-bit integer). The total NIGHT supply
 * (24 billion = 2.4·10^16 units) is not defined in the repo or the SDK, so it is not used as the cap; this one
 * only rejects absurd amounts before opening the wallet.
 */
export const MAX_AMOUNT = 2n ** 128n - 1n;
const TTL_MS = 30 * 60_000;
const NETWORK = 'undeployed';
const USAGE = 'Usage: send-night <mn_addr_undeployed1… address> <amount in NIGHT, e.g. 5000 or 0,5>';

/** An invalid argument; the message is shown as is to whoever typed the command. */
export class SendNightInputError extends Error {}

/**
 * Human-typed NIGHT amount ("5000", "0,5") → base units. Decimals use a comma and a dot is rejected: in Spanish
 * "5.000" means five thousand, and read as a decimal it would be five.
 */
export function parseNightAmount(text: string): bigint {
  if (text.includes('.')) {
    throw new SendNightInputError(`The amount "${text}" contains a dot: write decimals with a comma and no thousands separator (5000, 0,5).`);
  }
  const match = /^(\d+)(?:,(\d+))?$/.exec(text);
  if (!match) throw new SendNightInputError(`"${text}" is not a NIGHT amount (examples: 5000, 0,5).`);
  const [, whole = '', fraction = ''] = match;
  if (fraction.length > NIGHT_DECIMALS) {
    throw new SendNightInputError(`NIGHT allows at most ${NIGHT_DECIMALS} decimals, "${text}" has ${fraction.length}.`);
  }
  const units = BigInt(whole) * 10n ** BigInt(NIGHT_DECIMALS) + BigInt(fraction.padEnd(NIGHT_DECIMALS, '0'));
  if (units === 0n) throw new SendNightInputError('The amount must be greater than zero.');
  if (units > MAX_AMOUNT) {
    throw new SendNightInputError(`The amount is too large: the maximum is ${formatNight(MAX_AMOUNT)} (2^128 - 1 base units).`);
  }
  return units;
}

/** Base units → "5000 NIGHT", "0,5 NIGHT" (no thousands separator, matching how the command takes it). */
export function formatNight(units: bigint): string {
  const scale = 10n ** BigInt(NIGHT_DECIMALS);
  const fraction = (units % scale).toString().padStart(NIGHT_DECIMALS, '0').replace(/0+$/, '');
  return `${units / scale}${fraction ? `,${fraction}` : ''} NIGHT`;
}

/** Unshielded local devnet address (mn_addr_undeployed1…). Anything else is rejected with the reason. */
export function parseUndeployedAddress(text: string): UnshieldedAddress {
  let parsed: MidnightBech32m;
  try {
    parsed = MidnightBech32m.parse(text);
  } catch {
    throw new SendNightInputError(`"${text}" is not a valid Midnight address (it must start with mn_addr_undeployed1).`);
  }
  if (parsed.network !== NETWORK) {
    const network = typeof parsed.network === 'string' ? parsed.network : 'mainnet';
    throw new SendNightInputError(`The address belongs to the "${network}" network, only a local devnet address is valid here (mn_addr_undeployed1…).`);
  }
  try {
    return parsed.decode(UnshieldedAddress, NETWORK);
  } catch {
    throw new SendNightInputError(`The address is not an unshielded NIGHT address (mn_addr_undeployed1…), its type is "${parsed.type}".`);
  }
}

export type SendNightRequest = { receiver: UnshieldedAddress; amount: bigint };

/**
 * send-night arguments: `<address> <amount>`. `network` is NIGHTMAIL_NETWORK; unset means the local devnet. Any other
 * network is rejected (on preprod it would spend the tNIGHT that generates the payer's DUST).
 */
export function parseSendNightArgs(args: string[], network: string | undefined): SendNightRequest {
  if (args.length !== 2) throw new SendNightInputError(USAGE);
  if (network !== undefined && network !== NETWORK) {
    throw new SendNightInputError(`Only works on the local devnet (undeployed), and NIGHTMAIL_NETWORK=${network}. Unset that variable or set NIGHTMAIL_NETWORK=undeployed.`);
  }
  const [address = '', amount = ''] = args;
  return { amount: parseNightAmount(amount), receiver: parseUndeployedAddress(address) };
}

/**
 * Whether `root` is a linked git worktree (`git worktree add`). There `.git` is a file pointing at the main checkout;
 * in the main checkout it is a directory. No `.git` means not a linked worktree.
 */
export function isLinkedWorktree(root: string): boolean {
  return lstatSync(path.join(root, '.git'), { throwIfNoEntry: false })?.isFile() ?? false;
}

/**
 * Message for a busy operator wallet (WalletInUseError). The payer holds it for as long as it runs, so waiting does not
 * help: it has to be stopped briefly.
 */
export function walletInUseMessage(errorMessage: string): string {
  const pid = /process (\d+)/.exec(errorMessage)?.[1];
  return [
    `The operator wallet is busy${pid ? ` (process ${pid})` : ''}, usually because the payer keeps it open the whole time.`,
    'Stop the payer, run this command again and then start the payer again:',
    '  - if it is the service: NIGHTMAIL_NETWORK=undeployed tools/operator-wallet-service.sh stop   (then: ... start)',
    `  - if it was started by hand: kill -TERM ${pid ?? '<process>'}   and wait for it to exit.`,
    'Nothing was sent.',
  ].join('\n');
}

/**
 * Sends `amount` base units of unshielded NIGHT from the open operator wallet to `receiver` and returns the tx id.
 * Syncs first and makes sure there is DUST for the fee.
 */
export async function sendNight(
  wallet: OperatorWallet,
  receiver: UnshieldedAddress,
  amount: bigint,
  progress: (step: string) => void = () => {},
): Promise<string> {
  progress('Syncing the operator wallet and checking it has DUST for the fee…');
  await ensureSpendableDust(wallet);
  progress('Building and signing the transaction (the proof may take a while)…');
  const recipe = await wallet.facade.transferTransaction(
    [{ type: 'unshielded', outputs: [{ type: ledger.unshieldedToken().raw, receiverAddress: receiver, amount }] }],
    { ttl: new Date(Date.now() + TTL_MS) },
  );
  const signed = await wallet.facade.signRecipe(recipe, wallet.keystore.signDataAsync);
  const finalized = await wallet.facade.finalizeRecipe(signed);
  progress('Submitting the transaction to the network…');
  return String(await wallet.facade.submitTransaction(finalized));
}
