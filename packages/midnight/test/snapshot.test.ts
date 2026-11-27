// NightMailRegistry state reader: from public state (the compiled contract ledger or the bytes the
// indexer serves) to a typed, pageable model. States are built with the contract test simulator
// (contracts/test/sim.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContractState } from '@midnight-ntwrk/compact-runtime';
import {
  decodeActionState, decodeRegistry, InvalidInput, Kind, newAddressesBetween, NotRegistryState, page, Plan, readRegistry,
} from '../src/index.ts';
import { contractStateOf, deploy, hex, registryState } from './helpers.ts';

const sorted = (xs: string[]) => [...xs].sort();

test('freshly deployed contract: initial price, empty collections and tree without leaves', async () => {
  const c = await deploy({ price: 7n });
  const s = readRegistry(c.view());
  assert.equal(s.price, 7n);
  assert.deepEqual(s.oldPrices, []);
  assert.deepEqual(s.slotNullifiers, []);
  assert.deepEqual(s.addresses, []);
  assert.equal(s.bonos.leafCount, 0n);
  assert.equal(s.bonos.root, c.view().bonos.root().field);
});

test('full model: addresses, nullifiers, old prices and tree summary', async () => {
  const c = await deploy();
  const emptyRoot = readRegistry(c.view()).bonos.root;
  const free = await c.issue(Plan.free);
  const paid = await c.issue(Plan.paid);
  const a1 = await c.alias(free, 0n);
  const a2 = await c.alias(paid, 4n);
  const juan = c.mailbox('juan.perez', paid, 0n);
  await c.register(juan);
  await c.setPrice(150n);

  const s = readRegistry(c.view());
  assert.equal(s.price, 150n);
  assert.deepEqual(s.oldPrices, [{ price: 100n, until: c.time() + 900n }]);
  assert.equal(s.bonos.leafCount, 2n);
  assert.notEqual(s.bonos.root, emptyRoot);
  assert.equal(s.bonos.root, c.view().bonos.root().field);

  const nuls = [a1, a2].map((a) => hex(c.slotNul(a.bono, Kind.alias, a.j))).concat(hex(juan.slotNul));
  assert.deepEqual(s.slotNullifiers, sorted(nuls), 'sorted by value');

  assert.deepEqual(s.addresses.map((a) => a.addrKey), sorted([a1, a2, juan].map((a) => hex(a.addrKey))));
  const byKey = new Map(s.addresses.map((a) => [a.addrKey, a]));
  assert.deepEqual(byKey.get(hex(juan.addrKey)), {
    addrKey: hex(juan.addrKey), encPk: hex(juan.encPk), authPk: hex(juan.authPk), kind: Kind.mailbox,
    nameCipher: hex(juan.nameCipher), slotNul: hex(juan.slotNul),
  });
  assert.deepEqual(byKey.get(hex(a2.addrKey)), {
    addrKey: hex(a2.addrKey), encPk: hex(a2.encPk), authPk: hex(a2.authPk), kind: Kind.alias,
    nameCipher: '00'.repeat(104), slotNul: hex(c.slotNul(paid, Kind.alias, 4n)),
  });
});

test('several old prices, sorted by amount (numeric, not as text)', async () => {
  const c = await deploy({ price: 1000n });
  for (const [i, p] of [9n, 300n, 20n, 5n].entries()) await c.setPrice(p, c.time() + 900n + BigInt(i));
  const s = readRegistry(c.view());
  assert.equal(s.price, 5n);
  const t = c.time() + 900n;
  assert.deepEqual(s.oldPrices, [
    { price: 9n, until: t + 1n }, { price: 20n, until: t + 3n }, { price: 300n, until: t + 2n }, { price: 1000n, until: t },
  ]);
});

test('decodeRegistry reads the state bytes as the indexer serves them (hex)', async () => {
  const c = await deploy({ price: 9n });
  await c.issue(Plan.free);
  const cs = contractStateOf(c);
  const decoded = decodeRegistry(hex(cs.serialize()));
  assert.deepEqual(decoded, readRegistry(c.view()));
  assert.equal(decoded.price, 9n);
});

test('decodeRegistry rejects what is not a NightMailRegistry state', () => {
  const otherContract = hex(new ContractState().serialize()); // a valid state, but without these fields
  const notHex = { name: 'Error', message: 'state: expected hex' };
  for (const bad of ['', 'zz', 'ABCD', 'abc', 42]) {
    assert.throws(() => decodeRegistry(bad as string), InvalidInput, String(bad));
    assert.throws(() => decodeRegistry(bad as string), notHex, String(bad));
  }
  for (const bad of ['00', 'deadbeef']) {
    assert.throws(() => decodeRegistry(bad), InvalidInput, bad);
    assert.throws(() => decodeRegistry(bad), { message: 'state: not a contract state' }, bad);
    assert.throws(() => decodeRegistry(bad), (e) => !(e instanceof NotRegistryState), bad);
  }
  assert.throws(() => decodeRegistry(otherContract), NotRegistryState, 'state of another contract');
  assert.throws(() => decodeRegistry(otherContract), { message: 'state: not a NightMailRegistry contract state' });
});

test('decodeActionState: "" (failed transaction in contractActions) is null: otherwise, as decodeRegistry', async () => {
  assert.equal(decodeActionState(''), null);
  const { stateHex, expected } = await registryState();
  assert.deepEqual(decodeActionState(stateHex), expected);
  assert.throws(() => decodeActionState('zz'), InvalidInput);
});

test('newAddressesBetween: the addresses that entered between two states of consecutive blocks', async () => {
  const c = await deploy();
  const bono = await c.issue(Plan.paid);
  await c.alias(bono, 0n);
  const before = readRegistry(c.view());
  const a1 = await c.alias(bono, 1n);
  const a2 = await c.alias(bono, 2n);
  const after = readRegistry(c.view());
  assert.deepEqual(newAddressesBetween(before, after).map((a) => a.addrKey), sorted([hex(a1.addrKey), hex(a2.addrKey)]));
  assert.deepEqual(newAddressesBetween(null, before), before.addresses, 'no previous state: all of them');
  assert.deepEqual(newAddressesBetween(after, after), []);
});

test('page: chunks of `limit` from `offset`, and `next` until the end', () => {
  const xs = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(page(xs, 0, 2), { items: ['a', 'b'], next: 2 });
  assert.deepEqual(page(xs, 2, 2), { items: ['c', 'd'], next: 4 });
  assert.deepEqual(page(xs, 4, 2), { items: ['e'], next: null });
  assert.deepEqual(page(xs, 3, 2), { items: ['d', 'e'], next: null }, 'exactly at the end: there are no more');
  assert.deepEqual(page(xs, 5, 2), { items: [], next: null });
  assert.deepEqual(page(xs, 9, 2), { items: [], next: null });
  assert.deepEqual(page([], 0, 1), { items: [], next: null });
});
