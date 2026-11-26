// Server-side address resolution index. Pure: it does not read the chain.
//
// Rules the contract cannot enforce:
// 1. An alias-shaped local part resolves only through the suffix index and must match the registered
//    text exactly; never via H(name), since the contract accepts a mailbox named like someone's alias.
// 2. A suffix belongs to the first alias in chain order. Reserved names are never delivered.
//
// The finest chain order available is the block (indexer actions in one block share end-of-block
// state), so ties in a block are closed: two new aliases with the same free suffix block it forever.
// The index must therefore be fed every block with new addresses, in order, from deployment;
// merging blocks would wrongly block suffixes. `addBlock` is idempotent (the indexer redelivers).
import { aliasAddress, isAliasShaped, SUFFIX_CHARS, suffixOf } from './alias.ts';
import { Kind } from './contract.ts';
import { addrKey } from './hashes.ts';
import { fromHex, InvalidInput, toHex } from './input.ts';
import { NAME_BYTES } from './names.ts';
import type { RegistryAddress } from './snapshot.ts';

/** A local part that is not printable ASCII is never an address (and toLowerCase never sees it). */
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
const SUFFIX = new RegExp(`^[0-9a-hjkmnp-tv-z]{${SUFFIX_CHARS}}$`);

type Indexed = { entry: RegistryAddress; text: string };

/** Persistable index state (JSON). Changing its shape requires bumping `version`. */
export type ResolutionIndexState = {
  version: 1;
  /** Last height added (-1: none). */
  lastHeight: number;
  /** All addresses, in the order they arrived. */
  addresses: RegistryAddress[];
  /** suffix → addrKey of the alias holding it. */
  suffixes: { suffix: string; addrKey: string }[];
  /** Suffixes blocked by a tie. */
  blocked: string[];
  /** Suffixes first claimed at `lastHeight` (another alias with one of them at that same height is a tie). */
  claimedAtLastHeight: string[];
};
export const RESOLUTION_INDEX_STATE_VERSION = 1;

function groupBySuffix(aliases: Indexed[]): Map<string, Indexed[]> {
  const groups = new Map<string, Indexed[]>();
  for (const a of aliases) {
    const suffix = suffixOf(a.text);
    const group = groups.get(suffix);
    if (group) group.push(a);
    else groups.set(suffix, [a]);
  }
  return groups;
}

const badState = () => new InvalidInput('index state: invalid');

/** A saved address, with every field checked. */
function checkAddress(a: unknown): RegistryAddress {
  const e = a as RegistryAddress;
  if (typeof e !== 'object' || e === null || (e.kind !== Kind.mailbox && e.kind !== Kind.alias)) throw badState();
  for (const [field, bytes] of [['addrKey', 32], ['encPk', 32], ['authPk', 32], ['nameCipher', 104], ['slotNul', 32]] as const) {
    fromHex(e[field], bytes, field);
  }
  return { addrKey: e.addrKey, encPk: e.encPk, authPk: e.authPk, kind: e.kind, nameCipher: e.nameCipher, slotNul: e.slotNul };
}

/** Version, height and main lists of a saved state. */
function checkHeader(state: unknown): ResolutionIndexState {
  const s = state as ResolutionIndexState;
  if (typeof s !== 'object' || s === null || s.version !== RESOLUTION_INDEX_STATE_VERSION) throw badState();
  if (!Number.isSafeInteger(s.lastHeight) || s.lastHeight < -1) throw badState();
  if (!Array.isArray(s.addresses) || !Array.isArray(s.suffixes)) throw badState();
  return s;
}

function checkSuffixes(list: unknown): string[] {
  if (!Array.isArray(list) || !list.every((s) => typeof s === 'string' && SUFFIX.test(s))) throw badState();
  return list;
}

export class ResolutionIndex {
  private readonly byKey = new Map<string, RegistryAddress>();
  /** suffix → the alias holding it and its full text. */
  private readonly bySuffix = new Map<string, Indexed>();
  /** Suffixes claimed simultaneously by two or more aliases in one block; they belong to nobody. */
  private readonly blocked = new Set<string>();
  /** Suffixes first claimed at `lastHeight` (one block may arrive over several calls). */
  private readonly claimedAtHeight = new Set<string>();
  private lastHeight = -1;

  get size(): number {
    return this.byKey.size;
  }

  /**
   * Adds the addresses that arrived in block `blockHeight` (non-decreasing heights; repeating the last
   * one is allowed, and entries from another call at that height count as the same block). Already
   * seen entries are ignored. Everything is validated before any change. See the requirement above.
   */
  addBlock(blockHeight: number, entries: readonly RegistryAddress[]): void {
    if (!Number.isSafeInteger(blockHeight) || blockHeight < 0 || blockHeight < this.lastHeight) {
      throw new InvalidInput('blockHeight: out of order');
    }
    const { fresh, aliases } = this.prepare(entries);
    if (blockHeight > this.lastHeight) this.claimedAtHeight.clear();
    this.lastHeight = blockHeight;
    for (const e of fresh) this.byKey.set(e.addrKey, e);
    this.indexSuffixes(aliases);
  }

  /** Unseen addresses (deduplicated) and their alias texts; throws if any is invalid. */
  private prepare(entries: readonly RegistryAddress[]): { fresh: RegistryAddress[]; aliases: Indexed[] } {
    const fresh = new Map<string, RegistryAddress>();
    for (const e of entries) if (!this.byKey.has(e.addrKey)) fresh.set(e.addrKey, e);
    const keyed = [...fresh.values()].map((e) => ({ entry: e, key: fromHex(e.addrKey, 32, 'addrKey') }));
    const aliases = keyed.filter((k) => k.entry.kind === Kind.alias).map((k) => ({ entry: k.entry, text: aliasAddress(k.key) }));
    return { fresh: [...fresh.values()], aliases };
  }

  /** New aliases at the current height: the first one takes the suffix, a tie blocks it. */
  private indexSuffixes(aliases: Indexed[]): void {
    for (const [suffix, group] of groupBySuffix(aliases)) {
      if (this.blocked.has(suffix)) continue;
      if (this.bySuffix.has(suffix)) {
        // Already held: if it was claimed at this same height, it is a tie split across two calls.
        if (this.claimedAtHeight.has(suffix)) this.block(suffix);
        continue;
      }
      if (group.length > 1) {
        this.block(suffix);
        continue;
      }
      this.bySuffix.set(suffix, group[0]);
      this.claimedAtHeight.add(suffix);
    }
  }

  private block(suffix: string): void {
    this.bySuffix.delete(suffix);
    this.claimedAtHeight.delete(suffix);
    this.blocked.add(suffix);
  }

  /** Record for an addrKey (hex), mailbox or alias (Mailbox API). */
  get(key: string): RegistryAddress | undefined {
    return this.byKey.get(key);
  }

  /** Record that receives mail for a local part (SMTP `RCPT TO`), or undefined if none. */
  resolve(localPart: string): RegistryAddress | undefined {
    if (typeof localPart !== 'string' || localPart.length > NAME_BYTES || !PRINTABLE_ASCII.test(localPart)) {
      return undefined;
    }
    const lower = localPart.toLowerCase();
    if (isAliasShaped(lower)) {
      const hit = this.bySuffix.get(suffixOf(lower));
      return hit?.text === lower ? hit.entry : undefined;
    }
    const entry = this.byKey.get(mailboxKey(lower));
    return entry?.kind === Kind.mailbox ? entry : undefined;
  }

  /** Full state for persistence (e.g. as JSON in SQLite). */
  exportState(): ResolutionIndexState {
    return {
      version: RESOLUTION_INDEX_STATE_VERSION,
      lastHeight: this.lastHeight,
      addresses: [...this.byKey.values()],
      suffixes: [...this.bySuffix].map(([suffix, hit]) => ({ suffix, addrKey: hit.entry.addrKey })),
      blocked: [...this.blocked],
      claimedAtLastHeight: [...this.claimedAtHeight],
    };
  }

  /** Index from a saved state. Checks everything; an inconsistent state is InvalidInput. */
  static restore(state: unknown): ResolutionIndex {
    const s = checkHeader(state);
    const index = new ResolutionIndex();
    index.lastHeight = s.lastHeight;
    for (const a of s.addresses.map(checkAddress)) index.byKey.set(a.addrKey, a);
    if (index.byKey.size !== s.addresses.length) throw badState();
    for (const owned of s.suffixes) index.restoreSuffix(owned);
    for (const suffix of checkSuffixes(s.blocked)) index.blocked.add(suffix);
    for (const suffix of checkSuffixes(s.claimedAtLastHeight)) index.claimedAtHeight.add(suffix);
    index.checkRestored(s);
    return index;
  }

  /** A held suffix: the addrKey must be a saved alias whose text ends in that suffix. */
  private restoreSuffix(owned: { suffix?: unknown; addrKey?: unknown }): void {
    const entry = this.byKey.get(String(owned?.addrKey));
    if (entry?.kind !== Kind.alias) throw badState();
    const text = aliasAddress(fromHex(entry.addrKey, 32, 'addrKey'));
    const suffix = suffixOf(text);
    if (suffix !== owned.suffix || this.bySuffix.has(suffix)) throw badState();
    this.bySuffix.set(suffix, { entry, text });
  }

  /** No duplicates, no suffix both held and blocked, and every newly claimed suffix has a holder. */
  private checkRestored(s: ResolutionIndexState): void {
    const overlap = [...this.blocked].some((suffix) => this.bySuffix.has(suffix));
    const orphan = [...this.claimedAtHeight].some((suffix) => !this.bySuffix.has(suffix));
    const repeated = this.blocked.size !== s.blocked.length || this.claimedAtHeight.size !== s.claimedAtLastHeight.length;
    if (overlap || orphan || repeated) throw badState();
  }
}

/** addrKey (hex) of the mailbox with that name; '' (never a key) if it is not a valid mailbox name. */
function mailboxKey(name: string): string {
  try {
    return toHex(addrKey(name));
  } catch (e) {
    if (e instanceof InvalidInput) return '';
    throw e;
  }
}
