import json, os, statistics, subprocess, sys
def score(pairs, params=None):
    errs=[]
    env=dict(os.environ, SPOIL_PARAMS=",".join(f"{k}={v}" for k,v in (params or {}).items()))
    for b, envf in pairs:
        by={}
        for t in json.load(open(b+'/truth.json')): by.setdefault(t['cue'],[]).append(t['at_ms'])
        out=subprocess.run(['lua5.1','dump.lua','../vlc/spoilaint.lua',b+'/bench.srt',envf],capture_output=True,text=True,env=env).stdout
        for l in out.splitlines():
            c,i,w,e,s=l.split('\t'); errs.append(int(s)-by[int(c)][int(i)])
    return (sum(v<-100 for v in errs)/len(errs)*100, statistics.mean(abs(v) for v in errs), sum(abs(v)<=150 for v in errs)/len(errs)*100)
if __name__ == '__main__':
    for mode in ('51','mid','surround'):
        bs=['/tmp/bench'] if mode=='51' else ['/tmp/bench','/tmp/bench2','/tmp/bench3']
        e,a,w=score([(b,f'{b}/env_{mode}.txt') for b in bs])
        print(f"{mode:9} spoils {e:4.1f}%  avg {a:4.0f}ms  within150 {w:4.1f}%")
