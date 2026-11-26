import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = path.resolve(import.meta.dirname, '../../../tools/operator-wallet-service.sh');
const UNIT = 'nightmail-operator-wallet-undeployed.service';
// The service is a systemd unit, so this only makes sense on Linux.
const linuxOnly = { skip: process.platform !== 'linux' };

// Copy of the script in a temporary root (ROOT is derived from the script location), with its own HOME
// and a fake `systemctl` that records every call.
function sandbox(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'nm-service-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'tools'));
  mkdirSync(path.join(root, 'bin'));
  mkdirSync(path.join(root, 'home'));
  const script = path.join(root, 'tools', 'operator-wallet-service.sh');
  copyFileSync(SCRIPT, script);
  chmodSync(script, 0o755);
  const calls = path.join(root, 'systemctl.calls');
  writeFileSync(path.join(root, 'bin', 'systemctl'), `#!/bin/sh\necho "$*" >> '${calls}'\n`, { mode: 0o755 });
  const run = (...args: string[]) =>
    spawnSync('bash', [script, ...args], {
      encoding: 'utf8',
      env: {
        PATH: `${path.join(root, 'bin')}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: path.join(root, 'home'),
        NVM_DIR: path.join(root, 'no-nvm'),
        NIGHTMAIL_NETWORK: 'undeployed',
      },
    });
  const systemctlCalls = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []);
  const unitFile = path.join(root, 'home', '.config/systemd/user', UNIT);
  return { run, systemctlCalls, unitFile };
}

const INSTALL_CALLS = ['--user daemon-reload', `--user disable ${UNIT}`];

test('the service script is executable (used as tools/operator-wallet-service.sh start)', linuxOnly, () => {
  assert.notEqual(statSync(SCRIPT).mode & 0o111, 0);
});

test('install creates the unit, disables autostart and does not start it', linuxOnly, (t) => {
  const box = sandbox(t);
  const r = box.run('install');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(box.unitFile), 'the unit exists');
  assert.deepEqual(box.systemctlCalls(), INSTALL_CALLS);
  assert.match(r.stdout, /operator-wallet-service\.sh start/);
});

test('installing twice leaves the same unit (idempotent)', linuxOnly, (t) => {
  const box = sandbox(t);
  assert.equal(box.run('install').status, 0);
  const first = readFileSync(box.unitFile, 'utf8');
  assert.equal(box.run('install').status, 0);
  assert.equal(readFileSync(box.unitFile, 'utf8'), first);
  assert.deepEqual(box.systemctlCalls(), [...INSTALL_CALLS, ...INSTALL_CALLS]);
});
