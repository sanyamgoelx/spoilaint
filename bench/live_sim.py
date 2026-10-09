#!/usr/bin/env python3
"""
Simulates live (browser, tab audio) alignment on a bench film, to tune it before the JS port.

    python3 live_sim.py MODEL_DIR bench_dir out.tsv [--hop 500] [--ctx 1000] [--delay 150]

Audio arrives in real time. Every `hop` ms (only while a line is on screen or about to be) the model runs
on the newest `hop` ms plus `ctx` ms before it; its output frames for the new part are appended to one
rolling stream. Each line keeps a prefix-Viterbi over its tokens: the best state at the newest frame says
how far into the line the speaker is. A word is revealed once that position reaches its first token (and
stays there for one update), `delay` ms after the hop ends (inference time). Never before it is heard.
"""
import sys, json, numpy as np, onnxruntime as ort
import ctc_align as C

def arg(name, d):
    return float(sys.argv[sys.argv.index(name) + 1]) if name in sys.argv else d

model_dir, bench, out = sys.argv[1:4]
HOP, CTX, DELAY = arg("--hop", 500), arg("--ctx", 1000), arg("--delay", 150)
LAT = arg("--lat", -70)
NORM = "--winnorm" not in sys.argv
CONFIRM = "--noconfirm" not in sys.argv
SUM = "--sum" in sys.argv
THR = arg("--thr", 0.5)
EDGE = arg("--edge", 0)  # ignore the newest EDGE ms of frames when judging position
FRAME = 40

tk = C.Tokens(model_dir + "/tokens.txt")
so = ort.SessionOptions(); so.intra_op_num_threads = 1
sess = ort.InferenceSession(model_dir + "/model.int8.onnx", so)
audio = C.load_audio(bench + "/bench_stereo.mkv")

# cues from srt (+ VLC-script words so word lists match truth)
import subprocess
est = subprocess.run(["lua5.1", "-e", f"""
    local M = dofile('../vlc/spoilaint.lua')
    local f = io.open('{bench}/bench.srt', 'rb'); local d = f:read('*a'); f:close()
    for ci, c in ipairs(M.parseSubs(M.toUTF8(d))) do
      for wi, w in ipairs(M.estimateWords(c)) do
        print(table.concat({{ci-1, wi-1, w.text, w.at, c.start, c['end']}}, '\\t'))
      end
    end"""], capture_output=True, text=True, check=True).stdout
cues = {}
for l in est.splitlines():
    ci, wi, text, at, s, e = l.split("\t")
    cues.setdefault(int(ci), {"start": int(s), "end": int(e), "words": []})["words"].append({"text": text, "est": int(at)})
order = sorted(cues)

class LineState:
    def __init__(self, c):
        self.c = c
        toks, owner = [], []
        for wi, w in enumerate(c["words"]):
            for p in C.spoken_form(w["text"]):
                ids = tk.encode_word(p); toks += ids; owner += [wi] * len(ids)
        self.toks, self.owner = toks, owner
        self.first_tok = {}
        for k, wi in enumerate(owner): self.first_tok.setdefault(wi, k)
        S = 2 * len(toks) + 1
        self.S = S
        self.lab = np.full(S, tk.blank); self.lab[1::2] = toks
        self.skip = np.zeros(S, bool)
        for s in range(3, S, 2): self.skip[s] = self.lab[s] != self.lab[s - 2]
        self.dp = None
        self.from_t = c["start"] - 300
        self.revealed = {}
        self.pending = None
    def feed(self, lp_row):
        NEG = -1e30
        if self.dp is None:
            self.dp = np.full(self.S, NEG, np.float32)
            self.dp[0] = lp_row[tk.blank]
            if self.S > 1: self.dp[1] = lp_row[self.lab[1]]
            return
        prev = self.dp
        step = np.concatenate([[NEG], prev[:-1]])
        skip = np.where(self.skip, np.concatenate([[NEG, NEG], prev[:-2]]), NEG)
        if SUM:
            m = np.maximum(np.maximum(prev, step), skip)
            self.dp = m + np.log(np.exp(prev - m) + np.exp(step - m) + np.exp(skip - m)) + lp_row[self.lab]
        else:
            self.dp = np.maximum(np.maximum(prev, step), skip) + lp_row[self.lab]
    def position(self):
        if SUM:
            p = np.exp(self.dp - self.dp.max()); p /= p.sum()
            # furthest token k with P(at or past token k) >= THR
            tail = np.cumsum(p[::-1])[::-1]   # tail[s] = P(state >= s)
            ok = [s for s in range(1, self.S, 2) if tail[s] >= THR]
            return (ok[-1] - 1) // 2 if ok else -1
        s = int(np.argmax(self.dp))
        return (s - 1) // 2 if s % 2 == 1 else s // 2 - 1  # index of the last token entered

REDO = arg("--redo", 600)  # recompute this much of the newest output each step (it lacked right context)
frames = {}  # abs_ms -> logp row
states = {}
t = 0
end_all = cues[order[-1]]["end"] + 2000
model_secs = 0.0
import time
first = True
while t < end_all:
    t += HOP
    active = [ci for ci in order if cues[ci]["start"] - 300 <= t and t - HOP <= cues[ci]["end"] + 300]
    if not active:
        frames.clear(); first = True
        continue
    for ci in active:
        if ci not in states:
            states[ci] = LineState(cues[ci]); states[ci].hist = []
    a = max(0, t - HOP - CTX)
    a = a - a % FRAME
    clip = audio[int(a * 16): int(t * 16)]
    t1 = time.time()
    feat = C.fbank(clip)
    lp = sess.run(None, {"audio_signal": feat.T[None], "length": np.array([feat.shape[0]], np.int64)})[0][0]
    model_secs += time.time() - t1
    redo_from = a if first else max(a + 400, t - HOP - REDO)  # keep 400 ms of left context unused
    first = False
    for f in range(lp.shape[0]):
        ft = a + f * FRAME
        if ft >= redo_from: frames[ft] = lp[f]
    for ft in [k for k in frames if k < t - 8000]: del frames[ft]
    for ci in active:
        st = states[ci]
        lo = st.from_t
        # roll back to the checkpoint before redo_from, then replay
        while st.hist and st.hist[-1][0] >= redo_from: st.hist.pop()
        st.dp = st.hist[-1][1].copy() if st.hist else None
        last_t = st.hist[-1][0] if st.hist else -1e9
        for ft in sorted(frames):
            if ft <= last_t or ft < lo or ft > cues[ci]["end"] + 300: continue
            st.feed(frames[ft]); st.hist.append((ft, st.dp.copy()))
    now = t + DELAY
    for ci in active:
        st = states[ci]
        if st.dp is None: continue
        pos = st.position()
        conf_pos = (min(pos, st.pending) if st.pending is not None else -1) if CONFIRM else pos
        st.pending = pos
        for wi in range(len(cues[ci]["words"])):
            k = st.first_tok.get(wi)
            if k is not None and k <= conf_pos and wi not in st.revealed:
                st.revealed[wi] = now
# words never confirmed: the existing fallback (estimate + 1.5 s, before line end - 300)
rows = []
for ci in order:
    c = cues[ci]; st = states.get(ci)
    last = -1
    for wi, w in enumerate(c["words"]):
        r = st.revealed.get(wi) if st else None
        if r is None:
            r = max(w["est"] + 300, min(w["est"] + 1500, c["end"] - 300))
        r = max(r, last); last = r
        rows.append((ci, wi, w["text"], w["est"], int(r)))
with open(out, "w") as f:
    for r in rows: f.write("\t".join(map(str, r)) + "\n")
total = end_all / 1000
print(f"model time {model_secs:.1f}s for {total/60:.1f} min of film ({model_secs/total*100:.1f}% of one core, native)", file=sys.stderr)
