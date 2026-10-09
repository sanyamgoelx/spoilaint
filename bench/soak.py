#!/usr/bin/env python3
"""
Soak test: a 2-hour film (test films joined end to end) through the VLC app's aligner, as on a real movie night.
Checks it finishes, its memory stays flat (the film is streamed, never held whole), and timing stays as good at
1h50 as in the first minutes.
    python3 bench/soak.py [--films rb1,rb2] [--copies 5]
"""
import json, os, subprocess, sys, time, statistics
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_all as R
import perf

def srt_cues(p):
    blocks = open(p, encoding="utf-8").read().replace("\r", "").strip().split("\n\n")
    out = []
    for b in blocks:
        l = b.split("\n")
        a, z = l[1].split(" --> ")
        out.append((R.ms(a), R.ms(z), "\n".join(l[2:])))
    return out

def build(names, copies, d):
    os.makedirs(d, exist_ok=True)
    seq = [n for _ in range(copies) for n in names]
    # Audio is decoded per film and joined sample-exact (joining the compressed files directly adds a few ms of
    # encoder padding at every join, which would look like drift); video is joined as is.
    lst, wavs, cues, truth, at, cue0 = [], [], [], [], 0, 0
    for k, n in enumerate(seq):
        src = os.path.join(R.WORK, n)
        wav = os.path.join(d, f"{n}.wav")
        if not os.path.exists(wav):
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", os.path.join(src, "bench_stereo.mkv"), "-vn", "-ac", "2", "-ar", "48000", wav], check=True)
        samples = (os.path.getsize(wav) - 44) // 4
        lst.append(f"file '{os.path.join(src, 'bench_stereo.mkv')}'"); wavs.append(f"file '{wav}'")
        c = srt_cues(os.path.join(src, "bench.srt"))
        for s, e, t in c: cues.append((s + at, e + at, t))
        for t in json.load(open(os.path.join(src, "truth.json"))):
            truth.append(dict(t, cue=t["cue"] + cue0, at_ms=t["at_ms"] + at))
        cue0 += len(c); at += round(samples / 48)
    open(os.path.join(d, "list.txt"), "w").write("\n".join(lst) + "\n")
    open(os.path.join(d, "wavs.txt"), "w").write("\n".join(wavs) + "\n")
    out = os.path.join(d, "bench_stereo.mkv")
    if os.path.exists(out): os.remove(out)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", os.path.join(d, "list.txt"),
                    "-f", "concat", "-safe", "0", "-i", os.path.join(d, "wavs.txt"),
                    "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", out], check=True)
    with open(os.path.join(d, "bench.srt"), "w", encoding="utf-8") as f:
        for i, (s, e, t) in enumerate(cues): f.write(f"{i + 1}\n{R.ts(s)} --> {R.ts(e)}\n{t}\n\n")
    json.dump(truth, open(os.path.join(d, "truth.json"), "w"))
    return at

if __name__ == "__main__":
    names = (sys.argv[sys.argv.index("--films") + 1] if "--films" in sys.argv else "rb1,rb2").split(",")
    copies = int(sys.argv[sys.argv.index("--copies") + 1]) if "--copies" in sys.argv else 5
    d = os.path.join(R.WORK, "soak")
    length = build(names, copies, d)
    print(f"soak film: {length / 3600000:.2f} h, {os.path.getsize(os.path.join(d, 'bench_stereo.mkv')) / 1e6:.0f} MB", flush=True)
    exe = R.build_align_test()
    R.lua_words(d)
    env = dict(os.environ, LD_LIBRARY_PATH=os.path.join(R.ROOT, "tray/test"))
    os.environ.update(env)
    r = perf.run_probe(cmd=["mono", exe, R.MODEL, os.path.join(d, "bench_stereo.mkv"), os.path.join(d, "words.txt"), os.path.join(d, "align.txt")])
    perf.show("2-hour film", r)
    R.lua_apply(d, os.path.join(d, "align.txt"), os.path.join(d, "vlc.tsv"))
    # accuracy per 20-minute stretch: the end must be as good as the start
    truth = json.load(open(os.path.join(d, "truth.json")))
    by = {}
    for t in truth: by.setdefault(t["cue"], []).append(t["at_ms"])
    buckets = {}
    for l in open(os.path.join(d, "vlc.tsv"), encoding="utf-8"):
        p = l.rstrip("\n").split("\t"); c, i = int(p[0]), int(p[1])
        if c in by and i < len(by[c]):
            e = int(float(p[4])) - by[c][i]; buckets.setdefault(by[c][i] // 1200000, []).append(e)
    # (re-encoding the joined audio adds one AAC frame, ~21 ms, to every word, so "within" sits a little under the
    # single-film figure; what matters here is that it stays the same from start to end)
    ok, first = r["peak_mb"] <= 400, None
    for k in sorted(buckets):
        e = buckets[k]; early = sum(x < -100 for x in e) / len(e) * 100; within = sum(abs(x) <= 100 for x in e) / len(e) * 100
        first = within if first is None else first
        ok = ok and early <= 1.0 and within >= 75 and within >= first - 3
        print(f"  {k * 20:3d}-{k * 20 + 20:3d} min: early {early:.1f}%  within 0.1s {within:.1f}%")
    speed = length / 1000 / r["wall"]
    print(f"{'PASS' if ok else 'FAIL'}  {length / 60000:.0f} min of film synced in {r['wall']:.0f} s ({speed:.0f}x real time), peak memory {r['peak_mb']:.0f} MB")
    sys.exit(0 if ok else 1)
