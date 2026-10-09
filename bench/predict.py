# python3 predict.py truth.json lj.tsv [chain] -> speculative reveal: predict a word's start from the pace so far
# A word j may be shown at max(C_L, O_L + its syllables-so-far * pace + margin) for any confirmed word L up to
# `chain` words before it with no punctuation pause in between; never later than its own confirmation C_j.
import json, sys, re, numpy as np
truth = json.load(open(sys.argv[1])); by = {}
for t in truth: by.setdefault(t['cue'], []).append(t['at_ms'])
CHAIN = int(sys.argv[3]) if len(sys.argv) > 3 else 1
def syl(w):
    w = re.sub(r"[^a-z]", "", w.lower()); g = len(re.findall(r"[aeiouy]+", w))
    if len(w) > 3 and g > 1 and w.endswith('e') and not w.endswith('le'): g -= 1
    return max(1, g)
def pause(w): return bool(re.search(r"[.,!?;:…-]$", w.rstrip('"\')')))
lines = {}
for l in open(sys.argv[2]):
    r = l.rstrip('\n').split('\t'); lines.setdefault(int(r[0]), []).append(r)
for m in (999999, 200, 150, 100):
    lat, early, n, used = [], 0, 0, 0
    for c, rows in lines.items():
        T = by[c]
        ok = [r[5] == '1' and r[6] != '' for r in rows]
        for j, r in enumerate(rows):
            C = int(r[4]); R = C
            if m < 999999 and ok[j]:
                for L in range(j - 1, max(-1, j - 1 - CHAIN), -1):
                    if pause(rows[L][2]): break
                    if not ok[L]: continue
                    CL, OL = int(rows[L][4]), int(rows[L][6])
                    k = [i for i in range(L + 1) if ok[i] and int(rows[i][4]) <= CL]
                    rate = 210
                    if len(k) >= 2 and int(rows[k[-1]][6]) > int(rows[k[0]][6]):
                        rate = (int(rows[k[-1]][6]) - int(rows[k[0]][6])) / sum(syl(rows[i][2]) for i in range(k[0], k[-1]))
                    rate = min(max(rate, 120), 320)
                    cand = max(CL, OL + sum(syl(rows[i][2]) for i in range(L, j)) * rate + m)
                    if cand < R: R = cand
                if R < C: used += 1
            lat.append(R - T[j]); n += 1
            if R < T[j] - 100: early += 1
    lat = np.array(lat)
    name = 'no prediction' if m >= 999999 else f'predict +{m} ms'
    print(f"{name:16} median late {np.median(lat):4.0f} ms  p90 {np.percentile(lat,90):4.0f}  early >100ms {early/n*100:4.1f}%  (predicted {used})")
