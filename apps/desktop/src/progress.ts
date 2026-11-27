// Text of each progress stage: the real stage the core sends, as a headline (initial capital, no full stop) and,
// where it takes long, the reason in plain words. No invented durations: a figure only goes in if it comes from the
// code or a measurement, and none holds today for every network and machine (so the notes carry no figures).
import type { Progress } from './bindings/Progress.ts';
import { t } from './i18n/index.ts';

type Stage = Progress['stage'];
type WithData = 'bonoReady';

/** A stage for the `Progreso` piece: the headline and, if there is one, the note that explains the wait. */
export interface ProgressParts {
  readonly stage: string;
  readonly note: string | null;
}

/** A stage in the dictionary (`t().status.progress`): a missing note is not stored. */
export interface ProgressText {
  readonly stage: string;
  readonly note?: string;
}

const parts = (text: ProgressText): ProgressParts => ({ stage: text.stage, note: text.note ?? null });

// Why each stage says what it says (the texts live in `i18n/*/status.ts`):
// - queued: only address operations queue (bono operations answer "busy").
// - registeringDust: registration waits for generated DUST with a half-hour cap (sidecar): neither "a little" nor
//   "a few minutes".
// - paying: `wallet.buyBono` proves, sends and waits to see the bono on chain, all inside this stage: it can take
//   half an hour or more, so "minutes" is not said either.
// - proving: the proof server can only be local, and the contract state is read before proving. No duration: there
//   are only measurements from one devnet and one machine.
// - retrying: a service answered "busy" or with an error (or Midnight was slow). If the NightMail server answers
//   nothing at all, `serverUnreachable` shows instead.
// - walletStateDiscarded: what is unreadable may be the wallet state or only its purchase journal, so it is not
//   said that everything is rebuilt.
// - recovering: the core sends the start of each batch of candidates, not a bono that exists: the number is not
//   shown. Recovery needs the session open, and the session only exists with the phrase already stored.
// - bonoReady: the bono is on chain ("confirmado"); it may still need a wait before use, so it is not "ready".
// - unknown: a stage this version does not know (newer core): it says it continues, without inventing what it does.

/** One entry for each stage without data; the type forces them all to be covered (also in the dictionary). */
function simple(): Record<Exclude<Stage, WithData>, ProgressText> {
  return t().status.progress.stages;
}

/** One entry for each stage with data. */
const WITH_DATA: { [S in WithData]: (p: Extract<Progress, { stage: S }>) => ProgressParts } = {
  bonoReady: () => parts(t().status.progress.bonoReady),
};

/** Headline and note of a stage. */
export function progressParts(p: Progress): ProgressParts {
  const stage: string = p.stage;
  if (Object.hasOwn(WITH_DATA, stage)) return (WITH_DATA[stage as WithData] as (p: Progress) => ProgressParts)(p);
  const known = simple();
  return parts(Object.hasOwn(known, stage) ? known[stage as keyof typeof known] : t().status.progress.unknown);
}
