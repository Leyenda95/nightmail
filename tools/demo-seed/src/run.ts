// CLI logic, kept apart from cli.ts so it can be tested against the payer API with a fake payer.
// Everything goes through the payer's local API (apps/server/src/payer/api.ts): its single queue, caps and idempotency.
import path from "node:path";
import { parseArgs } from "node:util";
import { payerClient, payerSocketPath, type PayerClient } from "../../../apps/server/src/payer/client.ts";
import { bonoId, issueStep, type IssuePlan, type Step } from "./bonos.ts";
import { loadOrCreateKey } from "./key.ts";

const USAGE = `Usage: node tools/demo-seed/src/cli.ts <command> [options]

Commands:
  bonos            Issues fake bonos so the demo's bono tree is not nearly empty.
                   About 3 per minute, and waits when it hits the payer's hourly DUST cap.
                   It can be interrupted and rerun: it resumes where it left off, without duplicates.
    --free <N>     Bonos of the free plan (default 600)
    --paid <N>     Bonos of the paid plan (default 600)
    --hasta <N>    Instead of --free and --paid: N in total (half of each plan). Those already
                   issued with this key are counted without spending anything: use it to top up to N.
    --key-file <f> Key for the ids (default <operator data>/demo-seed.key; created if missing)
  avanzar-ronda    Advances the registry round once (the demo's "button").

  --socket <f>     Payer socket (default <operator data>/payer.sock)
  --help           Show this help

The operator data folder depends on NIGHTMAIL_NETWORK (undeployed or preprod), as on the server.`;

export interface Io {
  out(line: string): void;
  sleep(ms: number): Promise<void>;
  /** Network and operator data folder (holds the payer socket and the key). */
  config(): { network: string; dataDir: string };
}

type Counts = Record<IssuePlan, number>;
type Command = { name: "bonos"; counts: Counts; socket?: string; keyFile?: string } | { name: "avanzar-ronda"; socket?: string };

/** Consecutive waits on one bono before giving up; consecutive failures (each may cost DUST) before stopping. */
export const MAX_WAITS = 10;
export const MAX_FAILURES_IN_A_ROW = 3;
const MAX_COUNT = 1_000_000;
/** Default: 600 per plan, 1,200 in total. No power of 2 is special here. */
const DEFAULT_PER_PLAN = "600";

function count(value: string, name: string): number {
  if (!/^\d{1,7}$/.test(value) || Number(value) > MAX_COUNT) throw new Error(`--${name} must be an integer between 0 and ${MAX_COUNT}`);
  return Number(value);
}

const OPTIONS = {
  free: { type: "string" },
  paid: { type: "string" },
  hasta: { type: "string" },
  "key-file": { type: "string" },
  socket: { type: "string" },
  help: { type: "boolean" },
} as const;

/** Options that only make sense with `bonos`. */
const BONOS_ONLY = ["free", "paid", "hasta", "key-file"] as const;

type Values = { [K in (typeof BONOS_ONLY)[number]]?: string };

/** How many per plan: `--hasta N` (half each) or `--free`/`--paid`. */
function bonoCounts(values: Values): Counts {
  if (values.hasta === undefined) {
    return { free: count(values.free ?? DEFAULT_PER_PLAN, "free"), paid: count(values.paid ?? DEFAULT_PER_PLAN, "paid") };
  }
  if (values.free !== undefined || values.paid !== undefined) throw new Error("--hasta cannot be combined with --free or --paid");
  const total = count(values.hasta, "hasta");
  return { free: Math.ceil(total / 2), paid: Math.floor(total / 2) };
}

export function parseCommand(argv: string[]): Command | "help" {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
  if (values.help) return "help";
  const [name, ...rest] = positionals;
  if (rest.length) throw new Error(`unexpected: ${rest.join(" ")}`);
  if (name === "avanzar-ronda") {
    const extra = BONOS_ONLY.filter((option) => values[option] !== undefined);
    if (extra.length) throw new Error(`avanzar-ronda does not accept ${extra.map((option) => `--${option}`).join(" or ")}`);
    return { name, socket: values.socket };
  }
  if (name !== "bonos") throw new Error(name ? `unknown command: ${name}` : "missing command");
  const counts = bonoCounts(values);
  if (counts.free + counts.paid === 0) throw new Error("no bonos to issue (the total is 0)");
  return { name, counts, socket: values.socket, keyFile: values["key-file"] };
}

const column = (word: string) => word.padEnd(10);

type Payer = Pick<PayerClient, "health" | "issue" | "advanceRound">;
type Outcome = Exclude<Step, { kind: "wait" }>;

/** Requests one bono until the reply is something other than "wait". */
async function issueOne(payer: Payer, id: string, plan: IssuePlan, label: string, io: Io): Promise<Outcome> {
  for (let waits = 1; ; waits++) {
    let step: Step;
    try {
      step = issueStep(await payer.issue(id, plan));
    } catch {
      const reason = `Connection to the payer lost at ${label}: that bono may have been issued. Run the command again: it does not duplicate bonos.`;
      return { kind: "abort", reason };
    }
    if (step.kind !== "wait") return step;
    if (waits >= MAX_WAITS) return { kind: "abort", reason: `${label}: ${MAX_WAITS} waits in a row (${step.reason}); stopping. Run it again later.` };
    io.out(`${column("WAITING")}${step.seconds} s: ${step.reason}`);
    await io.sleep(step.seconds * 1000);
  }
}

/** Whether the payer is ready to issue, and if not, why. */
async function readiness(payer: Payer, where: Where): Promise<{ ok: true; line: string } | { ok: false; reason: string }> {
  let reply;
  try {
    reply = await payer.health();
  } catch {
    return { ok: false, reason: `Could not reach the payer at ${where.socket}. Is it running?` };
  }
  const body = reply.body as { ready?: boolean; contract?: string | null; dustCoins?: number };
  if (reply.status !== 200 || body.ready !== true) return { ok: false, reason: "The payer is not ready yet (it is syncing its wallet)." };
  if (!body.contract) return { ok: false, reason: "There is no registry deployed on this network." };
  const line = `Payer ready (network ${where.network}, socket ${where.socket}): registry ${body.contract}, ${body.dustCoins} DUST coins.`;
  return { ok: true, line };
}

/** Which payer is being talked to. */
type Where = { network: string; socket: string };

async function seedBonos(payer: Payer, where: Where, keyFile: string, counts: Counts, io: Io): Promise<number> {
  const ready = await readiness(payer, where);
  if (!ready.ok) return (io.out(ready.reason), 1);
  io.out(ready.line);
  const key = loadOrCreateKey(keyFile);
  const tally: Tally = { issued: 0, already: 0, pending: 0, failed: 0 };
  let failuresInARow = 0;
  for (const plan of ["free", "paid"] as const) {
    for (let i = 0; i < counts[plan]; i++) {
      const label = `${plan} ${i + 1}/${counts[plan]}`;
      const step = await issueOne(payer, bonoId(key, plan, i), plan, label, io);
      if (step.kind === "abort") return (io.out(step.reason), 1);
      report(step, label, tally, io);
      failuresInARow = step.kind === "failed" ? failuresInARow + 1 : 0;
      if (failuresInARow === MAX_FAILURES_IN_A_ROW) {
        io.out(`${MAX_FAILURES_IN_A_ROW} failures in a row: stopping (each one may cost DUST). Check the payer log.`);
        return 1;
      }
    }
  }
  io.out(`Done: ${tally.issued} issued, ${tally.already} already there, ${tally.pending} pending, ${tally.failed} failed.`);
  return tally.pending + tally.failed === 0 ? 0 : 1;
}

type Tally = { issued: number; already: number; pending: number; failed: number };

/** Tallies and prints the outcome of one bono. */
function report(step: Exclude<Outcome, { kind: "abort" }>, label: string, tally: Tally, io: Io): void {
  switch (step.kind) {
    case "failed":
      tally.failed++;
      return io.out(`${column("FAILED")}${label}: ${step.reason}`);
    case "pending":
      tally.pending++;
      return io.out(`${column("PENDING")}${label}: run the command again in ${Math.ceil(step.retryAfterS / 60)} min`);
    case "done":
      tally[step.already ? "already" : "issued"]++;
      return io.out(`${column(step.already ? "ALREADY" : "ISSUED")}${label}`);
  }
}

async function advanceRound(payer: Payer, socket: string, io: Io): Promise<number> {
  let reply;
  try {
    reply = await payer.advanceRound();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    io.out(
      code === "ENOENT" || code === "ECONNREFUSED"
        ? `Could not connect to the payer at ${socket} (is it running?): the round has NOT advanced.`
        : `Communication with the payer at ${socket} was lost: the round may have advanced, check it before repeating.`,
    );
    return 1;
  }
  const { status, body } = reply;
  if (status === 200 && "status" in body) {
    if (body.status === "advanced") return (io.out(body.round === null ? "Round advanced." : `Round advanced to ${body.round}.`), 0);
    if (body.status === "unknown") {
      const until = new Date(body.validUntil).toISOString();
      io.out(`Sent with unknown outcome: it may land in a block until that time. Do not repeat it before ${until} without checking the round.`);
    } else io.out(`Did not advance (${body.reason}).`);
    return 1;
  }
  const error = "error" in body ? body.error : "?";
  const maybe = status >= 500 ? " The round may have advanced anyway: check it before repeating." : "";
  io.out(`The payer replied HTTP ${status} (${error}).${maybe}`);
  return 1;
}

/** Runs the CLI and returns the exit code (0 ok, 1 something left undone, 2 bad usage). */
export async function run(argv: string[], io: Io): Promise<number> {
  let command: Command | "help";
  try {
    command = parseCommand(argv);
  } catch (error) {
    io.out(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  if (command === "help") return (io.out(USAGE), 0);
  try {
    if (command.name === "avanzar-ronda") {
      const socket = command.socket ?? payerSocketPath(io.config().dataDir);
      return await advanceRound(payerClient(socket), socket, io);
    }
    const { network, dataDir } = io.config();
    const socket = command.socket ?? payerSocketPath(dataDir);
    const keyFile = command.keyFile ?? path.join(dataDir, "demo-seed.key");
    return await seedBonos(payerClient(socket), { network, socket }, keyFile, command.counts, io);
  } catch (error) {
    // Setup failures: network config (e.g. missing .env on preprod) or the key file.
    io.out((error as Error).message);
    return 1;
  }
}
