// Fake SMTP server for the tests; it validates command order.
import net from "node:net";

export interface FakeOptions {
  /** Addresses answered with 550. */
  rejected?: string[];
  /** RCPT reply for specific addresses (e.g. "451 4.7.1 inténtalo luego", "251 reenviado"). */
  rcptReplies?: Record<string, string>;
  /** Greeting reply (default 220); `null` means no greeting. */
  greeting?: string | null;
  /** Reply at the end of DATA (default 250). */
  finalReply?: string;
  /** Writes each reply one byte at a time. */
  fragment?: boolean;
  /** Answers QUIT with this instead of 221 (to check the client tolerates it). */
  quitReply?: string;
}

export interface FakeServer {
  port: number;
  /** Commands received (excluding DATA content). */
  commands: string[];
  /** Content of each DATA received, as it arrived (dot-stuffed, without the terminator). */
  messages: string[];
  /** Commands received in an order the protocol does not allow. */
  violations: string[];
  close(): Promise<void>;
}

type Phase = "start" | "greeted" | "mail" | "rcpt" | "data" | "done";

/** Commands allowed in each phase and the phase each one leads to. */
const TRANSITIONS: Record<Phase, Record<string, Phase>> = {
  start: { EHLO: "greeted" },
  greeted: { MAIL: "mail", QUIT: "done" },
  mail: { RCPT: "rcpt", QUIT: "done" },
  rcpt: { RCPT: "rcpt", DATA: "data", QUIT: "done" },
  data: {},
  done: {},
};

export async function startFakeServer(options: FakeOptions = {}): Promise<FakeServer> {
  const commands: string[] = [];
  const messages: string[] = [];
  const violations: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    let buffer = "";
    let data: string | undefined;
    let phase: Phase = "start";
    let pending = Promise.resolve();
    const write = (text: string) => {
      if (!options.fragment) return void socket.write(text);
      for (const c of text) pending = pending.then(() => new Promise((r) => setTimeout(() => (socket.write(c), r()), 1)));
    };
    const reply = (text: string) => write(`${text}\r\n`);
    const onCommand = (line: string) => {
      commands.push(line);
      const verb = line.split(/[ :]/)[0]?.toUpperCase() ?? "";
      const next = TRANSITIONS[phase][verb];
      if (!next) {
        violations.push(`${phase}: ${line}`);
        return reply("503 5.5.1 comando fuera de orden");
      }
      phase = next;
      if (verb === "EHLO") write("250-nightmail.local\r\n250 SIZE 1000000\r\n");
      else if (verb === "RCPT") {
        const addr = /<(.*)>/.exec(line)?.[1] ?? "";
        reply(options.rcptReplies?.[addr] ?? (options.rejected?.includes(addr) ? "550 5.1.1 no existe" : "250 ok"));
      } else if (verb === "DATA") {
        data = "";
        reply("354 adelante");
      } else if (verb === "QUIT") {
        reply(options.quitReply ?? "221 adios");
        pending = pending.then(() => void socket.end());
      } else reply("250 ok");
    };
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (data !== undefined) {
          const all = data + buffer;
          const end = all.indexOf("\r\n.\r\n");
          if (end < 0) {
            data = all;
            buffer = "";
            return;
          }
          messages.push(all.slice(0, end + 2));
          buffer = all.slice(end + 5);
          data = undefined;
          phase = "greeted"; // after a message, another MAIL or QUIT is allowed
          reply(options.finalReply ?? "250 2.0.0 encolado");
          continue;
        }
        const nl = buffer.indexOf("\r\n");
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        onCommand(line);
      }
    });
    if (options.greeting !== null) reply(options.greeting ?? "220 nightmail.local ESMTP");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    commands,
    messages,
    violations,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A port nobody listens on. */
export async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Server that greets with 220 and drops the connection. */
export async function startHangupServer(): Promise<{ port: number; close(): void }> {
  const server = net.createServer((s) => {
    s.on("error", () => {});
    s.end("220 hola\r\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return { port, close: () => void server.close() };
}
