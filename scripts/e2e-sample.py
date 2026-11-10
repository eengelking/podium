#!/usr/bin/env python3
"""Usage: e2e-sample.py OUTFILE [SECONDS]
Appends CSV rows every SECONDS (default 5): time,kind,name,cpu_pct,mem_mb,pids,load1,load5,load15
cpu_pct for a container is the change in its cumulative CPU time over the interval, in percent of ONE core (100 = one core busy).
cpu_pct for 'mac' is the host's overall busy percent (100 - idle). Stop with kill.
Run it beside a whole-suite run to see whether the CPU is busy or idle while the specs wait (#1130):
  python3 -I scripts/e2e-sample.py "$OUT/sample.csv" 5 & SP=$!; bash scripts/e2e-all.sh --shards 3; kill $SP"""
import json, re, subprocess, sys, time

if len(sys.argv) < 2 or sys.argv[1] in ('-h', '--help'):
    print(__doc__)
    sys.exit(0 if len(sys.argv) > 1 else 2)
out = sys.argv[1]; every = float(sys.argv[2]) if len(sys.argv) > 2 else 5

def secs(s):  # Go duration: 1h2m3.5s, 12m25.7s, 43.08s, 850ms
    t = 0.0
    for v, u in re.findall(r'([\d.]+)(ms|h|m|s)', s):
        t += float(v) * {'h': 3600, 'm': 60, 's': 1, 'ms': 0.001}[u]
    return t

def mb(s):
    m = re.match(r'([\d.]+)\s*([kKMGT]?i?B)', s)
    if not m: return ''
    return round(float(m[1]) * {'B': 1/1e6, 'kB': 1/1e3, 'KB': 1/1e3, 'MB': 1, 'GB': 1e3, 'MiB': 1.048576, 'GiB': 1073.74}.get(m[2], 1), 1)

prev = {}
with open(out, 'a', buffering=1) as f:
    f.write('time,kind,name,cpu_pct,mem_mb,pids,load1,load5,load15\n')
    while True:
        now = time.time(); ts = time.strftime('%H:%M:%S')
        load = re.findall(r'[\d.]+', subprocess.run(['uptime'], capture_output=True, text=True).stdout.split('load average')[1])[:3]
        top = subprocess.run(['top', '-l', '1', '-n', '0'], capture_output=True, text=True).stdout
        idle = re.search(r'([\d.]+)% idle', top)
        f.write(f"{ts},host,mac,{round(100 - float(idle[1]), 1) if idle else ''},,,{','.join(load)}\n")
        r = subprocess.run(['podman', 'stats', '--no-stream', '--format', 'json'], capture_output=True, text=True).stdout
        for d in (json.loads(r) if r.strip() else []):
            n = d['name']; c = secs(d['cpu_time'])
            pct = round((c - prev[n][0]) / (now - prev[n][1]) * 100, 1) if n in prev else ''
            prev[n] = (c, now)
            f.write(f"{ts},ctr,{n},{pct},{mb(d['mem_usage'].split('/')[0].strip())},{d['pids']},,,\n")
        time.sleep(max(0, every - (time.time() - now)))
