// Devnet end to end (npm run test:e2e -w apps/server). The test plays the core against the real sidecar
// (JSON-RPC over stdio) and the server (HTTP): free plan from the Issuer, one-step registration of
// `juan.perez`, 2 aliases, the 3rd rejected. The public relayer pays; the operator wallet is never touched.
// Requires, already running (without NIGHTMAIL_NETWORK they target preprod):
//   NIGHTMAIL_NETWORK=undeployed npm run operator-wallet -w apps/server
//   NIGHTMAIL_NETWORK=undeployed npm run mail-server -w apps/server     (Issuer on 8788, relayer on 8789)
// Optional NIGHTMAIL_ISSUER_RECEIPT_KEY=sha256:... (printed at server startup) also checks the receipt key.
// In-memory server limits allow 3 runs per IP per day (then 429 until restart).
// Not a model for the app: the seed and HKDF labels here are test-only, and the app spaces issuance,
// registration and aliases out in time so they cannot be linked.
import { before, after, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { ed25519PublicKey, toHex, x25519PublicKey } from '@nightmail/core-ts';
import { NO_EXPIRY as MIDNIGHT_NO_EXPIRY } from '@nightmail/midnight';
import {
  CALL_REJECTED, eventually, proveCall as proveCallOf, type Proved, rpcError, seconds, Sidecar,
} from '../../midnight-sidecar/test-devnet/sidecar-process.ts';
import { loadConfig, readRegistryAddress } from '../src/config.ts';
import { RECEIPT_VALIDITY_S } from '../src/issuer/issuer.ts';
import { receiptKeyFingerprint, receiptMessage, SPKI_PREFIX } from '../src/issuer/receipt.ts';
import { payerClient, payerSocketPath } from '../src/payer/client.ts';

const env = process.env;
const ISSUER = `http://127.0.0.1:${env['NIGHTMAIL_ISSUER_PORT'] ?? 8788}`;
const RELAYER = `http://127.0.0.1:${env['NIGHTMAIL_RELAYER_PORT'] ?? 8789}`;
const CAPTCHA = env['NIGHTMAIL_ISSUER_CAPTCHA_TOKEN'] ?? 'nightmail-demo-captcha';
const RECEIPT_KEY = env['NIGHTMAIL_ISSUER_RECEIPT_KEY'];
const NAME = 'juan.perez';
const NO_EXPIRY = Number(MIDNIGHT_NO_EXPIRY); // sent over JSON-RPC as a number (2^32 - 1)
const FREE_ALIASES = 2; // free plan: 1 mailbox + 2 aliases (the contract's slotLimit)
const MAX_RELAY_ATTEMPTS = 4;
const MAX_BUSY_WAIT_S = 60;

const config = loadConfig('undeployed');
const R = readRegistryAddress(config);
const timings: string[] = [];
const note = (label: string, detail: string) => timings.push(`${label.padEnd(36)} ${detail}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- The seed and what the app derives from it (illustrative, see the header) -------------------------

const seed = randomBytes(32);
const derive = (label: string) => new Uint8Array(hkdfSync('sha256', seed, new Uint8Array(0), `nightmail-e2e/${label}`, 32));
const s = toHex(derive('bono/0'));
const witnesses = (j: number) => ({ s, k: 0, plan: 'free', validUntil: NO_EXPIRY, j });

/** Public keys of the address: X25519 (encryption) and Ed25519 (requests), never derived from `s`. */
const addressKeys = (path: string) => ({
  encPk: toHex(x25519PublicKey(derive(`${path}/enc`))),
  authPk: toHex(ed25519PublicKey(derive(`${path}/auth`))),
});

// --- The server over HTTP --------------------------------------------------------------------------

type Reply = { status: number; body: any };

async function post(base: string, route: string, body: object): Promise<Reply> {
  const res = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

/** A status read that must return 200 (a 404, 429 or 500 aborts polling with its body). */
async function postOk(base: string, route: string, body: object): Promise<Reply> {
  const reply = await post(base, route, body);
  assert.equal(reply.status, 200, `${route}: ${JSON.stringify(reply.body)}`);
  return reply;
}

/**
 * The Issuer receipt: signed for this registry and this id, with a reasonable deadline. The app pins the key
 * by its published fingerprint (out of band); here it is compared with NIGHTMAIL_ISSUER_RECEIPT_KEY if set,
 * otherwise only consistency is checked (the fingerprint goes to the timings to match against the server log).
 */
function assertReceipt(reply: any, id: string): void {
  const { receipt } = reply;
  assert.equal(reply.id, id);
  assert.equal(receipt.contract, R, 'the receipt is for the devnet registry');
  assert.ok(receipt.insertBy <= Date.now() / 1000 + RECEIPT_VALIDITY_S + 120, `reasonable insertion deadline: ${receipt.insertBy}`);
  const publicKey = Buffer.from(receipt.publicKey, 'hex');
  const fingerprint = receiptKeyFingerprint(publicKey);
  if (RECEIPT_KEY) assert.equal(fingerprint, RECEIPT_KEY, 'the receipt key is the published one');
  note('issuer: receipt key', RECEIPT_KEY ? `${fingerprint} (checked)` : `${fingerprint} (unchecked)`);
  const message = receiptMessage({ contract: R, id, plan: 'free', period: 'none', insertBy: BigInt(receipt.insertBy) });
  const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, publicKey]), format: 'der', type: 'spki' });
  assert.ok(verify(null, message, key, Buffer.from(receipt.signature, 'hex')), 'receipt signature');
}

type Outcome = { outcome: string; retryAfterS?: number; [k: string]: unknown };

/**
 * One relayer submission and the wait for its ticket (payer queue). 503 = `busy`; a 422
 * `bad-ttl` (the transaction is close to expiry, which happens after several long `busy`) = `expired`,
 * so a fresh one must be proved.
 */
async function submit(label: string, tx: string): Promise<Outcome> {
  const sent = await post(RELAYER, '/v1/relay', { tx });
  if (sent.status === 503) return { outcome: 'busy', retryAfterS: sent.body.retryAfterS };
  if (sent.status === 422 && sent.body.reason === 'bad-ttl') return { outcome: 'expired' };
  assert.equal(sent.status, 202, `${label}: ${JSON.stringify(sent.body)}`);
  const done = await eventually(`the ticket for ${label}`, () => postOk(RELAYER, '/v1/relay/status', { ticket: sent.body.ticket }),
    (r) => r.body.state === 'done', 150, 2000);
  return done.body;
}

/**
 * Proves the call and submits it to the relayer until it lands, with the core's retry semantics: `busy`
 * (not sent) -> wait and resend the same bytes; `expired` or `rejected` -> once, with a new proof (each
 * `rejected` is a fault: 3 per hour block the IP). `unknown`, `failed`, `refused`: failure.
 */
async function proveAndRelay(label: string, call: object): Promise<void> {
  let proved = await proveCall(label, call);
  let reproved = false;
  for (let attempt = 1; ; attempt++) {
    const t0 = performance.now();
    const result = await submit(label, proved.tx);
    note(`relayer: ${label}`, `${result.outcome.padEnd(9)} ${seconds(performance.now() - t0)}`);
    if (result.outcome === 'included') return;
    const busy = result.outcome === 'busy';
    const reprove = !reproved && (result.outcome === 'expired' || result.outcome === 'rejected');
    assert.ok(attempt < MAX_RELAY_ATTEMPTS && (busy || reprove), `${label}: ${JSON.stringify(result)}`);
    if (busy) await sleep(Math.min(result.retryAfterS ?? 5, MAX_BUSY_WAIT_S) * 1000);
    else {
      // Against the same state a state-dependent rejection would repeat (storage margin), so
      // before proving again wait until the indexer is past the block the proof was made against.
      await eventually('a later block', () => snapshot(null, 1), (snap) => snap.blockHeight > proved.blockHeight);
      reproved = true;
      proved = await proveCall(label, call);
    }
  }
}

// --- The sidecar over JSON-RPC ---------------------------------------------------------------------

let sidecar: Sidecar;

const hashes = async (ops: object[]): Promise<string[]> => (await sidecar.call('contract.hashes', { contractAddress: R, ops })).results;
const snapshot = (cursor: object | null = null, limit?: number) => sidecar.call('contract.snapshot', { contractAddress: R, cursor, limit });
/** Proves the call locally (sidecar + proof server); on a retryable failure, asks for another. */
async function proveCall(label: string, call: object): Promise<Proved> {
  const proved = await proveCallOf(sidecar, { contractAddress: R, ...call }, (ms, code) => note(`${label}: error ${code}`, `asking for another (${seconds(ms)})`));
  note(`proof: ${label}`, seconds(proved.proveMs));
  return proved;
}

type Collection = 'addresses';

/** The first entry of the collection matching `match` in the latest state (all pages). */
async function findEntry(collection: Collection, match: (entry: any) => boolean): Promise<any> {
  let cursor = null;
  do {
    const page = await snapshot(cursor);
    const hit = page[collection].find(match);
    if (hit) return hit;
    cursor = page.next;
  } while (cursor);
  return undefined;
}

const addressRecord = (addrKey: string) => findEntry('addresses', (a) => a.addrKey === addrKey);
const recorded = (what: string, addrKey: string) => eventually(what, () => addressRecord(addrKey), (a) => a !== undefined);

before(async () => {
  // The devnet payer, healthy and on this registry: so no free plan is spent against a server that cannot
  // issue (or, worse, against the preprod one).
  const health = await payerClient(payerSocketPath(config.dataDir), 10_000).health().catch(() => undefined);
  const payer = health?.status === 200 ? (health.body as { ready?: boolean; contract?: string | null }) : undefined;
  assert.ok(payer?.ready === true && payer.contract === R,
    `start the devnet payer first (NIGHTMAIL_NETWORK=undeployed npm run operator-wallet -w apps/server): ${JSON.stringify(health?.body)}`);
  const servers = await Promise.allSettled([post(ISSUER, '/v1/bono/status', { id: '00'.repeat(32) }), post(RELAYER, '/v1/relay/status', { ticket: '00'.repeat(16) })]);
  assert.ok(servers.every((r) => r.status === 'fulfilled'),
    `start the server first (NIGHTMAIL_NETWORK=undeployed npm run mail-server -w apps/server): ${ISSUER}, ${RELAYER}`);
  const started = await Sidecar.start();
  sidecar = started.sidecar;
  assert.ok(['contract.hashes', 'contract.snapshot', 'contract.findBonos', 'contract.proveCall'].every((m) => started.methods.includes(m)));
});

after(async () => {
  console.log(`\nEnd-to-end timings (sidecar over stdio, server relayer and payer):\n${timings.join('\n')}`);
  if (sidecar) assert.equal(await sidecar.close(), 0, 'the sidecar exits cleanly when its input is closed');
});

// --- The flow: each step needs the previous one; after a failure the rest is skipped ---------------

let broken = false;

function step(name: string, fn: (t: TestContext) => Promise<void>): void {
  test(name, async (t) => {
    if (broken) return t.skip('a previous step failed');
    try {
      await fn(t);
    } catch (e) {
      broken = true;
      throw e;
    }
  });
}

step('free plan: the Issuer signs the receipt, the payer issues the bono and its leaf appears in the tree', async () => {
  const [id] = await hashes([{ op: 'idK', s, k: 0 }]);
  const asked = await post(ISSUER, '/v1/bono/free', { id, captchaToken: CAPTCHA });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.equal(asked.body.plan, 'free');
  assertReceipt(asked.body, id);

  // After a dropped connection the app repeats the request with the same id: same receipt, no new issuance.
  const again = await postOk(ISSUER, '/v1/bono/free', { id, captchaToken: CAPTCHA });
  assert.deepEqual(again.body.receipt, asked.body.receipt, 'repeating the id returns the same receipt');

  const t0 = performance.now();
  const issued = await eventually('the issued bono', () => postOk(ISSUER, '/v1/bono/status', { id }), (r) => r.body.state !== 'pending', 150, 2000);
  assert.equal(issued.body.state, 'issued');
  assert.deepEqual(issued.body.receipt, asked.body.receipt, 'the status carries the same receipt as the creation');
  note('issuer: free plan issued', seconds(performance.now() - t0));

  const [leaf] = await hashes([{ op: 'leaf', id, plan: 'free', validUntil: NO_EXPIRY }]);
  const found = await eventually('the bono leaf', () => sidecar.call('contract.findBonos', { contractAddress: R, leaves: [leaf] }),
    (r) => r.positions[0] !== null);
  note('findBonos: leaf in the tree', `position ${found.positions[0]} of ${found.leafCount}`);
});

step(`mailbox ${NAME} in one transaction: registerMailbox through the relayer`, async (t) => {
  const [firstKey] = await hashes([{ op: 'addrKey', name: NAME }]);
  // The devnet registry keeps earlier runs: if the name exists, use a new one with the same prefix.
  const name = (await addressRecord(firstKey)) ? `${NAME}.${Date.now().toString(36)}` : NAME;
  t.diagnostic(`mailbox: ${name}`);
  const keys = addressKeys('addr/mailbox/0');
  const nameCipher = randomBytes(104).toString('hex');
  const [nul, addrKey] = await hashes([{ op: 'slotNul', s, kind: 'mailbox', j: 0, gen: 0 }, { op: 'addrKey', name }]);
  assert.equal(await addressRecord(addrKey), undefined, `${name} is free`);

  const t0 = performance.now();
  await proveAndRelay('registerMailbox', { circuit: 'registerMailbox', args: { name, ...keys, nameCipher }, witnesses: witnesses(0) });
  const mailbox = await recorded(name, addrKey);
  assert.deepEqual([mailbox.kind, mailbox.encPk, mailbox.authPk, mailbox.slotNul, mailbox.nameCipher],
    ['mailbox', keys.encPk, keys.authPk, nul, nameCipher]);
  note('mailbox registered', `${name} (${seconds(performance.now() - t0)})`);
});

step(`${FREE_ALIASES} aliases on the free plan, the next one is rejected before being proven`, async () => {
  for (let j = 0; j < FREE_ALIASES; j++) {
    const keys = addressKeys(`addr/alias/${j}`);
    await proveAndRelay(`createAlias j=${j}`, { circuit: 'createAlias', args: keys, witnesses: witnesses(j) });
    const [nul] = await hashes([{ op: 'slotNul', s, kind: 'alias', j, gen: 0 }]);
    const [addrKey] = await hashes([{ op: 'aliasAddrKey', ...keys, slotNul: nul }]);
    const alias = await recorded(`alias ${j}`, addrKey);
    assert.deepEqual([alias.kind, alias.encPk, alias.authPk, alias.slotNul], ['alias', keys.encPk, keys.authPk, nul]);
  }

  // One slot beyond the quota: the sidecar rejects it when running the circuit locally, before proving.
  const extra = { contractAddress: R, circuit: 'createAlias', args: addressKeys(`addr/alias/${FREE_ALIASES}`), witnesses: witnesses(FREE_ALIASES) };
  const { id, result } = sidecar.request('contract.proveCall', extra);
  assert.deepEqual(await rpcError(result), { code: CALL_REJECTED, message: 'Call rejected', data: { reason: 'no-slots-left' } });
  assert.deepEqual(sidecar.stagesOf(id), ['reading-state', 'building'], 'it did not reach the proving stage');

  // A slot already used is not valid either (the other way to ask for "one more alias"). Alias 0 was already
  // seen in the state (`recorded`), so its slot counts as used: rejected on the first try.
  const reused = await rpcError(sidecar.call('contract.proveCall', { ...extra, args: addressKeys('addr/alias/0'), witnesses: witnesses(0) }));
  assert.deepEqual(reused, { code: CALL_REJECTED, message: 'Call rejected', data: { reason: 'slot-already-used' } });
});
