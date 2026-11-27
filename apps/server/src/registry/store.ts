// Registry state persisted across restarts so the chain is not replayed from deployment every time: the
// whole resolution index (addresses, suffix → addrKey, blocked suffixes; `ResolutionIndex.exportState()`,
// versioned JSON) and the height of the last processed block.
//
// The index is only correct if it was fed block by block since deployment (see resolution.ts), so it is
// never partially repaired: if what was saved cannot be read, everything (height included) is discarded
// and syncing restarts from the first block.
//
// The database belongs to a single contract: a mailbox addrKey depends only on its name, so one
// deployment's boxes must never be served to another's addresses. Opening it with another contract is an error.
import { fromHex, InvalidInput, ResolutionIndex } from '@nightmail/midnight';
import { type Database, inTransaction } from '../storage/db.ts';

const SCHEMA = 'CREATE TABLE IF NOT EXISTS registry_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;';
const HEIGHT = /^(?:0|[1-9][0-9]{0,15})$/;

/** The database belongs to another contract (another registry deployment). */
export class WrongContract extends Error {}

export type LoadedRegistry = {
  index: ResolutionIndex;
  /** Height of the last processed block with actions (-1: none). */
  cursor: number;
  /** Height of the last block whose state was read and added to the index (-1: none). */
  fetched: number;
  /** Fixed reason why the saved state was discarded, if it was. */
  problem?: string;
};

const EMPTY = (): LoadedRegistry => ({ index: new ResolutionIndex(), cursor: -1, fetched: -1 });

function parseHeight(text: string): number {
  if (!HEIGHT.test(text) || !Number.isSafeInteger(Number(text))) throw new InvalidInput('cursor: invalid');
  return Number(text);
}

export class RegistryStore {
  private readonly db: Database;

  constructor(db: Database, contractAddress: string) {
    try {
      fromHex(contractAddress, 32, 'contract address');
    } catch {
      throw new Error('contract address: expected 32 bytes as lowercase hex');
    }
    this.db = db;
    db.exec(SCHEMA);
    const stored = this.read('contract');
    if (stored === undefined) this.write('contract', contractAddress);
    else if (stored !== contractAddress) throw new WrongContract('The mail database belongs to another registry contract');
  }

  private read(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM registry_meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  private write(key: string, value: string): void {
    this.db.prepare('INSERT INTO registry_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /**
   * The saved state; if there is none, or it is unreadable, an empty index to sync from scratch.
   * Unreadable data is moved aside (`index.discarded`, `cursor.discarded`, last occurrence only): left in
   * place, every restart would discard it again until the first block is read.
   */
  load(): LoadedRegistry {
    const index = this.read('index');
    const cursor = this.read('cursor');
    if (cursor === undefined) return EMPTY();
    try {
      return restore(index, cursor);
    } catch (error) {
      if (!(error instanceof InvalidInput || error instanceof SyntaxError)) throw error;
      // Moved aside, not deleted: it may be another version's format and still be useful for recovery.
      inTransaction(this.db, () => {
        this.db.prepare("DELETE FROM registry_meta WHERE key IN ('index.discarded', 'cursor.discarded')").run();
        this.db.prepare("UPDATE registry_meta SET key = key || '.discarded' WHERE key IN ('index', 'cursor')").run();
      });
      return { ...EMPTY(), problem: 'saved index unreadable' };
    }
  }

  /** Atomically saves the whole index and the processed height. */
  saveIndex(index: ResolutionIndex, cursor: number): void {
    inTransaction(this.db, () => {
      this.write('index', JSON.stringify(index.exportState()));
      this.write('cursor', String(cursor));
    });
  }

  /** Saves only the processed height (a block with no new addresses). */
  saveCursor(cursor: number): void {
    this.write('cursor', String(cursor));
  }
}

/**
 * A saved height without a saved index means no block needed reading up to that height (the index is
 * saved with every block read), so the empty index is correct.
 */
function restore(indexJson: string | undefined, cursorText: string): LoadedRegistry {
  const cursor = parseHeight(cursorText);
  const index = indexJson === undefined ? new ResolutionIndex() : ResolutionIndex.restore(JSON.parse(indexJson));
  const fetched = index.exportState().lastHeight;
  if (cursor < fetched) throw new InvalidInput('cursor: behind the index');
  return { index, cursor, fetched };
}
