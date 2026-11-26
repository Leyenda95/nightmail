import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ConnectError, prepareData, sendMail, SmtpError } from "../src/smtp-client.ts";
import { closedPort, startFakeServer, startHangupServer, type FakeOptions, type FakeServer } from "./fake-smtp.ts";

let server: FakeServer | undefined;
afterEach(async () => {
  assert.deepEqual(server?.violations ?? [], [], "the client broke the protocol order");
  await server?.close();
  server = undefined;
});

const base = { from: "tienda@x.example", data: "Subject: hola\r\n\r\ncuerpo\r\n", host: "127.0.0.1" };

async function sendTo(to: string[], options: FakeOptions = {}, extra: object = {}) {
  server = await startFakeServer(options);
  return sendMail({ ...base, port: server.port, to, ...extra });
}

describe("prepareData", () => {
  it("normalizes to CRLF and adds the terminator", () => {
    assert.equal(prepareData("a\nb\rc\r\nd"), "a\r\nb\r\nc\r\nd\r\n.\r\n");
  });
  it("applies dot-stuffing to lines starting with a dot", () => {
    assert.equal(prepareData(".uno\n..dos\nx.y\n.\n"), "..uno\r\n...dos\r\nx.y\r\n..\r\n.\r\n");
  });
  it("does not add an empty line if it already ends in a line break", () => {
    assert.equal(prepareData("a\n"), "a\r\n.\r\n");
  });
  it("empty message", () => {
    assert.equal(prepareData(""), "\r\n.\r\n");
  });
});

describe("sendMail", () => {
  it("keeps the SMTP conversation correct, up to QUIT", async () => {
    const result = await sendTo(["juan@nightmail.local"], {}, { heloName: "prueba.local" });
    assert.deepEqual(result, { accepted: ["juan@nightmail.local"], rejected: [], delivered: true });
    assert.deepEqual(server!.commands, [
      "EHLO prueba.local",
      "MAIL FROM:<tienda@x.example>",
      "RCPT TO:<juan@nightmail.local>",
      "DATA",
      "QUIT",
    ]);
    assert.equal(server!.messages[0], "Subject: hola\r\n\r\ncuerpo\r\n");
  });

  it("uses a default EHLO", async () => {
    await sendTo(["a@nightmail.local"]);
    assert.equal(server!.commands[0], "EHLO demo-mailer.local");
  });

  it("sends with dot-stuffing and the server receives the doubled dots", async () => {
    await sendTo(["a@nightmail.local"], {}, { data: "Subject: x\r\n\r\n.línea con punto\r\n.\r\nfin\r\n" });
    assert.equal(server!.messages[0], "Subject: x\r\n\r\n..línea con punto\r\n..\r\nfin\r\n");
  });

  it("records the 550 rejection of one recipient and delivers to the others", async () => {
    const result = await sendTo(["nadie@nightmail.local", "juan@nightmail.local"], { rejected: ["nadie@nightmail.local"] });
    assert.deepEqual(result.accepted, ["juan@nightmail.local"]);
    assert.deepEqual(result.rejected, [{ address: "nadie@nightmail.local", code: 550, text: "5.1.1 no existe" }]);
    assert.equal(result.delivered, true);
  });

  it("does not send DATA if all recipients are rejected, but closes with QUIT", async () => {
    const result = await sendTo(["nadie@nightmail.local"], { rejected: ["nadie@nightmail.local"] });
    assert.equal(result.delivered, false);
    assert.deepEqual(server!.commands.slice(-2), ["RCPT TO:<nadie@nightmail.local>", "QUIT"]);
    assert.equal(server!.messages.length, 0);
  });

  it("treats a 4xx on RCPT as rejection and a 251 as acceptance", async () => {
    const result = await sendTo(["tarde@nightmail.local", "otro@nightmail.local"], {
      rcptReplies: { "tarde@nightmail.local": "451 4.7.1 inténtalo luego", "otro@nightmail.local": "251 reenviado" },
    });
    assert.deepEqual(result.rejected, [{ address: "tarde@nightmail.local", code: 451, text: "4.7.1 inténtalo luego" }]);
    assert.deepEqual(result.accepted, ["otro@nightmail.local"]);
  });

  it("reads replies fragmented byte by byte, multiline included", async () => {
    const result = await sendTo(["a@nightmail.local"], { fragment: true });
    assert.equal(result.delivered, true);
  });

  it("tolerates the server not answering QUIT properly", async () => {
    const result = await sendTo(["a@nightmail.local"], { quitReply: "500 qué es eso" });
    assert.equal(result.delivered, true);
  });

  it("accepts a 250 reply without text", async () => {
    const result = await sendTo(["a@nightmail.local"], { rcptReplies: { "a@nightmail.local": "250" } });
    assert.deepEqual(result.accepted, ["a@nightmail.local"]);
  });

  it("fails with ConnectError if there is no connection", async () => {
    const port = await closedPort();
    await assert.rejects(
      sendMail({ ...base, port, to: ["a@nightmail.local"] }),
      (e: unknown) => e instanceof ConnectError && /connection/.test(e.message),
    );
  });

  it("fails with ConnectError if the connection is not established in time", async () => {
    // 10.255.255.1 does not answer (or the network is unreachable): either way it is a connection failure.
    await assert.rejects(
      sendMail({ ...base, host: "10.255.255.1", port: 2525, to: ["a@nightmail.local"], connectTimeoutMs: 150 }),
      (e: unknown) => e instanceof ConnectError,
    );
  });

  it("times out if the server accepts and does not greet (SmtpError, not ConnectError)", async () => {
    server = await startFakeServer({ greeting: null });
    await assert.rejects(
      sendMail({ ...base, port: server.port, to: ["a@nightmail.local"], timeoutMs: 100 }),
      (e: unknown) => e instanceof SmtpError && !(e instanceof ConnectError) && /timed out/.test(e.message),
    );
  });

  it("fails if the greeting is not 220", async () => {
    await assert.rejects(
      sendTo(["a@nightmail.local"], { greeting: "554 sin servicio" }),
      (e: unknown) => e instanceof SmtpError && e.code === 554 && /saludo/.test(e.message),
    );
  });

  it("fails if the final reply is not 250", async () => {
    await assert.rejects(
      sendTo(["a@nightmail.local"], { finalReply: "552 demasiado grande" }),
      (e: unknown) => e instanceof SmtpError && e.code === 552 && /mensaje/.test(e.message),
    );
  });

  it("fails if the server closes the connection midway", async () => {
    const hangup = await startHangupServer();
    try {
      await assert.rejects(
        sendMail({ ...base, port: hangup.port, to: ["a@nightmail.local"] }),
        (e: unknown) => e instanceof SmtpError && /closed/.test(e.message),
      );
    } finally {
      hangup.close();
    }
  });

  it("rechaza respuestas mal formadas", async () => {
    await assert.rejects(
      sendTo(["a@nightmail.local"], { greeting: "hola" }),
      (e: unknown) => e instanceof SmtpError && /mal formada/.test(e.message),
    );
  });
});
