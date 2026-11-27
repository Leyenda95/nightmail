// Independent check of the contract vectors: persistentHash is SHA-256 of the value's binary encoding
// (Bytes<N> as is, enums and Uint<8> as 1 byte, Uint<32> as 4 bytes little-endian).
// It does not use the compiled contract, so if a compiler or runtime change altered an encoding, this
// test and the vector test would disagree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const v = JSON.parse(readFileSync(new URL('../../test-vectors/contract/registry.json', import.meta.url), 'utf8'));
const i = v.inputs;
const sha = (...parts: Buffer[]) => createHash('sha256').update(Buffer.concat(parts)).digest('hex');
const b = (hex: string) => Buffer.from(hex, 'hex');
const pad = (text: string, n: number) => Buffer.concat([Buffer.from(text), Buffer.alloc(n - text.length)]);
const u8 = (x: number) => Buffer.from([x]);
const u32 = (x: number) => {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(x);
  return out;
};
const ctx = b(i.contractAddress); // ctxOf: the address as is
const [MAILBOX, ALIAS, FREE, PAID] = [0, 1, 0, 1];

test('SHA-256 reproduces all the hashes of registry.json without the compiled contract', () => {
  assert.equal(v.ctx, i.contractAddress);
  assert.equal(sha(pad('nightmail:operator-pk:', 32), b(i.operatorSk)), v.operatorPk);
  const id = sha(pad('nightmail:bono-id:', 32), ctx, b(i.s), u32(1));
  assert.equal(id, v.bonoId);
  assert.equal(sha(pad('nightmail:bono-leaf:', 32), ctx, b(id), u8(FREE), u32(0xffffffff)), v.bonoLeafFree);
  assert.equal(sha(pad('nightmail:bono-leaf:', 32), ctx, b(id), u8(PAID), u32(0xffffffff)), v.bonoLeafPaid);
  const slot = (kind: number, j: number, gen: number) => sha(pad('nightmail:bono-slot:', 32), ctx, b(i.s), u8(kind), u8(j), u32(gen));
  assert.equal(slot(MAILBOX, 3, 0), v.slotNullifierMailbox3);
  assert.equal(slot(ALIAS, 3, 0), v.slotNullifierAlias3);
  assert.equal(slot(MAILBOX, 3, 1), v.slotNullifierMailbox3Gen1);
  assert.equal(sha(pad('nightmail:addr:', 64), pad('juan.perez', 64)), v.addressKey);
  assert.equal(sha(b(i.encPk), b(i.authPk), b(v.slotNullifierAlias3)), v.aliasKey);
});
