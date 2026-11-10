#!/usr/bin/env python3
"""Usage: e2e-sample.py [SECONDS] > FILE.csv      (SECONDS between samples, default 5; stop it with kill)
Writes one CSV row per measure to stdout every SECONDS: time,kind,name,cpu_pct,mem_mb,pids,load1,load5,load15
  kind host: the Mac, with cpu_pct its busy percent (100 - idle) and the three load averages.
  kind ctr:  a Podman container, with cpu_pct the change in its cumulative CPU time over the interval in percent of ONE core
             (100 = one core busy), mem_mb its memory and pids its process count.
It writes to stdout so the caller chooses the file, and opens no path itself. Run it beside a whole-suite run to see whether the CPU
is busy or idle while the specs wait (#1130):
  python3 -I scripts/e2e-sample.py 5 > "$OUT/sample.csv" & SP=$!; bash scripts/e2e-all.sh --shards 3; kill $SP"""
import json, re, subprocess, sys, time

if any(a in ('-h', '--help') for a in sys.argv[1:]):
    print(__doc__)
    sys.exit(0)
try:
    every = float(sys.argv[1]) if len(sys.argv) > 1 else 5.0
    if every <= 0:
        raise ValueError
except ValueError:
    print(__doc__, file=sys.stderr)
    sys.exit(2)

SECONDS_PER = {'h': 3600, 'm': 60, 's': 1, 'ms': 0.001}
MB_PER = {'B': 1 / 1e6, 'kB': 1 / 1e3, 'KB': 1 / 1e3, 'MB': 1, 'GB': 1e3, 'MiB': 1.048576, 'GiB': 1073.74}


def number_end(s, i):
    """The index just after the digits and dots that start at i."""
    while i < len(s) and (s[i].isdigit() or s[i] == '.'):
        i += 1
    return i


def secs(s):
    """Seconds in a Go duration: 1h2m3.5s, 12m25.7s, 43.08s, 850ms."""
    total, i = 0.0, 0
    while i < len(s):
        j = number_end(s, i)
        k = j
        while k < len(s) and s[k].isalpha():
            k += 1
        if j == i or k == j:
            break
        total += float(s[i:j]) * SECONDS_PER.get(s[j:k], 0)
        i = k
    return total


def mb(s):
    """Megabytes in a size such as 305.9MB or 1.2GiB, or '' when it has no number."""
    s = s.strip()
    j = number_end(s, 0)
    return round(float(s[:j]) * MB_PER.get(s[j:].strip(), 1), 1) if j else ''


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True).stdout


def row(*cells):
    print(','.join(str(c) for c in cells), flush=True)


prev = {}
row('time', 'kind', 'name', 'cpu_pct', 'mem_mb', 'pids', 'load1', 'load5', 'load15')
while True:
    now = time.time()
    ts = time.strftime('%H:%M:%S')
    load = re.findall(r'[\d.]+', run(['uptime']).split('load average')[1])[:3]
    idle = re.search(r'([\d.]+)% idle', run(['top', '-l', '1', '-n', '0']))
    row(ts, 'host', 'mac', round(100 - float(idle[1]), 1) if idle else '', '', '', *load)
    stats = run(['podman', 'stats', '--no-stream', '--format', 'json'])
    for d in (json.loads(stats) if stats.strip() else []):
        name, cpu_time = d['name'], secs(d['cpu_time'])
        pct = round((cpu_time - prev[name][0]) / (now - prev[name][1]) * 100, 1) if name in prev else ''
        prev[name] = (cpu_time, now)
        row(ts, 'ctr', name, pct, mb(d['mem_usage'].split('/')[0]), d['pids'], '', '', '')
    time.sleep(max(0, every - (time.time() - now)))
