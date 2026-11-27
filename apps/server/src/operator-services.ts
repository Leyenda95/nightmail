// Payer-backed operator services (the `bono` issuer and the public relayer), started
// alongside the mail server in two steps so a permanent error fails before the mail server opens:
// `prepareOperatorServices` checks the payer serves this registry (an unreachable payer is tolerated),
// then `startOperatorServices` runs once the mail server is in sync.
// Limitation: the payer's contract is checked once; /issue should carry it.
import { adaptPayer, type RawPayer } from './issuer/payer-client.ts';
import { type IssuerConfig, loadIssuerConfig, startIssuer } from './issuer/start.ts';
import { errorKind, type Logger } from './log.ts';
import { payerClient, payerSocketPath } from './payer/client.ts';
import type { RelayerDeps } from './relayer/relayer.ts';
import { loadRelayerConfig, type RelayerConfig, startRelayer } from './relayer/start.ts';

type Reply = { status: number; body: unknown };
/** The subset of the payer client (payer/client.ts) used here. */
export type OperatorPayer = RawPayer & RelayerDeps['payer'] & { health(): Promise<Reply> };

/** How long to wait for the payer's `/health` at startup (the client alone would wait up to 30 min). */
export const PAYER_CHECK_TIMEOUT_MS = 5_000;

export type PrepareOptions = {
  /** Operator data directory, where the payer socket lives. */
  dataDir: string;
  /** Registry address (32-byte hex). */
  registry: string;
  log: Logger;
  /** Source of the configs (NIGHTMAIL_ISSUER_*, NIGHTMAIL_RELAYER_*). */
  env: Record<string, string | undefined>;
  /** Tests only: a different payer and timeout. */
  payer?: OperatorPayer;
  timeoutMs?: number;
};

export type OperatorSetup = { payer: OperatorPayer; issuerConfig: IssuerConfig; relayerConfig: RelayerConfig };

export type StartOptions = {
  dataDir: string;
  registry: string;
  log: Logger;
  setup: OperatorSetup;
  /** Listen address of the issuer and the relayer (default 127.0.0.1): the mail server's `listenHost`. */
  host?: string;
  /** Told of each relayed transaction included (registry/settling.ts). */
  onRelayIncluded?: () => void;
};

export type RunningOperatorServices = { issuerPort: number; relayerPort: number; close(): Promise<void> };

/** The payer's `/health`, or throws if it does not answer within `timeoutMs`. */
async function health(payer: OperatorPayer, timeoutMs: number): Promise<Reply> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('payer: no answer in time'), { name: 'Timeout' })), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([payer.health(), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Throws if the payer pays for another registry, or is ready with none. If it cannot tell, warns and continues. */
async function checkPayerContract(payer: OperatorPayer, registry: string, log: Logger, timeoutMs: number): Promise<void> {
  const unknown = (why: string) => log.warn(`payer: could not check its registry contract (${why}); the issuer and the relayer will retry`);
  let body: unknown;
  try {
    ({ body } = await health(payer, timeoutMs));
  } catch (error) {
    return unknown(errorKind(error)); // error kind only: the message may contain the socket path
  }
  const { ready, contract } = (typeof body === 'object' && body !== null ? body : {}) as { ready?: unknown; contract?: unknown };
  if (ready === true && contract === null) throw new Error('payer: it is ready but has no registry contract (it started before the deployment: restart it)');
  if (typeof contract !== 'string' || !/^[0-9a-f]{64}$/.test(contract)) return unknown('not ready');
  if (contract !== registry) throw new Error(`payer: it pays for another registry contract (${contract}, not ${registry})`);
}

/**
 * Closes everything at once and waits for all of it, even if something fails (the mail server does not wait for the
 * issuer to finish an issuance). A failed close is logged by error kind only.
 */
export async function closeTogether(closers: readonly (() => unknown)[], log: Logger): Promise<void> {
  const results = await Promise.allSettled(closers.map(async (close) => close()));
  for (const result of results) if (result.status === 'rejected') log.warn(`closing failed (${errorKind(result.reason)})`);
}

/** Step 1, before the mail server opens: configs and the payer's contract. Throws on permanent errors. */
export async function prepareOperatorServices(options: PrepareOptions): Promise<OperatorSetup> {
  const { dataDir, registry, log, env } = options;
  const issuerConfig = loadIssuerConfig(env);
  const relayerConfig = loadRelayerConfig(env);
  const payer = options.payer ?? payerClient(payerSocketPath(dataDir));
  log.info('payer: checking its registry contract');
  await checkPayerContract(payer, registry, log, options.timeoutMs ?? PAYER_CHECK_TIMEOUT_MS);
  return { payer, issuerConfig, relayerConfig };
}

/** Step 2: starts the issuer and the relayer. If one cannot listen, closes the other and throws. */
export async function startOperatorServices(options: StartOptions): Promise<RunningOperatorServices> {
  const { dataDir, registry, log, setup: { payer, issuerConfig, relayerConfig } } = options;
  const host = options.host === undefined ? {} : { host: options.host };
  const issuer = await startIssuer({
    dataDir, contract: registry, payer: adaptPayer(payer, log), log, config: issuerConfig, ...host,
  });
  try {
    const relayer = await startRelayer({
      dataDir, payer, registry, log, config: relayerConfig, ...host,
      ...(options.onRelayIncluded && { onIncluded: options.onRelayIncluded }),
    });
    return {
      issuerPort: issuer.port,
      relayerPort: relayer.port,
      close: async () => {
        await Promise.allSettled([relayer.close(), issuer.close()]);
      },
    };
  } catch (error) {
    await issuer.close();
    throw error;
  }
}
