// NightMail operator wallet: pays the DUST fees of relayed and operator transactions.
//
// A library: it installs no signal handlers and never exits the process; that is up
// to the payer process (bin/operator-wallet.ts).
//
// Syncing a new wallet takes hours (it rebuilds the global Merkle trees), so the
// state is saved every minute and restored at startup.
import WebSocket from 'ws';
import * as ledger from '@midnightntwrk/ledger-v9';
import {
  HDWallet, Roles, generateRandomSeed, WalletSeeds,
  createKeystore, PublicKey as UnshieldedPublicKey, type UnshieldedKeystore,
  WalletFacade, WalletEntrySchema, type DefaultConfiguration, type FacadeState,
  ShieldedWallet, UnshieldedWallet,
  InMemoryTransactionHistoryStorage,
} from '@midnightntwrk/wallet-sdk';
import { walletSeedSource, type ServerConfig } from '../config.ts';
import { OperatorDustWallet } from './dustWallet.ts';
import { nodeSubmission, type InclusionWatch } from './submission.ts';
import { acquireLock, loadOrCreateSeed, readState, setAsideState, writeState, type SavedState } from './storage.ts';

// The SDK uses the global WebSocket to talk to the indexer and the node.
if (!(globalThis as { WebSocket?: unknown }).WebSocket) (globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;

const SAVE_EVERY_MS = 60_000;

export class SyncStalledError extends Error {}

export type OperatorWallet = {
  facade: WalletFacade;
  keystore: UnshieldedKeystore;
  /** Public (unshielded) address to send faucet tNIGHT to. */
  address: string;
  /**
   * Reports when a submitted transaction enters a block, before the wallet's own `submitTransaction` returns
   * (that one waits for finality). Absent in test doubles: then nothing is reported early.
   */
  inclusion?: InclusionWatch;
  /** Saves the state now (it is also saved every minute). */
  save: () => Promise<void>;
  /** Stops the wallet: saves, stops the SDK and releases the lock. */
  close: () => Promise<void>;
};

function deriveKeystore(masterSeed: Uint8Array, config: ServerConfig) {
  const hd = HDWallet.fromSeed(masterSeed);
  if (hd.type !== 'seedOk') throw new Error('Invalid wallet seed');
  const derived = hd.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.NightExternal] as const)
    .deriveKeysAt(0);
  if (derived.type !== 'keysDerived') throw new Error('Could not derive wallet keys');
  hd.hdWallet.clear();
  const keystore = createKeystore({ kind: 'schnorr', secret: derived.keys[Roles.NightExternal] }, config.network);
  return { keystore, address: UnshieldedPublicKey.fromKeyStore(keystore).address };
}

function buildConfiguration(config: ServerConfig): DefaultConfiguration {
  return {
    networkId: config.network,
    costParameters: { feeBlocksMargin: 5 },
    relayURL: new URL(config.relayURL),
    provingServerUrl: new URL(config.proofServer),
    indexerClientConnection: { indexerHttpUrl: config.indexer, indexerWsUrl: config.indexerWS },
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema),
  };
}

export async function openOperatorWallet(config: ServerConfig): Promise<OperatorWallet> {
  const { seed: masterSeed, created } = loadOrCreateSeed(config.dataDir, walletSeedSource(config.network, () => generateRandomSeed()));
  if (created) console.log('[wallet] new operator wallet created (seed stored with permissions 0600)');
  const release = acquireLock(config.dataDir);
  try {
    const keys = deriveKeystore(masterSeed, config);
    const seeds = WalletSeeds.fromMasterSeed(masterSeed);
    const saved = readState(config.dataDir, keys.address);
    console.log(saved
      ? '[wallet] restoring saved state, only new blocks need syncing'
      : '[wallet] no saved state, full sync from genesis (this takes hours)');

    // If any part of the state cannot be restored, the whole file is set aside (so the
    // next periodic save does not overwrite it) and that part starts fresh.
    let setAside = false;
    const restoreOr = <T>(what: string, restore: () => T, fresh: () => T | Promise<T>): T | Promise<T> => {
      if (saved) {
        try {
          return restore();
        } catch (err) {
          console.warn(`[wallet] could not restore ${what} state, starting fresh:`, err instanceof Error ? err.message : err);
          if (!setAside) setAside = setAsideState(config.dataDir, `could not restore ${what}`) !== null;
        }
      }
      return fresh();
    };

    // The SDK default submission plus inclusion reports (submission.ts); the facade still waits for finality.
    const submission = nodeSubmission(new URL(config.relayURL));
    const facade = await WalletFacade.init({
      configuration: buildConfiguration(config),
      submissionService: () => submission.service as never,
      shielded: async (cfg) => restoreOr('shielded',
        () => ShieldedWallet(cfg).restore(saved!.shielded),
        () => ShieldedWallet(cfg).startWithSeed(seeds.shielded)),
      unshielded: async (cfg) => restoreOr('unshielded',
        () => UnshieldedWallet(cfg).restore(saved!.unshielded),
        () => UnshieldedWallet(cfg).startWithPublicKey(UnshieldedPublicKey.fromKeyStore(keys.keystore))),
      dust: async (cfg) => restoreOr('dust',
        () => OperatorDustWallet(cfg).restore(saved!.dust),
        () => OperatorDustWallet(cfg).startWithSeed(seeds.dust)),
    });
    await facade.start(seeds);

    // Saves are chained, so an in-progress periodic save never finishes after the
    // final save in close() nor writes after the lock is released.
    let closed = false;
    let chain: Promise<void> = Promise.resolve();
    const doSave = async () => {
      const state: SavedState = {
        version: 1,
        address: keys.address,
        shielded: await facade.shielded.serializeState(),
        unshielded: await facade.unshielded.serializeState(),
        dust: await facade.dust.serializeState(),
      };
      writeState(config.dataDir, state);
    };
    const enqueueSave = (): Promise<void> => {
      const next = chain.then(doSave);
      chain = next.catch(() => {});
      return next;
    };
    const save = async () => {
      if (closed) throw new Error('wallet is closed');
      await enqueueSave();
    };
    const timer = setInterval(() => {
      if (closed) return;
      enqueueSave().catch((err) => console.error('[wallet] could not save state:', err instanceof Error ? err.message : 'unknown error'));
    }, SAVE_EVERY_MS);
    timer.unref();

    const close = async () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      try {
        await enqueueSave(); // waits for pending saves, then saves one last time
      } finally {
        await facade.stop().catch(() => {});
        release();
      }
    };
    return { facade, ...keys, inclusion: { watch: submission.watch }, save, close };
  } catch (err) {
    release();
    throw err;
  }
}

function progressLine(s: FacadeState): string {
  const p = (x: unknown) => {
    const { appliedIndex, highestRelevantWalletIndex } = x as { appliedIndex: bigint; highestRelevantWalletIndex: bigint };
    return `${appliedIndex}/${highestRelevantWalletIndex}`;
  };
  return `dust ${p(s.dust.progress)}, shielded ${p(s.shielded.progress)}`;
}

/** Waits for the wallet to sync, logging progress. Rejects with SyncStalledError if it stalls. */
export function waitForSync(wallet: OperatorWallet, stallMs = 15 * 60_000): Promise<FacadeState> {
  const started = Date.now();
  let lastLine = '';
  let lastChange = Date.now();
  let lastLog = 0;
  return new Promise((resolve, reject) => {
    const watchdog = setInterval(() => {
      if (Date.now() - lastChange > stallMs) {
        sub.unsubscribe();
        clearInterval(watchdog);
        reject(new SyncStalledError(`sync has not advanced in ${stallMs / 60_000} min`));
      }
    }, 60_000);
    const sub = wallet.facade.state().subscribe((s) => {
      if (s.isSynced) {
        console.log(`[wallet] synced in ${Math.round((Date.now() - started) / 1000)}s`);
        sub.unsubscribe();
        clearInterval(watchdog);
        resolve(s);
        return;
      }
      const line = progressLine(s);
      if (line !== lastLine) {
        lastLine = line;
        lastChange = Date.now();
      }
      if (Date.now() - lastLog > 30_000) {
        lastLog = Date.now();
        console.log(`[wallet] syncing, ${line}, memory ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`);
      }
    });
  });
}

export function formatUnits(raw: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const cents = (raw * 100n) / scale;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

/** NIGHT (10^6 base units) and DUST (10^15). */
export function balancesLine(state: FacadeState): string {
  const night = (state.unshielded.balances as unknown as Record<string, bigint>)[ledger.unshieldedToken().raw] ?? 0n;
  const dust = state.dust.balance(new Date());
  return `NIGHT ${formatUnits(night, 6)}, DUST ${formatUnits(dust, 15)} (${state.dust.availableCoins.length} spendable coin(s))`;
}

/** Whether spendable DUST exists now (a balance > 0 is not enough: the coin appears a few blocks after registration). */
export function hasSpendableDust(state: FacadeState): boolean {
  return state.dust.availableCoins.length > 0;
}

/**
 * Syncs and makes sure spendable DUST exists: if not, registers the NIGHT (once) and waits for the
 * DUST coin to appear. Dependencies are injected so it can be tested without a network.
 */
export async function ensureSpendableDust(
  wallet: OperatorWallet,
  deps: {
    sync: (w: OperatorWallet) => Promise<FacadeState>;
    register: (w: OperatorWallet, s: FacadeState) => Promise<boolean>;
    sleep: (ms: number) => Promise<void>;
    waitMs: number;
    maxWaits: number;
  } = { sync: waitForSync, register: registerNightForDust, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), waitMs: 10_000, maxWaits: 60 },
): Promise<FacadeState> {
  let state = await deps.sync(wallet);
  for (let i = 0; !hasSpendableDust(state); i++) {
    if (i >= deps.maxWaits) throw new Error(`No spendable DUST after ${deps.maxWaits} waits`);
    if (i === 0) await deps.register(wallet, state);
    await deps.sleep(deps.waitMs);
    state = await wallet.facade.waitForSyncedState();
  }
  return state;
}

/**
 * Registers any NIGHT not yet registered for DUST generation (e.g. fresh from the faucet). The
 * registration fee is paid with the DUST those same coins generate. A partial failure is safe:
 * finalizeRecipe releases the reserved coins.
 *
 * `exclusive` wraps the spending part (register, finalize, submit): the payer process runs it through
 * its single queue so it never selects coins concurrently with another tx. Waiting for generated DUST
 * (up to 30 min, read-only) stays outside, so the queue is not blocked.
 */
export async function registerNightForDust(
  wallet: OperatorWallet,
  state: FacadeState,
  exclusive: <T>(spend: () => Promise<T>) => Promise<T> = (spend) => spend(),
): Promise<boolean> {
  const nightRaw = ledger.unshieldedToken().raw;
  const pending = state.unshielded.availableCoins.filter(
    (c) => c.utxo.type === nightRaw && !c.meta.registeredForDustGeneration,
  );
  if (pending.length === 0) return false;

  console.log(`[wallet] registering ${pending.length} NIGHT coin(s) for DUST generation`);
  const { fee } = await wallet.facade.estimateRegistration(pending);
  await wallet.facade.waitForGeneratedDust(pending, fee, { timeoutMs: 30 * 60_000 });
  const txId = await exclusive(async () => {
    const recipe = await wallet.facade.registerNightUtxosForDustGeneration(
      pending,
      wallet.keystore.getPublicKey(),
      async (payload) => wallet.keystore.signData(payload),
    );
    // No signRecipe: the registration is already signed, and signing it again
    // causes error 192 (InputsSignaturesLengthMismatch).
    const finalized = await wallet.facade.finalizeRecipe(recipe);
    return wallet.facade.submitTransaction(finalized);
  });
  console.log(`[wallet] DUST registration submitted: ${txId}`);
  return true;
}
