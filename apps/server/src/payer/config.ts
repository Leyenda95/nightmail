// Payer process limits. The defaults are provisional: a NightMailRegistry transaction costs ~0.4 DUST
// (measured on devnet), so 100 DUST/h is about 250 client transactions per hour and 50 DUST/h about
// 125 bonos per hour.
//
// Environment variables (optional, whole DUST):
//   NIGHTMAIL_PAYER_RELAY_DUST_PER_HOUR   hard cap on what `relay` pays per hour
//   NIGHTMAIL_PAYER_ISSUE_DUST_PER_HOUR   hard cap on what `issue` pays per hour
//   NIGHTMAIL_PAYER_MAX_QUEUE             running plus waiting operations (1-10000)
//   NIGHTMAIL_PAYER_EARLY_RELAY_ANSWER    1: answer guaranteed-only relays once in a block, before finality
//                                         (payer.ts). 0 or unset: off. Only turn it on once
//                                         test-devnet/inblock.devnet.ts passes against the node in use.
//                                         The mail server reads it too: only with it on does it treat
//                                         unknown recipients as "try later" for a while after an
//                                         inclusion (registry/settling.ts).
import type { PayerLimits } from './payer.ts';

/** Base units per DUST (15 decimals). */
export const DUST_UNIT = 10n ** 15n;

export const DEFAULT_PAYER_LIMITS: PayerLimits = {
  relayDustPerHour: 100n * DUST_UNIT,
  issueDustPerHour: 50n * DUST_UNIT,
  maxQueue: 32,
  earlyRelayAnswer: false,
};

/** A 0/1 switch; anything else is a config error. */
function flag(env: Record<string, string | undefined>, name: string): boolean | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  if (value !== '0' && value !== '1') throw new Error(`${name} must be 0 or 1`);
  return value === '1';
}

/** Unsigned integer of up to 12 digits; anything else is a config error, never a silent default. */
function unsigned(env: Record<string, string | undefined>, name: string): bigint | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9][0-9]{0,11})$/.test(value)) throw new Error(`${name} must be an unsigned integer`);
  return BigInt(value);
}

/** NIGHTMAIL_PAYER_EARLY_RELAY_ANSWER alone, for the mail server (which does not use the other payer limits). */
export function loadEarlyRelayAnswer(env: Record<string, string | undefined> = process.env): boolean {
  return flag(env, 'NIGHTMAIL_PAYER_EARLY_RELAY_ANSWER') ?? DEFAULT_PAYER_LIMITS.earlyRelayAnswer!;
}

export function loadPayerLimits(env: Record<string, string | undefined> = process.env): PayerLimits {
  const dust = (name: string, fallback: bigint) => {
    const whole = unsigned(env, name);
    return whole === undefined ? fallback : whole * DUST_UNIT;
  };
  const maxQueue = unsigned(env, 'NIGHTMAIL_PAYER_MAX_QUEUE') ?? BigInt(DEFAULT_PAYER_LIMITS.maxQueue);
  if (maxQueue < 1n || maxQueue > 10_000n) throw new Error('NIGHTMAIL_PAYER_MAX_QUEUE must be between 1 and 10000');
  return {
    relayDustPerHour: dust('NIGHTMAIL_PAYER_RELAY_DUST_PER_HOUR', DEFAULT_PAYER_LIMITS.relayDustPerHour),
    issueDustPerHour: dust('NIGHTMAIL_PAYER_ISSUE_DUST_PER_HOUR', DEFAULT_PAYER_LIMITS.issueDustPerHour),
    maxQueue: Number(maxQueue),
    earlyRelayAnswer: loadEarlyRelayAnswer(env),
  };
}
