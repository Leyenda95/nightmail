// Operator server configuration.
//
// Secrets (BLOCKFROST_PROJECT_ID) are read from the untracked `~/nightmail/.env`
// without going through `process.env`, so child processes never inherit them.
// `secrets` lists them so redact.ts can mask them in the output.
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseFlag } from './env.ts';

export const NETWORKS = ['undeployed', 'preprod'] as const;
export type NetworkName = (typeof NETWORKS)[number];

export type ServerConfig = {
  network: NetworkName;
  indexer: string;
  indexerWS: string;
  relayURL: string;
  proofServer: string;
  /** Operator data directory (wallet seed, lock and state). Not tracked by git. */
  dataDir: string;
  /** Secret values that must never appear in the output. */
  secrets: string[];
};

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function readEnvFile(file: string): Record<string, string | undefined> {
  return existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
}

export function parseNetwork(value: string | undefined): NetworkName {
  const network = value ?? 'preprod';
  if (!(NETWORKS as readonly string[]).includes(network)) {
    throw new Error(`Unsupported network: ${network} (expected ${NETWORKS.join(' or ')})`);
  }
  return network as NetworkName;
}

/** `value` if it is a URL with one of `protocols`, else `fallback` when unset. Anything else throws. */
function urlFrom(name: string, value: string | undefined, fallback: string, protocols: string[]): string {
  if (value === undefined) return fallback;
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (!url || !protocols.includes(url.protocol)) throw new Error(`${name} must be a ${protocols.join(' or ')} URL`);
  return value.replace(/\/+$/, '');
}

/**
 * Network configuration. The local devnet and the proof server are reached on 127.0.0.1 unless these
 * variables say otherwise (the Docker backend in infra/backend points them at the devnet containers):
 * NIGHTMAIL_DEVNET_NODE_URL (ws), NIGHTMAIL_DEVNET_INDEXER_URL (http, its WebSocket is `<url>/ws`)
 * and NIGHTMAIL_PROOF_SERVER_URL (http).
 */
export function loadConfig(
  network: NetworkName = parseNetwork(process.env['NIGHTMAIL_NETWORK']),
  env: Record<string, string | undefined> = readEnvFile(path.join(REPO_ROOT, '.env')),
  vars: Record<string, string | undefined> = process.env,
): ServerConfig {
  // In case it was exported in the shell: keep it away from child processes.
  delete process.env['BLOCKFROST_PROJECT_ID'];

  const proofServer = urlFrom('NIGHTMAIL_PROOF_SERVER_URL', vars['NIGHTMAIL_PROOF_SERVER_URL'], 'http://127.0.0.1:6300', ['http:', 'https:']);
  const dataDir = path.join(REPO_ROOT, '.data', 'operator', network);

  if (network === 'undeployed') {
    const indexer = urlFrom('NIGHTMAIL_DEVNET_INDEXER_URL', vars['NIGHTMAIL_DEVNET_INDEXER_URL'], 'http://127.0.0.1:8088/api/v4/graphql', ['http:']);
    return {
      network,
      indexer,
      indexerWS: `${indexer.replace(/^http/, 'ws')}/ws`,
      relayURL: urlFrom('NIGHTMAIL_DEVNET_NODE_URL', vars['NIGHTMAIL_DEVNET_NODE_URL'], 'ws://127.0.0.1:9944', ['ws:']),
      proofServer,
      dataDir,
      secrets: [],
    };
  }
  // On preprod the indexer and the RPC endpoint are served by Blockfrost. The
  // project_id goes in the URL because the SDK clients only accept URLs.
  const projectId = env['BLOCKFROST_PROJECT_ID'];
  if (!projectId) throw new Error('BLOCKFROST_PROJECT_ID is required in ~/nightmail/.env');
  const auth = `project_id=${encodeURIComponent(projectId)}`;
  return {
    network,
    indexer: `https://midnight-preprod.blockfrost.io/api/v0?${auth}`,
    indexerWS: `wss://midnight-preprod.blockfrost.io/api/v0/ws?${auth}`,
    relayURL: `wss://rpc.midnight-preprod.blockfrost.io?${auth}`,
    proofServer,
    dataDir,
    secrets: [projectId],
  };
}

/** Genesis seed of the local devnet (node dev preset): public, and already holds NIGHT and DUST. */
export const DEVNET_GENESIS_SEED = '0'.repeat(63) + '1';

/**
 * Seed source for a new operator wallet: the genesis seed on the devnet (deploy and test without a
 * faucet), a random one on any other network.
 */
export function walletSeedSource(network: NetworkName, random: () => Uint8Array): () => Uint8Array {
  return network === 'undeployed' ? () => Buffer.from(DEVNET_GENESIS_SEED, 'hex') : random;
}

/** For logs: never print a URL with the project_id in it. */
export function redactUrl(url: string): string {
  return url.replace(/project_id=[^&]+/g, 'project_id=***');
}

// --- Mail server (SMTP ingress, Mailbox API and RegistrySync): src/bin/mail-server.ts ---

export type MailServerConfig = {
  /** NightMailRegistry contract address (hex), from `<dataDir>/contracts.json`. */
  registryAddress: string;
  /** Mail domain, lowercase. */
  mailDomain: string;
  /**
   * Address the SMTP server, the API, the issuer and the relayer listen on. The MVP only listens locally:
   * 127.0.0.1, or 0.0.0.0 inside the Docker backend's container, whose ports are published on 127.0.0.1 only.
   */
  listenHost: string;
  smtpPort: number;
  apiPort: number;
  /** Base URL clients use to reach the API; its authority is the `host` they sign. */
  apiBaseUrl: string;
  /** A trusted proxy sits in front of the API: its per-IP limits use the last X-Forwarded-For entry. */
  trustedProxy: boolean;
  /** Mail server database, one per contract (see registry/store.ts). */
  databaseFile: string;
  debug: boolean;
};

export const DEFAULT_MAIL_DOMAIN = 'nightmail.local';
export const DEFAULT_SMTP_PORT = 2525;
export const DEFAULT_API_PORT = 8787;

function portFrom(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const port = /^[1-9][0-9]{0,4}$/.test(value) ? Number(value) : 0;
  if (port < 1 || port > 65535) throw new Error(`${name} must be a port number (1-65535)`);
  return port;
}

/** Docker creates this file in every container. */
export const inDockerContainer = (): boolean => existsSync('/.dockerenv');

/**
 * Only these two: local-only, or every interface of a container whose ports are published on 127.0.0.1.
 * 0.0.0.0 is refused outside a container, where it would expose the server to the network.
 */
function listenHostFrom(value: string | undefined, inContainer: () => boolean): string {
  if (value === undefined) return '127.0.0.1';
  if (value !== '127.0.0.1' && value !== '0.0.0.0') throw new Error('NIGHTMAIL_LISTEN_HOST must be 127.0.0.1 or 0.0.0.0');
  if (value === '0.0.0.0' && !inContainer()) {
    throw new Error('NIGHTMAIL_LISTEN_HOST=0.0.0.0 is only allowed inside a Docker container (no /.dockerenv here)');
  }
  return value;
}

/** Address of the registry deployed on that network, from `contracts.json` (written by `deploy-contracts`). */
export function readRegistryAddress(config: Pick<ServerConfig, 'network' | 'dataDir'>): string {
  const file = path.join(config.dataDir, 'contracts.json');
  if (!existsSync(file)) throw new Error(`No deployed contracts for ${config.network}: run \`npm run deploy-contracts -w apps/server\``);
  const contracts = JSON.parse(readFileSync(file, 'utf8')) as { network?: unknown; registry?: { address?: unknown } };
  const address = contracts.registry?.address;
  if (contracts.network !== config.network || typeof address !== 'string' || !/^[0-9a-f]{64}$/.test(address)) {
    throw new Error(`contracts.json does not describe a registry deployed on ${config.network}`);
  }
  return address;
}

/**
 * Mail server configuration. Optional environment variables: NIGHTMAIL_MAIL_DOMAIN,
 * NIGHTMAIL_SMTP_PORT, NIGHTMAIL_API_PORT, NIGHTMAIL_API_URL (public API URL when it is not
 * `http://127.0.0.1:<port>`), NIGHTMAIL_API_TRUSTED_PROXY (1 or 0), NIGHTMAIL_LISTEN_HOST (127.0.0.1 or
 * 0.0.0.0, the latter only inside a container) and NIGHTMAIL_DEBUG=1.
 */
export function loadMailServerConfig(
  config: Pick<ServerConfig, 'network' | 'dataDir'>,
  env: Record<string, string | undefined> = process.env,
  inContainer: () => boolean = inDockerContainer,
): MailServerConfig {
  const registryAddress = readRegistryAddress(config);
  const mailDomain = (env['NIGHTMAIL_MAIL_DOMAIN'] ?? DEFAULT_MAIL_DOMAIN).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(mailDomain)) throw new Error('NIGHTMAIL_MAIL_DOMAIN is not a domain name');
  const apiPort = portFrom(env['NIGHTMAIL_API_PORT'], DEFAULT_API_PORT, 'NIGHTMAIL_API_PORT');
  return {
    registryAddress,
    mailDomain,
    listenHost: listenHostFrom(env['NIGHTMAIL_LISTEN_HOST'], inContainer),
    smtpPort: portFrom(env['NIGHTMAIL_SMTP_PORT'], DEFAULT_SMTP_PORT, 'NIGHTMAIL_SMTP_PORT'),
    apiPort,
    apiBaseUrl: env['NIGHTMAIL_API_URL'] ?? `http://127.0.0.1:${apiPort}`,
    trustedProxy: parseFlag('NIGHTMAIL_API_TRUSTED_PROXY', env['NIGHTMAIL_API_TRUSTED_PROXY']),
    // Next to the operator data but in its own folder: the mail server never touches the wallet.
    databaseFile: path.join(path.dirname(path.dirname(config.dataDir)), 'server', config.network, `${registryAddress}.sqlite`),
    debug: env['NIGHTMAIL_DEBUG'] === '1',
  };
}
