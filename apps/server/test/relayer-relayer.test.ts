// The public relayer service: queue with random delay, forwarding to the payer and mapping its reply to a
// ticket. Everything uses doubles (parse, payer, sleep, randomness, clock): no network, no timers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RELAYER_LIMITS, MAX_TX_BYTES, Relayer, type RelayerDeps } from '../src/relayer/relayer.ts';
import { capturingLogger } from './smtp-helpers.ts';

const REGISTRY = 'ab'.repeat(32);
const HOUR = 3_600_000;
const MIN = 60_000;
const T0 = 1_000_000;

/**
 * Test transaction. The first byte picks the shape: ee is not a tx; dd calls another circuit; bb expires in
 * 5 min; b4 expires in 34 min (the rest in 30); cc does not expose its identifiers; c0 has none. Identifiers
 * come only from the second byte, so `aa 01` and `aa 01 99` are the same intent with different bytes (another
 * proof). The ttl lives in the bytes (as in reality): fixed on first read and unchanged afterwards.
 */
function fakeParse(clock: { now: number }, parsed: number[], freed: number[]) {
  const ttls = new Map<string, number>();
  return (bytes: Uint8Array) => {
    parsed.push(bytes[1] ?? -1);
    if (bytes[0] === 0xee) throw new Error('not a tx');
    const entryPoint = bytes[0] === 0xdd ? 'issueBono' : 'createAlias';
    const ttlMin = bytes[0] === 0xbb ? 5 : bytes[0] === 0xb4 ? 34 : 30;
    const hex = Buffer.from(bytes).toString('hex');
    if (!ttls.has(hex)) ttls.set(hex, clock.now + ttlMin * MIN);
    return {
      intents: new Map([[1, { actions: [{ address: REGISTRY, entryPoint, fallibleTranscript: undefined }], ttl: new Date(ttls.get(hex)!) }]]),
      identifiers: () => {
        if (bytes[0] === 0xcc) throw new Error('no identifiers');
        return bytes[0] === 0xc0 ? [] : [`id-${bytes[1]}`];
      },
      free: () => { freed.push(bytes[1] ?? -1); },
    };
  };
}
const tx = (n: number, first = 0xaa, ...rest: number[]) => Buffer.from([first, n, ...rest]).toString('hex');

type Reply = { status: number; body: unknown };
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r)); };
const INCLUDED: Reply = { status: 200, body: { status: 'SucceedEntirely', txHash: 'f1' } };
const REJECTED: Reply = { status: 200, body: { status: 'rejected', code: 115 } };
const withCode = (code: string) => Object.assign(new Error(`connect ${code}`), { code });

function setup(over: Partial<RelayerDeps> = {}, reply: Reply | Error | (() => Reply) = INCLUDED) {
  const logs: string[] = [];
  const sent: string[] = [];
  const sleeps: number[] = [];
  const parsed: number[] = [];
  const freed: number[] = [];
  const clock = { now: T0 };
  const relayer = new Relayer({
    payer: {
      relay: async (hex) => {
        sent.push(hex);
        if (reply instanceof Error) throw reply;
        return typeof reply === 'function' ? reply() : reply;
      },
    },
    registry: REGISTRY, parse: fakeParse(clock, parsed, freed), random: () => 0.5, sleep: async (ms) => { sleeps.push(ms); },
    now: () => clock.now, log: capturingLogger(logs), ...over,
  } as RelayerDeps);
  return { relayer, logs, sent, sleeps, clock, parsed, freed };
}

/** A promise resolved on demand, to hold back a forward or a sleep. */
function gate<T = void>() {
  let open!: (v: T) => void;
  const promise = new Promise<T>((r) => { open = r; });
  return { promise, open };
}

/** The ticket; fails if there is none (an error must never pass for "some other ticket"). */
const ticketOf = (r: unknown) => {
  assert.ok(typeof r === 'object' && r !== null && 'ticket' in r, `expected a ticket: ${JSON.stringify(r)}`);
  return (r as { ticket: string }).ticket;
};
const RATE_LIMITED = { error: 'rate-limited', retryAfterS: 3600 };
/** The same bytes once no longer held and their ttl leaves no margin (how everything held ends up in reality). */
const BAD_TTL = { error: 'not-relayable', reason: 'bad-ttl' };
const BUSY = { error: 'busy', retryAfterS: 60 };

test('relayer: default limits (provisional) and a 32 KiB maximum size', () => {
  assert.deepEqual(DEFAULT_RELAYER_LIMITS, { perIpPerHour: 20, globalPerHour: 300, attemptsPerIpPerHour: 60, faultsPerIpPerHour: 3, rejectedPerHour: 100 });
  assert.equal(MAX_TX_BYTES, 32 * 1024);
});

test('relayer: malformed hex (uppercase, odd, not hex, empty, > 32 KiB) → bad-request, without deserializing', () => {
  const { relayer, parsed } = setup();
  for (const bad of ['AA01', 'aa0', 'zz', '', 'aa'.repeat(32 * 1024 + 1)]) {
    assert.deepEqual(relayer.submit(bad, 'k'), { error: 'bad-request' }, bad.slice(0, 8));
  }
  assert.deepEqual(parsed, []);
});

test('relayer: exactly 32 KiB is accepted when parsing', () => {
  const { relayer } = setup();
  assert.ok('ticket' in relayer.submit('aa'.repeat(32 * 1024), 'k'));
});

test('relayer: parse throws → invalid-tx, checkRelayable rejects → not-relayable with the reason (also bad-ttl)', () => {
  const { relayer } = setup();
  assert.deepEqual(relayer.submit(tx(1, 0xee), 'k'), { error: 'invalid-tx' });
  assert.deepEqual(relayer.submit(tx(1, 0xdd), 'k'), { error: 'not-relayable', reason: 'wrong-circuit' });
  assert.deepEqual(relayer.submit(tx(1, 0xbb), 'k'), { error: 'not-relayable', reason: 'bad-ttl' });
});

test('relayer: if the identifiers cannot be read, or there are none → invalid-tx', () => {
  const { relayer } = setup();
  assert.deepEqual(relayer.submit(tx(1, 0xcc), 'k'), { error: 'invalid-tx' });
  assert.deepEqual(relayer.submit(tx(1, 0xc0), 'k'), { error: 'invalid-tx' });
});

test('relayer: every deserialized transaction is freed (free), accepted or not', () => {
  const { relayer, freed } = setup({ sleep: () => new Promise(() => {}) });
  relayer.submit(tx(1), 'k');
  relayer.submit(tx(2, 0xdd), 'k');
  relayer.submit(tx(3, 0xbb), 'k');
  relayer.submit(tx(4, 0xcc), 'k');
  relayer.submit(tx(5, 0xee), 'k'); // never became a transaction: nothing to free
  relayer.submit(tx(1, 0xaa, 0x99), 'k'); // duplicate
  assert.deepEqual(freed, [1, 2, 3, 4, 1]);
});

test('relayer: 16-byte hex ticket, queued while waiting and done when finished (included)', async () => {
  const hold = gate();
  const { relayer, sent } = setup({ sleep: () => hold.promise });
  const result = relayer.submit(tx(1), 'k');
  assert.match(ticketOf(result), /^[0-9a-f]{32}$/);
  assert.deepEqual(relayer.status(ticketOf(result)), { state: 'queued' });
  await flush();
  assert.deepEqual(sent, []); // still waiting for its delay
  hold.open();
  await flush();
  assert.deepEqual(relayer.status(ticketOf(result)), { state: 'done', outcome: 'included', txHash: 'f1' });
  assert.deepEqual(sent, [tx(1)]);
});

test('relayer: unknown ticket → undefined', () => {
  assert.equal(setup().relayer.status('00'.repeat(16)), undefined);
});

test('relayer: the delay is uniform in 0..maxDelayMs and comes BEFORE forwarding', async () => {
  const order: string[] = [];
  const { relayer, sleeps } = setup({
    random: () => 0.999, maxDelayMs: 1000,
    sleep: async (ms) => { order.push(`sleep ${ms}`); },
    payer: { relay: async () => { order.push('relay'); return { status: 200, body: { status: 'SucceedEntirely', txHash: 'x' } }; } },
  });
  relayer.submit(tx(1), 'k');
  await flush();
  assert.deepEqual(order, ['sleep 999', 'relay']);
  assert.deepEqual(sleeps, []);
  const zero = setup({ random: () => 0, maxDelayMs: 1000 });
  zero.relayer.submit(tx(1), 'k');
  await flush();
  assert.deepEqual(zero.sleeps, [0]);
});

const MAPPINGS: [string, Reply | Error, Record<string, unknown>][] = [
  ['rejected', REJECTED, { outcome: 'rejected', code: 115 }],
  ['rejected without a code', { status: 200, body: { status: 'rejected', code: null } }, { outcome: 'rejected', code: null }],
  ['unknown', { status: 200, body: { status: 'unknown', txHash: 'u1', validUntil: 5 } }, { outcome: 'unknown', txHash: 'u1', validUntil: 5 }],
  ['FailFallible', { status: 200, body: { status: 'FailFallible', txHash: 'e1' } }, { outcome: 'failed', status: 'FailFallible', txHash: 'e1' }],
  ['422', { status: 422, body: { error: 'not-relayable' } }, { outcome: 'refused', error: 'not-relayable' }],
  ['429 with retryAfterS', { status: 429, body: { error: 'x', retryAfterS: 30 } }, { outcome: 'busy', retryAfterS: 30 }],
  ['503 without retryAfterS', { status: 503, body: { error: 'dust-unavailable' } }, { outcome: 'busy', retryAfterS: 60 }],
  ['500', { status: 500, body: {} }, { outcome: 'unknown' }],
  ['200 with an odd shape', { status: 200, body: 'hola' }, { outcome: 'unknown' }],
  ['the payer throws without a code', new Error('payer: no answer in time'), { outcome: 'unknown' }],
  ['cut halfway (ECONNRESET)', withCode('ECONNRESET'), { outcome: 'unknown' }],
  ['payer stopped (ECONNREFUSED)', withCode('ECONNREFUSED'), { outcome: 'busy', retryAfterS: 60 }],
  ['no socket (ENOENT)', withCode('ENOENT'), { outcome: 'busy', retryAfterS: 60 }],
];

for (const [name, reply, expected] of MAPPINGS) {
  test(`relayer: payer response "${name}" → ${JSON.stringify(expected)}`, async () => {
    const { relayer } = setup({}, reply);
    const ticket = ticketOf(relayer.submit(tx(1), 'k'));
    await flush();
    assert.deepEqual(relayer.status(ticket), { state: 'done', ...expected });
  });
}

test('relayer: same bytes queued or in flight → the same ticket, without spending limits or attempts', async () => {
  const hold = gate();
  const { relayer, sent, parsed } = setup({ sleep: () => hold.promise, limits: { perIpPerHour: 1, globalPerHour: 1, attemptsPerIpPerHour: 1 } });
  const first = relayer.submit(tx(1), 'k');
  assert.deepEqual(relayer.submit(tx(1), 'k'), first);
  assert.deepEqual(relayer.submit(tx(1), 'otro'), first);
  assert.equal(parsed.length, 1, 'not deserialized again');
  hold.open();
  await flush();
  assert.equal(sent.length, 1);
});

// The same intent with different bytes (e.g. another proof) is the same transaction to the node.
test('relayer: the same intent with other bytes while the first is still alive → duplicate, without a foreign ticket or quota', async () => {
  const hold = gate();
  const { relayer, sent } = setup({ sleep: () => hold.promise, limits: { perIpPerHour: 1, globalPerHour: 1 } });
  ticketOf(relayer.submit(tx(1), 'a'));
  assert.deepEqual(relayer.submit(tx(1, 0xaa, 0x99), 'b'), { error: 'duplicate' });
  hold.open();
  await flush();
  assert.deepEqual(relayer.submit(tx(1, 0xaa, 0x99), 'b'), { error: 'duplicate' }, 'included: still held');
  assert.equal(sent.length, 1);
});

// Resending bytes that already have a reply is useless (the node would reject them) and is exactly what left
// operator DUST locked for 3 h (see `releaseDust` in src/chain/midnight.ts). The ticket that already holds the
// reply is returned without resending, for as long as the ticket lives (1 h > transaction validity, 30 min).
for (const [name, reply] of [
  ['included', INCLUDED],
  ['failed', { status: 200, body: { status: 'FailFallible', txHash: 'e1' } }],
  ['refused', { status: 422, body: { error: 'not-relayable' } }],
] as [string, Reply][]) {
  test(`relayer: after finishing (${name}) the same bytes give the same ticket, without resending, for 1 h`, async () => {
    const { relayer, sent, clock } = setup({}, reply);
    const first = ticketOf(relayer.submit(tx(1), 'a'));
    await flush();
    clock.now += HOUR - 1;
    assert.equal(ticketOf(relayer.submit(tx(1), 'b')), first);
    await flush();
    assert.equal(sent.length, 1, 'not resent');
    clock.now += 1;
    assert.deepEqual(relayer.submit(tx(1), 'b'), BAD_TTL, 'once the ticket expires, they are no longer held');
  });
}

// A reveal rejected because the round had not advanced yet would be valid shortly after with the same bytes.
test('relayer: after rejected the same bytes give the same ticket for only 2 min, then they can be sent again', async () => {
  const { relayer, sent, clock } = setup({}, REJECTED);
  const first = ticketOf(relayer.submit(tx(1), 'a'));
  await flush();
  clock.now += 2 * MIN - 1;
  assert.equal(ticketOf(relayer.submit(tx(1), 'b')), first);
  assert.deepEqual(relayer.submit(tx(1, 0xaa, 0x99), 'b'), { error: 'duplicate' });
  clock.now += 1;
  const second = ticketOf(relayer.submit(tx(1), 'b'));
  assert.notEqual(second, first);
  assert.equal(relayer.status(first)?.state, 'done', 'the ticket of the first one still answers');
  await flush();
  assert.equal(sent.length, 2);
});

for (const [name, reply] of [
  ['busy', { status: 503, body: { error: 'dust-unavailable', retryAfterS: 60 } }],
  ['payer stopped (ECONNREFUSED: not sent)', withCode('ECONNREFUSED')],
  ['no socket (ENOENT: not sent)', withCode('ENOENT')],
] as [string, Reply | Error][]) {
  test(`relayer: after ${name} the same bytes can be sent again (legitimate retry)`, async () => {
    const { relayer, sent } = setup({}, reply);
    const first = ticketOf(relayer.submit(tx(1), 'a'));
    await flush();
    assert.notEqual(ticketOf(relayer.submit(tx(1), 'a')), first);
    await flush();
    assert.equal(sent.length, 2);
  });
}

test('relayer: unknown keeps the bytes "in flight" until validUntil + 60 s', async () => {
  const { relayer, clock } = setup({}, { status: 200, body: { status: 'unknown', txHash: 'u', validUntil: T0 + 600_000 } });
  const first = ticketOf(relayer.submit(tx(1), 'a'));
  await flush();
  assert.equal(ticketOf(relayer.submit(tx(1), 'b')), first);
  clock.now = T0 + 660_000 - 1;
  assert.equal(ticketOf(relayer.submit(tx(1), 'b')), first);
  clock.now = T0 + 660_000;
  assert.notEqual(ticketOf(relayer.submit(tx(1), 'b')), first);
});

// Only "could not connect" is certainly not sent. A dropped connection, a timeout or an odd reply may have
// left it in the mempool, so it is held until it can no longer land: max(ttl, now + 30 min) + 60 s.
for (const [name, reply] of [
  ['ECONNRESET', withCode('ECONNRESET')],
  ['a client timeout', new Error('payer: no answer in time')],
  ['a 500', { status: 500, body: {} }],
] as [string, Reply | Error][]) {
  test(`relayer: unknown without validUntil (${name}) holds the bytes until max(ttl, end+30 min) + 60 s`, async () => {
    const { relayer, clock, sent } = setup({}, reply);
    const first = ticketOf(relayer.submit(tx(1), 'a')); // ttl = T0 + 30 min
    await flush();
    clock.now = T0 + 31 * MIN - 1;
    assert.equal(ticketOf(relayer.submit(tx(1), 'b')), first);
    assert.deepEqual(relayer.submit(tx(1, 0xaa, 0x99), 'b'), { error: 'duplicate' });
    clock.now = T0 + 31 * MIN;
    assert.deepEqual(relayer.submit(tx(1), 'b'), BAD_TTL, 'liberados');
    await flush();
    assert.equal(sent.length, 1);
  });
}

test('relayer: unknown without validUntil that finishes late → held until end + 30 min + 60 s (longer than the ttl)', async () => {
  const { relayer, clock } = setup({ sleep: async () => { clock.now += 10 * MIN; } }, withCode('ECONNRESET'));
  const first = ticketOf(relayer.submit(tx(1), 'a')); // ttl = T0 + 30 min; finishes at T0 + 10 min
  await flush();
  clock.now = T0 + 41 * MIN - 1;
  assert.equal(ticketOf(relayer.submit(tx(1), 'b')), first);
  clock.now = T0 + 41 * MIN;
  assert.deepEqual(relayer.submit(tx(1), 'b'), BAD_TTL);
});

test('relayer: the payer throws something that is not an Error (undefined, null) → unknown, without breaking the worker', async () => {
  for (const thrown of [undefined, null]) {
    const { relayer } = setup({ payer: { relay: async () => { throw thrown; } } });
    const ticket = ticketOf(relayer.submit(tx(1), 'k'));
    await flush();
    assert.deepEqual(relayer.status(ticket), { state: 'done', outcome: 'unknown' }, String(thrown));
  }
});

test('relayer: unknown without validUntil with a ttl longer than 30 min → held until ttl + 60 s', async () => {
  const { relayer, clock } = setup({}, withCode('ECONNRESET'));
  const first = ticketOf(relayer.submit(tx(1, 0xb4), 'a')); // ttl = T0 + 34 min
  await flush();
  clock.now = T0 + 35 * MIN - 1;
  assert.equal(ticketOf(relayer.submit(tx(1, 0xb4), 'b')), first);
  clock.now = T0 + 35 * MIN;
  assert.deepEqual(relayer.submit(tx(1, 0xb4), 'b'), BAD_TTL);
});

test('relayer: unknown outliving its ticket: once the ticket expires its bytes and identifiers are forgotten too', async () => {
  const { relayer, sent, clock } = setup({}, { status: 200, body: { status: 'unknown', txHash: 'u', validUntil: T0 + 2 * HOUR } });
  const first = ticketOf(relayer.submit(tx(1), 'a'));
  await flush();
  clock.now += HOUR;
  const second = ticketOf(relayer.submit(tx(1, 0xaa, 0x99), 'b')); // same intent: no longer counts as in flight
  assert.notEqual(second, first, 'a ticket that no longer exists is not returned');
  assert.equal(relayer.status(first), undefined);
  await flush();
  assert.equal(sent.length, 2);
});

test('relayer: per-client and global limit (only accepted ones count) and it resets after an hour', () => {
  const { relayer, clock } = setup({ sleep: () => new Promise(() => {}), limits: { perIpPerHour: 2, globalPerHour: 3 } });
  assert.ok('ticket' in relayer.submit(tx(1), 'a'));
  assert.deepEqual(relayer.submit(tx(1, 0xee), 'a'), { error: 'invalid-tx' }); // rejected: does not count
  assert.ok('ticket' in relayer.submit(tx(2), 'a'));
  assert.deepEqual(relayer.submit(tx(3), 'a'), RATE_LIMITED);
  assert.ok('ticket' in relayer.submit(tx(3), 'b'));
  assert.deepEqual(relayer.submit(tx(4), 'c'), RATE_LIMITED);
  clock.now += HOUR;
  assert.ok('ticket' in relayer.submit(tx(5), 'c'));
});

// Deserializing (WASM, synchronous) is the expensive part, so attempts are limited per client before it,
// whether or not they count afterwards.
test('relayer: attempts per client and hour before deserializing (invalid ones too), then rate-limited without parse', () => {
  const { relayer, parsed, clock } = setup({ sleep: () => new Promise(() => {}), limits: { attemptsPerIpPerHour: 2 } });
  assert.deepEqual(relayer.submit(tx(1, 0xee), 'a'), { error: 'invalid-tx' });
  assert.ok('ticket' in relayer.submit(tx(2), 'a'));
  assert.deepEqual(relayer.submit(tx(3), 'a'), RATE_LIMITED);
  assert.deepEqual(parsed, [1, 2], 'the third one is not deserialized');
  assert.ok('ticket' in relayer.submit(tx(5), 'b'));
  clock.now += HOUR;
  assert.ok('ticket' in relayer.submit(tx(3), 'a'));
});

// With broken proofs (free to make) a handful of IPs could exhaust the global quota. A node rejection returns
// the global quota, counts as a client fault (3/h, then blocked for the rest of the hour) and has its own
// global cap (beyond it, busy).
test('relayer A1: a rejected one returns its global quota, an included one does not', async () => {
  const rejected = setup({ limits: { globalPerHour: 1 } }, REJECTED);
  rejected.relayer.submit(tx(1), 'a');
  await flush();
  assert.ok('ticket' in rejected.relayer.submit(tx(2), 'b'), 'the global quota was returned');

  const included = setup({ limits: { globalPerHour: 1 } });
  included.relayer.submit(tx(1), 'a');
  await flush();
  assert.deepEqual(included.relayer.submit(tx(2), 'b'), RATE_LIMITED);
});

test('relayer A1: the per-client quota is spent by a rejected one', async () => {
  const { relayer } = setup({ limits: { perIpPerHour: 1 } }, REJECTED);
  relayer.submit(tx(1), 'a');
  await flush();
  assert.deepEqual(relayer.submit(tx(2), 'a'), RATE_LIMITED);
});

test('relayer A1: 3 rejections from a client within the hour → blocked (without deserializing) until its hour ends', async () => {
  const { relayer, clock, parsed } = setup({}, REJECTED);
  for (const n of [1, 2, 3]) {
    assert.ok('ticket' in relayer.submit(tx(n), 'a'), `submission ${n}`);
    await flush();
  }
  const before = parsed.length;
  assert.deepEqual(relayer.submit(tx(4), 'a'), RATE_LIMITED);
  assert.equal(parsed.length, before, 'blocked before deserializing');
  assert.ok('ticket' in relayer.submit(tx(4), 'b'), 'the others continue');
  clock.now += HOUR;
  assert.ok('ticket' in relayer.submit(tx(5), 'a'), 'after the hour, it can again');
});

// If the fault were recorded on completion, a burst would get through entirely (20 per IP) before the first
// rejection. It is recorded provisionally on acceptance: at most 3 "in progress or rejected" submissions per hour.
test('relayer B1: a burst from one client without waiting for replies → only 3 accepted, the rest get a short wait', async () => {
  const hold = gate();
  const { relayer, clock } = setup({ sleep: () => hold.promise }, REJECTED);
  const results = Array.from({ length: 20 }, (_, n) => relayer.submit(tx(n + 1), 'a'));
  assert.equal(results.filter((r) => 'ticket' in r).length, 3);
  assert.deepEqual(results[3], { error: 'rate-limited', retryAfterS: 60 }, 'with submissions in progress, come back soon');
  assert.ok('ticket' in relayer.submit(tx(30), 'b'), 'the others continue');
  hold.open();
  await flush();
  clock.now += 10 * MIN;
  assert.deepEqual(relayer.submit(tx(31), 'a'), { error: 'rate-limited', retryAfterS: 50 * 60 }, 'confirmed: the rest of its hour');
});

test('relayer B1: while it has ONE submission in progress, the wait stays short', async () => {
  const gates = [gate<Reply>(), gate<Reply>()];
  let i = 0;
  const { relayer } = setup({ limits: { faultsPerIpPerHour: 2 }, payer: { relay: () => gates[i++]!.promise } });
  relayer.submit(tx(1), 'a');
  relayer.submit(tx(2), 'a');
  await flush();
  assert.deepEqual(relayer.submit(tx(3), 'a'), { error: 'rate-limited', retryAfterS: 60 });
  gates[0]!.open(REJECTED);
  await flush();
  assert.deepEqual(relayer.submit(tx(3), 'a'), { error: 'rate-limited', retryAfterS: 60 }, '1 confirmed strike + 1 in progress');
  gates[1]!.open(REJECTED);
  await flush();
  assert.deepEqual(relayer.submit(tx(3), 'a'), RATE_LIMITED, 'both confirmed');
});

test('relayer B1: a confirmed strike counts in the current window even if accepted in the previous one', async () => {
  const hold = gate();
  let calls = 0;
  const { relayer, clock } = setup({ limits: { faultsPerIpPerHour: 2 }, sleep: () => (calls++ === 1 ? hold.promise : Promise.resolve()) }, REJECTED);
  relayer.submit(tx(9), 'a'); // confirmed fault: 'a' fault window from T0, with 1
  await flush();
  clock.now = T0 + 58 * MIN;
  assert.ok('ticket' in relayer.submit(tx(1), 'a')); // provisional in the T0 window (2/2)
  clock.now = T0 + HOUR; // the window expires with the submission still in progress...
  hold.open();
  await flush(); // ...and it is rejected in the next hour: counts there (1)
  clock.now = T0 + 61 * MIN;
  assert.ok('ticket' in relayer.submit(tx(2), 'a')); // 2/2 in the new window
  await flush(); // rejected
  clock.now = T0 + 62 * MIN;
  assert.deepEqual(relayer.submit(tx(3), 'a'), { error: 'rate-limited', retryAfterS: 58 * 60 }, 'new window from T0 + 60 min');
  clock.now = T0 + 2 * HOUR;
  assert.ok('ticket' in relayer.submit(tx(4), 'a'), 'pasada esa hora, vuelve a poder');
});

test('relayer B1: the provisional strike is returned if the result is not a rejection', async () => {
  for (const reply of [
    INCLUDED, { status: 200, body: { status: 'FailFallible', txHash: 'e' } }, { status: 200, body: { status: 'unknown', txHash: 'u', validUntil: T0 } },
    { status: 503, body: {} },
  ] as Reply[]) {
    const { relayer } = setup({ limits: { faultsPerIpPerHour: 1 } }, reply);
    relayer.submit(tx(1), 'a');
    await flush();
    assert.ok('ticket' in relayer.submit(tx(2), 'a'), JSON.stringify(reply.body));
  }
});

test('relayer A1: a refused from the payer counts as a rejection (strike, and returns the global quota)', async () => {
  const { relayer } = setup({ limits: { faultsPerIpPerHour: 1, globalPerHour: 1 } }, { status: 422, body: { error: 'fee-over-cap' } });
  relayer.submit(tx(1), 'a');
  await flush();
  assert.deepEqual(relayer.submit(tx(2), 'a'), RATE_LIMITED, 'falta');
  assert.ok('ticket' in relayer.submit(tx(3), 'b'), 'the global quota was returned');
});

// With the payer stopped or out of DUST, a retry must not consume quota when nothing was sent.
test('relayer M-2: what was not sent (busy, payer stopped) returns the global quota and the client one', async () => {
  for (const reply of [{ status: 503, body: { error: 'not-ready' } }, withCode('ECONNREFUSED')] as (Reply | Error)[]) {
    const { relayer } = setup({ limits: { perIpPerHour: 1, globalPerHour: 1 } }, reply);
    relayer.submit(tx(1), 'a');
    await flush();
    assert.ok('ticket' in relayer.submit(tx(2), 'a'), String(reply));
  }
});

test('relayer: if it has less than 3 min of ttl left when leaving the queue → expired, without sending or spending quota', async () => {
  const { relayer, clock, sent } = setup({ sleep: async () => { clock.now += 27 * MIN + 1; }, limits: { perIpPerHour: 1, globalPerHour: 1 } });
  const ticket = ticketOf(relayer.submit(tx(1), 'a')); // ttl = T0 + 30 min
  await flush();
  assert.deepEqual(relayer.status(ticket), { state: 'done', outcome: 'expired' });
  assert.deepEqual(sent, []);
  assert.ok('ticket' in relayer.submit(tx(2), 'a'), 'the quota was returned');
});

test('relayer: exactly 3 min before the ttl it is still sent', async () => {
  const { relayer, clock, sent } = setup({ sleep: async () => { clock.now += 27 * MIN; } });
  relayer.submit(tx(1), 'a');
  await flush();
  assert.equal(sent.length, 1);
});

test('relayer A1: global hourly rejection cap → busy for everyone, without deserializing, until the hour ends', async () => {
  const { relayer, clock, parsed } = setup({ limits: { rejectedPerHour: 2 } }, REJECTED);
  for (const key of ['a', 'b']) {
    relayer.submit(tx(key.charCodeAt(0)), key);
    await flush();
  }
  clock.now += 15 * MIN;
  const before = parsed.length;
  assert.deepEqual(relayer.submit(tx(3), 'c'), { error: 'busy', retryAfterS: 45 * 60 }, 'the rest of the hour');
  assert.equal(parsed.length, before, 'without deserializing or spending attempts');
  clock.now += 45 * MIN;
  assert.ok('ticket' in relayer.submit(tx(3), 'c'));
});

test('relayer: expired limiter windows are swept (IPs are not kept for more than an hour)', async () => {
  const { relayer, clock } = setup();
  relayer.submit(tx(1), '203.0.113.9');
  await flush();
  clock.now += HOUR + MIN;
  relayer.status('00'.repeat(16)); // any call sweeps
  const limiters = ['perIp', 'global', 'attempts', 'faults', 'rejected'].map((name) => (relayer as unknown as Record<string, { size: number }>)[name]!.size);
  assert.deepEqual(limiters, [0, 0, 0, 0, 0]);
});

test('relayer: with more than maxInFlight*4 waiting → busy 60 s, without spending quota', async () => {
  const hold = gate();
  const { relayer } = setup({ sleep: () => hold.promise, maxInFlight: 1, limits: { perIpPerHour: 100, globalPerHour: 100, attemptsPerIpPerHour: 100, faultsPerIpPerHour: 100 } });
  const results = [1, 2, 3, 4, 5, 6].map((n) => relayer.submit(tx(n), 'k')); // 1 in flight + 4 waiting
  assert.ok(results.slice(0, 5).every((r) => 'ticket' in r));
  assert.deepEqual(results[5], BUSY);
});

test('relayer: never more than maxInFlight forwards at once, the others wait their turn', async () => {
  const gates = [gate<Reply>(), gate<Reply>(), gate<Reply>()];
  let running = 0;
  let peak = 0;
  let i = 0;
  const { relayer } = setup({
    maxInFlight: 2,
    payer: { relay: async () => { running++; peak = Math.max(peak, running); const r = await gates[i++]!.promise; running--; return r; } },
  });
  const tickets = [1, 2, 3].map((n) => ticketOf(relayer.submit(tx(n), 'k')));
  await flush();
  assert.equal(running, 2);
  gates[0]!.open({ status: 200, body: { status: 'SucceedEntirely', txHash: 'a' } });
  await flush();
  assert.equal(running, 2);
  gates[1]!.open({ status: 200, body: { status: 'SucceedEntirely', txHash: 'b' } });
  gates[2]!.open({ status: 200, body: { status: 'SucceedEntirely', txHash: 'c' } });
  await flush();
  assert.equal(peak, 2);
  assert.ok(tickets.every((t) => relayer.status(t)?.state === 'done'));
});

test('relayer: a finished ticket expires 1 h after finishing', async () => {
  const { relayer, clock } = setup();
  const ticket = ticketOf(relayer.submit(tx(1), 'k'));
  await flush();
  clock.now += HOUR - 1;
  assert.equal(relayer.status(ticket)?.state, 'done');
  clock.now += 1;
  assert.equal(relayer.status(ticket), undefined);
});

test('relayer: memory is bounded (expired entries purged on each submit)', async () => {
  const { relayer, clock } = setup({ limits: { perIpPerHour: 100, globalPerHour: 100 } });
  const old = ticketOf(relayer.submit(tx(1), 'k'));
  await flush();
  clock.now += HOUR;
  relayer.submit(tx(2), 'k');
  assert.equal(relayer.status(old), undefined);
});

test('relayer: the log carries no IP, ticket or hash of an included one, but does carry the hash of unknown and failed', async () => {
  const included = setup();
  const ticket = ticketOf(included.relayer.submit(tx(1), '203.0.113.9'));
  await flush();
  assert.deepEqual(included.logs.filter((l) => /203\.0\.113|f1|aa01/.test(l) || l.includes(ticket)), []);

  const unknown = setup({}, { status: 200, body: { status: 'unknown', txHash: 'u9', validUntil: 1 } });
  unknown.relayer.submit(tx(1), '203.0.113.9');
  await flush();
  assert.ok(unknown.logs.some((l) => l.startsWith('warn') && l.includes('u9')));
  assert.ok(!unknown.logs.some((l) => l.includes('203.0.113')));

  const failed = setup({}, { status: 200, body: { status: 'FailFallible', txHash: 'e7' } });
  failed.relayer.submit(tx(1), 'k');
  await flush();
  assert.ok(failed.logs.some((l) => l.startsWith('warn') && l.includes('e7')));

  const rejected = setup({}, REJECTED);
  rejected.relayer.submit(tx(1), '203.0.113.9');
  await flush();
  assert.deepEqual(rejected.logs.filter((l) => /203\.0\.113/.test(l)), [], 'a strike does not log the IP either');
});

test('relayer: an odd status or a payer failure leaves a warn with only the HTTP status / the error class', async () => {
  const odd = setup({}, { status: 418, body: { secret: 'tx-detail' } });
  odd.relayer.submit(tx(1), 'k');
  await flush();
  assert.deepEqual(odd.logs, ['warn relayer: unexpected payer reply (HTTP 418)']);

  const down = setup({}, Object.assign(new Error('connect to /secret/path'), { code: 'ECONNREFUSED' }));
  down.relayer.submit(tx(1), 'k');
  await flush();
  assert.deepEqual(down.logs, ['warn relayer: payer unreachable (Error/ECONNREFUSED)']);
});

test('relayer: close() rejects new work and waits for what is in flight', async () => {
  const hold = gate<Reply>();
  const { relayer } = setup({ payer: { relay: () => hold.promise } });
  const ticket = ticketOf(relayer.submit(tx(1), 'k'));
  await flush();
  let closed = false;
  const closing = relayer.close().then(() => { closed = true; });
  await flush();
  assert.equal(closed, false);
  assert.deepEqual(relayer.submit(tx(2), 'k'), BUSY);
  hold.open(INCLUDED);
  await closing;
  assert.equal(relayer.status(ticket)?.state, 'done');
});

test('relayer: the sha256 of the bytes is the identity (same bytes in hex, same ticket)', () => {
  const { relayer } = setup({ sleep: () => new Promise(() => {}) });
  const a = relayer.submit('aabb', 'k');
  assert.deepEqual(relayer.submit('aabb', 'k'), a);
  assert.notDeepEqual(relayer.submit('aabc', 'k'), a);
});

test('relayer: a null body from the payer (200 or 422) does not throw: unknown / refused "unknown"', async () => {
  for (const [reply, expected] of [
    [{ status: 200, body: null }, { outcome: 'unknown' }],
    [{ status: 422, body: null }, { outcome: 'refused', error: 'unknown' }],
  ] as [Reply, Record<string, unknown>][]) {
    const { relayer } = setup({}, reply);
    const ticket = ticketOf(relayer.submit(tx(1), 'k'));
    await flush();
    assert.deepEqual(relayer.status(ticket), { state: 'done', ...expected });
  }
});

test('relayer: a 0 or an empty text from the payer is respected (code 0, retryAfterS 0, empty error)', async () => {
  for (const [reply, expected] of [
    [{ status: 200, body: { status: 'rejected', code: 0 } }, { outcome: 'rejected', code: 0 }],
    [{ status: 429, body: { retryAfterS: 0 } }, { outcome: 'busy', retryAfterS: 0 }],
    [{ status: 422, body: { error: '' } }, { outcome: 'refused', error: '' }],
  ] as [Reply, Record<string, unknown>][]) {
    const { relayer } = setup({}, reply);
    const ticket = ticketOf(relayer.submit(tx(1), 'k'));
    await flush();
    assert.deepEqual(relayer.status(ticket), { state: 'done', ...expected });
  }
});

test('relayer: a 200 without status or without txHash (even with the other one) → unknown, neither included nor failed', async () => {
  for (const body of [{ status: 'SucceedEntirely' }, { txHash: 'f1' }, { status: 'FailFallible' }]) {
    const { relayer } = setup({}, { status: 200, body });
    const ticket = ticketOf(relayer.submit(tx(1), 'k'));
    await flush();
    assert.deepEqual(relayer.status(ticket), { state: 'done', outcome: 'unknown' }, JSON.stringify(body));
  }
});

test('relayer: the delay can reach exactly maxDelayMs (random almost 1)', async () => {
  const { relayer, sleeps } = setup({ random: () => 0.9999999, maxDelayMs: 1000 });
  relayer.submit(tx(1), 'k');
  await flush();
  assert.deepEqual(sleeps, [1000]);
});

test('relayer: maxDelayMs 0 and maxInFlight 0 are respected (they do not fall back to the defaults)', async () => {
  const zero = setup({ maxDelayMs: 0 });
  zero.relayer.submit(tx(1), 'k');
  await flush();
  assert.deepEqual(zero.sleeps, [0]);
  const none = setup({ maxInFlight: 0 });
  assert.deepEqual(none.relayer.submit(tx(1), 'k'), BUSY);
});
