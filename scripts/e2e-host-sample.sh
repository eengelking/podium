#!/usr/bin/env bash
# Samples a Linux host while the end-to-end suite runs (#1174): its load, its CPU, I/O and memory pressure, and how many containers and
# networks the engine holds. e2e.yml starts it beside the suite so a trial run records what the next increase in shards, or in databases at
# once, has to fit in. scripts/e2e-sample.py does the same for a Mac (Podman, per container); this one reads /proc and needs no Python.
set -uo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/e2e-host-sample.sh sample [SECONDS] > FILE.csv      (default 10; stop it with kill)
       scripts/e2e-host-sample.sh summary FILE.csv

sample   Writes a CSV header, then one row every SECONDS to stdout:
           time,load1,cpu_some_avg10,io_some_avg10,io_full_avg10,mem_some_avg10,containers,networks
         The pressure columns are the percent of the last 10 seconds that tasks waited (/proc/pressure, "some" is at least one task,
         "full" is all of them). containers and networks are the engine's counts (E2E_ENGINE, else docker, else podman). A column the
         host does not give is empty.
summary  Prints the peak of each column of a sample file, and the sample count, on one line each.
It opens no path itself: the caller chooses the file.
USAGE
}

engine() { local e="${E2E_ENGINE:-}"; [[ -n "$e" ]] || { command -v docker >/dev/null 2>&1 && e=docker || e=podman; }; echo "$e"; }
# avg10 of the "some" or "full" line of a pressure file, or empty.
psi() { sed -n "s/^$2 .*avg10=\([0-9.]*\).*/\1/p" "/proc/pressure/$1" 2>/dev/null | head -n 1; }

case "${1:-}" in
  -h|--help|"") usage; [[ -n "${1:-}" ]] && exit 0; exit 2 ;;
  sample)
    interval="${2:-10}"
    [[ "$interval" =~ ^[1-9][0-9]*$ ]] || { echo "SECONDS needs a whole number of 1 or more, not \"$interval\"" >&2; exit 2; }
    eng="$(engine)"
    echo "time,load1,cpu_some_avg10,io_some_avg10,io_full_avg10,mem_some_avg10,containers,networks"
    while :; do
      load1="$(cut -d' ' -f1 /proc/loadavg 2>/dev/null)"
      ctr="$("$eng" ps -q 2>/dev/null | wc -l | tr -d ' ')"
      net="$("$eng" network ls -q 2>/dev/null | wc -l | tr -d ' ')"
      echo "$(date -u +%H:%M:%S),$load1,$(psi cpu some),$(psi io some),$(psi io full),$(psi memory some),$ctr,$net"
      sleep "$interval"
    done ;;
  summary)
    [[ -r "${2:-}" ]] || { echo "summary needs a sample file" >&2; exit 2; }
    awk -F, 'NR == 1 { for (i = 2; i <= NF; i++) name[i] = $i; next }
             { n++; for (i = 2; i <= NF; i++) if ($i != "" && $i + 0 > max[i] + 0) max[i] = $i }
             END { printf "samples: %d\n", n; for (i = 2; i in name; i++) printf "peak %s: %s\n", name[i], (i in max ? max[i] : "n/a") }' "$2" ;;
  *) echo "unknown command $1 (see --help)" >&2; exit 2 ;;
esac
