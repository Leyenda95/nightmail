// Mailbox names: normalization, alias shape and reserved names. A single definition shared by the
// app (via the sidecar), the server and resolution.
//
// The contract leaves normalization to the app. The strictest rule is used, since it can always be
// relaxed later without changing any registered addrKey: ASCII only, lowercase, letters, digits and the
// separators '.', '-' and '_'; starts and ends with a letter or digit; never two separators in a row;
// 1-64 bytes. No subaddressing ('+'). Dots are significant (`juan.perez` and `juanperez` differ).
import { isAliasShaped } from './alias.ts';
import { InvalidInput } from './input.ts';

export const NAME_BYTES = 64;
const NAME = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const DOUBLE_SEPARATOR = /[._-]{2}/;

/**
 * Role names nobody can register or receive mail for (a server-side blocklist): RFC 2142 (§3-§5), the
 * ones certificate authorities use for domain validation (admin, administrator, webmaster, hostmaster,
 * postmaster) and the usual mail-system names.
 */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  // RFC 2142
  'info', 'marketing', 'sales', 'support', 'abuse', 'noc', 'security', 'postmaster', 'hostmaster', 'usenet', 'news',
  'webmaster', 'www', 'uucp', 'ftp',
  // certificate authority domain validation
  'admin', 'administrator',
  // mail system
  'root', 'noreply', 'no-reply', 'mailer-daemon',
  // ours (also reserved on chain, with a subset of the above: see the registry constructor)
  'soporte', 'nightmail',
]);

/** Why a mailbox name is rejected (the UI provides the text). */
export type NameProblem = 'invalid' | 'alias-form' | 'reserved';

export class NameRejected extends InvalidInput {
  readonly problem: NameProblem;
  constructor(problem: NameProblem) {
    super(`name: ${problem}`);
    this.problem = problem;
  }
}

/** Canonical (ASCII) form of a name, or NameRejected('invalid'). */
export function normalizeName(name: string): string {
  // Length first (and before toLowerCase). Non-ASCII is rejected before lowercasing, because
  // toLowerCase would turn e.g. the Kelvin sign K into an ASCII k.
  if (typeof name !== 'string' || name.length > NAME_BYTES || !/^[\x21-\x7e]*$/.test(name)) {
    throw new NameRejected('invalid');
  }
  const lower = name.toLowerCase();
  if (!NAME.test(lower) || DOUBLE_SEPARATOR.test(lower)) throw new NameRejected('invalid');
  return lower;
}

/**
 * A name usable as a mailbox: normalized, not alias-shaped (it would only resolve as an alias) and not
 * reserved. Used by the app when registering and by the server for lookup by name.
 * - Recovery does not use it: it takes the addrKey from the on-chain record (by slotNul), since the
 *   reserved list may grow and an existing mailbox would stop passing this filter.
 * - With a real domain, SMTP must route `postmaster` (RFC 5321 §4.5.1) to the operator before
 *   resolving: here it is reserved and `resolve` never delivers it to a mailbox.
 */
export function mailboxName(name: string): string {
  const normal = normalizeName(name);
  if (isAliasShaped(normal)) throw new NameRejected('alias-form');
  if (RESERVED_NAMES.has(normal)) throw new NameRejected('reserved');
  return normal;
}

/** Mailbox name zero-padded to 64 bytes: the `name` input of registerMailbox and addressKey. */
export function nameBytes(name: string): Uint8Array {
  const out = new Uint8Array(NAME_BYTES);
  out.set(Buffer.from(mailboxName(name), 'ascii'));
  return out;
}
