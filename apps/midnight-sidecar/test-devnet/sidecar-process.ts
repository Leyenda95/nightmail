// The sidecar as a process, as the core launches it: a minimal JSON-RPC client over stdio for the devnet tests
// (prove.devnet.ts) and the server's end-to-end test (apps/server/test-e2e/flow.e2e.ts).
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const init = JSON.parse(readFileSync(new URL('../../../packages/test-vectors/rpc/initialize.json', import.meta.url), 'utf8'));

export type RpcError = { code: number; message: string; data?: unknown };
export type Notification = { method: string; params: any };

export const UPSTREAM_UNAVAILABLE = -32006;
export const CALL_REJECTED = -32009;
export const STALE_STATE = -32010;
export const PROVER_UNAVAILABLE = -32011;
/** Not part of the protocol: this client sets it on whatever awaited a reply when the sidecar exits. */
export const SIDECAR_EXITED = -1;
const exitedError = (code: number | null): RpcError => ({ code: SIDECAR_EXITED, message: `sidecar exited (${code})` });

export class Sidecar {
  readonly notifications: Notification[] = [];
  /** Called with each notification that arrives (to cancel at a specific stage). */
  onNotification: (n: Notification) => void = () => {};
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: RpcError) => void }>();
  private readonly exited: Promise<number | null>;
  private gone = false;
  private nextId = 1;
  private buffer = '';

  constructor() {
    this.child = spawn(process.execPath, ['src/index.ts'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.setEncoding('utf8').on('data', (c: string) => process.stderr.write(c.replace(/^(?=.)/gm, '  [sidecar] ')));
    this.child.stdout.setEncoding('utf8').on('data', (c: string) => this.read(c));
    // If the sidecar dies, whatever awaited a reply (and anything requested afterwards) fails instead of hanging
    // the test until its deadline. `close` rather than `exit`: it fires once everything written before exiting was read.
    this.exited = new Promise((resolve) => this.child.on('close', (code) => {
      this.gone = true;
      for (const waiting of this.pending.values()) waiting.reject(exitedError(code));
      this.pending.clear();
      resolve(code);
    }));
  }

  /** Launches the sidecar and runs `initialize` (in debug mode: its stderr warnings are visible). */
  static async start(): Promise<{ sidecar: Sidecar; methods: string[] }> {
    const sidecar = new Sidecar();
    try {
      const hello = await sidecar.call('initialize', { ...init, debug: true });
      return { sidecar, methods: hello.methods };
    } catch (e) {
      await sidecar.close(); // otherwise the process is orphaned and the test never ends
      throw e;
    }
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    for (let nl = this.buffer.indexOf('\n'); nl >= 0; nl = this.buffer.indexOf('\n')) {
      const msg = JSON.parse(this.buffer.slice(0, nl));
      this.buffer = this.buffer.slice(nl + 1);
      if (msg.id === undefined) {
        this.notifications.push(msg);
        this.onNotification(msg);
        continue;
      }
      const waiting = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) waiting?.reject(msg.error);
      else waiting?.resolve(msg.result);
    }
  }

  private write(msg: object): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  }

  /** Sends the request; `id` is the one it carries (to cancel it) and `result` is its reply. */
  request<T = any>(method: string, params: unknown): { id: number; result: Promise<T> } {
    const id = this.nextId++;
    // Writing to the input of a process that already exited does not throw: the reply would never arrive.
    if (this.gone) return { id, result: Promise.reject(exitedError(this.child.exitCode)) };
    const result = new Promise<T>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.write({ id, method, params });
    return { id, result };
  }

  call<T = any>(method: string, params: unknown): Promise<T> {
    return this.request<T>(method, params).result;
  }

  cancel(id: number): void {
    this.write({ method: '$/cancel', params: { id } });
  }

  /** The progress stages announced by request `id`. */
  stagesOf(id: number): string[] {
    return this.notifications.filter((n) => n.method === 'progress' && n.params.requestId === id).map((n) => n.params.stage);
  }

  /** Closes the input and waits for the process to exit (0 = clean exit); also valid if it already exited. */
  async close(): Promise<number | null> {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.stdin.end();
    return this.exited;
  }
}

/** The JSON-RPC error the promise fails with (fails the test if it does not fail). */
export const rpcError = (p: Promise<unknown>): Promise<RpcError> => p.then(() => assert.fail('an error was expected'), (e) => e);

export const seconds = (ms: number) => `${(ms / 1000).toFixed(1).padStart(5)} s`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A transient read failure: the indexer does not answer (sidecar) or the HTTP connection failed. */
const isTransient = (e: unknown) =>
  (e as RpcError)?.code === UPSTREAM_UNAVAILABLE || (e instanceof TypeError && e.message === 'fetch failed');

/**
 * Repeats the query until the expectation holds (the indexer runs a few blocks behind). A transient failure
 * counts as "not yet"; any other error is rethrown as is.
 */
export async function eventually<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean, tries = 60, everyMs = 2000): Promise<T> {
  let lastTransient: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const value = await read();
      if (done(value)) return value;
    } catch (e) {
      if (!isTransient(e)) throw e;
      lastTransient = e;
    }
    await sleep(everyMs);
  }
  const cause = lastTransient === undefined ? '' : ` (last transient failure: ${JSON.stringify(lastTransient) ?? String(lastTransient)})`;
  assert.fail(`never showed up: ${what}${cause}`);
}

export type Proved = { tx: string; blockHeight: number; proveMs: number; stages: string[] };

/** proveCall errors that are fixed by asking for another: busy proof server or a state read that was too old. */
const RETRY_PROVE = new Set([PROVER_UNAVAILABLE, STALE_STATE]);

/**
 * `contract.proveCall`: the transaction, how long it took and the progress stages it announced. If the proof
 * server does not answer or the state was old (both retryable), it asks for another, as the core will; `onRetry` records it.
 */
export async function proveCall(sidecar: Sidecar, params: object, onRetry: (ms: number, code: number) => void = () => {}, attempts = 3): Promise<Proved> {
  const t0 = performance.now();
  const { id, result } = sidecar.request('contract.proveCall', params);
  try {
    const { tx, blockHeight } = await result;
    return { tx, blockHeight, proveMs: performance.now() - t0, stages: sidecar.stagesOf(id) };
  } catch (e) {
    const { code, data } = e as RpcError;
    // `future` (machine clock behind) is not fixed by retrying.
    const future = code === STALE_STATE && (data as { reason?: string } | undefined)?.reason === 'future';
    if (!RETRY_PROVE.has(code) || future || attempts <= 1) throw e;
    onRetry(performance.now() - t0, code);
    await sleep(3000);
    return proveCall(sidecar, params, onRetry, attempts - 1);
  }
}
