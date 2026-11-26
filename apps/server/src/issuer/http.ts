// HTTP helpers for the Issuer API (also used by the relayer): JSON replies with an absolute deadline and
// connection close, and strict body reading (JSON object only, size-capped). Errors carry a fixed code, no details.
import { once } from 'node:events';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { errorKind } from '../log.ts';

export type Reply = { status: number; body: unknown; headers?: Record<string, string> };

export const json = (status: number, body: unknown, headers?: Record<string, string>): Reply =>
  ({ status, body, ...(headers && { headers }) });

export const fail = (status: number, error: string, headers?: Record<string, string>): Reply => json(status, { error }, headers);

/**
 * Sends the reply and closes the connection (`Connection: close`, otherwise two requests on one connection
 * would be linkable). The absolute deadline keeps a non-reading client from holding the connection.
 */
export function send(res: ServerResponse, reply: Reply, timeoutMs: number): void {
  const body = Buffer.from(JSON.stringify(reply.body), 'utf8');
  const deadline = setTimeout(() => res.destroy(), timeoutMs);
  deadline.unref();
  res.once('close', () => clearTimeout(deadline));
  res.writeHead(reply.status, {
    'Content-Type': 'application/json',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Connection: 'close',
    ...reply.headers,
  });
  res.end(body);
}

const INTERNAL_ERROR = fail(500, 'internal');

/**
 * Serves a request with `route`'s reply, or 500 `internal` if it throws (only the error type is logged).
 * A pipelined request arrives without a socket because the previous reply closed it; it is not served.
 */
export async function respond(
  res: ServerResponse, route: () => Promise<Reply>, o: { label: string; log: { warn(message: string): void }; timeoutMs: number },
): Promise<void> {
  if (res.socket === null) return;
  const reply = await route().catch((error: unknown) => {
    o.log.warn(`${o.label}: internal error (${errorKind(error)})`);
    return INTERNAL_ERROR;
  });
  send(res, reply, o.timeoutMs);
}

/** Listens and returns the actual port. Rejects if an 'error' (port in use) comes first. */
export async function listenOn(server: Server, port: number, host: string): Promise<number> {
  server.listen(port, host);
  await once(server, 'listening');
  const address = server.address();
  return typeof address === 'object' && address ? address.port : port;
}

export type BodyResult = { ok: true; value: Record<string, unknown> } | { ok: false; reply: Reply };

const JSON_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const TOO_LARGE = fail(413, 'payload_too_large');
const BAD_REQUEST = fail(400, 'bad_request');

/** The body as a JSON object, or the matching error reply (415, 413, 400). */
export function readJsonObject(req: IncomingMessage, maxBytes: number): Promise<BodyResult> {
  if (!JSON_TYPE.test(req.headers['content-type'] ?? '')) return Promise.resolve({ ok: false, reply: fail(415, 'unsupported_media_type') });
  if (Number(req.headers['content-length'] ?? 0) > maxBytes) return Promise.resolve({ ok: false, reply: TOO_LARGE });
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= maxBytes) chunks.push(chunk);
    });
    req.on('error', () => resolve({ ok: false, reply: BAD_REQUEST }));
    req.on('end', () => resolve(size > maxBytes ? { ok: false, reply: TOO_LARGE } : parseObject(Buffer.concat(chunks))));
  });
}

function parseObject(raw: Buffer): BodyResult {
  try {
    const value: unknown = JSON.parse(raw.toString('utf8'));
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return { ok: true, value: value as Record<string, unknown> };
  } catch {
    /* invalid JSON */
  }
  return { ok: false, reply: BAD_REQUEST };
}
