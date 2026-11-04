#!/usr/bin/env bash
# Orchestrator messaging (#347) end to end, with real Claude Code or OpenCode sessions (one harness or a mix, #976) against
# a throwaway Podium server built from this checkout. docs/MESSAGING.md, "Testing it end to end", walks through a run. See --help.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/podium-peers-e2e.sh up [options]
       scripts/podium-peers-e2e.sh down [options]
       scripts/podium-peers-e2e.sh -h | --help

Tries orchestrator messaging end to end with real Claude Code or OpenCode sessions, against
a throwaway Podium server built from this checkout. docs/MESSAGING.md has the steps and
docs/LIVE_TESTING.md the live checks. --harness picks the harness of each window.

up    Makes a work folder and writes a new admin secret to a file in it (mode 0600).
      The folder must be new or empty, or one an earlier up made. Builds the server
      and the UI from this checkout (npm run build), unless --no-build. Starts
      the server on --port in the background, with its database in the work folder
      (or, when $PODIUM_DB is a postgres:// URL, a new database on that server, whose
      URL goes in a 0600 file in the work folder; down drops it), and waits for it. Seeds one person with podium-peers-seed.mjs --talk, which turns
      on the messaging, responding and activity-feed flags, adds four made-up machines
      with conversations, and writes the person's name and token to a 0600 file. Then
      starts the sessions in tmux, one window each, each in its own git folder,
      reporting to the server as that person. A Claude Code window loads podium-reporter
      from this checkout with --plugin-dir. An OpenCode window gets a scratch home folder
      with the plugin built from this checkout copied in, an opencode.json that asks before
      a shell or edit call, and runs `opencode --standalone`. Prints the URL, the person's
      name and where the token and secret files are, never the token or the secret.
down  Kills the tmux server up started (a private one, see --tmux), stops the server that up started (by its saved pid) and
      drops the PostgreSQL database up made, if any, and removes the work folder,
      unless --keep (which keeps both). It removes only a folder up made, and
      never /, the home folder, this checkout, a folder holding it, or a link. Nothing is
      left behind: no tmux server, no process, no port, no scratch folder.

Options:
  --dir PATH      work folder (default: $TMPDIR/podium-peers-e2e); not a symbolic link
  --port N        server port (default 4380)
  --sessions N    sessions to start, 1 to 20 (default 4: planner, tester,
                  notes, docs, then s5, s6 and so on)
  --harness LIST  the harness of each window: claudecode or opencode (default claudecode).
                  A comma list is used in turn, so `--harness claudecode,opencode` makes
                  planner and notes Claude Code and tester and docs OpenCode, all reporting
                  to the one server
  --model NAME    the model of every Claude Code window (default haiku)
  --opencode-model PROVIDER/MODEL
                  the model of every OpenCode window; required when one is started and
                  never defaulted, so no machine's model is baked in. A free hosted one
                  (opencode/<name>-free, see `opencode models`) needs no sign-in
  --opencode-config FILE
                  a JSON file merged into each OpenCode window's opencode.json, for a
                  local model's provider block (LM Studio and the like). The model and
                  the `ask` permissions of this script win over what the file says
  --activity-output, --session-recording, --file-diff
                  turn on that Admin flag in the seed and that reporter option in every
                  window (Claude Code: activityOutput, sessionRecording, fileDiff in the
                  settings file; OpenCode: PODIUM_ACTIVITY_OUTPUT, PODIUM_SESSION_RECORDING,
                  PODIUM_FILE_DIFF in its env file)
  --tmux NAME     tmux session name, also the name of the private tmux socket (default podium-e2e)
  --name NAME     the person to seed (default Ed)
  --no-build      up: skip npm run build and serve server/dist and frontend/dist as they
                  are (faster, but an old build tests old code)
  --keep          down: keep the work folder (database, server log, seed output)
  --dry-run       print what it would do, and start, stop or write nothing
  -h, --help      show this help

Notes:
  - Each Claude Code session starts in a new folder, so it asks once in each window
    whether to trust it. Attach with `tmux -L podium-e2e attach -t podium-e2e` and
    accept it in every window before sending a prompt. OpenCode asks nothing.
  - tmux runs on its own socket (-L), named like the session, so a window never joins
    another tmux server's environment. Give every tmux command -L NAME, such as
    `tmux -L podium-e2e ls`.
  - The sessions use the model and cost money. --model haiku keeps that low, a local or
    free hosted OpenCode model costs nothing, and `down` ends them.
  - To type a prompt into a window, send the text, pause, then send Enter on its own.
    A long prompt sent with its Enter in one send-keys is often left unsubmitted:
      tmux -L podium-e2e send-keys -t podium-e2e:planner -l 'Run podium_peers and tell me what you see.'
      sleep 1; tmux -L podium-e2e send-keys -t podium-e2e:planner C-m
  - All the Claude Code sessions run on this machine, so they share one reporter (each
    OpenCode window has its own scratch home, so it is another machine to the server). Before they can
    message each other, sign in on My reporters with the printed name and the token
    from the token file, and give this machine the right to send to itself (the
    Grid's diagonal), or turn on Trust my own reporters.
  - The installed podium-reporter is turned off for the Claude Code sessions only, through
    the --settings file up writes. ~/.claude/settings.json is not touched. A Claude Code
    window runs with HOME set to a scratch folder that links every entry of your home
    except .podium, so it stays signed in and a reporter config file there cannot send it
    to your own server; down deletes the links before the folder. An OpenCode
    window runs with HOME set to its scratch folder, so nothing reaches your ~/.podium
    or ~/.config/opencode. A provider that needs a sign-in is not carried over: use a
    free or local model.
  - The token and the secret are read from their files inside each window and passed
    in the environment, never on a command line that ps shows.
  - Needs node, curl, git and tmux on PATH, claude when a window is Claude Code and
    opencode (2.x) when one is OpenCode.
USAGE
}

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# A plugin loads only from a self-contained folder (an import that leaves it is refused), so run the built one (#927).
MOD="$ROOT/dist/claudecode"
OC_DIST="$ROOT/dist/opencode"
MARKER=".podium-peers-e2e"
TOOLS="mcp__podium-reporter__podium_peers mcp__podium-reporter__podium_send mcp__podium-reporter__podium_request_access"

CMD=""
TMP_BASE="${TMPDIR:-/tmp}"
DIR="${TMP_BASE%/}/podium-peers-e2e"
PORT=4380
SESSIONS=4
MODEL=haiku
HARNESS=claudecode
OC_MODEL=""
OC_CONFIG=""
ACTIVITY_OUTPUT=0
SESSION_RECORDING=0
FILE_DIFF=0
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
    --harness) need_value "$@"; HARNESS="$2"; shift ;;
    --opencode-model) need_value "$@"; OC_MODEL="$2"; shift ;;
    --opencode-config) need_value "$@"; OC_CONFIG="$2"; shift ;;
    --activity-output) ACTIVITY_OUTPUT=1 ;;
    --session-recording) SESSION_RECORDING=1 ;;
    --file-diff) FILE_DIFF=1 ;;
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
# tmux -L default is the socket of the user's own tmux server, and down kills the server on the socket.
[[ "$TMUX_NAME" != default ]] || die "--tmux default is the name of your own tmux server's socket; pick another name"
[[ "$MODEL" =~ ^[A-Za-z0-9._:-]+$ ]] || die "--model takes letters, digits, '.', ':', - and _ only"
# One entry per window, used in turn: --harness claudecode,opencode alternates them.
IFS=, read -r -a HARNESSES <<<"$HARNESS"
(( ${#HARNESSES[@]} > 0 )) || die "--harness needs claudecode or opencode"
USES_CLAUDE=0; USES_OPENCODE=0
for h in "${HARNESSES[@]}"; do
  case "$h" in
    claudecode) USES_CLAUDE=1 ;;
    opencode) USES_OPENCODE=1 ;;
    *) die "--harness takes claudecode or opencode, or a comma list of them, not '$h'" ;;
  esac
done
if (( USES_OPENCODE )) && [[ "$CMD" == "up" ]]; then
  [[ -n "$OC_MODEL" ]] || die "--opencode-model PROVIDER/MODEL is required when a window is OpenCode (a free one: opencode/<name>-free, see \`opencode models\`)"
  [[ "$OC_MODEL" =~ ^[A-Za-z0-9._:@/-]+$ ]] || die "--opencode-model takes letters, digits, '.', ':', '@', '/', - and _ only"
fi
[[ -z "$OC_CONFIG" || -f "$OC_CONFIG" ]] || die "--opencode-config $OC_CONFIG is not a file"
[[ -z "$OC_CONFIG" || "$OC_CONFIG" = /* ]] || OC_CONFIG="$PWD/$OC_CONFIG"
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

# Every tmux call, on a private socket named like the session, so the windows never join the environment of another tmux
# server, and with no PODIUM_* variable of this shell reaching them: each window sets its own.
tm() {
  local u=() v
  while IFS= read -r v; do u+=(-u "$v"); done < <(compgen -e | grep -E '^PODIUM_' || true)
  env ${u[@]+"${u[@]}"} tmux -L "$TMUX_NAME" "$@"
}

# The harness of window number $1.
harness_of() { echo "${HARNESSES[$((($1 - 1) % ${#HARNESSES[@]}))]}"; }
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
    local tools="node curl git tmux"
    (( USES_CLAUDE )) && tools="$tools claude"
    (( USES_OPENCODE )) && tools="$tools opencode"
    for tool in $tools; do
      command -v "$tool" >/dev/null || die "$tool is not on PATH"
    done
    if server_pid >/dev/null; then die "a server from an earlier up is still running; run down first (--dir $DIR)"; fi
    if tm has-session -t "$TMUX_NAME" 2>/dev/null; then die "the tmux session $TMUX_NAME already exists; run down, or pick another with --tmux"; fi
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

  local seed_flags="" opts_json="" oc_env=""
  (( ACTIVITY_OUTPUT )) && { seed_flags="$seed_flags --activity-output"; opts_json="$opts_json, \"activityOutput\": true"; oc_env="$oc_env PODIUM_ACTIVITY_OUTPUT=true"; }
  (( SESSION_RECORDING )) && { seed_flags="$seed_flags --session-recording"; opts_json="$opts_json, \"sessionRecording\": true"; oc_env="$oc_env PODIUM_SESSION_RECORDING=true"; }
  (( FILE_DIFF )) && { seed_flags="$seed_flags --file-diff"; opts_json="$opts_json, \"fileDiff\": true"; oc_env="$oc_env PODIUM_FILE_DIFF=true"; }
  step "seed the person $PERSON with podium-peers-seed.mjs --talk$seed_flags, output (name and token) in $SEED_FILE (mode 0600)"
  if (( ! DRY )); then
    # shellcheck disable=SC2086 # the flags are fixed words
    PODIUM_TOKEN="$(cat "$SECRET_FILE")" node "$ROOT/scripts/podium-peers-seed.mjs" --url "$URL" --name "$PERSON" --talk $seed_flags >"$SEED_FILE"
  fi

  if (( USES_CLAUDE )); then step "write $SETTINGS: the installed podium-reporter off, this checkout's copy reporting to $URL with peers, activityFeed and respond on$opts_json"; fi
  if (( ! DRY )) && (( USES_CLAUDE )); then
    cat >"$SETTINGS" <<JSON
{
  "enabledPlugins": { "podium-reporter@eengelking-marketplace": false },
  "pluginConfigs": {
    "podium-reporter": {
      "options": { "serverUrl": "$URL", "peers": true, "activityFeed": true, "respond": "everything", "heartbeatMs": 3000$opts_json }
    }
  }
}
JSON
  fi

  # Built once per harness, then used by every window of it.
  local h
  for h in claudecode opencode; do
    if [[ "$h" == claudecode ]] && (( ! USES_CLAUDE )); then continue; fi
    if [[ "$h" == opencode ]] && (( ! USES_OPENCODE )); then continue; fi
    step "build the $h plugin from this checkout (scripts/plugin-build.mjs $h --dev-stamp)"
    (( DRY )) || node "$ROOT/scripts/plugin-build.mjs" "$h" --dev-stamp >/dev/null || die "plugin build failed"
  done

  step "start the tmux session $TMUX_NAME on its own socket (tmux -L $TMUX_NAME)"
  (( DRY )) || tm new-session -d -s "$TMUX_NAME" -n boot -x 200 -y 50
  local i name dir names=""
  for i in $(seq 1 "$SESSIONS"); do
    name="$(session_name "$i")"
    dir="$DIR/proj-$name"
    names="$names $name"
    if [[ "$(harness_of "$i")" == opencode ]]; then
      start_opencode "$name" "$dir" "$oc_env"
    else
      start_claude "$name" "$dir"
    fi
  done
  (( DRY )) || tm kill-window -t "$TMUX_NAME:boot"

  local who="$PERSON"
  (( DRY )) || who="$(sed -n 's/^name=//p' "$SEED_FILE")"
  say ""
  say "Podium:    $URL/#/"
  say "Person:    $who (sign in from the top bar with this name and the token)"
  say "Token:     the token= line in $SEED_FILE"
  say "Secret:    $SECRET_FILE (Admin, with the name Admin)"
  say "Sessions:  tmux -L $TMUX_NAME attach -t $TMUX_NAME (windows:$names); accept Claude Code's trust prompt in each of its windows"
  say "Next:      on My reporters, let this machine send to itself (the Grid's diagonal), or turn on Trust my own reporters"
  say "Stop:      scripts/podium-peers-e2e.sh down --dir '$DIR' --tmux $TMUX_NAME"
  UP_DB=""
}

# Claude Code needs the home folder to stay signed in, and a reporter config file in ~/.podium would make the session report to
# the server that file names, whatever the settings say. So a Claude Code window gets a scratch home that links every entry of
# the real home except .podium. down deletes the links first, then the folder.
CLAUDE_HOME="$DIR/home-claude"
make_claude_home() {
  mkdir -p "$CLAUDE_HOME"
  local real="${HOME:?HOME is not set}" f
  while IFS= read -r f; do
    ln -s "$f" "$CLAUDE_HOME/$(basename "$f")"
  done < <(find "$real" -mindepth 1 -maxdepth 1 ! -name .podium)
}

# A window of Claude Code ($1 name, $2 folder), loading this checkout's plugin.
start_claude() {
  local name="$1" dir="$2"
  step "start Claude Code ($MODEL) as $name in $dir, with --plugin-dir $MOD and HOME $CLAUDE_HOME (links to your home, except .podium)"
  (( DRY )) && return 0
  [[ -d "$CLAUDE_HOME" ]] || make_claude_home
  mkdir -p "$dir"
  [[ -d "$dir/.git" ]] || git -C "$dir" init -q
  tm new-window -t "$TMUX_NAME" -n "$name" -c "$dir"
  # Typed into the window's shell: the name and token are read from the file there, so neither is on this
  # script's command line, nor on tmux's.
  tm send-keys -t "$TMUX_NAME:$name" "export HOME='$CLAUDE_HOME' PODIUM_USER=\"\$(sed -n 's/^name=//p' '$SEED_FILE')\" PODIUM_TOKEN=\"\$(sed -n 's/^token=//p' '$SEED_FILE')\"; claude --plugin-dir '$MOD' --settings '$SETTINGS' --model '$MODEL' -n '$name' --allowedTools $TOOLS" C-m
}

# A window of OpenCode ($1 name, $2 folder, $3 the consent variables to set). It runs with its own scratch home, holding the
# plugin built from this checkout, and with --standalone, so it never talks to a background service started with another
# environment. The reporter takes the server, the token and every consent option only from PODIUM_* variables (never from
# opencode.json), so they go in an env file the window sources; the token is read from the seed file there, never typed.
start_opencode() {
  local name="$1" dir="$2" oc_env="$3"
  local home="$DIR/home-$name" envfile="$DIR/oc-env-$name.sh"
  step "start OpenCode ($OC_MODEL) as $name in $dir, home $home with the plugin copied in, env file $envfile, opencode --standalone"
  (( DRY )) && return 0
  mkdir -p "$dir" "$home/.config/opencode/plugins"
  [[ -d "$dir/.git" ]] || git -C "$dir" init -q
  rm -rf "$home/.config/opencode/plugins/podium"
  cp -R "$OC_DIST" "$home/.config/opencode/plugins/podium"
  # The model and `ask` for a shell or edit call (so a tool call produces a permission ask) win over the caller's file.
  node -e '
    const fs = require("node:fs");
    const [file, out, model] = process.argv.slice(1);
    const c = file ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    c.$schema = "https://opencode.ai/config.json";
    c.model = model;
    c.permission = { ...(typeof c.permission === "object" && c.permission ? c.permission : {}), bash: "ask", edit: "ask" };
    fs.writeFileSync(out, JSON.stringify(c, null, 2) + "\n");
  ' "$OC_CONFIG" "$dir/opencode.json" "$OC_MODEL"
  {
    printf 'export HOME=%q\n' "$home"
    printf 'export PODIUM_SERVER=%q\n' "$URL"
    printf "export PODIUM_USER=\"\$(sed -n 's/^name=//p' '%s')\" PODIUM_TOKEN=\"\$(sed -n 's/^token=//p' '%s')\"\n" "$SEED_FILE" "$SEED_FILE"
    printf 'export PODIUM_RESPOND=everything PODIUM_ACTIVITY_FEED=true PODIUM_PEERS=true%s\n' "$oc_env"
  } >"$envfile"
  tm new-window -t "$TMUX_NAME" -n "$name" -c "$dir"
  tm send-keys -t "$TMUX_NAME:$name" ". '$envfile'; opencode --standalone" C-m
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
    step "kill the tmux server on socket $TMUX_NAME, if it exists"
  elif tm has-session -t "$TMUX_NAME" 2>/dev/null; then
    step "kill the tmux server on socket $TMUX_NAME"
    # The server, not only the session: nothing is left running on the private socket.
    tm kill-server
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
    step "remove the links in $DIR/home-claude, then $DIR, if up made it"
  elif [[ -f "$DIR/$MARKER" ]]; then
    step "remove $DIR"
    # The links of the Claude Code scratch home first: rm does not follow a link, but nothing of the real home may be in reach.
    [[ ! -d "$DIR/home-claude" ]] || find "$DIR/home-claude" -maxdepth 1 -type l -delete
    rm -rf "$DIR"
  elif [[ -e "$DIR" ]]; then
    say "not removing $DIR: up did not make it"
  fi
}

"$CMD"
