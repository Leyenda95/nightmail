import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { envelopeLengthFor } from '@nightmail/core-ts';
import { MEMORY, openDatabase } from '../src/storage/db.ts';
import {
  DEFAULT_MAILBOX_QUOTA_BYTES, MailboxStore, QuotaExceeded, RECEIVED_AT_GRANULARITY_SECONDS,
} from '../src/mailbox/store.ts';

const SMALL = envelopeLengthFor(10); // 62 + 4096
const key = (byte: number) => new Uint8Array(32).fill(byte);
const envelope = (length = SMALL, fill = 1) => new Uint8Array(length).fill(fill);
const NOW = 1_794_873_600; // multiple of 3600

function storeWith(options: { quotaBytes?: number; ids?: Uint8Array[] } = {}) {
  let n = 0;
  const randomId = options.ids ? () => options.ids![n++]! : undefined;
  return new MailboxStore(openDatabase(MEMORY), {
    ...(options.quotaBytes !== undefined && { quotaBytes: options.quotaBytes }), ...(randomId && { randomId }),
  });
}

test('stores the envelope as is and returns it only to its box', () => {
  const store = storeWith();
  const sealed = envelope(SMALL, 7);
  store.deliver([{ addrKey: key(1), envelope: sealed }], NOW);
  const [message] = store.list(key(1), 0, 10).messages;
  assert.ok(message);
  assert.deepEqual(store.get(key(1), message.id), sealed);
  assert.equal(store.get(key(2), message.id), undefined, 'the id from another box does not work');
  assert.equal(store.get(key(1), 'ff'.repeat(16)), undefined);
  assert.deepEqual(store.list(key(2), 0, 10), { messages: [], next: 0 });
});

test('envelopeSize: the envelope length without reading it, only in its box', () => {
  const store = storeWith();
  store.deliver([{ addrKey: key(1), envelope: envelope(SMALL) }], NOW);
  const [message] = store.list(key(1), 0, 10).messages;
  assert.equal(store.envelopeSize(key(1), message!.id), SMALL);
  assert.equal(store.envelopeSize(key(2), message!.id), undefined);
  assert.equal(store.envelopeSize(key(1), 'ff'.repeat(16)), undefined);
  assert.equal(store.envelopeSize(key(1), 'no-es-hex'), undefined);
});

test('the list gives a random 16-byte id, bucketed size and rounded date, never the envelope', () => {
  const store = storeWith();
  store.deliver([{ addrKey: key(1), envelope: envelope(envelopeLengthFor(5000)) }], NOW + 3599);
  const { messages, next } = store.list(key(1), 0, 10);
  assert.equal(next, 1);
  assert.equal(messages.length, 1);
  assert.deepEqual(Object.keys(messages[0]!).sort(), ['id', 'receivedAt', 'size']);
  assert.match(messages[0]!.id, /^[0-9a-f]{32}$/);
  assert.equal(messages[0]!.size, 8192, 'the bucket, not the envelope length');
  assert.equal(messages[0]!.receivedAt, NOW, 'rounded down to the hour');
  assert.equal(RECEIVED_AT_GRANULARITY_SECONDS, 3600);
});

test('a date on an exact hour does not change and one second earlier falls in the previous hour', () => {
  const store = storeWith();
  store.deliver([{ addrKey: key(1), envelope: envelope() }], NOW);
  store.deliver([{ addrKey: key(1), envelope: envelope() }], NOW - 1);
  assert.deepEqual(store.list(key(1), 0, 10).messages.map((m) => m.receivedAt), [NOW, NOW - 3600]);
});

test('the ids are distinct and do not come from a counter', () => {
  const store = storeWith();
  for (let i = 0; i < 20; i++) store.deliver([{ addrKey: key(1), envelope: envelope() }], NOW);
  const ids = store.list(key(1), 0, 100).messages.map((m) => m.id);
  assert.equal(new Set(ids).size, 20);
  assert.notDeepEqual(ids, [...ids].sort(), 'they are not in ascending order');
});

test('since is a per-box cursor: returns what comes after, in arrival order, in pages', () => {
  const store = storeWith();
  for (let i = 1; i <= 5; i++) store.deliver([{ addrKey: key(1), envelope: envelope(SMALL, i) }], NOW);
  store.deliver([{ addrKey: key(2), envelope: envelope(SMALL, 9) }], NOW);
  const first = store.list(key(1), 0, 2);
  assert.equal(first.messages.length, 2);
  assert.equal(first.next, 2);
  const second = store.list(key(1), first.next, 2);
  assert.equal(second.next, 4);
  const third = store.list(key(1), second.next, 2);
  assert.equal(third.messages.length, 1);
  assert.equal(third.next, 5);
  assert.deepEqual(store.list(key(1), third.next, 2), { messages: [], next: 5 }, 'with nothing new, the cursor does not move');
  const all = [...first.messages, ...second.messages, ...third.messages];
  assert.deepEqual(all.map((m) => store.get(key(1), m.id)![0]), [1, 2, 3, 4, 5]);
  assert.equal(store.list(key(2), 0, 10).next, 1, 'each box numbers on its own');
});

test('per-box quota counted by envelope size: fits up to the exact limit and not one byte more', () => {
  const store = storeWith({ quotaBytes: 2 * SMALL });
  store.deliver([{ addrKey: key(1), envelope: envelope() }], NOW);
  assert.equal(store.usedBytes(key(1)), SMALL);
  assert.equal(store.hasRoomFor(key(1), SMALL), true);
  assert.equal(store.hasRoomFor(key(1), SMALL + 1), false);
  store.deliver([{ addrKey: key(1), envelope: envelope() }], NOW);
  assert.equal(store.usedBytes(key(1)), 2 * SMALL);
  assert.throws(() => store.deliver([{ addrKey: key(1), envelope: envelope() }], NOW), QuotaExceeded);
  assert.equal(store.list(key(1), 0, 10).messages.length, 2);
  assert.equal(store.hasRoomFor(key(2), 2 * SMALL), true, 'the quota is per box');
  store.deliver([{ addrKey: key(2), envelope: envelope() }], NOW);
});

test('a delivery to several boxes is all or nothing', () => {
  const store = storeWith({ quotaBytes: SMALL });
  store.deliver([{ addrKey: key(2), envelope: envelope() }], NOW); // slot 2 is now full
  assert.throws(
    () => store.deliver([{ addrKey: key(1), envelope: envelope() }, { addrKey: key(2), envelope: envelope() }], NOW),
    QuotaExceeded,
  );
  assert.equal(store.usedBytes(key(1)), 0, 'box 1 was rolled back');
  store.deliver([{ addrKey: key(1), envelope: envelope() }, { addrKey: key(3), envelope: envelope() }], NOW);
  assert.equal(store.usedBytes(key(1)), SMALL);
  assert.equal(store.usedBytes(key(3)), SMALL);
});

test('two deliveries to the same box in a single call both count toward the quota', () => {
  const store = storeWith({ quotaBytes: SMALL });
  const twice = [{ addrKey: key(1), envelope: envelope() }, { addrKey: key(1), envelope: envelope() }];
  assert.throws(() => store.deliver(twice, NOW), QuotaExceeded);
  assert.equal(store.usedBytes(key(1)), 0);
});

test('deliveries are consumed one at a time (sealing can happen on the fly)', () => {
  const store = storeWith();
  const order: string[] = [];
  function* lazy() {
    for (const byte of [1, 2]) {
      order.push(`sella ${byte}`);
      yield { addrKey: key(byte), envelope: envelope() };
      order.push(`guardado ${byte} (${store.usedBytes(key(byte))})`);
    }
  }
  store.deliver(lazy(), NOW);
  assert.deepEqual(order, ['sella 1', `guardado 1 (${SMALL})`, 'sella 2', `guardado 2 (${SMALL})`]);
});

test('a repeated id (should not happen) fails and leaves nothing half done', () => {
  const same = new Uint8Array(16).fill(5);
  const store = storeWith({ ids: [same, new Uint8Array(16).fill(6), same] });
  store.deliver([{ addrKey: key(1), envelope: envelope() }], NOW);
  assert.throws(() => store.deliver([{ addrKey: key(2), envelope: envelope() }, { addrKey: key(1), envelope: envelope() }], NOW));
  assert.equal(store.usedBytes(key(2)), 0);
  assert.equal(store.list(key(1), 0, 10).messages.length, 1);
});

test('rejects malformed keys, ids, cursors and envelopes', () => {
  const store = storeWith();
  assert.throws(() => store.deliver([{ addrKey: new Uint8Array(31), envelope: envelope() }], NOW), RangeError);
  assert.throws(() => store.deliver([{ addrKey: key(1), envelope: new Uint8Array(100) }], NOW), RangeError, 'not a bucket');
  assert.equal(store.usedBytes(key(1)), 0);
  assert.equal(store.get(key(1), 'XYZ'), undefined);
  assert.equal(store.get(key(1), 'AB'.repeat(16)), undefined, 'uppercase hex is not an id');
  assert.throws(() => store.list(key(1), -1, 10), RangeError);
  assert.throws(() => store.list(key(1), 0.5, 10), RangeError);
  assert.throws(() => store.list(key(1), 0, 0), RangeError);
});

test('a zero quota lets nothing in (not mistaken for "unset")', () => {
  const store = storeWith({ quotaBytes: 0 });
  assert.equal(store.hasRoomFor(key(1), 1), false);
  assert.throws(() => store.deliver([{ addrKey: key(1), envelope: envelope() }], NOW), QuotaExceeded);
});

test('the default quota is 300 MiB', () => {
  assert.equal(DEFAULT_MAILBOX_QUOTA_BYTES, 300 * 1024 * 1024);
  const store = storeWith();
  assert.equal(store.hasRoomFor(key(1), DEFAULT_MAILBOX_QUOTA_BYTES), true);
  assert.equal(store.hasRoomFor(key(1), DEFAULT_MAILBOX_QUOTA_BYTES + 1), false);
});

test('on disk: file 0600 in directory 0700, and a 32 MiB envelope survives close and reopen', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nightmail-store-'));
  try {
    const file = path.join(dir, 'server', 'mail.sqlite');
    const big = envelope(envelopeLengthFor(25 * 1024 * 1024), 3);
    let db = openDatabase(file);
    new MailboxStore(db).deliver([{ addrKey: key(1), envelope: big }], NOW);
    db.close();
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
    db = openDatabase(file);
    const store = new MailboxStore(db);
    const [message] = store.list(key(1), 0, 10).messages;
    assert.equal(message!.size, 33_554_432);
    const read = store.get(key(1), message!.id)!;
    assert.equal(read.length, big.length);
    assert.ok(read.every((byte) => byte === 3));
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
