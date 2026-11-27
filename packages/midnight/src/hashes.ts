// NightMailRegistry hashes that must match the chain, computed with the compiled contract's pure
// circuits (never reimplemented: one differing byte breaks the system). Inputs are validated here
// against the contract's sizes and ranges so that errors are InvalidInput (fixed message) rather than
// an internal runtime failure.
import { Kind, Plan, pureCircuits as pc } from './contract.ts';
import { fromHex, InvalidInput, uint } from './input.ts';
import { nameBytes } from './names.ts';

/** No expiry: the validUntil of every leaf in the MVP (max Uint<32>). */
export const NO_EXPIRY: bigint = pc.noExpiry();

function bytes32(value: Uint8Array, what: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32) throw new InvalidInput(`${what}: expected 32 bytes`);
  return value;
}

function member<T extends number>(value: T, allowed: object, what: string): T {
  if (typeof value !== 'number' || !Object.values(allowed).includes(value)) throw new InvalidInput(`${what}: unknown value`);
  return value;
}

/** Deployment ctx, from the contract address (32-byte hex, as the SDK returns it). */
export const ctx = (contractAddress: string): Uint8Array =>
  pc.ctxOf({ bytes: fromHex(contractAddress, 32, 'contractAddress') });

/** id_k = bonoId(ctx, s, k): the id of leaf k of `bono` s. */
export const idK = (c: Uint8Array, s: Uint8Array, k: bigint): Uint8Array =>
  pc.bonoId(bytes32(c, 'ctx'), bytes32(s, 's'), uint(k, 32, 'k'));

/** `bono` leaf: bonoLeaf(ctx, id_k, plan, validUntil). */
export const leaf = (c: Uint8Array, id: Uint8Array, plan: Plan, validUntil: bigint): Uint8Array =>
  pc.bonoLeaf(bytes32(c, 'ctx'), bytes32(id, 'id'), member(plan, Plan, 'plan'), uint(validUntil, 32, 'validUntil'));

/** Nullifier of slot (kind, j) of `bono` s, generation gen (0 in the MVP). */
export const slotNul = (c: Uint8Array, s: Uint8Array, kind: Kind, j: bigint, gen: bigint): Uint8Array =>
  pc.slotNullifier(bytes32(c, 'ctx'), bytes32(s, 's'), member(kind, Kind, 'kind'), uint(j, 8, 'j'), uint(gen, 32, 'gen'));

/**
 * Mailbox addrKey: addressKey(64-byte mailbox name). Rejects anything `mailboxName` rejects, so it is
 * for registering and lookup, not for recovery: the reserved list may grow and an already registered
 * mailbox would stop computing. Recovery takes the addrKey from the on-chain record (found by its
 * slotNul) instead of recomputing it.
 */
export const addrKey = (name: string): Uint8Array => pc.addressKey(nameBytes(name));

/** Alias addrKey: aliasKey(encPk, authPk, slotNul). */
export const aliasAddrKey = (encPk: Uint8Array, authPk: Uint8Array, nul: Uint8Array): Uint8Array =>
  pc.aliasKey(bytes32(encPk, 'encPk'), bytes32(authPk, 'authPk'), bytes32(nul, 'slotNul'));
