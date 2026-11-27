// NightMailRegistry witnesses (same names and types as declared by the contract). They read each
// call's private state. The operator only uses operatorSecret (issueBono), but the
// contract requires all of them to be constructed, including at deploy time.
import { CompactTypeBytes, StateValue, type ChargedState } from '@midnight-ntwrk/compact-runtime';

export type Bono = { s: Uint8Array; k: bigint; plan: number; validUntil: bigint };
export type RegistryPrivateState = { bono: Bono; j: bigint; opSk: Uint8Array };

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

function pathOf(c: any, leaf: Uint8Array, positionOf: (leafHex: string) => bigint | undefined) {
  const pos = positionOf(hex(leaf));
  // Never guess a position: the proof would fail anyway, and this way the reason is visible.
  if (pos === undefined) throw new Error(`bonoPath: unknown position for leaf ${hex(leaf).slice(0, 8)}…`);
  return c.ledger.bonos.pathForLeaf(pos, leaf);
}

/** `positionOf(leafHex)`: the leaf's position in the `bonos` tree (insertHash leaves cannot be found by value). */
export function registryWitnesses(positionOf: (leafHex: string) => bigint | undefined = () => undefined) {
  return {
    bonoSecret: (c: any) => [c.privateState, c.privateState.bono.s],
    bonoLeafIndex: (c: any) => [c.privateState, c.privateState.bono.k],
    bonoPlan: (c: any) => [c.privateState, c.privateState.bono.plan],
    bonoValidUntil: (c: any) => [c.privateState, c.privateState.bono.validUntil],
    slotIndex: (c: any) => [c.privateState, c.privateState.j],
    bonoPath: (c: any, leaf: Uint8Array) => [c.privateState, pathOf(c, leaf, positionOf)],
    operatorSecret: (c: any) => [c.privateState, c.privateState.opSk],
  };
}

const LEAF = new CompactTypeBytes(32);
/**
 * Location of `bonos` in the contract state: the compiler splits the 21 fields into [6, 15] and `bonos`
 * is the fourth of the first group. The field list is final; a contract test pins every field's path and
 * the generated code uses this same one: `state.asArray()[0].asArray()[3]`.
 */
const BONOS_FIELD = [0, 3] as const;

/**
 * Whether the leaf is already in the `bonos` tree. `data` is the contract state (`ContractState.data`).
 * Leaves are inserted with `insertHash`, so the generated `bonos.findPathForLeaf` cannot find them (it
 * hashes its input again); instead the raw tree is searched, flagging the value as already hashed.
 * Verified on the simulator and on the devnet (compact-runtime 0.21.0).
 */
export function hasBonoLeaf(data: ChargedState | StateValue, leaf: Uint8Array): boolean {
  if (!(leaf instanceof Uint8Array) || leaf.length !== 32) throw new Error('hasBonoLeaf: expected a leaf of 32 bytes');
  const state = data instanceof StateValue ? data : data.state;
  const tree = state.asArray()![BONOS_FIELD[0]]!.asArray()![BONOS_FIELD[1]]!.asArray()![0]!.asBoundedMerkleTree()!.rehash();
  return tree.findPathForLeaf({ value: LEAF.toValue(leaf), alignment: LEAF.alignment() }, undefined, undefined, true) !== undefined;
}
