// Startup of the Issuer and its upkeep, launched by operator-services.ts (alongside the relayer)
// from bin/mail-server.ts.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import path from 'node:path';
import { generateSecretKey } from '@nightmail/core-ts';
import type { Logger } from '../log.ts';
import { openDatabase, type Database } from '../storage/db.ts';
import { loadOrCreateSecret } from '../wallet/storage.ts';
import { parseFlag, parseInteger } from '../env.ts';
import { clientKey, isLoopback } from './client-ip.ts';
import { listenOn } from './http.ts';
import { createIssuerServer, type IssuerApiDeps } from './issuer-api.ts';
import { Issuer, type IssuerDeps } from './issuer.ts';
import type { PayerClient } from './payer-client.ts';
import { createReceiptSigner, receiptKeyFingerprint } from './receipt.ts';
import { IssuerStore } from './store.ts';
import { startUpkeep } from './upkeep.ts';

export type IssuerConfig = {
  port: number;
  captchaToken: string;
  cardToken: string;
  /** A trusted proxy sits in front: the client IP is the last X-Forwarded-For entry. */
  trustedProxy: boolean;
  /** Sign-ups (free + paid) per hour in total. */
  globalPerHour: number;
  /** Pending count at which new sign-ups get 503 busy. */
  maxPending: number;
};

const DEMO = { captchaToken: 'nightmail-demo-captcha', cardToken: 'tok_nightmail_demo' };
const HOUR_MS = 3_600_000;
const CLOSE_TIMEOUT_MS = 60_000;

function parseToken(name: string, value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  if (value === '') throw new Error(`${name}: the token cannot be empty`);
  return value;
}

/** Issuer config from the environment. CAPTCHA and card checks are simulated in the MVP with fixed tokens. */
export function loadIssuerConfig(env: Record<string, string | undefined>): IssuerConfig {
  const integer = (name: string, fallback: number, max?: number) => parseInteger(`NIGHTMAIL_ISSUER_${name}`, env[`NIGHTMAIL_ISSUER_${name}`], fallback, 1, max);
  return {
    port: integer('PORT', 8788, 65_535),
    captchaToken: parseToken('NIGHTMAIL_ISSUER_CAPTCHA_TOKEN', env['NIGHTMAIL_ISSUER_CAPTCHA_TOKEN'], DEMO.captchaToken),
    cardToken: parseToken('NIGHTMAIL_ISSUER_CARD_TOKEN', env['NIGHTMAIL_ISSUER_CARD_TOKEN'], DEMO.cardToken),
    trustedProxy: parseFlag('NIGHTMAIL_ISSUER_TRUSTED_PROXY', env['NIGHTMAIL_ISSUER_TRUSTED_PROXY']),
    globalPerHour: integer('GLOBAL_PER_HOUR', 100),
    maxPending: integer('MAX_PENDING', 100),
  };
}

/** Constant-time comparison; hashing first makes it independent of length too. */
function sameToken(expected: string): (given: string) => boolean {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  const want = digest(expected);
  return (given) => timingSafeEqual(digest(given), want);
}

export type StartIssuerOptions = {
  /** Operator data dir (0700): holds the receipt key and `issuer.sqlite`. */
  dataDir: string;
  /** Alternative database file (defaults to `<dataDir>/issuer.sqlite`). */
  dbFile?: string;
  /** Registry contract address (32-byte hex), signed into every receipt. */
  contract: string;
  payer: PayerClient;
  log: Logger;
  config: IssuerConfig;
  host?: string;
  /** Tests only: Issuer delay, sleep, clock and close timeout. */
  issuerOptions?: Partial<Pick<IssuerDeps, 'delayMs' | 'sleep' | 'now' | 'closeTimeoutMs'>>;
  apiOptions?: Partial<Pick<IssuerApiDeps, 'limits' | 'clientKey'>>;
};

export type RunningIssuer = { port: number; issuer: Issuer; close(): Promise<void> };

function warnings({ config, log, host }: StartIssuerOptions): void {
  if (config.captchaToken === DEMO.captchaToken || config.cardToken === DEMO.cardToken) {
    log.warn('issuer: using the demo CAPTCHA/card tokens (the checks are simulated in the MVP)');
  }
  if (!config.trustedProxy && isLoopback(host ?? '127.0.0.1')) {
    log.warn("issuer: listening on loopback without NIGHTMAIL_ISSUER_TRUSTED_PROXY=1: behind a proxy, the per-IP limits see the proxy's address");
  }
}

/** Listens and returns the actual port; on failure (port in use) closes the database and rethrows. */
async function listen(server: Server, db: Database, port: number, host: string): Promise<number> {
  try {
    return await listenOn(server, port, host);
  } catch (error) {
    db.close();
    throw error;
  }
}

function apiDeps(options: StartIssuerOptions): Partial<IssuerApiDeps> {
  const { config, apiOptions } = options;
  return {
    clientKey: apiOptions?.clientKey ?? clientKey(config.trustedProxy),
    limits: { global: { limit: config.globalPerHour, windowMs: HOUR_MS }, maxPending: config.maxPending, ...apiOptions?.limits },
  };
}

export async function startIssuer(options: StartIssuerOptions): Promise<RunningIssuer> {
  const { dataDir, payer, log, config } = options;
  warnings(options);
  const { value: seed } = loadOrCreateSecret(dataDir, 'issuer-receipt-key', generateSecretKey);
  const signer = createReceiptSigner(seed, options.contract);
  const db = openDatabase(options.dbFile ?? path.join(dataDir, 'issuer.sqlite'));
  const store = new IssuerStore(db);
  const issuer = new Issuer({ store, payer, signer, log, closeTimeoutMs: CLOSE_TIMEOUT_MS, ...options.issuerOptions });
  const checks = { captcha: sameToken(config.captchaToken), card: sameToken(config.cardToken) };
  const server = createIssuerServer({ issuer, signer, checks, log, ...apiDeps(options) });
  const port = await listen(server, db, config.port, options.host ?? '127.0.0.1');
  issuer.resume();
  const upkeep = startUpkeep({ store, log, warnPending: Math.ceil(config.maxPending / 2), ...(options.issuerOptions?.now && { now: options.issuerOptions.now }) });
  log.info(`issuer: listening on port ${port} (receipt key ${receiptKeyFingerprint(signer.publicKey)})`);
  return {
    port,
    issuer,
    close: async () => {
      upkeep.stop();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await issuer.close();
      db.close();
    },
  };
}
