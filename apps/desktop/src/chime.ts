// The new-mail sound, «luciérnaga» (`design/sounds`): a low, soft swell and one small clear note that appears above
// it and stays a moment (about 0.76 s). On Windows the system plays it, outside the webview (`play_chime`,
// `src-tauri/src/chime.rs`): with the window minimised or behind others, WebView2 treats the page as hidden and its
// audio engine did not reliably sound. Elsewhere (or if that fails) it is synthesised here with Web Audio on the spot,
// one oscillator per tone, following `design/sounds/sounds.json` and the formula in `design/sounds/tools/render.py`. No
// audio file and no CSP change. None of this throws: if it cannot play (no Web Audio, the engine does not allow sound
// before a user gesture, the sound is turned off in Settings), it stays silent.
import { api } from './api.ts';
import { prefs } from './prefs.ts';

/** What is used of `AudioContext`. */
export type ChimeContext = Pick<AudioContext, 'state' | 'currentTime' | 'destination' | 'resume' | 'suspend' | 'createOscillator' | 'createGain'>;

/** Volume of the whole sound. At 0.1893 its loudest point is at -12 dBFS. To make it quieter or louder, change only
 *  this value (Windows has its own, `GAIN` in `src-tauri/src/chime.rs`). */
export const GAIN = 0.1893;

/** The sound, as in `design/sounds/sounds.json`: it lasts `durationS` and fades to silence over its last `fadeOutS`.
 *  Each tone starts at `atS`, rises smoothly to `level` in `attackS` and then falls with time constant `decayS`. A
 *  low G with a faint octave (the night), then a high D as a pair of tones 2.8 Hz apart, which makes it shimmer,
 *  with a faint octave (the light). */
export const SOUND = {
  durationS: 0.76,
  fadeOutS: 0.1,
  tones: [
    { atS: 0, freqHz: 392, level: 0.6, attackS: 0.07, decayS: 0.14 },
    { atS: 0, freqHz: 784, level: 0.15, attackS: 0.1, decayS: 0.11 },
    { atS: 0.11, freqHz: 1174.66, level: 0.6, attackS: 0.016, decayS: 0.17 },
    { atS: 0.11, freqHz: 1177.46, level: 0.27, attackS: 0.016, decayS: 0.17 },
    { atS: 0.11, freqHz: 2349.32, level: 0.05, attackS: 0.01, decayS: 0.05 },
  ],
} as const;
/** Points of the smooth curves (the rise of each tone and the final fade): enough for them to sound continuous. */
const CURVE_POINTS = 64;
/** How long to wait for the engine to allow sound: if it still does not, a late sound would be out of place. */
const RESUME_WAIT_MS = 300;
/** After playing (or being primed), the engine is suspended after this many ms: running it uses CPU even when
 *  silent. Longer than the sound (about 0.76 s), so it does not cut it. */
export const REST_AFTER_MS = 1000;

export interface Chime {
  /** Plays once. `true` if it played. */
  play(): Promise<boolean>;
  /** Readies the engine to play later (from a user gesture), without playing. */
  prime(): Promise<void>;
}

/** From `from` to `to` along half a cosine, as in the README: it starts and ends flat, so there is no click. */
export function halfCosine(from: number, to: number): Float32Array {
  const curve = new Float32Array(CURVE_POINTS);
  for (let i = 0; i < CURVE_POINTS; i += 1) {
    curve[i] = from + ((to - from) * (1 - Math.cos((Math.PI * i) / (CURVE_POINTS - 1)))) / 2;
  }
  return curve;
}

/** Plays the sound from `start`: one oscillator and one gain node per tone, all into one more gain node for `GAIN`
 *  and the final fade. */
function sound(ctx: ChimeContext, start: number) {
  const end = start + SOUND.durationS;
  const master = ctx.createGain();
  master.gain.value = GAIN;
  master.gain.setValueCurveAtTime(halfCosine(GAIN, 0), end - SOUND.fadeOutS, SOUND.fadeOutS);
  master.connect(ctx.destination);
  for (const tone of SOUND.tones) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const at = start + tone.atS;
    osc.type = 'sine';
    osc.frequency.value = tone.freqHz;
    gain.gain.value = 0;
    gain.gain.setValueCurveAtTime(halfCosine(0, tone.level), at, tone.attackS);
    gain.gain.setTargetAtTime(0, at + tone.attackS, tone.decayS);
    osc.connect(gain).connect(master);
    osc.start(at);
    osc.stop(end);
  }
}

/** `make`: creates the context (or `null` if there is no Web Audio). Created once, the first time it is needed.
 *  `enabled`: the "sound on new mail" setting, read each time.
 *  `native`: plays it outside the webview; `true` if it did (then Web Audio is not used). Tried first on each sound. */
export function createChime(
  make: () => ChimeContext | null,
  enabled: () => boolean,
  native: () => Promise<boolean> = () => Promise.resolve(false),
): Chime {
  /** The system already played it once: the webview's audio engine is not needed (nor readied). */
  let nativeWorks = false;
  /** `played`: the system played it. `fallback`: not here (Linux, macOS), Web Audio plays it. `refused`: the core
   *  said no (NightMail was just locked, for instance): nothing sounds. */
  async function playNative(): Promise<'played' | 'fallback' | 'refused'> {
    try {
      nativeWorks = await native();
      return nativeWorks ? 'played' : 'fallback';
    } catch {
      return 'refused';
    }
  }
  let ctx: ChimeContext | null | undefined;
  let resting: ReturnType<typeof setTimeout> | undefined;
  /** The last suspension requested from the engine. Until it finishes the engine still reports "running", but
   *  anything played then would sound late, on resume. */
  let suspending: Promise<void> = Promise.resolve();
  /** Suspends the engine within `REST_AFTER_MS`. An earlier sound that has not been suspended yet does not do it. */
  function restSoon(audio: ChimeContext) {
    clearTimeout(resting);
    resting = setTimeout(() => {
      suspending = audio.suspend().catch(() => {});
    }, REST_AFTER_MS);
  }
  async function ready(): Promise<ChimeContext | null> {
    ctx ??= make();
    await suspending;
    if (ctx && ctx.state !== 'running') {
      const wait = new Promise<void>((resolve) => setTimeout(resolve, RESUME_WAIT_MS));
      await Promise.race([ctx.resume().catch(() => {}), wait]);
    }
    return ctx?.state === 'running' ? ctx : null;
  }
  return {
    async play() {
      if (!enabled()) return false;
      const system = await playNative();
      if (system !== 'fallback') return system === 'played';
      try {
        const audio = await ready();
        if (!audio) return false;
        sound(audio, audio.currentTime);
        restSoon(audio);
        return true;
      } catch {
        return false;
      }
    },
    async prime() {
      if (!enabled() || nativeWorks) return;
      try {
        const audio = await ready();
        if (audio) restSoon(audio);
      } catch {
        // No audio engine: `play` will try again.
      }
    },
  };
}

export const chime = createChime(
  () => (typeof globalThis.AudioContext === 'function' ? new AudioContext() : null),
  () => prefs.get().sound === 'on',
  () => api.playChime(),
);
