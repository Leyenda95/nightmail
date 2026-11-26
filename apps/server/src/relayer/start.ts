// Startup of the public relayer, launched by operator-services.ts (alongside the Issuer) from bin/mail-server.ts.
// Without an injected `payer`, it talks to the local payer over its socket (`payerSocketPath(dataDir)`).
import { Transaction } from '@midnightntwrk/ledger-v9';
import { parseFlag, parseInteger } from '../env.ts';
import { clientKey, isLoopback } from '../issuer/client-ip.ts';
import { listenOn } from '../issuer/http.ts';
import type { Logger } from '../log.ts';
import { payerClient, payerSocketPath } from '../payer/client.ts';
import { createRelayerServer, type RelayerApiDeps } from './relayer-api.ts';
import { DEFAULT_RELAYER_LIMITS, Relayer, type RelayerDeps, type RelayerLimits } from './relayer.ts';

/** The RelayerLimits defaults (DEFAULT_RELAYER_LIMITS) are provisional. */
export type RelayerConfig = RelayerLimits & {
  port: number;
  /** A trusted proxy sits in front: the client IP is the last X-Forwarded-For entry. */
  trustedProxy: boolean;
  /** The random delay before forwarding ranges from 0 to this. */
  maxDelayMs: number;
  maxInFlight: number;
};

export function loadRelayerConfig(env: Record<string, string | undefined>): RelayerConfig {
  const integer = (name: string, fallback: number, min = 1, max?: number) =>
    parseInteger(`NIGHTMAIL_RELAYER_${name}`, env[`NIGHTMAIL_RELAYER_${name}`], fallback, min, max);
  const d = DEFAULT_RELAYER_LIMITS;
  return {
    port: integer('PORT', 8789, 1, 65_535),
    trustedProxy: parseFlag('NIGHTMAIL_RELAYER_TRUSTED_PROXY', env['NIGHTMAIL_RELAYER_TRUSTED_PROXY']),
    perIpPerHour: integer('PER_IP_PER_HOUR', d.perIpPerHour),
    globalPerHour: integer('GLOBAL_PER_HOUR', d.globalPerHour),
    attemptsPerIpPerHour: integer('ATTEMPTS_PER_IP_PER_HOUR', d.attemptsPerIpPerHour),
    faultsPerIpPerHour: integer('FAULTS_PER_IP_PER_HOUR', d.faultsPerIpPerHour),
    rejectedPerHour: integer('REJECTED_PER_HOUR', d.rejectedPerHour),
    maxDelayMs: integer('MAX_DELAY_MS', 20_000, 0),
    maxInFlight: integer('MAX_IN_FLIGHT', 8),
  };
}

/** Same markers the payer uses to deserialize client transactions (payer/ports.ts). */
const parseTransaction = (bytes: Uint8Array): object => Transaction.deserialize('signature', 'proof', 'pre-binding', bytes);

export type StartRelayerOptions = {
  /** Operator data dir; the payer socket is derived from it when `payer` is not given. */
  dataDir: string;
  payer?: RelayerDeps['payer'];
  /** Registry address (32-byte hex). */
  registry: string;
  log: Logger;
  config?: RelayerConfig;
  host?: string;
  /** Tests only: alternative deserialization, and the service's clock, randomness and sleep. */
  parse?: RelayerDeps['parse'];
  relayerOptions?: Partial<Pick<RelayerDeps, 'random' | 'sleep' | 'now'>>;
  apiOptions?: Partial<Pick<RelayerApiDeps, 'limits' | 'clientKey' | 'now'>>;
};

export type RunningRelayer = { port: number; relayer: Relayer; close(): Promise<void> };

export async function startRelayer(options: StartRelayerOptions): Promise<RunningRelayer> {
  const { log, registry } = options;
  const config = options.config ?? loadRelayerConfig({});
  const host = options.host ?? '127.0.0.1';
  if (!config.trustedProxy && isLoopback(host)) {
    log.warn("relayer: listening on loopback without NIGHTMAIL_RELAYER_TRUSTED_PROXY=1: behind a proxy, the per-IP limits see the proxy's address");
  }
  const { port: _port, trustedProxy: _proxy, maxDelayMs, maxInFlight, ...limits } = config;
  const relayer = new Relayer({
    payer: options.payer ?? payerClient(payerSocketPath(options.dataDir)),
    registry, parse: options.parse ?? parseTransaction, log, limits, maxDelayMs, maxInFlight, ...options.relayerOptions,
  });
  const server = createRelayerServer({ relayer, log, clientKey: clientKey(config.trustedProxy), ...options.apiOptions });
  const port = await listenOn(server, config.port, host);
  log.info(`relayer: listening on port ${port}`);
  return {
    port,
    relayer,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await relayer.close();
    },
  };
}
