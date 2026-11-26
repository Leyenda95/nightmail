// Reader for NightMailRegistry public state: from the compiled contract's ledger to a typed, pageable
// model. No networking: it takes the ledger (or the state bytes, see decodeRegistry).
//
// Collections come out sorted by value (hex), not in chain order. A ledger Map or Set does not keep
// insertion order, so this model cannot serve the "first alias owns the suffix" rule (see
// resolution.ts); that order comes from following states block by block.
// The `bonos` leaves are not included, only their count and the current root.
import { ContractState } from '@midnight-ntwrk/compact-runtime';
import { type Kind, ledger, type Ledger } from './contract.ts';
import { InvalidInput, toHex } from './input.ts';

/** An `addresses` record (bytes as hex). Called AddressEntry in the sidecar protocol. */
export type RegistryAddress = {
  addrKey: string;
  encPk: string;
  authPk: string;
  kind: Kind;
  nameCipher: string;
  slotNul: string;
};
export type PendingEntry = { slotNul: string; reservedRound: bigint; commit: string };
/** A replaced price and the block time (Unix seconds, exclusive) until which it is still accepted. */
export type OldPrice = { price: bigint; until: bigint };

export type RegistrySnapshot = {
  round: bigint;
  price: bigint;
  oldPrices: OldPrice[];
  slotNullifiers: string[];
  addresses: RegistryAddress[];
  pendingNames: PendingEntry[];
  /** leafCount = leaves inserted (= first free position, as they are inserted in order); root = Field. */
  bonos: { leafCount: bigint; root: bigint };
};

/** Sorted by their text key (keys of a ledger Map or Set are unique). */
function sortedBy<T>(items: T[], key: (item: T) => string): T[] {
  const byKey = new Map(items.map((item) => [key(item), item]));
  return [...byKey.keys()].sort().map((k) => byKey.get(k)!);
}

/** Amount as text that sorts like the number (Uint<128>: at most 39 digits). */
const amountKey = (p: OldPrice) => p.price.toString().padStart(39, '0');

export function readRegistry(l: Ledger): RegistrySnapshot {
  const addresses: RegistryAddress[] = [...l.addresses].map(([key, r]) => ({
    addrKey: toHex(key), encPk: toHex(r.encPk), authPk: toHex(r.authPk), kind: r.kind,
    nameCipher: toHex(r.nameCipher), slotNul: toHex(r.slotNul),
  }));
  const pendingNames: PendingEntry[] = [...l.pendingNames].map(([nul, p]) => ({
    slotNul: toHex(nul), reservedRound: p.reservedRound, commit: toHex(p.commit),
  }));
  const oldPrices: OldPrice[] = [...l.oldPrices].map(([price, until]) => ({ price, until }));
  return {
    round: l.round,
    price: l.price,
    oldPrices: sortedBy(oldPrices, amountKey),
    slotNullifiers: [...l.slotNullifiers].map(toHex).sort(),
    addresses: sortedBy(addresses, (a) => a.addrKey),
    pendingNames: sortedBy(pendingNames, (p) => p.slotNul),
    bonos: { leafCount: l.bonos.firstFree(), root: l.bonos.root().field },
  };
}

/** The state belongs to another contract (or another version of this one), not a NightMailRegistry. */
export class NotRegistryState extends InvalidInput {}

/**
 * Model of a hex-serialized state (the indexer's `state` field). The ledger is read lazily, so another
 * contract's state may fail on any field access; everything is therefore read in here. Errors:
 * InvalidInput if it is not a contract state, NotRegistryState if it is another contract.
 */
export function decodeRegistry(stateHex: string): RegistrySnapshot {
  return asRegistry(decodeState(stateHex), (state) => readRegistry(ledger(state.data)));
}

/** Contract state from its hex serialization. InvalidInput if it is not one. */
export function decodeState(stateHex: string): ContractState {
  if (typeof stateHex !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(stateHex)) throw new InvalidInput('state: expected hex');
  try {
    return ContractState.deserialize(Buffer.from(stateHex, 'hex'));
  } catch {
    throw new InvalidInput('state: not a contract state');
  }
}

/** Reads the state as a NightMailRegistry; if reading fails, it belongs to another contract. */
function asRegistry<T>(state: ContractState, read: (state: ContractState) => T): T {
  try {
    return read(state);
  } catch {
    throw new NotRegistryState('state: not a NightMailRegistry contract state');
  }
}

/**
 * Where the compiled contract stores the `bonos` tree: field 3 of the first state subarray (fixed by the
 * final field list; see the path test in contracts/test/registry.test.ts). Inside a HistoricMerkleTree
 * the tree is the first element (followed by firstFree and the roots).
 */
const BONOS_TREE = [0, 3, 0] as const;

/**
 * Leaf (hex) → position index of the `bonos` tree. The contract inserts with insertHash, so the compiled
 * ledger cannot look a leaf up by value (findPathForLeaf would hash it again); leaves are read from the
 * serialized tree instead. The position is what `bonos.pathForLeaf` expects.
 * A leaf may repeat: the contract allows it (`buyBono` is open to anyone and a retry can buy the same id
 * twice). Any position of a leaf yields a valid path; the first one is returned.
 * `leafCount`: occupied positions (= `firstFree`), duplicates included.
 * NotRegistryState if the state is not a NightMailRegistry.
 */
export function bonoPositions(state: ContractState): { positions: Map<string, number>; leafCount: number } {
  return asRegistry(state, (s) => {
    const tree = BONOS_TREE.reduce((value, i) => value.asArray()![i]!, s.data.state).encode();
    if (tree.tag !== 'boundedMerkleTree') throw new Error('bonos: not a tree');
    const entries = [...tree.content[1]].map(([position, [leaf]]) => [toHex(leaf), Number(position)] as const);
    // Leaves are inserted in order with no gaps: as many positions as firstFree.
    if (BigInt(entries.length) !== ledger(s.data).bonos.firstFree()) throw new Error('bonos: leaves do not match firstFree');
    const positions = new Map<string, number>();
    for (const [leaf, position] of entries.sort((a, b) => a[1] - b[1])) if (!positions.has(leaf)) positions.set(leaf, position);
    return { positions, leafCount: entries.length };
  });
}

/**
 * State of a contract action as delivered by the indexer v4 `contractActions` subscription: '' if the
 * transaction failed (returns null, no new state), otherwise the model (as decodeRegistry).
 */
export const decodeActionState = (stateHex: string): RegistrySnapshot | null =>
  stateHex === '' ? null : decodeRegistry(stateHex);

/**
 * Addresses added between the states of two consecutive blocks, sorted by addrKey since there is no
 * order within a block (see ResolutionIndex.addBlock).
 * `previous = null` is only valid for the deployment block (the contract's first state): with a later
 * state, all earlier addresses would look like one block and their shared suffixes would be blocked in
 * the index (see the requirement in resolution.ts).
 */
export function newAddressesBetween(previous: RegistrySnapshot | null, next: RegistrySnapshot): RegistryAddress[] {
  const before = new Set(previous?.addresses.map((a) => a.addrKey));
  return next.addresses.filter((a) => !before.has(a.addrKey));
}

/** Slice of `limit` items from `offset`; `next` is the following offset, or null if there are no more. */
export function page<T>(items: readonly T[], offset: number, limit: number): { items: T[]; next: number | null } {
  const end = offset + limit;
  return { items: items.slice(offset, end), next: end < items.length ? end : null };
}
