// Operator connection to the NightMail contracts: midnight-js builds and proves the transactions;
// the operator wallet balances them (DUST and, when needed, shielded tokens), signs and submits.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspect } from 'node:util';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { ContractState, sampleSigningKey } from '@midnight-ntwrk/compact-runtime';
import { createUnprovenCallTx, createUnprovenDeployTx } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { LedgerTransaction } from '@midnight-ntwrk/midnight-js-types';
import { Transaction } from '@midnightntwrk/ledger-v9';
import { classifySubmissionFailure } from '@midnightntwrk/wallet-sdk-capabilities/submission';
import { REPO_ROOT, type ServerConfig } from '../config.ts';
import type { OperatorWallet } from '../wallet/operatorWallet.ts';

export const CONTRACTS = { registry: 'registry', token: 'token' } as const;
export type ContractName = keyof typeof CONTRACTS;

/** A contract's maintenance authority key (compact-runtime format). */
export type SigningKey = { tag: 'schnorr'; value: string };
export const newSigningKey = (): SigningKey => sampleSigningKey() as SigningKey;

type TokenKind = 'dust' | 'shielded' | 'unshielded';
/**
 * A proven, unbalanced, serialized transaction, ready for the wallet to pay for and submit.
 * `foreign`: built by someone else (relay); the wallet balances it but does not sign it (see balanceAndSign).
 */
export type Prepared = { bytes: Uint8Array; proveMs: number; kinds: TokenKind[]; result?: unknown; foreign?: boolean };
export type Outcome = {
  ok: boolean;
  /** SucceedEntirely, FailFallible…; 'rejected' if the node refused it; 'local-reject' if building it failed. */
  status: string;
  proveMs: number;
  blockMs: number;
  bytes: number;
  result?: unknown;
  error?: string;
};

const TTL_MS = 30 * 60_000;

/**
 * Message with the chain of causes (the SDK wraps the node error). The wallet wraps it in an Effect
 * FiberFailure that does not expose `cause`: the node's RpcError only shows up when inspecting it,
 * so it is extracted from there.
 */
export function causes(e: unknown): string {
  const parts: string[] = [];
  for (let c: any = e, i = 0; c && i < 6; c = c.cause, i++) parts.push(String(c.message ?? c).slice(0, 200));
  const rpc = /RpcError: [^\n]+/.exec(inspect(e, { depth: 10 }))?.[0].slice(0, 200);
  if (rpc && !parts.some((p) => p.includes(rpc))) parts.push(rpc);
  return parts.join(' ← ');
}

/** Directory of the contract compiled with keys (contracts/managed/<name>). */
export function compiledDir(name: ContractName, root = REPO_ROOT): string {
  const dir = path.join(root, 'contracts', 'managed', CONTRACTS[name]);
  if (!existsSync(path.join(dir, 'keys'))) {
    throw new Error(`Contract ${name} is not compiled with keys: run \`npm run compile -w contracts\``);
  }
  return dir;
}

/**
 * In-memory per-contract private states and maintenance keys (the operator keeps no circuit private
 * state; persistent keys are handled by deploy.ts).
 */
export function memoryPrivateStateProvider() {
  const states = new Map<string, Map<string, unknown>>();
  const signingKeys = new Map<string, SigningKey>();
  const forContract = (address: string) => {
    const own = states.get(address) ?? new Map<string, unknown>();
    states.set(address, own);
    return {
      contractAddress: address,
      set: async (id: string, s: unknown) => { own.set(id, s); },
      get: async (id: string) => own.get(id) ?? null,
      remove: async (id: string) => { own.delete(id); },
      clear: async () => { own.clear(); },
    };
  };
  return {
    signingKeys,
    provider: {
      forContract,
      setSigningKey: async (a: string, k: SigningKey) => { signingKeys.set(a, k); },
      getSigningKey: async (a: string) => signingKeys.get(a) ?? null,
      removeSigningKey: async (a: string) => { signingKeys.delete(a); },
      clearAll: async () => { states.clear(); },
      clearSigningKeys: async () => { signingKeys.clear(); },
    },
  };
}

/**
 * The wallet balances (DUST only, or shielded tokens too), signs and finalizes a proven transaction.
 * Balancing reserves coins: if signing fails they are released (`facade.revert` on the recipe); if
 * `finalizeRecipe` fails, it releases them itself (wallet-sdk-facade 5.0.1).
 * `foreign` (a client transaction) skips `signRecipe`, which would sign every unsigned unshielded input
 * with the operator key, whoever owns it (see relayable.ts). Paying DUST alone needs no signatures: a
 * DUST spend is authorized by its proof. Verified on the devnet.
 */
async function balanceAndSign(wallet: OperatorWallet, bytes: Uint8Array, kinds: TokenKind[], ttl: Date, foreign = false): Promise<any> {
  const handle = wallet.facade.adoptTransaction(bytes, 'Unbound');
  const recipe = await wallet.facade.balanceUnboundTransaction(handle, { ttl, tokenKindsToBalance: kinds });
  if (foreign) return wallet.facade.finalizeRecipe(recipe);
  let signed;
  try {
    signed = await wallet.facade.signRecipe(recipe, wallet.keystore.signDataAsync);
  } catch (e) {
    await wallet.facade.revert(recipe, 'not signed').catch(() => {}); // if this fails, the reservation expires with the tx
    throw e;
  }
  return wallet.facade.finalizeRecipe(signed);
}

/** Wallet and submission providers for the midnight-js flows that submit on their own (maintenance). */
function walletProviders(wallet: OperatorWallet, coinPublicKey: string, encryptionPublicKey: string) {
  // Maps each wrapped tx returned by balanceTx to the wallet's own finalized tx.
  const finalizedOf = new WeakMap<object, unknown>();
  return {
    walletProvider: {
      supportedEras: ['v9'],
      getCoinPublicKey: () => coinPublicKey,
      getEncryptionPublicKey: () => encryptionPublicKey,
      balanceTx: async (tx: any, ttl?: Date) => {
        const finalized = await balanceAndSign(wallet, tx.serialize(), ['dust'], ttl ?? new Date(Date.now() + TTL_MS));
        const wrapped = LedgerTransaction.fromBytes('v9', 'Finalized', finalized.serialize());
        finalizedOf.set(wrapped, finalized);
        return wrapped;
      },
    },
    midnightProvider: {
      supportedEras: ['v9'],
      submitTx: async (tx: object) => wallet.facade.submitTransaction(finalizedOf.get(tx) as any),
    },
  };
}

export async function openChain(config: ServerConfig, wallet: OperatorWallet) {
  const state: any = await wallet.facade.waitForSyncedState();
  const coinPublicKey: string = state.shielded.coinPublicKey.toHexString();
  const privateStates = memoryPrivateStateProvider();
  const base = {
    privateStateProvider: privateStates.provider,
    publicDataProvider: indexerPublicDataProvider(config.indexer, config.indexerWS),
    ...walletProviders(wallet, coinPublicKey, state.shielded.encryptionPublicKey.toHexString()),
    // Intents built by midnight-js (calls and deploys) expire together with the wallet's (TTL_MS)
    // rather than after an hour, so an uncertain send can be declared lost (and resent) sooner.
    config: { networkId: config.network, ttlSeconds: TTL_MS / 1000 },
  };
  const ctx: ChainContext = { config, wallet, base, signingKeys: privateStates.signingKeys };
  return {
    coinPublicKey,
    signingKeys: privateStates.signingKeys,
    /** A compiled contract bound to this connection. `witnesses` read each call's private state. */
    contract: (name: ContractName, witnesses: Record<string, unknown> = {}) => bindContract(ctx, name, witnesses),
    /** Time of the last block processed by the indexer. */
    indexedTime: () => indexedTime(config.indexer),
    /**
     * Pays (DUST only), signs, submits and awaits a tx proven by someone else (the relayer); see
     * sendPrepared. `beforeSubmit` receives what is about to be submitted, right before submitting.
     */
    send: (p: Prepared, beforeSubmit: (sent: SentTx) => void | Promise<void> = () => {}) =>
      sendPrepared(ctx, p, BLOCK_WAIT_MS, (finalized: any) => beforeSubmit(sentTxOf(finalized))),
  };
}

type ChainContext = { config: ServerConfig; wallet: OperatorWallet; base: any; signingKeys: Map<string, SigningKey> };

async function bindContract(ctx: ChainContext, name: ContractName, witnesses: Record<string, unknown>) {
  const zkDir = compiledDir(name);
  const module: any = await import(pathToFileURL(path.join(zkDir, 'contract', 'index.js')).href);
  const zk = new NodeZkConfigProvider<any>(zkDir);
  const providers: any = { ...ctx.base, zkConfigProvider: zk, proofProvider: httpClientProofProvider(ctx.config.proofServer, zk) };
  const compiled = CompiledContract.make<any>(name, module.Contract).pipe(
    CompiledContract.withWitnesses(witnesses as any),
    CompiledContract.withCompiledFileAssets(zkDir),
  );
  const send = (p: Prepared, beforeSubmit: (sent: SentTx) => void | Promise<void> = () => {}) =>
    sendPrepared(ctx, p, BLOCK_WAIT_MS, (finalized: any) => beforeSubmit(sentTxOf(finalized)));
  const prove = (unproven: unknown, kinds: TokenKind[], result?: unknown) => proveAndSend(providers, send, unproven, kinds, result);
  const build = (address: string, circuitId: string, ps: unknown, args: unknown[]) =>
    buildCall(providers, compiled, address, circuitId, ps, args);

  return {
    name, module, zkDir, compiled, providers, send,
    /**
     * Deploys with that key as maintenance authority (store it first: without it the contract can never be
     * maintained). `beforeSubmit` receives the signed tx's address, hash and expiry right before submission,
     * so they can be recorded and a resume never deploys a second contract (see deploy.ts).
     */
    deploy: (signingKey: SigningKey, args: unknown[], beforeSubmit: (sent: SentDeploy) => void | Promise<void> = () => {}) =>
      deployContract(ctx, providers, compiled, signingKey, args, beforeSubmit),
    /** Whether a contract exists at that address. */
    exists: async (address: string) => (await providers.publicDataProvider.queryContractState(address)) !== null,
    /** Verifying keys of the contract's maintenance authority committee. */
    maintenanceCommittee: async (address: string): Promise<string[]> =>
      (await contractState(providers, address)).maintenanceAuthority.committee.map((k: { value: string }) => k.value),
    /** Builds, proves, submits and waits. A local assert failure yields 'local-reject'. */
    call: (address: string, circuitId: string, ps: unknown, args: unknown[], kinds: TokenKind[] = ['dust']) =>
      callCircuit(() => build(address, circuitId, ps, args), prove, kinds),
    /** Builds and proves without submitting (lets race tests control arrival order). */
    async prepare(address: string, circuitId: string, ps: unknown, args: unknown[], kinds: TokenKind[] = ['dust']): Promise<Prepared> {
      const tx: any = await build(address, circuitId, ps, args);
      const t0 = performance.now();
      const bytes: Uint8Array = (await providers.proofProvider.proveTx(tx.private.unprovenTx)).serialize();
      return { bytes, proveMs: performance.now() - t0, kinds, result: tx.private.result };
    },
    async ledgerState(address: string): Promise<any> {
      return readLedger(providers, module, address);
    },
    /** Raw contract state, for what the generated ledger does not expose (see hasBonoLeaf). */
    state: (address: string): Promise<ContractState> => contractState(providers, address),
  };
}

/** Circuit or constructor args, only when non-empty (midnight-js rejects `args: []`). */
export const withArgs = (args: unknown[]) => (args.length ? { args } : {});

async function deployContract(
  ctx: ChainContext, providers: any, compiled: unknown,
  signingKey: SigningKey, args: unknown[], beforeSubmit: (sent: SentDeploy) => void | Promise<void>,
): Promise<{ address: string; outcome: Outcome }> {
  // The deploy intent expires together with the wallet's (TTL_MS, via `ttlSeconds` in openChain).
  const tx: any = await createUnprovenDeployTx(providers, {
    compiledContract: compiled, signingKey, initialPrivateState: {}, ...withArgs(args),
  } as any);
  // The address comes from the tx (ContractDeploy.address) before submission; each attempt carries a
  // fresh nonce, so resending mints a different address.
  const address: string = tx.public.contractAddress;
  const send = (p: Prepared) =>
    sendPrepared(ctx, p, BLOCK_WAIT_MS, (finalized: any) => beforeSubmit({ address, ...inFlightOf(ledgerTx(finalized)) }));
  const outcome = await proveAndSend(providers, send, tx.private.unprovenTx, ['dust']);
  if (outcome.ok) {
    await providers.publicDataProvider.watchForContractState(address);
    ctx.signingKeys.set(address, signingKey);
  }
  return { address, outcome };
}

async function callCircuit(
  build: () => Promise<any>, prove: (u: unknown, k: TokenKind[], r?: unknown) => Promise<Outcome>, kinds: TokenKind[],
): Promise<Outcome> {
  let tx: any;
  try {
    tx = await build();
  } catch (e) {
    return { ok: false, status: 'local-reject', proveMs: 0, blockMs: 0, bytes: 0, error: causes(e) };
  }
  return prove(tx.private.unprovenTx, kinds, tx.private.result);
}

async function contractState(providers: any, address: string): Promise<ContractState> {
  const read = await providers.publicDataProvider.queryContractState(address);
  if (!read) throw new Error(`No contract state at ${address}`);
  return read.contractState.deserialize({ v9: ContractState });
}

async function readLedger(providers: any, module: any, address: string): Promise<any> {
  return module.ledger((await contractState(providers, address)).data);
}

/** Runs the circuit locally against the current state (no proving, no submission). */
async function buildCall(providers: any, compiled: unknown, address: string, circuitId: string, ps: unknown, args: unknown[]) {
  const states = providers.privateStateProvider.forContract(address);
  const privateStateId = `call-${randomUUID()}`;
  await states.set(privateStateId, ps);
  try {
    return await createUnprovenCallTx(providers, {
      compiledContract: compiled, contractAddress: address, circuitId, privateStateId, ...withArgs(args),
    } as any);
  } finally {
    await states.remove(privateStateId);
  }
}

/** Proves and submits. Never throws: the outcome says what happened. */
async function proveAndSend(providers: any, send: (p: Prepared) => Promise<Outcome>, unproven: unknown, kinds: TokenKind[], result?: unknown): Promise<Outcome> {
  const t0 = performance.now();
  try {
    const bytes: Uint8Array = (await providers.proofProvider.proveTx(unproven)).serialize();
    return send({ bytes, proveMs: performance.now() - t0, kinds, result });
  } catch (e) {
    return { ok: false, status: 'prove-error', proveMs: performance.now() - t0, blockMs: 0, bytes: 0, error: causes(e) };
  }
}

/** The node refused the tx before inclusion (no fee charged, nothing applied): Substrate error 1010. */
export const isNodeRejection = (error: string) => /\b1010\b|Invalid Transaction/.test(error);

/**
 * The node's rejection code ("Custom error: N" inside error 1010, defined by the Midnight runtime), or
 * null if absent. It is the only part of a node error that may be passed on to a client.
 */
export function nodeRejectionCode(error: string): number | null {
  const code = /Custom error: (\d{1,5})\b/.exec(error)?.[1];
  return code === undefined ? null : Number(code);
}

/**
 * The submission failed because the node's pool refused it on arrival, so it cannot be in any block.
 * The text alone is not enough (a WebSocket close code 1010 contains it too): the wallet must also
 * classify it as 'NotIncluded' (a SubmissionError with a pool rejection code). 'NotIncluded' alone is
 * not enough either: it covers TransactionInvalid/Usurped, which may have been gossiped already.
 * If the wallet could not release its reservation, it throws an AggregateError with the submit error first.
 */
export function refusedByNode(e: unknown): boolean {
  const first = e instanceof AggregateError ? e.errors[0] : e;
  return classifySubmissionFailure(first)._tag === 'NotIncluded' && isNodeRejection(causes(first));
}

const BLOCK_WAIT_MS = 10 * 60_000;

type BeforeSubmit = (finalized: unknown) => void | Promise<void>;

/**
 * Releases the DUST reserved by a signed tx that will not be submitted; otherwise it stays reserved
 * until the tx expires. Returns the error to report.
 */
async function giveBack(wallet: OperatorWallet, finalized: unknown, cause: unknown): Promise<unknown> {
  try {
    await wallet.facade.revertTransaction(finalized as any, 'not submitted');
    return cause;
  } catch (e) {
    return `${causes(cause)}; revert: ${causes(e)}`;
  }
}

/**
 * Releases the DUST reserved by a tx the node refused before inclusion. The facade (5.0.1) does this itself,
 * except when the tx shares an identifier with an earlier submission (a repeated relay): then nothing is released
 * and the DUST stays locked for 3 h (`dustGracePeriod`); confirmed on the devnet and in the SDK source.
 * Only the DUST side (`facade.dust`), never `facade.revertTransaction`, which would mark the earlier
 * submission's record as Reverted. A no-op if already released. Returns the error to report.
 */
async function releaseDust(wallet: OperatorWallet, finalized: unknown, cause: unknown): Promise<unknown> {
  try {
    await wallet.facade.dust.revertTransaction(finalized as any);
    return cause;
  } catch (e) {
    return `${causes(cause)}; dust revert: ${causes(e)}`;
  }
}

/** A signed deployment about to be submitted: what must be recorded to be able to resume. */
export type SentDeploy = { address: string; txHash: string; validUntil: Date };

/**
 * Hash of a signed tx and the deadline for its inclusion in a block. The ledger rejects a tx with any
 * expired intent ("Intent TTL has expired"); taking the latest intent expiry stays on the safe side.
 */
export function inFlightOf(finalized: { transactionHash(): string; intents?: Map<number, { ttl: Date }> }) {
  const ttls = [...(finalized.intents?.values() ?? [])].map((i) => i.ttl.getTime());
  if (!ttls.length) throw new Error('The signed transaction has no intents');
  return { txHash: finalized.transactionHash(), validUntil: new Date(Math.max(...ttls)) };
}

/**
 * DUST paid by a signed tx: the sum of `vFee` over the DUST spends in its intents. This fee is charged
 * once the tx is in a block, whether or not it applies (FailFallible).
 */
export function dustFeeOf(tx: { intents?: Map<number, { dustActions?: { spends: { vFee: bigint }[] } | undefined }> | undefined }): bigint {
  let fee = 0n;
  for (const intent of tx.intents?.values() ?? []) {
    for (const spend of intent.dustActions?.spends ?? []) fee += spend.vFee;
  }
  return fee;
}

/** A signed tx about to be submitted: its hash, inclusion deadline and the DUST it pays. */
export type SentTx = { txHash: string; validUntil: Date; fee: bigint };

const sentTxOf = (finalized: { serialize(): Uint8Array }): SentTx => {
  const tx = ledgerTx(finalized);
  return { ...inFlightOf(tx), fee: dustFeeOf(tx) };
};

/**
 * The ledger-v9 tx inside the wallet's: the wallet returns an opaque wrapper (WalletTransaction) that
 * only offers `serialize()`.
 */
const ledgerTx = (finalized: { serialize(): Uint8Array }) =>
  Transaction.deserialize('signature', 'proof', 'binding', finalized.serialize());

const INDEXER_TIMEOUT_MS = 30_000;

/** Block timestamp of the last block processed by the indexer. */
export async function indexedTime(indexer: string, fetchFn: typeof fetch = fetch): Promise<Date> {
  const res = await fetchFn(indexer, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '{ block { timestamp } }' }),
    signal: AbortSignal.timeout(INDEXER_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`The indexer answered ${res.status}`);
  const timestamp = ((await res.json()) as any)?.data?.block?.timestamp;
  if (typeof timestamp !== 'number') throw new Error('The indexer did not return the time of its last block');
  return new Date(timestamp);
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no answer in ${ms / 1000} s`)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Submits a proven tx and waits for its block. The outcomes differ in what they imply:
 * - 'balance-error': the wallet could not balance or sign it (never left this process);
 * - 'record-error': `beforeSubmit` failed (never left this process);
 * - 'rejected': the node refused it before inclusion (no fee, no effects);
 * - 'unknown': submitted but the result is unknown (connection drop, timeout): it may be in a block;
 * - the block status (SucceedEntirely, FailFallible…) when known.
 * `beforeSubmit` receives the signed tx right before submission (so it can be recorded).
 */
export async function sendPrepared(
  ctx: Pick<ChainContext, 'wallet' | 'base'>, p: Prepared, waitMs = BLOCK_WAIT_MS, beforeSubmit: BeforeSubmit = () => {},
): Promise<Outcome> {
  const fail = (status: string, e: unknown): Outcome =>
    ({ ok: false, status, proveMs: p.proveMs, blockMs: 0, bytes: p.bytes.length, error: causes(e) });
  let finalized: unknown;
  try {
    finalized = await balanceAndSign(ctx.wallet, p.bytes, p.kinds, new Date(Date.now() + TTL_MS), p.foreign);
  } catch (e) {
    return fail('balance-error', e);
  }
  try {
    await beforeSubmit(finalized);
  } catch (e) {
    return fail('record-error', await giveBack(ctx.wallet, finalized, e));
  }
  const t1 = performance.now();
  let txId: string;
  try {
    // The wallet waits for 'Finalized' on a subscription that is not recreated on reconnect: without a limit it might never return.
    txId = await withTimeout(ctx.wallet.facade.submitTransaction(finalized as any), waitMs, 'submitTransaction');
  } catch (e) {
    return refusedByNode(e) ? fail('rejected', await releaseDust(ctx.wallet, finalized, e)) : fail('unknown', e);
  }
  try {
    const final = await withTimeout(ctx.base.publicDataProvider.watchForTxData(txId), waitMs, 'watchForTxData') as any;
    return { ok: final.status === 'SucceedEntirely', status: final.status, proveMs: p.proveMs,
      blockMs: performance.now() - t1, bytes: p.bytes.length, result: p.result };
  } catch (e) {
    return fail('unknown', e);
  }
}

export type Chain = Awaited<ReturnType<typeof openChain>>;
export type ChainContract = Awaited<ReturnType<Chain['contract']>>;
