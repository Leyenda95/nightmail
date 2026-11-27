// NightMail payer process: the sole holder of the operator wallet.
// - Keeps the wallet synced and registers incoming faucet NIGHT for DUST generation.
// - Serves the local API (Unix socket `<dataDir>/payer.sock`, 0600; payer/api.ts) through which the server
//   asks it to pay: relay and issueBono. Everything that spends DUST, NIGHT registration
//   included, goes through a single serial queue (payer/payer.ts).
//
// Runs as a systemd user service (tools/operator-wallet-service.sh).
// Exit codes:
//   0  orderly stop (SIGTERM/SIGINT)
//   1  transient failure or hung wallet → systemd restarts it
//   78 permanent configuration error (permissions, seed, network, keys, journal) → systemd does not restart
import { loadConfig, redactUrl } from '../config.ts';
import { installOutputRedaction } from '../redact.ts';
import { PayerSocketError, startPayerApi, type PayerApi } from '../payer/api.ts';
import { payerClient, payerSocketPath } from '../payer/client.ts';
import { loadPayerLimits } from '../payer/config.ts';
import { IssueJournal, JournalUnreadableError } from '../payer/journal.ts';
import { Payer, type PayerLimits, type PayerLog } from '../payer/payer.ts';
import { openPayerPorts, PayerConfigError } from '../payer/ports.ts';
import { InsecurePermissionsError } from '../wallet/storage.ts';
import {
  balancesLine, hasSpendableDust, openOperatorWallet, registerNightForDust, waitForSync,
  type OperatorWallet,
} from '../wallet/operatorWallet.ts';

const CHECK_EVERY_MS = 5 * 60_000;
const SYNC_TIMEOUT_MS = 20 * 60_000;
const REGISTER_TIMEOUT_MS = 35 * 60_000;
const EX_CONFIG = 78;
/**
 * How long shutdown waits for the queue's in-progress operation (a normal one takes ~20 s). Together with
 * the API (2 s) and the wallet (10 s) it fits in the unit's TimeoutStopSec=90 (tools/operator-wallet-service.sh).
 */
const PAYER_STOP_MS = 60_000;

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message.slice(0, 300)}` : 'unknown error';
}

const log: PayerLog = {
  info: (message) => console.log(`[payer] ${message}`),
  warn: (message) => console.error(`[payer] WARN ${message}`),
};

let config: ReturnType<typeof loadConfig>;
let limits: PayerLimits;
try {
  config = loadConfig();
  limits = loadPayerLimits();
} catch (err) {
  console.error('[payer] configuration error:', describe(err));
  process.exit(EX_CONFIG);
}
// Before anything else: no secret may reach stdout/stderr.
installOutputRedaction(config.secrets);

/**
 * What to close on shutdown, in closing order: each resource is prepended when opened, so the API closes
 * first (nothing new comes in), then the queue stops (queued work is dropped; the running operation is
 * awaited) and finally the wallet. Anything still in flight is recorded in the journal or resolved by the
 * wallet on the next start.
 */
const closers: { name: string; close: () => Promise<void> }[] = [];
/** Closes `resource` on shutdown, waiting at most `ms`; if it does not finish in time, logs it and moves on. */
const closeOnShutdown = (name: string, ms: number, resource: { close(): Promise<unknown> }) =>
  closers.unshift({
    name,
    close: async () => {
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<boolean>((r) => { timer = setTimeout(() => r(true), ms); });
      const isLate = await Promise.race([resource.close().then(() => false), late]).finally(() => clearTimeout(timer));
      if (isLate) console.error(`[payer] WARN ${name}: not closed after ${ms / 1000} s, going on`);
    },
  });
/** Closes (and reports) only what was actually opened. A failure closing one thing does not stop the rest. */
async function closeAll(): Promise<void> {
  if (closers.length === 0) return;
  console.log(`[payer] closing: ${closers.map((c) => c.name).join(', ')}...`);
  for (const { name, close } of closers) {
    await close().catch((err: unknown) => console.error(`[payer] error while closing ${name}:`, describe(err)));
  }
}
let stopping: Promise<unknown> | undefined;
/** Orderly shutdown and exit, run once even if more signals or errors arrive meanwhile. */
const shutdown = (code: number): Promise<never> =>
  (stopping ??= closeAll().catch((err: unknown) => console.error('[payer] error while closing:', describe(err))))
    .then(() => process.exit(code));

// Node writes uncaught exceptions straight to fd 2, bypassing the secret filter,
// so they are caught here and logged through it.
process.on('uncaughtException', (err) => {
  console.error('[payer] uncaught exception:', describe(err));
  void shutdown(1);
});
process.on('unhandledRejection', (err) => {
  console.error('[payer] unhandled rejection:', describe(err));
  void shutdown(1);
});
// Installed at startup with `on`: a second signal does not skip the orderly shutdown (it waits for the running one).
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

/** Awaits with a deadline. Only for operations that can be abandoned without side effects (reads). */
async function withTimeout<T>(name: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs / 60_000} min`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const PERMANENT = [InsecurePermissionsError, PayerConfigError, JournalUnreadableError, PayerSocketError];

console.log(`[payer] network ${config.network}, indexer ${redactUrl(config.indexer)}`);
// Another payer answering on the socket holds the wallet. The lock cannot always tell: a second container of the
// same service (`docker compose run payer`) has the same host name and pid. A socket that does not answer in
// time is not proof that nobody is there either.
const other = await payerClient(payerSocketPath(config.dataDir), 3000).health().then(() => 'answers', (err: unknown) =>
  (err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? null : describe(err));
if (other) {
  console.error(`[payer] another payer seems to be running on ${payerSocketPath(config.dataDir)} (${other}). Not starting.`);
  process.exit(EX_CONFIG);
}
try {
  const journal = IssueJournal.open(config.dataDir); // first: if it cannot be understood, do not start
  const wallet: OperatorWallet = await openOperatorWallet(config); // takes the directory's single-instance lock
  closeOnShutdown('the wallet (saving its state)', 10_000, wallet);
  console.log(`[payer] FAUCET ADDRESS (unshielded): ${wallet.address}`);

  // The API answers right away (/health with ready:false) even if the first sync takes hours.
  let payer: Payer | undefined;
  closeOnShutdown('the payer queue (waiting for the operation in progress)', PAYER_STOP_MS, { close: async () => payer?.stop() });
  const api: PayerApi = await startPayerApi({ socketPath: payerSocketPath(config.dataDir), payer: () => payer, log });
  closeOnShutdown('the local API', 2_000, api);
  log.info(`local API listening on ${payerSocketPath(config.dataDir)}`);

  let state = await waitForSync(wallet);
  console.log(`[payer] ${balancesLine(state)}`);
  const active = new Payer({
    ports: await openPayerPorts(config, wallet, log), journal, limits, log,
    // A hung job blocks the queue: exit so systemd restarts (the journal covers issuances).
    onStuck: () => void shutdown(1),
  });
  payer = active;
  log.info(`paying: relay cap ${limits.relayDustPerHour} and issue cap ${limits.issueDustPerHour} DUST units per hour, `
    + `queue of ${limits.maxQueue}, ${journal.size} issue(s) in flight, registry ${active.health().contract ?? 'not deployed'}, `
    + `early relay answer ${limits.earlyRelayAnswer ? 'ON (in a block)' : 'off (when final)'}`);

  while (!stopping) {
    // Watchdog: if the wallet is not synced again within SYNC_TIMEOUT_MS, assume
    // it is hung and exit so systemd restarts it.
    state = await withTimeout('waitForSyncedState', SYNC_TIMEOUT_MS, () => wallet.facade.waitForSyncedState());

    // Registering NIGHT spends coins and the SDK cannot cancel it: on timeout it is
    // not retried (it could spend the same coins twice); instead the process exits
    // and systemd restarts it from the saved state. The spending part goes through
    // the single queue, like everything else.
    const registered = await withTimeout('registerNightForDust', REGISTER_TIMEOUT_MS,
      () => registerNightForDust(wallet, state, (spend) => active.exclusive(spend)))
      .catch((err: unknown) => {
        if (err instanceof Error && err.message.includes('timed out')) throw err;
        console.error('[payer] DUST registration failed, will retry:', describe(err));
        return false;
      });
    if (registered) console.log('[payer] NIGHT registered; DUST will accrue over the next hours');
    console.log(`[payer] ${balancesLine(state)}${hasSpendableDust(state) ? ' — ready to pay fees' : ''}`);
    await new Promise((r) => setTimeout(r, CHECK_EVERY_MS));
  }
} catch (err) {
  const permanent = PERMANENT.some((kind) => err instanceof kind) || (err instanceof Error && /not a valid seed/.test(err.message));
  console.error(`[payer] fatal${permanent ? ' (configuration, not restarting)' : ', exiting so systemd restarts it'}:`, describe(err));
  await shutdown(permanent ? EX_CONFIG : 1);
}
