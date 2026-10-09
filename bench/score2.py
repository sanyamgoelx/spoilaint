#!/usr/bin/env python3
"""python3 score2.py truth.json method=dump.tsv[:col] ...  Compares word reveal times with the real ones.
A TSV row is: cue idx word time_ms [time_ms...]; col picks the time column (default last)."""
import json, sys, statistics
truth = json.load(open(sys.argv[1], encoding="utf-8"))
by = {}
for t in truth: by.setdefault(t["cue"], []).append(t["at_ms"])
print(f"{'method':14} {'words':>6} {'avg off':>8} {'median':>7} {'spoils >100ms early':>20} {'>400ms late':>12} {'within 100ms':>13}")
for spec in sys.argv[2:]:
    name, rest = spec.split("=", 1)
    path, col = (rest.split(":") + [None])[:2]
    errs = []
    for l in open(path, encoding="utf-8"):
        p = l.rstrip("\n").split("\t")
        if len(p) < 4: continue
        c, i = int(p[0]), int(p[1])
        if c not in by or i >= len(by[c]): continue
        v = int(float(p[int(col)] if col else p[-1]))
        errs.append(v - by[c][i])
    a = [abs(e) for e in errs]
    print(f"{name:14} {len(errs):6d} {statistics.mean(a):7.0f}ms {statistics.median(a):6.0f}ms {sum(e < -100 for e in errs)/len(errs)*100:19.1f}% {sum(e > 400 for e in errs)/len(errs)*100:11.1f}% {sum(abs(e) <= 100 for e in errs)/len(errs)*100:12.1f}%")
