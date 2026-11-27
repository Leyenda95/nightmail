// The receiving server end to end on the local devnet (npm run test:devnet -w apps/server): an address
// registered by hand receives mail from demo-mailer, and it is downloaded encrypted with a signed request.
//
// Uses the already deployed NightMailRegistry (.data/operator/undeployed/contracts.json; deploys nothing)
// and the devnet operator wallet: issues a paid `bono` with the operator key and registers addresses with
// real proofs. The server runs in this process, on free ports with a temporary database, and talks to the
// real indexer (`contractActions` subscription and state by height).
// Needs the devnet running, the contracts compiled with keys and the payer stopped (waits if the wallet is
// busy). Leaves new addresses in the devnet registry on every run.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import {
  canonicalHost, ed25519PublicKey, encodeAuthHeaders, generateSecretKey, type MailboxRequest, openMailbox, signRequest,
  x25519PublicKey,
} from '@nightmail/core-ts';
import {
  addrKey, aliasAddrKey, aliasAddress, ctx as ctxOf, idK, Kind, leaf, nameBytes, NO_EXPIRY, Plan, slotNul, toHex,
} from '@nightmail/midnight';
import { run } from '../../../tools/demo-mailer/src/run.ts';
import { loadConfig, readRegistryAddress } from '../src/config.ts';
import { openChain, type Chain, type ChainContract, type Outcome } from '../src/chain/midnight.ts';
import { registryWitnesses, type Bono, type RegistryPrivateState as PS } from '../src/chain/registry.ts';
import { indexerChain, type RunningMailServer, startMailServer } from '../src/mail-server.ts';
import { ensureSpendableDust, openOperatorWallet, type OperatorWallet } from '../src/wallet/operatorWallet.ts';
import { WalletInUseError } from '../src/wallet/storage.ts';

const DOMAIN = 'nightmail.local';
const API_URL = 'http://127.0.0.1:8787'; // the "configured" base URL: its authority is the host that gets signed
const rand = () => new Uint8Array(randomBytes(32));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const config = loadConfig('undeployed');
const R = readRegistryAddress(config);
const opSk = new Uint8Array(Buffer.from(readFileSync(path.join(config.dataDir, 'operator-sk'), 'utf8').trim(), 'hex'));
const ctx = ctxOf(R);
const dir = mkdtempSync(path.join(tmpdir(), 'nightmail-devnet-'));
const databaseFile = path.join(dir, `${R}.sqlite`);
const positions = new Map<string, bigint>();
const logs: string[] = [];
const timings: string[] = [];

let wallet: OperatorWallet;
let chain: Chain;
let registry: ChainContract;
let server: RunningMailServer;
const bono: Bono = { s: rand(), k: 0n, plan: Plan.paid, validUntil: NO_EXPIRY };

type Address = { localPart: string; addrKey: Uint8Array; encSecretKey: Uint8Array; authSecretKey: Uint8Array };
/** All addresses created in this run (to check they never show up in the logs). */
const created: Address[] = [];

const ps = (j: bigint): PS => ({ bono, j, opSk });
const view = () => registry.ledgerState(R);
/** Block time (Unix seconds) of the latest block the indexer has processed. */

function record(label: string, o: Outcome): Outcome {
  timings.push(`${label.padEnd(28)} ${o.status.padEnd(16)} proof ${(o.proveMs / 1000).toFixed(1).padStart(5)} s`);
  return o;
}

async function call(label: string, circuit: string, state: PS, args: unknown[]): Promise<void> {
  const o = record(label, await registry.call(R, circuit, state, args));
  assert.ok(o.ok, `${label}: ${o.status} ${o.error ?? ''}`);
}

async function openWalletWhenFree(): Promise<OperatorWallet> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await openOperatorWallet(config);
    } catch (error) {
      if (!(error instanceof WalletInUseError) || attempt >= 90) throw error;
      if (attempt === 0) console.log('[mail.devnet] the operator wallet is busy: waiting');
      await sleep(10_000);
    }
  }
}

const logger = {
  info: (m: string) => { logs.push(`info ${m}`); },
  warn: (m: string) => { logs.push(`warn ${m}`); },
  debug: (m: string) => { logs.push(`debug ${m}`); },
};

const startServer = () => startMailServer({
  registryAddress: R, mailDomain: DOMAIN, listenHost: '127.0.0.1', smtpPort: 0, apiPort: 0, apiBaseUrl: API_URL,
  databaseFile, chain: indexerChain(config.indexer, config.indexerWS, R), log: logger,
});

/** Fresh keys for an address, as the app would derive them. */
function newKeys() {
  const encSecretKey = generateSecretKey();
  const authSecretKey = generateSecretKey();
  return { encSecretKey, authSecretKey, encPk: x25519PublicKey(encSecretKey), authPk: ed25519PublicKey(authSecretKey) };
}

/** The alias those keys and the `bono` slot `j` will produce. */
function aliasOf(keys: { encPk: Uint8Array; authPk: Uint8Array; encSecretKey: Uint8Array; authSecretKey: Uint8Array }, j: bigint): Address {
  const key = aliasAddrKey(keys.encPk, keys.authPk, slotNul(ctx, bono.s, Kind.alias, j, 0n));
  const address = { localPart: aliasAddress(key), addrKey: key, encSecretKey: keys.encSecretKey, authSecretKey: keys.authSecretKey };
  created.push(address);
  return address;
}

async function createAlias(j: bigint, label = `createAlias (j=${j})`): Promise<Address> {
  const keys = newKeys();
  await call(label, 'createAlias', ps(j), [keys.encPk, keys.authPk]);
  return aliasOf(keys, j);
}

/** Waits until the server knows the address: sync lags a little behind the block. */
async function waitUntilKnown(address: Address, seconds = 120): Promise<void> {
  for (let i = 0; i < seconds * 4; i++) {
    if (server.directory.box(toHex(address.addrKey))) return;
    await sleep(250);
  }
  assert.fail(`the server has not synced the address in ${seconds} s: ${JSON.stringify(server.sync.status)}`);
}

const mail = (...args: string[]) => {
  const out: string[] = [];
  return run(['--port', String(server.smtpPort), ...args], (line) => out.push(line)).then((code) => ({ code, out }));
};

/** A request signed as the app will: with the server's time (GET /v1/time), never its own clock. */
async function signedGet(address: Address, target: string): Promise<Response> {
  const base = `http://127.0.0.1:${server.apiPort}`;
  const { time } = (await (await fetch(`${base}/v1/time`)).json()) as { time: number };
  const request: MailboxRequest = {
    host: canonicalHost(API_URL), version: 1, method: 'GET', path: target, addrKey: address.addrKey, timestamp: time,
    nonce: new Uint8Array(randomBytes(16)),
  };
  const signature = signRequest(address.authSecretKey, request);
  return fetch(`${base}${target}`, { headers: encodeAuthHeaders({ timestamp: time, nonce: request.nonce, signature }) });
}

/**
 * Like the app: if the server refuses (right after startup it rejects requests for 60 s, since it does
 * not remember earlier nonces), wait and retry with a fresh nonce.
 */
async function signedGetWhenReady(address: Address, target: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await signedGet(address, target);
    if (response.status !== 401 || attempt >= 20) return response;
    await sleep(5000);
  }
}

/** Downloads and opens every message in the mailbox. */
async function download(address: Address): Promise<{ raw: Buffer; size: number }[]> {
  const list = await signedGetWhenReady(address, `/v1/box/${toHex(address.addrKey)}/messages?since=0`);
  assert.equal(list.status, 200);
  assert.equal(list.headers.get('cache-control'), 'no-store');
  const { messages } = (await list.json()) as { messages: { id: string; size: number; receivedAt: number }[] };
  const out: { raw: Buffer; size: number }[] = [];
  for (const { id, size } of messages) {
    const response = await signedGet(address, `/v1/box/${toHex(address.addrKey)}/messages/${id}`);
    assert.equal(response.status, 200);
    const envelope = new Uint8Array(await response.arrayBuffer());
    assert.equal(envelope.length, size + 62);
    out.push({ raw: Buffer.from(openMailbox(address.encSecretKey, envelope)), size });
  }
  return out;
}

before(async () => {
  wallet = await openWalletWhenFree();
  await ensureSpendableDust(wallet);
  chain = await openChain(config, wallet);
  registry = await chain.contract('registry', registryWitnesses((leafHex) => positions.get(leafHex)));
  server = await startServer();
  // The `bono` is issued by the operator (as after a simulated card payment). 5 mailboxes + 20 aliases.
  const id = idK(ctx, bono.s, 0n);
  positions.set(toHex(leaf(ctx, id, bono.plan, bono.validUntil)), (await view()).bonos.firstFree());
  await call('issueBono (paid)', 'issueBono', ps(0n), [id, Plan.paid]);
});

after(async () => {
  console.log(`\n[mail.devnet] transactions:\n${timings.join('\n')}`);
  console.log(`\n[mail.devnet] server log:\n${logs.join('\n')}`);
  await server?.close();
  if (wallet) await wallet.close();
  rmSync(dir, { recursive: true, force: true });
});

test('an alias created while the server runs receives mail from the demo-mailer and is downloaded encrypted with a signed request', async () => {
  const nube = await createAlias(0n);
  await waitUntilKnown(nube);
  const to = `${nube.localPart}@${DOMAIN}`;
  const { code, out } = await mail('--to', to, '--to', `${to}=long`, '--to', `no.existe@${DOMAIN}`, '--count', '2', '--size-kb', '300');
  assert.equal(code, 1, out.join('\n'));
  assert.deepEqual(out.map((line) => line.slice(0, 9)), ['ACCEPTED ', 'ACCEPTED ', 'ACCEPTED ', 'ACCEPTED ', 'REJECTED ', 'REJECTED ', '2 failed ']);
  assert.match(out[4]!, /: 550 5\.1\.1 No such mailbox here$/);

  const messages = await download(nube);
  assert.deepEqual(messages.map((m) => m.size), [4096, 4096, 524_288, 524_288]);
  const parsed = await Promise.all(messages.map((m) => simpleParser(m.raw)));
  assert.deepEqual(parsed.map((p) => p.subject), [
    '¡Bienvenido a Tienda Luna!',
    'Factura F-2026-48201 de Suministros Aurora',
    'Informe largo de prueba (300 KiB)',
    'Informe largo de prueba (300 KiB)',
  ]);
  assert.match(parsed[0]!.text!, /usa el código LUNA10/);
  assert.equal(parsed[0]!.to && !Array.isArray(parsed[0]!.to) ? parsed[0]!.to.value[0]!.address : '', to);
  const lines = parsed[2]!.text!.trimEnd().split('\n');
  assert.ok(lines.length > 1000);
  assert.ok(lines.every((line, i) => line.startsWith(`${(i + 1) % 25 === 0 ? '.' : ''}Línea ${i + 1}. Este párrafo`)));

  // Unsigned, signed with another key or for another address: 401.
  const target = `/v1/box/${toHex(nube.addrKey)}/messages?since=0`;
  assert.equal((await fetch(`http://127.0.0.1:${server.apiPort}${target}`)).status, 401);
  assert.equal((await signedGet({ ...nube, authSecretKey: generateSecretKey() }, target)).status, 401);
});

test('a mailbox registered in one transaction (registerMailbox) receives mail by its name', async () => {
  const name = `e2e-${Date.now().toString(36)}`;
  const keys = newKeys();
  const key = addrKey(name);
  await call('registerMailbox', 'registerMailbox', ps(0n), [nameBytes(name), keys.encPk, keys.authPk, new Uint8Array(randomBytes(104))]);
  const box: Address = { localPart: name, addrKey: key, encSecretKey: keys.encSecretKey, authSecretKey: keys.authSecretKey };
  created.push(box);
  await waitUntilKnown(box);

  const { code, out } = await mail('--to', `${name.toUpperCase()}@${DOMAIN}`, '--template', 'attachment', '--name', 'Juan');
  assert.equal(code, 0, out.join('\n'));
  const [message] = await download(box);
  const parsed = await simpleParser(message!.raw);
  assert.match(parsed.subject!, /^Tu pedido #\d+ está en camino 📦$/);
  assert.equal(parsed.attachments[0]!.filename, 'resumen-pedido.csv');
});

test('two aliases sent at once (same block if the node batches them) and one with unusable keys, created while the server is stopped', async () => {
  await server.close();
  const before = logs.length;

  // Two createAlias calls proved against the same state and submitted together.
  const pair = [1n, 2n].map((j) => ({ j, keys: newKeys() }));
  const prepared = [];
  for (const { j, keys } of pair) prepared.push(await registry.prepare(R, 'createAlias', ps(j), [keys.encPk, keys.authPk]));
  const outcomes = await Promise.all(prepared.map((p) => registry.send(p)));
  for (const [i, o] of outcomes.entries()) {
    record(`createAlias (concurrent, j=${pair[i]!.j})`, o);
    // The second may lose on the declared cost or on the DUST coin: it retries on its own, as the app will.
    if (!o.ok) await call(`createAlias (retry, j=${pair[i]!.j})`, 'createAlias', ps(pair[i]!.j), [pair[i]!.keys.encPk, pair[i]!.keys.authPk]);
  }
  const twins = pair.map(({ j, keys }) => aliasOf(keys, j));

  // An alias with a low-order encryption key: the contract accepts it; the server does not deliver to it.
  const weak = { ...newKeys(), encPk: new Uint8Array(32) };
  await call('createAlias (bad key)', 'createAlias', ps(3n), [weak.encPk, weak.authPk]);
  const unusable = aliasOf(weak, 3n);

  server = await startServer(); // does not open its ports until it has every address on chain
  const restart = logs.slice(before);
  assert.ok(restart.some((l) => /chain head is block \d+ with \d+ address\(es\), 3 to sync/.test(l)), restart.join('\n'));
  const blocks = restart.filter((l) => l.includes('new address(es)'));
  assert.ok(blocks.length >= 1 && blocks.length <= 3, `reads only the new blocks, not the whole chain:\n${blocks.join('\n')}`);
  console.log(`[mail.devnet] blocks read after restart:\n${blocks.join('\n')}`);

  for (const twin of twins) assert.ok(server.directory.recipient(twin.localPart), 'both aliases are in the index');
  assert.equal(server.directory.recipient(unusable.localPart), undefined);

  const { code, out } = await mail(
    '--to', `${twins[0]!.localPart}@${DOMAIN}`, '--to', `${twins[1]!.localPart}@${DOMAIN}`, '--to', `${unusable.localPart}@${DOMAIN}`,
    '--template', 'personal',
  );
  assert.equal(code, 1, out.join('\n'));
  assert.deepEqual(out.map((line) => line.slice(0, 9)), ['ACCEPTED ', 'ACCEPTED ', 'REJECTED ', '1 failed ']);
  assert.match(out[2]!, /: 550 5\.1\.1 No such mailbox here$/, 'the same response as for a nonexistent address');
  for (const twin of twins) assert.equal((await download(twin)).length, 1);
  const target = `/v1/box/${toHex(unusable.addrKey)}/messages?since=0`;
  assert.equal((await signedGet(unusable, target)).status, 401, 'nothing is served to it either');
});

test('the server logs carry no addresses or content', () => {
  const all = logs.join('\n');
  const secrets = ['Tienda', 'LUNA10', 'no.existe', ...created.flatMap((a) => [a.localPart, toHex(a.addrKey)])];
  assert.equal(created.length, 5);
  for (const secret of secrets) assert.equal(all.includes(secret), false, secret);
  assert.ok(logs.some((l) => l.startsWith('debug smtp: message stored in 1 mailbox(es)')));
});
