#!/usr/bin/env python3
"""Renders the new-mail sound proposals of NightMail and checks them.

The sounds are described in sounds.json as lists of sine tones. This script is the only source of the WAV files:
it adds the tones up, writes one 16-bit mono file per sound next to sounds.json, reads each file back and checks
that it is short, quiet, free of clipping and silent at both ends. Standard library only.

    python3 tools/render.py                 # write the WAV files and check them
    python3 tools/render.py check a.wav ... # check existing WAV files against the same limits
    python3 tools/render.py gain            # print the gain each sound needs to reach the target peak
"""
import json
import math
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC = ROOT / 'sounds.json'
FULL_SCALE = 32768
# A sound "lasts" while it stays above this level. Below it, at the volume of a notification, nothing is heard.
AUDIBLE_DBFS = -60.0
# The first and the last audible samples must be this close to zero, so the sound starts and ends without a click.
EDGE_STEP = 4


def envelope(u, attack, decay):
    """Volume of a tone `u` seconds after its start: a smooth rise to 1 in `attack`, then a fall with time
    constant `decay` (it loses 8.7 dB every `decay` seconds)."""
    if u < 0:
        return 0.0
    if u < attack:
        return 0.5 * (1 - math.cos(math.pi * u / attack))
    return math.exp(-(u - attack) / decay)


def fade_out(t, duration, fade):
    """1 until the last `fade` seconds of the sound, then a smooth fall to exactly 0 at `duration`."""
    if t <= duration - fade:
        return 1.0
    if t >= duration:
        return 0.0
    return 0.5 * (1 + math.cos(math.pi * (t - (duration - fade)) / fade))


def synthesise(sound, rate, gain=None):
    """The sound as numbers between -1 and 1, without the silence around it."""
    gain = sound['gain'] if gain is None else gain
    duration, fade = sound['duration_s'], sound['fade_out_s']
    out = []
    for i in range(round(duration * rate)):
        t = i / rate
        v = 0.0
        for tone in sound['tones']:
            u = t - tone['at_s']
            if u > 0:
                v += tone['level'] * envelope(u, tone['attack_s'], tone['decay_s']) * math.sin(math.tau * tone['freq_hz'] * u)
        out.append(gain * v * fade_out(t, duration, fade))
    return out


def to_pcm(values, fmt):
    """16-bit samples, with the silence of the file before and after the sound."""
    rate = fmt['sample_rate_hz']
    lead, tail = round(fmt['lead_in_s'] * rate), round(fmt['tail_s'] * rate)
    return [0] * lead + [round(v * (FULL_SCALE - 1)) for v in values] + [0] * tail


def write_wav(path, pcm, fmt):
    with wave.open(str(path), 'wb') as out:
        out.setnchannels(fmt['channels'])
        out.setsampwidth(fmt['bits'] // 8)
        out.setframerate(fmt['sample_rate_hz'])
        out.writeframes(b''.join(s.to_bytes(2, 'little', signed=True) for s in pcm))


def read_wav(path):
    with wave.open(str(path), 'rb') as src:
        shape = {'sample_rate_hz': src.getframerate(), 'bits': src.getsampwidth() * 8, 'channels': src.getnchannels()}
        raw = src.readframes(src.getnframes())
    if shape['bits'] != 16 or shape['channels'] != 1:
        sys.exit(f'{path}: expected 16-bit mono, found {shape["bits"]}-bit with {shape["channels"]} channel(s)')
    return shape, [int.from_bytes(raw[i:i + 2], 'little', signed=True) for i in range(0, len(raw), 2)]


def dbfs(amplitude):
    return 20 * math.log10(amplitude / FULL_SCALE) if amplitude > 0 else -math.inf


def analyse(pcm, rate):
    """What matters about a rendered sound, measured on its samples."""
    floor = FULL_SCALE * 10 ** (AUDIBLE_DBFS / 20)
    loud = [i for i, s in enumerate(pcm) if abs(s) > floor]
    nonzero = [i for i, s in enumerate(pcm) if s != 0]
    first, last = nonzero[0], nonzero[-1]
    body = pcm[loud[0]:loud[-1] + 1]
    return {
        'peak': max(abs(s) for s in pcm),
        'peak_dbfs': dbfs(max(abs(s) for s in pcm)),
        'rms_dbfs': dbfs(math.sqrt(sum(s * s for s in body) / len(body))),
        'file_s': len(pcm) / rate,
        'sounding_s': len(body) / rate,
        'lead_silence_s': first / rate,
        'tail_silence_s': (len(pcm) - 1 - last) / rate,
        'first_step': abs(pcm[first]),
        'last_step': abs(pcm[last]),
        'dc': sum(pcm) / len(pcm),
    }


def problems(facts, shape, fmt, limits):
    """The requirements a sound does not meet (none if the list is empty)."""
    found = []
    for key in ('sample_rate_hz', 'bits', 'channels'):
        if shape[key] != fmt[key]:
            found.append(f'{key} is {shape[key]}, expected {fmt[key]}')
    if facts['peak'] >= FULL_SCALE - 1:
        found.append('it clips')
    if abs(facts['peak_dbfs'] - limits['peak_dbfs']) > limits['peak_tolerance_db']:
        found.append(f'peak {facts["peak_dbfs"]:.2f} dBFS, expected {limits["peak_dbfs"]} ± {limits["peak_tolerance_db"]}')
    if facts['sounding_s'] < limits['min_sounding_s']:
        found.append(f'it sounds for {facts["sounding_s"]:.3f} s, less than {limits["min_sounding_s"]} s')
    if facts['file_s'] > limits['max_file_s']:
        found.append(f'the file lasts {facts["file_s"]:.3f} s, more than {limits["max_file_s"]} s')
    if facts['lead_silence_s'] < limits['min_edge_silence_s'] or facts['tail_silence_s'] < limits['min_edge_silence_s']:
        found.append(f'less than {limits["min_edge_silence_s"]} s of silence at one end')
    if facts['first_step'] > EDGE_STEP or facts['last_step'] > EDGE_STEP:
        found.append(f'it starts or ends with a step ({facts["first_step"]} and {facts["last_step"]} of {FULL_SCALE})')
    if abs(facts['dc']) > 1:
        found.append(f'it is off centre by {facts["dc"]:.2f}')
    return found


def report(name, facts, found):
    print(
        f'{name:<28} peak {facts["peak_dbfs"]:6.2f} dBFS  rms {facts["rms_dbfs"]:6.2f} dBFS  '
        f'file {facts["file_s"]:.3f} s  sounding {facts["sounding_s"]:.3f} s  '
        f'silence {facts["lead_silence_s"] * 1000:.1f} + {facts["tail_silence_s"] * 1000:.1f} ms  '
        + ('OK' if not found else 'FAILS')
    )
    for line in found:
        print(f'  - {line}')


def main(args):
    spec = json.loads(SPEC.read_text(encoding='utf-8'))
    fmt, limits = spec['format'], spec['limits']
    rate = fmt['sample_rate_hz']
    failed = False
    if args[:1] == ['gain']:
        target = 10 ** (limits['peak_dbfs'] / 20)
        for sound in spec['sounds']:
            print(f'{sound["name"]}: gain {target / max(abs(v) for v in synthesise(sound, rate, gain=1.0)):.4f}')
        return
    if args[:1] == ['check']:
        paths = [Path(p) for p in args[1:]]
    else:
        paths = []
        for sound in spec['sounds']:
            paths.append(ROOT / f'{sound["name"]}.wav')
            write_wav(paths[-1], to_pcm(synthesise(sound, rate), fmt), fmt)
    for path in paths:
        shape, pcm = read_wav(path)
        facts = analyse(pcm, shape['sample_rate_hz'])
        found = problems(facts, shape, fmt, limits)
        report(path.name, facts, found)
        failed = failed or bool(found)
    if failed:
        sys.exit(1)
    print('OK')


if __name__ == '__main__':
    main(sys.argv[1:])
