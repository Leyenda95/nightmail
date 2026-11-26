// Wires the receiving server: RegistrySync + SMTP ingress + MailboxStore + Mailbox API in one process.
// It holds no operator wallet: the payer is a separate process.
//
// Startup order: open the database, load the saved index, start syncing and wait until every address
// currently on chain is known. Only then are the ports opened: an SMTP server with a stale index would
// reject existing addresses with a permanent `550`. Once running, if the sync becomes unhealthy, SMTP
// answers `451` for unknown addresses instead (and the API's delivery route `503`).
//
// The database is compacted once a day (`compact`) so the file no longer records the arrival order
// across mailboxes of what was received up to then.
import type { AddressInfo } from 'node:net';
import { canonicalHost, MemoryNonceStore } from '@nightmail/core-ts';
import { fetchRegistry, type RegistryAt } from '@nightmail/midnight';
import type { DeliverLimits } from './api/deliver.ts';
import { type ApiLimits, createApiServer } from './api/mailbox-api.ts';
import { clientAddress } from './issuer/client-ip.ts';
import { errorKind, type Logger } from './log.ts';
import { MailboxStore } from './mailbox/store.ts';
import { AddressDirectory } from './registry/directory.ts';
import { contractActionSource, httpGraphQL } from './registry/indexer.ts';
import { RegistryStore } from './registry/store.ts';
import { type ActionSource, type Backoff, RegistrySync, waitForHead } from './registry/sync.ts';
import { createSmtpServer, type IngressLimits } from './smtp/ingress.ts';
import { compact, type Database, openDatabase } from './storage/db.ts';

/** Chain state source: the contract actions, and its state at a given height (or the latest). */
export type ChainAccess = { source: ActionSource; fetchAt: (height?: number) => Promise<RegistryAt | null> };

/** How often the database is compacted. Provisional default. */
export const DEFAULT_COMPACT_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * The chain through the Midnight indexer (HTTP and WebSocket). Aborting `signal` cancels in-flight
 * queries (the subscription is cancelled by RegistrySync's own signal).
 */
export function indexerChain(indexer: string, indexerWS: string, registryAddress: string, signal?: AbortSignal): ChainAccess {
  const gql = httpGraphQL(indexer, signal ? { signal } : {});
  return {
    source: contractActionSource(indexerWS, registryAddress),
    fetchAt: (height) => fetchRegistry(gql, registryAddress, height),
  };
}

export type MailServerOptions = {
  registryAddress: string;
  mailDomain: string;
  listenHost: string;
  /** 0 picks any free port (tests). */
  smtpPort: number;
  apiPort: number;
  apiBaseUrl: string;
  databaseFile: string;
  chain: ChainAccess;
  log: Logger;
  ingressLimits?: Partial<IngressLimits>;
  apiLimits?: Partial<ApiLimits>;
  /** Limits of the anonymous delivery route of the API. */
  deliverLimits?: Partial<DeliverLimits>;
  /** A trusted proxy sits in front of the API: its per-IP limits use the last X-Forwarded-For entry (off by default). */
  trustedProxy?: boolean;
  quotaBytes?: number;
  syncBackoff?: Backoff;
  /** If the sync shows no sign of life for this long, SMTP answers 451 for unknown addresses. */
  syncStaleAfterMs?: number;
  compactEveryMs?: number;
  /** Current time in milliseconds (tests). */
  now?: () => number;
};

/** Compacts the database; a failure is logged and does not stop the server. */
function compactLogged(db: Database, log: Logger): void {
  try {
    compact(db);
    log.info('storage: database compacted');
  } catch (error) {
    log.warn(`storage: compaction failed (${errorKind(error)})`);
  }
}

/**
 * Compacts at startup (before the ports open, so it blocks no one) and then every `everyMs`, so a
 * server restarted before that interval still compacts. Returns a stop function.
 */
function scheduleCompaction(db: Database, everyMs: number, log: Logger): () => void {
  compactLogged(db, log);
  const timer = setInterval(() => compactLogged(db, log), everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

export type RunningMailServer = {
  smtpPort: number;
  apiPort: number;
  sync: RegistrySync;
  directory: AddressDirectory;
  mailboxes: MailboxStore;
  close(): Promise<void>;
};

type Listener = { listen(port: number, host: string, done: () => void): unknown; once(event: 'error', listener: (error: Error) => void): unknown };

function listen(server: Listener, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
}

/** `{ [key]: value }`, or `{}` when unset (the options use `exactOptionalPropertyTypes`). */
function given<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

export async function startMailServer(options: MailServerOptions): Promise<RunningMailServer> {
  const { log, chain } = options;
  const now = options.now ?? Date.now;
  const signedHost = canonicalHost(options.apiBaseUrl); // fails at startup if the base URL cannot be signed
  const db = openDatabase(options.databaseFile);
  const stop = new AbortController();
  let syncing: Promise<void> = Promise.resolve();
  const servers: { close(done: () => void): unknown }[] = [];
  let stopCompaction = () => {};
  const close = async () => {
    stop.abort();
    stopCompaction();
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    await syncing;
    db.close();
  };

  try {
    const registry = new RegistryStore(db, options.registryAddress); // throws if the database belongs to another contract
    stopCompaction = scheduleCompaction(db, options.compactEveryMs ?? DEFAULT_COMPACT_EVERY_MS, log);
    const loaded = registry.load();
    if (loaded.problem) log.warn(`registry sync: ${loaded.problem}, syncing again from the first block`);
    const mailboxes = new MailboxStore(db, given('quotaBytes', options.quotaBytes));
    const directory = new AddressDirectory(loaded.index);
    const sync = new RegistrySync({
      ...loaded, store: registry, source: chain.source, fetchAt: chain.fetchAt, log, now,
      ...given('backoff', options.syncBackoff), ...given('staleAfterMs', options.syncStaleAfterMs),
    });
    syncing = sync.run(stop.signal);
    const head = async () => {
      const at = await chain.fetchAt();
      if (at) sync.observeHead(at); // update the round without waiting for the next block read
      return at;
    };
    await waitForHead(loaded.index, head, { signal: stop.signal, log, progress: () => JSON.stringify(sync.status) });

    const smtp = createSmtpServer({
      domain: options.mailDomain, directory, store: mailboxes, log, now, directoryHealthy: () => sync.healthy(),
      ...given('limits', options.ingressLimits),
    });
    const api = createApiServer({
      host: signedHost, directory, store: mailboxes, log, now, directoryHealthy: () => sync.healthy(),
      clientAddress: clientAddress(options.trustedProxy ?? false),
      // In memory: it records its start time, so the API rejects requests that could predate it (replays).
      nonceStore: new MemoryNonceStore(Math.floor(now() / 1000)),
      ...given('limits', options.apiLimits), ...given('deliverLimits', options.deliverLimits),
    });
    servers.push(smtp, { close: (done) => { api.closeAllConnections(); api.close(done); } });
    await listen(smtp, options.smtpPort, options.listenHost);
    await listen(api, options.apiPort, options.listenHost);
    const smtpPort = (smtp.server.address() as AddressInfo).port;
    const apiPort = (api.address() as AddressInfo).port;
    log.info(`SMTP on ${options.listenHost}:${smtpPort} for @${options.mailDomain}; mailbox API on ${options.listenHost}:${apiPort} (signed host ${signedHost})`);
    return { smtpPort, apiPort, sync, directory, mailboxes, close };
  } catch (error) {
    await close();
    throw error;
  }
}
