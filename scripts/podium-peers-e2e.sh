#!/usr/bin/env bash
# Orchestrator messaging (#347) end to end, with real Claude Code sessions against a throwaway Podium server built
# from this checkout. docs/MESSAGING.md, "Testing it end to end", walks through a run. See --help.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/podium-peers-e2e.sh up [options]
       scripts/podium-peers-e2e.sh down [options]
       scripts/podium-peers-e2e.sh -h | --help

Tries orchestrator messaging end to end with real Claude Code sessions, against a
throwaway Podium server built from this checkout. docs/MESSAGING.md has the steps.

up    Makes a work folder and writes a new admin secret to a file in it (mode 0600).
      The folder must be new or empty, or one an earlier up made. Builds the server
      and the UI from this checkout (npm run build), unless --no-build. Starts
      the server on --port in the background, with its database in the work folder
      (or, when $PODIUM_DB is a postgres:// URL, a new database on that server, whose
      URL goes in a 0600 file in the work folder; down drops it), and waits for it. Seeds one person with podium-peers-seed.mjs --talk, which turns
      on the messaging, responding and activity-feed flags, adds four made-up machines
      with conversations, and writes the person's name and token to a 0600 file. Then
      starts the Claude Code sessions in tmux, one window each, each in its own git
      folder, loading podium-reporter from this checkout with --plugin-dir and
      reporting to the server as that person. Prints the URL, the person's name and
      where the token and secret files are, never the token or the secret.
down  Kills the tmux session, stops the server that up started (by its saved pid) and
      drops the PostgreSQL database up made, if any, and removes the work folder,
      unless --keep (which keeps both). It removes only a folder up made, and
      never /, the home folder, this checkout, a folder holding it, or a link.

Options:
  --dir PATH      work folder (default: $TMPDIR/podium-peers-e2e); not a symbolic link
  --port N        server port (default 4380)
  --sessions N    Claude Code sessions to start, 1 to 20 (default 4: planner, tester,
                  notes, docs, then s5, s6 and so on)
  --model NAME    model for every session (default haiku)
  --tmux NAME     tmux session name (default podium-e2e)
  --name NAME     the person to seed (default Ed)
  --no-build      up: skip npm run build and serve server/dist and frontend/dist as they
                  are (faster, but an old build tests old code)
  --keep          down: keep the work folder (database, server log, seed output)
  --dry-run       print what it would do, and start, stop or write nothing
  -h, --help      show this help

Notes:
  - Each session starts in a new folder, so Claude Code asks once in each window
    whether to trust it. Attach with `tmux attach -t podium-e2e` and accept it in
    every window before sending a prompt.
  - The sessions use the model and cost money. --model haiku keeps that low, and
    `down` ends them.
  - To type a prompt into a window, send the text, pause, then send Enter on its own.
    A long prompt sent with its Enter in one send-keys is often left unsubmitted:
      tmux send-keys -t podium-e2e:planner -l 'Run podium_peers and tell me what you see.'
      sleep 1; tmux send-keys -t podium-e2e:planner C-m
  - All the sessions run on this machine, so they share one reporter. Before they can
    message each other, sign in on My reporters with the printed name and the token
    from the token file, and give this machine the right to send to itself (the
    Grid's diagonal), or turn on Trust my own reporters.
  - The installed podium-reporter is turned off for these sessions only, through the
    --settings file up writes. ~/.claude/settings.json is not touched.
  - The token and the secret are read from their files inside each window and passed
    in the environment, never on a command line that ps shows.
  - Needs node, curl, git, tmux and claude on PATH.
USAGE
}

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MOD="$ROOT/mod/podium-reporter"
MARKER=".podium-peers-e2e"
TOOLS="mcp__podium-reporter__podium_peers mcp__podium-reporter__podium_send mcp__podium-reporter__podium_request_access"

CMD=""
TMP_BASE="${TMPDIR:-/tmp}"
DIR="${TMP_BASE%/}/podium-peers-e2e"
PORT=4380
SESSIONS=4
MODEL=haiku
TMUX_NAME=podium-e2e
PERSON=Ed
KEEP=0
DRY=0
BUILD=1

die() { echo "podium-peers-e2e: $*" >&2; exit 2; }
need_value() { [[ $# -ge 2 && -n "$2" ]] || die "$1 needs a value (see --help)"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    up|down) [[ -z "$CMD" ]] || die "give one of up or down"; CMD="$1" ;;
    --dir) need_value "$@"; DIR="$2"; shift ;;
    --port) need_value "$@"; PORT="$2"; shift ;;
    --sessions) need_value "$@"; SESSIONS="$2"; shift ;;
    --model) need_value "$@"; MODEL="$2"; shift ;;
    --tmux) need_value "$@"; TMUX_NAME="$2"; shift ;;
    --name) need_value "$@"; PERSON="$2"; shift ;;
    --keep) KEEP=1 ;;
    --no-build) BUILD=0 ;;
    --dry-run) DRY=1 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done

[[ -n "$CMD" ]] || { usage >&2; exit 2; }
# No leading zero: bash reads 09 as octal and fails, and 0099 as 99.
if [[ ! "$PORT" =~ ^[1-9][0-9]{0,4}$ ]] || (( 10#$PORT > 65535 )); then die "--port must be a number from 1 to 65535"; fi
if [[ ! "$SESSIONS" =~ ^[1-9][0-9]?$ ]] || (( 10#$SESSIONS > 20 )); then die "--sessions must be a number from 1 to 20"; fi
[[ "$TMUX_NAME" =~ ^[A-Za-z0-9_-]+$ ]] || die "--tmux takes letters, digits, - and _ only"
[[ "$MODEL" =~ ^[A-Za-z0-9._:-]+$ ]] || die "--model takes letters, digits, '.', ':', - and _ only"
# The paths go inside single quotes in the windows' commands.
[[ "$DIR" != *"'"* && "$ROOT" != *"'"* ]] || die "the work folder and the checkout path cannot hold a single quote"
[[ "$DIR" = /* ]] || DIR="$PWD/$DIR"
while [[ "$DIR" == */ && "$DIR" != "/" ]]; do DIR="${DIR%/}"; done

# A folder as the file system resolves it, when it exists.
real_dir() { (cd -P -- "$1" 2>/dev/null && pwd -P); }

# down removes the work folder whole, so it can never be /, the home folder, this checkout or a folder that holds it,
# whatever marker is in it, nor a link, whose target up wrote to and which rm would not follow.
guard_dir() {
  [[ ! -L "$DIR" ]] || die "the work folder cannot be a symbolic link: $DIR"
  local real home root
  real="$(real_dir "$DIR")" || return 0
  home="$(real_dir "${HOME:-/}")" || home="/"
  root="$(real_dir "$ROOT")"
  [[ "$real" != "/" && "$real" != "$home" ]] || die "the work folder cannot be / or the home folder: $DIR"
  [[ "$root" != "$real" && "$root" != "$real"/* ]] || die "the work folder cannot be this checkout or a folder that holds it: $DIR"
}
guard_dir

URL="http://127.0.0.1:$PORT"
SECRET_FILE="$DIR/admin-secret"
SEED_FILE="$DIR/seed.out"
SETTINGS="$DIR/settings.json"
PID_FILE="$DIR/server.pid"
DB_URL_FILE="$DIR/database-url"
LOG_FILE="$DIR/server.log"

say() { printf '%s\n' "$*"; }
step() { if (( DRY )); then say "would: $*"; else say "$*"; fi; }

session_name() {
  case "$1" in
    1) echo planner ;; 2) echo tester ;; 3) echo notes ;; 4) echo docs ;;
    *) echo "s$1" ;;
  esac
}

# The pid up saved, when it is still this checkout's server, so down never stops another process that took the pid.
server_pid() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(cat "$PID_FILE")"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  ps -p "$pid" -o command= 2>/dev/null | grep -q "server/dist/index.js" || return 1
  echo "$pid"
}

up() {
  # down removes a folder that holds the marker, so up writes it only into a folder that is new, empty, or its own.
  if [[ -e "$DIR" ]]; then
    [[ -d "$DIR" ]] || die "the work folder $DIR is not a folder"
    if [[ ! -f "$DIR/$MARKER" && -n "$(ls -A "$DIR")" ]]; then die "the work folder $DIR is not empty and an earlier up did not make it; pick a new or empty folder"; fi
  fi
  if (( ! DRY )); then
    local tool
    for tool in node curl git tmux claude; do
      command -v "$tool" >/dev/null || die "$tool is not on PATH"
    done
    if server_pid >/dev/null; then die "a server from an earlier up is still running; run down first (--dir $DIR)"; fi
    if tmux has-session -t "$TMUX_NAME" 2>/dev/null; then die "the tmux session $TMUX_NAME already exists; run down, or pick another with --tmux"; fi
    if curl -s -o /dev/null -m 2 "$URL/"; then die "something already answers on port $PORT; pick another with --port"; fi
  fi

  step "make the work folder $DIR (mode 0700)"
  if (( ! DRY )); then
    umask 077
    mkdir -p "$DIR"
    : >"$DIR/$MARKER"
  fi

  step "write a new admin secret to $SECRET_FILE (mode 0600)"
  if (( ! DRY )); then
    node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('hex'))" >"$SECRET_FILE"
  fi

  # Built every time, so the server and the UI are this checkout's code, not an older dist's.
  if (( BUILD )); then
    step "build the server and the UI from this checkout (npm run build), log $DIR/build.log"
    if (( ! DRY )); then (cd "$ROOT" && npm run build >"$DIR/build.log" 2>&1) || { tail -40 "$DIR/build.log" >&2; exit 1; }; fi
  else
    step "skip the build (--no-build) and serve server/dist and frontend/dist as they are"
    if (( ! DRY )) && [[ ! -f "$ROOT/server/dist/index.js" || ! -f "$ROOT/frontend/dist/index.html" ]]; then die "--no-build, but server/dist or frontend/dist is missing; run up without it"; fi
  fi

  # A SQLite file in the work folder, or, when PODIUM_DB is a postgres:// URL, a database of its own on that server, which down drops.
  # Its URL (it holds the password) goes in a 0600 file, never on a command line or in the output.
  local db="$DIR/podium.sqlite" dblabel="$DIR/podium.sqlite"
  if node "$ROOT/scripts/throwaway-db.mjs" is-postgres "${PODIUM_DB:-}"; then
    dblabel="a throwaway database on $(node "$ROOT/scripts/throwaway-db.mjs" label "$PODIUM_DB")"
    if (( ! DRY )); then
      # Installed before the database is made: an up that fails from here on (the server does not start, the seed fails) drops it
      # again, so a failed up leaves no database behind. A finished up clears UP_DB, and down drops the database from then on.
      UP_DB=""
      trap 'drop_failed_up_db' EXIT
      db="$(node "$ROOT/scripts/throwaway-db.mjs" create "$PODIUM_DB" peers)" || die "could not make a database on the PostgreSQL server in PODIUM_DB"
      UP_DB="$db"
      printf '%s\n' "$db" >"$DB_URL_FILE"
      dblabel="$(node "$ROOT/scripts/throwaway-db.mjs" label "$db")"
    fi
  fi
  step "start the server from $ROOT on $URL, database $dblabel, log $LOG_FILE, pid in $PID_FILE"
  if (( ! DRY )); then
    (
      cd "$ROOT"
      PODIUM_TOKEN="$(cat "$SECRET_FILE")" PORT="$PORT" HOST=127.0.0.1 PODIUM_DB="$db" PODIUM_DATA_DIR="$DIR" \
        nohup node server/dist/index.js >"$LOG_FILE" 2>&1 &
      echo $! >"$PID_FILE"
    )
    local ok=0 _
    for _ in $(seq 1 80); do
      if curl -sf -m 2 "$URL/api/fleet/health" >/dev/null; then ok=1; break; fi
      sleep 0.25
    done
    if (( ! ok )); then
      echo "the server did not answer on $URL; its log:" >&2
      tail -40 "$LOG_FILE" >&2
      exit 1
    fi
  fi

  step "seed the person $PERSON with podium-peers-seed.mjs --talk, output (name and token) in $SEED_FILE (mode 0600)"
  if (( ! DRY )); then
    PODIUM_TOKEN="$(cat "$SECRET_FILE")" node "$ROOT/scripts/podium-peers-seed.mjs" --url "$URL" --name "$PERSON" --talk >"$SEED_FILE"
  fi

  step "write $SETTINGS: the installed podium-reporter off, this checkout's copy reporting to $URL with peers, activityFeed and respond on"
  if (( ! DRY )); then
    cat >"$SETTINGS" <<JSON
{
  "enabledPlugins": { "podium-reporter@eengelking-marketplace": false },
  "pluginConfigs": {
    "podium-reporter": {
      "options": { "serverUrl": "$URL", "peers": true, "activityFeed": true, "respond": "everything", "heartbeatMs": 3000 }
    }
  }
}
JSON
  fi

  step "start the tmux session $TMUX_NAME"
  (( DRY )) || tmux new-session -d -s "$TMUX_NAME" -n boot -x 200 -y 50
  local i name dir names=""
  for i in $(seq 1 "$SESSIONS"); do
    name="$(session_name "$i")"
    dir="$DIR/proj-$name"
    names="$names $name"
    step "start Claude Code ($MODEL) as $name in $dir, with --plugin-dir $MOD"
    (( DRY )) && continue
    mkdir -p "$dir"
    [[ -d "$dir/.git" ]] || git -C "$dir" init -q
    tmux new-window -t "$TMUX_NAME" -n "$name" -c "$dir"
    # Typed into the window's shell: the name and token are read from the file there, so neither is on this
    # script's command line, nor on tmux's.
    tmux send-keys -t "$TMUX_NAME:$name" "export PODIUM_USER=\"\$(sed -n 's/^name=//p' '$SEED_FILE')\" PODIUM_TOKEN=\"\$(sed -n 's/^token=//p' '$SEED_FILE')\"; claude --plugin-dir '$MOD' --settings '$SETTINGS' --model '$MODEL' -n '$name' --allowedTools $TOOLS" C-m
  done
  (( DRY )) || tmux kill-window -t "$TMUX_NAME:boot"

  local who="$PERSON"
  (( DRY )) || who="$(sed -n 's/^name=//p' "$SEED_FILE")"
  say ""
  say "Podium:    $URL/#/"
  say "Person:    $who (sign in from the top bar with this name and the token)"
  say "Token:     the token= line in $SEED_FILE"
  say "Secret:    $SECRET_FILE (Admin, with the name Admin)"
  say "Sessions:  tmux attach -t $TMUX_NAME (windows:$names); accept the trust prompt in each"
  say "Next:      on My reporters, let this machine send to itself (the Grid's diagonal), or turn on Trust my own reporters"
  say "Stop:      scripts/podium-peers-e2e.sh down --dir '$DIR' --tmux $TMUX_NAME"
  UP_DB=""
}

# EXIT trap of an up that made a database: drops it unless up finished (UP_DB cleared). Nothing to do when none was made.
drop_failed_up_db() {
  [[ -n "${UP_DB:-}" ]] || return 0
  if node "$ROOT/scripts/throwaway-db.mjs" drop "$UP_DB" >/dev/null 2>&1; then rm -f "$DB_URL_FILE"
  else echo "up failed and could not drop its database; drop it by hand (its name is in $DB_URL_FILE)" >&2; fi
  UP_DB=""
}

down() {
  if (( DRY )); then
    step "kill the tmux session $TMUX_NAME, if it exists"
  elif tmux has-session -t "$TMUX_NAME" 2>/dev/null; then
    step "kill the tmux session $TMUX_NAME"
    tmux kill-session -t "$TMUX_NAME"
  fi

  if (( DRY )); then
    step "stop the server whose pid is in $PID_FILE, if it is still running"
  else
    local pid _
    if pid="$(server_pid)"; then
      step "stop the server (pid $pid)"
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
      kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
    fi
  fi

  if (( DRY )); then
    step "drop the PostgreSQL database up made, if $DB_URL_FILE exists"
  elif [[ -f "$DIR/$MARKER" && -f "$DB_URL_FILE" ]]; then
    if (( KEEP )); then
      say "keeping the PostgreSQL database named in $DB_URL_FILE"
    else
      step "drop the throwaway PostgreSQL database up made"
      node "$ROOT/scripts/throwaway-db.mjs" drop "$(cat "$DB_URL_FILE")" || say "could not drop it; drop it by hand (its name is in $DB_URL_FILE)"
    fi
  fi

  if (( KEEP )); then
    say "keeping $DIR"
  elif (( DRY )); then
    step "remove $DIR, if up made it"
  elif [[ -f "$DIR/$MARKER" ]]; then
    step "remove $DIR"
    rm -rf "$DIR"
  elif [[ -e "$DIR" ]]; then
    say "not removing $DIR: up did not make it"
  fi
}

"$CMD"
