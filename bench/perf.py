#!/usr/bin/env python3
"""
Spoilaint performance and "does it make the PC lag?" harness.

    python3 bench/perf.py [--nice N] -- <command ...>

Runs the command and, at the same time, a foreground probe that wants to do 2 ms of work every 10 ms (like a game,
a video player or a browser animating). Reports:
  - wall time, CPU time of the command and its children (cores used on average), peak memory
  - how late the probe's ticks were (p50/p99/max) and how many missed their 10 ms slot entirely:
    that lateness is the stutter a user would feel while a sync runs.
A run with no command first measures the probe on an idle machine, for comparison.
--nice N runs the command at that niceness (19 = Linux's lowest priority, like Windows' Idle class).
"""
import os, resource, subprocess, sys, threading, time, statistics


def probe(stop, out):
    late = []
    period, work = 0.010, 0.002
    nxt = time.perf_counter() + period
    while not stop.is_set():
        now = time.perf_counter()
        if now < nxt:
            time.sleep(nxt - now)
            continue
        late.append((now - nxt) * 1000)
        t = time.perf_counter()
        while time.perf_counter() - t < work: pass   # the foreground app's own work
        nxt += period
        if nxt < time.perf_counter() - period: nxt = time.perf_counter() + period  # fell way behind: resync
    out.extend(late)


def peak_rss_tree(pid):
    total = 0
    try:
        kids = subprocess.run(["ps", "-o", "rss=", "--ppid", str(pid)], capture_output=True, text=True).stdout.split()
        me = open(f"/proc/{pid}/status").read()
        rss = [int(l.split()[1]) for l in me.splitlines() if l.startswith("VmRSS")]
        total = (rss[0] if rss else 0) + sum(int(k) for k in kids)
    except Exception:
        pass
    return total


def run_probe(seconds=None, cmd=None, nice=0):
    stop, late = threading.Event(), []
    th = threading.Thread(target=probe, args=(stop, late)); th.start()
    peak = 0
    t0 = time.time()
    r0 = resource.getrusage(resource.RUSAGE_CHILDREN)
    if cmd:
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                             preexec_fn=(lambda: os.nice(nice)) if nice else None)
        while p.poll() is None:
            peak = max(peak, peak_rss_tree(p.pid)); time.sleep(0.2)
        outtxt = p.stdout.read()
    else:
        time.sleep(seconds); outtxt = ""
    wall = time.time() - t0
    stop.set(); th.join()
    r1 = resource.getrusage(resource.RUSAGE_CHILDREN)
    cpu = (r1.ru_utime - r0.ru_utime) + (r1.ru_stime - r0.ru_stime)
    late.sort()
    pct = lambda q: late[min(len(late) - 1, int(q * len(late)))] if late else 0
    missed = sum(x > 10 for x in late) / max(1, len(late)) * 100
    return {"wall": wall, "cpu": cpu, "cores": cpu / wall if wall else 0, "peak_mb": peak / 1024, "p50": pct(0.5), "p99": pct(0.99),
            "max": late[-1] if late else 0, "missed": missed, "out": outtxt}


def show(name, r):
    print(f"{name:34} wall {r['wall']:6.1f}s  cpu {r['cpu']:6.1f}s ({r['cores']:.2f} cores)  peak {r['peak_mb']:5.0f} MB  "
          f"| foreground lateness p50 {r['p50']:.2f} ms  p99 {r['p99']:.2f} ms  max {r['max']:.1f} ms  missed {r['missed']:.2f}%", flush=True)


if __name__ == "__main__":
    nice = int(sys.argv[sys.argv.index("--nice") + 1]) if "--nice" in sys.argv else 0
    cmd = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else None
    show("idle machine (baseline)", run_probe(seconds=10))
    if cmd:
        r = run_probe(cmd=cmd, nice=nice)
        show("while syncing" + (f" (nice {nice})" if nice else ""), r)
        print(r["out"].strip().splitlines()[-1] if r["out"].strip() else "")
