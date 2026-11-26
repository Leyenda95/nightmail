// SMTP Ingress test helpers: the real server on a free port and a hand-driven SMTP client.
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { ResolutionIndex } from '@nightmail/midnight';
import type { Logger } from '../src/log.ts';
import { MailboxStore, type MailboxStoreOptions } from '../src/mailbox/store.ts';
import { AddressDirectory } from '../src/registry/directory.ts';
import { createSmtpServer, type IngressDeps, type IngressLimits } from '../src/smtp/ingress.ts';
import { type Database, MEMORY, openDatabase } from '../src/storage/db.ts';
import type { TestAddress } from './mail-fixtures.ts';

export const DOMAIN = 'nightmail.local';

export type TestIngress = {
  port: number;
  store: MailboxStore;
  index: ResolutionIndex;
  directory: AddressDirectory;
  db: Database;
  /** Lines the server wrote to its log (with debug level enabled). */
  logs: string[];
  clock: { now: number };
  close(): Promise<void>;
};

export type TestIngressOptions = {
  addresses?: TestAddress[];
  limits?: Partial<IngressLimits>;
  store?: MailboxStoreOptions;
  databaseFile?: string;
  /** Replaces Ingress parts (e.g. a failing store). */
  override?: (deps: IngressDeps) => IngressDeps;
};

export function capturingLogger(lines: string[]): Logger {
  return { info: (m) => lines.push(`info ${m}`), warn: (m) => lines.push(`warn ${m}`), debug: (m) => lines.push(`debug ${m}`) };
}

export async function startIngress(options: TestIngressOptions = {}): Promise<TestIngress> {
  const db = openDatabase(options.databaseFile ?? MEMORY);
  const store = new MailboxStore(db, options.store);
  const index = new ResolutionIndex();
  index.addBlock(1, (options.addresses ?? []).map((a) => a.entry));
  const directory = new AddressDirectory(index);
  const logs: string[] = [];
  const clock = { now: 1_794_873_600_000 };
  const deps: IngressDeps = {
    domain: DOMAIN, directory, store, log: capturingLogger(logs), now: () => clock.now,
    ...(options.limits && { limits: options.limits }),
  };
  const server = createSmtpServer(options.override ? options.override(deps) : deps);
  const sockets = new Set<net.Socket>();
  server.server.on('connection', (socket: net.Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.server.address() as AddressInfo).port;
  return {
    port, store, index, directory, db, logs, clock,
    // Cut any remaining connections (a test that fails halfway leaves them open).
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const socket of sockets) socket.destroy();
    }),
  };
}

/** Minimal line-by-line SMTP client, to see the server's exact replies. */
export class SmtpDialog {
  private readonly socket: net.Socket;
  private buffer = '';
  private waiter: (() => void) | undefined;
  closed = false;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.setEncoding('latin1');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.waiter?.();
    });
    socket.on('close', () => {
      this.closed = true;
      this.waiter?.();
    });
    socket.on('error', () => {});
  }

  /** Connects, greets with EHLO and returns the ready dialog (and what the server announced). */
  static async open(port: number): Promise<{ dialog: SmtpDialog; greeting: string; ehlo: string }> {
    const socket = net.connect({ host: '127.0.0.1', port });
    const dialog = new SmtpDialog(socket);
    const greeting = await dialog.reply();
    const ehlo = await dialog.send('EHLO cliente.test');
    return { dialog, greeting, ehlo };
  }

  /** Next complete reply (all its lines, joined with "\n"); '' if the server closed. */
  async reply(): Promise<string> {
    for (;;) {
      const lines = this.buffer.split('\r\n');
      const last = lines.findIndex((line) => /^\d{3}(?: |$)/.test(line));
      if (last >= 0 && last < lines.length - 1) {
        this.buffer = lines.slice(last + 1).join('\r\n');
        return lines.slice(0, last + 1).join('\n');
      }
      if (this.closed) return '';
      await new Promise<void>((resolve) => { this.waiter = resolve; });
      this.waiter = undefined;
    }
  }

  /** Sends a line and waits for the reply. */
  send(line: string): Promise<string> {
    this.socket.write(`${line}\r\n`);
    return this.reply();
  }

  /** Writes bytes without waiting for a reply (DATA content). */
  write(data: string | Uint8Array): void {
    this.socket.write(data);
  }

  /** Drops the connection without QUIT. */
  drop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.closed) return resolve();
      this.socket.once('close', () => resolve());
      this.socket.destroy();
    });
  }

  async quit(): Promise<void> {
    await this.send('QUIT');
    await this.drop();
  }
}

/** Sends a whole message and returns the replies to each RCPT plus the final reply ('' if there was no DATA). */
export async function deliverRaw(port: number, recipients: string[], data: string | Uint8Array): Promise<{ rcpt: string[]; final: string }> {
  const { dialog } = await SmtpDialog.open(port);
  await dialog.send('MAIL FROM:<remitente@ejemplo.test>');
  const rcpt: string[] = [];
  for (const recipient of recipients) rcpt.push(await dialog.send(`RCPT TO:<${recipient}>`));
  let final = '';
  if (rcpt.some((r) => r.startsWith('250'))) {
    await dialog.send('DATA');
    dialog.write(data);
    final = await dialog.send('\r\n.');
  }
  await dialog.quit();
  return { rcpt, final };
}
