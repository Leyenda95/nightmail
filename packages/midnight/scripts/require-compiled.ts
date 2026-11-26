// Runs before the tests: the package uses the compiled contract (contracts/managed/registry) and the
// tests simulate it (contracts/managed/registry-sim). If either is missing, say how to build it
// instead of failing on an import.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const managed = (dir: string) => fileURLToPath(new URL(`../../../contracts/managed/${dir}/contract/index.js`, import.meta.url));
const missing = [
  ['registry', 'npm run compile -w contracts'],
  ['registry-sim', 'npm run compile:sim -w contracts'],
].filter(([dir]) => !existsSync(managed(dir)));

if (missing.length) {
  for (const [dir, command] of missing) console.error(`Compiled contract contracts/managed/${dir} is missing: run \`${command}\``);
  process.exit(1);
}
