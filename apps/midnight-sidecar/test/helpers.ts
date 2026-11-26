// Helpers for the contract.findBonos and contract.proveCall tests: already initialized handlers and a
// fake chain behind net.ts (indexer with the state of a simulator contract, and proof server).
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ContractOperation, type ContractState } from '@midnight-ntwrk/compact-runtime';
import { LedgerParameters, ZswapChainState } from '@midnightntwrk/ledger-v9';
import { REGISTRY_DIR } from '@nightmail/midnight';
import { createHandlers } from '../src/handlers.ts';
import { setFetchForTests } from '../src/net.ts';
import { AppError } from '../src/codes.ts';

const vectors = new URL('../../../packages/test-vectors/', import.meta.url);
export const json = (path: string) => JSON.parse(readFileSync(new URL(path, vectors), 'utf8'));
export const ADDRESS = 'ad'.repeat(32);
export const INDEXER: string = json('rpc/initialize.json').endpoints.indexer;
export const PROOF_SERVER: string = json('rpc/initialize.json').endpoints.proofServer;
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');

export type Notification = { method: string; params: unknown };

/** Request context: signal, id and the notifications the handler sends (in `sent`). */
export function ctx(signal = new AbortController().signal, sent: Notification[] = []) {
  return { signal, requestId: 7, notify: (method: string, params: unknown) => { sent.push({ method, params }); } };
}

export async function ready() {
  const h = createHandlers({ initialized: null });
  await h.initialize(json('rpc/initialize.json'), ctx());
  return h;
}

/** Error the promise rejects with (fails if it does not reject). */
export async function failure(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  assert.fail('an error was expected');
}

/** Code, message and data of the AppError the promise rejects with. */
export async function appError(p: Promise<unknown>): Promise<{ code: number; message: string; data?: unknown }> {
  const e = await failure(p);
  assert.ok(e instanceof AppError, `AppError expected: ${e?.stack ?? e}`);
  return e.data === undefined ? { code: e.code, message: e.message } : { code: e.code, message: e.message, data: e.data };
}

export const hashAt = (h: number) => h.toString(16).padStart(64, '0');

export type FakeChain = {
  /** Contract state in hex, as the indexer serves it; null: no contract at that address. */
  state: string | null;
  tip?: number;
  /** Time of the latest block (Unix milliseconds). Defaults to now. */
  timestamp?: number;
  ledgerParameters?: string;
  zswapState?: string;
  /** Fake proof server: receives the path (`/check`, `/prove`) and the request. Without it, there is no connection. */
  prover?: (path: string, init: RequestInit) => Promise<Response> | Response;
};

export type FakeRequest = { url: string; init: RequestInit };

/** Installs the fake chain in net.ts and returns the requests it receives. */
export function fakeChain(chain: FakeChain): FakeRequest[] {
  const requests: FakeRequest[] = [];
  const tip = chain.tip ?? 100;
  setFetchForTests(async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.startsWith(PROOF_SERVER)) {
      if (!chain.prover) throw new TypeError('fetch failed');
      return chain.prover(url.slice(PROOF_SERVER.length), init);
    }
    assert.equal(url, INDEXER, 'only the configured indexer and proof server are contacted');
    const { variables } = JSON.parse(String(init.body));
    if (!variables.offset) return Response.json({ data: { block: { height: tip } } });
    const block = {
      height: variables.offset.height, hash: hashAt(variables.offset.height), timestamp: chain.timestamp ?? Date.now(),
      ledgerParameters: chain.ledgerParameters ?? LEDGER_PARAMETERS,
      contractZswapState: chain.state === null ? null : chain.zswapState ?? ZSWAP_STATE,
    };
    return Response.json({ data: { block, contract: chain.state === null ? null : { state: chain.state } } });
  });
  return requests;
}

// --- contract.proveCall ---------------------------------------------------------------------------

export const PROVABLE = ['createAlias', 'reserveMailbox', 'revealMailbox'] as const;
export type Provable = (typeof PROVABLE)[number];

/**
 * State (hex) of a simulator contract as if it were deployed. The simulator builds it without verifier
 * keys (--skip-zk); a deployed contract carries them and midnight-js requires them to build the call, so
 * those of the circuits the sidecar proves are added.
 */
export function deployedState(state: ContractState): string {
  for (const circuit of PROVABLE) {
    const op = new ContractOperation();
    op.verifierKey = readFileSync(new URL(`keys/${circuit}.verifier`, `file://${REGISTRY_DIR}`));
    state.setOperation(circuit, op);
  }
  return toHex(state.serialize());
}

/** Initial ledger parameters and an empty Zswap state, in hex as the indexer serves them. */
export const LEDGER_PARAMETERS = toHex(LedgerParameters.initialParameters().serialize());
export const ZSWAP_STATE = toHex(new ZswapChainState().serialize());

// Real answers from proof server 9.0.2 (/check and /prove) to one call of each circuit. The client
// does not verify the proof (the node does), so they serve for any call of the same circuit:
// the tests check everything except proof validity, which the devnet test covers.
// To re-record them (with the local proof server running):
const FIXTURE = new URL('./fixtures/proof-server.json', import.meta.url);
type Recorded = Record<string, Record<string, string>>;
const recorded: Recorded = existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, 'utf8')) : {};
const RECORDING = process.env.NIGHTMAIL_RECORD_PROOFS === '1';

/** Fake proof server that replies with what was recorded for that circuit. */
export function replayProver(circuit: Provable): NonNullable<FakeChain['prover']> {
  return async (path, init) => {
    if (RECORDING) {
      const res = await fetch(`http://127.0.0.1:6300${path}`, { method: 'POST', body: init.body, headers: init.headers });
      assert.ok(res.ok, `proof server: HTTP ${res.status}`);
      (recorded[circuit] ??= {})[path] = toHex(new Uint8Array(await res.arrayBuffer()));
      writeFileSync(FIXTURE, JSON.stringify(recorded, null, 1) + '\n');
    }
    const answer = recorded[circuit]?.[path];
    assert.ok(answer, `no recorded answer from ${path} for ${circuit}`);
    return new Response(Buffer.from(answer, 'hex'));
  };
}
