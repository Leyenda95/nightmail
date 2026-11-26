import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "../../../apps/server/src/config.ts";
import { run } from "./run.ts";

process.exitCode = await run(process.argv.slice(2), {
  out: (line) => console.log(line),
  sleep: (ms) => sleep(ms),
  config: () => loadConfig(),
});
