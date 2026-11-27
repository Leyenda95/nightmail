// The wallet's submission service with inclusion reports (wallet/submission.ts), over a scripted node status stream.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Stream } from 'effect';
import { NodeClientError, SubmissionEvent } from '@midnightntwrk/wallet-sdk/node-client/effect';
import { classifySubmissionFailure } from '@midnightntwrk/wallet-sdk-capabilities/submission';
import { type EventStream, watchedSubmission } from '../src/wallet/submission.ts';

const bytes = new Uint8Array([1, 2, 3]) as never;
const submitted = SubmissionEvent.Submitted({ tx: bytes, txHash: '0x01' });
const inBlock = (n: number) => SubmissionEvent.InBlock({ tx: bytes, txHash: '0x01', blockHash: `0xb${n}`, blockHeight: BigInt(n) });
const finalized = (n: number) => SubmissionEvent.Finalized({ tx: bytes, txHash: '0x01', blockHash: `0xb${n}`, blockHeight: BigInt(n) });
const tx = () => ({ serialize: () => new Uint8Array([1, 2, 3]) });

/** A service whose node answers every submission with `events`; `closed` counts closes. */
function serviceOver(events: SubmissionEvent.SubmissionEvent[], failWith?: unknown) {
  const counts = { closed: 0, streams: 0 };
  const stream: EventStream = () => {
    counts.streams += 1;
    const scripted = Stream.fromIterable(events);
    return failWith === undefined ? scripted : Stream.concat(scripted, Stream.fail(failWith));
  };
  return { submission: watchedSubmission(stream, async () => { counts.closed += 1; }), counts };
}

test('waits for the status the wallet asks for (Finalized) and reports the first block on the way', async () => {
  const { submission, counts } = serviceOver([submitted, inBlock(7), finalized(7)]);
  const watchedTx = tx();
  const blocks: unknown[] = [];
  submission.watch(watchedTx, (block) => blocks.push(block));
  const event = await submission.service.submitTransaction(watchedTx, 'Finalized');
  assert.equal(event._tag, 'Finalized');
  assert.deepEqual(blocks, [{ blockHash: '0xb7', blockHeight: 7n }]);
  assert.equal(counts.streams, 1, 'submitted once');
  await submission.service.close();
  assert.equal(counts.closed, 1);
});

test('a retracted block: reported once (the first), the wallet still gets the final block', async () => {
  const { submission } = serviceOver([inBlock(7), submitted, inBlock(8), finalized(8)]);
  const watchedTx = tx();
  const blocks: unknown[] = [];
  submission.watch(watchedTx, (block) => blocks.push(block));
  const event = await submission.service.submitTransaction(watchedTx, 'Finalized');
  assert.deepEqual([event._tag, (event as { blockHeight: bigint }).blockHeight], ['Finalized', 8n]);
  assert.deepEqual(blocks, [{ blockHash: '0xb7', blockHeight: 7n }]);
});

test('only the watched object is reported, and not after it stops watching; a failing watcher changes nothing', async () => {
  const { submission } = serviceOver([inBlock(7), finalized(7)]);
  const watchedTx = tx();
  let calls = 0;
  const stop = submission.watch(watchedTx, () => { calls += 1; });
  await submission.service.submitTransaction(tx(), 'Finalized');
  stop();
  await submission.service.submitTransaction(watchedTx, 'Finalized');
  assert.equal(calls, 0);
  submission.watch(watchedTx, () => { throw new Error('watcher bug'); });
  assert.equal((await submission.service.submitTransaction(watchedTx, 'Finalized'))._tag, 'Finalized');
});

test('the default status is InBlock, as in the SDK default service', async () => {
  const { submission } = serviceOver([submitted, inBlock(3), finalized(3)]);
  assert.equal((await submission.service.submitTransaction(tx()))._tag, 'InBlock');
});

test('failures are wrapped like the SDK default, so the wallet classifies them the same', async () => {
  const invalid = new NodeClientError.TransactionInvalidError({ message: 'invalid', txData: bytes });
  const refused = serviceOver([], invalid).submission;
  const error = await refused.service.submitTransaction(tx(), 'Finalized').then(() => assert.fail('should fail'), (e: unknown) => e);
  assert.equal(classifySubmissionFailure(error)._tag, 'NotIncluded', 'refused: the wallet may release its coins');

  const ended = serviceOver([submitted, inBlock(4)]).submission;
  const unsure = await ended.service.submitTransaction(tx(), 'Finalized').then(() => assert.fail('should fail'), (e: unknown) => e);
  assert.equal(classifySubmissionFailure(unsure)._tag, 'Undetermined', 'ended after a block without finality: may be in it');
});
