// Contract deployment against a fake chain: ordering, keys saved before deploying, in-flight deploy
// recorded before submitting, resuming after partial failures (adopt, wait for expiry or resubmit),
// instance lock, idempotency and the maintenance authority check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, fstatSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { signatureVerifyingKey } from '@midnight-ntwrk/compact-runtime';
import {
  DeployInProgressError, deployNightMail, DeployPendingError, EXPIRY_MARGIN_MS, fsyncDirStrict, readDeployment,
} from '../src/chain/deploy.ts';
import { ensurePrivateDir } from '../src/wallet/storage.ts';

const dataDir = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'nm-deploy-'));
  chmodSync(d, 0o700);
  return path.join(d, 'operator');
};
const perms = (p: string) => (statSync(p).mode & 0o777).toString(8);
const COLOR = new Uint8Array(32).fill(0xc0);
const OPTS = { network: 'undeployed' as const, price: 100n };
const TTL_MS = 60 * 60_000;
const T0 = Date.parse('2026-11-17T12:00:00.000Z');
/** Indexer time from which the first submission (made at T0) can no longer land. */
const EXPIRED = T0 + TTL_MS + EXPIRY_MARGIN_MS + 1;

type Fault =
  | 'token' | 'registry' // the node rejects it on submit
  | 'color' | 'wrong-authority' | 'prove-error'
  | 'crash-after-submit' | 'registry-crash' // submitted, included, then the process crashes
  | 'lost' | 'registry-lost' // submitted, the process crashes, not in any block yet
  | 'ambiguous' | 'unknown-lost' // uncertain outcome: included / not yet included
  | 'failed-block' // included in a block but failed (the contract does not exist)
  | 'unwritable'; // the submission cannot be recorded (data dir not writable)

type Sent = { address: string; txHash: string; validUntil: Date };

/**
 * Fake chain shared across attempts (like the real one): remembers which contracts exist and the
 * indexer time. Checks that the key was already on disk when deploying and that the in-flight deploy
 * (address, hash and expiry) was recorded before "submitting".
 */
function fakeChain(dir: string) {
  const onChain = new Map<string, string>(); // address -> verifying key of its authority
  const sentAuthority = new Map<string, string>(); // what was submitted, even if not on chain yet
  const log: { name: string; key: { value: string }; args: unknown[] }[] = [];
  let fault: Fault | undefined;
  let next = 0;
  let clock = T0;
  let gate: Promise<void> | undefined;
  let atGate: (() => void) | undefined;
  let onIndexedTime: (() => void) | undefined;
  const contract = async (name: 'token' | 'registry', witnesses?: Record<string, unknown>) => {
    // Like the real one: the registry cannot be built without its witnesses (also to deploy or query it).
    if (name === 'registry' && typeof witnesses?.['bonoSecret'] !== 'function') throw new Error('registry needs witnesses');
    return contractFor(name);
  };
  const contractFor = (name: 'token' | 'registry') => ({
    module: { pureCircuits: {
      operatorKey: (sk: Uint8Array) => new Uint8Array(32).fill(sk[0]! ^ 0xff),
      colorOf: () => {
        if (fault === 'color') throw new Error('color failed');
        return COLOR;
      },
    } },
    async deploy(key: { tag: 'schnorr'; value: string }, args: unknown[], beforeSubmit: (s: Sent) => void | Promise<void>) {
      const keyFile = path.join(dir, `maintenance-key-${name}`);
      assert.ok(existsSync(keyFile), `the ${name} key is saved before deploying`);
      assert.equal(readFileSync(keyFile, 'utf8').trim(), key.value);
      const n = ++next;
      const address = `${name}-address-${n}`;
      log.push({ name, key, args });
      if (fault === 'prove-error') return { address, outcome: { ok: false, status: 'prove-error', error: 'proof server down' } };
      const sent = { address, txHash: `tx-${n}`, validUntil: new Date(clock + TTL_MS) };
      if (fault === 'unwritable') chmodSync(dir, 0o500);
      try {
        await beforeSubmit(sent); // like sendPrepared: if it cannot be recorded, it is not sent
      } catch (e) {
        return { address, outcome: { ok: false, status: 'record-error', error: (e as Error).message } };
      }
      assert.deepEqual(progress(dir).pending?.[name], { ...sent, validUntil: sent.validUntil.toISOString() },
        'the in-flight deployment is recorded before submitting');
      atGate?.();
      await gate;
      if (fault === name) return { address, outcome: { ok: false, status: 'rejected', error: 'boom' } };
      sentAuthority.set(address, fault === 'wrong-authority' ? 'otra' : signatureVerifyingKey(key).value);
      if (fault === 'lost' || (fault === 'registry-lost' && name === 'registry')) throw new Error('crash after submit');
      if (fault === 'unknown-lost') return { address, outcome: { ok: false, status: 'unknown', error: 'socket closed' } };
      if (fault === 'failed-block') return { address, outcome: { ok: false, status: 'FailEntirely' } };
      land(address);
      if (fault === 'crash-after-submit' || (fault === 'registry-crash' && name === 'registry')) {
        throw new Error('crash after submit');
      }
      if (fault === 'ambiguous') return { address, outcome: { ok: false, status: 'unknown', error: 'socket closed' } };
      return { address, outcome: { ok: true, status: 'SucceedEntirely' } };
    },
    exists: async (address: string) => onChain.has(address),
    maintenanceCommittee: async (address: string) => [onChain.get(address)!],
  });
  /** A submitted transaction lands in a block. */
  const land = (address: string) => onChain.set(address, sentAuthority.get(address)!);
  const indexedTime = async () => {
    onIndexedTime?.();
    return new Date(clock);
  };
  return {
    chain: { contract, indexedTime } as any,
    log,
    land,
    setFault: (f?: Fault) => { fault = f; },
    forget: () => onChain.clear(), // the devnet was reset
    setClock: (ms: number) => { clock = ms; },
    /** Holds submissions until `open` is called; `reached` resolves when one hits the hold. */
    holdSubmit: () => {
      let open!: () => void;
      gate = new Promise((r) => { open = r; });
      const reached = new Promise<void>((r) => { atGate = r; });
      return { reached, open: () => { gate = undefined; open(); } };
    },
    onIndexedTime: (f?: () => void) => { onIndexedTime = f; },
  };
}

const run = (f: ReturnType<typeof fakeChain>, dir: string, opts = OPTS) => deployNightMail(f.chain, { dataDir: dir, ...opts });
const progress = (dir: string) => JSON.parse(readFileSync(path.join(dir, 'contracts.json'), 'utf8'));

/** A first attempt that submits the token and crashes before it lands in a block. */
async function lostToken(f: ReturnType<typeof fakeChain>, dir: string) {
  f.setFault('lost');
  await assert.rejects(run(f, dir), /crash after submit/);
  f.setFault();
}

test('deploys the token and then the registry with its color, the price and the operator key', async () => {
  const dir = dataDir();
  const f = fakeChain(dir);
  const d = await run(f, dir);
  assert.deepEqual(f.log.map((l) => l.name), ['token', 'registry']);
  const opSk = Buffer.from(readFileSync(path.join(dir, 'operator-sk'), 'utf8').trim(), 'hex');
  assert.deepEqual(f.log[1]!.args, [new Uint8Array(32).fill(opSk[0]! ^ 0xff), COLOR, 100n]);
  assert.equal(d.token.address, 'token-address-1');
  assert.equal(d.token.color, Buffer.from(COLOR).toString('hex'));
  assert.equal(d.registry.address, 'registry-address-2');
  assert.equal(d.registry.initialPrice, '100');
  assert.deepEqual(readDeployment(dir), d);
  assert.equal((d as any).pending, undefined, 'no in-flight deployments when done');
  for (const file of ['contracts.json', 'operator-sk', 'maintenance-key-token', 'maintenance-key-registry']) {
    assert.equal(perms(path.join(dir, file)), '600', file);
  }
  assert.notDeepEqual(f.log[0]!.key, f.log[1]!.key, 'each contract has its own key');
});

test('is idempotent: if already deployed (and still on chain) it does not deploy again', async () => {
  const dir = dataDir();
  const f = fakeChain(dir);
  const first = await run(f, dir);
  f.log.length = 0;
  assert.deepEqual(await run(f, dir), first);
  assert.deepEqual(f.log, []);
});

test('a contracts.json of contracts that no longer exist (devnet restarted) is an error, not a success', async () => {
  const dir = dataDir();
  const f = fakeChain(dir);
  await run(f, dir);
  f.forget();
  await assert.rejects(run(f, dir), /stale/);
});

test('if the deployment is cut off after submitting, the retry adopts the contract instead of deploying another', async () => {
  const dir = dataDir();
  const f = fakeChain(dir);
  f.setFault('crash-after-submit');
  await assert.rejects(run(f, dir), /crash after submit/);
  f.setFault();
  const d = await run(f, dir);
  assert.deepEqual(f.log.map((l) => l.name), ['token', 'registry'], 'the token was deployed only once');
  assert.equal(d.token.address, 'token-address-1');
});

test('submitted but not yet included and still in time to land: does not deploy another, says so and touches nothing', async () => {
  const dir = dataDir();
  const f = fakeChain(dir);
  await lostToken(f, dir);
  const before = readFileSync(path.join(dir, 'contracts.json'), 'utf8');
  await assert.rejects(run(f, dir), (e: Error) => {
    assert.ok(e instanceof DeployPendingError, String(e));
    // Until when it can land, when to retry (with the margin) and where the indexer is.
    assert.match(e.message,
      /token .*tx-1.*token-address-1.*until 2026-11-17T13:00:00\.000Z.*after 2026-11-17T13:01:00\.000Z.*at 2026-11-17T12:00:00\.000Z.*reset/);
    return true;
  });
  f.setClock(EXPIRED - 1); // exactly at the limit (expiry + margin): not yet considered lost
  await assert.rejects(run(f, dir), DeployPendingError);
  assert.deepEqual(f.log.map((l) => l.name), ['token'], 'no other one was submitted');
  assert.equal(readFileSync(path.join(dir, 'contracts.json'), 'utf8'), before, 'the record does not change');
});

test('if the transaction lands late, the next attempt adopts that contract', async () => {
  const dir = dataDir();
  const f = fakeChain(dir);
  await lostToken(f, dir);
  await assert.rejects(run(f, dir), DeployPendingError);
  f.land('token-address-1');
  f.setClock(EXPIRED); // even if already expired: it is on chain, so it is adopted
  const d = await run(f, dir);
  assert.equal(d.token.address, 'token-address-1');
  assert.deepEqual(f.log.map((l) => l.name), ['token', 'registry']);
});

test('if it expired without landing on chain, it is deployed again (and the new submission is recorded)', async () => {
  const dir = dataDir();
  const f = fakeChain(dir);
  await lostToken(f, dir);
  f.setClock(EXPIRED);
  const d = await run(f, dir);
  assert.deepEqual(f.log.map((l) => l.name), ['token', 'token', 'registry']);
  assert.equal(d.token.address, 'token-address-2');
  assert.deepEqual(f.log[0]!.key, f.log[1]!.key, 'with the same maintenance key');
});

test('the indexer time is read before looking up the contract (if it lands in between, it is adopted)', async () => {
  const dir = dataDir();
  const f = fakeChain(dir);
  await lostToken(f, dir);
  f.setClock(EXPIRED);
  // The indexer passes the expiry right after indexing the block that included it.
  f.onIndexedTime(() => f.land('token-address-1'));
  const d = await run(f, dir);
  assert.equal(d.token.address, 'token-address-1', 'adopted, not orphaned');
  assert.deepEqual(f.log.map((l) => l.name), ['token', 'registry']);
});

test('an uncertain result (unconfirmed) is adopted if the contract exists', async () => {
  const dir = dataDir();
  const f = fakeChain(dir);
  f.setFault('ambiguous');
  const d = await run(f, dir);
  assert.deepEqual(f.log.map((l) => l.name), ['token', 'registry']);
  assert.equal(d.registry.address, 'registry-address-2');
});

test('an uncertain result without the contract on chain: fails and keeps the submission recorded for the next attempt', async () => {
  const dir = dataDir();
  const f = fakeChain(dir);
  f.setFault('unknown-lost');
  await assert.rejects(run(f, dir), /Deploying token failed: unknown \(socket closed\)/);
  assert.equal(progress(dir).pending.token.txHash, 'tx-1');
  f.setFault();
  await assert.rejects(run(f, dir), DeployPendingError);
  assert.deepEqual(f.log.map((l) => l.name), ['token']);
});

test('if the registry fails, the token stays recorded and the retry continues with the same key', async () => {
  const dir = dataDir();
  const f = fakeChain(dir);
  f.setFault('registry');
  await assert.rejects(run(f, dir), /registry failed: rejected \(boom\)/);
  assert.equal(progress(dir).pending?.registry, undefined, 'rejected by the node: not left in flight');
  f.setFault();
  const firstKey = f.log[1]!.key;
  f.log.length = 0;
  const d = await run(f, dir); // no waiting for expiry: the node did not accept it
  assert.deepEqual(f.log.map((l) => l.name), ['registry'], 'does not redeploy the token');
  assert.equal(d.token.address, 'token-address-1');
  assert.deepEqual(f.log[0]!.key, firstKey, 'the registry key does not change between attempts');
});

test('if it fails before submitting (proof), nothing is left in flight and the retry deploys', async () => {
  const dir = dataDir();
  const f = fakeChain(dir);
  f.setFault('prove-error');
  await assert.rejects(run(f, dir), /token failed: prove-error \(proof server down\)/);
  f.setFault();
  assert.equal((await run(f, dir)).token.address, 'token-address-2');
});

test('if something fails after deploying the token, its address is already recorded and it is not redeployed', async () => {
  const dir = dataDir();
  const f = fakeChain(dir);
  f.setFault('color');
  await assert.rejects(run(f, dir), /color failed/);
  f.setFault();
  f.log.length = 0;
  const d = await run(f, dir);
  assert.deepEqual(f.log.map((l) => l.name), ['registry']);
  assert.equal(d.token.color, Buffer.from(COLOR).toString('hex'), 'the color is filled in on the retry');
});

test('checks that the deployed maintenance authority is the saved key', async () => {
  const dir = dataDir();
  const f = fakeChain(dir);
  f.setFault('wrong-authority');
  await assert.rejects(run(f, dir), /maintenance authority/);
});

test('a submitted (unconfirmed) registry with one price is not adopted when another is recorded', async () => {
  const dir = dataDir();
  const f = fakeChain(dir);
  f.setFault('registry-crash');
  await assert.rejects(run(f, dir), /crash after submit/);
  f.setFault();
  await assert.rejects(run(f, dir, { ...OPTS, price: 200n }), /sent with price 100/);
  const d = await run(f, dir);
  assert.equal(d.registry.initialPrice, '100');
  assert.deepEqual(f.log.map((l) => l.name), ['token', 'registry'], 'adopted, not redeployed');
});

test('a submitted unconfirmed registry: the price is only compared when adopting it, once expired it is submitted with the new one', async () => {
  const dir = dataDir();
  const f = fakeChain(dir);
  f.setFault('registry-lost');
  await assert.rejects(run(f, dir), /crash after submit/);
  f.setFault();
  await assert.rejects(run(f, dir, { ...OPTS, price: 200n }), (e: Error) =>
    e instanceof DeployPendingError && /^The registry deployment .*registry-address-2/.test(e.message));
  f.setClock(EXPIRED);
  const d = await run(f, dir, { ...OPTS, price: 200n });
  assert.deepEqual([d.registry.address, d.registry.initialPrice], ['registry-address-3', '200']);
  assert.deepEqual(f.log.map((l) => l.args.at(-1)), [undefined, 100n, 200n]);
});

test('a submission included in a block but failed keeps the record (not resubmitted until it expires)', async () => {
  const dir = dataDir();
  const f = fakeChain(dir);
  f.setFault('failed-block');
  await assert.rejects(run(f, dir), /Deploying token failed: FailEntirely/);
  assert.equal(progress(dir).pending.token.address, 'token-address-1');
  f.setFault();
  await assert.rejects(run(f, dir), DeployPendingError);
  assert.deepEqual(f.log.map((l) => l.name), ['token']);
});

test('if the submission cannot be recorded, nothing is submitted or left in flight', async () => {
  const dir = dataDir();
  const f = fakeChain(dir);
  f.setFault('unwritable');
  await assert.rejects(run(f, dir), /Deploying token failed: record-error \(EACCES/);
  chmodSync(dir, 0o700);
  assert.equal(existsSync(path.join(dir, 'contracts.json')), false, 'no submission was left recorded');
  f.setFault();
  const d = await run(f, dir);
  assert.equal(d.token.address, 'token-address-2', 'the first one was not submitted: deploys without waiting');
});

test('fsyncDirStrict: if the directory cannot be flushed to disk, it fails (and closes the directory)', () => {
  const dir = dataDir();
  ensurePrivateDir(dir);
  let fd = -1;
  assert.throws(() => fsyncDirStrict(dir, (d) => { fd = d; throw new Error('EIO'); }), /EIO/);
  assert.throws(() => fstatSync(fd), /EBADF/, 'cerrada');
  fsyncDirStrict(dir);
});

test('fsyncDirStrict: Windows does not allow fsync on a directory (EPERM) and there it is not a failure, on Linux it is', () => {
  const dir = dataDir();
  ensurePrivateDir(dir);
  const eperm = () => { throw Object.assign(new Error('EPERM: operation not permitted, fsync'), { code: 'EPERM' }); };
  assert.doesNotThrow(() => fsyncDirStrict(dir, eperm, 'win32'));
  assert.throws(() => fsyncDirStrict(dir, eperm, 'linux'), /EPERM/);
  assert.throws(() => fsyncDirStrict(dir, () => { throw new Error('EIO'); }, 'win32'), /EIO/, 'another error still fails');
});

test('a submission recorded in the old format (address only): adopted if it exists, otherwise a clear error', async () => {
  const dir = dataDir();
  const f = fakeChain(dir);
  await lostToken(f, dir);
  const legacy = { ...progress(dir), pending: { token: 'token-address-1' } };
  writeFileSync(path.join(dir, 'contracts.json'), JSON.stringify(legacy));
  f.setClock(EXPIRED);
  await assert.rejects(run(f, dir), (e: Error) => e instanceof DeployPendingError && /expiry was not recorded.*pending\.token/.test(e.message));
  f.land('token-address-1');
  assert.equal((await run(f, dir)).token.address, 'token-address-1');
});

test('a recorded submission with an unreadable expiry: explicit error, neither adopted nor resubmitted', async () => {
  const dir = dataDir();
  const f = fakeChain(dir);
  await lostToken(f, dir);
  for (const validUntil of ['mañana', undefined]) {
    const broken = { ...progress(dir), pending: { token: { address: 'token-address-1', txHash: 'tx-1', validUntil } } };
    writeFileSync(path.join(dir, 'contracts.json'), JSON.stringify(broken));
    await assert.rejects(run(f, dir), /pending token deployment is malformed/);
  }
  writeFileSync(path.join(dir, 'contracts.json'), JSON.stringify({ network: 'undeployed', pending: { token: { validUntil: '2026-11-17T13:00:00Z' } } }));
  await assert.rejects(run(f, dir), /malformed/);
  assert.deepEqual(f.log.map((l) => l.name), ['token']);
});

test('two deployments at once in the same directory: the second refuses, the lock is released when done', async () => {
  const dir = dataDir();
  const f = fakeChain(dir);
  const held = f.holdSubmit();
  const first = run(f, dir);
  await held.reached; // the first one is already submitting the token
  await assert.rejects(run(f, dir), (e: Error) => e instanceof DeployInProgressError && /already running/.test(e.message));
  held.open();
  const d = await first;
  assert.deepEqual(f.log.map((l) => l.name), ['token', 'registry'], 'a single deployment');
  assert.deepEqual(await run(f, dir), d, 'released: can be run again');
});

test('the lock is also released if the deployment fails', async () => {
  const dir = dataDir();
  const f = fakeChain(dir);
  f.setFault('token');
  await assert.rejects(run(f, dir), /token failed: rejected/);
  f.setFault();
  assert.equal((await run(f, dir)).token.address, 'token-address-2');
});

test('does not mix networks, the price must be greater than zero, once deployed the price is no longer compared (setPrice)', async () => {
  const dir = dataDir();
  const f = fakeChain(dir);
  const first = await run(f, dir);
  assert.deepEqual(await run(f, dir, { ...OPTS, price: 200n }), first, 'neither redeploys nor changes the record');
  await assert.rejects(run(f, dir, { ...OPTS, network: 'preprod' as any }), /network/);
  const empty = dataDir();
  await assert.rejects(run(fakeChain(empty), empty, { ...OPTS, price: 0n }), /greater than zero/);
});
