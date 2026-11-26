import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadMailServerConfig, readRegistryAddress } from '../src/config.ts';
import { createLogger, silentLogger } from '../src/log.ts';

const root = mkdtempSync(path.join(tmpdir(), 'nightmail-config-'));
after(() => rmSync(root, { recursive: true, force: true }));

const REGISTRY = '0a'.repeat(32);

function operatorDir(network: string, contracts?: unknown): { network: 'undeployed'; dataDir: string } {
  const dataDir = path.join(mkdtempSync(path.join(root, 'd-')), '.data', 'operator', network);
  mkdirSync(dataDir, { recursive: true });
  if (contracts !== undefined) writeFileSync(path.join(dataDir, 'contracts.json'), typeof contracts === 'string' ? contracts : JSON.stringify(contracts));
  return { network: network as 'undeployed', dataDir };
}

const deployed = () => operatorDir('undeployed', { network: 'undeployed', registry: { address: REGISTRY } });

test('defaults: nightmail.local, SMTP 2525 and API 8787 on 127.0.0.1, one database per contract', () => {
  const config = deployed();
  const mail = loadMailServerConfig(config, {});
  assert.deepEqual(mail, {
    registryAddress: REGISTRY,
    mailDomain: 'nightmail.local',
    listenHost: '127.0.0.1',
    smtpPort: 2525,
    apiPort: 8787,
    apiBaseUrl: 'http://127.0.0.1:8787',
    trustedProxy: false,
    databaseFile: path.join(path.dirname(path.dirname(config.dataDir)), 'server', 'undeployed', `${REGISTRY}.sqlite`),
    debug: false,
  });
  assert.ok(mail.databaseFile.endsWith(path.join('.data', 'server', 'undeployed', `${REGISTRY}.sqlite`)));
});

test('environment variables change domain, ports, base URL and debug', () => {
  const mail = loadMailServerConfig(deployed(), {
    NIGHTMAIL_MAIL_DOMAIN: 'Correo.Ejemplo.TEST', NIGHTMAIL_SMTP_PORT: '2600', NIGHTMAIL_API_PORT: '9000',
    NIGHTMAIL_API_URL: 'https://api.ejemplo.test', NIGHTMAIL_DEBUG: '1',
  });
  assert.equal(mail.mailDomain, 'correo.ejemplo.test');
  assert.equal(mail.smtpPort, 2600);
  assert.equal(mail.apiPort, 9000);
  assert.equal(mail.apiBaseUrl, 'https://api.ejemplo.test');
  assert.equal(mail.debug, true);
  assert.equal(loadMailServerConfig(deployed(), { NIGHTMAIL_API_PORT: '9000' }).apiBaseUrl, 'http://127.0.0.1:9000');
  assert.equal(loadMailServerConfig(deployed(), { NIGHTMAIL_DEBUG: 'true' }).debug, false, 'only "1" turns debug on');
});

test('NIGHTMAIL_API_TRUSTED_PROXY: 1 or 0, anything else does not start', () => {
  assert.equal(loadMailServerConfig(deployed(), { NIGHTMAIL_API_TRUSTED_PROXY: '1' }).trustedProxy, true);
  assert.equal(loadMailServerConfig(deployed(), { NIGHTMAIL_API_TRUSTED_PROXY: '0' }).trustedProxy, false);
  for (const value of ['', 'true', 'yes', '2']) {
    assert.throws(() => loadMailServerConfig(deployed(), { NIGHTMAIL_API_TRUSTED_PROXY: value }), /NIGHTMAIL_API_TRUSTED_PROXY/, value);
  }
});

test('rejects malformed ports and domains', () => {
  for (const port of ['0', '65536', '80a', '-1', '', '08080', '1.5']) {
    assert.throws(() => loadMailServerConfig(deployed(), { NIGHTMAIL_SMTP_PORT: port }), /NIGHTMAIL_SMTP_PORT/, port);
    assert.throws(() => loadMailServerConfig(deployed(), { NIGHTMAIL_API_PORT: port }), /NIGHTMAIL_API_PORT/, port);
  }
  assert.equal(loadMailServerConfig(deployed(), { NIGHTMAIL_SMTP_PORT: '65535' }).smtpPort, 65535);
  assert.equal(loadMailServerConfig(deployed(), { NIGHTMAIL_SMTP_PORT: '1' }).smtpPort, 1);
  for (const domain of ['', 'con espacio.test', '-raro.test', 'raro-.', 'a@b.test', 'ñ.test']) {
    assert.throws(() => loadMailServerConfig(deployed(), { NIGHTMAIL_MAIL_DOMAIN: domain }), /NIGHTMAIL_MAIL_DOMAIN/, domain);
  }
});

test('the contract comes from contracts.json of that network, if missing or from another network it does not start', () => {
  assert.equal(readRegistryAddress(deployed()), REGISTRY);
  assert.throws(() => readRegistryAddress(operatorDir('undeployed')), /deploy-contracts/);
  const wrong = [
    { network: 'preprod', registry: { address: REGISTRY } },
    { network: 'undeployed' },
    { network: 'undeployed', registry: {} },
    { network: 'undeployed', registry: { address: REGISTRY.toUpperCase() } },
    { network: 'undeployed', registry: { address: REGISTRY.slice(2) } },
    { network: 'undeployed', registry: { address: `${REGISTRY}00` } },
    { network: 'undeployed', registry: { address: 7 } },
  ];
  for (const contracts of wrong) {
    assert.throws(() => readRegistryAddress(operatorDir('undeployed', contracts)), /does not describe a registry/, JSON.stringify(contracts));
  }
  assert.throws(() => readRegistryAddress(operatorDir('undeployed', '{roto')), SyntaxError);
});

test('createLogger: info and warnings always, debug only when asked', () => {
  const lines: string[] = [];
  const quiet = createLogger(false, (line) => lines.push(line));
  quiet.info('one');
  quiet.warn('two');
  quiet.debug('three');
  const verbose = createLogger(true, (line) => lines.push(line));
  verbose.debug('four');
  assert.deepEqual(lines, ['[mail] one', '[mail] WARN two', '[mail] debug four']);
  silentLogger.info('nothing');
  silentLogger.warn('nothing');
  silentLogger.debug('nothing');
});

test('NIGHTMAIL_LISTEN_HOST: 127.0.0.1 by default, 0.0.0.0 only inside a container, nothing else', () => {
  const container = () => true;
  const host = () => false;
  assert.equal(loadMailServerConfig(deployed(), { NIGHTMAIL_LISTEN_HOST: '0.0.0.0' }, container).listenHost, '0.0.0.0');
  assert.throws(() => loadMailServerConfig(deployed(), { NIGHTMAIL_LISTEN_HOST: '0.0.0.0' }, host), /only allowed inside a Docker container/);
  assert.equal(loadMailServerConfig(deployed(), { NIGHTMAIL_LISTEN_HOST: '127.0.0.1' }, host).listenHost, '127.0.0.1');
  assert.equal(loadMailServerConfig(deployed(), {}, container).listenHost, '127.0.0.1');
  for (const value of ['', 'localhost', '192.168.1.10', '::']) {
    assert.throws(() => loadMailServerConfig(deployed(), { NIGHTMAIL_LISTEN_HOST: value }, container), /NIGHTMAIL_LISTEN_HOST/, value);
  }
});
