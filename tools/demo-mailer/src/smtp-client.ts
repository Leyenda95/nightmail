// Minimal SMTP client (no TLS or AUTH: only for the local demo server).
import net from "node:net";

export interface SmtpReply {
  code: number;
  lines: string[];
}

export interface SendOptions {
  host: string;
  port: number;
  /** Name announced in EHLO. */
  heloName?: string;
  from: string;
  to: string[];
  /** Full message (headers and body). Normalized to CRLF and dot-stuffed. */
  data: string;
  /** Connect timeout (default 3 s). */
  connectTimeoutMs?: number;
  /** Idle timeout once connected (default 10 s). */
  timeoutMs?: number;
}

export interface RejectedRecipient {
  address: string;
  code: number;
  text: string;
}

export interface SendResult {
  accepted: string[];
  rejected: RejectedRecipient[];
  /** `false` if no recipient was accepted, so DATA was never sent. */
  delivered: boolean;
}

/** Connection error or unexpected server reply (`code` is the SMTP code, if any). */
export class SmtpError extends Error {
  readonly code: number | undefined;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "SmtpError";
    this.code = code;
  }
}

/** The connection could not be established (refused or no answer). */
export class ConnectError extends SmtpError {
  constructor(message: string) {
    super(message);
    this.name = "ConnectError";
  }
}

/** CRLF on every line, dot-stuffing and the final `.` terminator. */
export function prepareData(message: string): string {
  const lines = message.replace(/\r\n|\r|\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => (l.startsWith(".") ? `.${l}` : l)).join("\r\n") + "\r\n.\r\n";
}

// A reply line: "250-text", "250 text", or a bare "250" (last line).
const REPLY_LINE = /^(\d{3})(?:([ -])(.*))?$/;

/** Queued line reader over a socket, for awaiting replies in sequence. */
class LineReader {
  private buffer = "";
  private queue: string[] = [];
  private waiter: { resolve: (l: string) => void; reject: (e: Error) => void } | undefined;
  private failure: Error | undefined;

  constructor(socket: net.Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      const parts = this.buffer.split("\r\n");
      this.buffer = parts.pop() ?? "";
      this.queue.push(...parts);
      this.flush();
    });
    socket.on("error", (e) => this.fail(new SmtpError(`connection: ${e.message}`)));
    socket.on("close", () => this.fail(new SmtpError("the server closed the connection")));
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.flush();
  }

  private flush(): void {
    const waiter = this.waiter;
    if (!waiter) return;
    const line = this.queue.shift();
    if (line !== undefined) {
      this.waiter = undefined;
      waiter.resolve(line);
    } else if (this.failure) {
      this.waiter = undefined;
      waiter.reject(this.failure);
    }
  }

  readLine(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
      this.flush();
    });
  }

  async readReply(): Promise<SmtpReply> {
    const lines: string[] = [];
    for (;;) {
      const raw = await this.readLine();
      const m = REPLY_LINE.exec(raw);
      if (!m) throw new SmtpError(`respuesta mal formada: ${raw}`);
      lines.push(m[3] ?? "");
      if (m[2] !== "-") return { code: Number(m[1]), lines };
    }
  }
}

function connect(host: string, port: number, connectTimeoutMs: number, idleMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const fail = (message: string) => {
      clearTimeout(timer);
      socket.destroy();
      reject(new ConnectError(message));
    };
    const onError = (e: Error) => fail(`connection: ${e.message}`);
    const timer = setTimeout(
      () => fail(`connection: no answer from ${host}:${port} after ${connectTimeoutMs} ms`),
      connectTimeoutMs,
    );
    socket.once("error", onError);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.off("error", onError);
      socket.setTimeout(idleMs, () => socket.destroy(new Error("timed out")));
      resolve(socket);
    });
  });
}

function replyText(reply: SmtpReply): string {
  return reply.lines.join(" ");
}

/** Sends a message. Throws `SmtpError` on connection failures or unexpected replies. */
export async function sendMail(options: SendOptions): Promise<SendResult> {
  const socket = await connect(options.host, options.port, options.connectTimeoutMs ?? 3_000, options.timeoutMs ?? 10_000);
  const reader = new LineReader(socket);
  const command = async (line: string, expected: number, step: string): Promise<SmtpReply> => {
    socket.write(`${line}\r\n`);
    return expect(await reader.readReply(), expected, step);
  };
  try {
    expect(await reader.readReply(), 220, "saludo");
    await command(`EHLO ${options.heloName ?? "demo-mailer.local"}`, 250, "EHLO");
    await command(`MAIL FROM:<${options.from}>`, 250, "MAIL FROM");
    const result: SendResult = { accepted: [], rejected: [], delivered: false };
    for (const address of options.to) {
      socket.write(`RCPT TO:<${address}>\r\n`);
      const reply = await reader.readReply();
      if (reply.code === 250 || reply.code === 251) result.accepted.push(address);
      else result.rejected.push({ address, code: reply.code, text: replyText(reply) });
    }
    if (result.accepted.length > 0) {
      await command("DATA", 354, "DATA");
      socket.write(prepareData(options.data));
      expect(await reader.readReply(), 250, "mensaje");
      result.delivered = true;
    }
    await command("QUIT", 221, "QUIT").catch(() => undefined);
    socket.end();
    return result;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

function expect(reply: SmtpReply, code: number, step: string): SmtpReply {
  if (reply.code !== code) {
    throw new SmtpError(`${step}: expected ${code}, got ${reply.code} ${replyText(reply)}`, reply.code);
  }
  return reply;
}
