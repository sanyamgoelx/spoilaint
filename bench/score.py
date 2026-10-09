#!/usr/bin/env python3
"""python3 score.py truth.json dump.tsv [lag_ms]  -> how close each method is to the real word times."""
import json, sys, statistics
truth = json.load(open(sys.argv[1], encoding="utf-8"))
lag = int(sys.argv[3]) if len(sys.argv) > 3 else 0
rows = [l.rstrip("\n").split("\t") for l in open(sys.argv[2], encoding="utf-8") if l.strip()]
by_cue = {}
for t in truth: by_cue.setdefault(t["cue"], []).append(t["at_ms"])
res = {"estimate": [], "speech": []}
for cue, idx, word, est, syn in rows:
    real = by_cue[int(cue)][int(idx)]
    res["estimate"].append(int(est) + lag - real)
    res["speech"].append(int(syn) + lag - real)
print(f"{len(rows)} words, delay setting {lag:+d} ms")
print(f"{'method':10} {'avg off':>8} {'median':>7} {'spoils >100ms early':>20} {'>400ms late':>12} {'within 150ms':>13}")
for k, errs in res.items():
    a = [abs(e) for e in errs]
    early = sum(e < -100 for e in errs) / len(errs) * 100
    late = sum(e > 400 for e in errs) / len(errs) * 100
    within = sum(abs(e) <= 150 for e in errs) / len(errs) * 100
    print(f"{k:10} {statistics.mean(a):7.0f}ms {statistics.median(a):6.0f}ms {early:19.1f}% {late:11.1f}% {within:12.1f}%")
