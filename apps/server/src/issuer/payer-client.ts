// Adapts the raw payer client (payer/client.ts: HTTP status + body) to what the Issuer and RoundTicker need:
// a closed set of outcomes and no exceptions.
//
// Only `issued` and `already-issued` mean the `bono` exists. Everything else is retried with the same id
// (the payer is idempotent) or treated as failed; a dropped connection is "unknown", never "not sent".
//
// `issue` has two kinds of "later": `pending` concerns that id (200 pending: an issue for it is in flight);
// `unavailable` concerns the whole payer (429 dust-cap, 503, 500, connection drop) and makes the Issuer pause
// its entire queue, because the payer builds and proves the call before checking its cap, so every attempt
// costs a proof.
import type { IssuePlan } from '../payer/journal.ts';
import type { Logger } from '../log.ts';

export type { IssuePlan };

export type IssueOutcome =
  | { status: 'issued' | 'already-issued' }
  /** The id has an issue with unknown outcome: retry later with the same id. */
  | { status: 'pending'; retryAfterS?: number }
  /** The payer is not serving right now (fixed code in `reason`): pause the whole queue. */
  | { status: 'unavailable'; reason: string; retryAfterS?: number }
  /** Not issued; `reason` is a fixed payer code (or `id-conflict`, `fee-over-cap`, `http-<status>`). */
  | { status: 'failed'; reason: string };

export type AdvanceOutcome =
  | { status: 'advanced'; round: number | null }
  /** May have been paid and sent (drop, 5xx, timeout), so it is not treated as "did not advance". `validUntil`: Unix ms. */
  | { status: 'unknown'; validUntil?: number }
  | { status: 'failed' };

export type PayerClient = {
  issue(id: string, plan: IssuePlan): Promise<IssueOutcome>;
  advanceRound(): Promise<AdvanceOutcome>;
};

type Reply = { status: number; body: unknown };
/** The subset of the raw client used here (satisfied by `payerClient(...)` from payer/client.ts). */
export type RawPayer = {
  issue(id: string, plan: IssuePlan): Promise<Reply>;
  advanceRound(): Promise<Reply>;
};

const CODE_RE = /^[a-z0-9-]{1,40}$/;

const field = (body: unknown, name: string): unknown =>
  body !== null && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined;

const retryAfterOf = (body: unknown): { retryAfterS?: number } => {
  const value = field(body, 'retryAfterS');
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? { retryAfterS: value } : {};
};

/** The payer's fixed error code, or `http-<status>` if the body has nothing shaped like one. */
function errorCode({ status, body }: Reply): string {
  const error = field(body, 'error');
  return typeof error === 'string' && CODE_RE.test(error) ? error : `http-${status}`;
}

function okOutcome(body: unknown): IssueOutcome {
  const state = field(body, 'status');
  const reason = field(body, 'reason');
  if (state === 'issued' || state === 'already-issued') return { status: state };
  if (state === 'failed' && typeof reason === 'string') return { status: 'failed', reason };
  return { status: 'pending', ...retryAfterOf(body) }; // pending or unrecognized: retry the same id later
}

/** Errors retrying won't fix: any 4xx other than 429, or a missing registry. */
const isPermanent = (status: number, code: string) => (status >= 400 && status < 500 && status !== 429) || code === 'no-contract';

/** `issue` outcome mapping that warns the operator once per permanent code (they indicate config or version problems). */
function issueOutcomes(log: Logger): (reply: Reply) => IssueOutcome {
  const warned = new Set<string>();
  return (reply) => {
    if (reply.status === 200) return okOutcome(reply.body);
    const code = errorCode(reply);
    if (code === 'fee-over-cap' || reply.status === 409) return failedWith(code === 'fee-over-cap' ? code : 'id-conflict', log);
    if (!isPermanent(reply.status, code)) return { status: 'unavailable', reason: code, ...retryAfterOf(reply.body) };
    if (!warned.has(code)) {
      warned.add(code);
      log.warn(`issuer: the payer answered ${code}; marking the request failed (check the payer version and configuration)`);
    }
    return { status: 'failed', reason: code };
  };
}

function failedWith(reason: 'fee-over-cap' | 'id-conflict', log: Logger): IssueOutcome {
  if (reason === 'fee-over-cap') log.warn('issuer: the payer will never pay this issue with its current DUST cap; the operator must raise it');
  return { status: 'failed', reason };
}

function advanceOutcome({ status, body }: Reply): AdvanceOutcome {
  if (status !== 200) return { status: 'unknown' }; // a 5xx doesn't guarantee nothing was paid
  const state = field(body, 'status');
  if (state === 'advanced') {
    const round = field(body, 'round');
    return { status: 'advanced', round: typeof round === 'number' ? round : null };
  }
  if (state === 'failed') return { status: 'failed' };
  const validUntil = field(body, 'validUntil');
  return { status: 'unknown', ...(typeof validUntil === 'number' && Number.isFinite(validUntil) && { validUntil }) };
}

export function adaptPayer(raw: RawPayer, log: Logger): PayerClient {
  const issueOutcome = issueOutcomes(log);
  return {
    async issue(id, plan) {
      try {
        return issueOutcome(await raw.issue(id, plan));
      } catch {
        return { status: 'unavailable', reason: 'unreachable' }; // the Issuer logs the pause
      }
    },
    async advanceRound() {
      try {
        return advanceOutcome(await raw.advanceRound());
      } catch {
        return { status: 'unknown' };
      }
    },
  };
}
