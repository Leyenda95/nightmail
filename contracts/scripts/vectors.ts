// Known-answer vectors for the NightMailRegistry pure functions, shared by the contract tests and,
// later, the Rust core, the server and the sidecar.
//   node scripts/vectors.ts   -> writes packages/test-vectors/contract/registry.json
// Changing a contract formula requires regenerating them deliberately.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Kind, Plan, pureCircuits as pc } from '../managed/registry-sim/contract/index.js';

export const VECTORS_FILE = fileURLToPath(new URL('../../packages/test-vectors/contract/registry.json', import.meta.url));

const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** Computes the vectors with the compiled contract. Fixed inputs, hex outputs. */
export function computeVectors() {
  const address = bytes(32, 0xad), s = bytes(32, 0x51), enc = bytes(32, 0xe1), auth = bytes(32, 0xa7);
  const salt = bytes(32, 0x5a), opSk = bytes(32, 0x0b);
  const name = new Uint8Array(64);
  name.set(new TextEncoder().encode('juan.perez'));
  const ctx = pc.ctxOf({ bytes: address });
  const id = pc.bonoId(ctx, s, 1n);
  const slotNul = pc.slotNullifier(ctx, s, Kind.mailbox, 3n, 0n);
  const addrKey = pc.addressKey(name);
  return {
    note: 'Generated with the compiled contract: today they are a regression snapshot. They will become cross '
      + 'vectors when the Rust core, the server and the sidecar check them with their own implementation.',
    inputs: {
      contractAddress: hex(address), s: hex(s), k: '1', encPk: hex(enc), authPk: hex(auth), salt: hex(salt),
      operatorSk: hex(opSk), name: 'juan.perez (UTF-8, zero-padded to 64 bytes)', mailboxSlot: '3', gen: '0',
    },
    noExpiry: pc.noExpiry().toString(),
    // Grace window of a replaced price (seconds from the block of the change): the operator passes
    // setPrice an end between the two, e.g. its clock + the midpoint.
    oldPriceGrace: { minSeconds: pc.oldPriceGrace().toString(), maxSeconds: pc.oldPriceGraceMax().toString() },
    limits: {
      free: { mailbox: Number(pc.slotLimit(Plan.free, Kind.mailbox)), alias: Number(pc.slotLimit(Plan.free, Kind.alias)) },
      paid: { mailbox: Number(pc.slotLimit(Plan.paid, Kind.mailbox)), alias: Number(pc.slotLimit(Plan.paid, Kind.alias)) },
    },
    ctx: hex(ctx),
    operatorPk: hex(pc.operatorKey(opSk)),
    bonoId: hex(id),
    bonoLeafFree: hex(pc.bonoLeaf(ctx, id, Plan.free, pc.noExpiry())),
    bonoLeafPaid: hex(pc.bonoLeaf(ctx, id, Plan.paid, pc.noExpiry())),
    slotNullifierMailbox3: hex(slotNul),
    slotNullifierAlias3: hex(pc.slotNullifier(ctx, s, Kind.alias, 3n, 0n)),
    slotNullifierMailbox3Gen1: hex(pc.slotNullifier(ctx, s, Kind.mailbox, 3n, 1n)),
    addressKey: hex(addrKey),
    aliasKey: hex(pc.aliasKey(enc, auth, pc.slotNullifier(ctx, s, Kind.alias, 3n, 0n))),
    nameCommit: hex(pc.nameCommit(addrKey, enc, auth, salt, slotNul)),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(VECTORS_FILE, JSON.stringify(computeVectors(), null, 2) + '\n');
  console.log(`written ${VECTORS_FILE}`);
}
