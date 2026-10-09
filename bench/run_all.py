#!/usr/bin/env python3
"""
Spoilaint regression suite: one command that rebuilds the test films (if missing) and checks every timing path
against fixed limits, so a change can't quietly make subtitles early, late or broken.

    python3 bench/run_all.py            # everything (~35-40 min)
    python3 bench/run_all.py --quick    # engine, fuzzing, Lua parity, VLC aligner on rb1, live on rb1 (~7 min)
    python3 bench/run_all.py --soak     # everything plus a 2-hour film (+4 min)

Needs (Linux): node, lua5.1, ffmpeg, python3 (numpy, scipy, onnxruntime), mono (mcs), and:
  SPOILAINT_MODEL  folder with model.int8.onnx + tokens.txt   (default installer/vendor/speech-model)
  SPOILAINT_ORT    folder with libonnxruntime.so (onnxruntime-linux-x64-1.20.1/lib, from microsoft/onnxruntime releases)
  SPOILAINT_ORTWEB node_modules folder with onnxruntime-web@1.20.1 (npm install onnxruntime-web@1.20.1)
  SPOILAINT_WORK   scratch folder for test films (default /tmp/spoilaint-bench)
The TIMIT sample (real speech, hand-marked word times) is downloaded from NLTK's data on GitHub when missing.
"""
import json, os, random, shutil, subprocess, sys, statistics, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BENCH = os.path.join(ROOT, "bench")
MODEL = os.environ.get("SPOILAINT_MODEL", os.path.join(ROOT, "installer/vendor/speech-model"))
ORT = os.environ.get("SPOILAINT_ORT", "/root/asr/onnxruntime-linux-x64-1.20.1/lib")
ORTWEB = os.environ.get("SPOILAINT_ORTWEB", "/tmp/ortnode/node_modules")
WORK = os.environ.get("SPOILAINT_WORK", "/tmp/spoilaint-bench")
QUICK = "--quick" in sys.argv
results = []  # (name, ok, detail)


def run(cmd, **kw):
    kw.setdefault("cwd", ROOT)
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def check(name, ok, detail):
    results.append((name, ok, detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name:42} {detail}", flush=True)


# ------------------------------------------------------------------ test films
# Two ordinary films, then six hard ones: echoey room, people talking over each other, 5.1 surround, fast talkers,
# very quiet dialogue, and everything at once.
STRESS_FILMS = (
    ("rb1", ["--seed", "1", "--snr", "10"]), ("rb2", ["--seed", "2", "--snr", "3", "--laughs"]),
    ("s1_echo", ["--seed", "11", "--reverb", "0.6", "--codec", "opus"]),
    ("s2_chatter", ["--seed", "12", "--babble", "-8", "--overlap"]),
    ("s3_surround", ["--seed", "13", "--surround", "--snr", "6"]),
    ("s4_fast", ["--seed", "14", "--tempo", "1.2", "--codec", "mp3", "--snr", "8"]),
    ("s5_quiet", ["--seed", "15", "--level", "30", "--reverb", "0.3"]),
    ("s6_worst", ["--seed", "16", "--laughs", "--snr", "3", "--babble", "-12", "--tempo", "0.9", "--overlap"]),
)
def ms(x): return (int(x[0:2]) * 3600 + int(x[3:5]) * 60 + int(x[6:8])) * 1000 + int(x[9:12])
def ts(v):
    v = max(0, int(round(v))); h, v = divmod(v, 3600000); m, v = divmod(v, 60000); s, v = divmod(v, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{v:03d}"


def transform_srt(src, dst, fn_time=None, fn_texts=None):
    blocks = open(src, encoding="utf-8").read().strip().split("\n\n")
    heads = [b.split("\n")[:2] for b in blocks]
    texts = ["\n".join(b.split("\n")[2:]) for b in blocks]
    if fn_texts: texts = fn_texts(texts)
    out = []
    for (num, times), t in zip(heads, texts):
        a, b = times.split(" --> ")
        if fn_time: a, b = ts(fn_time(ms(a))), ts(fn_time(ms(b)))
        out.append(f"{num}\n{a} --> {b}\n{t}")
    open(dst, "w", encoding="utf-8").write("\n\n".join(out) + "\n\n")


def films():
    os.makedirs(WORK, exist_ok=True)
    timit = os.path.join(WORK, "timit")
    if not os.path.isdir(timit):
        print("downloading the TIMIT sample...", flush=True)
        z = os.path.join(WORK, "timit.zip")
        subprocess.run(["curl", "-sL", "-o", z, "https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/corpora/timit.zip"], check=True)
        subprocess.run(["unzip", "-q", "-o", z, "-d", WORK], check=True)
    for name, args in STRESS_FILMS:
        d = os.path.join(WORK, name)
        if not os.path.exists(os.path.join(d, "truth.json")):
            print(f"building test film {name}...", flush=True)
            subprocess.run([sys.executable, os.path.join(BENCH, "make_real_bench.py"), timit, d] + args, check=True)
    rb1 = os.path.join(WORK, "rb1")
    variants = {
        "shift_late": lambda t: t + 3200,             # subtitles 3.2 s late
        "shift_early": lambda t: t - 2100,            # 2.1 s early
        "drift": lambda t: (t - 1000) * 23.976 / 25,  # made for 25 fps, film is 23.976, plus 1 s
    }
    for name, fn in variants.items():
        d = os.path.join(WORK, name)
        if not os.path.exists(os.path.join(d, "bench.srt")):
            os.makedirs(d, exist_ok=True)
            transform_srt(os.path.join(rb1, "bench.srt"), os.path.join(d, "bench.srt"), fn_time=fn)
    # small shifts, common between releases: found by the quick +-2 s search (an echoey film too)
    for name, src, sh in (("shift_small", "rb1", 600), ("echo_shift", "s1_echo", -800)):
        d = os.path.join(WORK, name)
        if not os.path.exists(os.path.join(d, "bench.srt")):
            os.makedirs(d, exist_ok=True)
            transform_srt(os.path.join(WORK, src, "bench.srt"), os.path.join(d, "bench.srt"), fn_time=lambda t, sh=sh: t + sh)
        for f in ("bench_stereo.mkv", "truth.json"):
            if not os.path.exists(os.path.join(d, f)): os.symlink(os.path.join(WORK, src, f), os.path.join(d, f))
    d = os.path.join(WORK, "wrongtext")
    if not os.path.exists(os.path.join(d, "bench.srt")):
        os.makedirs(d, exist_ok=True)
        def shuffle(t): r = random.Random(3); t = t[:]; r.shuffle(t); return t
        transform_srt(os.path.join(rb1, "bench.srt"), os.path.join(d, "bench.srt"), fn_texts=shuffle)
    d = os.path.join(WORK, "fast")
    if not os.path.exists(os.path.join(d, "truth.json")):
        os.makedirs(d, exist_ok=True)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", os.path.join(rb1, "bench_stereo.mkv"), "-vn", "-af", "atempo=1.5", "-c:a", "aac",
                        os.path.join(d, "bench_stereo.mkv")], check=True)
        transform_srt(os.path.join(rb1, "bench.srt"), os.path.join(d, "bench.srt"), fn_time=lambda t: t / 1.5)
        tr = json.load(open(os.path.join(rb1, "truth.json")))
        for x in tr: x["at_ms"] = round(x["at_ms"] / 1.5)
        json.dump(tr, open(os.path.join(d, "truth.json"), "w"))
    for name in ("shift_late", "shift_early", "drift", "wrongtext"):  # same audio and truth as rb1
        d = os.path.join(WORK, name)
        for f in ("bench_stereo.mkv", "truth.json"):
            if not os.path.exists(os.path.join(d, f)): os.symlink(os.path.join(rb1, f), os.path.join(d, f))


# ------------------------------------------------------------------ scoring
def score(truth_path, tsv, col):
    by = {}
    for t in json.load(open(truth_path)): by.setdefault(t["cue"], []).append(t["at_ms"])
    errs = []
    for l in open(tsv, encoding="utf-8"):
        p = l.rstrip("\n").split("\t")
        if len(p) <= col: continue
        c, i = int(p[0]), int(p[1])
        if c in by and i < len(by[c]): errs.append(int(float(p[col])) - by[c][i])
    a = [abs(e) for e in errs]
    return {"n": len(errs), "early": sum(e < -100 for e in errs) / len(errs) * 100, "within": sum(x <= 100 for x in a) / len(a) * 100,
            "median": statistics.median(errs), "avg": statistics.mean(a)}


def lua_words(d):
    r = run(["lua5.1", "-e", f"""
        local M = dofile('vlc/spoilaint.lua')
        local f = io.open('{d}/bench.srt','rb'); local x = f:read('*a'); f:close()
        local cues = M.parseSubs(M.toUTF8(x)); for _, c in ipairs(cues) do c.words = M.estimateWords(c) end
        local o = io.open('{d}/words.txt','wb'); o:write((M.wordsFile(cues))); o:close()"""])
    if r.returncode: raise RuntimeError(r.stderr)


def lua_apply(d, align, out):
    r = run(["lua5.1", "-e", f"""
        local M = dofile('vlc/spoilaint.lua')
        local function rd(p) local f = io.open(p,'rb'); local x = f:read('*a'); f:close(); return x end
        local cues = M.parseSubs(M.toUTF8(rd('{d}/bench.srt'))); for _, c in ipairs(cues) do c.words = M.estimateWords(c) end
        local est = {{}}; for ci, c in ipairs(cues) do est[ci] = {{}}; for wi, w in ipairs(c.words) do est[ci][wi] = w.at end end
        local _, hash = M.wordsFile(cues)
        M.applyAlignment(cues, rd('{align}'), hash)
        local o = io.open('{out}','wb')
        for ci, c in ipairs(cues) do for wi, w in ipairs(c.words) do o:write(table.concat({{ci-1, wi-1, w.text, est[ci][wi], w.at}}, '\\t'), '\\n') end end
        o:close()"""])
    if r.returncode: raise RuntimeError(r.stderr)


# ------------------------------------------------------------------ suites
def engine_and_parity():
    r = run(["node", "engine/test/engine.test.js"])
    check("engine unit tests", r.returncode == 0, (r.stdout.strip().splitlines() or ["?"])[-1])
    same = True
    for f in ("a.srt", "b.srt", "u16.srt"):
        for mode in ("word", "chunk"):
            run(["lua5.1", "vlc/test/parity.lua", f"vlc/test/samples/{f}", "/tmp/sp_l.ass", mode, "300"])
            run(["node", "vlc/test/parity.js", f"vlc/test/samples/{f}", "/tmp/sp_j.ass", mode, "300"])
            same = same and open("/tmp/sp_l.ass", "rb").read() == open("/tmp/sp_j.ass", "rb").read()
    check("VLC script = browser engine (parity)", same, "byte-identical .ass on samples" if same else "outputs differ")


def fuzz():
    cases = os.path.join(WORK, "fuzz", "cases"); words = os.path.join(WORK, "fuzz", "words")
    shutil.rmtree(os.path.join(WORK, "fuzz"), ignore_errors=True); os.makedirs(words)
    run([sys.executable, os.path.join(BENCH, "fuzz/make_cases.py"), cases, "100" if QUICK else "1500"])
    lst = os.path.join(WORK, "fuzz", "list.txt"); open(lst, "w").write("\n".join(sorted(os.listdir(cases))) + "\n")
    for name, cmd in (("fuzz: browser engine", ["node", "bench/fuzz/fuzz.js", cases]),
                      ("fuzz: VLC script", ["lua5.1", "bench/fuzz/fuzz.lua", cases, lst]),
                      ("fuzz: VLC script = engine on broken files", ["sh", "bench/fuzz/parity_sweep.sh", cases])):
        r = run(cmd)
        out = [l for l in r.stdout.splitlines() if "subtitles moved" not in l]
        check(name, r.returncode == 0, out[-1] if out else r.stderr[-200:])
        if r.returncode: print("\n".join(out[-8:-1]))
    exe = os.path.join(WORK, "fuzz", "FuzzWords.exe")
    r = run(["mcs", "-nologo", "-sdk:4.5", "-out:" + exe, "bench/fuzz/FuzzWords.cs", "tray/Align.cs", "tray/Core.cs", "-r:System.dll", "-r:System.Core.dll"])
    r = r if r.returncode else run(["mono", exe, os.path.join(MODEL, "tokens.txt"), words])
    check("fuzz: app words reader", r.returncode == 0, (r.stdout.strip().splitlines() or [r.stderr[-200:]])[-1])


def lag_probe(exe):
    """Does a sync make the computer stutter? A foreground task wants 2 ms of work every 10 ms while rb1 syncs at the
    lowest priority (as the app runs it); count the ticks that missed their slot."""
    sys.path.insert(0, BENCH); import perf
    d = os.path.join(WORK, "rb1")
    os.environ["LD_LIBRARY_PATH"] = os.path.join(ROOT, "tray/test")
    base = perf.run_probe(seconds=5)
    r = perf.run_probe(cmd=["mono", exe, MODEL, os.path.join(d, "bench_stereo.mkv"), os.path.join(d, "words.txt"), "/tmp/sp_lag_align.txt"], nice=19)
    ok = r["missed"] <= max(1.0, base["missed"] * 3) and r["p99"] <= max(5.0, base["p99"] * 3) and r["peak_mb"] <= 400
    check("no lag while syncing", ok, f"foreground ticks missed {r['missed']:.2f}% (idle {base['missed']:.2f}%), p99 late {r['p99']:.1f} ms, "
                                     f"{r['cores']:.2f} cores, peak {r['peak_mb']:.0f} MB, {r['wall']:.0f} s")


def build_align_test():
    exe = os.path.join(ROOT, "tray/test/AlignTest.exe")
    r = run(["mcs", "-nologo", "-sdk:4.5", "-out:" + exe, "tray/test/AlignTest.cs", "tray/Align.cs", "tray/Core.cs", "-r:System.dll", "-r:System.Core.dll"])
    if r.returncode: raise RuntimeError(r.stdout + r.stderr)
    for f in os.listdir(ORT):
        if f.startswith("libonnxruntime.so"): shutil.copy(os.path.join(ORT, f), os.path.join(ROOT, "tray/test", f))
    return exe


def vlc_case(exe, name, expect_offset=None, min_within=85, max_early=1.0):
    d = os.path.join(WORK, name)
    lua_words(d)
    t0 = time.time()
    r = run(["mono", exe, MODEL, os.path.join(d, "bench_stereo.mkv"), os.path.join(d, "words.txt"), os.path.join(d, "align.txt")],
            env=dict(os.environ, LD_LIBRARY_PATH=os.path.join(ROOT, "tray/test")))
    if r.returncode: check(f"VLC aligner: {name}", False, r.stderr[-300:]); return
    lua_apply(d, os.path.join(d, "align.txt"), os.path.join(d, "vlc.tsv"))
    s = score(os.path.join(d, "truth.json"), os.path.join(d, "vlc.tsv"), 4)
    off = [l for l in r.stdout.splitlines() if l.startswith("offset")]
    ok = s["early"] <= max_early and s["within"] >= min_within
    if expect_offset is not None:
        got = int(off[0].split()[1]) if off else 0
        ok = ok and abs(got - expect_offset) <= 300
    check(f"VLC aligner: {name}", ok, f"early {s['early']:.1f}%  within 0.1s {s['within']:.1f}%  {off[0] if off else ''}  ({time.time() - t0:.0f}s)")


def live_case(name, max_median, max_early=1.0, expect_mismatch=False, rate=1.0):
    d = os.path.join(WORK, name)
    out = os.path.join(d, "live.tsv")
    r = run(["node", os.path.join(BENCH, "live_js.js"), MODEL, d, out], env=dict(os.environ, NODE_PATH=ORTWEB))
    if r.returncode: check(f"browser live: {name}", False, r.stderr[-300:]); return
    # the content script's mismatch rule on the per-line match scores
    g = [float(l.split("\t")[1]) for l in open(out + ".scores") if l.strip()]
    sp = max(0, rate - 1); on, flips, off_lines = True, 0, 0
    for i in range(len(g)):
        w = sorted(g[max(0, i - 4): i + 1])
        if len(w) < 3: continue
        m = w[len(w) >> 1]
        if on and m > 0.6 + 0.3 * sp: on = False; flips += 1
        elif not on and m < 0.45 + 0.2 * sp: on = True; flips += 1
        off_lines += (not on)
    if expect_mismatch:
        ok = off_lines >= len(g) * 0.9
        check(f"browser live: {name}", ok, f"mismatch detected on {off_lines}/{len(g)} lines")
        return
    s = score(os.path.join(d, "truth.json"), out, 4)
    ok = s["early"] <= max_early and s["median"] <= max_median and flips == 0
    check(f"browser live: {name}", ok, f"early {s['early']:.1f}%  median {s['median']:.0f} ms late  false mismatch switches {flips}")


def main():
    films()
    print("Spoilaint regression suite" + (" (quick)" if QUICK else ""), flush=True)
    engine_and_parity()
    fuzz()
    exe = build_align_test()
    vlc_case(exe, "rb1")
    if not QUICK:
        vlc_case(exe, "rb2")
        # hard films: a little early is tolerated (first words in echo/5.1), "within 0.1 s" set ~5 points under today's
        for name, within in (("s1_echo", 88), ("s2_chatter", 68), ("s3_surround", 90), ("s4_fast", 82), ("s5_quiet", 82), ("s6_worst", 64)):
            vlc_case(exe, name, min_within=within, max_early=3.0)
        vlc_case(exe, "shift_late", expect_offset=-3200)
        vlc_case(exe, "shift_early", expect_offset=2100)
        vlc_case(exe, "drift")
        vlc_case(exe, "shift_small", expect_offset=-600)
        vlc_case(exe, "echo_shift", expect_offset=800, min_within=88, max_early=3.0)
        lag_probe(exe)
    live_case("rb1", max_median=350)
    if not QUICK:
        live_case("rb2", max_median=650)
        live_case("fast", max_median=500, rate=1.5)  # 1.5x: the mismatch rule uses the real playback rate
        live_case("wrongtext", max_median=0, expect_mismatch=True)
        live_case("s1_echo", max_median=700, max_early=1.5)
        live_case("s6_worst", max_median=1000, max_early=1.5)
    if "--soak" in sys.argv:
        r = run([sys.executable, os.path.join(BENCH, "soak.py")])
        lines = r.stdout.strip().splitlines()
        check("2-hour film (soak)", r.returncode == 0, lines[-1][6:] if lines else r.stderr[-200:])
    bad = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(bad)} passed, {len(bad)} failed", flush=True)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
