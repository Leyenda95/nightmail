// The payer's serial queue: everything that spends DUST (relay, issueBono and NIGHT
// registration) runs here one at a time, in arrival order. That way two transactions never pick the same
// coins and contract inserts never race each other.
import { Slots } from '../limits.ts';

/** The queue is full: the caller answers "try later" without enqueuing. */
export class QueueFullError extends Error {}
/** The queue is stopping (process shutdown): the job does not run. */
export class QueueStoppedError extends Error {}

export class SerialQueue {
  private readonly maxLength: number;
  /** One slot per running or waiting job. */
  private readonly places: Slots;
  private tail: Promise<unknown> = Promise.resolve();
  private stopped = false;

  /** `maxLength`: running plus waiting jobs allowed. */
  constructor(maxLength: number) {
    this.places = new Slots(maxLength);
    this.maxLength = maxLength;
  }

  /** Running plus waiting jobs. */
  get length(): number {
    return this.maxLength - this.places.available;
  }

  /** Runs `job` after all earlier ones finish. Its failure does not affect later jobs. */
  run<T>(job: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(stoppedError());
    if (!this.places.tryAcquire()) return Promise.reject(new QueueFullError('payer queue is full'));
    const result = this.tail
      .then(() => (this.stopped ? Promise.reject(stoppedError()) : job()))
      .finally(() => this.places.release());
    this.tail = result.catch(() => {});
    return result;
  }

  /**
   * Stops the queue: waiting and new jobs fail with QueueStoppedError without running. Resolves when the
   * running job finishes (it can't be cancelled, it may be submitting a transaction).
   */
  stop(): Promise<void> {
    this.stopped = true;
    return this.tail.then(() => {});
  }
}

function stoppedError(): QueueStoppedError {
  return new QueueStoppedError('payer is stopping');
}
