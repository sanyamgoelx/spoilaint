import itertools
from evalenv import score
B=['/tmp/bench','/tmp/bench2','/tmp/bench3']
grid=dict(modulation=[0,0.2,0.35,0.5], looseFrac=[0.15,0.3], modulationStrict=[0,1], thresholdFrac=[0.5,0.6], durationWeight=[0,0.5], closeGapFrames=[3,5])
res=[]
for vals in itertools.product(*grid.values()):
    p=dict(zip(grid.keys(),vals))
    if p['modulation']==0 and (p['looseFrac']!=0.15 or p['modulationStrict']): continue
    es,as_,ws=score([(b,f'{b}/env_mid.txt') for b in B],p)
    e5,a5,w5=score([('/tmp/bench','/tmp/bench/env_51.txt')],p)
    res.append(((es+e5)*3+(as_+a5)/20,es,as_,ws,e5,a5,w5,p))
res.sort(key=lambda r:r[0])
for r in res[:6]:
    print(f"stereo: spoils {r[1]:4.1f}% avg {r[2]:4.0f}ms w150 {r[3]:4.1f}% | 5.1: spoils {r[4]:4.1f}% avg {r[5]:4.0f}ms w150 {r[6]:4.1f}% | {r[7]}")
