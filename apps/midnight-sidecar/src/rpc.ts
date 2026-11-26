// JSON-RPC 2.0 server over stdio, one message per line (NDJSON).
//
// - stdout belongs to the protocol (see stdio.ts); logs go to stderr.
// - Errors carry only a code and a public message. The detail of an unexpected
//   error goes to stderr only when `isDebug()` (debug builds).
// - Notifications (messages without `id`) are never answered. `$/cancel {id}`
//   aborts the signal handed to that request's handler.
// - When input closes, pending requests are answered (within a grace period)
//   and `onClose` is called.
import { AppError, codes } from './codes.ts';

export type HandlerContext = {
  /** Aborted when the core cancels the request or the process shuts down. */
  signal: AbortSignal;
  /** Request id (for progress notifications). */
  requestId: number | string;
  /** Sends a notification to the core (e.g. `progress`). */
  notify: (method: string, params: unknown) => void;
};

export type Handler = (params: unknown, ctx: HandlerContext) => Promise<unknown>;

export type Output = { write(chunk: string, cb?: (err?: Error | null) => void): boolean };

export type ServeOptions = {
  input?: NodeJS.ReadableStream;
  output?: Output;
  onClose?: () => void;
  isDebug?: () => boolean;
  maxLineBytes?: number;
  closeGraceMs?: number;
};

export const MAX_LINE_BYTES = 64 * 1024 * 1024;

type Message = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };

/** What handling a line or request needs; created once per `serve`. */
type Session = {
  handlers: Record<string, Handler>;
  controllers: Map<string, AbortController>;
  /** Writes an already serialised line (without newline). */
  writeLine: (line: string) => void;
  notify: (method: string, params: unknown) => void;
  isDebug: () => boolean;
};

type Request = { id: number | string; method: string; params: unknown };

/** Result of parsing a line: an error with its reply, a notification or a valid request. */
type Parsed =
  | { kind: 'error'; id: unknown; code: number; message: string }
  | { kind: 'notification'; msg: Message }
  | ({ kind: 'request' } & Request);

const invalidRequest = (id: unknown): Parsed => ({ kind: 'error', id, code: codes.INVALID_REQUEST, message: 'Invalid request' });

const isIdValue = (id: unknown): id is number | string => typeof id === 'number' || typeof id === 'string';

function parseLine(line: string): Parsed {
  let msg: Message;
  try {
    msg = JSON.parse(line) as Message;
  } catch {
    return { kind: 'error', id: null, code: codes.PARSE_ERROR, message: 'Parse error' };
  }
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return invalidRequest(null);
  return Object.hasOwn(msg, 'id') ? parseRequest(msg) : { kind: 'notification', msg };
}

function parseRequest(msg: Message): Parsed {
  const { id, method } = msg;
  if (msg.jsonrpc !== '2.0' || typeof method !== 'string' || !isIdValue(id)) {
    return invalidRequest(isIdValue(id) ? id : null);
  }
  return { kind: 'request', id, method, params: msg.params };
}

/** Key in `controllers` to abort if the notification is a valid `$/cancel`. */
function cancelTarget(msg: Message): string | undefined {
  if (msg.jsonrpc !== '2.0' || msg.method !== '$/cancel') return undefined;
  return String((msg.params as { id?: unknown } | undefined)?.id);
}

function logDetail(session: Session, method: string, err: unknown): void {
  // The detail may be sensitive: debug only.
  if (session.isDebug()) console.error(`[sidecar] ${method} failed:`, err);
  else console.error(`[sidecar] ${method} failed`);
}

function sendError(session: Session, id: unknown, code: number, message: string, data?: unknown): void {
  const error = data === undefined ? { code, message } : { code, message, data };
  session.writeLine(JSON.stringify({ jsonrpc: '2.0', id, error }));
}

/** Replies to a failed request: public AppError, cancellation or internal error. */
function replyFailure(session: Session, req: Request, err: unknown, aborted: boolean): void {
  if (err instanceof AppError) return sendError(session, req.id, err.code, err.message, err.data);
  if (aborted) return sendError(session, req.id, codes.CANCELLED, 'Cancelled');
  logDetail(session, req.method, err);
  sendError(session, req.id, codes.APP_INTERNAL, 'Internal error');
}

function replyResult(session: Session, req: Request, result: unknown): void {
  let line: string;
  try {
    line = JSON.stringify({ jsonrpc: '2.0', id: req.id, result });
  } catch (err) {
    logDetail(session, req.method, err);
    return sendError(session, req.id, codes.APP_INTERNAL, 'Internal error');
  }
  session.writeLine(line);
}

async function runRequest(session: Session, req: Request): Promise<void> {
  const handler = Object.hasOwn(session.handlers, req.method) ? session.handlers[req.method] : undefined;
  if (!handler) return sendError(session, req.id, codes.METHOD_NOT_FOUND, 'Method not found');

  const controller = new AbortController();
  const key = String(req.id);
  session.controllers.set(key, controller);
  try {
    const ctx = { signal: controller.signal, requestId: req.id, notify: session.notify };
    replyResult(session, req, await handler(req.params, ctx));
  } catch (err) {
    replyFailure(session, req, err, controller.signal.aborted);
  } finally {
    session.controllers.delete(key);
  }
}

// Must stay async so a synchronous failure becomes a rejected promise instead of escaping the listener.
async function handleLine(session: Session, line: string): Promise<void> {
  const parsed = parseLine(line);
  switch (parsed.kind) {
    case 'error':
      return sendError(session, parsed.id, parsed.code, parsed.message);
    case 'notification': {
      // Notifications are never answered.
      const target = cancelTarget(parsed.msg);
      if (target !== undefined) session.controllers.get(target)?.abort();
      return;
    }
    case 'request':
      return runRequest(session, parsed);
  }
}

/**
 * Splits input into lines. If the pending fragment (no newline yet) exceeds `maxLine`, it is dropped
 * up to the next newline and reported once. A long line whose newline arrives in the same chunk is
 * not dropped (it reaches JSON parsing). The limit counts UTF-16 units, not bytes.
 */
class LineSplitter {
  private buffer = '';
  private scanFrom = 0;
  private discarding = false;
  private readonly maxLine: number;
  private readonly onLine: (line: string) => void;
  private readonly onTooLong: () => void;

  constructor(maxLine: number, onLine: (line: string) => void, onTooLong: () => void) {
    this.maxLine = maxLine;
    this.onLine = onLine;
    this.onTooLong = onTooLong;
  }

  push(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const nl = this.buffer.indexOf('\n', this.scanFrom);
      if (nl < 0) return this.checkPartial();
      this.takeLine(nl);
    }
  }

  private checkPartial(): void {
    this.scanFrom = this.buffer.length;
    if (this.buffer.length <= this.maxLine) return;
    // Line too long: drop everything up to the next newline.
    if (!this.discarding) this.onTooLong();
    this.discarding = true;
    this.buffer = '';
    this.scanFrom = 0;
  }

  private takeLine(nl: number): void {
    const line = this.buffer.slice(0, nl).trim(); // trim also removes the \r of CRLF
    this.buffer = this.buffer.slice(nl + 1);
    this.scanFrom = 0;
    if (this.discarding) this.discarding = false;
    else if (line) this.onLine(line);
  }
}

export function serve(handlers: Record<string, Handler>, options: ServeOptions = {}): void {
  const input = options.input ?? process.stdin;
  const output: Output = options.output ?? process.stdout;
  const onClose = options.onClose ?? (() => process.exit(0));
  const graceMs = options.closeGraceMs ?? 5000;

  const writeLine = (line: string): void => {
    output.write(line + '\n');
  };
  const session: Session = {
    handlers,
    controllers: new Map(),
    writeLine,
    notify: (method, params) => writeLine(JSON.stringify({ jsonrpc: '2.0', method, params })),
    isDebug: options.isDebug ?? (() => false),
  };
  const pending = new Set<Promise<void>>();

  const splitter = new LineSplitter(
    options.maxLineBytes ?? MAX_LINE_BYTES,
    (line) => {
      const p: Promise<void> = handleLine(session, line).finally(() => pending.delete(p));
      pending.add(p);
    },
    () => sendError(session, null, codes.PARSE_ERROR, 'Line too long'),
  );

  input.setEncoding('utf8'); // StringDecoder: does not split multibyte characters across chunks
  input.on('data', (chunk: string) => splitter.push(chunk));
  input.on('end', () => {
    for (const c of session.controllers.values()) c.abort();
    const grace = new Promise<void>((resolve) => setTimeout(resolve, graceMs).unref());
    void Promise.race([Promise.allSettled([...pending]), grace]).then(onClose);
  });
}
