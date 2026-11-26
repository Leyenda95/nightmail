// Mutation testing for the Compact contracts (standard mutation tools do not support Compact).
//   npm run test:mutants -w contracts
// Each mutant in scripts/mutants/<contract>.json is [name, original text, mutated text]. The contract
// is compiled with the change (--skip-zk, into its simulator folder) and the tests are run; the mutant
// is killed if any test fails. Exits with an error if a mutant survives, fails to compile, or its
// original text does not occur exactly once. The original contracts are recompiled at the end.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = fileURLToPath(new URL('..', import.meta.url));
const COMPILER = process.env['npm_package_config_compact'] ?? JSON.parse(readFileSync(path.join(PKG, 'package.json'), 'utf8')).config.compact;
const CONTRACTS = [
  { src: 'src/NightMailRegistry.compact', out: 'managed/registry-sim', mutants: 'scripts/mutants/registry.json' },
  { src: 'src/TestToken.compact', out: 'managed/token-sim', mutants: 'scripts/mutants/token.json' },
];

function compile(text: string, file: string, out: string): string | null {
  const dir = mkdtempSync(path.join(tmpdir(), 'nm-mutant-'));
  try {
    const src = path.join(dir, path.basename(file));
    writeFileSync(src, text);
    const r = spawnSync('compact', ['compile', COMPILER, '--skip-zk', src, path.join(PKG, out)], { encoding: 'utf8' });
    return r.status === 0 ? null : (r.stderr || r.stdout).trim().split('\n').at(-1) ?? 'error';
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function testsPass(): boolean {
  return spawnSync('node', ['--test', 'test/*.test.ts'], { cwd: PKG, encoding: 'utf8' }).status === 0;
}

let failures = 0;
let total = 0;
try {
  for (const c of CONTRACTS) {
    const original = readFileSync(path.join(PKG, c.src), 'utf8');
    const mutants: [string, string, string][] = JSON.parse(readFileSync(path.join(PKG, c.mutants), 'utf8'));
    for (const [name, from, to] of mutants) {
      total++;
      const count = original.split(from).length - 1;
      let verdict: string;
      if (count !== 1) verdict = `TEXT ${count} TIMES`;
      else {
        const error = compile(original.replace(from, to), c.src, c.out);
        verdict = error ? `DOES NOT COMPILE: ${error.slice(0, 80)}` : testsPass() ? 'SURVIVES' : 'killed';
      }
      if (verdict !== 'killed') failures++;
      console.log(`${verdict.padEnd(12)} ${path.basename(c.src)}: ${name}`);
    }
    compile(original, c.src, c.out);
  }
} finally {
  for (const c of CONTRACTS) compile(readFileSync(path.join(PKG, c.src), 'utf8'), c.src, c.out);
}
console.log(`\n${total - failures}/${total} mutants killed`);
if (failures) process.exitCode = 1;
