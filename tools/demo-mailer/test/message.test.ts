import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  base64Lines,
  buildMessage,
  encodeHeaderValue,
  formatDate,
  formatMailbox,
  mimeParameter,
} from "../src/message.ts";

const decodeWords = (h: string) =>
  h
    .split("\r\n ")
    .map((w) => {
      const m = /^=\?utf-8\?B\?(.*)\?=$/.exec(w);
      assert.ok(m, `palabra mal codificada: ${w}`);
      return Buffer.from(m[1]!, "base64").toString("utf8");
    })
    .join("");

describe("encodeHeaderValue", () => {
  it("leaves ASCII untouched", () => {
    assert.equal(encodeHeaderValue("Factura 123"), "Factura 123");
  });
  it("encodes with RFC 2047 if there is non-ASCII", () => {
    const out = encodeHeaderValue("¡Hola! 🎉");
    assert.match(out, /^=\?utf-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    assert.equal(decodeWords(out), "¡Hola! 🎉");
  });
  it("splits into words of up to 76 columns without splitting UTF-8 characters", () => {
    const text = "ñ🎉".repeat(40);
    const out = encodeHeaderValue(text);
    const words = out.split("\r\n ");
    assert.ok(words.length > 1);
    words.forEach((w, i) => assert.ok(w.length <= (i === 0 ? 76 : 75), `${i}: ${w.length}`));
    assert.equal(decodeWords(out), text);
  });
  it("counts the header name: no line exceeds 76 columns", () => {
    const subject = "El Faro Digital · Lo más leído de la semana";
    const lines = `Subject: ${encodeHeaderValue(subject, 9)}`.split("\r\n");
    for (const l of lines) assert.ok(l.length <= 76, `${l.length}: ${l}`);
    assert.equal(decodeWords(encodeHeaderValue(subject, 9)), subject);
  });
  it("without offset, the first word allows 48 bytes", () => {
    const text = "é".repeat(24); // 48 bytes
    assert.equal(encodeHeaderValue(text).includes("\r\n"), false);
    assert.equal(encodeHeaderValue(text + "b").split("\r\n ").length, 2);
  });
  it("each later word also allows 45 bytes", () => {
    const text = "é".repeat(24) + "b".repeat(45); // 48 + 45 bytes
    const words = encodeHeaderValue(text).split("\r\n ");
    assert.equal(words.length, 2);
    assert.equal(decodeWords(words.join("\r\n ")), text);
  });
  it("treats a control character as non-printable", () => {
    assert.match(encodeHeaderValue("a\tb"), /^=\?utf-8\?B\?/);
  });
});

describe("formatMailbox / formatDate / base64Lines / mimeParameter", () => {
  it("address only", () => assert.equal(formatMailbox({ address: "a@b.c" }), "a@b.c"));
  it("ASCII name quoted with escapes", () => {
    assert.equal(formatMailbox({ name: 'Ana "la" X', address: "a@b.c" }), '"Ana \\"la\\" X" <a@b.c>');
    assert.equal(formatMailbox({ name: "A\\B", address: "a@b.c" }), '"A\\\\B" <a@b.c>');
  });
  it("the encoded name without offset fits in a single 48-byte word", () => {
    assert.ok(!formatMailbox({ name: "é".repeat(24), address: "a@b.c" }).includes("\r\n"));
  });
  it("name with accents encoded", () => {
    const out = formatMailbox({ name: "Marta Núñez", address: "m@b.c" });
    assert.match(out, /^=\?utf-8\?B\?.+\?= <m@b\.c>$/);
  });
  it("RFC 5322 date with +0000", () => {
    assert.equal(formatDate(new Date("2026-11-17T10:00:00Z")), "Tue, 17 Nov 2026 10:00:00 +0000");
  });
  it("base64 in lines of 76", () => {
    const lines = base64Lines("x".repeat(200)).split("\r\n");
    assert.deepEqual(lines.slice(0, -1).map((l) => l.length), [76, 76, 76]);
    assert.equal(lines[3]!.length, 40);
    assert.equal(base64Lines(""), "");
  });
  it("ASCII parameter quoted, with escapes", () => {
    assert.equal(mimeParameter("name", "a.csv"), 'name="a.csv"');
    assert.equal(mimeParameter("name", 'a"b\\c'), 'name="a\\"b\\\\c"');
  });
  it("non-ASCII parameter with RFC 2231", () => {
    assert.equal(mimeParameter("filename", "résumé 1.txt"), "filename*=UTF-8''r%C3%A9sum%C3%A9%201.txt");
  });
});

describe("buildMessage", () => {
  const spec = {
    from: { name: "Tienda Luna", address: "pedidos@tienda.example" },
    to: [{ address: "juan@nightmail.local" }],
    subject: "Pedido ✔",
    text: "Hola ñandú\n",
    date: new Date("2026-11-17T10:00:00Z"),
  };

  it("has the required headers and a base64 utf-8 body with CRLF", () => {
    const msg = buildMessage(spec);
    const [head, body] = msg.split("\r\n\r\n");
    assert.match(head!, /^Date: Tue, 17 Nov 2026 10:00:00 \+0000\r\n/);
    assert.match(head!, /\r\nMessage-ID: <[0-9a-f-]+@tienda\.example>\r\n/);
    assert.match(head!, /\r\nFrom: "Tienda Luna" <pedidos@tienda\.example>\r\n/);
    assert.match(head!, /\r\nTo: juan@nightmail\.local\r\n/);
    assert.match(head!, /\r\nSubject: =\?utf-8\?B\?/);
    assert.match(head!, /\r\nMIME-Version: 1\.0\r\n/);
    assert.match(head!, /\r\nContent-Type: text\/plain; charset=utf-8\r\n/);
    assert.match(head!, /\r\nContent-Transfer-Encoding: base64$/);
    assert.equal(Buffer.from(body!, "base64").toString("utf8"), "Hola ñandú\r\n");
    assert.ok(!/[^\x00-\x7f]/.test(msg));
  });

  it("respeta Message-ID y dominio indicados y une varios destinatarios", () => {
    const m1 = buildMessage({ ...spec, messageId: "<fijo@x>", to: [{ address: "a@b.c" }, { address: "d@e.f" }] });
    assert.match(m1, /\r\nMessage-ID: <fijo@x>\r\n/);
    assert.match(m1, /\r\nTo: a@b\.c, d@e\.f\r\n/);
    assert.match(buildMessage({ ...spec, domain: "otro.example" }), /Message-ID: <[0-9a-f-]+@otro\.example>/);
  });

  it("uses nightmail.local if the sender has no domain", () => {
    assert.match(buildMessage({ ...spec, from: { address: "root" } }), /Message-ID: <[0-9a-f-]+@nightmail\.local>/);
  });

  it("uses the current date if none is given", () => {
    const { date: _omit, ...rest } = spec;
    assert.match(buildMessage(rest), /^Date: \w{3}, \d{2} \w{3} \d{4} /);
  });

  it("encoding 8bit: UTF-8 as is, with CRLF and without base64", () => {
    const msg = buildMessage({ ...spec, text: "uno\n.dos\nñ", encoding: "8bit" });
    assert.match(msg, /\r\nContent-Transfer-Encoding: 8bit\r\n\r\nuno\r\n\.dos\r\nñ\r\n$/);
  });

  it("multipart/mixed with base64 attachment and folded parameters", () => {
    const msg = buildMessage({
      ...spec,
      attachment: { filename: "datos.csv", contentType: "text/csv", content: Buffer.from("a,b\n1,2\n") },
    });
    const boundary = /Content-Type: multipart\/mixed;\r\n boundary="([^"]+)"/.exec(msg)?.[1];
    assert.ok(boundary);
    const [head, ...rest] = msg.split("\r\n\r\n");
    assert.ok(!head!.includes("Content-Transfer-Encoding"));
    const body = rest.join("\r\n\r\n");
    assert.ok(body.startsWith(`--${boundary}\r\nContent-Type: text/plain; charset=utf-8`));
    assert.ok(body.includes(`\r\n--${boundary}\r\nContent-Type: text/csv;\r\n name="datos.csv"`));
    assert.ok(body.includes('Content-Disposition: attachment;\r\n filename="datos.csv"'));
    assert.ok(body.includes(Buffer.from("a,b\n1,2\n").toString("base64")));
    assert.ok(body.trimEnd().endsWith(`--${boundary}--`));
  });

  it("non-ASCII attachment names with RFC 2231", () => {
    const msg = buildMessage({
      ...spec,
      attachment: { filename: "résumé.txt", contentType: "text/plain", content: Buffer.from("x") },
    });
    assert.match(msg, /filename\*=UTF-8''r%C3%A9sum%C3%A9\.txt/);
    assert.match(msg, /name\*=UTF-8''r%C3%A9sum%C3%A9\.txt/);
    assert.ok(!/[^\x00-\x7f]/.test(msg));
  });
});
