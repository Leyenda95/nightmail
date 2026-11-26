// Filler bonos for the demo (so the registry collections are not nearly empty): the id of each one and what to do
// with each reply from the payer's `POST /issue` (apps/server/src/payer/api.ts). Side-effect free.
import { createHmac } from "node:crypto";
import type { PayerReply } from "../../../apps/server/src/payer/client.ts";
import type { IssuePlan } from "../../../apps/server/src/payer/journal.ts";
import type { IssueResult, PayerError } from "../../../apps/server/src/payer/payer.ts";

export type { IssuePlan };

/**
 * Id of filler bono number `index` (0-based) of a plan. Derived from an operator key so a run can resume without
 * duplicates: the same index always gives the same id and the payer answers `already-issued`. The key hides nothing:
 * filler leaves are recognisable anyway (issued by the operator, back to back, before there are users). They make the
 * tree look bigger but do not grow the real anonymity set, which is why they are disclosed.
 * Nobody knows a secret that can spend them.
 */
export function bonoId(key: Uint8Array, plan: IssuePlan, index: number): string {
  return createHmac("sha256", key).update(`nightmail/demo-seed/v1/${plan}/${index}`).digest("hex");
}

export type Step =
  /** The bono exists (`already`: it was there before). */
  | { kind: "done"; already: boolean }
  /** An issuance of this id was sent with no known outcome yet; check again after `retryAfterS`. */
  | { kind: "pending"; retryAfterS: number }
  /** Not issued (may have cost DUST); can be retried later. */
  | { kind: "failed"; reason: string }
  /** Retry the same id in `seconds`. */
  | { kind: "wait"; seconds: number; reason: string }
  /** No point in continuing. */
  | { kind: "abort"; reason: string };

const wait = (seconds: number, reason: string): Step => ({ kind: "wait", seconds, reason });
const abort = (reason: string): Step => ({ kind: "abort", reason });

type ErrorBody = { error: string; retryAfterS?: number; transient?: boolean };

/** What to do with each `/issue` error (anything else aborts). */
const ON_ERROR: Record<string, (e: ErrorBody) => Step> = {
  "dust-cap": (e) => wait(e.retryAfterS ?? 60, "hourly DUST cap for issuances"),
  "indexer-behind": (e) => wait(e.retryAfterS ?? 30, "the indexer is behind"),
  "dust-unavailable": (e) =>
    e.transient
      ? wait(e.retryAfterS ?? 60, "DUST held by a recent send")
      : abort("The payer has no spendable DUST (check its log)."),
  "queue-full": () => wait(30, "the payer queue is full"),
  internal: () => wait(60, "internal payer failure"),
  "id-conflict": () => ({ kind: "failed", reason: "id-conflict" }),
  "not-ready": () => abort("The payer is still syncing its wallet."),
  "no-contract": () => abort("There is no registry deployed on this network."),
  "fee-over-cap": () =>
    abort("The fee of one issuance exceeds the hourly cap: raise NIGHTMAIL_PAYER_ISSUE_DUST_PER_HOUR."),
  stopping: () => abort("The payer is stopping."),
};

export function issueStep({ status, body }: PayerReply<IssueResult>): Step {
  if (status === 200 && "status" in body) {
    switch (body.status) {
      case "issued":
        return { kind: "done", already: false };
      case "already-issued":
        return { kind: "done", already: true };
      case "pending":
        return { kind: "pending", retryAfterS: body.retryAfterS };
      case "failed":
        return { kind: "failed", reason: body.reason };
    }
  }
  const error: ErrorBody = "error" in body ? (body as PayerError) : { error: "?" };
  return Object.hasOwn(ON_ERROR, error.error)
    ? ON_ERROR[error.error]!(error)
    : abort(`Unexpected payer reply: HTTP ${status} (${error.error}).`);
}
