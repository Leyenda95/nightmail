// Strict parsing of numeric and on/off environment variables (issuer, relayer). A malformed value is
// never ignored: startup fails and names the variable.

/** Integer in [`min`, `max`]; `fallback` when unset. Empty or out of range throws. */
export function parseInteger(name: string, value: string | undefined, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const n = value === undefined ? fallback : value === '' ? Number.NaN : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name}: expected an integer between ${min} and ${max}`);
  return n;
}

/** '1' is true, '0' or unset is false, anything else throws. */
export function parseFlag(name: string, value: string | undefined): boolean {
  if (value === undefined || value === '0') return false;
  if (value === '1') return true;
  throw new Error(`${name}: expected 1 or 0`);
}
