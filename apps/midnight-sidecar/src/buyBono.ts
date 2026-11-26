// `wallet.buyBono`: buys a payment bono with the shielded token, idempotently. A request timing out does not mean
// nothing was sent, and a retry must not pay the same `id` twice.
//
// How it works:
// - Proof of purchase is the leaf `leaf(ctx, id, paid, NO_EXPIRY)` in the `bonos` tree. If it is there, we are done.
// - Before sending, the purchase is written to the encrypted journal (with fsync): `id`, contract, hash and TTL (the
//   largest of the signed transaction's intents). While the TTL has not passed by the latest indexed block's time
//   (plus EXPIRY_MARGIN_MS) the transaction may still land, so it is not paid again: we wait.
// - Once expired without a leaf it can no longer land (the ledger rejects any intent with ttl below the block
//   time), so it is removed from the journal and bought again, at most MAX_PURCHASES times per call.
// - A definite rejection by the node on submit removes the entry and fails with TX_REJECTED. An uncertain outcome
//   (a submit that does not finish in time, a dropped connection...) keeps the journal and waits.
// - A lost (unreadable) journal leaves a barrier (walletFiles.ts): no `id` is paid until it expires.
// - Only what spends (read, build, pay, record, submit) runs in the wallet queue; waiting for the leaf does not.
// - Cancelling before recording returns the reserved coins and sends nothing; afterwards it only stops waiting (the
//   journal stays: the next call with the same `id` keeps waiting for that transaction). Closing the wallet cancels too.
// - The amount is fixed by the core (`amount`, the price the user accepted) and no other is ever paid. If the contract
//   does not accept it, the circuit fails locally (CALL_REJECTED wrong-amount / old-price-expired) without proving or sending.
// - The coin is always new (random nonce). The call is built with zeroed keys, as in proveCall: the only
//   output is the contract's, and the wallet supplies inputs and change when paying.
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Transaction } from '@midnightntwrk/ledger-v9';
import { bonoPositions, type CallStates, ctx, leaf, ledger, NO_EXPIRY, Plan, toHex } from '@nightmail/midnight';
import { AppError, codes } from './codes.ts';
import {
  b32, contractAddress, indexerGql, invalid, isObject, latestStates, MAX_INDEXER_RESPONSE_BYTES, publicErrors,
} from './contract.ts';
import { registryContract, requireFresh, requireSameCircuit } from './prove.ts';
import type { HandlerContext } from './rpc.ts';
import type { InitializeParams } from './protocol/InitializeParams.ts';
import type { WalletBuyBonoResult } from './protocol/WalletBuyBonoResult.ts';
import { cancelled, type OpenWallet, submit, SubmitPending, txRejected } from './wallet.ts';
import { BARRIER_ID, type Purchase } from './walletFiles.ts';
import { amountOf, buildAndPay } from './walletCall.ts';

/** How often to check whether the leaf is there (each read downloads the contract state). */
export const POLL_MS = 6_000;
/** Maximum purchases per call (one that expires without landing is repeated once; after that the core decides). */
export const MAX_PURCHASES = 2;
/**
 * Margin over the TTL: block time is in seconds in the ledger and in ms in the indexer, and which block the node
 * uses as reference is not verified. An extra minute only lengthens the wait.
 */
export const EXPIRY_MARGIN_MS = 60_000;
/** Consecutive reads allowed to fail (indexer down, stale state) while waiting before giving up. */
export const MAX_READ_FAILURES = 5;

export type Order = { address: string; id: Uint8Array; amount: bigint; leaf: string };
export type Seen = { blockHeight: number; blockTimestamp: number; included: boolean };
type Finalized = Parameters<typeof submit>[1];

export function orderOf(params: unknown): Order {
  if (!isObject(params)) throw invalid();
  const address = contractAddress(params);
  const id = b32(params.id, 'id');
  return { address, id, amount: amountOf(params.amount), leaf: toHex(leaf(ctx(address), id, Plan.paid, BigInt(NO_EXPIRY))) };
}

/** Dependencies of the purchase (replaced in unit tests). */
export type Deps = {
  /** Reads the latest state: its block, its time and whether the order's leaf is already in the tree. */
  read: (order: Order) => Promise<Seen>;
  pay: (order: Order) => Promise<Finalized>;
  /** Hash and TTL (largest of its intents) of the signed transaction. */
  inspect: (finalized: Finalized) => { txHash: string; ttl: number };
  /** Gives back to the wallet what a transaction that will not be sent had reserved. */
  giveBack: (finalized: Finalized) => Promise<void>;
  submit: (finalized: Finalized) => Promise<string>;
  journal: { read: () => Purchase[]; write: (purchases: Purchase[]) => void };
  exclusive: <T>(run: () => Promise<T>) => Promise<T>;
  wait: (ms: number) => Promise<void>;
  signal: AbortSignal;
  notify: (stage: string, data?: Record<string, unknown>) => void;
};

/** Hash and TTL of the signed transaction (the wallet's is an opaque wrapper that only offers serialize). */
export function inspectTx(finalized: { serialize(): Uint8Array }): { txHash: string; ttl: number } {
  const tx = Transaction.deserialize('signature', 'proof', 'binding', finalized.serialize());
  const ttls = [...(tx.intents?.values() ?? [])].map((i) => i.ttl.getTime());
  if (ttls.length === 0) throw new Error('The signed transaction has no intents');
  return { txHash: tx.transactionHash(), ttl: Math.max(...ttls) };
}

function realDeps(wallet: OpenWallet, init: InitializeParams, context: HandlerContext): Deps {
  const signal = AbortSignal.any([context.signal, wallet.signal]);
  const gql = () => indexerGql(init.endpoints.indexer, signal, MAX_INDEXER_RESPONSE_BYTES);
  return {
    // With already public errors (IndexerUnavailable maps to UPSTREAM_UNAVAILABLE): readTolerant tells them apart by code.
    read: (order) => publicErrors(async () => {
      const states: CallStates = await latestStates(gql(), order.address);
      requireFresh(states.blockTimestamp);
      const included = bonoPositions(states.state).positions.has(order.leaf);
      return { blockHeight: states.blockHeight, blockTimestamp: states.blockTimestamp, included };
    }),
    pay: async (order) => (await buildAndPay(wallet, init, { ...context, signal }, {
      address: order.address,
      contract: registryContract,
      circuit: 'buyBono',
      // New coin of the colour the contract charges (read from the same state the call is built against).
      args: (states) => [
        { nonce: new Uint8Array(randomBytes(32)), color: ledger(states.state.data).paymentColor, value: order.amount }, order.id,
      ],
      kinds: ['shielded', 'dust'],
      walletKeys: false,
      check: (states) => requireSameCircuit(states, 'buyBono'),
    })).finalized,
    inspect: inspectTx,
    giveBack: async (finalized) => {
      await wallet.facade.revertTransaction(finalized as never, 'not submitted').catch(() => {});
    },
    submit: (finalized) => submit(wallet, finalized, signal),
    journal: { read: () => wallet.files.readJournal(), write: (p) => wallet.files.writeJournal(p) },
    exclusive: (run) => wallet.exclusive(run),
    wait: (ms) => sleep(ms, undefined, { signal }).catch(() => { throw cancelled(); }),
    signal,
    notify: (stage, data) => context.notify('progress', { requestId: context.requestId, stage, percent: null, ...data }),
  };
}

const matches = (order: Order) => (p: Purchase) =>
  p.id === BARRIER_ID || (p.contractAddress === order.address && p.id === toHex(order.id));
const sameEntry = (a: Purchase) => (b: Purchase) => a.id === b.id && a.contractAddress === b.contractAddress && a.txHash === b.txHash;
const expired = (p: Purchase, seen: Seen) => seen.blockTimestamp > p.ttl + EXPIRY_MARGIN_MS;

/** One step of the purchase (inside the wallet queue): finish, wait, or pay and send. */
type Step = { done: WalletBuyBonoResult } | { waitUntil: number; sent: boolean };

/** What the state read says: already there, a purchase in flight to wait for, or time to buy. */
function decide(order: Order, seen: Seen, deps: Deps, bought: number): Step | 'buy' {
  // With the leaf already in the tree the journal entry is kept: another call with the same `id` may have read an
  // earlier state (or a lagging indexer) and, with no entry, would buy again. It is pruned on its own once it
  // expires (writeJournal).
  if (seen.included) return { done: { blockHeight: seen.blockHeight, alreadyIncluded: bought === 0 } };
  const inFlight = deps.journal.read().filter(matches(order));
  const live = inFlight.filter((p) => !expired(p, seen));
  const dead = inFlight.filter((p) => expired(p, seen));
  if (dead.length > 0) deps.journal.write(deps.journal.read().filter((p) => !dead.some(sameEntry(p)))); // can no longer land
  if (live.length > 0) return { waitUntil: Math.max(...live.map((p) => p.ttl)), sent: false };
  if (bought >= MAX_PURCHASES) throw txRejected();
  return 'buy';
}

/** Pays, records in the journal and sends. Cancelling, or failing to record, before sending gives the coins back. */
async function buyOnce(order: Order, deps: Deps): Promise<Step> {
  const finalized = await deps.pay(order);
  let entry: Purchase;
  try {
    const { txHash, ttl } = deps.inspect(finalized);
    entry = { id: toHex(order.id), contractAddress: order.address, txHash, ttl };
    if (deps.signal.aborted) throw cancelled(); // last point where cancelling still sends nothing
    deps.journal.write([...deps.journal.read(), entry]);
  } catch (e) {
    await deps.giveBack(finalized);
    throw e;
  }
  try {
    await deps.submit(finalized);
  } catch (e) {
    if ((e as { code?: number }).code === codes.TX_REJECTED) {
      deps.journal.write(deps.journal.read().filter((p) => !sameEntry(entry)(p)));
      throw e;
    }
    if (!(e instanceof SubmitPending)) throw e; // CANCELLED or an uncertain failure: the journal stays
  }
  return { waitUntil: entry.ttl, sent: true };
}

/** Reads the state, tolerating transient failures (indexer down, stale state) while waiting. */
async function readTolerant(order: Order, deps: Deps, waiting: boolean): Promise<Seen> {
  for (let failures = 0; ; failures++) {
    try {
      return await deps.read(order);
    } catch (e) {
      const transient = [codes.UPSTREAM_UNAVAILABLE, codes.STALE_STATE].includes((e as { code?: number }).code as never);
      if (!waiting || !transient || failures + 1 >= MAX_READ_FAILURES) throw e;
      await deps.wait(POLL_MS * (failures + 1));
    }
  }
}

/** The purchase with journal and wait; see the comment at the top. */
export async function purchase(order: Order, deps: Deps): Promise<WalletBuyBonoResult> {
  let bought = 0;
  let waiting = false;
  for (;;) {
    const seen = await readTolerant(order, deps, waiting);
    const step = await deps.exclusive(async () => {
      const next = decide(order, seen, deps, bought);
      return next === 'buy' ? buyOnce(order, deps) : next;
    });
    if ('done' in step) return step.done;
    if (step.sent) bought++;
    if (!waiting) deps.notify('waiting-inclusion', { expiresAt: step.waitUntil });
    waiting = true;
    await deps.wait(POLL_MS);
  }
}

export async function buyBono(wallet: OpenWallet, init: InitializeParams, params: unknown, context: HandlerContext): Promise<WalletBuyBonoResult> {
  const deps = realDeps(wallet, init, context);
  try {
    return await purchase(orderOf(params), deps);
  } catch (e) {
    // Closing the wallet also aborts the reads and the proof (AbortError from the SDK or fetch): treat it as a cancellation.
    if (deps.signal.aborted && !(e instanceof AppError)) throw cancelled();
    throw e;
  }
}
