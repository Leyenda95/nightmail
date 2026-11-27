// NightMail operator server: `npm run mail-server -w apps/server`.
// Network from NIGHTMAIL_NETWORK (undeployed | preprod); the contract comes from .data/operator/<network>/contracts.json.
// Starts the receiving server (SMTP + Mailbox API) and, once it is in sync with the chain, the `bono` issuer and the
// public relayer. Those two pay through the payer, a separate process
// (`npm run operator-wallet`); without it they still start and retry. Anything that cannot be fixed without a config
// change (an invalid value, a payer for another registry) is checked before the mail server opens.
import { loadConfig, loadMailServerConfig, redactUrl } from '../config.ts';
import { createLogger } from '../log.ts';
import { indexerChain, startMailServer } from '../mail-server.ts';
import { closeTogether, prepareOperatorServices, startOperatorServices } from '../operator-services.ts';
import { installOutputRedaction } from '../redact.ts';
import { loadEarlyRelayAnswer } from '../payer/config.ts';
import { settlingWindow } from '../registry/settling.ts';

const config = loadConfig();
installOutputRedaction(config.secrets);
const mail = loadMailServerConfig(config);
const log = createLogger(mail.debug);
log.info(`network ${config.network}, registry ${mail.registryAddress}, indexer ${redactUrl(config.indexer)}`);

const stopChain = new AbortController(); // cancels in-flight indexer queries on shutdown
/** What must be closed among the things already started (in parallel: mail does not wait for an in-flight issuance). */
const closers: (() => unknown)[] = [() => stopChain.abort()];
const closeAll = () => closeTogether(closers, log);

// Installed first: a signal during startup closes whatever has finished starting. Anything half-started is not closed
// gracefully, which is acceptable: the mail database survives it, and the issuer's pending issuances are on disk.
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    log.info(`${signal}: closing`);
    void closeAll().then(() => process.exit(0));
  });
}

const setup = await prepareOperatorServices({ dataDir: config.dataDir, registry: mail.registryAddress, log, env: process.env });
// With the payer's early answer on, the relayer tells the mail server when an address may have just been created
// (registry/settling.ts). With it off there is no window: unknown recipients are answered as before.
const inclusions = settlingWindow(loadEarlyRelayAnswer());
try {
  const server = await startMailServer({
    ...mail,
    chain: indexerChain(config.indexer, config.indexerWS, mail.registryAddress, stopChain.signal),
    log,
    ...(inclusions && { settling: () => inclusions.settling() }),
  });
  closers.push(() => server.close());
  const services = await startOperatorServices({
    dataDir: config.dataDir, registry: mail.registryAddress, log, setup, host: mail.listenHost,
    ...(inclusions && { onRelayIncluded: () => inclusions.note() }),
  });
  closers.push(() => services.close());
} catch (error) {
  await closeAll();
  throw error;
}
