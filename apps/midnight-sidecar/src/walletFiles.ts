// Files of the embedded wallet in the folder chosen by the core (`stateDir`, 0700): the SDK's synced state and the
// purchase journal, both encrypted with the key the core supplies (the sidecar stores no plaintext secrets).
// No SDK dependencies (testable).
//
// - AES-256-GCM with a random 12-byte nonce; the file name is bound as associated data (AAD), so one
//   file cannot be passed off as the other.
// - Atomic writes with fsync (writePrivateFile). A file that cannot be decrypted (other key, corrupt) or that
//   belongs to another wallet is set aside (`.bad-<date>`), never overwritten.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { ensurePrivateDir, setAsideFile, writePrivateFile } from '@nightmail/midnight';
import { AppError, codes } from './codes.ts';

const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
export const STATE_FILE = 'wallet-state.enc';
export const JOURNAL_FILE = 'purchases.enc';

const aad = (name: string) => Buffer.from(`nightmail:sidecar-wallet:v${VERSION}:${name}`);

export class UnreadableFile extends Error {}

/**
 * How long a lost (unreadable) journal blocks purchases: the maximum TTL of a purchase (30 min, callTtl) plus a margin.
 * Within that time an earlier purchase could still land in a block, so no `id` is paid unless it is already in the tree.
 */
export const LOST_JOURNAL_BARRIER_MS = 35 * 60_000;
/** `id` of the barrier: matches any order (see buyBono.ts). */
export const BARRIER_ID = '*';
/** Entries that expired longer ago than this (local clock) are pruned on write. */
export const PRUNE_AFTER_MS = 2 * 60 * 60_000;

const UNREADABLE = Symbol('unreadable');

const closedFiles = () => new AppError(codes.WALLET_UNAVAILABLE, 'Wallet unavailable', { reason: 'not-open' });

/** Encrypts a JSON object for file `name`. */
export function seal(key: Uint8Array, name: string, value: unknown): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(name));
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return JSON.stringify({ v: VERSION, nonce: nonce.toString('hex'), ct: ct.toString('hex') });
}

/** Decrypts what `seal` wrote for file `name`. Throws UnreadableFile if it cannot (other key, corrupt...). */
export function unseal(key: Uint8Array, name: string, sealed: string): unknown {
  try {
    const { v, nonce, ct } = JSON.parse(sealed) as { v: unknown; nonce: unknown; ct: unknown };
    if (v !== VERSION || typeof nonce !== 'string' || typeof ct !== 'string') throw new Error('format');
    const body = Buffer.from(ct, 'hex');
    if (body.length < TAG_BYTES) throw new Error('short');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'hex'), { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(name));
    decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
    const plain = Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch {
    throw new UnreadableFile(name);
  }
}

/** SDK state (what each wallet's `serializeState` returns) and which wallet it belongs to. */
export type SavedWallet = { address: string; shielded: string; unshielded: string; dust: string };

/**
 * A bono purchase that was sent (or is about to be) and whose outcome is unknown. Until its TTL it can still land in
 * a block, so the same `id` is not paid twice (see buyBono.ts). `ttl` is in ms since 1970.
 */
export type Purchase = { id: string; contractAddress: string; txHash: string; ttl: number };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function isSavedWallet(v: unknown): v is SavedWallet {
  return isRecord(v) && ['address', 'shielded', 'unshielded', 'dust'].every((k) => typeof v[k] === 'string');
}

function isPurchase(v: unknown): v is Purchase {
  return isRecord(v) && ['id', 'contractAddress', 'txHash'].every((k) => typeof v[k] === 'string') && Number.isSafeInteger(v.ttl);
}

export class WalletFiles {
  readonly dir: string;
  readonly #key: Uint8Array;
  /** Whether any file was set aside this session (so the core can warn). */
  discarded = false;
  /** After `wipe` the key is gone: reading or writing throws WALLET_UNAVAILABLE (nothing is ever set aside for that). */
  #closed = false;
  /** Where the last unreadable file went (returned if the barrier cannot be written). */
  #lastSetAside: string | null = null;

  constructor(dir: string, key: Uint8Array) {
    if (!path.isAbsolute(dir)) throw new Error('stateDir must be an absolute path');
    if (key.length !== 32) throw new Error('stateKey must be 32 bytes');
    ensurePrivateDir(dir);
    this.dir = dir;
    this.#key = Uint8Array.from(key);
  }

  /** Reads and decrypts `name`; if it cannot, sets it aside and returns UNREADABLE. No file: undefined. */
  #read(name: string): unknown {
    if (this.#closed) throw closedFiles();
    const file = path.join(this.dir, name);
    if (!existsSync(file)) return undefined;
    try {
      return unseal(this.#key, name, readFileSync(file, 'utf8'));
    } catch (e) {
      if (!(e instanceof UnreadableFile)) throw e;
      this.#lastSetAside = this.#setAside(name);
      return UNREADABLE;
    }
  }

  #setAside(name: string): string | null {
    const dest = setAsideFile(path.join(this.dir, name));
    this.discarded = true;
    return dest;
  }

  #write(name: string, value: unknown): void {
    if (this.#closed) throw closedFiles();
    writePrivateFile(this.dir, name, seal(this.#key, name, value));
  }

  /** The saved state of that wallet; an unreadable one, or one from another wallet, is set aside and yields null. */
  readWallet(address: string): SavedWallet | null {
    const saved = this.#read(STATE_FILE);
    if (saved === undefined || saved === UNREADABLE) return null;
    if (!isSavedWallet(saved) || saved.address !== address) {
      this.#setAside(STATE_FILE);
      return null;
    }
    return saved;
  }

  /** Sets the state aside (it could not be restored into the SDK): the next write starts from scratch. */
  discardWallet(): void {
    this.#setAside(STATE_FILE);
  }

  writeWallet(state: SavedWallet): void {
    this.#write(STATE_FILE, state);
  }

  /**
   * Purchases in flight. An unreadable journal (other key, corrupt, other format) is set aside and replaced by a
   * barrier of LOST_JOURNAL_BARRIER_MS: there is no way to know which purchases it held, so nothing is paid until
   * all of them have expired (fail closed). Read when the wallet opens (`stateDiscarded`).
   */
  readJournal(now = Date.now()): Purchase[] {
    const saved = this.#read(JOURNAL_FILE);
    if (saved === undefined) return [];
    if (saved === UNREADABLE || !Array.isArray(saved) || !saved.every(isPurchase)) {
      const dest = saved === UNREADABLE ? this.#lastSetAside : this.#setAside(JOURNAL_FILE);
      const barrier = [{ id: BARRIER_ID, contractAddress: BARRIER_ID, txHash: '', ttl: now + LOST_JOURNAL_BARRIER_MS }];
      try {
        this.writeJournal(barrier, now);
      } catch (e) {
        // If no barrier was written, put the set-aside journal back; otherwise the next open would see nothing (fail open).
        if (dest) renameSync(dest, path.join(this.dir, JOURNAL_FILE));
        throw e;
      }
      return barrier;
    }
    return saved;
  }

  /** Writes the journal, pruning entries expired for more than PRUNE_AFTER_MS (local clock; does not affect safety). */
  writeJournal(purchases: Purchase[], now = Date.now()): void {
    this.#write(JOURNAL_FILE, purchases.filter((p) => p.ttl + PRUNE_AFTER_MS > now));
  }

  /** Wipes the key from memory (when the wallet closes). */
  wipe(): void {
    this.#closed = true;
    this.#key.fill(0);
  }
}
