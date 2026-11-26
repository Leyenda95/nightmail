// The receiving mail server alone (registry sync through the indexer, SMTP and Mailbox API, delivery route
// included), without the issuer, the relayer or the payer, on free loopback ports and a database of its own. For
// `tools/dev/e2e-send.sh` when the stack's server cannot be used (it predates the delivery route, or it should not be
// touched): the issuer and relayer of the running stack still create the addresses. Not a test itself.
//
//   NIGHTMAIL_NETWORK=undeployed node apps/server/test/serve-mail-server.ts <database file>
//
// Prints the API base URL on the first line of stdout once it is in sync with the chain, and serves until stdin
// closes.
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { loadConfig, loadMailServerConfig } from '../src/config.ts';
import { createLogger } from '../src/log.ts';
import { indexerChain, startMailServer } from '../src/mail-server.ts';

/** A free port on the loopback (the signed host must be known before the server starts). */
async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

const databaseFile = process.argv[2];
if (!databaseFile) throw new Error('usage: serve-mail-server.ts <database file>');

const config = loadConfig();
const [apiPort, smtpPort] = [await freePort(), await freePort()];
const ports = { NIGHTMAIL_API_PORT: String(apiPort), NIGHTMAIL_SMTP_PORT: String(smtpPort) };
const mail = loadMailServerConfig(config, { ...process.env, ...ports });
// The logger writes to stderr: stdout carries only the base URL.
const log = createLogger(mail.debug);
const stop = new AbortController();
const server = await startMailServer({
  ...mail,
  databaseFile,
  chain: indexerChain(config.indexer, config.indexerWS, mail.registryAddress, stop.signal),
  log,
});
process.stdout.write(`${mail.apiBaseUrl}\n`);

const close = () => {
  stop.abort();
  void server.close().then(() => process.exit(0));
};
process.stdin.resume();
process.stdin.on('end', close);
process.on('SIGTERM', close);
process.on('SIGINT', close);
