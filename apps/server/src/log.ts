// Minimal mail server logger. Addresses, senders, message content, keys and signatures are never
// logged; only counts, block heights and fixed reasons. Details of a rejection go to debug level only.

export type Logger = {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
};

const stderr = (line: string) => {
  process.stderr.write(`${line}\n`);
};

/** Writes to stderr (or `write`); `debug` lines only when enabled. */
export function createLogger(debug: boolean, write: (line: string) => void = stderr): Logger {
  return {
    info: (message) => write(`[mail] ${message}`),
    warn: (message) => write(`[mail] WARN ${message}`),
    debug: (message) => {
      if (debug) write(`[mail] debug ${message}`);
    },
  };
}

export const silentLogger: Logger = { info: () => {}, warn: () => {}, debug: () => {} };

/**
 * Loggable kind of an error: its name, its `code` and, for SQLite, its `errcode` (e.g.
 * `Error/ERR_SQLITE_ERROR/13` on a full disk). Never the message, which may carry paths, URLs or
 * request data.
 */
export function errorKind(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown';
  const { code, errcode } = error as { code?: unknown; errcode?: unknown };
  const parts = [error.name];
  if (typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code)) parts.push(code);
  if (Number.isSafeInteger(errcode)) parts.push(String(errcode));
  return parts.join('/');
}
