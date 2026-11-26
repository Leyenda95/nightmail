// Mailbox API responses: fixed bodies with no details, sent under a deadline on a connection that closes.
import type { ServerResponse } from 'node:http';
import type { RateLimit } from '../limits.ts';

/** A response; `release` is called once it is fully sent or cut off (frees its slot). */
export type Reply = { status: number; type: string; body: Uint8Array; headers?: Record<string, string>; release?: () => void };

export const json = (status: number, value: unknown, headers?: Record<string, string>): Reply =>
  ({ status, type: 'application/json', body: Buffer.from(JSON.stringify(value), 'utf8'), ...(headers && { headers }) });

// Errors shared by every route: fixed body, no details.
export const NOT_FOUND = json(404, { error: 'not_found' });
export const BUSY = json(429, { error: 'busy' }, { 'Retry-After': '1' });
export const INTERNAL_ERROR = json(500, { error: 'internal' });
export const rateLimited = (limit: RateLimit): Reply =>
  json(429, { error: 'rate_limited' }, { 'Retry-After': String(Math.ceil(limit.windowMs / 1000)) });

/**
 * Sends the response under an absolute deadline. The slot is freed exactly once: on finish or cut-off
 * (`'close'`), or when the deadline fires in case `'close'` is never emitted.
 */
export function send(res: ServerResponse, reply: Reply, timeoutMs: number): void {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(deadline);
    reply.release?.();
  };
  const deadline = setTimeout(() => {
    res.destroy();
    finish();
  }, timeoutMs);
  deadline.unref();
  res.once('close', finish);
  res.writeHead(reply.status, {
    'Content-Type': reply.type,
    'Content-Length': reply.body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Connection: 'close',
    ...reply.headers,
  });
  res.end(reply.body);
}
