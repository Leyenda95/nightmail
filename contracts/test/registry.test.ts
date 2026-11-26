// NightMailRegistry in the simulator: bonos, slots, two-step mailboxes and aliases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deploy, hex, Kind, NAME_CIPHER_BYTES, nameBytes, NO_EXPIRY, pc, Plan, PRICE, rand, T0 } from './sim.ts';

const advance = async (c: Awaited<ReturnType<typeof deploy>>, n: number) => {
  for (let i = 0; i < n; i++) await c.advanceRound();
};

// --- Bono issuance ---------------------------------------------------------------------------

test('only the operator issues bonos (free and simulated paid)', async () => {
  const c = await deploy();
  await c.issue(Plan.free);
  await c.issue(Plan.paid);
  assert.equal(c.view().bonos.firstFree(), 2n);
  await assert.rejects(c.run('issueBono', { opSk: rand() }, rand(), Plan.free), /Not the operator/);
});

test('buying a bono: exact amount, token color, and the coin goes to the contract', async () => {
  const c = await deploy();
  await assert.rejects(c.buy({ nonce: rand(), color: c.paymentColor, value: PRICE - 1n }), /Wrong amount/);
  await assert.rejects(c.buy({ nonce: rand(), color: c.paymentColor, value: PRICE + 1n }), /Wrong amount/);
  await assert.rejects(c.buy({ nonce: rand(), color: rand(), value: PRICE }), /Wrong token/);
  const coin = { nonce: rand(), color: c.paymentColor, value: PRICE };
  const r = await c.runFull('buyBono', {}, coin, pc.bonoId(c.ctx, rand(), 0n));
  const outs = r.context.callContext.currentZswapLocalState.outputs;
  assert.equal(outs.length, 1, 'receives exactly one coin');
  assert.equal(hex(outs[0].coinInfo.nonce), hex(coin.nonce));
  assert.equal(outs[0].coinInfo.value, PRICE);
  assert.equal(outs[0].recipient.is_left, false, 'the recipient is a contract');
  assert.equal(hex(outs[0].recipient.right.bytes), c.address, 'and it is this contract');
  assert.equal(c.view().bonos.firstFree(), 1n);
});

test('the purchased leaf is paid: it gives the paid plan slots', async () => {
  const c = await deploy();
  const b = await c.buy();
  await c.alias(b, 19n);
  await c.register(c.mailbox('ana', b, 4n));
});

test('plan and expiry are set by the circuit: a free bono does not pass for a paid one', async () => {
  const c = await deploy();
  const free = await c.issue(Plan.free);
  for (const forged of [{ ...free, plan: Plan.paid }, { ...free, validUntil: NO_EXPIRY - 1n }]) {
    await assert.rejects(c.createAlias(c.aliasFor(forged, 2n), { path: c.pathClaiming(free, forged) }), /Not a bono/);
  }
});

// --- Quota ---------------------------------------------------------------------------------------

test('free quota: 1 mailbox and 2 aliases', async () => {
  const c = await deploy();
  const b = await c.issue(Plan.free);
  await c.alias(b, 0n);
  await c.alias(b, 1n);
  await assert.rejects(c.alias(b, 2n), /No slots left/);
  await c.reserve(c.mailbox('ana', b, 0n));
  await assert.rejects(c.reserve(c.mailbox('ana2', b, 1n)), /No slots left/);
});

test('paid quota: 5 mailboxes and 20 aliases', async () => {
  const c = await deploy();
  const b = await c.issue(Plan.paid);
  for (let j = 0n; j < 20n; j++) await c.alias(b, j);
  await assert.rejects(c.alias(b, 20n), /No slots left/);
  for (let j = 0n; j < 5n; j++) await c.reserve(c.mailbox(`buzon${j}`, b, j));
  await assert.rejects(c.reserve(c.mailbox('buzon5', b, 5n)), /No slots left/);
  assert.equal(c.view().slotNullifiers.size(), 25n);
});

test('a slot already used cannot be used again', async () => {
  const c = await deploy();
  const b = await c.issue(Plan.free);
  await c.alias(b, 0n);
  await assert.rejects(c.alias(b, 0n), /Slot already used/);
  await c.reserve(c.mailbox('ana', b, 0n));
  await assert.rejects(c.reserve(c.mailbox('otra', b, 0n)), /Slot already used/);
});

test('mailbox and alias are different slots: mailbox 0 does not spend alias 0', async () => {
  const c = await deploy();
  const b = await c.issue(Plan.free);
  await c.reserve(c.mailbox('ana', b, 0n));
  await c.alias(b, 0n);
});

test('another leaf of the same bono gives no extra quota: upgrading the plan leaves 5+20 in total', async () => {
  const c = await deploy();
  const free = await c.issue(Plan.free);
  await c.alias(free, 0n);
  await c.alias(free, 1n);
  await c.reserve(c.mailbox('ana', free, 0n));
  const free2 = await c.issue(Plan.free, free.s, 1n); // another free leaf with the same s
  await assert.rejects(c.alias(free2, 0n), /Slot already used/);
  await assert.rejects(c.alias(free2, 2n), /No slots left/);
  const paid = await c.buy(undefined, free.s, 2n); // upgrade with the same s
  await assert.rejects(c.alias(paid, 1n), /Slot already used/); // slots already spent still count
  await assert.rejects(c.reserve(c.mailbox('otra', paid, 0n)), /Slot already used/);
  for (let j = 2n; j < 20n; j++) await c.alias(paid, j);
  await assert.rejects(c.alias(paid, 20n), /No slots left/);
  for (let j = 1n; j < 5n; j++) await c.reserve(c.mailbox(`b${j}`, paid, j));
  await assert.rejects(c.reserve(c.mailbox('b5', paid, 5n)), /No slots left/);
});

test('a repeated leaf (operator retry) gives no extra slots', async () => {
  const c = await deploy();
  const b = await c.issue(Plan.free);
  await c.issue(Plan.free, b.s, b.k);
  await c.alias(b, 0n);
  await c.alias(b, 1n);
  await assert.rejects(c.alias(b, 2n), /No slots left/);
  await assert.rejects(c.alias(b, 0n), /Slot already used/);
});

// --- Membership ---------------------------------------------------------------------------------

test('a bono from another deployment (another ctx) is not valid', async () => {
  const a = await deploy();
  const b = await deploy();
  assert.notEqual(hex(a.ctx), hex(b.ctx));
  const bono = await a.issue(Plan.free); // its leaf carries a's ctx
  const other = await b.issue(Plan.free);
  // In b the circuit recomputes the leaf with b's ctx: it does not exist, even given a path.
  await assert.rejects(b.createAlias(b.aliasFor(bono, 0n), { path: b.pathClaiming(other, bono) }), /Not a bono/);
});

test('without a bono, presenting the (valid) path of another user\'s paid leaf does not work', async () => {
  const c = await deploy();
  const victim = await c.buy();
  const attacker = { s: rand(), k: 0n, plan: Plan.paid, validUntil: NO_EXPIRY }; // never issued
  await assert.rejects(
    c.createAlias(c.aliasFor(attacker, 19n), { pathOf: c.leafOf(victim) }),
    /Path is for another bono/,
  );
});

test('a path computed against an earlier root is still valid (historic tree)', async () => {
  const c = await deploy();
  const b = await c.issue(Plan.paid);
  const oldPath = c.pathNow(b);
  await c.issue(Plan.free);
  await c.issue(Plan.free);
  await c.createAlias(c.aliasFor(b, 0n), { path: oldPath });
  await c.alias(b, 1n); // and so does the current path
});

// --- Alias --------------------------------------------------------------------------------------

test('alias: the record stores keys, kind and slot, and the encrypted name stays empty', async () => {
  const c = await deploy();
  const b = await c.issue(Plan.paid);
  const a = await c.alias(b, 3n);
  assert.equal(hex(a.addrKey), hex(pc.aliasKey(a.encPk, a.authPk, c.slotNul(b, Kind.alias, 3n))));
  const rec = c.view().addresses.lookup(a.addrKey);
  assert.equal(hex(rec.encPk), hex(a.encPk));
  assert.equal(hex(rec.authPk), hex(a.authPk));
  assert.equal(rec.kind, Kind.alias);
  assert.equal(hex(rec.nameCipher), hex(new Uint8Array(NAME_CIPHER_BYTES)));
  assert.equal(hex(rec.slotNul), hex(c.slotNul(b, Kind.alias, 3n)));
  assert.equal(c.view().addresses.size(), 1n);
});

test('copying the keys of an alias from the mempool is useless: it gives another address, the victim\'s stays free', async () => {
  const c = await deploy();
  const victimBono = await c.issue(Plan.free);
  const attackerBono = await c.issue(Plan.free);
  const victim = c.aliasFor(victimBono, 0n);
  const copy = c.aliasFor(attackerBono, 0n, { encPk: victim.encPk, authPk: victim.authPk });
  await c.createAlias(copy); // the attacker gets there first with the same keys
  assert.notEqual(hex(copy.addrKey), hex(victim.addrKey));
  await c.createAlias(victim);
  assert.equal(hex(c.view().addresses.lookup(victim.addrKey).slotNul), hex(c.slotNul(victimBono, Kind.alias, 0n)));
});

// --- Two-step mailbox -------------------------------------------------------------------------

test('reservation and reveal: the full record, with the slotNul, and the reservation is deleted', async () => {
  const c = await deploy();
  const b = await c.issue(Plan.free);
  const m = c.mailbox('juan.perez', b, 0n);
  await c.reserve(m);
  const pending = c.view().pendingNames.lookup(m.slotNul);
  assert.equal(hex(pending.commit), hex(m.commit));
  await advance(c, 2);
  await c.reveal(m);
  const rec = c.view().addresses.lookup(m.addrKey);
  assert.equal(hex(m.addrKey), hex(pc.addressKey(nameBytes('juan.perez'))));
  assert.equal(hex(rec.encPk), hex(m.encPk));
  assert.equal(hex(rec.authPk), hex(m.authPk));
  assert.equal(rec.kind, Kind.mailbox);
  assert.equal(hex(rec.nameCipher), hex(m.nameCipher));
  assert.equal(hex(rec.slotNul), hex(c.slotNul(b, Kind.mailbox, 0n)));
  assert.ok(!c.view().pendingNames.member(m.slotNul));
});

test('a repeated reveal (the same transaction again) is rejected', async () => {
  const c = await deploy();
  const b = await c.issue(Plan.free);
  const m = c.mailbox('ana', b, 0n);
  await c.register(m);
  await assert.rejects(c.reveal(m), /Not reserved/);
  assert.equal(c.view().addresses.size(), 1n);
});

test('the reservation stores the proposed round: with the maximum round the sum does not fit and it is rejected', async () => {
  const c = await deploy();
  const b = await c.issue(Plan.paid);
  const m = c.mailbox('ana', b, 0n);
  await c.reserve(m, 7n);
  assert.equal(c.view().pendingNames.lookup(m.slotNul).reservedRound, 7n);
  await assert.rejects(c.reserve(c.mailbox('otra', b, 1n), 2n ** 64n - 1n), /cast .* failed/);
  assert.ok(!c.view().slotNullifiers.member(c.slotNul(b, Kind.mailbox, 1n)), 'the rejection does not spend the slot');
});

test('the reveal must be from a round after the reserved one', async () => {
  const c = await deploy();
  const b = await c.issue(Plan.paid);
  const m = c.mailbox('ana', b, 0n);
  await c.reserve(m); // r = current round + 1
  await assert.rejects(c.reveal(m), /Too early/);
  await c.advanceRound();
  await assert.rejects(c.reveal(m), /Too early/); // round == r
  await c.advanceRound();
  await c.reveal(m);
});

test('reserving with a past round is not valid: with the current one it is', async () => {
  const c = await deploy();
  const b = await c.issue(Plan.paid);
  await advance(c, 2);
  await assert.rejects(c.reserve(c.mailbox('ana', b, 0n), 0n), /Stale round/);
  await c.reserve(c.mailbox('ana', b, 0n), c.view().round);
});

test('copying a commitment from the mempool neither blocks the victim nor steals the mailbox', async () => {
  const c = await deploy();
  const victimBono = await c.issue(Plan.free);
  const attackerBono = await c.issue(Plan.free);
  const victim = c.mailbox('ana', victimBono, 0n);
  // The attacker first reserves the same commitment with its own slot.
  await c.reserve({ bono: attackerBono, j: 0n, commit: victim.commit });
  await c.reserve(victim); // the victim's reservation still goes through
  await advance(c, 2);
  // Seeing the reveal, the attacker replays it with its slot: the commitment does not match.
  const attackerNul = c.slotNul(attackerBono, Kind.mailbox, 0n);
  await assert.rejects(c.reveal({ ...victim, slotNul: attackerNul }), /Wrong reveal/);
  await c.reveal(victim);
  assert.equal(hex(c.view().addresses.lookup(victim.addrKey).slotNul), hex(victim.slotNul));
});

test('revealing a different name, or different keys, than the commitment\'s is rejected', async () => {
  const c = await deploy();
  const b = await c.issue(Plan.free);
  const m = c.mailbox('ana', b, 0n);
  await assert.rejects(c.reveal(m), /Not reserved/);
  await c.reserve(m);
  await advance(c, 2);
  await assert.rejects(c.reveal({ ...m, name: nameBytes('ana2') }), /Wrong reveal/);
  await assert.rejects(c.reveal({ ...m, encPk: rand() }), /Wrong reveal/);
  await assert.rejects(c.reveal({ ...m, authPk: rand() }), /Wrong reveal/);
  await assert.rejects(c.reveal({ ...m, salt: rand() }), /Wrong reveal/);
  await c.reveal(m);
});

test('an already registered name is rejected (the first to reveal wins)', async () => {
  const c = await deploy();
  const b = await c.issue(Plan.paid);
  const first = c.mailbox('ana', b, 0n);
  const second = c.mailbox('ana', b, 1n);
  await c.reserve(first);
  await c.reserve(second);
  await advance(c, 2);
  await c.reveal(first);
  await assert.rejects(c.reveal(second), /Address taken/);
});

test('the contract does NOT prevent a mailbox with the text of someone else\'s alias: the server resolves aliases first', async () => {
  // An alias's text is words(addrKey) + "." + base32(60 bits), computable from its public key. The
  // contract accepts a mailbox with that name (under another key), so the server's SMTP must resolve
  // anything shaped like an alias through the suffix index only, never falling back to H(name). This
  // test pins down that the contract cannot enforce that rule.
  const c = await deploy();
  const victimBono = await c.issue(Plan.free);
  const alias = await c.alias(victimBono, 0n);
  const aliasText = `pato-azul.${hex(alias.addrKey).slice(0, 12)}`; // alias-shaped (the real format belongs to the app)
  const attackerBono = await c.issue(Plan.free);
  const m = c.mailbox(aliasText, attackerBono, 0n);
  await c.register(m);
  assert.equal(c.view().addresses.lookup(alias.addrKey).kind, Kind.alias);
  assert.equal(c.view().addresses.lookup(m.addrKey).kind, Kind.mailbox, 'both records coexist');
});

// --- Rounds -------------------------------------------------------------------------------------

test('only the operator advances the round', async () => {
  const c = await deploy();
  await c.advanceRound();
  assert.equal(c.view().round, 1n);
  await assert.rejects(c.advanceRound(rand()), /Not the operator/);
});

// --- Price ---------------------------------------------------------------------------------------

// A purchase started at the previous price is honoured: the contract keeps accepting each replaced
// price during its grace window, 15 to 20 minutes from the block of the change (the operator supplies
// the end, the contract bounds it).
const GRACE = 900n;
const GRACE_MAX = 1200n;

test('only the operator changes the price, and never to 0', async () => {
  const c = await deploy();
  await assert.rejects(c.setPrice(50n, undefined, rand()), /Not the operator/);
  await assert.rejects(c.setPrice(0n), /Price must be positive/);
  await assert.rejects(c.setPrice(PRICE), /Price unchanged/); // would change nothing and overwrite a window
  assert.equal(c.view().price, PRICE);
  assert.equal(c.view().oldPrices.size(), 0n, 'a rejected change leaves nothing');
  await c.setPrice(50n);
  assert.equal(c.view().price, 50n);
  assert.equal(c.view().oldPrices.size(), 1n);
  assert.equal(c.view().oldPrices.lookup(PRICE), T0 + GRACE, 'the old one, with the end of its window');
  await c.pay(50n);
});

test('after a change, the old price is accepted during its window and rejected when it ends', async () => {
  const c = await deploy();
  await c.setPrice(50n); // at T0: the old price (100) is accepted until T0 + 15 min
  const until = T0 + GRACE;
  const old = await c.pay(PRICE);
  await c.alias(old, 19n); // and yields a paid bono like any other
  c.setTime(until - 1n);
  await c.pay(PRICE); // last second of the window
  c.setTime(until);
  await assert.rejects(c.pay(PRICE), /Old price expired/);
  c.setTime(until + 3600n);
  await assert.rejects(c.pay(PRICE), /Old price expired/);
  await c.pay(50n); // the current price does not expire
  assert.equal(c.view().bonos.firstFree(), 3n, 'rejected purchases issue no bono');
});

test('an amount that was never a price is never accepted (not 0 either): the current one, at any time', async () => {
  const c = await deploy();
  for (const v of [0n, 1n, 50n, PRICE - 1n, PRICE + 1n]) await assert.rejects(c.pay(v), /Wrong amount/);
  await c.setPrice(50n);
  for (const v of [0n, 1n, 49n, 51n, PRICE - 1n, PRICE + 1n, 2n ** 64n + PRICE]) await assert.rejects(c.pay(v), /Wrong amount/);
  c.setTime(T0 + 10n ** 9n);
  await c.pay(50n);
});

test('the contract bounds the window: between 15 and 20 minutes from the block of the change', async () => {
  const c = await deploy();
  c.setTime(T0 + 500n); // limits are measured from the block time, not from deployment
  const now = c.time();
  const rejected: [bigint, RegExp][] = [
    [now + GRACE - 1n, /Grace too short/], // one second short of 15 min
    [now, /Grace too short/],
    [T0 + GRACE, /Grace too short/],
    [now + GRACE_MAX + 1n, /Grace too long/], // one second over 20 min
    [2n ** 64n - 1n, /Grace too long/], // "forever"
  ];
  for (const [until, error] of rejected) await assert.rejects(c.setPrice(50n, until), error);
  // A nonsensical time (smaller than the window itself) is also rejected; the message comes from the
  // compiler's subtraction underflow check, so its text is not asserted.
  for (const until of [0n, GRACE - 1n, GRACE_MAX - 1n]) await assert.rejects(c.setPrice(50n, until));
  assert.equal(c.view().price, PRICE);
  assert.equal(c.view().oldPrices.size(), 0n);
  await c.setPrice(50n, now + GRACE); // exactly 15 min
  await c.setPrice(60n, now + GRACE_MAX); // exactly 20 min
  assert.equal(c.view().oldPrices.lookup(PRICE), now + GRACE);
  assert.equal(c.view().oldPrices.lookup(50n), now + GRACE_MAX);
  assert.equal(pc.oldPriceGrace(), GRACE);
  assert.equal(pc.oldPriceGraceMax(), GRACE_MAX);
});

test('two changes in a row: each old price is valid until the end of ITS window, and no other amount', async () => {
  const c = await deploy(); // 100
  await c.setPrice(50n); // at T0: 100 is accepted until T0 + 15 min
  c.setTime(T0 + 60n);
  await c.setPrice(70n, T0 + 60n + GRACE_MAX); // a minute later: 50 is accepted until T0 + 21 min
  const until100 = T0 + GRACE;
  const until50 = T0 + 60n + GRACE_MAX;
  for (const v of [70n, 50n, PRICE]) await c.pay(v); // the current price and the two previous ones
  for (const v of [0n, 49n, 60n, 69n, 71n, 99n]) await assert.rejects(c.pay(v), /Wrong amount/);
  c.setTime(until100 - 1n);
  await c.pay(PRICE);
  c.setTime(until100); // the first window ends; the second is still open
  await assert.rejects(c.pay(PRICE), /Old price expired/);
  await c.pay(50n);
  c.setTime(until50 - 1n);
  await c.pay(50n);
  c.setTime(until50);
  await assert.rejects(c.pay(50n), /Old price expired/);
  await assert.rejects(c.pay(PRICE), /Old price expired/);
  await c.pay(70n);
});

test('going back to an old price: it is the current one (no expiry) and, if replaced again, it gets a new window', async () => {
  const c = await deploy();
  await c.setPrice(50n); // 100 -> 50
  c.setTime(T0 + 30n);
  await c.setPrice(PRICE); // 50 -> 100
  c.setTime(T0 + 30n + GRACE); // both windows have ended
  await c.pay(PRICE); // 100 is current, even though its "old price" window has ended
  await assert.rejects(c.pay(50n), /Old price expired/);
  await c.setPrice(80n); // 100 -> 80
  assert.equal(c.view().oldPrices.lookup(PRICE), T0 + 30n + 2n * GRACE);
  await c.pay(PRICE);
  await assert.rejects(c.pay(50n), /Old price expired/);
  assert.equal(c.view().oldPrices.size(), 2n);
});

test('round trip A→B→A→B: the window of A is overwritten: what is guaranteed is 15 min from the last time it was current', async () => {
  const c = await deploy(); // A = 100
  await c.setPrice(50n, T0 + GRACE_MAX); // T0: A->B; A is accepted until T0 + 20 min
  assert.equal(c.view().oldPrices.lookup(PRICE), T0 + GRACE_MAX);
  c.setTime(T0 + 6n);
  await c.setPrice(PRICE); // B->A
  c.setTime(T0 + 12n);
  await c.setPrice(50n); // A->B again with the minimum window: A's end drops to T0 + 12 + 15 min
  const untilA = T0 + 12n + GRACE;
  assert.equal(c.view().oldPrices.lookup(PRICE), untilA, 'was T0 + 20 min before');
  c.setTime(untilA - 1n);
  await c.pay(PRICE); // 15 min since A last stopped being current: guaranteed
  c.setTime(untilA);
  await assert.rejects(c.pay(PRICE), /Old price expired/); // the 20 min from the first change: not guaranteed
});

// Block-time comparisons left in a call's public transcript: the limit compared against (the `push`
// before the `lt`) and the required result (`popeq`).
const leUint = (b: Uint8Array) => BigInt('0x' + (hex(Uint8Array.from(b).reverse()) || '0'));
const transcriptOf = (r: any): any[] => r.context.callProofDataTrace.at(-1).publicTranscript;
const timeChecks = (r: any) => {
  const ops = transcriptOf(r);
  // No assumption about what sits right next to the `lt`: take the last `push` before and the first `popeq` after.
  return ops.flatMap((op, i) => {
    if (op !== 'lt') return [];
    const pushed = ops.slice(0, i).findLast((o) => o?.push);
    const expected = ops.slice(i + 1).find((o) => o?.popeq);
    assert.ok(pushed && expected, 'a time comparison without limit or without result');
    return [{ limit: leUint(pushed.push.value.content.value[0]), result: leUint(expected.popeq.result.value[0]) === 1n }];
  });
};

/** A proven, unsubmitted purchase (does not change the simulator state). */
const provedBuy = (c: Awaited<ReturnType<typeof deploy>>, value: bigint) =>
  c.prove('buyBono', {}, { nonce: rand(), color: c.paymentColor, value }, pc.bonoId(c.ctx, rand(), 0n));

test('privacy: buying at the current price does not compare the time: at the old one, only with the public limit', async () => {
  const c = await deploy();
  assert.deepEqual(timeChecks(await provedBuy(c, PRICE)), []);
  await c.setPrice(50n);
  c.setTime(T0 + 123n); // the time at which the proof is generated
  assert.deepEqual(timeChecks(await provedBuy(c, 50n)), []);
  const old = await provedBuy(c, PRICE);
  // A single comparison, "block time < limit", against the limit stored on the ledger (the same for
  // everyone) with a true result (as in every accepted purchase): it adds nothing to what is public.
  assert.deepEqual(timeChecks(old), [{ limit: T0 + GRACE, result: true }]);
  // Nor the proving device's time: its bytes (little-endian, like the limit's) are absent.
  const le4 = (t: bigint) => hex(new Uint8Array(new BigUint64Array([t]).buffer).subarray(0, 4));
  const dump = JSON.stringify(transcriptOf(old), (_, v) => (v instanceof Uint8Array ? hex(v) : typeof v === 'bigint' ? v.toString() : v));
  assert.ok(dump.includes(le4(T0 + GRACE)), 'the limit does appear');
  assert.ok(!dump.includes(le4(c.time())), 'the proof time does not');
});

test('what the node sees: the time that counts is the block\'s, and a purchase proved before the price change must be proved again', async () => {
  const c = await deploy();
  const before = await provedBuy(c, PRICE); // proven with price = 100...
  c.verifyNow(before);
  await c.setPrice(50n); // ...and the price changes before it arrives
  // It read `price` = 100, which no longer holds: the node rejects it (before the block, no fee). The
  // contract cannot prevent this; the app re-proves with the same amount and it enters via the window.
  assert.throws(() => c.verifyNow(before), /mismatch/);
  const retried = await provedBuy(c, PRICE);
  c.verifyNow(retried);
  // Any change invalidates everything in flight, including this purchase at the old price within its
  // window, because both buyBono branches read `price`.
  await c.setPrice(70n);
  assert.throws(() => c.verifyNow(retried), /mismatch/);
  const again = await provedBuy(c, PRICE); // again with the same amount: 100 is still in its window
  c.verifyNow(again);
  c.setTime(T0 + GRACE - 1n);
  c.verifyNow(again); // still valid up to the last second of the window
  c.setTime(T0 + GRACE);
  assert.throws(() => c.verifyNow(again), /mismatch/); // proven in time but arrives late: rejected
  const current = await provedBuy(c, 70n);
  c.setTime(T0 + 10n ** 9n);
  c.verifyNow(current); // at the current price there is no time to check
  // A price change proven with a lagging operator clock is rejected too: the block time decides.
  const change = await c.prove('setPrice', { opSk: c.opSk }, 60n, c.time() + GRACE);
  c.verifyNow(change);
  c.setTime(c.time() + 1n);
  assert.throws(() => c.verifyNow(change), /mismatch/);
});

// --- Constructor ----------------------------------------------------------------------------------

test('the constructor stores operator, color and price', async () => {
  const c = await deploy();
  const v = c.view();
  assert.equal(hex(v.operatorPk), hex(pc.operatorKey(c.opSk)));
  assert.equal(hex(v.paymentColor), hex(c.paymentColor));
  assert.equal(v.price, PRICE);
  assert.equal(v.oldPrices.size(), 0n, 'no old prices');
});

test('the constructor rejects price 0, empty operator key and empty color (they could not be corrected)', async () => {
  const zero = new Uint8Array(32);
  await assert.rejects(deploy({ price: 0n }), /Price must be positive/);
  await assert.rejects(deploy({ opPk: zero }), /Missing operator key/);
  await assert.rejects(deploy({ color: zero }), /Missing payment color/);
});

// --- Reserved fields -----------------------------------------------------------

// State path of each field, read from the compiler-generated accessors (ledger()).
function fieldPaths(): Record<string, number[]> {
  const src = readFileSync(new URL('../managed/registry-sim/contract/index.js', import.meta.url), 'utf8');
  const start = src.indexOf('export function ledger(');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  const fields = [...body.matchAll(/^ {4}(?:get (\w+)\(\) \{|(\w+): \{)$/gm)];
  return Object.fromEntries(fields.map((m, i) => {
    const firstPath = /path: \[([^\]]*)\]/.exec(body.slice(m.index, fields[i + 1]?.index))![1]!;
    return [m[1] ?? m[2], [...firstPath.matchAll(/toValue\((\d+)n\)/g)].map((x) => Number(x[1]))];
  }));
}

test('the path of each field in the state is the deployment one: adding a field, even at the end, changes them', async () => {
  // The compiler splits the 21 fields into two subarrays, [6, 15] (with 18 fields it was [3, 15] and
  // `bonos` sat at [1, 0]). A circuit added later through the maintenance authority must be compiled
  // with this exact field list; if this test fails, the contract no longer matches the deployed one.
  const c = await deploy();
  assert.deepEqual(c.stateShape(), [6, 15]);
  const first = ['operatorPk', 'paymentColor', 'price', 'bonos', 'slotNullifiers', 'addresses'];
  const second = ['pendingNames', 'round', 'priceMonthly', 'priceAnnual', 'period', 'renewNullifiers', 'addressPaidUntil',
    'releasedSlots', 'spareTree', 'spareSet', 'spareMap', 'spareCounter', 'oldPrices', 'oldPricesMonthly', 'oldPricesAnnual'];
  const expected = Object.fromEntries([...first.map((f, i) => [f, [0, i]]), ...second.map((f, i) => [f, [1, i]])]);
  assert.deepEqual(fieldPaths(), expected);
  assert.deepEqual(Object.keys(c.view()).sort(), Object.keys(expected).sort(), 'not one field more or less');
});

test('the reserved and spare fields exist from deployment and stay empty', async () => {
  const c = await deploy();
  const v = c.view();
  assert.equal(v.period, 0n);
  assert.equal(v.priceMonthly, 0n);
  assert.equal(v.priceAnnual, 0n);
  assert.equal(v.oldPricesMonthly.size(), 0n);
  assert.equal(v.oldPricesAnnual.size(), 0n);
  assert.equal(v.renewNullifiers.size(), 0n);
  assert.equal(v.addressPaidUntil.size(), 0n);
  assert.equal(v.releasedSlots.firstFree(), 0n);
  assert.equal(v.spareTree.firstFree(), 0n);
  assert.equal(v.spareSet.size(), 0n);
  assert.equal(v.spareMap.size(), 0n);
  assert.equal(v.spareCounter, 0n);
});
