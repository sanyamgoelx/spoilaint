# python3 lag.py truth.json lj.tsv  -> where the live delay comes from, and what scheduling by heard onset would give
import json, sys, numpy as np
truth = json.load(open(sys.argv[1])); by = {}
for t in truth: by.setdefault(t['cue'], []).append(t['at_ms'])
rows = [l.rstrip('\n').split('\t') for l in open(sys.argv[2])]
C, O, T, key = [], [], [], []
for r in rows:
    if len(r) < 7 or r[5] != '1' or r[6] == '': continue
    c, i = int(r[0]), int(r[1])
    C.append(int(r[4])); O.append(int(r[6])); T.append(by[c][i]); key.append((c, i))
C, O, T = map(np.array, (C, O, T))
lat = C - T; oerr = O - T
print(f"aligned words {len(C)}: shown after the real start by median {np.median(lat):.0f} ms (p10 {np.percentile(lat,10):.0f}, p90 {np.percentile(lat,90):.0f}); heard-onset error median {np.median(oerr):+.0f} ms (p5 {np.percentile(oerr,5):+.0f}, p95 {np.percentile(oerr,95):+.0f})")
# clumps: next word shown within 60 ms of this one though really >=150 ms apart
cl = tot = 0
for j in range(len(key) - 1):
    if key[j+1][0] == key[j][0] and key[j+1][1] == key[j][1] + 1:
        tot += 1
        if C[j+1] - C[j] < 60 and T[j+1] - T[j] >= 150: cl += 1
print(f"clumped pairs {cl}/{tot} ({cl/max(1,tot)*100:.0f}%)")
for D in (300, 400, 500, 600):
    R = np.maximum(C, O + D)
    cl2 = sum(1 for j in range(len(key)-1) if key[j+1][0]==key[j][0] and key[j+1][1]==key[j][1]+1 and R[j+1]-R[j] < 60 and T[j+1]-T[j] >= 150)
    l = R - T
    print(f"  schedule at heard onset + {D}: median late {np.median(l):.0f}, p90 {np.percentile(l,90):.0f}, spread (p90-p10) {np.percentile(l,90)-np.percentile(l,10):.0f} ms, clumped {cl2/max(1,tot)*100:.0f}%")
