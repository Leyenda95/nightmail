// Protocol error codes. Keep in sync with apps/desktop/src-tauri/src/protocol.rs
// and packages/test-vectors/rpc/error-codes.json.
export const codes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** Internal error with a fixed message: the detail never crosses the boundary. */
  APP_INTERNAL: -32000,
  NOT_INITIALIZED: -32001,
  PROTOCOL_MISMATCH: -32002,
  INVALID_CONFIG: -32003,
  CANCELLED: -32004,
  /** contract.snapshot: no NightMailRegistry at that address (`Contract not found`). */
  CONTRACT_NOT_FOUND: -32005,
  /** The indexer does not answer: network, timeout, 5xx or GraphQL errors (`Indexer unavailable`). Retryable. */
  UPSTREAM_UNAVAILABLE: -32006,
  /** contract.snapshot: the sidecar no longer holds the cursor's state (`Snapshot expired`). Start over. */
  SNAPSHOT_EXPIRED: -32007,
  /** Mailbox name rejected (`Name rejected`); `data.reason` is invalid | alias-form | reserved. */
  NAME_REJECTED: -32008,
  /** contract.proveCall: the circuit failed locally on a contract check (`Call rejected`); reason in `data.reason`. */
  CALL_REJECTED: -32009,
  /**
   * contract.proveCall (and contract.findBonos with minLeafCount): the state served by the indexer is unusable
   * (`Stale chain state`). `data` is StaleStateData: { reason: old | future | behind, ageMs, leafCount? }.
   * `old` and `behind` can be retried; `future` cannot (the machine clock is wrong).
   */
  STALE_STATE: -32010,
  /** contract.proveCall: the local proof server does not answer: network, timeout, 429 or 5xx (`Proof server unavailable`). Retryable. */
  PROVER_UNAVAILABLE: -32011,
  /**
   * contract.proveCall: the on-chain verifier key of the circuit differs from the app's (`Contract version
   * mismatch`), in either direction.
   */
  CONTRACT_MISMATCH: -32012,
  /** wallet.*: the wallet cannot be used (`Wallet unavailable`); `data.reason` is not-open | already-open | in-use | not-synced. */
  WALLET_UNAVAILABLE: -32013,
  /** wallet.*: not enough token or DUST to pay (`Insufficient funds`); `data.asset` is token | dust. */
  INSUFFICIENT_FUNDS: -32014,
  /** wallet.*: the node rejected the transaction on receipt (`Transaction rejected`), so it certainly did not land. Retryable. */
  TX_REJECTED: -32015,
} as const;

/** Error with a code, a fixed public message and, if needed, structured data (never sensitive). */
export class AppError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, publicMessage: string, data?: unknown) {
    super(publicMessage);
    this.code = code;
    this.data = data;
  }
}
