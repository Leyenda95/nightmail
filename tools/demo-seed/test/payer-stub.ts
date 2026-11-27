// The real payer local API (apps/server/src/payer/api.ts) on a temporary Unix socket, backed by a fake payer
// (`PayerOps`), so these tests notice any change to the API contract or its types.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startPayerApi, type PayerApi, type PayerOps } from "../../../apps/server/src/payer/api.ts";
import type { Health, IssueResult, PayerError } from "../../../apps/server/src/payer/payer.ts";

/** What the payer answers, or "cut": the connection drops without a reply. */
export type Answer<T> = T | PayerError | "cut";

export interface StubPayer {
  /** Test operator data folder (0700) holding the socket and the key. */
  dir: string;
  socket: string;
  issues: { id: string; plan: string }[];
  /** false: the wallet is still syncing (the API answers `{ ready: false }` and `503 not-ready`). */
  ready: boolean;
  health: Health;
  /** Reply to each `/issue`; by default it issues and remembers (repeating an id gives `already-issued`). */
  issue: (id: string, plan: string, n: number) => Answer<IssueResult>;
  close(): Promise<void>;
}

export const READY: Health = {
  ready: true,
  dustCoins: 5,
  dustBalance: 1n,
  queueLength: 0,
  lostFees: { count: 0, dust: 0n, byCause: {} },
  dustSpentLastHour: { relay: 0n, issue: 0n },
  dustCapPerHour: { relay: 100n, issue: 50n },
  issuesInFlight: 0,
  earlyAnswersWrong: 0,
  earlyAnswersUnconfirmed: 0,
  contract: "0a73",
};

export async function startStubPayer(): Promise<StubPayer> {
  const dir = mkdtempSync(path.join(tmpdir(), "demo-seed-"));
  const issued = new Set<string>();
  let api: PayerApi;
  /** Drops all connections (and stops listening) without replying. */
  const answer = <T>(value: Answer<T>): Promise<T | PayerError> =>
    value === "cut" ? (void api.close(), new Promise<never>(() => {})) : Promise.resolve(value);
  const stub: StubPayer = {
    dir,
    socket: path.join(dir, "payer.sock"),
    issues: [],
    ready: true,
    health: READY,
    issue: (id, plan) => {
      const key = `${plan}:${id}`;
      if (issued.has(key)) return { status: "already-issued" };
      issued.add(key);
      return { status: "issued", txHash: "ab" };
    },
    close: async () => {
      await api.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  const ops: PayerOps = {
    health: () => stub.health,
    relay: () => Promise.resolve({ error: "internal" }),
    issue: (id, plan) => {
      stub.issues.push({ id, plan });
      return answer(stub.issue(id, plan, stub.issues.length));
    },
  };
  const log = { info: () => {}, warn: () => {} };
  api = await startPayerApi({ socketPath: stub.socket, payer: () => (stub.ready ? ops : undefined), log });
  return stub;
}
