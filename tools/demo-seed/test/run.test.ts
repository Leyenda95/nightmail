import assert from "node:assert/strict";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { bonoId } from "../src/bonos.ts";
import { run } from "../src/run.ts";
import { READY, startStubPayer, type StubPayer } from "./payer-stub.ts";

let payer: StubPayer;
let out: string[];
let sleeps: number[];
beforeEach(async () => {
  payer = await startStubPayer();
  out = [];
  sleeps = [];
});
afterEach(() => payer.close());

/** As if run from the command line, with the operator data folder pointing at the test payer's. */
const seed = (...argv: string[]) =>
  run(argv, {
    out: (line) => out.push(line),
    sleep: async (ms) => void sleeps.push(ms),
    config: () => ({ network: "undeployed", dataDir: payer.dir }),
  });

describe("bonos", () => {
  it("issues the requested bonos of each plan, with distinct ids, and creates the 0600 key next to the socket", async () => {
    assert.equal(await seed("bonos", "--free", "2", "--paid", "1"), 0);
    assert.deepEqual(payer.issues.map((i) => i.plan), ["free", "free", "paid"]);
    assert.equal(new Set(payer.issues.map((i) => i.id)).size, 3);
    for (const { id } of payer.issues) assert.match(id, /^[0-9a-f]{64}$/);
    const keyFile = path.join(payer.dir, "demo-seed.key");
    assert.equal(readFileSync(keyFile).length, 32);
    assert.equal(statSync(keyFile).mode & 0o777, 0o600);
    assert.deepEqual(out.slice(1), [
      "ISSUED    free 1/2",
      "ISSUED    free 2/2",
      "ISSUED    paid 1/1",
      "Done: 3 issued, 0 already there, 0 pending, 0 failed.",
    ]);
    assert.equal(out[0], `Payer ready (network undeployed, socket ${payer.socket}): registry 0a73, 5 DUST coins.`);
  });

  it("repeating it with the same key requests the same ids and issues nothing new (it can be resumed)", async () => {
    await seed("bonos", "--free", "2", "--paid", "1");
    const first = payer.issues.splice(0);
    out = [];
    assert.equal(await seed("bonos", "--free", "3", "--paid", "1"), 0);
    assert.deepEqual(payer.issues.slice(0, 2), first.slice(0, 2));
    assert.deepEqual(payer.issues[3], first[2]);
    assert.equal(out.at(-1), "Done: 1 issued, 3 already there, 0 pending, 0 failed.");
  });

  it("--hasta N tops up to N in total: what was already issued with the key is counted without issuing it again", async () => {
    assert.equal(await seed("bonos", "--free", "2", "--paid", "1"), 0);
    const first = payer.issues.splice(0);
    out = [];
    assert.equal(await seed("bonos", "--hasta", "5"), 0);
    assert.deepEqual(payer.issues.map((i) => i.plan), ["free", "free", "free", "paid", "paid"]);
    assert.deepEqual([payer.issues[0], payer.issues[1], payer.issues[3]], first);
    assert.equal(out.at(-1), "Done: 2 issued, 3 already there, 0 pending, 0 failed.");
  });

  it("the ids come from the key: another key, other ids", async () => {
    const other = path.join(payer.dir, "otra.key");
    writeFileSync(other, Buffer.alloc(32, 7), { mode: 0o600 });
    assert.equal(await seed("bonos", "--free", "1", "--paid", "0", "--key-file", other), 0);
    assert.equal(payer.issues[0]!.id, bonoId(Buffer.alloc(32, 7), "free", 0));
  });

  it("a key that is not 32 bytes is not used", async () => {
    const bad = path.join(payer.dir, "mala.key");
    writeFileSync(bad, "corta", { mode: 0o600 });
    assert.equal(await seed("bonos", "--free", "1", "--key-file", bad), 1);
    assert.match(out.join("\n"), /is not a demo-seed key/);
    assert.equal(payer.issues.length, 0);
  });

  it("a key with permissions more open than 0600 is not used", async () => {
    const open = path.join(payer.dir, "abierta.key");
    writeFileSync(open, Buffer.alloc(32, 7));
    chmodSync(open, 0o644);
    assert.equal(await seed("bonos", "--free", "1", "--key-file", open), 1);
    assert.match(out.at(-1)!, /has permissions 644: must be 600/);
    assert.equal(payer.issues.length, 0);
  });

  it("with the hourly DUST cap it waits what the payer says and retries the same id", async () => {
    payer.issue = (_id, _plan, n) => (n === 1 ? { error: "dust-cap", retryAfterS: 120 } : { status: "issued", txHash: "ab" });
    assert.equal(await seed("bonos", "--free", "1", "--paid", "0"), 0);
    assert.deepEqual(sleeps, [120_000]);
    assert.equal(payer.issues[0]!.id, payer.issues[1]!.id);
    assert.match(out.join("\n"), /WAITING   120 s: hourly DUST cap for issuances/);
  });

  it("stops waiting after 10 waits in a row on the same bono", async () => {
    payer.issue = () => ({ error: "indexer-behind", retryAfterS: 30 });
    assert.equal(await seed("bonos", "--free", "1", "--paid", "0"), 1);
    assert.equal(payer.issues.length, 10);
    assert.match(out.at(-1)!, /10 waits in a row/);
  });

  it("a pending bono is counted and the rest go on; the exit code warns", async () => {
    payer.issue = (_id, _plan, n) => (n === 1 ? { status: "pending", txHash: "ab", retryAfterS: 600 } : { status: "issued", txHash: "ab" });
    assert.equal(await seed("bonos", "--free", "2", "--paid", "0"), 1);
    assert.equal(payer.issues.length, 2);
    assert.match(out.join("\n"), /PENDING   free 1\/2: run the command again in 10 min/);
    assert.equal(out.at(-1), "Done: 1 issued, 0 already there, 1 pending, 0 failed.");
  });

  it("stops after 3 failures in a row (each one may cost DUST)", async () => {
    payer.issue = () => ({ status: "failed", reason: "fee-lost", txHash: "ab" });
    assert.equal(await seed("bonos", "--free", "5", "--paid", "0"), 1);
    assert.equal(payer.issues.length, 3);
    assert.match(out.join("\n"), /FAILED    free 1\/5: fee-lost/);
    assert.match(out.at(-1)!, /3 failures in a row/);
  });

  for (const [what, answer, message] of [
    ["no spendable DUST", { error: "dust-unavailable", transient: false, retryAfterS: 60 }, /no spendable DUST/],
    ["fee above the cap", { error: "fee-over-cap" }, /NIGHTMAIL_PAYER_ISSUE_DUST_PER_HOUR/],
    ["the payer is stopping", { error: "stopping" }, /payer is stopping/],
  ] as const) {
    it(`stops dead: ${what}`, async () => {
      payer.issue = () => answer;
      assert.equal(await seed("bonos", "--free", "2", "--paid", "0"), 1);
      assert.equal(payer.issues.length, 1);
      assert.match(out.at(-1)!, message);
    });
  }

  it("if the connection is cut midway, it says that repeating does not duplicate", async () => {
    payer.issue = () => "cut";
    assert.equal(await seed("bonos", "--free", "2", "--paid", "0"), 1);
    assert.equal(payer.issues.length, 1);
    assert.match(out.at(-1)!, /Run the command again: it does not duplicate bonos/);
  });

  it("issues nothing if the payer is still syncing or there is no registry deployed", async () => {
    payer.ready = false;
    assert.equal(await seed("bonos", "--free", "1"), 1);
    assert.match(out.at(-1)!, /The payer is not ready yet/);
    payer.ready = true;
    payer.health = { ...READY, contract: null };
    assert.equal(await seed("bonos", "--free", "1"), 1);
    assert.match(out.at(-1)!, /no registry deployed/);
    assert.equal(payer.issues.length, 0);
  });

  it("without a payer, it says so with a hint", async () => {
    assert.equal(await seed("bonos", "--free", "1", "--socket", path.join(payer.dir, "no-hay.sock")), 1);
    assert.match(out.at(-1)!, /Could not reach the payer at .*no-hay\.sock\. Is it running\?/);
  });

  it("by default, 600 of each plan (1,200) and no warnings", async () => {
    payer.issue = () => ({ status: "already-issued" });
    assert.equal(await seed("bonos"), 0);
    assert.equal(payer.issues.filter((i) => i.plan === "free").length, 600);
    assert.equal(payer.issues.filter((i) => i.plan === "paid").length, 600);
    assert.doesNotMatch(out.join("\n"), /Warning/);
  });
});

describe("avanzar-ronda", () => {
  it("advances and reports the new round", async () => {
    assert.equal(await seed("avanzar-ronda"), 0);
    assert.equal(payer.advances, 1);
    assert.deepEqual(out, ["Round advanced to 9."]);
  });

  it("if it advanced without being able to read the round, it is still a success", async () => {
    payer.advance = { status: "advanced", round: null, txHash: "cd" };
    assert.equal(await seed("avanzar-ronda"), 0);
    assert.deepEqual(out, ["Round advanced."]);
  });

  it("unknown outcome: do not repeat before the time the payer gives", async () => {
    payer.advance = { status: "unknown", txHash: "cd", validUntil: Date.UTC(2026, 10, 22, 10, 30) };
    assert.equal(await seed("avanzar-ronda"), 1);
    assert.match(out[0]!, /unknown outcome.*Do not repeat it before 2026-11-22T10:30:00\.000Z/);
  });

  it("did not advance", async () => {
    payer.advance = { status: "failed", reason: "rejected" };
    assert.equal(await seed("avanzar-ronda"), 1);
    assert.deepEqual(out, ["Did not advance (rejected)."]);
  });

  it("a payer error does not guarantee nothing was paid", async () => {
    payer.advance = { error: "internal" };
    assert.equal(await seed("avanzar-ronda"), 1);
    assert.match(out[0]!, /HTTP 500 \(internal\).*may have advanced/s);
  });

  it("without a payer (no socket), says it did NOT connect and the round did not advance", async () => {
    assert.equal(await seed("avanzar-ronda", "--socket", path.join(payer.dir, "no-hay.sock")), 1);
    assert.match(out[0]!, /Could not connect to the payer at .*no-hay\.sock .*the round has NOT advanced/);
  });

  it("if the connection is cut midway, the round may have advanced", async () => {
    payer.advance = "cut";
    assert.equal(await seed("avanzar-ronda"), 1);
    assert.equal(payer.advances, 1);
    assert.match(out[0]!, /lost: the round may have advanced/);
  });
});

describe("usage", () => {
  for (const argv of [
    [],
    ["otra"],
    ["bonos", "--free", "-1"],
    ["bonos", "--free", "0", "--paid", "0"],
    ["bonos", "--free", "x"],
    ["bonos", "--nada"],
    ["bonos", "--hasta", "0"],
    ["bonos", "--hasta", "10", "--free", "3"],
    ["avanzar-ronda", "--free", "3"],
    ["avanzar-ronda", "--key-file", "k"],
  ]) {
    it(`bad usage (${argv.join(" ") || "nothing"}) gives 2 and the help, without calling the payer`, async () => {
      assert.equal(await seed(...argv), 2);
      assert.match(out.join("\n"), /Usage: /);
      assert.equal(payer.issues.length + payer.advances, 0);
    });
  }

  it("--help gives 0", async () => {
    assert.equal(await seed("--help"), 0);
    assert.match(out[0]!, /^Usage: /);
  });
});
