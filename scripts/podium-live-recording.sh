#!/bin/bash
# Live check of session recording (#353) with a real Claude Code session in tmux against a THROWAWAY Podium server.
# It never touches your own Podium: the server binds 127.0.0.1 on its own port with a temp data dir and a random
# secret, and the test session loads no user settings (--setting-sources project), so an installed podium-reporter
# is not loaded. Run `--help` for the steps. Needs tmux, jq, curl, node 22+, and `claude` logged in.

usage() {
  cat <<'EOF'
Usage: scripts/podium-live-recording.sh <command> [args]

  server [port]           start a throwaway server (default port 4793) in the background; prints the work dir
  session <dir> [name]    start one contained Claude Code session in tmux (default name p353-live-a) on haiku,
                          with the mod from this checkout, respond=everything, activityFeed and sessionRecording on
  api <dir> <METHOD> <path> [json]
                          call the server as the signed-in Admin (respond and admin headers sent)
  stop <dir> [name]       kill that tmux session; with no name, kills every p353-live-* session
  clean <dir>             stop the server and delete the work dir (only if it was made by `server`)

Steps: server, then `session`, answer the folder-trust prompt (tmux send-keys -t <name> Down Enter), send one prompt
(the mod reports after a session's first turn), find the session id with
  api <dir> GET /api/fleet/state | jq -r '.sessions[].id'
then start recording with
  api <dir> PUT /api/fleet/respond/sessions/<id>/recording '{"loops":["@orchestrator"]}'
and drive prompts with tmux send-keys / paste-buffer and read them back with
  api <dir> GET '/api/fleet/respond/sessions/<id>/recording?limit=50'
Admin unlock lasts 10 idle minutes; sign in again with `api <dir> SIGNIN` when a call answers "locked" or 401.
EOF
}

die() { echo "podium-live-recording: $*" >&2; exit 1; }
HERE="$(cd "$(dirname "$0")/.." && pwd)"

case "${1:-}" in
  -h|--help|"") usage ;;
  server)
    port="${2:-4793}"
    dir="$(mktemp -d)" || die "no temp dir"
    mkdir "$dir/data" "$dir/work"
    openssl rand -hex 24 > "$dir/secret"
    echo "$port" > "$dir/port"
    [[ -f "$HERE/server/dist/index.js" ]] || die "run npm run build first"
    HOST=127.0.0.1 PORT="$port" PODIUM_DB="$dir/data/podium.sqlite" PODIUM_TOKEN="$(cat "$dir/secret")" \
      nohup node "$HERE/server/dist/index.js" > "$dir/server.log" 2>&1 &
    echo $! > "$dir/server.pid"
    sleep 2
    "$0" api "$dir" SIGNIN > /dev/null
    "$0" api "$dir" PUT /api/admin/settings '{"features":{"respond":true}}' > /dev/null
    "$0" api "$dir" PUT /api/admin/settings '{"features":{"session-recording":true}}' > /dev/null
    echo "work dir: $dir  (server pid $(cat "$dir/server.pid"), port $port, flags respond and session-recording on)"
    ;;
  api)
    dir="$2"; method="$3"; path="$4"; body="${5:-}"
    [[ -f "$dir/secret" ]] || die "not a work dir: $dir"
    port="$(cat "$dir/port")"; base="http://127.0.0.1:$port"
    if [[ "$method" == "SIGNIN" ]]; then
      creds="{\"name\":\"Admin\",\"token\":\"$(cat "$dir/secret")\"}"
      for p in /api/fleet/respond/sign-in /api/admin/unlock; do
        curl -s -m 20 -X POST -b "$dir/jar" -c "$dir/jar" -H 'X-Podium-Respond: 1' -H 'X-Podium-Admin: 1' \
          -H 'Content-Type: application/json' -H "Origin: $base" --data "$creds" "$base$p"; echo
      done
      exit 0
    fi
    args=(-s -m 20 -X "$method" -b "$dir/jar" -c "$dir/jar" -H 'X-Podium-Respond: 1' -H 'X-Podium-Admin: 1' -H "Origin: $base")
    [[ -n "$body" ]] && args+=(-H 'Content-Type: application/json' --data "$body")
    curl "${args[@]}" "$base$path"; echo
    ;;
  session)
    dir="$2"; name="${3:-p353-live-a}"
    [[ -f "$dir/secret" ]] || die "not a work dir: $dir"
    case "$name" in p353-live-*) ;; *) die "name must start with p353-live-" ;; esac
    port="$(cat "$dir/port")"
    # Settings for this session only: the installed reporter off, this mod's options, the token as the env override.
    cat > "$dir/settings.json" <<EOF
{
  "enabledPlugins": { "podium-reporter@eengelking-marketplace": false },
  "pluginConfigs": { "podium-reporter": { "options": { "serverUrl": "http://127.0.0.1:$port", "userName": "", "respond": "everything", "activityFeed": true, "sessionRecording": true, "flushIntervalMs": 500, "heartbeatMs": 2000 } } },
  "env": { "PODIUM_TOKEN": "$(cat "$dir/secret")" }
}
EOF
    echo '{"mcpServers":{}}' > "$dir/mcp.json"
    # env -i: nothing of the parent's PODIUM_*/CLAUDE* variables reaches the session.
    tmux new-session -d -s "$name" -x 200 -y 50 -c "$dir/work" \
      "env -i HOME=$HOME USER=$USER LOGNAME=$USER SHELL=/bin/zsh TMPDIR=${TMPDIR:-/tmp} PATH=$PATH TERM=xterm-256color claude --permission-mode default --plugin-dir $HERE/mod/podium-reporter --settings $dir/settings.json --setting-sources project --strict-mcp-config --mcp-config $dir/mcp.json --model haiku --add-dir $dir/work"
    echo "started tmux session $name in $dir/work"
    ;;
  stop)
    dir="$2"; name="${3:-}"
    if [[ -n "$name" ]]; then tmux kill-session -t "$name"
    else tmux ls -F '#{session_name}' 2>/dev/null | grep '^p353-live-' | while read -r s; do tmux kill-session -t "$s"; done; fi
    ;;
  clean)
    dir="$2"
    [[ -f "$dir/server.pid" && -f "$dir/secret" ]] || die "not a work dir made by 'server': $dir"
    kill "$(cat "$dir/server.pid")" 2>/dev/null
    rm -r "$dir"
    echo "removed $dir"
    ;;
  *) usage; exit 1 ;;
esac
