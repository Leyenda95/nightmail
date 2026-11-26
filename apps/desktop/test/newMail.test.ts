// New mail outside the inbox: when it counts as new, when the notice appears, how it groups arrivals and
// when it sounds. `node --test test/*.test.ts`.
import './idioma-es.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { SyncView } from '../src/bindings/SyncView.ts';
import { createChime, GAIN, halfCosine, REST_AFTER_MS, SOUND, type ChimeContext } from '../src/chime.ts';
import { DICTIONARIES } from '../src/i18n/index.ts';
import { afterSync, dismissNotice, holdNotice, nextNotice, noticeStart, watchingInbox } from '../src/newMail.ts';
import { soundChoices } from '../src/screens/settings.ts';

const round = (stored: number, more: Partial<SyncView> = {}): SyncView => ({ stored, skipped: 0, failed: 0, deferred: 0, fresh: 0, ...more });

// --- What counts as new mail (decided by the core, per address: `SyncView.fresh`)

test('counts only what the core reports as new, not everything stored (backlog does not notify)', () => {
  assert.equal(afterSync(0, round(40)), 0);
  assert.equal(afterSync(3, round(5, { fresh: 2, failed: 1 })), 5, 'a failing address does not hide what is new in another');
});

// --- The notice

test('on mount there is no notice, even if mail had arrived before', () => {
  const n = noticeStart(5);
  assert.equal(n.count, 0);
  assert.equal(nextNotice(n, 5, false), n);
});

test('outside the inbox, arrivals show in the notice and play the sound, in the inbox neither notice nor sound', () => {
  const start = noticeStart(0);
  const away = nextNotice(start, 1, false);
  assert.equal(away.count, 1);
  assert.equal(away.chimes, 1);
  const inInbox = nextNotice(start, 1, true);
  assert.equal(inInbox.count, 0);
  assert.equal(inInbox.chimes, 0);
  assert.equal(nextNotice(inInbox, 1, false), inInbox, 'leaving the inbox does not notify about what was already seen there');
});

test('several arrivals merge into one notice with an up-to-date count, and the sound plays for each', () => {
  let n = noticeStart(0);
  n = nextNotice(n, 1, false);
  n = nextNotice(n, 3, false);
  n = nextNotice(n, 4, false);
  assert.equal(n.count, 4);
  assert.equal(n.chimes, 3);
  assert.equal(nextNotice(n, 4, false), n, 'without arrivals, nothing changes or plays');
});

test('entering the inbox clears the notice, what arrives later outside starts from zero', () => {
  let n = nextNotice(noticeStart(0), 2, false);
  n = nextNotice(n, 2, true);
  assert.equal(n.count, 0);
  n = nextNotice(n, 3, false);
  assert.equal(n.count, 1);
});

test('closing the notice (button or timeout) clears it, the next arrival opens a new one with only its own', () => {
  let n = nextNotice(noticeStart(0), 2, false);
  n = dismissNotice(n);
  assert.equal(n.count, 0);
  assert.equal(nextNotice(n, 2, false), n);
  n = nextNotice(n, 5, false);
  assert.equal(n.count, 3);
  const closed = dismissNotice(noticeStart(0));
  assert.equal(dismissNotice(closed), closed);
});

test('with the pointer or focus on it, it is held, on leaving the notice is released', () => {
  let n = nextNotice(noticeStart(0), 1, false);
  n = holdNotice(n, true);
  assert.equal(n.held, true);
  assert.equal(dismissNotice(n).held, false);
  assert.equal(nextNotice(n, 1, true).held, false);
  const none = noticeStart(0);
  assert.equal(holdNotice(none, true), none, 'without a notice there is nothing to hold');
});

test('a count that goes down (new session) does not notify', () => {
  const n = nextNotice(noticeStart(4), 1, false);
  assert.equal(n.count, 0);
  assert.equal(n.seen, 1);
});

test('the text only says how many, with its plural, in both languages', () => {
  assert.equal(DICTIONARIES.es.screensMail.newMail.count(1), '1 mensaje nuevo');
  assert.equal(DICTIONARIES.es.screensMail.newMail.count(3), '3 mensajes nuevos');
  assert.equal(DICTIONARIES.en.screensMail.newMail.count(1), '1 new message');
  assert.equal(DICTIONARIES.en.screensMail.newMail.count(3), '3 new messages');
});

// --- The sound

/** What a gain node was asked to do: its starting value, its curves and its falls. */
interface FakeGain {
  value: number;
  curves: { curve: Float32Array; at: number; seconds: number }[];
  targets: { target: number; at: number; constant: number }[];
  to: unknown;
  node: unknown;
}

/** A stand-in `AudioContext`: it records the tones that start, its gain nodes and how many times `resume` and
 *  `suspend` are requested. */
function fakeAudio(state: AudioContextState = 'running', resumes: 'ok' | 'fails' | 'hangs' = 'ok', suspends: 'now' | 'later' = 'now') {
  const started: number[] = [];
  const stopped: number[] = [];
  const frequencies: number[] = [];
  const gains: FakeGain[] = [];
  const param = () => ({ value: 0 });
  const node = () => ({ connect: (next: unknown) => next });
  const ctx = {
    state,
    currentTime: 10,
    destination: {},
    resumed: 0,
    suspended: 0,
    /** With `suspends: 'later'`, the pause ends on calling this; until then the engine still reads "running", like the real one. */
    finishSuspend: () => {},
    suspend() {
      ctx.suspended += 1;
      if (suspends === 'now') {
        ctx.state = 'suspended';
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        ctx.finishSuspend = () => {
          ctx.state = 'suspended';
          resolve();
        };
      });
    },
    resume() {
      ctx.resumed += 1;
      if (resumes === 'fails') return Promise.reject(new Error('NotAllowedError'));
      if (resumes === 'hangs') return new Promise<void>(() => {});
      ctx.state = 'running';
      return Promise.resolve();
    },
    createOscillator() {
      const osc = {
        ...node(),
        type: '',
        frequency: param(),
        start: (at: number) => started.push(at),
        stop: (at: number) => stopped.push(at),
      };
      Object.defineProperty(osc.frequency, 'value', {
        set(v: number) {
          frequencies.push(v);
        },
      });
      return osc;
    },
    createGain() {
      const seen: FakeGain = { value: 1, curves: [], targets: [], to: undefined, node: undefined };
      gains.push(seen);
      const gainNode = {
        gain: {
          set value(v: number) {
            seen.value = v;
          },
          setValueCurveAtTime: (curve: Float32Array, at: number, seconds: number) => seen.curves.push({ curve, at, seconds }),
          setTargetAtTime: (target: number, at: number, constant: number) => seen.targets.push({ target, at, constant }),
        },
        connect(next: unknown) {
          seen.to = next;
          return next;
        },
      };
      seen.node = gainNode;
      return gainNode;
    },
  };
  return { ctx, started, stopped, frequencies, gains, asContext: ctx as unknown as ChimeContext };
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

test('sound on: the firefly, a low note and, above it, a high one that appears at 110 ms', async () => {
  const audio = fakeAudio();
  const chime = createChime(() => audio.asContext, () => true);
  assert.equal(await chime.play(), true);
  assert.deepEqual(audio.frequencies, [392, 784, 1174.66, 1177.46, 2349.32]);
  assert.deepEqual(audio.started.map((at) => Math.round((at - 10) * 1000)), [0, 0, 110, 110, 110]);
  assert.ok(audio.stopped.every((at) => near(at, 10.76)), 'everything ends at 0.76 s');
});

test('sound: each tone rises smoothly to its level and then falls, the whole carries the gain and fades at the end', async () => {
  const audio = fakeAudio();
  await createChime(() => audio.asContext, () => true).play();
  const [master, ...tones] = audio.gains;
  assert.equal(tones.length, SOUND.tones.length);
  for (const [i, tone] of SOUND.tones.entries()) {
    const { value, curves, targets, to } = tones[i];
    assert.equal(value, 0, 'silent until it starts');
    assert.equal(curves.length, 1);
    assert.ok(near(curves[0].at, 10 + tone.atS) && near(curves[0].seconds, tone.attackS));
    assert.equal(curves[0].curve[0], 0);
    assert.ok(Math.abs(curves[0].curve.at(-1)! - tone.level) < 1e-6);
    assert.deepEqual(targets.length, 1);
    assert.ok(targets[0].target === 0 && near(targets[0].at, 10 + tone.atS + tone.attackS) && targets[0].constant === tone.decayS);
    assert.equal(to, master.node, 'all go through the shared gain');
  }
  assert.equal(master.value, GAIN);
  assert.equal(master.curves.length, 1);
  const fade = master.curves[0];
  assert.ok(near(fade.at, 10.66) && near(fade.seconds, 0.1), 'fades out in the last 100 ms');
  assert.ok(Math.abs(fade.curve[0] - GAIN) < 1e-6 && fade.curve.at(-1)! === 0, 'no click at the end');
});

test('sound: the smooth curves are half cosines, flat at start and end', () => {
  const curve = halfCosine(0, 1);
  assert.equal(curve[0], 0);
  assert.ok(Math.abs(curve.at(-1)! - 1) < 1e-6);
  assert.ok(Math.abs(curve[Math.floor(curve.length / 2)] - 0.5) < 0.05);
  assert.ok(curve.every((v, i) => i === 0 || v >= curve[i - 1]), 'rises without going back');
});

test('sound: the tones, duration and fade are those in design/sounds/sounds.json', () => {
  type Spec = { sounds: { name: string; duration_s: number; fade_out_s: number; gain: number; tones: Record<string, number>[] }[] };
  const spec = JSON.parse(readFileSync(new URL('../../../design/sounds/sounds.json', import.meta.url), 'utf8')) as Spec;
  const luciernaga = spec.sounds.find((s) => s.name === 'luciernaga')!;
  assert.equal(SOUND.durationS, luciernaga.duration_s);
  assert.equal(SOUND.fadeOutS, luciernaga.fade_out_s);
  assert.deepEqual(
    SOUND.tones.map((t) => [t.atS, t.freqHz, t.level, t.attackS, t.decayS]),
    luciernaga.tones.map((t) => [t.at_s, t.freq_hz, t.level, t.attack_s, t.decay_s]),
  );
  assert.ok(GAIN > 0 && GAIN <= luciernaga.gain * 2, 'the gain can be changed, but not above -6 dBFS');
});

test('sound off in Settings: it does not play and does not even create the audio engine', async () => {
  let made = 0;
  const chime = createChime(() => {
    made += 1;
    return fakeAudio().asContext;
  }, () => false);
  assert.equal(await chime.play(), false);
  await chime.prime();
  assert.equal(made, 0);
});

test('suspended engine: resumes it and plays, if not allowed (no prior gesture) it does not play and does not throw', async () => {
  const ok = fakeAudio('suspended');
  assert.equal(await createChime(() => ok.asContext, () => true).play(), true);
  assert.equal(ok.ctx.resumed, 1);
  const refused = fakeAudio('suspended', 'fails');
  assert.equal(await createChime(() => refused.asContext, () => true).play(), false);
  assert.equal(refused.started.length, 0);
  const waiting = fakeAudio('suspended', 'hangs');
  assert.equal(await createChime(() => waiting.asContext, () => true).play(), false, 'does not wait forever nor play late');
  assert.equal(waiting.started.length, 0);
});

test('without Web Audio, or if creating it throws, it does not play and does not throw', async () => {
  assert.equal(await createChime(() => null, () => true).play(), false);
  const throwing = createChime(() => {
    throw new Error('no audio');
  }, () => true);
  assert.equal(await throwing.play(), false);
  await throwing.prime();
});

test('prime leaves the engine ready without playing, and the engine is created only once', async () => {
  const audio = fakeAudio('suspended');
  let made = 0;
  const chime = createChime(() => {
    made += 1;
    return audio.asContext;
  }, () => true);
  await chime.prime();
  assert.equal(audio.ctx.resumed, 1);
  assert.equal(audio.started.length, 0);
  await chime.play();
  assert.equal(made, 1);
  assert.equal(audio.started.length, 5);
});

test('the engine rests (suspended) shortly after playing or being primed, and the next sound resumes it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const audio = fakeAudio('suspended');
  const chime = createChime(() => audio.asContext, () => true);
  await chime.prime();
  assert.equal(audio.ctx.state, 'running');
  t.mock.timers.tick(REST_AFTER_MS);
  assert.equal(audio.ctx.state, 'suspended', 'ready, but idle while not playing');
  assert.equal(await chime.play(), true);
  assert.equal(audio.ctx.resumed, 2);
  t.mock.timers.tick(REST_AFTER_MS - 1);
  assert.equal(audio.ctx.state, 'running', 'does not cut the sound');
  assert.ok(REST_AFTER_MS >= SOUND.durationS * 1000 + 200, 'rests once the sound has finished, with a margin');
  t.mock.timers.tick(1);
  assert.equal(audio.ctx.state, 'suspended');
});

test("two sounds in a row: the first one's pause does not cut the second", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const audio = fakeAudio();
  const chime = createChime(() => audio.asContext, () => true);
  await chime.play();
  t.mock.timers.tick(REST_AFTER_MS - 300);
  await chime.play();
  t.mock.timers.tick(REST_AFTER_MS - 300);
  assert.equal(audio.ctx.state, 'running');
  t.mock.timers.tick(300);
  assert.equal(audio.ctx.state, 'suspended');
  assert.equal(audio.ctx.suspended, 1);
});

test('a sound arriving while the engine is suspending waits for the pause and resumes it: it does not play late', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const audio = fakeAudio('suspended', 'ok', 'later');
  const chime = createChime(() => audio.asContext, () => true);
  await chime.prime();
  t.mock.timers.tick(REST_AFTER_MS);
  assert.equal(audio.ctx.suspended, 1);
  assert.equal(audio.ctx.state, 'running', 'the pause has not finished yet');
  const played = chime.play();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(audio.started.length, 0, 'does not schedule notes on an engine about to suspend');
  audio.ctx.finishSuspend();
  assert.equal(await played, true);
  assert.equal(audio.ctx.resumed, 2, 'resumes it after the pause');
  assert.equal(audio.started.length, 5);
  assert.equal(audio.ctx.state, 'running');
});

test('Windows: plays through the system, outside the window, and neither uses nor primes the page audio engine', async () => {
  let made = 0;
  let asked = 0;
  const chime = createChime(
    () => {
      made += 1;
      return fakeAudio().asContext;
    },
    () => true,
    () => {
      asked += 1;
      return Promise.resolve(true);
    },
  );
  assert.equal(await chime.play(), true);
  await chime.prime();
  assert.equal(await chime.play(), true);
  assert.equal(asked, 2, 'each notice asks the system');
  assert.equal(made, 0, 'even with the window minimized it does not depend on the page');
});

test('outside Windows the system does not handle it and it plays with Web Audio, as before', async () => {
  const audio = fakeAudio();
  const chime = createChime(() => audio.asContext, () => true, () => Promise.resolve(false));
  assert.equal(await chime.play(), true);
  assert.equal(audio.started.length, 5);
});

test('if the core rejects it (just locked) it plays nowhere, when off it does not even ask', async () => {
  const audio = fakeAudio();
  const refused = createChime(() => audio.asContext, () => true, () => Promise.reject(new Error('NotUnlocked')));
  assert.equal(await refused.play(), false);
  assert.equal(audio.started.length, 0);
  let asked = 0;
  const off = createChime(() => audio.asContext, () => false, () => {
    asked += 1;
    return Promise.resolve(true);
  });
  assert.equal(await off.play(), false);
  assert.equal(asked, 0);
});

test('Settings: the sound has its two options, on first, with title and text', () => {
  assert.deepEqual(soundChoices().map((c) => c.value), ['on', 'off']);
  for (const c of soundChoices()) assert.ok(c.title.trim() && c.text?.trim(), c.value);
});

test('the Inbox is only watched with the window visible and focused', () => {
  assert.equal(watchingInbox(true, false), true);
  assert.equal(watchingInbox(true, true), false, 'minimized or unfocused: not watched');
  assert.equal(watchingInbox(false, false), false);
  assert.equal(watchingInbox(false, true), false);
});

test('in the Inbox with the window still a notice arrives (and plays), with the window in view it does not', () => {
  const start = noticeStart(0);
  const still = nextNotice(start, 1, watchingInbox(true, true));
  assert.equal(still.count, 1);
  assert.equal(still.chimes, 1);
  const seen = nextNotice(start, 1, watchingInbox(true, false));
  assert.equal(seen.count, 0);
  assert.equal(seen.chimes, 0);
});
