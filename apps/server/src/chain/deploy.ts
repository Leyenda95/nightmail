// Operator deployment of the NightMail contracts (TestToken and NightMailRegistry).
//
// All keys are written to disk (mode 0600) before deploying; back them up, since without the registry's
// maintenance key no circuit can ever be added. A resend mints a new address, so each in-flight deploy
// (address, tx hash, inclusion deadline) is recorded durably before sending; on resume it is adopted if
// on chain, redeployed if it can no longer land, otherwise the run stops and says how long to wait.
import { closeSync, existsSync, fsyncSync, openSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { sampleSigningKey, signatureVerifyingKey } from '@midnight-ntwrk/compact-runtime';
import { isDirFsyncUnsupported } from '@nightmail/midnight';
import type { NetworkName } from '../config.ts';
import { acquireLock, ensurePrivateDir, loadOrCreateSecret, WalletInUseError, writePrivateFile } from '../wallet/storage.ts';
import type { SentDeploy, SigningKey } from './midnight.ts';
import { registryWitnesses } from './registry.ts';

const DEPLOYMENT_FILE = 'contracts.json';
const LOCK_DIR = 'deploy-lock';
type Name = 'token' | 'registry';

/**
 * Margin past an in-flight tx's expiry before it is considered lost: covers rounding between block
 * time and ledger time. It only ever delays a resend, never brings it forward.
 */
export const EXPIRY_MARGIN_MS = 60_000;

/** Another deployment is running with the same data directory. */
export class DeployInProgressError extends Error {}
/** A sent deployment can still land on chain: wait, do not resend. */
export class DeployPendingError extends Error {}
/** contracts.json names a contract that is not on the chain (the local devnet was reset): start over. */
export class StaleDeploymentError extends Error {}

export type Deployment = {
  network: NetworkName;
  token: { address: string; color: string };
  /** initialPrice is the price at deploy time; the operator changes it later with setPrice (the ledger value wins). */
  registry: { address: string; initialPrice: string; operatorPk: string };
  deployedAt: string;
};
/** An unconfirmed deployment that was sent (or is about to be). validUntil is ISO 8601. */
type InFlight = { address: string; txHash: string; validUntil: string };
/**
 * What has been recorded so far: a partial deployment and unconfirmed sends. A send stored as a plain
 * string (address only) is the older format, with no hash or expiry. `registryPrice` is the price the
 * pending registry was sent with.
 */
type Progress = Partial<Omit<Deployment, 'network'>> & {
  network: NetworkName;
  pending?: Partial<Record<Name, InFlight | string>> & { registryPrice?: string };
};
/** A validated recorded send. `until` (ms) is null in the older format, which did not record it. */
type Pending = { address: string; txHash: string; until: number | null };

type DeployableContract = {
  module: any;
  deploy(key: SigningKey, args: unknown[], beforeSubmit: (sent: SentDeploy) => void):
    Promise<{ address: string; outcome: { ok: boolean; status: string; error?: string } }>;
  exists(address: string): Promise<boolean>;
  maintenanceCommittee(address: string): Promise<string[]>;
};
/** The minimum the deployment needs from the chain connection (see midnight.ts). */
type DeployChain = {
  contract(name: Name, witnesses?: Record<string, unknown>): Promise<DeployableContract>;
  /** Time of the last block processed by the indexer. */
  indexedTime(): Promise<Date>;
};
/** One contract with what is needed to deploy or resume it. `price` applies to the registry only. */
type Target = { chain: DeployChain; c: DeployableContract; name: Name; dataDir: string; d: Progress; price?: string };

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const bytes = (h: string) => new Uint8Array(Buffer.from(h, 'hex'));

function readProgress(dataDir: string): Progress | null {
  const file = path.join(dataDir, DEPLOYMENT_FILE);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Progress) : null;
}

/** The recorded complete deployment, or null if there is none (or it is partial). */
export function readDeployment(dataDir: string): Deployment | null {
  const d = readProgress(dataDir);
  return d?.token?.color && d.registry && d.deployedAt ? (d as Deployment) : null;
}

function save(dataDir: string, d: Progress): void {
  writePrivateFile(dataDir, DEPLOYMENT_FILE, JSON.stringify(d, null, 2) + '\n');
}

/**
 * Directory fsync that throws on failure (writePrivateFile only warns): an in-flight record must be on disk
 * before the tx is sent, otherwise it is better not to send. The one exception is Windows, which does not
 * allow fsync on a directory (EPERM); there it is not a failure (see isDirFsyncUnsupported).
 */
export function fsyncDirStrict(
  dir: string, sync: (fd: number) => void = fsyncSync, platform: NodeJS.Platform = process.platform,
): void {
  const fd = openSync(dir, 'r');
  try {
    sync(fd);
  } catch (err) {
    if (!isDirFsyncUnsupported(err, platform)) throw err;
  } finally {
    closeSync(fd);
  }
}

/** A contract's maintenance key: created and stored the first time, reused afterwards. */
function maintenanceKey(dataDir: string, name: Name): SigningKey {
  const { value } = loadOrCreateSecret(dataDir, `maintenance-key-${name}`,
    () => Buffer.from((sampleSigningKey() as SigningKey).value, 'hex'));
  return { tag: 'schnorr', value: value.toString('hex') };
}

function checkCompatible(d: Progress, opts: { network: NetworkName; price: bigint }): void {
  if (opts.price <= 0n) throw new Error('The bono price must be greater than zero');
  if (d.network !== opts.network) throw new Error(`contracts.json is for network ${d.network}, not ${opts.network}`);
}

/**
 * Deploys a contract (or adopts one already sent) and checks its maintenance authority.
 * Returns its address and clears `d.pending[name]`.
 */
async function ensureDeployed(t: Target, args: unknown[]): Promise<string> {
  const key = maintenanceKey(t.dataDir, t.name);
  const address = (await adoptPending(t)) ?? (await deployAndRecord(t, key, args));
  await checkAuthority(t.c, t.name, address, key);
  delete t.d.pending?.[t.name];
  return address;
}

/**
 * An earlier send: its address if on chain, undefined if it can no longer land; DeployPendingError otherwise.
 * Indexer time is read before the lookup, so once it is past the expiry the lookup is conclusive.
 */
async function adoptPending(t: Target): Promise<string | undefined> {
  const raw = t.d.pending?.[t.name];
  if (!raw) return undefined;
  const p = parsePending(t.name, raw);
  const indexed = (await t.chain.indexedTime()).getTime();
  if (await t.c.exists(p.address)) return checkSentPrice(t, p.address);
  if (p.until !== null && indexed > p.until + EXPIRY_MARGIN_MS) return undefined;
  throw new DeployPendingError(pendingMessage(t.name, p, indexed));
}

/** Validates a recorded earlier send. A plain string is the older format (address only). */
function parsePending(name: Name, raw: InFlight | string): Pending {
  if (typeof raw === 'string') return { address: raw, txHash: '(not recorded)', until: null };
  const until = Date.parse(raw.validUntil);
  if (typeof raw.address !== 'string' || !Number.isFinite(until)) {
    throw new Error(`contracts.json: the pending ${name} deployment is malformed: ${JSON.stringify(raw)}`);
  }
  return { address: raw.address, txHash: raw.txHash, until };
}

function pendingMessage(name: Name, p: Pending, indexed: number): string {
  const sent = `The ${name} deployment sent earlier (tx ${p.txHash}, address ${p.address}) is not on chain`;
  if (p.until === null) {
    return `${sent} and its expiry was not recorded (older format). Once it can no longer be included (1 h after ` +
      `it was sent), remove pending.${name} from contracts.json and run again.`;
  }
  return `${sent} yet but can still be included until ${new Date(p.until).toISOString()}. Run again after ` +
    `${new Date(p.until + EXPIRY_MARGIN_MS).toISOString()} by the indexer, which is at ${new Date(indexed).toISOString()} ` +
    '(it runs a few seconds behind the clock): it will be adopted if it landed, or deployed again if not. ' +
    'If the network was reset it will never land, and it is deployed again after that time as well. Do not edit contracts.json.';
}

/** A sent registry carries its price: adopting it while recording a different one would be wrong. */
function checkSentPrice({ d, price }: Target, address: string): string {
  const sent = d.pending?.registryPrice;
  if (price && sent && sent !== price) throw new Error(`The pending registry was sent with price ${sent}, not ${price}`);
  return address;
}

async function deployAndRecord({ c, name, dataDir, d, price }: Target, key: SigningKey, args: unknown[]): Promise<string> {
  const record = (s: SentDeploy) => {
    const entry: InFlight = { address: s.address, txHash: s.txHash, validUntil: s.validUntil.toISOString() };
    d.pending = { ...d.pending, [name]: entry, ...(price ? { registryPrice: price } : {}) };
    save(dataDir, d);
    fsyncDirStrict(dataDir);
  };
  const sent = await c.deploy(key, args, record);
  // An uncertain outcome (e.g. the connection dropped after sending) counts if the contract exists.
  if (sent.outcome.ok || (await c.exists(sent.address))) return sent.address;
  if (sent.outcome.status === 'rejected') {
    // The node refused it, so it will never land: it can be resent without waiting for expiry.
    delete d.pending?.[name];
    save(dataDir, d);
  }
  throw new Error(`Deploying ${name} failed: ${sent.outcome.status}${sent.outcome.error ? ` (${sent.outcome.error})` : ''}`);
}

async function checkAuthority(c: DeployableContract, name: Name, address: string, key: SigningKey): Promise<void> {
  if (!(await c.maintenanceCommittee(address)).includes(signatureVerifyingKey(key).value)) {
    throw new Error(`The maintenance authority of ${name} (${address}) is not the stored key`);
  }
}

async function checkStillDeployed(chain: DeployChain, d: Progress): Promise<void> {
  for (const [name, address] of [['token', d.token!.address], ['registry', d.registry!.address]] as const) {
    if (!(await (await chain.contract(name, name === 'registry' ? registryWitnesses() : {})).exists(address))) {
      throw new StaleDeploymentError(`contracts.json is stale: ${name} ${address} does not exist on ${d.network} (devnet reset?)`);
    }
  }
}

/** One deployment per data directory (lock in a subfolder, since `lock` is the wallet's). */
function lockDeployment(dataDir: string): () => void {
  const dir = path.join(dataDir, LOCK_DIR);
  ensurePrivateDir(dir);
  try {
    return acquireLock(dir);
  } catch (e) {
    if (!(e instanceof WalletInUseError)) throw e;
    throw new DeployInProgressError(`Another deployment is already running with ${dataDir}`, { cause: e });
  }
}

export async function deployNightMail(
  chain: DeployChain,
  opts: { dataDir: string; network: NetworkName; price: bigint },
): Promise<Deployment> {
  ensurePrivateDir(opts.dataDir);
  const release = lockDeployment(opts.dataDir);
  try {
    return await deployLocked(chain, opts);
  } finally {
    release();
  }
}

async function deployLocked(chain: DeployChain, opts: { dataDir: string; network: NetworkName; price: bigint }): Promise<Deployment> {
  const dataDir = opts.dataDir;
  const d: Progress = readProgress(dataDir) ?? { network: opts.network };
  checkCompatible(d, opts);
  if (readDeployment(dataDir)) {
    await checkStillDeployed(chain, d);
    return d as Deployment;
  }
  // Resuming: a recorded token must still be on chain, or the registry would be deployed over a missing one.
  if (d.token?.address && !(await (await chain.contract('token')).exists(d.token.address))) {
    throw new StaleDeploymentError(`contracts.json is stale: token ${d.token.address} does not exist on ${d.network} (devnet reset?)`);
  }

  if (!d.token?.color) {
    const token = await chain.contract('token');
    if (!d.token) {
      d.token = { address: await ensureDeployed({ chain, c: token, name: 'token', dataDir, d }, []), color: '' };
      save(dataDir, d);
    }
    d.token.color = hex(token.module.pureCircuits.colorOf({ bytes: bytes(d.token.address) }));
    save(dataDir, d);
  }
  const opSk = loadOrCreateSecret(dataDir, 'operator-sk', () => randomBytes(32)).value;
  const registry = await chain.contract('registry', registryWitnesses());
  const operatorPk: Uint8Array = registry.module.pureCircuits.operatorKey(new Uint8Array(opSk));
  const address = await ensureDeployed({ chain, c: registry, name: 'registry', dataDir, d, price: opts.price.toString() },
    [operatorPk, bytes(d.token.color), opts.price]);
  d.registry = { address, initialPrice: opts.price.toString(), operatorPk: hex(operatorPk) };
  d.deployedAt = new Date().toISOString();
  delete d.pending;
  save(dataDir, d);
  return d as Deployment;
}
