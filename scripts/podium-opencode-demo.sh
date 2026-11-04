#!/usr/bin/env bash
# Demo launcher: OpenCode + podium-reporter-opencode (mTLS to localhost:4318) + Ollama.
# Usage: podium-opencode-demo.sh start [--check-only] [-- <args for opencode>]   (start is the default)
#        podium-opencode-demo.sh stop    closes OpenCode, stops Ollama, confirms your OpenCode config is as it was
# The OpenCode config for the demo is passed inline (OPENCODE_CONFIG_CONTENT); ~/.config/opencode is never written.
# Env: PODIUM_REPO (default: the checkout this script is in), DEMO_MODEL (default gemma4:12b-pinned), DEMO_DIR (cwd for opencode)
set -euo pipefail

REPO="${PODIUM_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
MODEL="${DEMO_MODEL:-gemma4:12b-pinned}"
PEM="${PODIUM_REPORTER_CONFIG:-$(ls -t "$HOME"/.podium/reporter-config-*.pem 2>/dev/null | head -1 || true)}"
OLLAMA_URL="http://localhost:11434"
CHECK_ONLY=0
STATE_DIR="$HOME/.podium/demo"; PIDFILE="$STATE_DIR/opencode.pid"; SNAP="$STATE_DIR/opencode-config.sha"
CFG_DIR="$HOME/.config/opencode"
cfg_sum() { [[ -d "$CFG_DIR" ]] || { echo none; return 0; }; (cd "$CFG_DIR" && find . -path ./node_modules -prune -o -type f \( -name 'opencode.json*' -o -name 'cli.json' -o -name 'package.json' -o -name 'AGENTS.md' \) -print | sort | xargs shasum -a 256 2>/dev/null | shasum -a 256 | cut -d' ' -f1); }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '  ok: %s\n' "$*"; }
die()  { printf '  FAIL: %s\n' "$*" >&2; exit 1; }

case "${1:-}" in -h|--help)
  sed -n '2,6p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0;;
esac

if [[ "${1:-}" = "stop" ]]; then
  step "Stopping OpenCode"
  if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null && ps -p "$(cat "$PIDFILE")" -o command= | grep -q opencode; then
    pid=$(cat "$PIDFILE"); kill "$pid"
    for _ in $(seq 1 10); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid"
    ok "OpenCode (pid $pid) closed"
  else ok "OpenCode was not running"; fi
  rm -f "$PIDFILE"
  step "Stopping Ollama"
  ollama ps 2>/dev/null | awk 'NR>1{print $1}' | while read -r m; do ollama stop "$m" >/dev/null 2>&1 || true; done
  brew services stop ollama >/dev/null 2>&1 || true
  for _ in $(seq 1 15); do curl -sf "$OLLAMA_URL/api/tags" >/dev/null 2>&1 || break; sleep 1; done
  curl -sf "$OLLAMA_URL/api/tags" >/dev/null 2>&1 && die "Ollama still answers (started outside Homebrew? quit it by hand)"
  ok "Ollama stopped"
  step "OpenCode config"
  if [[ -f "$SNAP" ]]; then
    [[ "$(cfg_sum)" = "$(cat "$SNAP")" ]] && ok "$CFG_DIR is exactly as it was before the demo" || die "$CFG_DIR changed since start (something else edited it)"
    rm -f "$SNAP"
  else ok "no snapshot (demo never started); nothing to restore"; fi
  exit 0
fi
[[ "${1:-}" = "start" ]] && shift
[[ "${1:-}" = "--check-only" ]] && { CHECK_ONLY=1; shift; }
[[ "${1:-}" = "--" ]] && shift

step "1. Reporter certificate"
[[ -n "$PEM" ]] && [[ -f "$PEM" ]] || die "no reporter-config-*.pem in ~/.podium"
chmod 600 "$PEM"
server=$(sed -n 's/^# server: //p' "$PEM" | head -1)
expires=$(sed -n 's/^# expires: //p' "$PEM" | head -1)
case "$server" in https://localhost:4318|https://127.0.0.1:4318) ok "config points at $server";; *) die "config points at '$server', not localhost:4318";; esac
openssl x509 -in "$PEM" -noout >/dev/null 2>&1 || die "certificate in $PEM does not parse"
openssl x509 -in "$PEM" -noout -checkend 86400 >/dev/null || die "certificate expired or expires within 24h ($expires)"
ok "certificate valid, expires $expires"

step "2. Podium server"
"$REPO/bin/podiumctl" health >/dev/null 2>&1 || die "Podium is not answering (podiumctl start)"
ok "Podium answers at $("$REPO/bin/podiumctl" url)"
(exec 3<>/dev/tcp/127.0.0.1/4318) 2>/dev/null || die "reporter port 4318 is not open"
ok "reporter port 4318 open"

step "3. Build podium-reporter-opencode"
(cd "$REPO" && node scripts/plugin-build.mjs opencode) >/dev/null
[[ -f "$REPO/dist/opencode/package.json" ]] || die "dist/opencode was not built"
ok "built $REPO/dist/opencode"

step "4. Ollama"
if ! curl -sf "$OLLAMA_URL/api/tags" >/dev/null; then
  brew services start ollama >/dev/null
  for _ in $(seq 1 30); do curl -sf "$OLLAMA_URL/api/tags" >/dev/null && break; sleep 1; done
fi
curl -sf "$OLLAMA_URL/api/tags" >/dev/null || die "Ollama is not answering at $OLLAMA_URL"
ok "Ollama online"
ollama list | awk -v m="$MODEL" 'NR>1 && $1==m {f=1} END {exit !f}' || die "model $MODEL is not pulled (ollama list)"
echo "  loading $MODEL (first load can take a minute)..."
curl -sf "$OLLAMA_URL/api/generate" -d "{\"model\":\"$MODEL\",\"prompt\":\"hi\",\"stream\":false,\"keep_alive\":\"2h\",\"options\":{\"num_predict\":1}}" >/dev/null \
  || die "could not load $MODEL"
curl -sf "$OLLAMA_URL/api/ps" | grep -q "\"name\":\"$MODEL\"" || die "$MODEL is not running"
ok "$MODEL is running"

[[ "$CHECK_ONLY" = 1 ]] && { step "all checks passed (--check-only)"; exit 0; }

step "5. Start OpenCode"
export OPENCODE_CONFIG_CONTENT
OPENCODE_CONFIG_CONTENT=$(cat <<JSON
{
  "plugin": ["$REPO/dist/opencode"],
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama (local)",
      "options": { "baseURL": "$OLLAMA_URL/v1", "apiKey": "ollama" },
      "models": { "$MODEL": { "name": "$MODEL" } }
    }
  },
  "model": "ollama/$MODEL"
}
JSON
)
export PODIUM_REPORTER_CONFIG="$PEM"
mkdir -p "$STATE_DIR"
[[ -f "$SNAP" ]] || cfg_sum > "$SNAP"   # kept from the first start until stop
ok "config snapshot saved"
cd "${DEMO_DIR:-$PWD}"
# --standalone: a private server, so this config and the plugin apply (not the background service's).
echo $$ > "$PIDFILE"
exec opencode --standalone "$@"
