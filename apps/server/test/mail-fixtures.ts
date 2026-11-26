// Mail server test data: addresses as the registry provides them, with their keys.
import { randomBytes } from 'node:crypto';
import { ed25519PublicKey, generateSecretKey, toHex, x25519PublicKey } from '@nightmail/core-ts';
import { addrKey, aliasAddress, Kind, type RegistryAddress, type RegistryAt, type RegistrySnapshot } from '@nightmail/midnight';

export type TestAddress = {
  entry: RegistryAddress;
  /** Local part mail is sent to. */
  localPart: string;
  addrKey: Uint8Array;
  encSecretKey: Uint8Array;
  authSecretKey: Uint8Array;
};

function withKeys(key: Uint8Array, kind: Kind, localPart: string, overrides: Partial<RegistryAddress>): TestAddress {
  const encSecretKey = generateSecretKey();
  const authSecretKey = generateSecretKey();
  const entry: RegistryAddress = {
    addrKey: toHex(key),
    encPk: toHex(x25519PublicKey(encSecretKey)),
    authPk: toHex(ed25519PublicKey(authSecretKey)),
    kind,
    nameCipher: '00'.repeat(104),
    slotNul: toHex(randomBytes(32)),
    ...overrides,
  };
  return { entry, localPart, addrKey: key, encSecretKey, authSecretKey };
}

/** A mailbox with that name (its addrKey comes from the contract's pure circuit). */
export function mailbox(name: string, overrides: Partial<RegistryAddress> = {}): TestAddress {
  return withKeys(addrKey(name), Kind.mailbox, name, overrides);
}

/** An alias with that addrKey (random if omitted). */
export function alias(key: Uint8Array = new Uint8Array(randomBytes(32)), overrides: Partial<RegistryAddress> = {}): TestAddress {
  return withKeys(key, Kind.alias, aliasAddress(key), overrides);
}

/** Another addrKey with the same alias suffix (first 60 bits) and a different remainder. */
export function sameSuffixKey(key: Uint8Array): Uint8Array {
  const other = new Uint8Array(randomBytes(32));
  other.set(key.subarray(0, 8));
  return other;
}

/** Registry state with those addresses (everything else empty). */
export function snapshotOf(addresses: RegistryAddress[]): RegistrySnapshot {
  return {
    round: 0n,
    price: 100n,
    oldPrices: [],
    slotNullifiers: [],
    addresses: [...addresses].sort((a, b) => (a.addrKey < b.addrKey ? -1 : 1)),
    pendingNames: [],
    bonos: { leafCount: 0n, root: 0n },
  };
}

/** Made-up hash of the block at that height in the tests' fake chains. */
export const blockHashOf = (height: number): string => height.toString(16).padStart(64, '0');

/** What `fetchRegistry` returns for a block with those addresses in the registry. */
export function registryAt(height: number, addresses: RegistryAddress[]): RegistryAt {
  return { blockHeight: height, blockHash: blockHashOf(height), blockTimestamp: 0, stateBytes: 1000, snapshot: snapshotOf(addresses) };
}

/** Low-order X25519 key (u = 0): nothing can be encrypted to it. */
export const LOW_ORDER_ENC_PK = '00'.repeat(32);
/** Low-order Ed25519 key (y = 1, the identity): anyone could forge valid signatures. */
export const LOW_ORDER_AUTH_PK = '01' + '00'.repeat(31);
