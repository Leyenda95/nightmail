import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PayerReply } from "../../../apps/server/src/payer/client.ts";
import type { IssueResult } from "../../../apps/server/src/payer/payer.ts";
import { bonoId, issueStep, type Step } from "../src/bonos.ts";

describe("bonoId", () => {
  const key = Buffer.alloc(32, 1);

  it("is pinned: if it changed, repeating the seeding would issue new bonos instead of resuming", () => {
    // HMAC-SHA256 computed independently with `openssl dgst -sha256 -mac HMAC` over "nightmail/demo-seed/v1/free/0".
    assert.equal(bonoId(key, "free", 0), "032fd73b09326ad9d6fa8f753f0a328fd79f7e7f4d66da5485c96a44a6a5f899");
  });

  it("changes with the plan, the number and the key", () => {
    const ids = new Set([bonoId(key, "free", 0), bonoId(key, "paid", 0), bonoId(key, "free", 1), bonoId(Buffer.alloc(32, 2), "free", 0)]);
    assert.equal(ids.size, 4);
  });
});

describe("issueStep", () => {
  // Replies exactly as the payer API sends them (HTTP status from payer/api.ts, body from payer.ts / api.ts).
  const cases: [string, PayerReply<IssueResult>, Step["kind"], RegExp?][] = [
    ["issued", { status: 200, body: { status: "issued", txHash: "ab" } }, "done"],
    ["already-issued", { status: 200, body: { status: "already-issued" } }, "done"],
    ["pending", { status: 200, body: { status: "pending", txHash: "ab", retryAfterS: 90 } }, "pending"],
    ["failed", { status: 200, body: { status: "failed", reason: "fee-lost", txHash: "ab" } }, "failed", /fee-lost/],
    ["transient dust-unavailable", { status: 503, body: { error: "dust-unavailable", transient: true, retryAfterS: 45 } }, "wait", /held/],
    ["dust-unavailable without DUST", { status: 503, body: { error: "dust-unavailable", transient: false, retryAfterS: 45 } }, "abort", /no spendable DUST/],
    ["queue-full", { status: 503, body: { error: "queue-full" } }, "wait", /queue/],
    ["internal", { status: 500, body: { error: "internal" } }, "wait", /internal payer failure/],
    ["id-conflict", { status: 409, body: { error: "id-conflict" } }, "failed", /id-conflict/],
    ["not-ready", { status: 503, body: { error: "not-ready" } }, "abort", /syncing/],
    ["no-contract", { status: 503, body: { error: "no-contract" } }, "abort", /no registry deployed/],
    ["stopping", { status: 503, body: { error: "stopping" } }, "abort", /stopping/],
    ["dust-cap", { status: 429, body: { error: "dust-cap", retryAfterS: 120 } }, "wait", /hourly DUST cap/],
    ["indexer-behind", { status: 503, body: { error: "indexer-behind", retryAfterS: 30 } }, "wait", /indexer is behind/],
    ["fee-over-cap", { status: 422, body: { error: "fee-over-cap" } }, "abort", /NIGHTMAIL_PAYER_ISSUE_DUST_PER_HOUR/],
    ["bad-request", { status: 400, body: { error: "bad-request" } }, "abort", /HTTP 400 \(bad-request\)/],
  ];
  for (const [name, reply, kind, reason] of cases) {
    it(`${name} → ${kind}`, () => {
      const step = issueStep(reply);
      assert.equal(step.kind, kind);
      if (reason) assert.match("reason" in step ? step.reason : "", reason);
    });
  }

  it("waits use what the payer says, or a fixed value if it says nothing", () => {
    assert.deepEqual(issueStep(cases[4]![1]), { kind: "wait", seconds: 45, reason: "DUST held by a recent send" });
    assert.deepEqual(issueStep(cases[12]![1]), { kind: "wait", seconds: 120, reason: "hourly DUST cap for issuances" });
    assert.deepEqual(issueStep(cases[6]![1]), { kind: "wait", seconds: 30, reason: "the payer queue is full" });
    assert.deepEqual(issueStep(cases[1]![1]), { kind: "done", already: true });
    assert.deepEqual(issueStep(cases[2]![1]), { kind: "pending", retryAfterS: 90 });
  });
});
