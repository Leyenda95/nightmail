import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { buildMessage } from "../src/message.ts";
import { parseRecipient, parseSettings, run } from "../src/run.ts";
import { DEFAULT_ROTATION, TEMPLATES, longText } from "../src/templates.ts";
import { closedPort, startFakeServer, type FakeServer } from "./fake-smtp.ts";

let server: FakeServer | undefined;
afterEach(async () => {
  assert.deepEqual(server?.violations ?? [], []);
  await server?.close();
  server = undefined;
});

const ctx = { to: { address: "juan.perez@nightmail.local" }, index: 0, now: new Date("2026-11-17T10:00:00Z"), sizeKb: 8 };
const named = { ...ctx, name: "Juan" };

describe("plantillas", () => {
  it("all generate messages whose headers are ASCII and at most 76 columns", () => {
    for (const [name, tpl] of Object.entries(TEMPLATES)) {
      const [head] = buildMessage(tpl(ctx)).split("\r\n\r\n");
      assert.ok(!/[^\x00-\x7f]/.test(head!), name);
      // Header lines (folded ones included) never exceed 76 characters.
      for (const line of head!.split("\r\n")) assert.ok(line.length <= 76, `${name}: ${line.length} ${line}`);
      assert.match(head!, /\r\nTo: juan\.perez@nightmail\.local/, name);
    }
  });
  it("no message line exceeds 998 characters", () => {
    for (const [name, tpl] of Object.entries(TEMPLATES)) {
      for (const line of buildMessage(tpl(ctx)).split("\r\n")) assert.ok(line.length <= 998, name);
    }
  });
  it("personal lleva tildes y emojis", () => {
    const spec = TEMPLATES.personal!(ctx);
    assert.match(spec.text, /Andrés 🎂/);
    assert.match(spec.subject, /🎉/);
  });
  it("attachment is multipart", () => {
    assert.match(buildMessage(TEMPLATES.attachment!(ctx)), /multipart\/mixed/);
  });
  it("greets by name only if given; otherwise a neutral greeting (an alias is not a name)", () => {
    assert.match(TEMPLATES.welcome!(named).text, /^Hola, Juan,/);
    assert.match(TEMPLATES.welcome!(named).subject, /Luna, Juan!/);
    assert.match(TEMPLATES.welcome!(ctx).text, /^Hola,\n/);
    assert.match(TEMPLATES.personal!(ctx).text, /^¡Hola! /);
    assert.match(TEMPLATES.invoice!(ctx).text, /^Estimado\/a cliente:/);
    assert.match(TEMPLATES.invoice!(named).text, /^Estimado\/a Juan:/);
    assert.ok(!TEMPLATES.welcome!({ ...ctx, to: { address: "nube.abcdefghijkl@nightmail.local" } }).text.includes("Nube"));
  });
  it("numbers orders and invoices by index", () => {
    assert.match(TEMPLATES.invoice!({ ...ctx, index: 3 }).subject, /F-2026-48203/);
  });
  it("long respects the requested size even on the wire and includes dot lines before stuffing", () => {
    const text = longText(10);
    assert.ok(text.split("\n").some((l) => l.startsWith(".")));
    const msg = buildMessage(TEMPLATES.long!({ ...ctx, sizeKb: 10 }));
    const wire = Buffer.byteLength(msg);
    assert.ok(wire >= 10 * 1024 && wire < 10 * 1024 + 1024, `${wire}`);
    assert.ok(msg.split("\r\n").some((l) => l.startsWith(".")));
    assert.ok(!msg.includes("\n") || msg.split("\n").every((l, i, a) => i === a.length - 1 || l.endsWith("\r")));
  });
  it("longText: lines numbered from 1, one in 25 starts with a dot, and stops as soon as it reaches the size (with CRLF)", () => {
    const lines = longText(10).split("\n");
    assert.match(lines[0]!, /^Línea 1\. /);
    lines.forEach((l, i) => assert.equal(l.startsWith("."), (i + 1) % 25 === 0, `line ${i + 1}`));
    const bytes = lines.map((l) => Buffer.byteLength(l) + 2);
    const total = bytes.reduce((a, b) => a + b);
    assert.ok(total >= 10 * 1024 && total - bytes.at(-1)! < 10 * 1024, `${total}`);
  });
  it("the default rotation excludes the test ones", () => {
    for (const test of ["long", "bomb", "images"]) assert.ok(!DEFAULT_ROTATION.includes(test), test);
    for (const n of DEFAULT_ROTATION) assert.ok(n in TEMPLATES);
  });
});

describe("parseSettings", () => {
  it("default values", () => {
    assert.deepEqual(parseSettings(["--to", "a@b.c"]), {
      recipients: [{ address: "a@b.c", template: undefined }],
      count: 1, template: undefined, name: undefined, sizeKb: 256, host: "127.0.0.1", port: 2525,
    });
  });
  it("several --to, template per recipient and options", () => {
    const s = parseSettings(["--to", "a@b.c=welcome", "--to", "d@e.f", "--count", "3", "--template", "long", "--name", "Ana", "--port", "99", "--host", "h"]);
    assert.deepEqual(s, {
      recipients: [{ address: "a@b.c", template: "welcome" }, { address: "d@e.f", template: undefined }],
      count: 3, template: "long", name: "Ana", sizeKb: 256, host: "h", port: 99,
    });
  });
  it("errors", () => {
    assert.throws(() => parseSettings([]), /missing --to/);
    assert.throws(() => parseSettings(["--to", "a@b.c", "--count", "0"]), /--count/);
    assert.throws(() => parseSettings(["--to", "a@b.c", "--port", "x"]), /--port/);
    assert.throws(() => parseSettings(["--to", "a@b.c", "--template", "nope"]), /unknown template/);
    assert.throws(() => parseSettings(["--to", "a@b.c", "--template", "toString"]), /unknown template/);
    assert.throws(() => parseSettings(["--to", "a@b.c=nope"]), /unknown template/);
  });
  it("puerto entre 1 y 65535", () => {
    assert.equal((parseSettings(["--to", "a@b.c", "--port", "65535"]) as { port: number }).port, 65535);
    assert.throws(() => parseSettings(["--to", "a@b.c", "--port", "65536"]), /65535/);
    assert.throws(() => parseSettings(["--to", "a@b.c", "--port", "0"]), /--port/);
  });
  it("ayuda", () => assert.equal(parseSettings(["--help"]), "help"));
});

describe("parseRecipient", () => {
  it("acepta direcciones normales", () => {
    assert.deepEqual(parseRecipient("juan.perez@nightmail.local"), { address: "juan.perez@nightmail.local", template: undefined });
  });
  it("splits the template even with one-character addresses", () => {
    assert.deepEqual(parseRecipient("a=welcome"), { address: "a", template: "welcome" });
  });
  it("a leading = is part of the address, it does not split a template", () => {
    assert.deepEqual(parseRecipient("=x@b.c"), { address: "=x@b.c", template: undefined });
  });
  it("rejects CR/LF, spaces, <>, non-ASCII and empty ones", () => {
    for (const bad of ["a@b.c\r\nRCPT TO:<x@y.z>", "a b@c.d", "<a@b.c>", "a@b.c>", "ñu@b.c", "", "a\x7f@b.c"]) {
      assert.throws(() => parseRecipient(bad), /invalid|template/, JSON.stringify(bad));
    }
  });
});

describe("run", () => {
  it("reports accepted/rejected per recipient without aborting", async () => {
    server = await startFakeServer({ rejected: ["nadie@nightmail.local"] });
    const out: string[] = [];
    const code = await run(
      ["--to", "nadie@nightmail.local", "--to", "juan@nightmail.local", "--port", String(server.port)],
      (l) => out.push(l),
    );
    assert.equal(code, 1);
    assert.deepEqual(out, [
      "REJECTED  [welcome] nadie@nightmail.local: 550 5.1.1 no existe",
      "ACCEPTED  [welcome] juan@nightmail.local",
      "1 failed send(s).",
    ]);
    assert.equal(server.messages.length, 1);
  });

  it("a 552 after DATA is reported as REJECTED, not ERROR", async () => {
    server = await startFakeServer({ finalReply: "552 5.3.4 demasiado grande" });
    const out: string[] = [];
    const code = await run(["--to", "a@nightmail.local", "--template", "long", "--size-kb", "1", "--port", String(server.port)], (l) => out.push(l));
    assert.equal(code, 1);
    assert.match(out[0]!, /^REJECTED {2}\[long\] a@nightmail\.local: .*552 5\.3\.4 demasiado grande/);
  });

  it("rotates templates with --count", async () => {
    server = await startFakeServer();
    const out: string[] = [];
    const n = DEFAULT_ROTATION.length + 1;
    const code = await run(["--to", "a@nightmail.local", "--count", String(n), "--port", String(server.port)], (l) => out.push(l));
    assert.equal(code, 0);
    assert.deepEqual(
      out.slice(0, n).map((l) => /\[(\w+)\]/.exec(l)![1]),
      [...DEFAULT_ROTATION, DEFAULT_ROTATION[0]],
    );
    assert.equal(out.at(-1), "All delivered.");
    assert.equal(server.messages.length, n);
  });

  it("template per recipient and order numbering continuing across recipients", async () => {
    server = await startFakeServer();
    const out: string[] = [];
    await run(
      ["--to", "a@nightmail.local=attachment", "--to", "b@nightmail.local=attachment", "--name", "Ana", "--port", String(server.port)],
      (l) => out.push(l),
    );
    assert.deepEqual(out.slice(0, 2), ["ACCEPTED  [attachment] a@nightmail.local", "ACCEPTED  [attachment] b@nightmail.local"]);
    const subject = (m: string) => Buffer.from(/Subject: =\?utf-8\?B\?([^?]+)/.exec(m)![1]!, "base64").toString();
    assert.match(subject(server.messages[0]!), /#48200/);
    assert.match(subject(server.messages[1]!), /#48201/);
  });

  it("--name reaches the greeting", async () => {
    server = await startFakeServer();
    await run(["--to", "nube.abcdefghijkl@nightmail.local", "--template", "welcome", "--name", "Ana", "--port", String(server.port)], () => {});
    const subject = Buffer.from(/Subject: =\?utf-8\?B\?([^?]+)/.exec(server.messages[0]!)![1]!, "base64").toString();
    assert.match(subject, /Luna, Ana!/);
  });

  it("uses the given template and sends the requested size with stuffing", async () => {
    server = await startFakeServer();
    const out: string[] = [];
    await run(["--to", "a@nightmail.local", "--template", "long", "--size-kb", "8", "--port", String(server.port)], (l) => out.push(l));
    assert.equal(out[0], "ACCEPTED  [long] a@nightmail.local");
    assert.ok(server.messages[0]!.length >= 8 * 1024);
    assert.ok(server.messages[0]!.split("\r\n").some((l) => l.startsWith("..")));
  });

  it("without a server it aborts the batch at the first connection failure, with a hint", async () => {
    const port = await closedPort();
    const out: string[] = [];
    const code = await run(["--to", "a@nightmail.local", "--to", "b@nightmail.local", "--count", "3", "--port", String(port)], (l) => out.push(l));
    assert.equal(code, 1);
    assert.equal(out.length, 1);
    assert.match(out[0]!, /^ERROR     \[welcome\] a@nightmail\.local: connection/);
    assert.match(out[0]!, /Is the server running at 127\.0\.0\.1:\d+\?$/);
  });

  it("bad usage gives code 2 and help gives 0", async () => {
    const out: string[] = [];
    assert.equal(await run([], (l) => out.push(l)), 2);
    assert.match(out[0]!, /missing --to/);
    out.length = 0;
    assert.equal(await run(["--help"], (l) => out.push(l)), 0);
    assert.match(out[0]!, /^Usage:/);
  });
});
