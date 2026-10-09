import itertools, json, os, subprocess, statistics
benches=['/tmp/bench','/tmp/bench2','/tmp/bench3']
truths={}
for b in benches:
    by={}
    for t in json.load(open(b+'/truth.json')): by.setdefault(t['cue'],[]).append(t['at_ms'])
    truths[b]=by
def run(params):
    errs=[]
    env=dict(os.environ, SPOIL_PARAMS=",".join(f"{k}={v}" for k,v in params.items()))
    for b in benches:
        out=subprocess.run(['lua5.1','dump.lua','../vlc/spoilaint.lua',b+'/bench.srt',b+'/env.txt'],capture_output=True,text=True,env=env).stdout
        for l in out.splitlines():
            c,i,w,e,s=l.split('\t'); errs.append(int(s)-truths[b][int(c)][int(i)])
    early=sum(e<-100 for e in errs)/len(errs)*100
    avg=statistics.mean(abs(e) for e in errs)
    within=sum(abs(e)<=150 for e in errs)/len(errs)*100
    return early, avg, within
grid=dict(peakDb=[1.5,2.5,3.5], durationWeight=[0,0.5,1.0], closeGapFrames=[3,5,8], thresholdFrac=[0.25,0.35,0.5], peakGapFrames=[4,6])
res=[]
for vals in itertools.product(*grid.values()):
    p=dict(zip(grid.keys(),vals)); e,a,w=run(p)
    res.append((e*3+a/10, e, a, w, p))
res.sort(key=lambda r:r[0])
for r in res[:8]: print(f"score={r[0]:.1f} early={r[1]:.1f}% avg={r[2]:.0f}ms within150={r[3]:.1f}% {r[4]}")
