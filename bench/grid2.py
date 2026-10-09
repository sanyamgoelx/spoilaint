import itertools
from evalenv import score
B=['/tmp/bench','/tmp/bench2','/tmp/bench3']
grid=dict(thresholdFrac=[0.4,0.5,0.6,0.7], peakDb=[2.5,4.0], closeGapFrames=[3,5], minRangeDb=[6,10], durationWeight=[0,0.5])
res=[]
for vals in itertools.product(*grid.values()):
    p=dict(zip(grid.keys(),vals))
    e,a,w=score([(b,f'{b}/env_mid.txt') for b in B],p)
    res.append((e*3+a/10,e,a,w,p))
res.sort(key=lambda r:r[0])
for r in res[:6]:
    e5,a5,w5=score([('/tmp/bench','/tmp/bench/env_51.txt')],r[4])
    print(f"stereo: spoils {r[1]:4.1f}% avg {r[2]:4.0f}ms w150 {r[3]:4.1f}% | 5.1: spoils {e5:4.1f}% avg {a5:4.0f}ms w150 {w5:4.1f}% | {r[4]}")
