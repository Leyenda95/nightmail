// Client for the local proof server: proves an already built transaction.
//
// midnight-js's `httpClientProofProvider` is not used: it issues its requests with `cross-fetch` (bypassing
// net.ts), follows redirects, retries on its own and cannot be cancelled. Here every request goes through
// net.ts to the origin validated in `initialize`, with `redirect: 'error'` (a local service must not be able
// to redirect the witnesses elsewhere) and with the signal of the JSON-RPC request.
//
// The proof server receives the witnesses in the clear (the bono secret), which is why it can only be local.
import { ZKConfigRegistry, zkConfigToProvingKeyMaterial, type ZKConfigProvider } from '@midnight-ntwrk/midnight-js-types';
import {
  CostModel, createCheckPayload, createProvingPayload, parseCheckResult, type ProvingProvider, type UnprovenTransaction,
} from '@midnightntwrk/ledger-v9';
import { readBodyCapped } from '@nightmail/midnight';
import { AppError, codes } from './codes.ts';
import { net } from './net.ts';

/** Maximum time for one proof server request (midnight-js's value). A proof takes seconds. */
export const PROVE_TIMEOUT_MS = 5 * 60_000;
/** Cap on a proof server response (a proof is a few KB): anything larger is not read. */
export const MAX_PROVER_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Where the proof server is and how to talk to it within one JSON-RPC request. */
export type ProverLink = {
  /** Origin validated in `initialize` (`http://127.0.0.1:6300`). */
  origin: string;
  /** Aborted if the core cancels the request. */
  signal: AbortSignal;
  /** Debug log: never receives anything from the call (no witnesses, no bodies). */
  log: (message: string) => void;
};

/** PROVER_UNAVAILABLE; the cause (HTTP status or network error type) goes only to the debug log. */
function unavailable(link: ProverLink, why: string): AppError {
  link.log(`proof server unavailable: ${why}`);
  return new AppError(codes.PROVER_UNAVAILABLE, 'Proof server unavailable');
}

/** Type of a network error, without its message: `TypeError ECONNREFUSED`, `TimeoutError`... */
function kindOf(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown';
  const code = (error.cause as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? `${error.name} ${code}` : error.name;
}

/**
 * Binary POST to the proof server. Network errors, timeouts, 429 and 5xx map to PROVER_UNAVAILABLE (retryable);
 * any other error response, or an oversized one, is an internal failure. If the core cancels, the cancellation
 * error is rethrown as is. The payload carries the witnesses, so it is zeroed afterwards (fetch copies the body
 * when called, so wiping it later does not affect what was sent).
 */
async function post(link: ProverLink, path: string, payload: Uint8Array): Promise<Uint8Array> {
  const { signal } = link;
  try {
    const res = await net.fetch(`${link.origin}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      // The payload is a plain JS Uint8Array (not a view over wasm memory), so it can be sent as is.
      body: payload as Uint8Array<ArrayBuffer>,
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(PROVE_TIMEOUT_MS)]),
    });
    if (res.status >= 500 || res.status === 429) throw unavailable(link, `HTTP ${res.status}`);
    if (!res.ok) throw new ProofServerError(`proof server: HTTP ${res.status}`);
    const answer = await readBodyCapped(res, MAX_PROVER_RESPONSE_BYTES);
    if (answer === undefined) throw new ProofServerError('proof server: response too large');
    return new Uint8Array(answer);
  } catch (e) {
    if (signal.aborted || e instanceof AppError || e instanceof ProofServerError) throw e;
    throw unavailable(link, kindOf(e));
  } finally {
    payload.fill(0);
  }
}

/** Runs `run` with the preimage (it holds the private inputs) and zeroes it afterwards. */
async function wiping<R>(preimage: Uint8Array, run: () => Promise<R>): Promise<R> {
  try {
    return await run();
  } finally {
    preimage.fill(0);
  }
}

/** The proof server answered with an error that is not about availability (e.g. 400): internal failure. */
class ProofServerError extends Error {}

/**
 * Proves the transaction on the proof server and returns it serialised: proven but unbalanced. `zk` supplies
 * the contract's keys (the ledger's own circuits are provided by the proof server).
 */
export async function proveTransaction(unproven: UnprovenTransaction, zk: ZKConfigProvider<string>, link: ProverLink): Promise<Uint8Array> {
  const registry = new ZKConfigRegistry([zk]);
  // The ledger (wasm) keeps only the text of a provider error, so the original is stored here and
  // rethrown unchanged (PROVER_UNAVAILABLE, cancellation...).
  const failed: { error?: unknown } = {};
  const keep = <A extends unknown[], R>(run: (...args: A) => Promise<R>) => async (...args: A): Promise<R> => {
    try {
      return await run(...args);
    } catch (e) {
      if (!('error' in failed)) failed.error = e;
      throw e;
    }
  };
  const lookupKey = keep(async (location: string) => {
    const config = await registry.resolveKeyLocation(location);
    return config === undefined ? undefined : zkConfigToProvingKeyMaterial(config);
  });
  const provider: ProvingProvider = {
    lookupKey,
    // The preimage is a fresh JS copy per call that wasm does not reuse, so wipe it when done.
    check: keep(async (preimage, location) => wiping(preimage, async () =>
      parseCheckResult(await post(link, '/check', createCheckPayload(preimage, (await lookupKey(location))?.ir))))),
    prove: keep(async (preimage, location, overwriteBindingInput) => wiping(preimage, async () =>
      post(link, '/prove', createProvingPayload(preimage, overwriteBindingInput, await lookupKey(location))))),
  };
  try {
    return (await unproven.prove(provider, CostModel.initialCostModel())).serialize();
  } catch (e) {
    throw 'error' in failed ? failed.error : e;
  }
}
