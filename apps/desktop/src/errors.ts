// Maps the core's error codes to a three-part message: what happened, what is still safe (only when money is at
// stake: no comforting filler) and what you can do. Raw exception text is never shown, only what this table decides.
//
// "What is still safe" is not a template: each code claims only what the core guarantees on every path by which
// that code arrives (`src-tauri/src/**`), and when nothing true can reassure, it is `null`. Before adding or
// changing one of those sentences, check where the error is produced.
//
// The words live in `i18n/<language>/errors.ts` (the reason for each "safe" sentence sits next to it in
// `es/errors.ts`). What stays here is the logic: which code says what and which sentence goes with which path.
// Texts are read at call time, never when the module loads (the language changes while the app is open).
import type { CommandError } from './bindings/CommandError.ts';
import type { CoreError } from './bindings/CoreError.ts';
import type { LinkError } from './bindings/LinkError.ts';
import type { OrchError } from './bindings/OrchError.ts';
import type { SendError } from './bindings/SendError.ts';
import { formatDateTime } from './format.ts';
import { DICTIONARIES, t } from './i18n/index.ts';
import { errorCode } from './pending.ts';

type AnyError = CoreError | OrchError | CommandError | LinkError | SendError;
type Code = AnyError['code'];
type ByCode<C extends Code> = Extract<AnyError, { code: C }>;
type Parametric =
  | 'tooManyAttempts'
  | 'nameRejected'
  | 'bonoNotReady'
  | 'callRejected'
  | 'rateLimited'
  | 'insufficientFunds'
  | 'wallet'
  | 'midnightError';

/** An error in three parts. Screens place them separately; `joinParts` joins them for callers that want one text. */
export interface ErrorParts {
  /** What happened. If the state is uncertain, it says so. */
  readonly what: string;
  /** What is still safe, or `null` if there is nothing true to say for this error. */
  readonly safe: string | null;
  /** What you can do, or `null` if it does not depend on you. */
  readonly action: string | null;
}

/** An error as stored in the dictionary: missing parts are omitted (a dictionary holds no `null`). */
export interface ErrorText {
  readonly what: string;
  readonly safe?: string;
  readonly action?: string;
}

const parts = (what: string, safe: string | null, action: string | null): ErrorParts => ({ what, safe, action });

/** The three parts of a dictionary error, with `null` for the missing ones. */
const full = (text: ErrorText): ErrorParts => parts(text.what, text.safe ?? null, text.action ?? null);

/** One message per code without data, in the current language; the type forces the dictionary to cover them all. */
function simple(): Record<Exclude<Code, Parametric>, ErrorText> {
  return t().errors.simple;
}

/** The only rejections that clear by themselves (the contract's round advances); the others repeat the same, so retrying is not suggested. */
const CALL_CLEARS: readonly unknown[] = ['stale-round', 'too-early'];
/** Reasons the wallet gives BEFORE building a payment. `not-open` can also come when saving, after sending. */
const WALLET_BEFORE_PAYING: readonly unknown[] = ['already-open', 'in-use', 'not-synced'];

/** The text for `key`, or `fallback` if the core sends a reason this version does not know (never shown raw). */
function pick(table: Record<string, string>, key: unknown, fallback: string): string {
  return typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : fallback;
}

/** A wait in words: seconds if short, minutes otherwise (the relayer may ask for an hour). */
function waitText(secs: unknown): string {
  const wait = t().errors.wait;
  if (typeof secs !== 'number' || !Number.isFinite(secs) || secs <= 0) return wait.moment;
  return secs < 90 ? wait.seconds(Math.ceil(secs)) : wait.minutes(Math.ceil(secs / 60));
}

/** The bono is on chain (confirmed) but the core does not let it be used yet. The time is a minimum, not a promise:
 *  the core may also require other bonos to land after yours. */
function bonoNotReady(usableAt: unknown): ErrorParts {
  const text = t().errors.bonoNotReady;
  if (typeof usableAt !== 'number' || !Number.isFinite(usableAt)) return parts(text.what, text.safe, text.action);
  return parts(text.whatBefore(formatDateTime(usableAt)), text.safe, text.actionAfter);
}

/** Funds are missing. With a balance this version does not know, which step lacked them is unknown, so nothing is claimed to be safe. */
function insufficientFunds(asset: unknown): ErrorParts {
  const funds = t().errors.insufficientFunds;
  const known: Record<ByCode<'insufficientFunds'>['asset'], ErrorText> = { dust: funds.dust, token: funds.token };
  return full(typeof asset === 'string' && Object.hasOwn(known, asset) ? known[asset as keyof typeof known] : funds.unknown);
}

// One message per code with data; the type forces all of them to be covered.
const PARAMETRIC: { [C in Parametric]: (e: ByCode<C>) => ErrorParts } = {
  tooManyAttempts: (e) => {
    const text = t().errors.tooManyAttempts;
    return parts(text.what, null, text.action(waitText(e.waitSecs)));
  },
  nameRejected: (e) => {
    const { errors } = t();
    const problems: Record<ByCode<'nameRejected'>['reason'], string> = errors.nameRejected.problem;
    return parts(errors.nameRejected.what(pick(problems, e.reason, errors.nameRejected.unknown)), null, errors.otherName);
  },
  bonoNotReady: (e) => bonoNotReady(e.usableAt),
  callRejected: (e) => {
    const { errors } = t();
    const problems: Record<ByCode<'callRejected'>['reason'], string> = errors.callRejected.problem;
    return parts(
      errors.callRejected.what(pick(problems, e.reason, problems.other)),
      null,
      CALL_CLEARS.includes(e.reason) ? errors.retrySoon : null,
    );
  },
  rateLimited: (e) => {
    const text = t().errors.rateLimited;
    return parts(text.what, null, text.action(waitText(e.retryAfterS)));
  },
  insufficientFunds: (e) => insufficientFunds(e.asset),
  wallet: (e) => {
    const { errors } = t();
    const problems: Record<ByCode<'wallet'>['reason'], string> = errors.wallet.problem;
    return parts(
      errors.wallet.what(pick(problems, e.reason, errors.wallet.unknown)),
      WALLET_BEFORE_PAYING.includes(e.reason) ? errors.wallet.notPaid : null,
      e.reason === 'in-use' ? errors.wallet.inUseAction : errors.retrySoon,
    );
  },
  // The JSON-RPC code, only if it arrives well formed.
  midnightError: (e) => {
    const { errors } = t();
    const rpcCode: unknown = e.rpcCode;
    const what = Number.isInteger(rpcCode) ? errors.midnightError.withCode(rpcCode as number) : errors.midnightError.what;
    return parts(what, null, errors.retry);
  },
};

/** Every code this table knows (those of the three layers, those of links and those of sending mail). The keys do not
 *  depend on the language: they are taken from the Spanish dictionary, the source of the shape (no `t()` at module load). */
export const ERROR_CODES = [...Object.keys(DICTIONARIES.es.errors.simple), ...Object.keys(PARAMETRIC)] as readonly Code[];

/** The three parts of any core error, in the current language; anything unknown gives the generic message. */
export function errorParts(e: unknown): ErrorParts {
  const code = errorCode(e);
  if (code === null) return full(t().errors.generic);
  if (Object.hasOwn(PARAMETRIC, code)) return (PARAMETRIC[code as Parametric] as (e: AnyError) => ErrorParts)(e as AnyError);
  const table = simple();
  return full(Object.hasOwn(table, code) ? table[code as keyof typeof table] : t().errors.generic);
}

/** The parts present, in order: what happened, what is safe, what you can do. */
export function joinParts({ what, safe, action }: ErrorParts): string {
  return [what, safe, action].filter(Boolean).join(' ');
}

/** Message in the current language for any core error, with its three parts in a single text. */
export function describeError(e: unknown): string {
  return joinParts(errorParts(e));
}

/** Is it the "incomplete configuration" error (from either layer)? */
export function isBadConfig(e: unknown): boolean {
  return errorCode(e) === 'badConfig';
}

/** Is it a disk or permissions failure when taking the profile? The core does not mount again, so retrying is useless. */
export function isBootFailure(e: unknown): boolean {
  const code = errorCode(e);
  return code === 'insecureFiles' || code === 'storage';
}

/** Does this profile have another live instance of the app? Then this one does not start the core (`src-tauri/src/instance.rs`). */
export function isProfileInUse(e: unknown): boolean {
  return errorCode(e) === 'profileInUse';
}
