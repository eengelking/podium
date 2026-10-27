#!/usr/bin/env bash
# Browser cost of an open Podium tab at a fleet size (#682). Companion to podium-perf.mjs, which measures the server.
set -uo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/podium-perf-browser.sh [--sessions N] [--agents N] [--seconds N] [--width PX] [-h]

Starts a throwaway Podium server (built server/dist, a free port, a temp database), runs the simulator against it, opens the wall
in headless Chrome (scripts/page-shot.mjs) and, over --seconds, reports as JSON: DOM node count, JS heap, long tasks (over 50 ms)
and how many frames the page drew. Needs `npm run build` first.

  --sessions N   Simulated sessions (default 20, max 50)
  --agents N     Extra agents per session (default 10)
  --seconds N    How long the tab is watched (default 30)
  --width PX     Viewport width (default 1440)
  -h, --help     Show this help

Everything it starts is stopped at the end and its temp files are removed. GPU is measured by scripts/gpu-sample.sh (see #280).
USAGE
}

SESSIONS=20
AGENTS=10
SECONDS_RUN=30
WIDTH=1440
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --sessions) SESSIONS="$2"; shift ;;
    --agents) AGENTS="$2"; shift ;;
    --seconds) SECONDS_RUN="$2"; shift ;;
    --width) WIDTH="$2"; shift ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/podium-perf-browser.XXXXXX")"
PIDS=()
PORT="$(node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"
URL="http://127.0.0.1:$PORT"
TOKEN="$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")"

cleanup() {
  for p in "${PIDS[@]:-}"; do [[ -n "$p" ]] && kill "$p" 2>/dev/null; done
  sleep 0.5
  for p in "${PIDS[@]:-}"; do [[ -n "$p" ]] && kill -9 "$p" 2>/dev/null; done
  rm -rf "$TMP"
}
trap cleanup EXIT

[[ -f "$ROOT/server/dist/index.js" && -d "$ROOT/frontend/dist" ]] || { echo "build first: npm run build" >&2; exit 1; }

PODIUM_DB="$TMP/podium.sqlite" PODIUM_TOKEN="$TOKEN" PORT="$PORT" HOST=127.0.0.1 node "$ROOT/server/dist/index.js" >"$TMP/server.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 80); do curl -sf "$URL/api/health" >/dev/null && break; sleep 0.25; done
curl -sf "$URL/api/health" >/dev/null || { echo "server did not start"; cat "$TMP/server.log"; exit 1; }

"$ROOT/node_modules/.bin/tsx" "$ROOT/scripts/podium-sim.ts" --url "$URL" --token "$TOKEN" --sessions "$SESSIONS" --agents "$AGENTS" --seed 682 --duration $((SECONDS_RUN + 60)) >/dev/null 2>&1 &
PIDS+=($!)
sleep 10

EVAL="(async () => {
  const longTasks = [];
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) longTasks.push(e.duration); }).observe({ entryTypes: ['longtask'] }); } catch {}
  let frames = 0;
  const tick = () => { frames++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  const heap = () => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576 * 10) / 10 : null);
  const first = heap();
  await new Promise((r) => setTimeout(r, $SECONDS_RUN * 1000));
  return {
    domNodes: document.getElementsByTagName('*').length,
    cards: document.querySelectorAll('[class*=card]').length,
    heapMbStart: first, heapMbEnd: heap(),
    longTasks: longTasks.length, longTaskMsTotal: Math.round(longTasks.reduce((a, b) => a + b, 0)), longTaskMsMax: Math.round(Math.max(0, ...longTasks)),
    framesPerSecond: Math.round(frames / $SECONDS_RUN * 10) / 10,
    transferKb: Math.round(performance.getEntriesByType('resource').reduce((a, e) => a + (e.transferSize || 0), 0) / 1024),
  };
})()"

echo "podium-perf-browser: $SESSIONS sessions x $AGENTS agents, $SECONDS_RUN s, width $WIDTH, $URL" >&2
node "$ROOT/scripts/page-shot.mjs" --url "$URL/" --width "$WIDTH" --height 900 --wait 3000 --eval "$EVAL" --out "$TMP/shot.png"
