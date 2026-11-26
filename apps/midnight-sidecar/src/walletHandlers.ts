// `wallet.*` methods (protocol 1.4): validate parameters and drive the open wallet (one per process). The logic
// lives in wallet.ts (wallet), walletCall.ts (calls paid by the wallet) and buyBono.ts.
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromHex } from '@nightmail/midnight';
import { buyBono } from './buyBono.ts';
import { contractAddress, invalid, isObject, publicErrors } from './contract.ts';
import type { Handler, HandlerContext } from './rpc.ts';
import type { InitializeParams } from './protocol/InitializeParams.ts';
import type { WalletOpenResult } from './protocol/WalletOpenResult.ts';
import {
  balanceOf, currentState, type OpenWallet, openWallet, registerDust, submit, waitForSync, walletUnavailable,
} from './wallet.ts';
import { amountOf, buildAndPay, type Compiled, compiledAt } from './walletCall.ts';

export { amountOf };


function openParams(params: unknown) {
  if (!isObject(params) || typeof params.stateDir !== 'string' || !path.isAbsolute(params.stateDir)) throw invalid();
  return { seed: fromHex(params.seed, 32, 'seed'), stateKey: fromHex(params.stateKey, 32, 'stateKey'), stateDir: params.stateDir };
}

/** Compiled TestToken: only the faucet uses it (test networks). Loaded on first use. */
let testToken: Promise<Compiled> | undefined;
function loadTestToken(): Promise<Compiled> {
  testToken ??= (async () => {
    const entry = import.meta.resolve('@nightmail/contracts/managed/token/contract/index.js');
    return compiledAt('token', fileURLToPath(new URL('../', entry)), await import(entry));
  })();
  return testToken;
}

/** The request context with a signal that is also aborted when the wallet closes. */
const withWallet = (wallet: OpenWallet, context: HandlerContext): HandlerContext =>
  ({ ...context, signal: AbortSignal.any([context.signal, wallet.signal]) });

/** `wallet.faucet`: mints TestToken to the wallet's own shielded key (`mint(amount, random nonce)`). Pays DUST. */
async function faucet(wallet: OpenWallet, init: InitializeParams, params: unknown, context: HandlerContext) {
  if (!isObject(params)) throw invalid();
  const address = contractAddress({ contractAddress: params.tokenAddress });
  const amount = amountOf(params.amount);
  const contract = await loadTestToken();
  const signal = withWallet(wallet, context).signal; // cancelling or closing the wallet stops the mint
  return wallet.exclusive(async () => {
    const paid = await buildAndPay(wallet, init, { ...context, signal }, {
      address, contract, circuit: 'mint', args: [amount, new Uint8Array(randomBytes(32))], kinds: ['dust'],
    });
    return { txId: await submit(wallet, paid.finalized, signal) };
  });
}

export type WalletHandlers = { handlers: Record<string, Handler>; close: () => Promise<void> };

export function walletHandlers(initialized: () => InitializeParams): WalletHandlers {
  let wallet: OpenWallet | null = null;
  let opening = false;
  const open = () => {
    if (!wallet) throw walletUnavailable('not-open');
    return wallet;
  };
  const close = async () => {
    const w = wallet;
    wallet = null;
    await w?.close();
  };
  const run = <T>(fn: () => Promise<T>) => publicErrors(fn);

  const handlers: Record<string, Handler> = {
    'wallet.open': (params) => run(async (): Promise<WalletOpenResult> => {
      const init = initialized();
      if (wallet || opening) throw walletUnavailable('already-open');
      const p = openParams(params);
      opening = true;
      try {
        wallet = await openWallet(init, p);
      } finally {
        opening = false;
        p.stateKey.fill(0); // WalletFiles keeps its own copy; openWallet wipes the seed
      }
      return {
        unshieldedAddress: wallet.unshieldedAddress, shieldedAddress: wallet.shieldedAddress,
        restored: wallet.restored, stateDiscarded: wallet.files.discarded,
      };
    }),
    'wallet.close': () => run(async () => {
      initialized();
      await close();
      return {};
    }),
    'wallet.sync': (_params, context) => run(async () => {
      initialized();
      const wallet = open();
      return balanceOf(await waitForSync(wallet.facade, withWallet(wallet, context)));
    }),
    'wallet.balance': () => run(async () => {
      initialized();
      return balanceOf(await currentState(open().facade));
    }),
    'wallet.registerDust': (_params, context) => run(async () => {
      initialized();
      return { registered: await registerDust(open(), context) };
    }),
    'wallet.faucet': (params, context) => run(async () => { const init = initialized(); return faucet(open(), init, params, context); }),
    'wallet.buyBono': (params, context) => run(async () => { const init = initialized(); return buyBono(open(), init, params, context); }),
  };
  return { handlers, close };
}
