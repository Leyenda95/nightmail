//! The new-mail sound played by the system on Windows, outside the webview.
//!
//! The UI decides when it is due (`apps/desktop/src/newMail.ts`) and asks for it here first. Played from the webview
//! (Web Audio), it depends on the page: when NightMail is minimised or behind other windows, WebView2 treats the page
//! as hidden and the audio engine may not come back in time, so the sound was lost. Played here it does not depend
//! on that. It is the same sound the UI synthesises (`chime.ts`), written once as an in-memory WAV and handed to
//! `PlaySoundW`, which plays it without blocking. No file and no new crate.
//!
//! The sound is «luciérnaga» (`design/sounds`): a low, soft swell and one small clear note that appears above it and
//! stays a moment, about 0.76 s. Its tones, envelopes and final fade are those of `design/sounds/sounds.json`, with
//! the formula of `design/sounds/tools/render.py`, and the result matches `design/sounds/luciernaga.wav`.
//!
//! On Linux and macOS [`play`] does nothing and returns `false`: the UI then plays it with Web Audio, as before.

use std::sync::OnceLock;

/// Volume of the whole sound. At 0.1893 its loudest point is at -12 dBFS. To make it quieter or louder, change only
/// this value (the UI has its own, `GAIN` in `chime.ts`).
const GAIN: f64 = 0.1893;

/// Samples per second, as in the reference file.
const RATE: u32 = 44_100;
/// Silence before and after the sound, in seconds.
const LEAD_IN_S: f64 = 0.01;
const TAIL_S: f64 = 0.02;
/// The sound lasts `DURATION_S` and fades to silence over its last `FADE_OUT_S`.
const DURATION_S: f64 = 0.76;
const FADE_OUT_S: f64 = 0.1;

/// One sine tone: it starts at `at_s`, rises to `level` in `attack_s` and then falls with time constant `decay_s`.
struct Tone {
    at_s: f64,
    freq_hz: f64,
    level: f64,
    attack_s: f64,
    decay_s: f64,
}

/// The tones: a low G with a faint octave (the night), then a high D as a pair of tones 2.8 Hz apart, which makes it
/// shimmer, with a faint octave (the light).
const TONES: [Tone; 5] = [
    Tone { at_s: 0.0, freq_hz: 392.0, level: 0.6, attack_s: 0.07, decay_s: 0.14 },
    Tone { at_s: 0.0, freq_hz: 784.0, level: 0.15, attack_s: 0.1, decay_s: 0.11 },
    Tone { at_s: 0.11, freq_hz: 1174.66, level: 0.6, attack_s: 0.016, decay_s: 0.17 },
    Tone { at_s: 0.11, freq_hz: 1177.46, level: 0.27, attack_s: 0.016, decay_s: 0.17 },
    Tone { at_s: 0.11, freq_hz: 2349.32, level: 0.05, attack_s: 0.01, decay_s: 0.05 },
];

/// Volume of a tone `u` seconds after it starts: a smooth rise to 1 in `attack`, then an exponential fall.
fn envelope(u: f64, attack: f64, decay: f64) -> f64 {
    if u < 0.0 {
        0.0
    } else if u < attack {
        0.5 * (1.0 - (std::f64::consts::PI * u / attack).cos())
    } else {
        (-(u - attack) / decay).exp()
    }
}

/// 1 until the last `FADE_OUT_S` of the sound, then a smooth fall to exactly 0 at `DURATION_S`.
fn fade_out(t: f64) -> f64 {
    let from = DURATION_S - FADE_OUT_S;
    if t <= from {
        1.0
    } else if t >= DURATION_S {
        0.0
    } else {
        0.5 * (1.0 + (std::f64::consts::PI * (t - from) / FADE_OUT_S).cos())
    }
}

/// The samples at volume `gain`, 16-bit mono, with the silence before and after the sound.
fn samples_at(gain: f64) -> Vec<i16> {
    let rate = f64::from(RATE);
    let lead = (LEAD_IN_S * rate).round() as usize;
    let tail = (TAIL_S * rate).round() as usize;
    let body = (DURATION_S * rate).round() as usize;
    let sound = (0..body).map(|i| {
        let t = i as f64 / rate;
        let mut v = 0.0;
        for tone in &TONES {
            let u = t - tone.at_s;
            if u > 0.0 {
                v += tone.level
                    * envelope(u, tone.attack_s, tone.decay_s)
                    * (std::f64::consts::TAU * tone.freq_hz * u).sin();
            }
        }
        (gain * v * fade_out(t) * f64::from(i16::MAX)).round() as i16
    });
    std::iter::repeat_n(0, lead).chain(sound).chain(std::iter::repeat_n(0, tail)).collect()
}

fn samples() -> Vec<i16> {
    samples_at(GAIN)
}

/// The sound as a WAV file (PCM, 16-bit mono).
fn wav_of(samples: &[i16]) -> Vec<u8> {
    let data_len = u32::try_from(samples.len() * 2).expect("a short sound");
    let mut out = Vec::with_capacity(44 + samples.len() * 2);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&RATE.to_le_bytes());
    out.extend_from_slice(&(RATE * 2).to_le_bytes()); // bytes per second
    out.extend_from_slice(&2u16.to_le_bytes()); // bytes per sample
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

/// Built once and kept for the whole run: `PlaySoundW` reads it while it plays, after returning.
fn wav() -> &'static [u8] {
    static WAV: OnceLock<Vec<u8>> = OnceLock::new();
    WAV.get_or_init(|| wav_of(&samples()))
}

/// Plays the sound without waiting for it to end. `true` if the system took it. A new sound cuts one still playing.
#[cfg(windows)]
pub fn play() -> bool {
    use windows_sys::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_MEMORY, SND_NODEFAULT};
    // SAFETY: with `SND_MEMORY` the first argument points to a whole WAV in memory, which lives until the process
    // ends (`wav`), so it outlives the asynchronous playback. `SND_NODEFAULT`: if it cannot play it, no system beep.
    unsafe { PlaySoundW(wav().as_ptr().cast(), std::ptr::null_mut(), SND_MEMORY | SND_ASYNC | SND_NODEFAULT) != 0 }
}

/// Linux and macOS: not played here (the UI uses Web Audio).
#[cfg(not(windows))]
pub fn play() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The gain in `design/sounds/sounds.json`, with which `luciernaga.wav` was made.
    const REFERENCE_GAIN: f64 = 0.1893;
    const REFERENCE_WAV: &[u8] = include_bytes!("../../../../design/sounds/luciernaga.wav");

    /// The samples of a 16-bit mono WAV file, found by its `data` chunk.
    fn pcm_of(wav: &[u8]) -> Vec<i16> {
        let mut at = 12;
        while &wav[at..at + 4] != b"data" {
            at += 8 + u32::from_le_bytes(wav[at + 4..at + 8].try_into().unwrap()) as usize;
        }
        let len = u32::from_le_bytes(wav[at + 4..at + 8].try_into().unwrap()) as usize;
        wav[at + 8..at + 8 + len].chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect()
    }

    #[test]
    fn the_wav_is_16_bit_mono_pcm_with_its_sizes() {
        let wav = wav();
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(wav[4..8].try_into().unwrap()) as usize, wav.len() - 8);
        assert_eq!(&wav[8..16], b"WAVEfmt ");
        assert_eq!(u16::from_le_bytes([wav[20], wav[21]]), 1, "PCM");
        assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1, "mono");
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), RATE);
        assert_eq!(u16::from_le_bytes([wav[34], wav[35]]), 16);
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()) as usize, wav.len() - 44);
    }

    #[test]
    fn it_is_the_reference_sound_sample_by_sample() {
        let reference = pcm_of(REFERENCE_WAV);
        let ours = samples_at(REFERENCE_GAIN);
        assert_eq!(ours.len(), reference.len());
        let worst = ours.iter().zip(&reference).map(|(a, b)| (i32::from(*a) - i32::from(*b)).abs()).max().unwrap();
        assert!(worst <= 1, "differs from luciernaga.wav by up to {worst} of 32768");
    }

    #[test]
    fn short_quiet_and_starting_and_ending_in_silence_without_a_click() {
        let s = samples();
        let rate = f64::from(RATE);
        let seconds = s.len() as f64 / rate;
        assert!((0.78..0.80).contains(&seconds), "{seconds} s: 10 ms of silence, 0.76 s of sound and 20 ms of silence");
        // The loudest point: -12 dBFS at the reference gain (± 0.3 dB), and in proportion to `GAIN`.
        let loudest = f64::from(s.iter().map(|v| v.unsigned_abs()).max().unwrap());
        let expected = GAIN / REFERENCE_GAIN * 10f64.powf(-12.0 / 20.0) * f64::from(i16::MAX);
        assert!((20.0 * (loudest / expected).log10()).abs() <= 0.3, "peak {loudest}, expected about {expected}");
        assert!(loudest < f64::from(i16::MAX), "it does not clip");
        let first = s.iter().position(|&v| v != 0).unwrap();
        let last = s.iter().rposition(|&v| v != 0).unwrap();
        assert!(first as f64 / rate >= 0.005 && (s.len() - 1 - last) as f64 / rate >= 0.005, "silence at both ends");
        assert!(s[first].unsigned_abs() <= 4 && s[last].unsigned_abs() <= 4, "no click when it starts or ends");
        let sounding = (last - first) as f64 / rate;
        assert!((0.72..0.79).contains(&sounding), "it sounds for {sounding} s");
    }

    #[test]
    fn the_envelope_and_the_fade_are_smooth() {
        assert_eq!(envelope(-0.001, 0.07, 0.14), 0.0);
        assert!(envelope(0.0, 0.07, 0.14).abs() < 1e-12);
        assert!((envelope(0.035, 0.07, 0.14) - 0.5).abs() < 1e-9);
        assert!((envelope(0.07, 0.07, 0.14) - 1.0).abs() < 1e-9);
        assert!((envelope(0.21, 0.07, 0.14) - (-1f64).exp()).abs() < 1e-9);
        assert_eq!(fade_out(DURATION_S - FADE_OUT_S), 1.0);
        assert!((fade_out(DURATION_S - FADE_OUT_S / 2.0) - 0.5).abs() < 1e-9);
        assert_eq!(fade_out(DURATION_S), 0.0);
    }
}
