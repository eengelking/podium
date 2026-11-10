#!/usr/bin/env bash
# Runs the whole end-to-end suite once on every registered database, together, as ONE command that ends when the last run ends.
# An agent (podium-e2e-keeper) starts this once in the background and waits for its exit: no Monitor, no timer, no second command.
# Each database is one `E2E_DB=<kind> bash scripts/e2e-up.sh run`, with its own --out folder, log and containers (e2e-up.sh).
set -uo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/e2e-all.sh [--out DIR] [--no-build] [--databases "sqlite postgres"] [-- <cypress run arguments>]

Runs the whole suite once per database, all at once, waits for every run, and prints one last line:
  E2E RESULT: PASS|FAIL sqlite=PASS postgres=FAIL ...
Exit code: 0 every database passed, 1 any run failed, 2 a setup error.

Options:
  --out DIR          Folder for each database's log (<db>.log) and results (<db>/). Default: a new folder under $TMPDIR, outside the repo.
  --no-build         Pass --no-build to every run (the image of this checkout must already be built).
  --databases LIST   Space-separated kinds. Default: the list in .github/workflows/e2e.yml (DATABASES), never a list from memory.
  -h, --help         Show this help.
Anything after -- goes to `cypress run` in every run.

On INT or TERM it stops its runs (each run's own script removes its containers, network and volume when it exits).
USAGE
}

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="" ; BUILD=() ; DBS="" ; EXTRA=()
while (($#)); do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    --no-build) BUILD=(--no-build); shift ;;
    --databases) DBS="${2:-}"; shift 2 ;;
    --) shift; EXTRA=("$@"); break ;;
    *) echo "unknown option $1 (see --help)" >&2; exit 2 ;;
  esac
done

if [[ -z "$DBS" ]]; then
  DBS="$(sed -n "s/.*DATABASES: \${{ inputs.databases || '\([^']*\)' }}.*/\1/p" "$ROOT/.github/workflows/e2e.yml" | head -n 1)"
fi
[[ -n "$DBS" ]] || { echo "could not read DATABASES from .github/workflows/e2e.yml; pass --databases" >&2; exit 2; }
[[ -n "$OUT" ]] || OUT="$(mktemp -d "${TMPDIR:-/tmp}/podium-e2e-all.XXXXXX")"
case "$(cd "$OUT" 2>/dev/null && pwd)" in "$ROOT"|"$ROOT"/*) echo "--out must be outside the repo" >&2; exit 2 ;; esac
mkdir -p "$OUT"

PIDS=() ; KINDS=()
stop() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; }
trap 'stop; wait; exit 130' INT TERM

echo "e2e-all: databases: $DBS; logs in $OUT"
for db in $DBS; do
  E2E_DB="$db" bash "$ROOT/scripts/e2e-up.sh" run --out "$OUT/$db" ${BUILD[@]+"${BUILD[@]}"} ${EXTRA[@]+-- "${EXTRA[@]}"} > "$OUT/$db.log" 2>&1 &
  PIDS+=("$!") ; KINDS+=("$db")
done

fail=0 ; summary=""
for i in "${!PIDS[@]}"; do
  wait "${PIDS[$i]}"; code=$?
  db="${KINDS[$i]}"
  if ((code == 0)); then summary+=" $db=PASS"; else summary+=" $db=FAIL($code)"; fail=1; fi
  echo "--- $db (exit $code), last lines of $OUT/$db.log:"
  tail -n 12 "$OUT/$db.log"
done
if ((fail)); then echo "E2E RESULT: FAIL$summary"; else echo "E2E RESULT: PASS$summary"; fi
exit "$fail"
