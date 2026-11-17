#!/usr/bin/env bash
# A throwaway Podium server with the simulator running, kept up until stopped, for measuring a real browser tab (#280).
# podium-perf-browser.sh does the same in headless Chrome and exits; this one stays up so a headed tab and scripts/gpu-sample.sh can measure it.
set -uo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/podium-throwaway-fleet.sh [--sessions N] [--agents N] [--speed X] [--frozen] [-h]

Starts a throwaway Podium server (built server/dist, a free port, a temp database) and the simulator against it, prints the wall URL
on one line, and keeps both running until Ctrl-C or SIGTERM, then stops them and removes the temp files. Needs `npm run build`.

  --sessions N   Simulated sessions (default 10, max 200)
  --agents N     Extra agents per session (default 10)
  --speed X      Simulated seconds per real second (default 1)
  --frozen       Stop the simulator after 15 s, so the data stops changing (the wall as it is when no updates arrive)
  -h, --help     Show this help
USAGE
}

SESSIONS=10 AGENTS=10 SPEED=1 FROZEN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --sessions) SESSIONS="$2"; shift ;;
    --agents) AGENTS="$2"; shift ;;
    --speed) SPEED="$2"; shift ;;
    --frozen) FROZEN=1 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/podium-throwaway-fleet.XXXXXX")"
PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null; done
  sleep 0.5
  for p in "${PIDS[@]:-}"; do [[ -n "$p" ]] && kill -9 "$p" 2>/dev/null; done
  rm -rf "$TMP"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

[[ -f "$ROOT/server/dist/index.js" && -d "$ROOT/frontend/dist" ]] || { echo "build first: npm run build" >&2; exit 1; }
PORT="$(node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"
URL="http://127.0.0.1:$PORT"
TOKEN="$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")"

PODIUM_DB="$TMP/podium.sqlite" PODIUM_DATA_DIR="$TMP" PODIUM_TOKEN="$TOKEN" PORT="$PORT" HOST=127.0.0.1 node "$ROOT/server/dist/index.js" >"$TMP/server.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 80); do curl -sf "$URL/api/health" >/dev/null && break; sleep 0.25; done
curl -sf "$URL/api/health" >/dev/null || { echo "server did not start" >&2; cat "$TMP/server.log" >&2; exit 1; }

DURATION=()
(( FROZEN )) && DURATION=(--duration 15)
"$ROOT/node_modules/.bin/tsx" "$ROOT/scripts/podium-sim.ts" --url "$URL" --token "$TOKEN" --sessions "$SESSIONS" --agents "$AGENTS" --speed "$SPEED" --seed 280 ${DURATION[@]+"${DURATION[@]}"} >/dev/null 2>&1 &
PIDS+=($!)

echo "$URL/"
wait
