#!/usr/bin/env python3
"""
Spoilaint speech bench: builds a fake "movie" whose dialogue timing is known exactly.

Every word is synthesised on its own (espeak-ng) and placed at a known time, so we know when each
word is really spoken. Background music and sound effects are mixed in like a film, and the .srt
is timed the way human subtitlers do it (lines start a little before speech, linger after).

Outputs (in the folder given):
  bench.mkv        video + 5.1 audio (dialogue in the centre channel) + same audio as stereo track 2
  bench_stereo.mkv video + stereo audio only (dialogue mixed into both sides)
  bench.srt        subtitles
  truth.json       [{cue, word, at_ms}] the moment each word starts being spoken

Usage: python3 make_bench.py OUTDIR [--seed N] [--connected] [--laughs]   (--connected: words run into each other; --laughs: sitcom laugh track as loud as the dialogue)
"""
import json, os, random, subprocess, sys, tempfile
import numpy as np
from scipy.io import wavfile

SR = 16000

LINES = [
    ("en-us+m3", 165, "I checked the logs twice, and the door was never opened."),
    ("en-us+f3", 175, "So whoever took it... was already inside."),
    ("en-us+m3", 160, "Then it's one of us."),
    ("en-us+f3", 180, "Don't look at me like that. I was asleep the whole night."),
    ("en-us+m3", 150, "Somebody wasn't."),
    ("en-us+f3", 170, "Fine. Ask Daniel where he went at two in the morning."),
    ("en-us+m3", 185, "He told me he was getting water, but the kitchen light never came on."),
    ("en-us+f3", 160, "You noticed that? You were awake?"),
    ("en-us+m3", 170, "I couldn't sleep. Not after what happened yesterday."),
    ("en-us+f3", 190, "Okay, okay. Let's not turn on each other. Not yet."),
    ("en-us+m3", 155, "We need to check the cameras before anyone else does."),
    ("en-us+f3", 175, "The cameras were switched off at one forty five."),
    ("en-us+m3", 165, "By who?"),
    ("en-us+f3", 170, "By someone with the code. Only three people have it."),
    ("en-us+m3", 180, "You, me, and the person we trusted most."),
    ("hi", 150, "मुझे पता था... तुम ही हो।"),
    ("en-us+f3", 165, "Wait. Listen. Do you hear that?"),
    ("en-us+m3", 175, "It's coming from the basement. Stay behind me."),
    ("en-us+f3", 160, "If this goes wrong, I want you to know something."),
    ("en-us+m3", 170, "Tell me later. Right now we move."),
]
# Lines joined into one subtitle (two sentences with a real pause inside one cue) - the hard case.
JOIN = {(2, 3), (11, 12)}


def synth(text, voice, rate):
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        path = f.name
    subprocess.run(["espeak-ng", "-v", voice, "-s", str(rate), "-w", path, text], check=True)
    sr, data = wavfile.read(path)
    os.remove(path)
    data = data.astype(np.float32) / 32768.0
    if data.ndim > 1:
        data = data.mean(axis=1)
    if sr != SR:
        n = int(len(data) * SR / sr)
        data = np.interp(np.linspace(0, len(data) - 1, n), np.arange(len(data)), data).astype(np.float32)
    # Trim silence so we know where the word really starts.
    env = np.abs(data)
    thr = max(env.max() * 0.04, 1e-4)
    idx = np.where(env > thr)[0]
    if len(idx) == 0:
        return np.zeros(1, np.float32)
    return data[max(0, idx[0] - 16): idx[-1] + 160]


def pause_after(word, rng):
    w = word.rstrip('"\')')
    if w.endswith("...") or w.endswith("…"):
        return rng.uniform(0.55, 0.9)
    if w[-1:] in ".!?।":
        return rng.uniform(0.35, 0.6)
    if w[-1:] in ",;:":
        return rng.uniform(0.15, 0.3)
    return rng.uniform(-0.05, 0.0) if CONNECTED else rng.uniform(0.02, 0.07)


CONNECTED = False


def laugh_track(n, lines, rng, seed):
    """Sitcom audience: crowds of 'ha-ha' bursts (voiced, syllable-paced) after most lines."""
    out = np.zeros(n, np.float32)
    g = np.random.default_rng(seed + 99)
    for li, line in enumerate(lines):
        if rng.random() > 0.65:
            continue
        start = line["words"][-1]["end"] + rng.uniform(0.05, 0.5)
        dur = rng.uniform(1.5, 3.5)
        for person in range(int(rng.uniform(6, 14))):
            f0 = rng.uniform(180, 360)
            rate = rng.uniform(4.0, 6.5)                    # 'ha's per second
            t0 = start + rng.uniform(0, 0.4)
            length = dur * rng.uniform(0.6, 1.0)
            a, b = int(t0 * SR), min(n, int((t0 + length) * SR))
            if b <= a:
                continue
            tt = np.arange(b - a) / SR
            # glottal-ish pulse train (harmonics) shaped by 'ha' bursts and a fade-out
            voice = sum(np.sin(2 * np.pi * f0 * k * tt + g.uniform(0, 6)) / k for k in range(1, 8))
            breath = g.normal(0, 0.4, b - a)
            bursts = np.clip(np.sin(2 * np.pi * rate * tt + g.uniform(0, 6)), 0, None) ** 2
            fade = np.minimum(1, (length - tt) / 0.8) * np.minimum(1, tt / 0.1)
            out[a:b] += ((0.6 * voice + breath) * bursts * fade * rng.uniform(0.02, 0.05)).astype(np.float32)
    return out


def main():
    global CONNECTED
    CONNECTED = "--connected" in sys.argv
    LAUGHS = "--laughs" in sys.argv
    out = sys.argv[1]
    seed = int(sys.argv[sys.argv.index("--seed") + 1]) if "--seed" in sys.argv else 7
    rng = random.Random(seed)
    os.makedirs(out, exist_ok=True)

    t = 2.0
    speech = np.zeros(int(SR * 400), np.float32)
    lines = []  # each: {voice, words: [{text, at, end}]}
    for li, (voice, rate, text) in enumerate(LINES):
        words = []
        toks = text.split()
        for wi, w in enumerate(toks):
            audio = synth(w, voice, rate) * rng.uniform(0.7, 1.0)
            start = int(t * SR)
            if start < 0: start = 0
            speech[start:start + len(audio)] += audio
            words.append({"text": w, "at": t, "end": t + len(audio) / SR})
            t += len(audio) / SR
            if wi < len(toks) - 1:
                t += pause_after(w, rng)
        lines.append({"voice": voice, "words": words})
        t += rng.uniform(0.8, 3.5)
    total = t + 3.0
    speech = speech[: int(total * SR)]
    n = len(speech)
    tt = np.arange(n) / SR

    # Music bed: slow chords + bass, with a loud swell in some silent stretches.
    music = np.zeros(n, np.float32)
    chords = [(220, 277, 330), (196, 247, 294), (174, 220, 262), (165, 208, 247)]
    for k in range(0, int(total / 4) + 1):
        a, b = int(k * 4 * SR), min(n, int((k + 1) * 4 * SR))
        for f in chords[k % 4]:
            music[a:b] += 0.05 * np.sin(2 * np.pi * f * tt[a:b])
        music[a:b] += 0.06 * np.sin(2 * np.pi * chords[k % 4][0] / 2 * tt[a:b])
    music *= 0.6 + 0.4 * np.sin(2 * np.pi * 0.05 * tt)  # slow swells
    noise = np.random.default_rng(seed).normal(0, 0.01, n).astype(np.float32)
    # Sound effects: bursts of noise between lines.
    fx = np.zeros(n, np.float32)
    for li in range(len(lines) - 1):
        gap_a = lines[li]["words"][-1]["end"] + 0.3
        gap_b = lines[li + 1]["words"][0]["at"] - 0.3
        if gap_b - gap_a > 0.5 and rng.random() < 0.5:
            s = int(rng.uniform(gap_a, gap_b - 0.3) * SR)
            ln = int(0.25 * SR)
            burst = np.random.default_rng(li).normal(0, 0.25, ln).astype(np.float32) * np.hanning(ln).astype(np.float32)
            fx[s:s + ln] += burst

    speech_n = speech / max(1e-6, np.abs(speech).max()) * 0.5
    bed = music + noise + fx
    if LAUGHS:
        laughs = laugh_track(n, lines, rng, seed)
        # As loud as the dialogue (a Friends-style mix): match RMS of the active parts.
        ls = np.sqrt(np.mean(laughs[np.abs(laughs) > 1e-4] ** 2)) if np.any(np.abs(laughs) > 1e-4) else 1
        ss = np.sqrt(np.mean(speech_n[np.abs(speech_n) > 1e-4] ** 2))
        bed = bed + laughs * (ss / max(ls, 1e-6))
    # 5.1: FL FR FC LFE BL BR. Dialogue in the centre, bed everywhere.
    fl = bed; fr = bed * 0.95; fc = speech_n + bed * 0.15; lfe = music * 0.5; bl = bed * 0.5; br = bed * 0.5
    six = np.stack([fl, fr, fc, lfe, bl, br], axis=1)
    # Film music is wide: different notes and noise left and right; effects panned.
    music_r = np.zeros(n, np.float32)
    for k in range(0, int(total / 4) + 1):
        a, b = int(k * 4 * SR), min(n, int((k + 1) * 4 * SR))
        for f in chords[(k + 1) % 4]:
            music_r[a:b] += 0.05 * np.sin(2 * np.pi * f * 1.5 * tt[a:b] + 1.3)
    music_r *= 0.6 + 0.4 * np.sin(2 * np.pi * 0.05 * tt + 1.0)
    noise_r = np.random.default_rng(seed + 1).normal(0, 0.01, n).astype(np.float32)
    left = music * 0.8 + music_r * 0.3 + noise + fx * 0.9
    right = music_r * 0.8 + music * 0.3 + noise_r + fx * 0.4
    stereo = np.stack([left + speech_n * 0.7, right + speech_n * 0.7], axis=1)
    def save(path, arr):
        arr = np.clip(arr, -1, 1)
        wavfile.write(path, SR, (arr * 32767).astype(np.int16))
    save(os.path.join(out, "_six.wav"), six)
    save(os.path.join(out, "_stereo.wav"), stereo)
    vid = ["-f", "lavfi", "-i", f"color=c=0x241A12:s=640x360:r=10:d={total:.2f}"]
    subprocess.run(["ffmpeg", "-v", "error", "-y", *vid, "-i", os.path.join(out, "_six.wav"),
                    "-i", os.path.join(out, "_stereo.wav"),
                    "-map", "0:v", "-map", "1:a", "-map", "2:a", "-c:v", "libx264", "-preset", "ultrafast",
                    "-c:a", "ac3", "-b:a", "384k", "-shortest", os.path.join(out, "bench.mkv")], check=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", *vid, "-i", os.path.join(out, "_stereo.wav"),
                    "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
                    "-shortest", os.path.join(out, "bench_stereo.mkv")], check=True)
    os.remove(os.path.join(out, "_six.wav")); os.remove(os.path.join(out, "_stereo.wav"))

    # Subtitles, timed like a human subtitler: start 0-350 ms before speech, end 0.3-0.9 s after.
    cues, truth, i = [], [], 0
    while i < len(lines):
        group = [lines[i]]
        if (i, i + 1) in JOIN:
            group.append(lines[i + 1]); i += 1
        i += 1
        first = group[0]["words"][0]["at"]; last = group[-1]["words"][-1]["end"]
        start = max(0, first - rng.uniform(0.0, 0.35))
        end = last + rng.uniform(0.3, 0.9)
        end = max(end, start + 1.2)
        text = "\n".join(" ".join(w["text"] for w in g["words"]) for g in group) if len(group) > 1 else \
            " ".join(w["text"] for w in group[0]["words"])
        ci = len(cues)
        cues.append((start, end, text))
        for g in group:
            for w in g["words"]:
                truth.append({"cue": ci, "word": w["text"], "at_ms": round(w["at"] * 1000)})
    # Keep cues from overlapping.
    for k in range(len(cues) - 1):
        if cues[k][1] > cues[k + 1][0] - 0.05:
            cues[k] = (cues[k][0], cues[k + 1][0] - 0.05, cues[k][2])

    def ts(s):
        ms = int(round(s * 1000)); h, ms = divmod(ms, 3600000); m, ms = divmod(ms, 60000); sec, ms = divmod(ms, 1000)
        return f"{h:02d}:{m:02d}:{sec:02d},{ms:03d}"
    with open(os.path.join(out, "bench.srt"), "w", encoding="utf-8") as f:
        for k, (s, e, text) in enumerate(cues):
            f.write(f"{k + 1}\n{ts(s)} --> {ts(e)}\n{text}\n\n")
    with open(os.path.join(out, "truth.json"), "w", encoding="utf-8") as f:
        json.dump(truth, f, ensure_ascii=False)
    print(f"{len(cues)} cues, {len(truth)} words, {total:.1f}s")


if __name__ == "__main__":
    main()
