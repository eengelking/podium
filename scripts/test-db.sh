#!/usr/bin/env bash
# Runs the server suite on every storage adapter (#891, #823): a throwaway container for each database that needs a server, started
# together, each one's test server variable set, then `npx vitest run` in server/, then every container removed. SQLite needs none.
# The databases, images and variables come from scripts/db-adapters.mjs, so a new adapter needs no edit here.
set -uo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/test-db.sh [--floor] [--image KIND=REF ...] [--] [vitest args...]
       e.g. scripts/test-db.sh src/storage/adapters.test.ts

Starts one throwaway container per database that has a test server (PostgreSQL, MariaDB, ...: `node scripts/db-adapters.mjs kinds
--server`), all at once, with a placeholder password on a free local port, waits until each answers, sets its test server variable
(PODIUM_TEST_PG, PODIUM_TEST_MARIADB, ...), runs `npx vitest run [vitest args]` in server/, and removes every container it started,
however the run ends. Each test file makes its own database on each server and drops it after.

Options:
  --floor            Use each database's oldest supported version where it names one (MariaDB 10.5), not the current one.
  --image KIND=REF   Use this image for one kind (for example --image mariadb=docker.io/library/mariadb:11.8).
  -h, --help         Show this help.

Environment:
  PODIUM_TEST_ONLY   Kinds to run, comma separated (for example sqlite,postgres). The others get no container, and the run prints
                     that they were NOT RUN: a limited run is not a pass for a pull request. Set it only when asked to leave one out.
  CONTAINER_ENGINE   podman (default) or docker.
Exit code: vitest's, or 2 when a container could not be started or did not answer.
USAGE
}

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TABLE="$ROOT/scripts/db-adapters.mjs"
FLOOR=() ; IMAGES=()
while (($#)); do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --floor) FLOOR=(--floor); shift ;;
    --image) [[ "${2:-}" == *=* ]] || { echo "test-db: --image needs KIND=REF" >&2; exit 2; }; IMAGES+=("$2"); shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done

engine="${CONTAINER_ENGINE:-podman}"
"$engine" info >/dev/null 2>&1 || { echo "test-db: $engine is not usable ($engine info fails). Is it running? On a Mac: podman machine start" >&2; exit 2; }

all="$(node "$TABLE" kinds)" || exit 2
servers="$(node "$TABLE" kinds --server)" || exit 2
only=" $(printf '%s' "${PODIUM_TEST_ONLY:-}" | tr ',' ' ') "
limited=0 ; [[ -n "${PODIUM_TEST_ONLY//[ ,]/}" ]] && limited=1
for k in $only; do
  [[ " $all " == *" $k "* ]] || { echo "test-db: PODIUM_TEST_ONLY names \"$k\", which is not a storage kind (kinds: $all)" >&2; exit 2; }
done
LEFT=() ; if ((limited)); then for k in $all; do [[ "$only" == *" $k "* ]] || LEFT+=("$k"); done; fi

NAMES=() ; KINDS=() ; PORTS=() ; RAN=()
cleanup() {
  local n
  for n in ${NAMES[@]+"${NAMES[@]}"}; do "$engine" rm -f "$n" >/dev/null 2>&1; done
  for n in ${NAMES[@]+"${NAMES[@]}"}; do "$engine" inspect "$n" >/dev/null 2>&1 && echo "test-db: container $n is still there" >&2; done
  return 0
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Start every container first, so the databases initialize side by side.
for k in $servers; do
  if ((limited)) && [[ "$only" != *" $k "* ]]; then continue; fi
  img=() ; for i in ${IMAGES[@]+"${IMAGES[@]}"}; do [[ "${i%%=*}" == "$k" ]] && img=(--image "${i#*=}"); done
  shell="$(DB_PASSWORD=change-me node "$TABLE" shell "$k" test ${FLOOR[@]+"${FLOOR[@]}"} ${img[@]+"${img[@]}"})" || exit 2
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

cd "$ROOT/server" || exit 2
npx vitest run "$@"
code=$?
if ((limited)); then
  echo "test-db: LIMITED by PODIUM_TEST_ONLY=$PODIUM_TEST_ONLY. Servers started: ${RAN[*]:-none}. NOT RUN: ${LEFT[*]:-none}. A limited run is not a pass for a pull request."
else
  echo "test-db: every adapter had its server: sqlite ${RAN[*]:-}"
fi
exit "$code"
