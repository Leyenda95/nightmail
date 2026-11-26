// Anonymous delivery: `POST /v1/box/<addrKey>/deliver` stores an envelope already sealed by the sender's app
// to the box's public encryption key.
//
// The sender is neither authenticated nor recorded. Its IP is only a key of in-memory rate limits (never
// logged or stored), and no request header other than Content-Type, Content-Length and Transfer-Encoding is
// read (and X-Forwarded-For, only behind a trusted proxy and only as that key, see client-ip.ts). The server
// cannot open the envelope and does not try: it only checks what is public, that its length is a bucket of
// the table (62-byte header + 4 KiB..32 MiB, so the padding is already in it) and that it
// starts with version and suite 0x01 0x01 (checked as soon as those two bytes arrive: a wrong one gets its 400
// without waiting for the rest). It is then stored exactly like mail received by SMTP
// (`MailboxStore.deliver`: own row, random id, date rounded to the minute, size), so the two cannot be told
// apart afterwards.
//
// Checks go from the cheapest: headers (400 / 413), per-IP limits, the box (404, or 503 while the address
// index is stale; past a number of unknown boxes per IP everything is 429, so existence is not probed faster
// than through SMTP), per-box limits, quota (507), upload slots (429 busy, which gives back what the per-IP
// limits had just counted: a full server is not the sender's fault). Only then is the body read into a buffer
// of the declared length, under a deadline that grows with that length (a few seconds for a small envelope,
// so a client that declares one and sends nothing does not hold its slot for long). Small envelopes, most
// mail, have many slots of their own; larger ones share a few, and the largest fewer still.
//
// Answers to malformed or rate-limited requests are sent at once and close the connection without reading the
// body. 404, 503 and 507 are sent after discarding the body, so a well-behaved client can read them; that
// discarding counts as one of the IP's uploads in flight and has the same deadline as an upload of that length,
// so it cannot hold connections longer. The API server also caps its open connections (`maxConnections`).
import type { IncomingMessage } from 'node:http';
import {
  bucketOfEnvelope, ENVELOPE_HEADER_LENGTH, ENVELOPE_SUITE, ENVELOPE_VERSION, envelopeLengthFor, MAX_ENVELOPE_LENGTH,
} from '@nightmail/core-ts';
import { clientAddress, ipKey } from '../issuer/client-ip.ts';
import { RateLimiter, type RateLimit, Slots } from '../limits.ts';
import type { Logger } from '../log.ts';
import { type MailboxStore, QuotaExceeded } from '../mailbox/store.ts';
import type { AddressDirectory, DirectoryEntry } from '../registry/directory.ts';
import { BUSY, json, NOT_FOUND, rateLimited, type Reply } from './reply.ts';

/** Delivery limits. The defaults are provisional. */
export type DeliverLimits = {
  /** Delivery attempts per IP, counted before the body is read. */
  perIp: RateLimit;
  /** Envelope bytes per IP (declared length), counted before the body is read. */
  bytesPerIp: RateLimit;
  /** Stored deliveries per destination box. */
  perBox: RateLimit;
  /** Stored envelope bytes per destination box. */
  bytesPerBox: RateLimit;
  /** Deliveries to a box that does not exist, per IP, before answering 429 to everything from that IP. */
  unknownBoxes: RateLimit;
  /** Largest envelope accepted (413 above it). */
  maxEnvelopeBytes: number;
  /** Up to this envelope size, an upload holds a "small" slot instead of a general one. */
  smallEnvelopeBytes: number;
  /** Concurrent small uploads. */
  smallSlots: number;
  /** Above this envelope size, an upload also holds a "large" slot while it is received. */
  largeEnvelopeBytes: number;
  /** Concurrent uploads above the small size (large ones included). */
  slots: number;
  /** Concurrent large uploads (at most `slots`). */
  largeSlots: number;
  /** Concurrent uploads (and body discards before a 404, 503 or 507) per IPv4 address or IPv6 /56. */
  inFlightPerIp: number;
  /** Fixed part of the deadline to receive a body. */
  bodyGraceMs: number;
  /** Slowest upload accepted: the deadline adds the time to receive the declared length at this rate. */
  minUploadBytesPerSecond: number;
  /** Longest deadline to receive a body, whatever its length; past its deadline the connection is cut. */
  bodyTimeoutMs: number;
};

const HOUR_MS = 3_600_000;
const KIB = 1024;
const MIB = 1024 * KIB;

// Uploads in flight group IPv6 by /56, not by the /64 of the hourly limits: a home connection usually gets a
// /56 (or larger) and could otherwise hold 256 times more slots at once. An upload lasts seconds (two minutes
// at most), so sharing them with a neighbour in the same /56 (some mobile networks) costs a brief `busy`.
const IN_FLIGHT_V6_PREFIX_BITS = 56;

// Upload memory is bounded by smallSlots × smallEnvelopeBytes + (slots - largeSlots) × largeEnvelopeBytes +
// largeSlots × maxEnvelopeBytes: with the defaults 4 MiB + 6 MiB + 64 MiB, about 74 MiB.
export const DEFAULT_DELIVER_LIMITS: DeliverLimits = {
  perIp: { limit: 60, windowMs: HOUR_MS },
  bytesPerIp: { limit: 256 * MIB, windowMs: HOUR_MS },
  perBox: { limit: 120, windowMs: HOUR_MS },
  // One largest envelope (a 25 MiB message) plus 8 MiB of other mail per hour: filling the 300 MiB quota of
  // an empty box takes at least 7.5 hours, whatever the number of IPs (see the known risk in mailbox-api.ts).
  bytesPerBox: { limit: 40 * MIB, windowMs: HOUR_MS },
  unknownBoxes: { limit: 10, windowMs: 60_000 },
  // A 25 MiB message (the SMTP limit) lands in the 32 MiB bucket, the largest one.
  maxEnvelopeBytes: MAX_ENVELOPE_LENGTH,
  // Most mail is text: up to the 64 KiB bucket, many short uploads at once, so a few clients holding the
  // general slots do not stop ordinary mail.
  smallEnvelopeBytes: ENVELOPE_HEADER_LENGTH + 64 * KIB,
  smallSlots: 64,
  largeEnvelopeBytes: MIB,
  slots: 8,
  largeSlots: 2,
  inFlightPerIp: 2,
  // A 4 KiB envelope gets about 5 s, 1 MiB about 21 s, 4 MiB about 69 s, and from the 8 MiB bucket on 120 s.
  bodyGraceMs: 5000,
  minUploadBytesPerSecond: 64 * KIB,
  bodyTimeoutMs: 120_000,
};

const isPositiveInteger = (n: number) => Number.isSafeInteger(n) && n > 0;

/** The limits with the defaults filled in, checked for consistency (throws RangeError). */
export function deliverLimitsOf(overrides: Partial<DeliverLimits> = {}): DeliverLimits {
  const limits = { ...DEFAULT_DELIVER_LIMITS, ...overrides };
  const { maxEnvelopeBytes, bytesPerIp, bytesPerBox, smallEnvelopeBytes, largeEnvelopeBytes, slots, largeSlots } = limits;
  if (!Number.isSafeInteger(maxEnvelopeBytes) || maxEnvelopeBytes < envelopeLengthFor(0) || maxEnvelopeBytes > MAX_ENVELOPE_LENGTH) {
    throw new RangeError('maxEnvelopeBytes: outside the envelope sizes');
  }
  if (bytesPerIp.limit < maxEnvelopeBytes || bytesPerBox.limit < maxEnvelopeBytes) {
    throw new RangeError('byte limits: smaller than the largest envelope');
  }
  const positive = [
    smallEnvelopeBytes, limits.smallSlots, largeEnvelopeBytes, slots, largeSlots, limits.inFlightPerIp,
    limits.bodyGraceMs, limits.minUploadBytesPerSecond, limits.bodyTimeoutMs,
  ];
  if (!positive.every(isPositiveInteger)) throw new RangeError('deliver limits: expected positive integers');
  if (smallEnvelopeBytes > largeEnvelopeBytes) throw new RangeError('smallEnvelopeBytes: above largeEnvelopeBytes');
  if (largeSlots > slots) throw new RangeError('largeSlots: more than slots (each large upload also holds a slot)');
  return limits;
}

/** Deadline for a body of `length` bytes: the grace plus its time at the slowest accepted rate, capped. */
export function bodyDeadlineMs(limits: Pick<DeliverLimits, 'bodyGraceMs' | 'minUploadBytesPerSecond' | 'bodyTimeoutMs'>, length: number): number {
  return Math.min(limits.bodyTimeoutMs, limits.bodyGraceMs + Math.ceil((length * 1000) / limits.minUploadBytesPerSecond));
}

export type DeliverDeps = {
  directory: Pick<AddressDirectory, 'box'>;
  store: Pick<MailboxStore, 'deliver' | 'hasRoomFor'>;
  log: Logger;
  limits?: Partial<DeliverLimits>;
  /** Current time in milliseconds. */
  now: () => number;
  /** Whether the address index is up to date (`RegistrySync.healthy`; always true by default). */
  directoryHealthy?: () => boolean;
  /** The sender's IP for the limits: the socket's by default, `clientAddress(true)` behind a trusted proxy. */
  clientAddress?: (req: IncomingMessage) => string;
};

// Fixed bodies, no details.
const DELIVERED = json(200, { status: 'delivered' });
const BAD_REQUEST = json(400, { error: 'bad_request' });
const TOO_LARGE = json(413, { error: 'too_large' });
const UNAVAILABLE = json(503, { error: 'unavailable' }, { 'Retry-After': '30' });
const MAILBOX_FULL = json(507, { error: 'mailbox_full' });

const CONTENT_TYPE = 'application/octet-stream';
const CONTENT_LENGTH = /^[1-9][0-9]{0,9}$/;

/** Declared body length if the framing is the only one accepted (Content-Length, no Transfer-Encoding). */
function declaredLength(req: IncomingMessage): number | undefined {
  const { 'content-type': type, 'content-length': length, 'transfer-encoding': encoding } = req.headers;
  if (encoding !== undefined || type?.toLowerCase() !== CONTENT_TYPE) return undefined;
  return length !== undefined && CONTENT_LENGTH.test(length) ? Number(length) : undefined;
}

function isEnvelopeLength(length: number): boolean {
  try {
    bucketOfEnvelope(length);
    return true;
  } catch {
    return false;
  }
}

/**
 * How reading a body ends: whole (`end`), refused early so it can be answered while the rest is dropped unread
 * (`answer`), or with the connection cut (`cut`). After each chunk the reader says `more`, `answer` or `cut`.
 */
type BodyEnd = 'end' | 'answer' | 'cut';

/** Waits for a body until `timeoutMs`; on time-out (or `cut`) the connection is cut. */
function untilDone(req: IncomingMessage, timeoutMs: number, onData: (chunk: Buffer) => 'more' | Exclude<BodyEnd, 'end'>): Promise<BodyEnd> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (how: BodyEnd) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (how === 'cut') req.socket.destroy();
      resolve(how);
    };
    const deadline = setTimeout(() => finish('cut'), timeoutMs);
    deadline.unref();
    req.on('data', (chunk: Buffer) => {
      if (settled) return; // already answered: the rest is dropped
      const next = onData(chunk);
      if (next !== 'more') finish(next);
    });
    req.once('end', () => finish('end'));
    req.once('close', () => finish('cut')); // only effective if it closes before 'end'
    req.once('error', () => finish('cut'));
  });
}

/**
 * The whole body (exactly `length` bytes); `bad-header` as soon as its first two bytes are not version and suite
 * 0x01 0x01 (the rest is not waited for); null if it did not arrive in time or whole.
 */
async function readBody(req: IncomingMessage, length: number, timeoutMs: number): Promise<Buffer | 'bad-header' | null> {
  const body = Buffer.alloc(length);
  let received = 0;
  const how = await untilDone(req, timeoutMs, (chunk) => {
    if (received + chunk.length > length) return 'cut';
    chunk.copy(body, received);
    const headerSeen = received >= 2;
    received += chunk.length;
    if (!headerSeen && received >= 2 && (body[0] !== ENVELOPE_VERSION || body[1] !== ENVELOPE_SUITE)) return 'answer';
    return 'more';
  });
  if (how === 'answer') return 'bad-header';
  return how === 'end' && received === length ? body : null;
}

export class Deliveries {
  private readonly deps: DeliverDeps;
  private readonly limits: DeliverLimits;
  private readonly directoryHealthy: () => boolean;
  private readonly clientAddress: (req: IncomingMessage) => string;
  private readonly perIp: RateLimiter;
  private readonly bytesPerIp: RateLimiter;
  private readonly perBox: RateLimiter;
  private readonly bytesPerBox: RateLimiter;
  private readonly unknownBoxes: RateLimiter;
  private readonly smallSlots: Slots;
  private readonly slots: Slots;
  private readonly largeSlots: Slots;
  /** Uploads and body discards in progress per network key (memory only, dropped at 0). */
  private readonly inFlight = new Map<string, number>();
  /** Same answer for every delivery rate limit, so it does not tell which one was hit. */
  private readonly rateLimited: Reply;

  constructor(deps: DeliverDeps) {
    this.deps = deps;
    this.limits = deliverLimitsOf(deps.limits);
    this.directoryHealthy = deps.directoryHealthy ?? (() => true);
    this.clientAddress = deps.clientAddress ?? clientAddress(false);
    const { perIp, bytesPerIp, perBox, bytesPerBox, unknownBoxes } = this.limits;
    this.perIp = new RateLimiter(perIp);
    this.bytesPerIp = new RateLimiter(bytesPerIp);
    this.perBox = new RateLimiter(perBox);
    this.bytesPerBox = new RateLimiter(bytesPerBox);
    this.unknownBoxes = new RateLimiter(unknownBoxes);
    this.smallSlots = new Slots(this.limits.smallSlots);
    this.slots = new Slots(this.limits.slots);
    this.largeSlots = new Slots(this.limits.largeSlots);
    const longest = Math.max(...[perIp, bytesPerIp, perBox, bytesPerBox, unknownBoxes].map((limit) => limit.windowMs));
    this.rateLimited = rateLimited({ limit: 1, windowMs: longest });
  }

  /**
   * The reason only reaches the debug log, which is off unless NIGHTMAIL_DEBUG=1 and must stay off in
   * production: its timestamps would give the exact second of the stored dates which are kept to the minute (see the line for a stored
   * envelope). It never carries the IP, the box or a header.
   */
  private rejected(reason: string, reply: Reply): Reply {
    this.deps.log.debug(`api: delivery rejected (${reason})`);
    return reply;
  }

  /**
   * A refusal a well-behaved client should be able to read (404, 503, 507): sent once the body has been read and
   * discarded, as one of the IP's uploads in flight and under the deadline of an upload of that length (null if it
   * never arrived whole). It holds no slot: nothing is kept in memory. If the IP has no upload left in flight, the
   * reply is sent at once and the connection closed without reading the body, like a 400. That says nothing new
   * (same status, same body); only a client still sending its body may miss the answer.
   */
  private afterBody(req: IncomingMessage, network: string, length: number, reason: string, reply: Reply): Reply | Promise<Reply | null> {
    this.rejected(reason, reply);
    const release = this.acquire(network, []);
    if (!release) return reply;
    return untilDone(req, bodyDeadlineMs(this.limits, length), () => 'more').then((how) => (how === 'end' ? reply : null)).finally(release);
  }

  /** The slots an upload of that length holds while it is received. */
  private poolsFor(length: number): Slots[] {
    if (length <= this.limits.smallEnvelopeBytes) return [this.smallSlots];
    return length > this.limits.largeEnvelopeBytes ? [this.slots, this.largeSlots] : [this.slots];
  }

  /**
   * Takes one of the uploads in flight of the client's network (IPv4 address or IPv6 /56) and a slot of each pool;
   * returns their release, or undefined if any is full.
   */
  private acquire(network: string, pools: Slots[]): (() => void) | undefined {
    const inFlight = this.inFlight.get(network) ?? 0;
    if (inFlight >= this.limits.inFlightPerIp) return undefined;
    const taken: Slots[] = [];
    for (const pool of pools) {
      if (!pool.tryAcquire()) {
        for (const held of taken) held.release();
        return undefined;
      }
      taken.push(pool);
    }
    this.inFlight.set(network, inFlight + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const held of taken) held.release();
      const left = (this.inFlight.get(network) ?? 1) - 1;
      if (left === 0) this.inFlight.delete(network);
      else this.inFlight.set(network, left);
    };
  }

  /**
   * Handles `POST /v1/box/<addrKeyHex>/deliver`: a reply now (body not read), or a promise of one; the promise
   * gives null when the body never arrived whole (the connection is already cut, nothing to answer).
   */
  deliver(req: IncomingMessage, addrKeyHex: string, time: number): Reply | Promise<Reply | null> {
    const length = declaredLength(req);
    if (length === undefined) return this.rejected('bad-request', BAD_REQUEST);
    if (length > this.limits.maxEnvelopeBytes) return this.rejected('too-large', TOO_LARGE);
    if (!isEnvelopeLength(length)) return this.rejected('bad-length', BAD_REQUEST);

    const address = this.clientAddress(req);
    const ip = ipKey(address);
    const network = ipKey(address, IN_FLIGHT_V6_PREFIX_BITS);
    if (!this.perIp.hit(ip, time) || !this.bytesPerIp.hit(ip, time, length)) return this.rejected('ip-limit', this.rateLimited);
    if (!this.unknownBoxes.allows(ip, time)) return this.rejected('unknown-limit', this.rateLimited);
    const box = this.deps.directory.box(addrKeyHex);
    if (!box) {
      this.unknownBoxes.hit(ip, time);
      return this.directoryHealthy()
        ? this.afterBody(req, network, length, 'unknown-box', NOT_FOUND)
        : this.afterBody(req, network, length, 'stale-directory', UNAVAILABLE);
    }
    if (!this.boxAllows(addrKeyHex, time, length)) return this.rejected('box-limit', this.rateLimited);
    if (!this.deps.store.hasRoomFor(box.addrKey, length)) return this.afterBody(req, network, length, 'quota', MAILBOX_FULL);
    const release = this.acquire(network, this.poolsFor(length));
    if (!release) {
      // Not the sender's fault: what was just counted against its IP is given back.
      this.perIp.refund(ip, time);
      this.bytesPerIp.refund(ip, time, length);
      return this.rejected('busy', BUSY);
    }
    return this.receive(req, box, addrKeyHex, length).finally(release);
  }

  private boxAllows(addrKeyHex: string, time: number, length: number): boolean {
    return this.perBox.allows(addrKeyHex, time) && this.bytesPerBox.allows(addrKeyHex, time, length);
  }

  private async receive(req: IncomingMessage, box: DirectoryEntry, addrKeyHex: string, length: number): Promise<Reply | null> {
    const envelope = await readBody(req, length, bodyDeadlineMs(this.limits, length));
    if (envelope === 'bad-header') return this.rejected('bad-envelope', BAD_REQUEST);
    if (!envelope) {
      this.deps.log.debug('api: delivery rejected (incomplete-body)');
      return null;
    }
    const time = this.deps.now();
    // Counted only once there is something to store; other uploads may have used the room meanwhile.
    if (!this.boxAllows(addrKeyHex, time, length)) return this.rejected('box-limit', this.rateLimited);
    this.perBox.hit(addrKeyHex, time);
    this.bytesPerBox.hit(addrKeyHex, time, length);
    try {
      this.deps.store.deliver([{ addrKey: box.addrKey, envelope }], Math.floor(time / 1000));
    } catch (error) {
      if (error instanceof QuotaExceeded) return this.rejected('quota', MAILBOX_FULL);
      throw error;
    }
    // Debug only (off in production): the log timestamp would give the exact second of `received_at`, which is kept to the minute.
    this.deps.log.debug('api: envelope delivered');
    return DELIVERED;
  }
}
