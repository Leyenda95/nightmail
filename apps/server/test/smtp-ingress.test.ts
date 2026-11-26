import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { envelopeLengthFor, MAX_PLAINTEXT_LENGTH, openMailbox } from '@nightmail/core-ts';
import { sendMail, SmtpError } from '../../../tools/demo-mailer/src/smtp-client.ts';
import { silentLogger } from '../src/log.ts';
import { createSmtpServer, DEFAULT_INGRESS_LIMITS, localPartOf } from '../src/smtp/ingress.ts';
import { alias, LOW_ORDER_AUTH_PK, LOW_ORDER_ENC_PK, mailbox, type TestAddress } from './mail-fixtures.ts';
import { deliverRaw, DOMAIN, SmtpDialog, startIngress, type TestIngress, type TestIngressOptions } from './smtp-helpers.ts';

const open: TestIngress[] = [];
afterEach(async () => {
  for (const ingress of open.splice(0)) await ingress.close();
});
async function ingressWith(options: TestIngressOptions = {}): Promise<TestIngress> {
  const ingress = await startIngress(options);
  open.push(ingress);
  return ingress;
}

const at = (address: TestAddress) => `${address.localPart}@${DOMAIN}`;

/** A mailbox's messages, opened with its key. */
function inbox(ingress: TestIngress, address: TestAddress): string[] {
  return ingress.store.list(address.addrKey, 0, 100).messages
    .map((m) => Buffer.from(openMailbox(address.encSecretKey, ingress.store.get(address.addrKey, m.id)!)).toString('latin1'));
}

const NO_SUCH = '550 5.1.1 No such mailbox here';

test('a mail for a registered mailbox and alias is stored sealed for each of them', async () => {
  const juan = mailbox('juan.perez');
  const nube = alias();
  const ingress = await ingressWith({ addresses: [juan, nube] });
  const result = await sendMail({
    host: '127.0.0.1', port: ingress.port, from: 'tienda@ejemplo.test', to: [at(juan), at(nube)],
    data: 'Subject: hola\n\nPrimera línea\n.una que empieza por punto\n',
  });
  assert.deepEqual(result, { accepted: [at(juan), at(nube)], rejected: [], delivered: true });
  const expected = 'Subject: hola\r\n\r\nPrimera línea\r\n.una que empieza por punto\r\n';
  assert.deepEqual(inbox(ingress, juan).map((m) => Buffer.from(m, 'latin1').toString('utf8')), [expected]);
  assert.deepEqual(inbox(ingress, nube).map((m) => Buffer.from(m, 'latin1').toString('utf8')), [expected]);
  const [forJuan] = ingress.store.list(juan.addrKey, 0, 10).messages;
  const [forNube] = ingress.store.list(nube.addrKey, 0, 10).messages;
  assert.equal(forJuan!.size, 4096);
  assert.notDeepEqual(ingress.store.get(juan.addrKey, forJuan!.id), ingress.store.get(nube.addrKey, forNube!.id), 'a different envelope for each one');
  assert.throws(() => openMailbox(nube.encSecretKey, ingress.store.get(juan.addrKey, forJuan!.id)!), 'each envelope opens only for its owner');
});

test('8-bit content arrives byte for byte, without announcing or requiring BODY=8BITMIME', async () => {
  const juan = mailbox('juan.perez');
  const ingress = await ingressWith({ addresses: [juan] });
  const body = Buffer.from([0x00, 0x7f, 0x80, 0xff, 0xc3, 0xb1, 0x0d, 0x0a, 0x2e, 0x2e, 0x78]); // "..x": escaped dot
  const { final } = await deliverRaw(ingress.port, [at(juan)], body);
  assert.match(final, /^250 2\.6\.0 /);
  const expected = Buffer.concat([body.subarray(0, 8), body.subarray(9), Buffer.from('\r\n')]);
  assert.deepEqual(Buffer.from(inbox(ingress, juan)[0]!, 'latin1'), expected);
});

test('RCPT TO: the same 550 for nonexistent, reserved, alias shape, bad key and another domain', async () => {
  const juan = mailbox('juan.perez');
  const nube = alias();
  const badEnc = mailbox('cifrado.malo', { encPk: LOW_ORDER_ENC_PK });
  const badAuth = mailbox('firma.mala', { authPk: LOW_ORDER_AUTH_PK });
  const ingress = await ingressWith({ addresses: [juan, nube, badEnc, badAuth], limits: { unknownRecipients: { limit: 100, windowMs: 60_000 } } });
  const { dialog } = await SmtpDialog.open(ingress.port);
  await dialog.send('MAIL FROM:<a@ejemplo.test>');
  const rejected = [
    `nadie@${DOMAIN}`,
    `postmaster@${DOMAIN}`,
    `admin@${DOMAIN}`,
    `otra.cosa.${nube.localPart.slice(-12)}@${DOMAIN}`, // a real alias's suffix with other words
    `x${nube.localPart}@${DOMAIN}`,
    at(badEnc),
    at(badAuth),
    'juan.perez@otro.dominio',
    `juan.perez@sub.${DOMAIN}`,
    `juan.perez@${DOMAIN}.evil`,
    `"juan.perez"@${DOMAIN}`,
    `juan.perez+etiqueta@${DOMAIN}`,
  ];
  for (const address of rejected) assert.equal(await dialog.send(`RCPT TO:<${address}>`), NO_SUCH, address);
  for (const address of [at(juan), at(nube), `JUAN.Perez@NightMail.LOCAL`, at(nube).toUpperCase()]) {
    assert.equal(await dialog.send(`RCPT TO:<${address}>`), '250 2.1.5 Accepted', address);
  }
  await dialog.quit();
});

test('localPartOf: only addresses of our domain, with a local part', () => {
  assert.equal(localPartOf('juan@nightmail.local', DOMAIN), 'juan');
  assert.equal(localPartOf('j@nightmail.local', DOMAIN), 'j', 'a single-character local part is valid');
  assert.equal(localPartOf('Juan@NIGHTMAIL.Local', DOMAIN), 'Juan');
  assert.equal(localPartOf('a@b@nightmail.local', DOMAIN), 'a@b', 'it splits at the last at sign');
  assert.equal(localPartOf('@nightmail.local', DOMAIN), undefined);
  assert.equal(localPartOf('nightmail.local', DOMAIN), undefined);
  assert.equal(localPartOf('juan@', DOMAIN), undefined);
  assert.equal(localPartOf('juan@otro.local', DOMAIN), undefined);
});

test('anti-probing limit: after N unknown recipients, that IP gets 451 for everything, existing or not', async () => {
  const juan = mailbox('juan.perez');
  const ingress = await ingressWith({ addresses: [juan], limits: { unknownRecipients: { limit: 3, windowMs: 60_000 } } });
  const { dialog } = await SmtpDialog.open(ingress.port);
  await dialog.send('MAIL FROM:<a@ejemplo.test>');
  for (let i = 0; i < 5; i++) assert.equal(await dialog.send(`RCPT TO:<${at(juan)}>`), '250 2.1.5 Accepted', 'hits do not count');
  for (let i = 0; i < 3; i++) assert.equal(await dialog.send(`RCPT TO:<nadie${i}@${DOMAIN}>`), NO_SUCH);
  const limited = '451 4.3.0 Too many unknown recipients, try again later';
  assert.equal(await dialog.send(`RCPT TO:<nadie9@${DOMAIN}>`), limited);
  assert.equal(await dialog.send(`RCPT TO:<${at(juan)}>`), limited, 'an existing address gets the same: no oracle');
  await dialog.quit();

  const second = await SmtpDialog.open(ingress.port); // another connection from the same IP: still limited
  await second.dialog.send('MAIL FROM:<a@ejemplo.test>');
  assert.equal(await second.dialog.send(`RCPT TO:<${at(juan)}>`), limited);
  ingress.clock.now += 59_999;
  assert.equal(await second.dialog.send(`RCPT TO:<${at(juan)}>`), limited, 'until the window ends');
  ingress.clock.now += 1;
  assert.equal(await second.dialog.send(`RCPT TO:<${at(juan)}>`), '250 2.1.5 Accepted');
  assert.equal(await second.dialog.send(`RCPT TO:<nadie@${DOMAIN}>`), NO_SUCH);
  await second.dialog.quit();
});

test('size limit counting bytes: the exact maximum gets in and one more byte is rejected, without announcing SIZE in MAIL', async () => {
  const juan = mailbox('juan.perez');
  const ingress = await ingressWith({ addresses: [juan], limits: { maxMessageBytes: 10_000 } });
  const exact = 'x'.repeat(10_000 - 2); // the server also counts the last line's trailing CRLF
  assert.match((await deliverRaw(ingress.port, [at(juan)], exact)).final, /^250 /);
  const over = await deliverRaw(ingress.port, [at(juan)], `${exact}y`);
  assert.match(over.final, /^552 5\.3\.4 /);
  const far = await deliverRaw(ingress.port, [at(juan)], 'z'.repeat(200_000));
  assert.match(far.final, /^552 5\.3\.4 /);
  assert.deepEqual(inbox(ingress, juan).map((m) => m.length), [10_000], 'only the one that fit was stored');
});

test('the SIZE announced in EHLO is the limit and a MAIL FROM declaring more is rejected before DATA', async () => {
  const ingress = await ingressWith({ limits: { maxMessageBytes: 10_000 } });
  const { dialog, ehlo } = await SmtpDialog.open(ingress.port);
  assert.match(ehlo, /^250[- ]SIZE 10000$/m);
  assert.match(await dialog.send('MAIL FROM:<a@ejemplo.test> SIZE=10001'), /^552 /);
  assert.match(await dialog.send('MAIL FROM:<a@ejemplo.test> SIZE=10000'), /^250 /);
  await dialog.quit();
});

test('defaults: 25 MiB, and neither AUTH nor STARTTLS is offered', async () => {
  assert.equal(DEFAULT_INGRESS_LIMITS.maxMessageBytes, 25 * 1024 * 1024);
  const ingress = await ingressWith();
  const { dialog, greeting, ehlo } = await SmtpDialog.open(ingress.port);
  assert.match(greeting, /^220 nightmail\.local ESMTP NightMail/);
  assert.match(ehlo, /^250[- ]SIZE 26214400$/m);
  assert.match(ehlo, /^250[- ]ENHANCEDSTATUSCODES$/m);
  assert.doesNotMatch(ehlo, /AUTH|STARTTLS/);
  assert.match(await dialog.send('AUTH PLAIN AGEAYg=='), /^5\d\d /);
  assert.match(await dialog.send('STARTTLS'), /^5\d\d /);
  await dialog.quit();
});

test('simultaneous large messages: with no free slot it answers 451 and small ones keep coming in', async () => {
  const juan = mailbox('juan.perez');
  const ingress = await ingressWith({ addresses: [juan], limits: { largeMessageBytes: 1000, largeMessageSlots: 1 } });
  const big = 'g'.repeat(5000);

  // A client starts a large message and stalls halfway, taking the only slot.
  const stalled = await SmtpDialog.open(ingress.port);
  await stalled.dialog.send('MAIL FROM:<a@ejemplo.test>');
  await stalled.dialog.send(`RCPT TO:<${at(juan)}>`);
  await stalled.dialog.send('DATA');
  stalled.dialog.write('h'.repeat(2000));
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal((await deliverRaw(ingress.port, [at(juan)], big)).final, '451 4.3.0 Server busy, try again later');
  assert.match((await deliverRaw(ingress.port, [at(juan)], 'chico')).final, /^250 /, 'a small one does not need a slot');
  assert.match((await deliverRaw(ingress.port, [at(juan)], 'p'.repeat(998))).final, /^250 /, 'right at the threshold (1000 bytes with its CRLF) neither');
  assert.equal((await deliverRaw(ingress.port, [at(juan)], 'p'.repeat(999))).final, '451 4.3.0 Server busy, try again later', 'one byte more does');

  await stalled.dialog.drop(); // dropping the connection frees the slot
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.match((await deliverRaw(ingress.port, [at(juan)], big)).final, /^250 /);
  assert.match((await deliverRaw(ingress.port, [at(juan)], big)).final, /^250 /, 'and after a normal delivery it is free too');
  assert.deepEqual(inbox(ingress, juan).map((m) => m.length), [7, 1000, 5002, 5002], 'nothing of the half-sent message was stored');
});

test('a message that is too large releases its slot as soon as it exceeds the maximum', async () => {
  const juan = mailbox('juan.perez');
  const ingress = await ingressWith({ addresses: [juan], limits: { largeMessageBytes: 1000, largeMessageSlots: 1, maxMessageBytes: 3000 } });
  const stalled = await SmtpDialog.open(ingress.port);
  await stalled.dialog.send('MAIL FROM:<a@ejemplo.test>');
  await stalled.dialog.send(`RCPT TO:<${at(juan)}>`);
  await stalled.dialog.send('DATA');
  stalled.dialog.write('h'.repeat(4000)); // exceeds the maximum and still does not finish
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.match((await deliverRaw(ingress.port, [at(juan)], 'g'.repeat(2000))).final, /^250 /, 'the slot is already free');
  assert.match(await stalled.dialog.send('\r\n.'), /^552 5\.3\.4 /);
  await stalled.dialog.quit();
});

test('a slot is released only once even if the message is rejected and then finishes: no extra slots appear', async () => {
  const juan = mailbox('juan.perez');
  const ingress = await ingressWith({ addresses: [juan], limits: { largeMessageBytes: 1000, largeMessageSlots: 1, maxMessageBytes: 3000 } });
  assert.match((await deliverRaw(ingress.port, [at(juan)], 'h'.repeat(4000))).final, /^552 5\.3\.4 /);
  assert.match((await deliverRaw(ingress.port, [at(juan)], 'g'.repeat(2000))).final, /^250 /);

  const stalled = await SmtpDialog.open(ingress.port); // takes the only slot
  await stalled.dialog.send('MAIL FROM:<a@ejemplo.test>');
  await stalled.dialog.send(`RCPT TO:<${at(juan)}>`);
  await stalled.dialog.send('DATA');
  stalled.dialog.write('h'.repeat(2000));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await deliverRaw(ingress.port, [at(juan)], 'g'.repeat(2000))).final, '451 4.3.0 Server busy, try again later');
  await stalled.dialog.drop();
});

test('box quota by envelope size: when full it answers 552 at RCPT, if this message does not fit, 552 at the end and nothing is stored for anyone', async () => {
  const juan = mailbox('juan.perez');
  const ana = mailbox('ana.garcia');
  const small = envelopeLengthFor(0);
  const ingress = await ingressWith({ addresses: [juan, ana], store: { quotaBytes: 2 * small } });
  // A 9000-byte message needs the 16 KiB tier, which does not fit in a quota of two small envelopes.
  const tooBigForQuota = await deliverRaw(ingress.port, [at(juan), at(ana)], 'q'.repeat(9000));
  assert.deepEqual(tooBigForQuota.rcpt, ['250 2.1.5 Accepted', '250 2.1.5 Accepted']);
  assert.equal(tooBigForQuota.final, '552 5.2.2 Mailbox full');
  assert.equal(ingress.store.usedBytes(juan.addrKey), 0);
  assert.equal(ingress.store.usedBytes(ana.addrKey), 0);

  for (let i = 0; i < 2; i++) assert.match((await deliverRaw(ingress.port, [at(juan)], 'hola')).final, /^250 /);
  assert.equal(ingress.store.usedBytes(juan.addrKey), 2 * small, 'counts the whole envelope, not the 6 bytes of the message');
  const full = await deliverRaw(ingress.port, [at(juan), at(ana)], 'hola');
  assert.deepEqual(full.rcpt, ['552 5.2.2 Mailbox full', '250 2.1.5 Accepted'], 'the full one is rejected per recipient');
  assert.match(full.final, /^250 /);
  assert.equal(inbox(ingress, ana).length, 1);
  assert.equal(inbox(ingress, juan).length, 2);
});

test('the same address written two ways receives the message only once', async () => {
  const juan = mailbox('juan.perez');
  const ingress = await ingressWith({ addresses: [juan] });
  const { dialog } = await SmtpDialog.open(ingress.port);
  await dialog.send('MAIL FROM:<a@ejemplo.test>');
  await dialog.send(`RCPT TO:<${at(juan)}>`);
  await dialog.send(`RCPT TO:<Juan.Perez@${DOMAIN}>`);
  await dialog.send(`RCPT TO:<JUAN.PEREZ@NIGHTMAIL.LOCAL>`);
  await dialog.send('DATA');
  dialog.write('una vez');
  assert.match(await dialog.send('\r\n.'), /^250 /);
  await dialog.quit();
  assert.equal(inbox(ingress, juan).length, 1);
});

test('at most maxRecipients recipients per message', async () => {
  const people = ['uno', 'dos', 'tres'].map((n) => mailbox(n));
  const ingress = await ingressWith({ addresses: people, limits: { maxRecipients: 2 } });
  const { rcpt, final } = await deliverRaw(ingress.port, people.map(at), 'hola');
  assert.deepEqual(rcpt.map((r) => r.slice(0, 3)), ['250', '250', '452']);
  assert.match(final, /^250 /);
  assert.deepEqual(people.map((p) => inbox(ingress, p).length), [1, 1, 0]);
});

test('if the connection drops halfway through DATA nothing is stored and the server keeps going', async () => {
  const juan = mailbox('juan.perez');
  const ingress = await ingressWith({ addresses: [juan] });
  const { dialog } = await SmtpDialog.open(ingress.port);
  await dialog.send('MAIL FROM:<a@ejemplo.test>');
  await dialog.send(`RCPT TO:<${at(juan)}>`);
  await dialog.send('DATA');
  dialog.write('mensaje a medias');
  await dialog.drop();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(inbox(ingress, juan).length, 0);
  assert.match((await deliverRaw(ingress.port, [at(juan)], 'otro')).final, /^250 /);
});

test('if storing fails, it answers 451 (not 250) and the detail does not leak over SMTP', async () => {
  const juan = mailbox('juan.perez');
  const ingress = await ingressWith({
    addresses: [juan],
    override: (deps) => ({ ...deps, store: { hasRoomFor: () => true, deliver: () => { throw new Error('disk on fire: /secreto'); } } }),
  });
  const { final } = await deliverRaw(ingress.port, [at(juan)], 'hola');
  assert.equal(final, '451 4.3.0 Local error, try again later');
  assert.ok(ingress.logs.some((l) => l === 'warn smtp: delivery failed (Error)'));
  assert.ok(!ingress.logs.join('\n').includes('secreto'));
});

test('if an accepted recipient stops resolving before DATA, nothing is delivered to anyone (451)', async () => {
  const juan = mailbox('juan.perez');
  const ana = mailbox('ana.garcia');
  let lookups = 0;
  const ingress = await ingressWith({
    addresses: [juan, ana],
    override: (deps) => ({
      ...deps,
      directory: { recipient: (localPart) => (++lookups > 2 && localPart === 'ana.garcia' ? undefined : deps.directory.recipient(localPart)) },
    }),
  });
  const { rcpt, final } = await deliverRaw(ingress.port, [at(juan), at(ana)], 'hola');
  assert.deepEqual(rcpt.map((r) => r.slice(0, 3)), ['250', '250']);
  assert.equal(final, '451 4.3.0 Local error, try again later');
  assert.equal(inbox(ingress, juan).length, 0);
});

test('the plaintext message and the addresses reach neither the disk nor the logs', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nightmail-smtp-'));
  try {
    const juan = mailbox('juan.perez');
    const ingress = await ingressWith({ addresses: [juan], databaseFile: path.join(dir, 'mail.sqlite') });
    const marker = 'MARCA-SECRETA-0123456789';
    const result = await sendMail({
      host: '127.0.0.1', port: ingress.port, from: 'remitente.secreto@ejemplo.test', to: [at(juan), `nadie@${DOMAIN}`],
      data: `Subject: ${marker}\n\n${marker} ${'relleno '.repeat(200)}\n`,
    });
    assert.equal(result.delivered, true);
    assert.equal(inbox(ingress, juan).length, 1);
    assert.ok(inbox(ingress, juan)[0]!.includes(marker), 'the owner can read it');
    ingress.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const files = readdirSync(dir);
    assert.ok(files.includes('mail.sqlite'));
    for (const file of files) {
      const bytes = readFileSync(path.join(dir, file));
      for (const secret of [marker, 'remitente.secreto', 'juan.perez']) {
        assert.equal(bytes.includes(secret), false, `${secret} is in ${file}`);
      }
    }
    const logs = ingress.logs.join('\n');
    assert.deepEqual(ingress.logs, ['debug smtp: message stored in 1 mailbox(es)']);
    for (const secret of [marker, 'remitente', 'juan', 'nadie']) assert.equal(logs.includes(secret), false, secret);
  } finally {
    await Promise.all(open.splice(0).map((i) => i.close()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the demo-mailer sendMail sees per-recipient rejections and the final error as SmtpError', async () => {
  const juan = mailbox('juan.perez');
  const ingress = await ingressWith({ addresses: [juan], limits: { maxMessageBytes: 100 } });
  const partial = await sendMail({ host: '127.0.0.1', port: ingress.port, from: 'a@ejemplo.test', to: [`nadie@${DOMAIN}`, at(juan)], data: 'hola\n' });
  assert.deepEqual(partial.rejected, [{ address: `nadie@${DOMAIN}`, code: 550, text: '5.1.1 No such mailbox here' }]);
  assert.deepEqual(partial.accepted, [at(juan)]);
  const none = await sendMail({ host: '127.0.0.1', port: ingress.port, from: 'a@ejemplo.test', to: [`nadie@${DOMAIN}`], data: 'hola\n' });
  assert.equal(none.delivered, false);
  await assert.rejects(
    sendMail({ host: '127.0.0.1', port: ingress.port, from: 'a@ejemplo.test', to: [at(juan)], data: `${'x'.repeat(200)}\n` }),
    (e: Error) => e instanceof SmtpError && e.code === 552,
  );
});

test('rejects a message maximum that does not fit in an envelope, the largest that fits is accepted', async () => {
  await assert.rejects(startIngress({ limits: { maxMessageBytes: 32 * 1024 * 1024 } }), RangeError);
  await assert.rejects(startIngress({ limits: { maxMessageBytes: MAX_PLAINTEXT_LENGTH + 1 } }), RangeError);
  await ingressWith({ limits: { maxMessageBytes: MAX_PLAINTEXT_LENGTH } });
});

test('the stored received date is the server time rounded to the minute', async () => {
  const juan = mailbox('juan.perez');
  const ingress = await ingressWith({ addresses: [juan] });
  const minute = Math.floor(ingress.clock.now / 60_000) * 60;
  ingress.clock.now = (minute + 60 + 5) * 1000 + 999; // 5.999 s past the next minute
  assert.match((await deliverRaw(ingress.port, [at(juan)], 'hola')).final, /^250 /);
  assert.deepEqual(ingress.store.list(juan.addrKey, 0, 10).messages.map((m) => m.receivedAt), [minute + 60]);
});

test('the plaintext message is wiped from memory once sealed', async (t) => {
  const juan = mailbox('juan.perez');
  const ingress = await ingressWith({ addresses: [juan] });
  const concat = t.mock.method(Buffer, 'concat');
  const body = 'texto en claro'; // 14 bytes + trailing CRLF = 16 bytes
  assert.match((await deliverRaw(ingress.port, [at(juan)], body)).final, /^250 /);
  concat.mock.restore();
  const message = concat.mock.calls.map((call) => call.result as Buffer).filter((b) => b.length === body.length + 2);
  assert.ok(message.some((b) => b.every((byte) => byte === 0)), 'the message buffer is zeroed');
  assert.equal(inbox(ingress, juan)[0], `${body}\r\n`, 'and what was stored is the message, not the zeros');
});

test('no reverse IP lookup (it would leak the connection to a DNS) and no built-in smtp-server logging', () => {
  const server = createSmtpServer({
    domain: DOMAIN, directory: { recipient: () => undefined }, store: { deliver: () => {}, hasRoomFor: () => true }, log: silentLogger,
  });
  assert.equal(server.options.disableReverseLookup, true);
  assert.equal(server.options.logger, false);
});

test('with an unhealthy sync, an unknown address gets 451 (retry), not the final 550, known ones keep coming in', async () => {
  const juan = mailbox('juan.perez');
  let healthy = false;
  const ingress = await ingressWith({ addresses: [juan], override: (deps) => ({ ...deps, directoryHealthy: () => healthy }) });
  const { dialog } = await SmtpDialog.open(ingress.port);
  await dialog.send('MAIL FROM:<a@ejemplo.test>');
  assert.equal(await dialog.send(`RCPT TO:<recien.creada@${DOMAIN}>`), '451 4.3.0 Recipient not verifiable now, try again later');
  assert.equal(await dialog.send(`RCPT TO:<${at(juan)}>`), '250 2.1.5 Accepted');
  healthy = true;
  assert.equal(await dialog.send(`RCPT TO:<recien.creada@${DOMAIN}>`), NO_SUCH);
  await dialog.quit();
});
