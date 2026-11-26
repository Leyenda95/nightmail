// The sidecar's embedded wallet: pays the plan with the shielded token (`wallet.buyBono`) and the fees of those
// transactions in DUST. Adapted from the operator's wallet (apps/server/src/wallet).
//
// - The core passes the wallet seed and the state key in `wallet.open`. The seed is wiped as soon as the SDK has
//   derived its keys (WalletSeeds does not keep it; facade.start turns the derived seeds into key objects, which are
//   wiped too). What stays in memory while open is the SDK's key objects and the keystore secret (they cannot be
//   wiped from outside). `wallet.close` stops the SDK and wipes the state key.
// - The synced state is stored encrypted in the folder chosen by the core (walletFiles.ts), every minute, after each
//   submit and on close. A state that cannot be read or restored is set aside and the wallet resyncs from scratch.
// - One open wallet per process, plus a single-instance lock per folder (two processes with the same wallet
//   would pick the same coins).
// - Spending operations run serially (`exclusive`), and only while they spend: long waits (generated DUST, a purchase
//   landing in a block) stay outside. `close` aborts whatever is running (`signal`), waits for the queue and only
//   then saves, stops the SDK and wipes the key.
// - Network: the SDK uses the global fetch/WebSocket, not net.ts (to be routed through that layer, with Tor, later).
//   What that exposes: the SDK's prover client sends the proving data of the spends to the local proof server (via
//   global fetch, without prover.ts's redirect guard); the indexer receives the shielded viewing key, the NIGHT
//   address and the DUST address (and the IP) and is polled every second for the submitted transactions; the node
//   sees the IP next to the buyBono transaction (and the leaf position).
import * as ledger from '@midnightntwrk/ledger-v9';
import {
  DustWallet, type FacadeState, HDWallet, InMemoryTransactionHistoryStorage, MidnightBech32m, PublicKey as UnshieldedPublicKey,
  Roles, ShieldedWallet, type UnshieldedKeystore, UnshieldedWallet, WalletEntrySchema, WalletFacade, WalletSeeds, createKeystore,
} from '@midnightntwrk/wallet-sdk';
import { classifySubmissionFailure } from '@midnightntwrk/wallet-sdk-capabilities/submission';
import { acquireLock, WalletInUseError } from '@nightmail/midnight';
import { AppError, codes } from './codes.ts';
import type { HandlerContext } from './rpc.ts';
import type { FundsAsset } from './protocol/FundsAsset.ts';
import type { InitializeParams } from './protocol/InitializeParams.ts';
import type { WalletBalance } from './protocol/WalletBalance.ts';
import type { WalletProblem } from './protocol/WalletProblem.ts';
import { WalletFiles } from './walletFiles.ts';

const SAVE_EVERY_MS = 60_000;
/**
 * Cap on waiting for a submit: submitTransaction waits until the transaction is finalized and the node client
 * retries the connection without limit. Past the cap the outcome is unknown (it may still land).
 */
export const SUBMIT_TIMEOUT_MS = 90_000;
/** How long `close` waits for in-flight work to finish before closing anyway. */
const DRAIN_TIMEOUT_MS = 30_000;
/** Cap on waiting for the DUST generated for the registration fee. */
const DUST_WAIT_MS = 30 * 60_000;
/** Maximum time to read the current state (the wallet emits it on subscription). */
const STATE_READ_MS = 10_000;

export const walletUnavailable = (reason: WalletProblem) => new AppError(codes.WALLET_UNAVAILABLE, 'Wallet unavailable', { reason });
export const insufficientFunds = (asset: FundsAsset) => new AppError(codes.INSUFFICIENT_FUNDS, 'Insufficient funds', { asset });
export const txRejected = () => new AppError(codes.TX_REJECTED, 'Transaction rejected');
export const cancelled = () => new AppError(codes.CANCELLED, 'Cancelled');

/** The submit did not finish in time: the transaction may be in the mempool or in a block (outcome unknown). */
export class SubmitPending extends Error {}

/** The promise or the abort of `signal` (CANCELLED), whichever comes first. A later rejection of the promise is ignored. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  promise.catch(() => {});
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Rejects with `error()` if the promise does not finish within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, error: () => Error): Promise<T> {
  promise.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(error()), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Searches an SDK error (Effect FiberFailure, causes, AggregateError...) for an object satisfying `match`, walking
 * its properties (symbol keys too, where Effect keeps the cause). Structural: no text matching on traces.
 */
export function findInError(e: unknown, match: (o: Record<PropertyKey, unknown>) => boolean, depth = 8, seen = new Set<unknown>()): Record<PropertyKey, unknown> | undefined {
  // Bytes (a transaction's txData: up to MBs) are not walked index by index.
  if (typeof e !== 'object' || e === null || depth < 0 || seen.has(e) || ArrayBuffer.isView(e)) return undefined;
  seen.add(e);
  const o = e as Record<PropertyKey, unknown>;
  if (match(o)) return o;
  for (const key of [...Object.getOwnPropertyNames(o), ...Object.getOwnPropertySymbols(o)]) {
    if (key === 'stack' || key === 'message') continue;
    let value: unknown;
    try {
      value = o[key]; // a throwing getter must not mask the original error
    } catch {
      continue;
    }
    const found = findInError(value, match, depth - 1, seen);
    if (found) return found;
  }
  return undefined;
}

export type OpenWallet = {
  facade: WalletFacade;
  keystore: UnshieldedKeystore;
  files: WalletFiles;
  unshieldedAddress: string;
  shieldedAddress: string;
  restored: boolean;
  /** Saves now (it also runs every minute). */
  save: () => Promise<void>;
  /** Runs `spend` when no other spending operation is in progress. */
  exclusive: <T>(spend: () => Promise<T>) => Promise<T>;
  /** Aborted when the wallet closes: whatever is in flight stops (combine it with each request's signal). */
  signal: AbortSignal;
  close: () => Promise<void>;
};

type Opened = { seed: Uint8Array; stateKey: Uint8Array; stateDir: string };

export function deriveKeystore(seed: Uint8Array, network: string) {
  const hd = HDWallet.fromSeed(seed);
  if (hd.type !== 'seedOk') throw new AppError(codes.INVALID_PARAMS, 'Invalid params');
  const derived = hd.hdWallet.selectAccount(0).selectRoles([Roles.NightExternal] as const).deriveKeysAt(0);
  if (derived.type !== 'keysDerived') throw new AppError(codes.INVALID_PARAMS, 'Invalid params');
  hd.hdWallet.clear();
  const keystore = createKeystore({ kind: 'schnorr', secret: derived.keys[Roles.NightExternal] }, network as never);
  return { keystore, address: UnshieldedPublicKey.fromKeyStore(keystore).address };
}

export function configuration(init: InitializeParams) {
  const ep = init.endpoints;
  return {
    networkId: init.network,
    costParameters: { feeBlocksMargin: 5 },
    relayURL: new URL(ep.node),
    provingServerUrl: new URL(ep.proofServer),
    indexerClientConnection: { indexerHttpUrl: ep.indexer, indexerWsUrl: ep.indexerWs },
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema),
  };
}

/** Restores each part of the saved state; if one cannot be, the state is set aside and that part starts from scratch. */
export function restorer(files: WalletFiles, saved: ReturnType<WalletFiles['readWallet']>) {
  let discarded = false;
  return <T>(restore: (s: NonNullable<typeof saved>) => T, fresh: () => T | Promise<T>): T | Promise<T> => {
    if (saved && !discarded) {
      try {
        return restore(saved);
      } catch {
        discarded = true;
        files.discardWallet();
      }
    }
    return fresh();
  };
}

/** Single-slot queue: spending operations never pick coins at the same time. */
export function serialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(spend: () => Promise<T>): Promise<T> => {
    const next = tail.then(spend);
    tail = next.catch(() => {});
    return next;
  };
}

export async function openWallet(init: InitializeParams, { seed, stateKey, stateDir }: Opened): Promise<OpenWallet> {
  let files: WalletFiles;
  let release: () => void;
  try {
    files = new WalletFiles(stateDir, stateKey);
  } catch (e) {
    seed.fill(0);
    throw e;
  }
  try {
    release = acquireLock(stateDir, 'wallet');
  } catch (e) {
    seed.fill(0);
    files.wipe();
    if (e instanceof WalletInUseError) throw walletUnavailable('in-use');
    throw e;
  }
  let facade: WalletFacade | undefined;
  let seeds: object | undefined;
  try {
    const keys = deriveKeystore(seed, init.network);
    const derived = WalletSeeds.fromMasterSeed(seed);
    seeds = derived;
    seed.fill(0);
    const saved = files.readWallet(keys.address);
    const restoreOr = restorer(files, saved);
    const seedsOf = derived;
    facade = await WalletFacade.init({
      configuration: configuration(init) as never,
      shielded: async (cfg) => restoreOr((s) => ShieldedWallet(cfg).restore(s.shielded), () => ShieldedWallet(cfg).startWithSeed(seedsOf.shielded)),
      unshielded: async (cfg) => restoreOr((s) => UnshieldedWallet(cfg).restore(s.unshielded),
        () => UnshieldedWallet(cfg).startWithPublicKey(UnshieldedPublicKey.fromKeyStore(keys.keystore))),
      dust: async (cfg) => restoreOr((s) => DustWallet(cfg).restore(s.dust), () => DustWallet(cfg).startWithSeed(seedsOf.dust)),
    });
    await facade.start(derived);
    wipeSeeds(derived);
    const restored = saved !== null && !files.discarded;
    files.readJournal(); // on open: an unreadable journal already puts its barrier and shows up in `stateDiscarded`
    const shieldedAddress = MidnightBech32m.encode(init.network as never, (await currentState(facade)).shielded.address).asString();
    return withPersistence({ facade, keystore: keys.keystore, files, unshieldedAddress: keys.address, shieldedAddress, restored }, release);
  } catch (e) {
    seed.fill(0);
    if (seeds) wipeSeeds(seeds);
    await facade?.stop().catch(() => {});
    release();
    files.wipe();
    throw e;
  }
}

/** Wipes the derived seeds (Uint8Array) returned by WalletSeeds once the SDK has created its keys. */
export function wipeSeeds(seeds: object): void {
  for (const value of Object.values(seeds)) if (value instanceof Uint8Array) value.fill(0);
}

/** Adds periodic saving, the spend queue and close. Saves are chained so none writes after close. */
export function withPersistence(base: Omit<OpenWallet, 'save' | 'exclusive' | 'close' | 'signal'>, release: () => void): OpenWallet {
  let closed = false;
  const closing = new AbortController();
  const exclusive = serialQueue();
  let chain: Promise<void> = Promise.resolve();
  const doSave = async () => {
    base.files.writeWallet({
      address: base.unshieldedAddress,
      shielded: await base.facade.shielded.serializeState(),
      unshielded: await base.facade.unshielded.serializeState(),
      dust: await base.facade.dust.serializeState(),
    });
  };
  const enqueueSave = () => {
    const next = chain.then(doSave);
    chain = next.catch(() => {});
    return next;
  };
  const timer = setInterval(() => {
    if (!closed) enqueueSave().catch(() => console.error('[sidecar] wallet: could not save state'));
  }, SAVE_EVERY_MS);
  timer.unref();
  return {
    ...base,
    save: async () => {
      if (closed) throw walletUnavailable('not-open');
      await enqueueSave();
    },
    exclusive,
    signal: closing.signal,
    close: async () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      closing.abort();
      // In-flight work sees the abort; wait (with a cap) for the queue to drain before touching the files.
      await withTimeout(exclusive(async () => {}), DRAIN_TIMEOUT_MS, () => new Error('drain')).catch(() => {});
      try {
        await enqueueSave();
      } finally {
        await base.facade.stop().catch(() => {});
        base.files.wipe();
        release();
      }
    },
  };
}

/** The wallet's current state (synced or not). */
export function currentState(facade: WalletFacade, timeoutMs = STATE_READ_MS): Promise<FacadeState> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      queueMicrotask(() => sub.unsubscribe());
      reject(new AppError(codes.APP_INTERNAL, 'Internal error'));
    }, timeoutMs);
    const sub = facade.state().subscribe((s) => {
      clearTimeout(timer);
      queueMicrotask(() => sub.unsubscribe());
      resolve(s);
    });
  });
}

type Progress = { appliedIndex: bigint; highestRelevantWalletIndex: bigint };

/** Sync percentage (that of the most lagging part, shielded or dust), or null if not known yet. */
export function syncPercent(s: { shielded: { progress: unknown }; dust: { progress: unknown } }): number | null {
  const parts = [s.shielded.progress, s.dust.progress] as Progress[];
  if (parts.some((p) => p.highestRelevantWalletIndex <= 0n)) return null;
  return Math.min(...parts.map((p) => Number((p.appliedIndex * 100n) / p.highestRelevantWalletIndex)), 100);
}

/** Waits for the wallet to be synced; reports progress when it changes; cancellable. */
export function waitForSync(facade: WalletFacade, context: HandlerContext): Promise<FacadeState> {
  return new Promise((resolve, reject) => {
    let last: number | null | undefined;
    const done = () => {
      context.signal.removeEventListener('abort', onAbort);
      queueMicrotask(() => sub.unsubscribe());
    };
    const onAbort = () => {
      done();
      reject(new AppError(codes.CANCELLED, 'Cancelled'));
    };
    context.signal.addEventListener('abort', onAbort, { once: true });
    const sub = facade.state().subscribe((s) => {
      if (s.isSynced) {
        done();
        resolve(s);
        return;
      }
      const percent = syncPercent(s);
      if (percent !== last) context.notify('progress', { requestId: context.requestId, stage: 'syncing', percent });
      last = percent;
    });
    if (context.signal.aborted) onAbort();
  });
}

const NIGHT = ledger.unshieldedToken().raw;

/** NIGHT coins that do not generate DUST yet (the ones `registerDust` registers). */
const unregisteredNight = (s: FacadeState) =>
  s.unshielded.availableCoins.filter((c) => c.utxo.type === NIGHT && !c.meta.registeredForDustGeneration);

export function balanceOf(s: FacadeState, now = new Date()): WalletBalance {
  const night = (s.unshielded.balances as unknown as Record<string, bigint>)[NIGHT] ?? 0n;
  const tokens = Object.entries(s.shielded.balances as unknown as Record<string, bigint>)
    .filter(([, amount]) => amount > 0n)
    .map(([color, amount]) => ({ color, amount: amount.toString() }));
  return {
    synced: s.isSynced,
    night: night.toString(),
    unregisteredNight: unregisteredNight(s).reduce((sum, c) => sum + c.utxo.value, 0n).toString(),
    dust: s.dust.balance(now).toString(),
    dustCoins: s.dust.availableCoins.length,
    tokens,
  };
}

/** Synced state, or WALLET_UNAVAILABLE not-synced (no spending from a lagging wallet). */
export async function syncedState(wallet: OpenWallet): Promise<FacadeState> {
  const s = await currentState(wallet.facade);
  if (!s.isSynced) throw walletUnavailable('not-synced');
  return s;
}

/**
 * Registers the NIGHT that is not yet registered so it generates DUST. The registration fee is paid with the DUST
 * those same coins generate, so it waits until there is enough (up to 30 min). Same flow as the operator's wallet.
 */
export async function registerDust(wallet: OpenWallet, context: HandlerContext): Promise<boolean> {
  const signal = AbortSignal.any([context.signal, wallet.signal]);
  const pending = unregisteredNight(await syncedState(wallet));
  if (pending.length === 0) return false;
  const notify = (stage: string) => context.notify('progress', { requestId: context.requestId, stage, percent: null });
  notify('waiting-dust');
  // The wait (up to 30 min, read-only) stays outside the spend queue, as in the operator's wallet.
  const { fee } = await wallet.facade.estimateRegistration(pending);
  await abortable(wallet.facade.waitForGeneratedDust(pending, fee, { timeoutMs: DUST_WAIT_MS }), signal);
  const utxoKey = (c: (typeof pending)[number]) => `${c.utxo.intentHash}:${c.utxo.outputNo}`;
  const waited = new Set(pending.map(utxoKey));
  return wallet.exclusive(async () => {
    signal.throwIfAborted();
    // Another call may have registered them meanwhile; and only the awaited ones (the generated DUST covers their fee).
    const still = unregisteredNight(await syncedState(wallet)).filter((c) => waited.has(utxoKey(c)));
    if (still.length === 0) return false;
    notify('submitting');
    const recipe = await wallet.facade.registerNightUtxosForDustGeneration(
      still, wallet.keystore.getPublicKey(), async (payload) => wallet.keystore.signData(payload));
    // No signRecipe: the registration is already signed (signing again gives error 192).
    await submit(wallet, await wallet.facade.finalizeRecipe(recipe), signal);
    return true;
  });
}

// --- Paying and submitting ---------------------------------------------------------------------------

/**
 * Is money missing to balance? Looks for the SDK's tagged error inside the Effect wrapper. Missing DUST for the
 * fee is `InsufficientFundsError({tokenType: 'dust'})` (dust-wallet v2/Transacting.js; on the devnet:
 * "could not balance dust"); `InsufficientDustForFee` only appears when registering NIGHT.
 */
export function missingAsset(e: unknown): FundsAsset | null {
  if (findInError(e, (o) => o._tag === 'Wallet.InsufficientDustForFee')) return 'dust';
  const funds = findInError(e, (o) => o._tag === 'Wallet.InsufficientFunds');
  if (!funds) return null;
  return funds.tokenType === 'dust' || /could not balance dust/.test(String(funds.message)) ? 'dust' : 'token';
}

type TokenKind = 'dust' | 'shielded' | 'unshielded';

/**
 * Balances (pays) a proven, unbalanced transaction, signs it and finalizes it. Balancing reserves coins: if signing
 * fails they are returned (`revert`); if `finalizeRecipe` fails, it returns them itself.
 */
export async function payFor(wallet: OpenWallet, provenTx: Uint8Array, kinds: TokenKind[], ttl: Date) {
  let recipe;
  try {
    recipe = await wallet.facade.balanceUnboundTransaction(wallet.facade.adoptTransaction(provenTx, 'Unbound'), { ttl, tokenKindsToBalance: kinds });
  } catch (e) {
    const asset = missingAsset(e);
    throw asset ? insufficientFunds(asset) : e;
  }
  let signed;
  try {
    signed = await wallet.facade.signRecipe(recipe, wallet.keystore.signDataAsync);
  } catch (e) {
    await wallet.facade.revert(recipe, 'not signed').catch(() => {});
    throw e;
  }
  return wallet.facade.finalizeRecipe(signed);
}

type Finalized = Awaited<ReturnType<WalletFacade['finalizeRecipe']>>;

/**
 * The node's pool rejected it on receipt (Substrate error 1010): it cannot be in any block. 'NotIncluded' alone is
 * not enough (it includes TransactionInvalid/Usurped, which may have been broadcast earlier), so the numeric code
 * 1010 is also required in the cause, never text (a `:1010:` inside a trace does not count).
 */
export function refusedByNode(e: unknown): boolean {
  const first = e instanceof AggregateError ? e.errors[0] : e;
  return classifySubmissionFailure(first)._tag === 'NotIncluded' && findInError(first, (o) => o.code === 1010) !== undefined;
}

/**
 * Submits and saves the state (the coins stay reserved). A definite node rejection is TX_REJECTED (the wallet has
 * already released what it reserved). If it does not finish within `timeoutMs` it is SubmitPending; if cancelled,
 * CANCELLED. In both cases it may have been sent (the SDK's promise keeps going, with nobody awaiting it). Any
 * other failure propagates unchanged.
 */
export async function submit(wallet: OpenWallet, finalized: Finalized, signal = wallet.signal, timeoutMs = SUBMIT_TIMEOUT_MS): Promise<string> {
  let txId;
  if (signal.aborted) {
    // Cancelled (or the wallet closing) before sending: nothing goes out and what was reserved is returned.
    await wallet.facade.revertTransaction(finalized as never, 'not submitted').catch(() => {});
    throw cancelled();
  }
  try {
    const sending = wallet.facade.submitTransaction(finalized);
    txId = await abortable(withTimeout(sending, timeoutMs, () => new SubmitPending()), signal);
  } catch (e) {
    if (refusedByNode(e)) throw txRejected();
    throw e;
  } finally {
    await wallet.save().catch(() => console.error('[sidecar] wallet: could not save state'));
  }
  return txId;
}
