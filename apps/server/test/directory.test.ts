import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '@nightmail/core-ts';
import { ResolutionIndex } from '@nightmail/midnight';
import { AddressDirectory } from '../src/registry/directory.ts';
import { alias, LOW_ORDER_AUTH_PK, LOW_ORDER_ENC_PK, mailbox, sameSuffixKey } from './mail-fixtures.ts';

function directoryWith(...blocks: ReturnType<typeof alias>[][]) {
  const index = new ResolutionIndex();
  blocks.forEach((block, i) => index.addBlock(i + 1, block.map((a) => a.entry)));
  return { index, directory: new AddressDirectory(index) };
}

test('a mailbox resolves by its name and an alias by its full text, with its keys as bytes', () => {
  const juan = mailbox('juan.perez');
  const nube = alias();
  const { directory } = directoryWith([juan, nube]);
  const forJuan = directory.recipient('Juan.Perez')!;
  assert.equal(toHex(forJuan.addrKey), juan.entry.addrKey);
  assert.equal(toHex(forJuan.encPk), juan.entry.encPk);
  assert.equal(toHex(forJuan.authPk), juan.entry.authPk);
  assert.equal(toHex(directory.recipient(nube.localPart.toUpperCase())!.addrKey), nube.entry.addrKey);
  assert.equal(directory.recipient('nadie'), undefined);
});

test('box: by addrKey in hex, mailbox or alias, unknown or malformed does not exist', () => {
  const juan = mailbox('juan.perez');
  const nube = alias();
  const { directory } = directoryWith([juan, nube]);
  assert.equal(toHex(directory.box(juan.entry.addrKey)!.authPk), juan.entry.authPk);
  assert.equal(toHex(directory.box(nube.entry.addrKey)!.authPk), nube.entry.authPk);
  assert.equal(directory.box('ab'.repeat(32)), undefined);
  assert.equal(directory.box(juan.entry.addrKey.toUpperCase()), undefined);
  assert.equal(directory.box(''), undefined);
});

test('an address with an unusable encryption key does not exist: it neither receives nor is served', () => {
  const bad = mailbox('clave.mala', { encPk: LOW_ORDER_ENC_PK });
  const badAlias = alias(undefined, { encPk: 'ff'.repeat(32) }); // not canonical
  const { directory } = directoryWith([bad, badAlias]);
  assert.equal(directory.recipient('clave.mala'), undefined);
  assert.equal(directory.box(bad.entry.addrKey), undefined);
  assert.equal(directory.recipient(badAlias.localPart), undefined);
  assert.equal(directory.box(badAlias.entry.addrKey), undefined);
});

test('an address with a low-order signing key does not exist either', () => {
  const bad = mailbox('firma.mala', { authPk: LOW_ORDER_AUTH_PK });
  const { directory } = directoryWith([bad]);
  assert.equal(directory.recipient('firma.mala'), undefined);
  assert.equal(directory.box(bad.entry.addrKey), undefined);
});

test('the §4.2 rules hold: a mailbox with alias text does not receive, nor do reserved names', () => {
  const victim = alias();
  // The contract accepts a mailbox with any addrKey, but one "named like an alias" cannot even be built here
  // (mailboxName rejects it), so the rule is checked from outside: the alias text only leads to the alias.
  const { directory } = directoryWith([victim]);
  assert.equal(toHex(directory.recipient(victim.localPart)!.addrKey), victim.entry.addrKey);
  assert.equal(directory.recipient(`otra.cosa.${victim.localPart.slice(-12)}`), undefined, 'the suffix alone is not enough');
  assert.equal(directory.recipient('postmaster'), undefined);
  assert.equal(directory.recipient('admin'), undefined);
});

test('the suffix belongs to the first one even if its keys are unusable: the second does not inherit it', () => {
  const first = alias(undefined, { encPk: LOW_ORDER_ENC_PK });
  const second = alias(sameSuffixKey(first.addrKey));
  const { directory } = directoryWith([first], [second]);
  assert.equal(directory.recipient(first.localPart), undefined);
  assert.equal(directory.recipient(second.localPart), undefined, 'the suffix does not pass to the next one');
  assert.ok(directory.box(second.entry.addrKey), 'but its box exists for the API');
});

test('sees addresses added to the index after it is created', () => {
  const { index, directory } = directoryWith([]);
  const nuevo = mailbox('recien.llegado');
  assert.equal(directory.recipient('recien.llegado'), undefined);
  index.addBlock(7, [nuevo.entry]);
  assert.ok(directory.recipient('recien.llegado'));
  assert.ok(directory.box(nuevo.entry.addrKey));
});
