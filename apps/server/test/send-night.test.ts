// send-night: argument parsing (amount in NIGHT, devnet address, network) and sending with a fake wallet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as ledger from '@midnightntwrk/ledger-v9';
import { MidnightBech32m, UnshieldedAddress } from '@midnightntwrk/wallet-sdk';
import {
  formatNight, isLinkedWorktree, MAX_AMOUNT, parseNightAmount, parseSendNightArgs, parseUndeployedAddress, SendNightInputError,
  sendNight, walletInUseMessage,
} from '../src/wallet/sendNight.ts';

const receiver = new UnshieldedAddress(Buffer.alloc(32, 7));
const devnetAddress = MidnightBech32m.encode('undeployed', receiver).asString();
const preprodAddress = MidnightBech32m.encode('preprod', receiver).asString();
const inputError = (pattern: RegExp) => (err: unknown) => err instanceof SendNightInputError && pattern.test(err.message);

test('the NIGHT amount is converted to base units (1 NIGHT = 10^6)', () => {
  assert.equal(parseNightAmount('5000'), 5_000_000_000n); // same as FUNDING in the sidecar's devnet test
  assert.equal(parseNightAmount('1'), 1_000_000n);
  assert.equal(parseNightAmount('0,5'), 500_000n);
  assert.equal(parseNightAmount('2,000001'), 2_000_001n);
  assert.equal(parseNightAmount('0,000001'), 1n);
  assert.equal(parseNightAmount('007'), 7_000_000n); // leading zeros change nothing
  assert.equal(parseNightAmount('5,000'), 5_000_000n); // decimal comma: five, not five thousand
});

test('the amount is shown as it is typed, with a decimal comma', () => {
  assert.equal(formatNight(5_000_000_000n), '5000 NIGHT');
  assert.equal(formatNight(500_000n), '0,5 NIGHT');
  assert.equal(formatNight(2_000_001n), '2,000001 NIGHT');
  for (const text of ['12,5', '7', '0,000001']) assert.equal(formatNight(parseNightAmount(text)), `${text} NIGHT`);
});

test('an amount that is not a positive number of NIGHT is rejected', () => {
  for (const bad of ['', ',', 'abc', '-1', '+1', '1e3', ',5', '5,', '1 000', '0x10']) {
    assert.throws(() => parseNightAmount(bad), inputError(/is not a NIGHT amount/), bad);
  }
  assert.throws(() => parseNightAmount('0'), inputError(/greater than zero/));
  assert.throws(() => parseNightAmount('0,000'), inputError(/greater than zero/));
  assert.throws(() => parseNightAmount('0,0000001'), inputError(/6 decimals/));
});

test('a dot is rejected: "5.000" could mean five thousand or five', () => {
  assert.throws(() => parseNightAmount('5.000'), inputError(/comma/));
  assert.throws(() => parseNightAmount('0.5'), inputError(/comma/));
});

test('an amount above the maximum (2^128 - 1 base units) is rejected', () => {
  assert.equal(MAX_AMOUNT, 2n ** 128n - 1n);
  const atMax = formatNight(MAX_AMOUNT).replace(' NIGHT', '');
  assert.equal(parseNightAmount(atMax), MAX_AMOUNT);
  const overByOneUnit = formatNight(MAX_AMOUNT + 1n).replace(' NIGHT', '');
  for (const huge of [overByOneUnit, (2n ** 128n).toString(), '9'.repeat(1000)]) {
    assert.throws(() => parseNightAmount(huge), inputError(/maximum/), huge.slice(0, 40));
  }
  assert.throws(() => parseSendNightArgs([devnetAddress, '9'.repeat(1000)], undefined), inputError(/maximum/));
});

test('accepts an unshielded local devnet address', () => {
  assert.ok(parseUndeployedAddress(devnetAddress).equals(receiver));
});

test('rejects addresses from another network, of another type or malformed', () => {
  assert.throws(() => parseUndeployedAddress(preprodAddress), inputError(/"preprod" network/));
  const shielded = new MidnightBech32m('shield-addr', 'undeployed', Buffer.alloc(64, 1)).asString();
  assert.throws(() => parseUndeployedAddress(shielded), inputError(/unshielded/));
  assert.throws(() => parseUndeployedAddress('hola'), inputError(/is not a valid Midnight address/));
  assert.throws(() => parseUndeployedAddress(devnetAddress.slice(0, -1) + 'q'), inputError(/is not a valid Midnight address/));
});

test('the arguments: address and amount, local devnet only', () => {
  const ok = parseSendNightArgs([devnetAddress, '12,5'], undefined);
  assert.ok(ok.receiver.equals(receiver));
  assert.equal(ok.amount, 12_500_000n);
  assert.equal(parseSendNightArgs([devnetAddress, '1'], 'undeployed').amount, 1_000_000n);

  assert.throws(() => parseSendNightArgs([devnetAddress], undefined), inputError(/Usage: send-night/));
  assert.throws(() => parseSendNightArgs([devnetAddress, '1', 'extra'], undefined), inputError(/Usage: send-night/));
  assert.throws(() => parseSendNightArgs([devnetAddress, '1'], 'preprod'), inputError(/only .*local devnet/i));
  assert.throws(() => parseSendNightArgs([devnetAddress, '0'], undefined), inputError(/greater than zero/));
  assert.throws(() => parseSendNightArgs([preprodAddress, '1'], undefined), inputError(/preprod/));
});

test('if the payer holds the wallet, the message names its process and how to stop it', () => {
  const message = walletInUseMessage('operator wallet already in use by process 4242');
  assert.match(message, /process 4242/);
  assert.match(message, /kill -TERM 4242/);
  assert.match(message, /operator-wallet-service\.sh stop/);
  assert.match(message, /Nothing was sent/);
  assert.doesNotMatch(walletInUseMessage('could not acquire the operator wallet lock'), /undefined|null/);
  assert.doesNotMatch(message, /up\.sh/); // not in the repository
});

test('a linked git worktree (.git is a file) is told apart from the main checkout (.git is a directory)', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'send-night-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = path.join(root, 'main');
  const linked = path.join(root, 'linked');
  const plain = path.join(root, 'plain');
  mkdirSync(path.join(main, '.git'), { recursive: true });
  mkdirSync(linked);
  writeFileSync(path.join(linked, '.git'), 'gitdir: /somewhere/.git/worktrees/linked\n');
  mkdirSync(plain);
  assert.equal(isLinkedWorktree(main), false);
  assert.equal(isLinkedWorktree(linked), true);
  assert.equal(isLinkedWorktree(plain), false);
});

/** Fake operator wallet: already synced, with spendable DUST; records what it is asked to do. */
function fakeWallet() {
  const calls: { outputs?: unknown; ttl?: Date; signer?: unknown; finalized?: unknown; submitted?: unknown } = {};
  const signDataAsync = async () => 'signature';
  const synced = { isSynced: true, dust: { availableCoins: [{}] } };
  const facade = {
    state: () => ({ subscribe: (cb: (s: unknown) => void) => { queueMicrotask(() => cb(synced)); return { unsubscribe() {} }; } }),
    transferTransaction: async (outputs: unknown, options: { ttl: Date }) => { calls.outputs = outputs; calls.ttl = options.ttl; return 'recipe'; },
    signRecipe: async (recipe: string, signer: unknown) => { calls.signer = signer; return `signed ${recipe}`; },
    finalizeRecipe: async (signed: string) => { calls.finalized = signed; return `final ${signed}`; },
    submitTransaction: async (tx: string) => { calls.submitted = tx; return 'ab12cd'; },
  };
  return { calls, signDataAsync, wallet: { facade, keystore: { signDataAsync } } as any };
}

test('sends the unshielded NIGHT signed by the wallet and returns the transaction id', async () => {
  const { calls, signDataAsync, wallet } = fakeWallet();
  const steps: string[] = [];
  const txId = await sendNight(wallet, receiver, 3_000_000n, (step) => steps.push(step));
  assert.equal(txId, 'ab12cd');
  assert.deepEqual(calls.outputs, [
    { type: 'unshielded', outputs: [{ type: ledger.unshieldedToken().raw, receiverAddress: receiver, amount: 3_000_000n }] },
  ]);
  assert.ok(calls.ttl!.getTime() > Date.now());
  assert.equal(calls.signer, signDataAsync);
  assert.equal(calls.finalized, 'signed recipe');
  assert.equal(calls.submitted, 'final signed recipe');
  assert.ok(steps.length >= 2, 'reports its progress');
});
