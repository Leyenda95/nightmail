// HTML emails: nested MIME parts, PNG, and the html, bomb and images templates.
// Messages are checked with a real MIME parser (mailparser), the way a mail client would read them.
import assert from "node:assert/strict";
import { crc32, inflateSync } from "node:zlib";
import { describe, it } from "node:test";
import { simpleParser } from "mailparser";
// The viewer's caps, taken from its own code: if they change, this test flags that the templates no longer exercise them.
import { MAX_IMAGES, MAX_PIXELS, MAX_SIDE, MAX_TOTAL_PIXELS } from "../../../apps/desktop/src/images.ts";
import { buildMessage } from "../src/message.ts";
import { encodePng } from "../src/png.ts";
import { TEMPLATES } from "../src/templates.ts";

const PIXEL = encodePng(1, 1, { bitDepth: 8, colorType: 2 }, Buffer.from([0, 255, 0, 0]));
const spec = {
  from: { name: "Tienda Luna", address: "pedidos@tienda.example" },
  to: [{ address: "juan@nightmail.local" }],
  subject: "Pedido",
  text: "Texto ñ\n",
  html: '<p>HTML ñ <img src="cid:logo@tienda.example"></p>',
  date: new Date("2026-11-17T10:00:00Z"),
};
const logo = { cid: "logo@tienda.example", filename: "logo.png", contentType: "image/png", content: PIXEL };
const parse = (msg: string) => simpleParser(msg, { keepCidLinks: true });

/** Width and height declared in a PNG's IHDR header. */
const pngSize = (png: Uint8Array) => {
  const b = Buffer.from(png);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
};

/** The PNG's rows (inflated IDAT; the PNGs here have a single IDAT after the IHDR). */
const pngRows = (png: Uint8Array) => {
  const b = Buffer.from(png);
  assert.equal(b.subarray(37, 41).toString("latin1"), "IDAT");
  return inflateSync(b.subarray(41, 41 + b.readUInt32BE(33)));
};

describe("encodePng", () => {
  it("writes signature, IHDR with the size, IDAT that inflates to the given rows, IEND and valid CRCs", () => {
    const raw = Buffer.from([0, 1, 2, 3, 4, 5, 6, 0, 7, 8, 9, 10, 11, 12]); // 2×2 RGB, filter 0 on each row
    const png = Buffer.from(encodePng(2, 2, { bitDepth: 8, colorType: 2 }, raw));
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.deepEqual(pngSize(png), { width: 2, height: 2 });
    const chunks: string[] = [];
    for (let at = 8; at < png.length; ) {
      const len = png.readUInt32BE(at);
      const type = png.subarray(at + 4, at + 8).toString("latin1");
      const data = png.subarray(at + 8, at + 8 + len);
      assert.equal(png.readUInt32BE(at + 8 + len), crc32(png.subarray(at + 4, at + 8 + len)), type);
      if (type === "IHDR") assert.deepEqual([...data.subarray(8)], [8, 2, 0, 0, 0]);
      if (type === "IDAT") assert.deepEqual(inflateSync(data), raw);
      chunks.push(type);
      at += 12 + len;
    }
    assert.deepEqual(chunks, ["IHDR", "IDAT", "IEND"]);
  });
});

describe("buildMessage con HTML", () => {
  it("text and HTML as alternatives; the inline image goes with the HTML and its Content-ID", async () => {
    const msg = buildMessage({ ...spec, inline: [logo] });
    assert.match(msg, /\r\nContent-Type: multipart\/alternative;\r\n boundary="/);
    // RFC 2387: multipart/related carries `type` with its root part's type (the HTML).
    assert.match(msg, /\r\nContent-Type: multipart\/related; type="text\/html";\r\n boundary="/);
    const mail = await parse(msg);
    assert.equal(mail.text, "Texto ñ\n");
    assert.equal(mail.html, spec.html);
    assert.equal(mail.attachments.length, 1);
    const [img] = mail.attachments;
    assert.equal(img!.cid, "logo@tienda.example");
    assert.equal(img!.contentType, "image/png");
    assert.equal(img!.contentDisposition, "inline");
    assert.deepEqual(img!.content, Buffer.from(PIXEL));
    for (const line of msg.split("\r\n")) assert.ok(line.length <= 998);
    assert.equal(Buffer.byteLength(msg), msg.length, "todo ASCII");
  });

  it("without inline images there is no multipart/related", async () => {
    const msg = buildMessage(spec);
    assert.doesNotMatch(msg, /multipart\/related/);
    assert.equal((await parse(msg)).html, spec.html);
  });

  it("with attachment: multipart/mixed with the alternatives inside and the attachment apart", async () => {
    const attachment = { filename: "a.csv", contentType: "text/csv", content: Buffer.from("a,b\n") };
    const msg = buildMessage({ ...spec, inline: [logo], attachment });
    assert.match(msg, /^Content-Type: multipart\/mixed;/m);
    const mail = await parse(msg);
    assert.equal(mail.html, spec.html);
    assert.deepEqual(
      mail.attachments.map((a) => [a.filename, a.contentDisposition]),
      [["logo.png", "inline"], ["a.csv", "attachment"]],
    );
  });
});

const ctx = { to: { address: "juan.perez@nightmail.local" }, index: 0, now: new Date("2026-11-17T10:00:00Z"), sizeKb: 8 };

/** The `cid:` references used by the HTML and the ones the message carries. */
async function cids(name: string) {
  const mail = await parse(buildMessage(TEMPLATES[name]!(ctx)));
  const used = [...String(mail.html).matchAll(/src="cid:([^"]+)"/g)].map((m) => m[1]);
  return { mail, used, sent: mail.attachments.map((a) => a.cid) };
}

describe("plantillas HTML", () => {
  it("html: shop email with a text version, links and the inline logo the HTML uses", async () => {
    const { mail, used, sent } = await cids("html");
    assert.match(String(mail.text), /Tienda Luna/);
    assert.match(String(mail.html), /<a href="https:\/\/tiendaluna\.example\//);
    assert.deepEqual(used, sent);
    assert.equal(sent.length, 1);
  });

  /** A genuinely valid bomb (not a broken header): 1-bit grayscale, a few KB, all rows present and black. */
  const assertBomb = (png: Uint8Array, side: number) => {
    assert.deepEqual(pngSize(png), { width: side, height: side });
    assert.ok(png.length < 64 * 1024, `${png.length} bytes`);
    assert.deepEqual([...png.subarray(24, 29)], [1, 0, 0, 0, 0]);
    const rows = pngRows(png);
    assert.equal(rows.length, side * (1 + Math.ceil(side / 8)));
    assert.ok(rows.every((b) => b === 0));
  };

  it("bomb: in a single email, one image per reader cap, hidden in small boxes; and one that does fit", async () => {
    const { mail, used, sent } = await cids("bomb");
    assert.deepEqual(used, sent);
    const html = String(mail.html);
    const byCid = (cid: string) => mail.attachments.find((a) => a.cid === cid)!.content;

    // 1. Via `cid:`, a side larger than the per-side cap.
    const bomb = byCid("bomba@pruebas.example");
    assertBomb(bomb, 16384);
    assert.ok(16384 > MAX_SIDE);
    assert.match(html, /<img src="cid:bomba@pruebas\.example" width="64" height="64"/);

    // 2. The same image as a `data:` URI inside the HTML.
    const data = /<img src="data:image\/png;base64,([^"]+)" width="64" height="64"/.exec(html);
    assert.ok(data, "missing data: bomb");
    assert.deepEqual(Buffer.from(data[1]!, "base64"), bomb);

    // 3. Via `cid:`, each side within the cap but more pixels than the per-image cap.
    assertBomb(byCid("bomba-8000@pruebas.example"), 8000);
    assert.ok(8000 <= MAX_SIDE && 8000 * 8000 > MAX_PIXELS);
    assert.match(html, /<img src="cid:bomba-8000@pruebas\.example" width="64" height="64"/);

    // The one that must render: within every cap.
    const green = pngSize(byCid("verde@pruebas.example"));
    assert.deepEqual(green, { width: 20, height: 20 });
    assert.equal(sent.length, 3);
    assert.ok(sent.length <= MAX_IMAGES);
  });

  it("images: 24 distinct medium images (1280 × 960), more than the 20 the app delivers", async () => {
    const { mail, used, sent } = await cids("images");
    assert.equal(sent.length, 24);
    assert.ok(sent.length > MAX_IMAGES);
    // Not covered (see README): the rendered images stay below the per-message pixel budget.
    assert.ok(MAX_IMAGES * 1280 * 960 < MAX_TOTAL_PIXELS);
    assert.deepEqual(used, sent);
    const colors = new Set<string>();
    for (const a of mail.attachments) {
      assert.deepEqual(pngSize(a.content), { width: 1280, height: 960 });
      // Single color: all rows equal, filter byte 0 and the same pixel repeated.
      const rows = pngRows(a.content);
      const stride = 1 + 1280 * 3;
      assert.equal(rows.length, 960 * stride);
      const row = rows.subarray(0, stride);
      assert.equal(row[0], 0);
      assert.deepEqual(row.subarray(1), Buffer.alloc(1280 * 3).fill(row.subarray(1, 4)));
      for (let y = 1; y < 960; y++) assert.ok(rows.subarray(y * stride, (y + 1) * stride).equals(row), `fila ${y}`);
      colors.add(row.subarray(1, 4).toString("hex"));
    }
    assert.equal(colors.size, 24);
  });
});
