#!/usr/bin/env bash
# The container half of `npm run test:db` (#1294, #891, #823): takes the machine's database lock, starts a throwaway container for each
# database server kind it is given, all at once, waits until each answers, sets each one's test server variable, runs a command, then
# removes every container however the run ends. scripts/test-db.mjs is the front door; it chooses the kinds and builds the command.
# The databases, images and variables come from scripts/db-adapters.mjs, so a new adapter needs no edit here.
set -uo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/db-servers.sh [--image KIND=REF ...] [--kinds "KIND [KIND...]"] [--cwd DIR] -- COMMAND [ARGS...]

Takes the machine's database lock (scripts/db-lock.sh), starts one throwaway container per kind in --kinds that has a test server
(`node scripts/db-adapters.mjs kinds --server`; default: all of them), with a placeholder password on a free 127.0.0.1 port, waits up to
two minutes for each to answer (and prints its last log lines when one does not), sets its test server variable (PODIUM_TEST_PG,
PODIUM_TEST_MARIADB, ...), runs COMMAND in DIR (default: server/) and removes every container it started, however the run ends, and
checks that none is left. Containers carry the label dev.podium.test-db.

Options:
  --image KIND=REF   Use this image for one kind (for example --image mariadb=docker.io/library/mariadb:11.8). Untested.
  --kinds LIST       The kinds that get a server, space or comma separated. A kind with no test server (sqlite) needs none.
  --cwd DIR          Where COMMAND runs, relative to the repository root.
  -h, --help         Show this help.

Environment:
  CONTAINER_ENGINE        podman (default) or docker.
  PODIUM_DB_LOCK=off      Skip the lock. PODIUM_DB_LOCK_TIMEOUT_S=N gives up (exit 3) after N seconds of waiting. CI skips the lock.
Exit code: COMMAND's, or 2 when a container could not be started or did not answer.
USAGE
}

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TABLE="$ROOT/scripts/db-adapters.mjs"
IMAGES=()
kinds_arg="" ; kinds_given=0
cwd="server"
while (($#)); do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --image) [[ "${2:-}" == *=* ]] || { echo "test-db: --image needs KIND=REF" >&2; exit 2; }; IMAGES+=("$2"); shift 2 ;;
    --kinds) [[ $# -ge 2 ]] || { echo "test-db: --kinds needs a list" >&2; exit 2; }; kinds_arg="$2"; kinds_given=1; shift 2 ;;
    --cwd) [[ $# -ge 2 ]] || { echo "test-db: --cwd needs a folder" >&2; exit 2; }; cwd="$2"; shift 2 ;;
    --) shift; break ;;
    *) echo "test-db: unknown option $1 (see --help)" >&2; exit 2 ;;
  esac
done
(($#)) || { echo "test-db: no command to run after -- (see --help)" >&2; exit 2; }

engine="${CONTAINER_ENGINE:-podman}"
servers="$(node "$TABLE" kinds --server)" || exit 2
want=" $(printf '%s' "$kinds_arg" | tr ',' ' ') "
all_wanted=0 ; ((!kinds_given)) && all_wanted=1 # --kinds "" (only sqlite chosen) starts no server
start=0
for k in $servers; do if ((all_wanted)) || [[ "$want" == *" $k "* ]]; then start=1; fi; done
# A run that starts no container (sqlite alone) needs no engine.
((start)) && { "$engine" info >/dev/null 2>&1 || { echo "test-db: $engine is not usable ($engine info fails). Is it running? On a Mac: podman machine start" >&2; exit 2; }; }

# One heavy database job at a time on this machine (#1284): wait here for the lock, before any container starts.
# shellcheck source=scripts/db-lock.sh
source "$ROOT/scripts/db-lock.sh"
db_lock_acquire "npm run test:db"

NAMES=() ; KINDS=() ; PORTS=() ; RAN=()
cleanup() {
  local n
  db_lock_release
  for n in ${NAMES[@]+"${NAMES[@]}"}; do "$engine" rm -f "$n" >/dev/null 2>&1; done
  for n in ${NAMES[@]+"${NAMES[@]}"}; do "$engine" inspect "$n" >/dev/null 2>&1 && echo "test-db: container $n is still there" >&2; done
  return 0
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Start every container first, so the databases initialize side by side.
for k in $servers; do
  if ((!all_wanted)) && [[ "$want" != *" $k "* ]]; then continue; fi
  img=() ; for i in ${IMAGES[@]+"${IMAGES[@]}"}; do [[ "${i%%=*}" == "$k" ]] && img=(--image "${i#*=}"); done
  shell="$(DB_PASSWORD=change-me node "$TABLE" shell "$k" test ${img[@]+"${img[@]}"})" || exit 2
  eval "$shell"
  name="podium-test-$k-$$"
  envs=() ; for e in "${DB_ENV[@]}"; do envs+=(-e "$e"); done
  echo "test-db: starting $DB_LABEL ($DB_IMAGE)"
  "$engine" run -d --name "$name" --label dev.podium.test-db="$$" "${envs[@]}" -p "127.0.0.1::$DB_PORT" "$DB_IMAGE" ${DB_ARGS[@]+"${DB_ARGS[@]}"} >/dev/null \
    || { echo "test-db: could not start $DB_LABEL from $DB_IMAGE" >&2; exit 2; }
  NAMES+=("$name") ; KINDS+=("$k") ; PORTS+=("$DB_PORT")
done

# Then wait for each, up to two minutes each, and point its variable at it.
for idx in ${NAMES[@]+"${!NAMES[@]}"}; do
  name="${NAMES[$idx]}" ; k="${KINDS[$idx]}"
  port="$("$engine" port "$name" "${PORTS[$idx]}/tcp" | head -n1 | sed 's/.*://')"
  [[ "$port" =~ ^[0-9]+$ ]] || { echo "test-db: could not read the port of $name" >&2; exit 2; }
  eval "$(DB_PASSWORD=change-me node "$TABLE" shell "$k" test --set host=127.0.0.1 --set port="$port")"
  ok=0
  for _ in $(seq 1 240); do
    if "$engine" exec "$name" "${DB_READY[@]}" >/dev/null 2>&1; then ok=1; break; fi
    [[ "$("$engine" inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" == true ]] || break
    sleep 0.5
  done
  if ((!ok)); then
    echo "test-db: $DB_LABEL did not answer; its last log lines:" >&2
    "$engine" logs --tail 20 "$name" >&2 2>&1
    exit 2
  fi
  export "$DB_TEST_VAR=$DB_URL"
  RAN+=("$k")
  echo "test-db: $DB_LABEL test server: 127.0.0.1:$port ($DB_TEST_VAR)"
done
echo "test-db: servers started: ${RAN[*]:-none}"

cd "$ROOT/$cwd" || exit 2
"$@"
exit $?
