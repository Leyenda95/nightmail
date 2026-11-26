// CLI logic, kept apart from cli.ts so it can be tested.
import { parseArgs } from "node:util";
import { buildMessage } from "./message.ts";
import { ConnectError, sendMail, SmtpError } from "./smtp-client.ts";
import { DEFAULT_ROTATION, TEMPLATES } from "./templates.ts";

const USAGE = `Usage: node tools/demo-mailer/src/cli.ts --to <address[=template]> [--to ...] [options]

  --to <address>       Recipient (repeatable, required). With "address=template"
                       only that template is sent to it.
  --count <N>          Emails per recipient (default 1)
  --template <name>    ${Object.keys(TEMPLATES).join(", ")} (default: rotates through the normal ones)
  --name <name>        Name for the greetings (default: neutral greeting)
  --size-kb <N>        Size of the "long" template (default 256)
  --host <host>        SMTP server (default 127.0.0.1)
  --port <port>        SMTP port (default 2525)
  --help               Show this help`;

export interface Recipient {
  address: string;
  template: string | undefined;
}

export interface Settings {
  recipients: Recipient[];
  count: number;
  template: string | undefined;
  name: string | undefined;
  sizeKb: number;
  host: string;
  port: number;
}

function positiveInt(value: string, name: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`--${name} must be a positive integer`);
  return Number(value);
}

function checkTemplate(name: string): string {
  if (!Object.hasOwn(TEMPLATES, name)) throw new Error(`unknown template: ${name}`);
  return name;
}

function parsePort(value: string): number {
  const port = positiveInt(value, "port");
  if (port > 65535) throw new Error("--port must be between 1 and 65535");
  return port;
}

/** `address` or `address=template`; the address may not contain spaces, CR/LF, `<>` or non-ASCII. */
export function parseRecipient(value: string): Recipient {
  const eq = value.lastIndexOf("=");
  const address = eq > 0 ? value.slice(0, eq) : value;
  if (!/^[\x21-\x7e]+$/.test(address) || /[<>]/.test(address)) throw new Error(`invalid address: ${JSON.stringify(address)}`);
  return { address, template: eq > 0 ? checkTemplate(value.slice(eq + 1)) : undefined };
}

export function parseSettings(argv: string[]): Settings | "help" {
  const { values } = parseArgs({
    args: argv,
    options: {
      to: { type: "string", multiple: true },
      count: { type: "string", default: "1" },
      template: { type: "string" },
      name: { type: "string" },
      "size-kb": { type: "string", default: "256" },
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "2525" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) return "help";
  if (!values.to?.length) throw new Error("missing --to");
  return {
    recipients: values.to.map(parseRecipient),
    count: positiveInt(values.count, "count"),
    template: values.template === undefined ? undefined : checkTemplate(values.template),
    name: values.name,
    sizeKb: positiveInt(values["size-kb"], "size-kb"),
    host: values.host,
    port: parsePort(values.port),
  };
}

function templateName(settings: Settings, recipient: Recipient, i: number): string {
  return recipient.template ?? settings.template ?? DEFAULT_ROTATION[i % DEFAULT_ROTATION.length] ?? "welcome";
}

interface Outcome {
  line: string;
  ok: boolean;
  /** No point in continuing (no server). */
  abort?: boolean;
}

/** Sends one email (`i`: index for this recipient, `seq`: index in the whole batch). */
async function sendOne(settings: Settings, recipient: Recipient, i: number, seq: number): Promise<Outcome> {
  const name = templateName(settings, recipient, i);
  const spec = TEMPLATES[name]!({
    to: { address: recipient.address },
    ...(settings.name !== undefined && { name: settings.name }),
    index: seq,
    now: new Date(),
    sizeKb: settings.sizeKb,
  });
  const label = `[${name}] ${recipient.address}`;
  try {
    const result = await sendMail({
      host: settings.host,
      port: settings.port,
      from: spec.from.address,
      to: [recipient.address],
      data: buildMessage(spec),
    });
    const rejected = result.rejected[0];
    if (rejected) return { line: `REJECTED  ${label}: ${rejected.code} ${rejected.text}`, ok: false };
    return { line: `ACCEPTED  ${label}`, ok: true };
  } catch (error) {
    if (error instanceof ConnectError) {
      const hint = `Is the server running at ${settings.host}:${settings.port}?`;
      return { line: `ERROR     ${label}: ${error.message}\n${hint}`, ok: false, abort: true };
    }
    if (!(error instanceof SmtpError)) throw error;
    const verdict = error.code === undefined ? "ERROR    " : "REJECTED ";
    return { line: `${verdict} ${label}: ${error.message}`, ok: false };
  }
}

/** Runs the CLI and returns the exit code (0 if everything was accepted). */
export async function run(argv: string[], out: (line: string) => void): Promise<number> {
  let settings: Settings | "help";
  try {
    settings = parseSettings(argv);
  } catch (error) {
    out(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  if (settings === "help") {
    out(USAGE);
    return 0;
  }
  let failures = 0;
  let seq = 0;
  for (const recipient of settings.recipients) {
    for (let i = 0; i < settings.count; i++) {
      const { line, ok, abort } = await sendOne(settings, recipient, i, seq++);
      out(line);
      if (abort) return 1;
      if (!ok) failures++;
    }
  }
  out(failures === 0 ? "All delivered." : `${failures} failed send(s).`);
  return failures === 0 ? 0 : 1;
}
