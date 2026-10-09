#!/usr/bin/env python3
"""
Spoilaint real-speech bench: a fake "movie" made of real recorded human speech with hand-marked word
times (the TIMIT sample from NLTK's data: 160 sentences, 16 speakers).

    curl -L -o timit.zip https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/corpora/timit.zip
    unzip timit.zip
    python3 make_real_bench.py TIMIT_DIR OUTDIR [--seed N] [--laughs] [--snr DB]
        [--reverb RT60_S] [--babble DB] [--overlap] [--tempo X] [--level DB] [--surround] [--codec aac|ac3|opus|mp3]

Stress options: --reverb room echo on the dialogue; --babble crowd chatter (other voices) DB relative to the dialogue;
--overlap some lines start before the previous one ends (crosstalk); --tempo the whole film played faster/slower;
--level the whole mix turned down (quiet film); --surround 5.1 with dialogue in the centre; --codec the audio format.

Outputs: bench_stereo.mkv (stereo, dialogue in the middle, music/effects/laughs around it), bench.srt
(timed like a human subtitler: 0-350 ms before speech, 0.3-1.2 s after; some lines hold two sentences),
truth.json [{cue, word, at_ms}] (same format as make_bench.py, scored by score.py / evalenv.py).
"""
import json, os, random, subprocess, sys
import numpy as np
from scipy.io import wavfile

SR = 16000


def load_utts(root):
    utts = []
    for spk in sorted(os.listdir(root)):
        d = os.path.join(root, spk)
        if not os.path.isdir(d) or not spk.startswith("dr"):
            continue
        for f in sorted(os.listdir(d)):
            if not f.endswith(".wrd"):
                continue
            stem = f[:-4]
            wav, txt = os.path.join(d, stem + ".wav"), os.path.join(d, stem + ".txt")
            if not (os.path.exists(wav) and os.path.exists(txt)):
                continue
            words = [l.split() for l in open(os.path.join(d, f)) if l.strip()]
            words = [(int(a), int(b), w) for a, b, w in words]
            text = " ".join(open(txt).read().split()[2:])
            shown = text.split()
            if len(shown) != len(words):
                continue
            sr, data = wavfile.read(wav)
            assert sr == SR
            utts.append({"id": spk + "/" + stem, "audio": data.astype(np.float32) / 32768.0, "words": words, "shown": shown})
    return utts


def laugh(n, rng, g):
    out = np.zeros(n, np.float32)
    for _ in range(int(rng.uniform(6, 14))):
        f0, rate = rng.uniform(180, 360), rng.uniform(4.0, 6.5)
        t0, length = rng.uniform(0, 0.4), n / SR * rng.uniform(0.6, 1.0)
        a, b = int(t0 * SR), min(n, int((t0 + length) * SR))
        if b <= a:
            continue
        tt = np.arange(b - a) / SR
        voice = sum(np.sin(2 * np.pi * f0 * k * tt + g.uniform(0, 6)) / k for k in range(1, 8))
        bursts = np.clip(np.sin(2 * np.pi * rate * tt + g.uniform(0, 6)), 0, None) ** 2
        fade = np.minimum(1, (length - tt) / 0.8) * np.minimum(1, tt / 0.1)
        out[a:b] += ((0.6 * voice + g.normal(0, 0.4, b - a)) * bursts * fade * rng.uniform(0.02, 0.05)).astype(np.float32)
    return out


def main():
    root, out = sys.argv[1], sys.argv[2]
    seed = int(sys.argv[sys.argv.index("--seed") + 1]) if "--seed" in sys.argv else 7
    snr = float(sys.argv[sys.argv.index("--snr") + 1]) if "--snr" in sys.argv else 10.0
    laughs = "--laughs" in sys.argv
    opt = lambda k, d: float(sys.argv[sys.argv.index(k) + 1]) if k in sys.argv else d
    reverb, babble, tempo, level = opt("--reverb", 0), opt("--babble", None), opt("--tempo", 1.0), opt("--level", 0)
    overlap, surround = "--overlap" in sys.argv, "--surround" in sys.argv
    codec = sys.argv[sys.argv.index("--codec") + 1] if "--codec" in sys.argv else ("ac3" if surround else "aac")
    rng = random.Random(seed)
    g = np.random.default_rng(seed)
    os.makedirs(out, exist_ok=True)
    utts = load_utts(root)
    rng.shuffle(utts)

    # Lay the sentences out with gaps; trim each to 120 ms around its words.
    total = int(SR * (len(utts) * 6 + 10))
    speech = np.zeros(total, np.float32)
    t = 2.0
    lines = []
    for u in utts:
        a = max(0, u["words"][0][0] - int(0.12 * SR))
        b = min(len(u["audio"]), u["words"][-1][1] + int(0.12 * SR))
        clip = u["audio"][a:b]
        clip = clip / max(1e-6, np.sqrt(np.mean(clip ** 2))) * 0.08 * rng.uniform(0.6, 1.4)  # level varies by actor
        s = int(t * SR)
        speech[s:s + len(clip)] += clip
        words = [{"text": shown, "at": t + (wa - a) / SR, "end": t + (wb - a) / SR} for (wa, wb, _), shown in zip(u["words"], u["shown"])]
        lines.append({"words": words})
        gap = rng.uniform(0.25, 3.0)
        if overlap and rng.random() < 0.25: gap = -rng.uniform(0.1, 0.5)  # the next speaker cuts in
        t += len(clip) / SR + gap
    n = int((t + 3) * SR)
    speech = speech[:n]
    if reverb > 0:
        # room echo: exponentially decaying noise as the room's impulse response (RT60 = reverb seconds)
        L = int(reverb * SR)
        rir = g.normal(0, 1, L).astype(np.float32) * np.exp(-6.9 * np.arange(L) / L).astype(np.float32)
        rir[0] = 4.0
        rir /= np.sqrt(np.sum(rir ** 2))
        from scipy.signal import fftconvolve
        speech = fftconvolve(speech, rir)[:n].astype(np.float32)
    babble_track = np.zeros(n, np.float32)
    if babble is not None:
        # other voices talking in the background the whole time (3 at once)
        pool = [u["audio"] for u in utts]
        for _ in range(3):
            pos = 0
            while pos < n:
                a = pool[int(rng.random() * len(pool))]
                a = a / max(1e-6, np.sqrt(np.mean(a ** 2)))
                m = min(len(a), n - pos)
                babble_track[pos:pos + m] += a[:m]
                pos += m
        sp = np.sqrt(np.mean(speech[np.abs(speech) > 1e-4] ** 2))
        babble_track *= sp / max(1e-6, np.sqrt(np.mean(babble_track ** 2))) * (10 ** (babble / 20))
    tt = np.arange(n) / SR

    # Background: wide music bed, noise, effects in gaps, optional laugh track after lines.
    chords = [(220, 277, 330), (196, 247, 294), (174, 220, 262), (165, 208, 247)]
    music_l = np.zeros(n, np.float32); music_r = np.zeros(n, np.float32)
    for k in range(0, int(n / SR / 4) + 1):
        a, b = int(k * 4 * SR), min(n, int((k + 1) * 4 * SR))
        for f in chords[k % 4]:
            music_l[a:b] += 0.05 * np.sin(2 * np.pi * f * tt[a:b])
        for f in chords[(k + 1) % 4]:
            music_r[a:b] += 0.05 * np.sin(2 * np.pi * f * 1.5 * tt[a:b] + 1.3)
    swell = (0.6 + 0.4 * np.sin(2 * np.pi * 0.05 * tt)).astype(np.float32)
    music_l *= swell; music_r *= swell
    fx = np.zeros(n, np.float32)
    lt = np.zeros(n, np.float32)
    for li in range(len(lines) - 1):
        ga, gb = lines[li]["words"][-1]["end"] + 0.2, lines[li + 1]["words"][0]["at"] - 0.2
        if gb - ga > 0.5 and rng.random() < 0.4:
            s, ln = int(rng.uniform(ga, gb - 0.3) * SR), int(0.25 * SR)
            fx[s:s + ln] += g.normal(0, 0.25, ln).astype(np.float32) * np.hanning(ln).astype(np.float32)
        if laughs and rng.random() < 0.6:
            s = int((lines[li]["words"][-1]["end"] + rng.uniform(0.05, 0.5)) * SR)
            ln = int(rng.uniform(1.5, 3.5) * SR)
            seg = laugh(ln, rng, g)
            lt[s:s + len(seg)] += seg[: max(0, min(len(seg), n - s))]
    bed_l = music_l * 0.8 + music_r * 0.3 + g.normal(0, 0.01, n).astype(np.float32) + fx * 0.9
    bed_r = music_r * 0.8 + music_l * 0.3 + g.normal(0, 0.01, n).astype(np.float32) + fx * 0.4
    # Set the bed so dialogue sits `snr` dB above it (RMS of the talking parts vs the bed).
    sp_rms = np.sqrt(np.mean(speech[np.abs(speech) > 1e-4] ** 2))
    bed_rms = np.sqrt(np.mean(((bed_l + bed_r) / 2) ** 2))
    k = sp_rms / max(bed_rms, 1e-6) / (10 ** (snr / 20))
    bed_l *= k; bed_r *= k
    if laughs:
        lr = np.sqrt(np.mean(lt[np.abs(lt) > 1e-4] ** 2))
        lt *= sp_rms / max(lr, 1e-6)  # as loud as the dialogue (sitcom mix)
        bed_l += lt; bed_r += lt * 0.9
    bed_l += babble_track * 0.8; bed_r += babble_track * 0.8
    if surround:
        # 5.1 (FL FR FC LFE BL BR): dialogue in the centre with a little bleed into the fronts, bed everywhere
        mix = np.stack([bed_l + speech * 0.15, bed_r + speech * 0.15, speech + (bed_l + bed_r) * 0.1, (music_l + music_r) * 0.3 * k,
                        bed_l * 0.6, bed_r * 0.6], axis=1)
    else:
        mix = np.stack([bed_l + speech * 0.7, bed_r + speech * 0.7], axis=1)
    mix /= max(1.0, np.abs(mix).max() / 0.95)
    mix *= 10 ** (-abs(level) / 20)  # a quiet film
    wav = os.path.join(out, "_mix.wav")
    wavfile.write(wav, SR, (mix * 32767).astype(np.int16))
    total_s = n / SR
    af = ["-af", f"atempo={tempo}"] if tempo != 1.0 else []
    ca = {"aac": ["-c:a", "aac", "-b:a", "160k"], "ac3": ["-c:a", "ac3", "-b:a", "448k"], "opus": ["-c:a", "libopus", "-b:a", "96k"],
          "mp3": ["-c:a", "libmp3lame", "-b:a", "128k"]}[codec]
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c=0x241A12:s=320x180:r=5:d={total_s / tempo:.2f}",
                    "-i", wav, "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast"] + af + ca +
                   ["-shortest", os.path.join(out, "bench_stereo.mkv")], check=True)
    os.remove(wav)

    # Subtitles: some cues hold two sentences (a real pause inside one line, the hard case).
    cues, truth, i = [], [], 0
    while i < len(lines):
        group = [lines[i]]
        if i + 1 < len(lines) and rng.random() < 0.15 and lines[i + 1]["words"][0]["at"] - lines[i]["words"][-1]["end"] < 1.5:
            group.append(lines[i + 1]); i += 1
        i += 1
        words = [w for l in group for w in l["words"]]
        start = words[0]["at"] - rng.uniform(0.0, 0.35)
        end = max(words[-1]["end"] + rng.uniform(0.3, 1.2), start + 1.0)
        if cues and start < cues[-1]["end"] + 0.08:
            start = cues[-1]["end"] + 0.08
        text = " ".join(w["text"] for w in words)
        # two rows like real subtitles
        parts = text.split()
        if len(text) > 42:
            half = len(parts) // 2
            text = " ".join(parts[:half]) + "\n" + " ".join(parts[half:])
        cues.append({"start": start, "end": end, "text": text})
        for wi, w in enumerate(words):
            truth.append({"cue": len(cues) - 1, "word": wi, "text": w["text"], "at_ms": round(w["at"] * 1000 / tempo)})

    def ts(x):
        ms = int(round(x * 1000)); h, ms = divmod(ms, 3600000); m, ms = divmod(ms, 60000); s, ms = divmod(ms, 1000)
        return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"
    with open(os.path.join(out, "bench.srt"), "w", encoding="utf-8") as f:
        for k, c in enumerate(cues):
            f.write(f"{k + 1}\n{ts(c['start'] / tempo)} --> {ts(c['end'] / tempo)}\n{c['text']}\n\n")
    json.dump(truth, open(os.path.join(out, "truth.json"), "w"), indent=0)
    extra = [x for x in [laughs and "laugh track", reverb and f"echo {reverb:.1f}s", babble is not None and f"chatter {babble:+.0f} dB",
                         overlap and "crosstalk", tempo != 1.0 and f"tempo {tempo}x", level and f"level -{abs(level):.0f} dB",
                         surround and "5.1", codec] if x]
    print(f"{len(cues)} lines, {len(truth)} words, {total_s / tempo / 60:.1f} min, dialogue {snr:+.0f} dB over the bed, " + ", ".join(extra))


if __name__ == "__main__":
    main()
