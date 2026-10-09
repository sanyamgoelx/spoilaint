#!/usr/bin/env python3
"""
Prototype of Spoilaint's forced aligner (reference for the C# and JS ports).

    python3 ctc_align.py MODEL_DIR movie_audio.(mkv|wav) subs.srt out.tsv [--lua ../vlc/spoilaint.lua]

For every subtitle line: cut the audio around it, compute 80-band log-mel features (Kaldi-style, written
out by hand so the ports can copy it), run the CTC model, and find the best path through the line's
known tokens (Viterbi forced alignment). A word starts where its first token starts. Lines that don't fit
the audio (low confidence) keep the estimate.
TSV out: cue idx word estimate_ms aligned_ms
"""
import math, re, subprocess, sys, time
import numpy as np
import onnxruntime as ort

SR = 16000
FRAME_MS = 40  # model output step (10 ms features, subsampled 4x)
CONF = float(sys.argv[sys.argv.index("--conf") + 1]) if "--conf" in sys.argv else -4.0


# ---------------------------------------------------------------- features (Kaldi fbank, 80 bins)
def mel_banks(n_fft=512, bins=80, low=20.0, high=8000.0):
    def mel(f): return 1127.0 * np.log(1.0 + f / 700.0)
    nf = n_fft // 2
    fft_freqs = np.arange(nf) * SR / n_fft
    ml, mh = mel(low), mel(high)
    delta = (mh - ml) / (bins + 1)
    m = mel(fft_freqs)
    banks = np.zeros((bins, nf + 1), np.float32)
    for b in range(bins):
        left, center, right = ml + b * delta, ml + (b + 1) * delta, ml + (b + 2) * delta
        up = (m - left) / (center - left)
        down = (right - m) / (right - center)
        w = np.maximum(0, np.minimum(up, down))
        w[(m <= left) | (m >= right)] = 0
        banks[b, :nf] = w
    return banks

BANKS = mel_banks()
WIN = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(400) / 399)) ** 0.85  # Povey window


def fbank(samples):
    """samples: float32 in [-1, 1] at 16 kHz -> (T, 80) log-mel, normalised per band."""
    x = samples.astype(np.float64) * 32768.0
    n = len(x)
    T = (n + 80) // 160
    if T < 1:
        return np.zeros((0, 80), np.float32)
    # snip_edges = false: frame t is centred on t*160 + 80, edges reflected
    pad = np.concatenate([x[:200][::-1], x, x[-400:][::-1]])
    idx = np.arange(T)[:, None] * 160 + 80 - 200 + 200 + np.arange(400)[None, :]
    fr = pad[idx]
    fr = fr - fr.mean(axis=1, keepdims=True)
    fr = np.concatenate([fr[:, :1] - 0.97 * fr[:, :1], fr[:, 1:] - 0.97 * fr[:, :-1]], axis=1)
    fr = fr * WIN
    spec = np.abs(np.fft.rfft(fr, 512)) ** 2
    feat = np.log(np.maximum(spec @ BANKS.T, 1.1920929e-07)).astype(np.float32)
    mean, std = feat.mean(axis=0, keepdims=True), feat.std(axis=0, keepdims=True)
    return (feat - mean) / (std + 1e-5)


# ---------------------------------------------------------------- text -> tokens
ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()


def say_number(n):
    if n < 20: return ONES[n]
    if n < 100: return TENS[n // 10] + ("" if n % 10 == 0 else " " + ONES[n % 10])
    if n < 1000: return ONES[n // 100] + " hundred" + ("" if n % 100 == 0 else " " + say_number(n % 100))
    if n < 1000000: return say_number(n // 1000) + " thousand" + ("" if n % 1000 == 0 else " " + say_number(n % 1000))
    return " ".join(ONES[int(d)] for d in str(n))


def say_digits(s):
    n = int(s)
    if len(s) == 4 and 1100 <= n <= 2099 and n % 1000 >= 10:  # years: 1999 -> nineteen ninety nine
        return say_number(n // 100) + " " + (("oh " + ONES[n % 100]) if n % 100 < 10 else say_number(n % 100))
    return say_number(n)


def spoken_form(word):
    w = word.lower().replace("’", "'").replace("‘", "'")
    w = re.sub(r"\d+", lambda m: " " + say_digits(m.group(0)) + " ", w)
    w = w.replace("&", " and ").replace("%", " percent ")
    w = re.sub(r"[^a-z' ]+", " ", w)
    return [p.strip("'") for p in w.split() if p.strip("'")]


class Tokens:
    def __init__(self, path):
        self.id = {}
        for l in open(path, encoding="utf-8"):
            sym, i = l.rstrip("\n").rsplit(" ", 1)
            self.id[sym] = int(i)
        self.blank = max(self.id.values())
        self.maxlen = max(len(s) for s in self.id)

    def encode_word(self, w):
        """Greedy longest match; the first piece carries the word-start mark."""
        out, s, pos = [], "▁" + w, 0
        while pos < len(s):
            for L in range(min(self.maxlen, len(s) - pos), 0, -1):
                piece = s[pos:pos + L]
                if piece in self.id and piece != "<unk>":
                    out.append(self.id[piece]); pos += L; break
            else:
                pos += 1  # character the model doesn't know
        return out


# ---------------------------------------------------------------- forced alignment
def force_align(logp, toks):
    """CTC Viterbi. logp (T, V), toks list of ids. Returns (first frame of each token, per-token score)."""
    T, L = logp.shape[0], len(toks)
    S = 2 * L + 1
    if T < L:
        return None
    blank = logp.shape[1] - 1
    lab = np.full(S, blank); lab[1::2] = toks
    NEG = -1e30
    dp = np.full((T, S), NEG, np.float32)
    bp = np.zeros((T, S), np.int8)
    dp[0, 0] = logp[0, blank]; dp[0, 1] = logp[0, toks[0]]
    can_skip = np.zeros(S, bool)
    for s in range(3, S, 2):
        can_skip[s] = lab[s] != lab[s - 2]
    for t in range(1, T):
        prev = dp[t - 1]
        stay = prev
        step = np.concatenate([[NEG], prev[:-1]])
        skip = np.concatenate([[NEG, NEG], prev[:-2]])
        skip = np.where(can_skip, skip, NEG)
        best = np.maximum(np.maximum(stay, step), skip)
        choice = np.where(best == stay, 0, np.where(best == step, 1, 2))
        dp[t] = best + logp[t, lab]
        bp[t] = choice
    s = S - 1 if dp[T - 1, S - 1] >= dp[T - 1, S - 2] else S - 2
    path = np.zeros(T, np.int32)
    for t in range(T - 1, -1, -1):
        path[t] = s
        s -= bp[t, s]
    first = [None] * L
    score = [0.0] * L
    for t in range(T):
        st = path[t]
        if st % 2 == 1:
            k = st // 2
            if first[k] is None: first[k] = t
            score[k] = max(score[k], float(logp[t, toks[k]])) if score[k] != 0.0 else float(logp[t, toks[k]])
    return first, score


def load_audio(path):
    pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-f", "s16le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(pcm, np.int16).astype(np.float32) / 32768.0


def main():
    model_dir, media, srt, out = sys.argv[1:5]
    import json
    lua = sys.argv[sys.argv.index("--lua") + 1] if "--lua" in sys.argv else "../vlc/spoilaint.lua"
    lat = int(sys.argv[sys.argv.index("--lat") + 1]) if "--lat" in sys.argv else 0
    # Cues + estimated words from the real VLC script (so word lists match exactly).
    est = subprocess.run(["lua5.1", "-e", f"""
        local M = dofile('{lua}')
        local f = io.open('{srt}', 'rb'); local d = f:read('*a'); f:close()
        for ci, c in ipairs(M.parseSubs(M.toUTF8(d))) do
          for wi, w in ipairs(M.estimateWords(c)) do
            print(table.concat({{ci-1, wi-1, w.text, w.at, c.start, c['end'], w.inst and 1 or 0}}, '\\t'))
          end
        end"""], capture_output=True, text=True, check=True).stdout
    cues = {}
    for l in est.splitlines():
        ci, wi, text, at, s, e, inst = l.split("\t")
        cues.setdefault(int(ci), {"start": int(s), "end": int(e), "words": []})["words"].append({"text": text, "est": int(at), "inst": inst == "1"})
    tk = Tokens(model_dir + "/tokens.txt")
    so = ort.SessionOptions(); so.intra_op_num_threads = 2
    sess = ort.InferenceSession(model_dir + "/model.int8.onnx", so)
    t0 = time.time()
    audio = load_audio(media)
    t_dec = time.time() - t0
    order = sorted(cues)
    t_model = t_align = 0.0
    total_audio = 0.0
    rows, low = [], 0
    for n, ci in enumerate(order):
        c = cues[ci]
        prev_end = cues[order[n - 1]]["end"] if n else 0
        next_start = cues[order[n + 1]]["start"] if n + 1 < len(order) else 10 ** 9
        a = max(c["start"] - 300, prev_end - 100, 0)
        b = min(c["end"] + 300, next_start + 100)
        clip = audio[int(a * 16): int(b * 16)]
        total_audio += len(clip) / SR
        t1 = time.time()
        feat = fbank(clip)
        lp = sess.run(None, {"audio_signal": feat.T[None].astype(np.float32), "length": np.array([feat.shape[0]], np.int64)})[0][0]
        t_model += time.time() - t1
        t1 = time.time()
        toks, owner = [], []
        for wi, w in enumerate(c["words"]):
            if w["inst"]: continue
            for part in spoken_form(w["text"]):
                ids = tk.encode_word(part)
                toks += ids; owner += [wi] * len(ids)
        res = force_align(lp, toks) if toks else None
        t_align += time.time() - t1
        times = [None] * len(c["words"])
        if res:
            first, score = res
            conf = float(np.mean(score))
            if conf < CONF: low += 1
            else:
                for k, wi in enumerate(owner):
                    if times[wi] is None: times[wi] = a + first[k] * FRAME_MS + lat
        for wi, w in enumerate(c["words"]):
            rows.append((ci, wi, w["text"], w["est"], times[wi] if times[wi] is not None else w["est"] + 300))
    with open(out, "w", encoding="utf-8") as f:
        for r in rows: f.write("\t".join(map(str, r)) + "\n")
    print(f"decode {t_dec:.1f}s, features+model {t_model:.1f}s, align {t_align:.1f}s for {total_audio/60:.1f} min of line audio; low-confidence lines {low}/{len(order)}", file=sys.stderr)


if __name__ == "__main__":
    main()
