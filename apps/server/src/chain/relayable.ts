// Which client transactions the payer agrees to pay for: only contract calls that move no value.
// Why: when signing, the wallet adds its signature to every unshielded input that lacks one, regardless of
// whose it is (wallet-sdk-unshielded-wallet 2.x, `v2/TransactionOps.addSignaturesToOffer`). An unshielded
// offer spending the operator's NIGHT UTXOs (which are public) would walk away with that NIGHT. DUST
// actions and Zswap offers have no place in a client tx either (its circuits neither create nor spend
// coins). Which contract and circuit may be called is the public relayer's decision; this is only what
// the payer must never pay for.
// No SDK needed: it inspects the shape (fields) of a ledger-v9 transaction, so test doubles work too.

/** Why a transaction is not paid for. */
export type RelayProblem = 'unshielded-offer' | 'dust-actions' | 'zswap-offer' | 'no-call';

type IntentShape = { actions?: readonly unknown[]; guaranteedUnshieldedOffer?: unknown; fallibleUnshieldedOffer?: unknown; dustActions?: unknown };
type TxShape = { intents?: Map<number, IntentShape>; guaranteedOffer?: unknown; fallibleOffer?: Map<number, unknown> };

const hasZswapOffer = (tx: TxShape) => tx.guaranteedOffer !== undefined || (tx.fallibleOffer?.size ?? 0) > 0;
const hasCall = (i: IntentShape) => (i.actions?.length ?? 0) > 0;

/** What moves value inside an intent, or null. */
function intentProblem(i: IntentShape): RelayProblem | null {
  if (i.guaranteedUnshieldedOffer !== undefined || i.fallibleUnshieldedOffer !== undefined) return 'unshielded-offer';
  return i.dustActions === undefined ? null : 'dust-actions';
}

/** null if it can be paid for, otherwise the reason. `tx` is an unbalanced ledger-v9 `Transaction`. */
export function relayProblem(tx: TxShape): RelayProblem | null {
  if (hasZswapOffer(tx)) return 'zswap-offer';
  const intents = [...(tx.intents?.values() ?? [])];
  const moved = intents.map(intentProblem).find((p) => p !== null);
  if (moved) return moved;
  return intents.some(hasCall) ? null : 'no-call';
}
