# python3 ahead.py truth.json tsv[:col]  -> for wrong/dubbed text: how far ahead of the real speech words are shown
import json, sys
truth = json.load(open(sys.argv[1])); sp = {}
for t in truth: sp.setdefault(t['cue'], []).append(t['at_ms'])
for spec in sys.argv[2:]:
    path, col = (spec.split(':') + ['4'])[:2]; col = int(col)
    rows = [l.rstrip('\n').split('\t') for l in open(path)]
    n = {}
    for r in rows: n[int(r[0])] = max(n.get(int(r[0]), 0), int(r[1]) + 1)
    ahead = []; aligned = 0
    for r in rows:
        c, i, t = int(r[0]), int(r[1]), int(r[col])
        a, b = sp[c][0], sp[c][-1] + 300
        real = min(1, max(0, (t - a) / max(1, b - a)))
        word = i / n[c]
        ahead.append(word - real)
        if len(r) > 5 and r[5] == '1': aligned += 1
    print(f"{path}:{col}  words {len(rows)}  aligned {aligned}  shown >20% of the line ahead of the speech: {sum(x > 0.2 for x in ahead)/len(ahead)*100:.1f}%  >40%: {sum(x > 0.4 for x in ahead)/len(ahead)*100:.1f}%")
