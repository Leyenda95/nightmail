import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryNonceStore, authenticateRequest } from '../src/authenticate.ts';
import type { AuthContext, NonceEntry, NonceStore } from '../src/authenticate.ts';
import { signRequest } from '../src/request-auth.ts';
import type { MailboxRequest } from '../src/request-auth.ts';
import { ed25519PublicKey } from '../src/keys.ts';
import { fromHex } from '../src/bytes.ts';

const authSk = fromHex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
const authPublicKey = ed25519PublicKey(authSk);
const NOW = 1794873600;
const addrKey = fromHex('621068aeef170d87aab62215f32c563c6ef3d198cf39b86a0fb109c4d2046c54');
const nonceA = fromHex('000102030405060708090a0b0c0d0e0f');
const nonceB = fromHex('100102030405060708090a0b0c0d0e0f');

const request = (change: Partial<MailboxRequest> = {}): MailboxRequest => ({
  host: 'nightmail.local', version: 1, method: 'GET', path: '/v1/box/x/messages', addrKey, timestamp: NOW, nonce: nonceA,
  ...change,
});
const STARTED = NOW - 3600; // started an hour ago; only matters for the restart test
const OK = { ok: true };
const rejected = (reason: string) => ({ ok: false, reason });

/** Spy store: records every call and delegates to an in-memory store. */
function spyStore() {
  const calls: NonceEntry[] = [];
  const inner = new MemoryNonceStore(STARTED);
  const store: NonceStore = {
    startedAt: inner.startedAt,
    insertIfAbsent: (entry) => { calls.push(entry); return inner.insertIfAbsent(entry); },
  };
  return { calls, store };
}

function authenticate(req: MailboxRequest, context: Partial<AuthContext> & { nonceStore: NonceStore }, signature = signRequest(authSk, req)) {
  return authenticateRequest(req, signature, { authPublicKey, now: NOW, ...context });
}

test('accepts a correctly signed request, inside the window and with a new nonce', () => {
  const { calls, store } = spyStore();
  assert.deepEqual(authenticate(request(), { nonceStore: store }), OK);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { addrKey, nonce: nonceA, deadline: NOW + 60, now: NOW });
});

test('rejects a replay of the same request while it is still inside the window', () => {
  const nonceStore = new MemoryNonceStore(STARTED);
  const req = request({ timestamp: NOW + 60 }); // signed with a clock 60 s ahead
  assert.deepEqual(authenticate(req, { nonceStore }), OK);
  assert.deepEqual(authenticate(req, { nonceStore }), rejected('replay'));
  // Still valid 120 s after arrival, so the nonce must still be remembered.
  for (const later of [61, 119, 120]) {
    assert.deepEqual(authenticate(req, { nonceStore, now: NOW + later }), rejected('replay'), `+${later} s`);
  }
  // One second later it is outside the window, nonce or not.
  assert.deepEqual(authenticate(req, { nonceStore, now: NOW + 121 }), rejected('stale'));
});

test('the same nonce on another address, or another nonce on the same one, are different requests', () => {
  const nonceStore = new MemoryNonceStore(STARTED);
  assert.deepEqual(authenticate(request(), { nonceStore }), OK);
  assert.deepEqual(authenticate(request({ nonce: nonceB }), { nonceStore }), OK);
  const otherAddrKey = fromHex('721068aeef170d87aab62215f32c563c6ef3d198cf39b86a0fb109c4d2046c54');
  assert.deepEqual(authenticate(request({ addrKey: otherAddrKey }), { nonceStore }), OK);
  assert.deepEqual(authenticate(request({ timestamp: NOW + 1 }), { nonceStore }), rejected('replay'), 'same nonce with another timestamp');
  assert.equal(nonceStore.size, 3);
});

test('fixed order: time window, then signature, and the nonce only at the end', () => {
  const { calls, store } = spyStore();
  const badSignature = new Uint8Array(64);
  // Outside the window and badly signed: the window check wins.
  assert.deepEqual(authenticate(request({ timestamp: NOW - 61 }), { nonceStore: store }, badSignature), rejected('stale'));
  assert.deepEqual(authenticate(request({ timestamp: NOW + 61 }), { nonceStore: store }), rejected('stale'));
  // Badly signed: nothing is stored, so without the key nobody can fill the store or burn nonces.
  assert.deepEqual(authenticate(request(), { nonceStore: store }, badSignature), rejected('bad-signature'));
  assert.equal(calls.length, 0);
  assert.deepEqual(authenticate(request(), { nonceStore: store }), OK);
  // Replayed and badly signed: the signature check wins.
  assert.deepEqual(authenticate(request(), { nonceStore: store }, badSignature), rejected('bad-signature'));
  assert.equal(calls.length, 1);
});

test('the signature must be made with the address key and over that request', () => {
  const nonceStore = new MemoryNonceStore(STARTED);
  const otherKey = ed25519PublicKey(fromHex('4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb'));
  assert.deepEqual(authenticate(request(), { nonceStore, authPublicKey: otherKey }), rejected('bad-signature'));
  const signature = signRequest(authSk, request());
  assert.deepEqual(authenticate(request({ path: '/v1/box/x/messages/1' }), { nonceStore }, signature), rejected('bad-signature'));
  assert.equal(nonceStore.size, 0);
});

test('the configured tolerance applies to the window and to the nonce deadline', () => {
  const { calls, store } = spyStore();
  assert.deepEqual(authenticate(request({ timestamp: NOW + 6 }), { nonceStore: store, toleranceSeconds: 5 }), rejected('stale'));
  assert.deepEqual(authenticate(request({ timestamp: NOW + 5 }), { nonceStore: store, toleranceSeconds: 5 }), OK);
  assert.equal(calls[0]!.deadline, NOW + 10);
});

test('a timestamp that is not an integer is rejected as stale, without throwing', () => {
  const nonceStore = new MemoryNonceStore(STARTED);
  for (const timestamp of [Number.NaN, 1.5, -1, '1794873600' as never]) {
    assert.deepEqual(authenticate(request({ timestamp }), { nonceStore }, new Uint8Array(64)), rejected('stale'));
  }
});

test('with a store that does not survive a restart, every timestamp ≤ start + tolerance is rejected', () => {
  const startedAt = NOW - 30;
  const nonceStore = new MemoryNonceStore(startedAt);
  assert.equal(nonceStore.startedAt, startedAt);
  // Could have been seen before the restart (arrived at the latest at start-up, up to 60 s ahead).
  for (const timestamp of [NOW - 60, NOW, NOW + 29, NOW + 30]) {
    assert.deepEqual(
      authenticate(request({ timestamp }), { nonceStore }), rejected('stale'), `timestamp ${timestamp - NOW}`,
    );
  }
  assert.deepEqual(authenticate(request({ timestamp: NOW + 31 }), { nonceStore }), OK);
  // 60 s after start-up, a correct clock gets in.
  const later = startedAt + 61;
  assert.deepEqual(authenticate(request({ timestamp: later, nonce: nonceB }), { nonceStore, now: later }), OK);
  // The normal window still applies.
  assert.deepEqual(
    authenticate(request({ timestamp: later + 61, nonce: nonceB }), { nonceStore, now: later }), rejected('stale'),
  );
  // With a different tolerance, the post-start margin is that tolerance.
  assert.deepEqual(
    authenticate(request({ timestamp: startedAt + 5 }), { nonceStore, now: startedAt + 5, toleranceSeconds: 5 }),
    rejected('stale'),
  );
  assert.deepEqual(
    authenticate(request({ timestamp: startedAt + 6, nonce: fromHex('200102030405060708090a0b0c0d0e0f') }),
      { nonceStore, now: startedAt + 6, toleranceSeconds: 5 }),
    OK,
  );
});

test('with a persistent store (startedAt = null) there is no margin after start-up', () => {
  const seen = new Set<string>();
  const persistent: NonceStore = {
    startedAt: null,
    insertIfAbsent: ({ nonce }) => !seen.has(nonce.join()) && Boolean(seen.add(nonce.join())),
  };
  assert.deepEqual(authenticate(request({ timestamp: NOW - 60 }), { nonceStore: persistent }), OK);
  assert.deepEqual(authenticate(request({ timestamp: NOW - 60 }), { nonceStore: persistent }), rejected('replay'));
  assert.deepEqual(authenticate(request({ timestamp: 0, nonce: nonceB }), { nonceStore: persistent, now: 0 }), OK);
});

test('MemoryNonceStore requires a valid start time', () => {
  for (const bad of [undefined, null, Number.NaN, -1, 1.5, '1794873600', Number.POSITIVE_INFINITY]) {
    assert.throws(() => new MemoryNonceStore(bad as never), RangeError, String(bad));
  }
  assert.equal(new MemoryNonceStore(0).startedAt, 0);
});

test('MemoryNonceStore sweeps expired entries at most once per second', () => {
  const store = new MemoryNonceStore(NOW);
  const entry = (n: number, deadline: number, now: number) => ({ addrKey, nonce: Uint8Array.of(n), deadline, now });
  // Entries already expired on arrival (only possible using the store directly): no sweep within the same second.
  assert.equal(store.insertIfAbsent(entry(1, NOW - 1, NOW)), true);
  assert.equal(store.insertIfAbsent(entry(2, NOW - 1, NOW)), true);
  assert.equal(store.size, 2);
  // The next second sweeps once (both go) and not again within that second.
  assert.equal(store.insertIfAbsent(entry(3, NOW, NOW + 1)), true);
  assert.equal(store.size, 1, 'the one that just arrived, also expired, stays until the next sweep');
  assert.equal(store.insertIfAbsent(entry(4, NOW + 100, NOW + 1)), true);
  assert.equal(store.size, 2);
  // If the clock goes backwards there is no sweep and nothing is forgotten early.
  assert.equal(store.insertIfAbsent(entry(5, NOW + 100, NOW)), true);
  assert.equal(store.size, 3);
  assert.equal(store.insertIfAbsent(entry(6, NOW + 100, NOW + 2)), true);
  assert.equal(store.size, 3, 'when the clock moves forward entry 3 goes, entries 4, 5 and 6 remain');
});

test('MemoryNonceStore: check and insert in one step', () => {
  const store = new MemoryNonceStore(STARTED);
  const entry = { addrKey, nonce: nonceA, deadline: NOW + 60, now: NOW };
  assert.equal(store.insertIfAbsent(entry), true);
  assert.equal(store.insertIfAbsent(entry), false);
  assert.equal(store.insertIfAbsent({ ...entry, deadline: NOW + 999 }), false, 'the key is (addrKey, nonce), not the deadline');
  assert.equal(store.size, 1);
  // The key stays distinct when bytes move between addrKey and nonce.
  const shifted = { addrKey: Uint8Array.of(1, 2), nonce: Uint8Array.of(3), deadline: NOW + 60, now: NOW };
  assert.equal(store.insertIfAbsent(shifted), true);
  assert.equal(store.insertIfAbsent({ ...shifted, addrKey: Uint8Array.of(1), nonce: Uint8Array.of(2, 3) }), true);
  assert.equal(store.size, 3);
});

test('MemoryNonceStore: forgets only when now > deadline', () => {
  const store = new MemoryNonceStore(STARTED);
  const entry = { addrKey, nonce: nonceA, deadline: NOW + 60, now: NOW };
  store.insertIfAbsent(entry);
  store.insertIfAbsent({ addrKey, nonce: nonceB, deadline: NOW + 10, now: NOW });
  assert.equal(store.size, 2);
  // Still remembered at the deadline itself.
  assert.equal(store.insertIfAbsent({ ...entry, now: NOW + 60 }), false);
  assert.equal(store.size, 1, 'the one with deadline NOW + 10 is already forgotten');
  // One second later it is forgotten and the same key is accepted again.
  assert.equal(store.insertIfAbsent({ ...entry, deadline: NOW + 200, now: NOW + 61 }), true);
  assert.equal(store.size, 1);
});
