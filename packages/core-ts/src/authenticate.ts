// Full authentication of a mailbox request. The order matters:
//
//   1. time window   (cheap; drops stale requests without touching any state)
//   2. signature     (nothing is stored before this, so without the key nobody can fill the store)
//   3. nonce         (check-and-insert in one step, only for correctly signed requests)
//
// A nonce is remembered until `timestamp + tolerance` (inclusive), i.e. for as long as the request
// is still inside the window, not "60 s after it arrived".
import { toHex } from './bytes.ts';
import { MAX_CLOCK_SKEW_SECONDS, isWithinTimeWindow, nonceRetentionDeadline, verifyRequest } from './request-auth.ts';
import type { MailboxRequest } from './request-auth.ts';

export type NonceEntry = {
  addrKey: Uint8Array;
  nonce: Uint8Array;
  /** Last second (Unix) the entry must be remembered. */
  deadline: number;
  /** Current time (Unix seconds), so the store can forget expired entries. */
  now: number;
};

export interface NonceStore {
  /**
   * Since when (Unix seconds) the store remembers what it has seen: its start time if it does not
   * survive a restart, or `null` if it persists. `authenticateRequest` rejects every
   * `timestamp <= startedAt + tolerance`, since those requests may have been seen before the start
   * and their nonce is lost. The field is required so an implementation cannot forget it.
   */
  readonly startedAt: number | null;
  /**
   * Stores (addrKey, nonce) and returns `true` if it was absent, otherwise returns `false`.
   * Must be atomic: two calls with the same entry never both return `true`.
   * An entry may only be forgotten once `now > deadline`.
   */
  insertIfAbsent(entry: NonceEntry): boolean;
}

/**
 * In-memory store. Being synchronous, it is atomic within one Node process. It does not survive a
 * restart, so it is created with the server start time (Unix seconds).
 */
export class MemoryNonceStore implements NonceStore {
  readonly startedAt: number;
  readonly #deadlines = new Map<string, number>();
  #sweptAt: number;

  constructor(startedAt: number) {
    if (!Number.isSafeInteger(startedAt) || startedAt < 0) throw new RangeError('invalid start time');
    this.startedAt = startedAt;
    this.#sweptAt = startedAt;
  }

  insertIfAbsent({ addrKey, nonce, deadline, now }: NonceEntry): boolean {
    this.#forgetExpired(now);
    const key = `${toHex(addrKey)}:${toHex(nonce)}`;
    if (this.#deadlines.has(key)) return false;
    this.#deadlines.set(key, deadline);
    return true;
  }

  get size(): number {
    return this.#deadlines.size;
  }

  /** At most one sweep per second; walking the map on every request would gain nothing. */
  #forgetExpired(now: number): void {
    if (now <= this.#sweptAt) return;
    this.#sweptAt = now;
    for (const [key, deadline] of this.#deadlines) {
      if (now > deadline) this.#deadlines.delete(key);
    }
  }
}

/** Rejection reason, for server logs and metrics. Clients always get the same response. */
export type AuthFailure = 'stale' | 'bad-signature' | 'replay';

export type AuthResult = { ok: true } | { ok: false; reason: AuthFailure };

export type AuthContext = {
  /** Ed25519 key registered for the address. */
  authPublicKey: Uint8Array;
  /** Server time, in Unix seconds. */
  now: number;
  nonceStore: NonceStore;
  toleranceSeconds?: number;
};

const failure = (reason: AuthFailure): AuthResult => ({ ok: false, reason });

function isFresh(timestamp: number, now: number, startedAt: number | null, toleranceSeconds: number): boolean {
  if (!isWithinTimeWindow(timestamp, now, toleranceSeconds)) return false;
  return startedAt === null || timestamp > startedAt + toleranceSeconds;
}

/**
 * Is `request` authentic, fresh and not a replay? The server builds `request`: `host` from its
 * config, `method` and `path` from the HTTP request, `version` and `addrKey` from the route, and
 * `timestamp`, `nonce` and the signature from the headers (`parseAuthHeaders`).
 */
export function authenticateRequest(request: MailboxRequest, signature: Uint8Array, context: AuthContext): AuthResult {
  const { authPublicKey, now, nonceStore, toleranceSeconds = MAX_CLOCK_SKEW_SECONDS } = context;
  if (!isFresh(request.timestamp, now, nonceStore.startedAt, toleranceSeconds)) return failure('stale');
  if (!verifyRequest(authPublicKey, request, signature)) return failure('bad-signature');
  const deadline = nonceRetentionDeadline(request.timestamp, toleranceSeconds);
  if (!nonceStore.insertIfAbsent({ addrKey: request.addrKey, nonce: request.nonce, deadline, now })) return failure('replay');
  return { ok: true };
}
