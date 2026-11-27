// Which client transactions the public relayer accepts: exactly one call to our registry (registerMailbox
// or createAlias), moving no value, with no fallible transcript (so a failure is a node
// rejection with no fee) and a ttl that leaves time to land in a block. The node checks the proof and the
// execution. ledger-v9 shapes (their fields), as in relayable.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRelayable, intentTtlMs, RELAYABLE_CIRCUITS, TTL_MAX_AHEAD_MS, TTL_MIN_AHEAD_MS } from '../src/relayer/validate.ts';

const REGISTRY = 'ab'.repeat(32);
const NOW = 1_800_000_000_000;
const MIN = 60_000;
const call = (o: Record<string, unknown> = {}) => ({
  address: REGISTRY, entryPoint: 'createAlias', guaranteedTranscript: {}, fallibleTranscript: undefined, ...o,
});
const txOf = (...actions: object[]) => ({ intents: new Map([[7, { actions, ttl: new Date(NOW + 30 * MIN) }]]) });
const check = (tx: Parameters<typeof checkRelayable>[0]) => checkRelayable(tx, REGISTRY, NOW);

test('relayer: a call to each allowed circuit of our registry, guaranteed only → accepted', () => {
  assert.deepEqual([...RELAYABLE_CIRCUITS], ['registerMailbox', 'createAlias']);
  for (const entryPoint of RELAYABLE_CIRCUITS) assert.equal(check(txOf(call({ entryPoint }))), null, entryPoint);
});

test('relayer: the circuit name may come as bytes (ledger-v9: string | Uint8Array)', () => {
  assert.equal(check(txOf(call({ entryPoint: new TextEncoder().encode('registerMailbox') }))), null);
  assert.equal(check(txOf(call({ entryPoint: new TextEncoder().encode('issueBono') }))), 'wrong-circuit');
});

test('relayer: as bytes, neither a leading BOM nor invalid UTF-8 passes as an allowed circuit', () => {
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('createAlias')]);
  assert.equal(check(txOf(call({ entryPoint: bom }))), 'wrong-circuit', 'the BOM is not stripped');
  const invalid = new Uint8Array([...new TextEncoder().encode('createAlias'), 0xff]);
  assert.equal(check(txOf(call({ entryPoint: invalid }))), 'wrong-circuit');
});

test('relayer: another registry circuit (the operator ones or buyBono) → wrong-circuit', () => {
  for (const entryPoint of ['issueBono', 'setPrice', 'buyBono', 'createalias', '']) {
    assert.equal(check(txOf(call({ entryPoint }))), 'wrong-circuit', entryPoint);
  }
});

test('relayer: another contract → wrong-contract', () => {
  assert.equal(check(txOf(call({ address: 'cd'.repeat(32) }))), 'wrong-contract');
});

test('relayer: with a fallible transcript (a failure would charge a fee) → fallible-transcript', () => {
  assert.equal(check(txOf(call({ fallibleTranscript: {} }))), 'fallible-transcript');
});

test('relayer: no call, two calls, two intents or an action that is not a call → not-one-call', () => {
  assert.equal(check({}), 'not-one-call');
  assert.equal(check(txOf()), 'not-one-call');
  assert.equal(check(txOf(call(), call())), 'not-one-call');
  const intent = { actions: [call()], ttl: new Date(NOW + 30 * MIN) };
  assert.equal(check({ intents: new Map([[1, intent], [2, intent]]) }), 'not-one-call');
  const deploy = { address: REGISTRY }; // a deploy or maintenance update has no entryPoint
  assert.equal(check(txOf(deploy)), 'not-one-call');
});

test('relayer: anything that moves value (offers, DUST) → moves-value, even if the call is fine', () => {
  const intent = (extra: object) => ({ intents: new Map([[1, { actions: [call()], ttl: new Date(NOW + 30 * MIN), ...extra }]]) });
  assert.equal(check(intent({ guaranteedUnshieldedOffer: {} })), 'moves-value');
  assert.equal(check(intent({ fallibleUnshieldedOffer: {} })), 'moves-value');
  assert.equal(check(intent({ dustActions: {} })), 'moves-value');
  assert.equal(check({ ...intent({}), guaranteedOffer: {} }), 'moves-value');
  assert.equal(check({ ...intent({}), fallibleOffer: new Map([[1, {}]]) }), 'moves-value');
});

test('relayer: a rewards transaction is not a call → not-one-call', () => {
  assert.equal(check({ ...txOf(call()), rewards: {} }), 'not-one-call');
});

// An intent that expires within seconds ends up `unknown` (counts against the cap without being charged and
// frees the slot). The app sets ttl = (block time + 30 min) rounded down to 10 min (sidecar, callTtl), so
// [now+10, now+35] min is required.
test('relayer: intent ttl between now+10 min and now+35 min (both included), outside → bad-ttl', () => {
  assert.deepEqual([TTL_MIN_AHEAD_MS, TTL_MAX_AHEAD_MS], [10 * MIN, 35 * MIN]);
  const withTtl = (ttl: unknown) => ({ intents: new Map([[1, { actions: [call()], ttl }]]) });
  assert.equal(check(withTtl(new Date(NOW + 10 * MIN))), null);
  assert.equal(check(withTtl(new Date(NOW + 35 * MIN))), null);
  assert.equal(check(withTtl(new Date(NOW + 10 * MIN - 1))), 'bad-ttl');
  assert.equal(check(withTtl(new Date(NOW + 35 * MIN + 1))), 'bad-ttl');
  assert.equal(check(withTtl(new Date(NOW - MIN))), 'bad-ttl', 'already expired');
  for (const odd of [undefined, NOW + 30 * MIN, new Date(Number.NaN)]) assert.equal(check(withTtl(odd)), 'bad-ttl', String(odd));
});

test('relayer: the ttl is checked after the shape (a shape reason takes priority)', () => {
  const bad = { intents: new Map([[1, { actions: [call({ entryPoint: 'issueBono' })], ttl: new Date(NOW) }]]) };
  assert.equal(check(bad), 'wrong-circuit');
});

test('intentTtlMs: the ttl of the single intent in ms, or undefined if there is none with a valid date', () => {
  assert.equal(intentTtlMs(txOf(call())), NOW + 30 * MIN);
  assert.equal(intentTtlMs({}), undefined);
  assert.equal(intentTtlMs({ intents: new Map([[1, { actions: [], ttl: 5 }]]) }), undefined);
  assert.equal(intentTtlMs({ intents: new Map([[1, { ttl: new Date(1) }], [2, { ttl: new Date(1) }]]) }), undefined);
});
