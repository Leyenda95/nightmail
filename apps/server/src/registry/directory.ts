// What the SMTP ingress and the Mailbox API know about addresses: a view over the resolution index
// (maintained by RegistrySync) that also drops addresses with unusable keys.
//
// An address whose encryption key cannot be sealed to (non-canonical or low order), or whose signing key
// would let anyone forge valid signatures (low order), does not exist for the server: it receives no mail
// and nothing is served to it. It still occupies its slot in the index (its suffix stays taken, as on
// chain); it is only filtered out at lookup time.
import { isUsableAuthPublicKey, isUsableMailboxPublicKey } from '@nightmail/core-ts';
import { fromHex, type RegistryAddress, type ResolutionIndex } from '@nightmail/midnight';

export type DirectoryEntry = { addrKey: Uint8Array; encPk: Uint8Array; authPk: Uint8Array };

function usable(entry: RegistryAddress): DirectoryEntry | null {
  const encPk = fromHex(entry.encPk, 32, 'encPk');
  const authPk = fromHex(entry.authPk, 32, 'authPk');
  if (!isUsableMailboxPublicKey(encPk) || !isUsableAuthPublicKey(authPk)) return null;
  return { addrKey: fromHex(entry.addrKey, 32, 'addrKey'), encPk, authPk };
}

export class AddressDirectory {
  private readonly index: ResolutionIndex;
  /** addrKey (hex) → its keys, or null if unusable. An addrKey's registration never changes, so caching is safe. */
  private readonly checked = new Map<string, DirectoryEntry | null>();

  constructor(index: ResolutionIndex) {
    this.index = index;
  }

  private entryOf(registered: RegistryAddress | undefined): DirectoryEntry | undefined {
    if (!registered) return undefined;
    let entry = this.checked.get(registered.addrKey);
    if (entry === undefined) {
      entry = usable(registered);
      this.checked.set(registered.addrKey, entry);
    }
    return entry || undefined;
  }

  /**
   * Mailbox that receives mail for a local part (`RCPT TO`), following `ResolutionIndex.resolve`: aliases
   * only by suffix and full text, mailboxes by H(name), reserved names never. undefined if it does not
   * exist or its keys are unusable.
   */
  recipient(localPart: string): DirectoryEntry | undefined {
    return this.entryOf(this.index.resolve(localPart));
  }

  /** Box for an addrKey (lowercase hex), mailbox or alias (Mailbox API). */
  box(addrKeyHex: string): DirectoryEntry | undefined {
    return this.entryOf(this.index.get(addrKeyHex));
  }
}
