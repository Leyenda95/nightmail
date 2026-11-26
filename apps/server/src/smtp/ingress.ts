// SMTP ingress: receives mail for registry addresses and stores it sealed.
//
// RCPT TO: every non-deliverable address gets the same `550`. Past a per-IP `550` limit the IP gets
// `451` for everything, so it cannot probe which addresses exist; while chain sync is unhealthy,
// unknown addresses get `451` instead of a permanent `550`.
// DATA: kept in memory only, byte-counted as it arrives (SIZE alone is not trusted). Large messages take
// one of a few slots, since sealing 25 MiB needs about 96 MiB transiently. Sealed per recipient and
// stored all or nothing; the assembled plaintext is zeroed and never logged or written to disk.
// On a real domain, RFC 5321 requires accepting `postmaster`, which must then be routed to the operator
// before the registry lookup (reserved names currently get `550`).
import { SMTPServer, type SMTPServerAddress, type SMTPServerDataStream, type SMTPServerSession } from 'smtp-server';
import { envelopeLengthFor, MAX_PLAINTEXT_LENGTH, sealMailbox } from '@nightmail/core-ts';
import { RateLimiter, type RateLimit, Slots } from '../limits.ts';
import { errorKind, type Logger } from '../log.ts';
import { type Delivery, type MailboxStore, QuotaExceeded } from '../mailbox/store.ts';
import type { AddressDirectory, DirectoryEntry } from '../registry/directory.ts';

/** SMTP ingress limits. The defaults are provisional. */
export type IngressLimits = {
  /** Maximum message size (DATA bytes, after dot-unstuffing). */
  maxMessageBytes: number;
  /** From this size on, a message holds a "large message" slot while it is received and sealed. */
  largeMessageBytes: number;
  /** Concurrent large messages. */
  largeMessageSlots: number;
  /** Recipients per message (each one is a separate sealing). */
  maxRecipients: number;
  /** Concurrent connections. */
  maxClients: number;
  /** `550`s per IP before answering `451` to everything. */
  unknownRecipients: RateLimit;
  /** Maximum connection idle time. */
  socketTimeoutMs: number;
};

export const DEFAULT_INGRESS_LIMITS: IngressLimits = {
  maxMessageBytes: 25 * 1024 * 1024,
  largeMessageBytes: 1024 * 1024,
  largeMessageSlots: 2,
  maxRecipients: 10,
  maxClients: 20,
  unknownRecipients: { limit: 10, windowMs: 60_000 },
  socketTimeoutMs: 60_000,
};

export type IngressDeps = {
  /** Mail domain, lowercase (`nightmail.local`). */
  domain: string;
  directory: Pick<AddressDirectory, 'recipient'>;
  store: Pick<MailboxStore, 'deliver' | 'hasRoomFor'>;
  log: Logger;
  limits?: Partial<IngressLimits>;
  /** Current time in milliseconds. */
  now?: () => number;
  /** Whether the address index is up to date (`RegistrySync.healthy`; always true by default). */
  directoryHealthy?: () => boolean;
};

type SmtpReply = Error & { responseCode: number };
/** SMTP error reply; `smtp-server` prepends the enhanced status code matching the reply code. */
const reply = (responseCode: number, text: string): SmtpReply => Object.assign(new Error(text), { responseCode });

// Fixed texts (the library adds the enhanced code: 550 → 5.1.1, 552 → 5.2.2, 451 → 4.3.0).
const NO_SUCH_MAILBOX = () => reply(550, 'No such mailbox here');
const DIRECTORY_STALE = () => reply(451, 'Recipient not verifiable now, try again later');
const TOO_MANY_UNKNOWN = () => reply(451, 'Too many unknown recipients, try again later');
const MAILBOX_FULL = () => reply(552, 'Mailbox full');
const TOO_BIG = () => reply(552, 'Message too big');
const BUSY = () => reply(451, 'Server busy, try again later');
const LOCAL_ERROR = () => reply(451, 'Local error, try again later');

/** Local part of an address in our domain (domain compared case-insensitively), or undefined. */
export function localPartOf(address: string, domain: string): string | undefined {
  const at = address.lastIndexOf('@');
  if (at < 1 || address.slice(at + 1).toLowerCase() !== domain) return undefined;
  return address.slice(0, at);
}

type Verdict = 'ok' | 'too-big' | 'busy';

/** The incoming message: kept in memory while it fits and there is room for it. */
class Intake {
  private readonly limits: IngressLimits;
  private readonly slots: Slots;
  private chunks: Uint8Array[] = [];
  private size = 0;
  private holdsSlot = false;
  verdict: Verdict = 'ok';

  constructor(limits: IngressLimits, slots: Slots) {
    this.limits = limits;
    this.slots = slots;
  }

  push(chunk: Uint8Array): void {
    this.size += chunk.length;
    if (this.verdict !== 'ok') return; // the rest is read and discarded
    if (this.size > this.limits.maxMessageBytes) return this.give('too-big');
    if (this.size > this.limits.largeMessageBytes && !this.holdsSlot) {
      if (!this.slots.tryAcquire()) return this.give('busy');
      this.holdsSlot = true;
    }
    this.chunks.push(chunk);
  }

  private give(verdict: Verdict): void {
    this.verdict = verdict;
    this.release();
  }

  /** The whole message; the received chunks are dropped from here. */
  take(): Buffer {
    const message = Buffer.concat(this.chunks);
    this.chunks = [];
    return message;
  }

  /** Drops the received data and the slot, if held. Safe to call more than once. */
  release(): void {
    this.chunks = [];
    if (!this.holdsSlot) return;
    this.holdsSlot = false;
    this.slots.release();
  }
}

type RcptCallback = (error?: Error | null) => void;
type DataCallback = (error?: Error | null, message?: string) => void;

const REJECTIONS: Record<Exclude<Verdict, 'ok'>, () => SmtpReply> = { 'too-big': TOO_BIG, busy: BUSY };

function* sealedFor(boxes: DirectoryEntry[], message: Uint8Array): Generator<Delivery> {
  for (const box of boxes) yield { addrKey: box.addrKey, envelope: sealMailbox(box.encPk, message) };
}

/** `RCPT TO` and `DATA` handlers (kept apart from the server so they can be mounted anywhere). */
export class Ingress {
  readonly limits: IngressLimits;
  private readonly deps: IngressDeps;
  private readonly now: () => number;
  private readonly unknownRecipients: RateLimiter;
  private readonly slots: Slots;
  private readonly directoryHealthy: () => boolean;

  constructor(deps: IngressDeps) {
    this.limits = { ...DEFAULT_INGRESS_LIMITS, ...deps.limits };
    if (this.limits.maxMessageBytes > MAX_PLAINTEXT_LENGTH) throw new RangeError('maxMessageBytes: larger than a mailbox envelope can hold');
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.directoryHealthy = deps.directoryHealthy ?? (() => true);
    this.unknownRecipients = new RateLimiter(this.limits.unknownRecipients);
    this.slots = new Slots(this.limits.largeMessageSlots);
  }

  private recipientOf(address: string): DirectoryEntry | undefined {
    const localPart = localPartOf(address, this.deps.domain);
    return localPart === undefined ? undefined : this.deps.directory.recipient(localPart);
  }

  /** Mailboxes of the accepted recipients, deduplicated (two spellings of the same address). */
  private boxesOf(session: SMTPServerSession): DirectoryEntry[] | undefined {
    const boxes = new Map<string, DirectoryEntry>();
    for (const { address } of session.envelope.rcptTo) {
      const box = this.recipientOf(address);
      if (!box) return undefined;
      boxes.set(Buffer.from(box.addrKey).toString('hex'), box);
    }
    return [...boxes.values()];
  }

  /** Seals and stores the message for all its recipients or none. Zeroes the plaintext when done. */
  private deliver(message: Buffer, session: SMTPServerSession): SmtpReply | null {
    const { store, log } = this.deps;
    try {
      const boxes = this.boxesOf(session);
      if (!boxes) return LOCAL_ERROR();
      store.deliver(sealedFor(boxes, message), Math.floor(this.now() / 1000));
      // Debug only: the log timestamp would undo the hourly rounding of `received_at`.
      log.debug(`smtp: message stored in ${boxes.length} mailbox(es)`);
      return null;
    } catch (error) {
      if (error instanceof QuotaExceeded) return MAILBOX_FULL();
      log.warn(`smtp: delivery failed (${errorKind(error)})`);
      return LOCAL_ERROR();
    } finally {
      message.fill(0);
    }
  }

  onRcptTo(address: SMTPServerAddress, session: SMTPServerSession, callback: RcptCallback): void {
    const ip = session.remoteAddress;
    const time = this.now();
    if (!this.unknownRecipients.allows(ip, time)) return callback(TOO_MANY_UNKNOWN());
    const box = this.recipientOf(address.address);
    if (!box) {
      this.unknownRecipients.hit(ip, time);
      return callback(this.directoryHealthy() ? NO_SUCH_MAILBOX() : DIRECTORY_STALE());
    }
    // A mailbox that cannot fit even the smallest envelope: better to say so here, per recipient.
    if (!this.deps.store.hasRoomFor(box.addrKey, envelopeLengthFor(0))) return callback(MAILBOX_FULL());
    callback();
  }

  onData(stream: SMTPServerDataStream, session: SMTPServerSession, callback: DataCallback): void {
    const intake = new Intake(this.limits, this.slots);
    stream.on('data', (chunk: Uint8Array) => intake.push(chunk));
    stream.once('end', () => {
      const rejection = intake.verdict === 'ok' ? this.deliver(intake.take(), session) : REJECTIONS[intake.verdict]();
      intake.release();
      if (rejection) callback(rejection);
      else callback(null, 'Message accepted');
    });
    // The connection dropped mid-message (or it already ended, leaving nothing to release).
    stream.once('error', () => intake.release());
    stream.once('close', () => intake.release());
  }
}

/** SMTP server with the ingress mounted; the caller runs `listen(port, '127.0.0.1')`. */
export function createSmtpServer(deps: IngressDeps): SMTPServer {
  const ingress = new Ingress(deps);
  const server = new SMTPServer({
    name: deps.domain,
    banner: 'NightMail',
    // No AUTH (receive-only) and no STARTTLS (the MVP only listens locally).
    disabledCommands: ['AUTH', 'STARTTLS'],
    disableReverseLookup: true,
    // Enhanced status codes (RFC 2034): the library prepends them to each reply based on its code.
    hideENHANCEDSTATUSCODES: false,
    logger: false,
    size: ingress.limits.maxMessageBytes,
    rejectOversized: true,
    maxClients: ingress.limits.maxClients,
    maxRecipients: ingress.limits.maxRecipients,
    socketTimeout: ingress.limits.socketTimeoutMs,
    onRcptTo: (address, session, callback) => ingress.onRcptTo(address, session, callback),
    onData: (stream, session, callback) => ingress.onData(stream, session, callback),
  });
  // Without this handler a socket error would crash the process. Name only: the message may contain the IP.
  server.on('error', (error) => deps.log.debug(`smtp: connection error (${error.name})`));
  return server;
}
