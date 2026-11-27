// Submission to the node that also reports when a transaction enters a block.
//
// The wallet (wallet-sdk-facade 5.0.1, `submitTransaction`) always asks its submission service for 'Finalized' and
// only returns then: about two GRANDPA rounds after the block. This service is the SDK default
// (`makeDefaultSubmissionService`) plus one thing: while it follows the node's status stream up to the status the
// wallet asked for, the first 'InBlock' of a watched transaction is reported to whoever watches it. The wallet
// still gets 'Finalized' and still settles its coins as before; only the watcher learns earlier.
import { Cause, Effect, Exit, Fiber, Option, pipe, Scope, Stream } from 'effect';
import { NodeClient, NodeClientError, PolkadotNodeClient, SubmissionEvent } from '@midnightntwrk/wallet-sdk/node-client/effect';
import { SubmissionError } from '@midnightntwrk/wallet-sdk-capabilities/submission';

/** The block that holds a transaction (not final yet: a fork may still retract it). */
export type InBlock = { blockHash: string; blockHeight: bigint };

export type InclusionWatch = {
  /**
   * Calls `onInBlock` once, the first time `tx` (the very object handed to `facade.submitTransaction`) is in a
   * block. Returns a function that stops watching.
   */
  watch(tx: object, onInBlock: (block: InBlock) => void): () => void;
};

type Status = 'Submitted' | 'InBlock' | 'Finalized';
type Serializable = { serialize(): Uint8Array };
/** Status stream of one submission, as the node client gives it. */
export type EventStream = (tx: Serializable) => Stream.Stream<SubmissionEvent.SubmissionEvent, unknown>;

export type WatchedSubmission = InclusionWatch & {
  /** The submission service to hand to `WalletFacade.init`. */
  service: {
    submitTransaction(tx: Serializable, waitForStatus?: Status): Promise<SubmissionEvent.SubmissionEvent>;
    close(): Promise<void>;
  };
};

/**
 * A submission service over `events` that reports inclusions. Failures are wrapped exactly like the SDK default
 * (a SubmissionError whose cause is the node client's error), so `classifySubmissionFailure` reads them the same.
 */
export function watchedSubmission(events: EventStream, close: () => Promise<void>): WatchedSubmission {
  const watchers = new WeakMap<object, (block: InBlock) => void>();
  const report = (tx: object, event: SubmissionEvent.SubmissionEvent) => {
    if (event._tag !== 'InBlock') return;
    const watcher = watchers.get(tx);
    if (!watcher) return;
    watchers.delete(tx); // once: a retracted block puts it back in the pool and a later one may hold it again
    try {
      watcher({ blockHash: event.blockHash, blockHeight: event.blockHeight });
    } catch {
      // A watcher's failure must not change the submission's outcome.
    }
  };
  const submitTransaction = (tx: Serializable, waitForStatus: Status = 'InBlock') => pipe(
    events(tx),
    Stream.tap((event) => Effect.sync(() => report(tx, event))),
    Stream.find(SubmissionEvent.is(waitForStatus)),
    Stream.runHead,
    Effect.flatMap(Option.match({
      onNone: () => Effect.fail(new NodeClientError.TransactionProgressError({
        message: 'Transaction did not reach desired stage and no other error was reported',
        txData: tx.serialize() as never,
        desiredStage: waitForStatus,
      })),
      onSome: (event) => Effect.succeed(event),
    })),
    Effect.mapError((cause) => new SubmissionError({ message: 'Transaction submission error', cause })),
    Effect.runPromise,
  );
  return {
    service: { submitTransaction, close },
    watch(tx, onInBlock) {
      watchers.set(tx, onInBlock);
      return () => { watchers.delete(tx); };
    },
  };
}

/** `watchedSubmission` over the node at `relayURL`, built the same way as the SDK default. */
export function nodeSubmission(relayURL: URL): WatchedSubmission {
  // Built in the background in a scope this service owns, so it is usable at once; closing interrupts a build
  // still waiting for the node, then releases a built client (as `makeDefaultSubmissionServiceEffect`).
  const scope = Scope.make().pipe(Effect.runSync);
  const clientBuild = PolkadotNodeClient.make({ nodeURL: relayURL }).pipe(Effect.provideService(Scope.Scope, scope), Effect.runFork);
  const client = pipe(Fiber.await(clientBuild), Effect.flatMap((exit) => (Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause)
    ? Effect.fail(new NodeClientError.ConnectionError({ message: `The submission service was closed before it connected to ${relayURL.toString()}` }))
    : exit)));
  const events: EventStream = (tx) =>
    NodeClient.sendMidnightTransaction(tx.serialize() as never).pipe(Stream.provideServiceEffect(NodeClient.NodeClient, client));
  const close = () => pipe(Fiber.interrupt(clientBuild), Effect.zipRight(Scope.close(scope, Exit.void)), Effect.ignoreLogged, Effect.runPromise);
  return watchedSubmission(events, close);
}
