// Which client transactions the public relayer accepts: exactly one call to our registry, to a user circuit,
// moving no value, with no fallible transcript and a ttl that leaves time to land in a block. The node checks
// the proof and execution against state: since everything is in the guaranteed part, a bad proof or a failing
// transcript is a mempool rejection with no fee (verified on devnet: test-devnet/payer.devnet.ts). Validating
// them here isn't possible with the SDK (`LedgerState.updateIndex` drops the verifier keys).
// No SDK: only the shape (fields) of the ledger-v9 `Transaction` is inspected, so test doubles work too.
import { relayProblem } from '../chain/relayable.ts';

/** Circuits a user calls through the relayer (the rest are operator-only or paid with tokens). */
export const RELAYABLE_CIRCUITS = ['registerMailbox', 'createAlias'] as const;

/**
 * Allowed intent ttl relative to now. The app sets "(time of the last read block + 30 min) rounded down to
 * 10 min", i.e. 20-30 min ahead (sidecar `callTtl`, whose test checks it always fits here). Under 10 min it may
 * expire in the queue (-> `unknown`, counted against the cap without a fee and freeing the slot); the app never
 * sets more than 35 min (5 min of clock slack).
 */
export const TTL_MIN_AHEAD_MS = 10 * 60_000;
export const TTL_MAX_AHEAD_MS = 35 * 60_000;

/** Why a transaction is not forwarded to the payer. */
export type RelayRefusal = 'not-one-call' | 'moves-value' | 'wrong-contract' | 'wrong-circuit' | 'fallible-transcript' | 'bad-ttl';

type CallShape = { address?: unknown; entryPoint?: unknown; fallibleTranscript?: unknown };
type IntentShape = { actions?: readonly unknown[]; ttl?: unknown } & Record<string, unknown>;
type TxShape = { intents?: Map<number, IntentShape>; rewards?: unknown } & Record<string, unknown>;

/** Circuit name; from bytes, only strict UTF-8 with any BOM kept, so malformed names never match an allowed one. */
function circuitName(entryPoint: unknown): unknown {
  if (!(entryPoint instanceof Uint8Array)) return entryPoint;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(entryPoint);
  } catch {
    return undefined;
  }
}

function onlyIntent(tx: TxShape): IntentShape | undefined {
  const intents = [...(tx.intents?.values() ?? [])];
  return intents.length === 1 ? intents[0] : undefined;
}

/** The transaction's only call, or undefined unless there is exactly one intent with one call. */
function onlyCall(tx: TxShape): CallShape | undefined {
  const actions = onlyIntent(tx)?.actions ?? [];
  const action = actions.length === 1 ? actions[0] as CallShape : undefined;
  return action && 'entryPoint' in action ? action : undefined; // deploys and maintenance updates have none
}

/** ttl of the only intent in Unix ms; undefined unless there is a single intent with a valid date. */
export function intentTtlMs(tx: TxShape): number | undefined {
  const ttl = onlyIntent(tx)?.ttl;
  const ms = ttl instanceof Date ? ttl.getTime() : Number.NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

function ttlFits(tx: TxShape, now: number): boolean {
  const ttl = intentTtlMs(tx);
  return ttl !== undefined && ttl >= now + TTL_MIN_AHEAD_MS && ttl <= now + TTL_MAX_AHEAD_MS;
}

function callProblem(call: CallShape, registry: string): RelayRefusal | null {
  if (call.address !== registry) return 'wrong-contract';
  if (!(RELAYABLE_CIRCUITS as readonly unknown[]).includes(circuitName(call.entryPoint))) return 'wrong-circuit';
  return call.fallibleTranscript === undefined ? null : 'fallible-transcript';
}

/** null if the transaction may be forwarded to the payer, else the reason. `registry`: our registry address (hex); `now`: Unix ms. */
export function checkRelayable(tx: TxShape, registry: string, now: number): RelayRefusal | null {
  if (tx.rewards !== undefined) return 'not-one-call';
  const moved = relayProblem(tx);
  if (moved && moved !== 'no-call') return 'moves-value';
  const call = onlyCall(tx);
  if (!call) return 'not-one-call';
  const problem = callProblem(call, registry);
  if (problem) return problem;
  return ttlFits(tx, now) ? null : 'bad-ttl';
}
