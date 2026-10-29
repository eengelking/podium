#!/usr/bin/env bash
# Runs the end-to-end suite (e2e/, #782, DECISIONS 48) in containers: Podium's own image as the server and the pinned
# cypress/included image as the runner, on one private network. Nothing is installed on the host and no port is opened on it.
# Podman or Docker; the same script runs on a Mac with Podman and on ubuntu-latest with Docker.
set -uo pipefail

# Pinned by version and digest (an index covering amd64 and arm64). Change both together, on purpose, and update DECISIONS 48.
CYPRESS_IMAGE="${E2E_CYPRESS_IMAGE:-docker.io/cypress/included:16.2.0@sha256:c196ed896aec24c7ea8fc1d4185b210493e311339b6c09d0153f9b8dfc6a6058}"
SERVER_IMAGE="${E2E_SERVER_IMAGE:-localhost/podium-e2e:latest}"

usage() {
  cat <<'USAGE'
Usage: scripts/e2e-up.sh [run] [options] [-- <cypress run arguments>]
       scripts/e2e-up.sh down

Builds Podium's image from the Containerfile, starts it as the server on a private container network with a fresh database,
waits until /api/fleet/health answers and its serverVersion equals package.json's, then runs the Cypress suite from e2e/ in the
pinned cypress/included container. The specs call back into this script (through a mounted folder, not a port) to restart,
pause and resume the server and to reseed it. At the end, always, every container, network and volume it made is removed.

Commands:
  run     (default) build, start, test, tear down. The exit code is Cypress's (0 = every spec passed).
  down    Remove containers, networks and volumes left behind by an interrupted run of this script (matched by label).

Options:
  --no-build        Reuse the image already built (localhost/podium-e2e:latest). Fails if it is not there.
  --engine NAME     podman or docker (default: podman if installed, else docker; or $E2E_ENGINE).
  --out DIR         Where failure screenshots and the scrubbed server log go (default e2e/results, which git ignores).
  -h, --help        Show this help.
Anything after -- goes to `cypress run`, for example:
  scripts/e2e-up.sh -- --spec "cypress/e2e/wall/**"

Environment:
  E2E_SECRET        The admin secret (PODIUM_TOKEN) of the throwaway server. Default: a new random one for each run, kept in a
                    mode-600 file in a temp folder, passed to the containers through env files, and printed nowhere. CI sets it
                    and masks it.
  E2E_KEEP=1        Keep the temp folder and the server container's data volume for looking at (tear down the rest).
  E2E_CYPRESS_IMAGE Override the pinned Cypress image (a different version needs a new digest and a DECISIONS 48 note).

Cypress itself is never installed: the image carries it. axe-core is mounted read-only from node_modules (a root dev dependency).
Exit code: 0 passed, 1 a spec or a check failed, 2 a setup error.
USAGE
}

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CMD="run"
BUILD=1
ENGINE="${E2E_ENGINE:-}"
OUT="${E2E_OUT:-$ROOT/e2e/results}"
REST=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    run|down) CMD="$1"; shift ;;
    --no-build) BUILD=0; shift ;;
    --engine) ENGINE="${2:?--engine needs podman or docker}"; shift 2 ;;
    --out) OUT="${2:?--out needs a folder}"; shift 2 ;;
    --) shift; REST=("$@"); break ;;
    *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
done

if [[ -z "$ENGINE" ]]; then
  if command -v podman >/dev/null 2>&1; then ENGINE=podman; elif command -v docker >/dev/null 2>&1; then ENGINE=docker; fi
fi
[[ "$ENGINE" == podman || "$ENGINE" == docker ]] || { echo "need podman or docker on PATH (or --engine)" >&2; exit 2; }
E="$ENGINE"

LABEL="dev.podium.e2e"
say() { echo "e2e: $*"; }
fail() { echo "e2e: FAIL  $*" >&2; }

# Removes everything carrying our label. Used by teardown (this run's id) and by `down` (any run).
remove_labelled() {
  local filter="label=$LABEL${1:+=$1}" ids
  ids="$($E ps -aq --filter "$filter" 2>/dev/null)"
  # shellcheck disable=SC2086
  [[ -n "$ids" ]] && $E rm -f $ids >/dev/null 2>&1
  ids="$($E volume ls -q --filter "$filter" 2>/dev/null)"
  # shellcheck disable=SC2086
  [[ -n "$ids" ]] && $E volume rm -f $ids >/dev/null 2>&1
  ids="$($E network ls -q --filter "$filter" 2>/dev/null)"
  # shellcheck disable=SC2086
  [[ -n "$ids" ]] && $E network rm -f $ids >/dev/null 2>&1
  return 0
}
leftovers() {
  { $E ps -aq --filter "label=$LABEL${1:+=$1}"; $E volume ls -q --filter "label=$LABEL${1:+=$1}"; $E network ls -q --filter "label=$LABEL${1:+=$1}"; } 2>/dev/null
}

if [[ "$CMD" == down ]]; then
  remove_labelled ""
  if [[ -n "$(leftovers "")" ]]; then fail "something with label $LABEL is still there"; exit 1; fi
  say "nothing left"
  exit 0
fi

$E info >/dev/null 2>&1 || { fail "$E is not usable ($E info fails). Is it running? On a Mac: podman machine start"; exit 2; }
[[ -f "$ROOT/node_modules/axe-core/axe.min.js" ]] || { fail "node_modules/axe-core is missing: run npm ci --ignore-scripts at the repo root (axe-core is a frontend dev dependency)"; exit 2; }

RUN="$(date +%s)-$$"
NET="podium-e2e-$RUN"
SRV="podium-e2e-$RUN-srv"
VOL="podium-e2e-$RUN-data"
CYC="podium-e2e-$RUN-cy"
PORT=4317
URL="http://$SRV:$PORT"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/podium-e2e.XXXXXX")"
CTL="$WORK/ctl"
mkdir -p "$CTL" "$OUT"
OUT="$(cd "$OUT" && pwd)"   # absolute: a relative --out would be mounted as a named volume
chmod 700 "$WORK"
chmod 777 "$CTL" "$OUT"
SECRET="${E2E_SECRET:-$(LC_ALL=C tr -dc 'a-f0-9' </dev/urandom | head -c 40)}"
VERSION="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$ROOT/package.json" | head -1)"
CTL_PID=""
# The secret as a sed pattern, so a custom E2E_SECRET with a / or & in it still scrubs.
SECRET_RE="$(printf '%s' "$SECRET" | sed 's/[][\.*^$/&]/\\&/g')"
EXTRA_ENV=()

( umask 077
  printf 'PORT=%s\nHOST=0.0.0.0\nPODIUM_TOKEN=%s\nPODIUM_ALLOWED_HOSTS=%s\nPODIUM_LOG=info\nPODIUM_FAILURE_LIMIT=100000\n' "$PORT" "$SECRET" "$SRV" >"$WORK/server.env"
  # A seeded session stays on the wall for the whole run: long stale, linger and drop times, so no spec depends on a clock.
  printf 'STALE_AFTER_MS=7200000\nHOOK_STALE_AFTER_MS=7200000\nDROP_AFTER_MS=14400000\nLINGER_MS=7200000\nDETACHED_HIDE_AFTER_MS=7200000\n' >>"$WORK/server.env"
  printf 'PODIUM_E2E_SECRET=%s\n' "$SECRET" >"$WORK/seed.env"
  printf 'CYPRESS_ADMIN_SECRET=%s\nCYPRESS_E2E_SERVER=%s\nCYPRESS_baseUrl=%s\nCI=1\nNO_COLOR=1\n' "$SECRET" "$SRV" "$URL" >"$WORK/cypress.env"
)
# CI masks the secret by itself; this keeps it out of the log when the runner sets it.
if [[ -n "${GITHUB_ACTIONS:-}" ]]; then echo "::add-mask::$SECRET"; fi

teardown() {
  local code=$?
  trap - EXIT INT TERM
  [[ -n "$CTL_PID" ]] && { touch "$CTL/stop"; wait "$CTL_PID" 2>/dev/null; }
  # The server log, scrubbed of the secret, for the CI artifact. The repo is public and artifacts are world-readable.
  $E logs "$SRV" 2>&1 | sed "s/$SECRET_RE/[secret]/g" >"$OUT/server.log" 2>/dev/null
  chmod 666 "$OUT/server.log" 2>/dev/null
  if [[ "${E2E_KEEP:-0}" == 1 ]]; then
    $E rm -f "$CYC" >/dev/null 2>&1
    say "kept $WORK and volume $VOL (container $SRV is stopped); remove them with: scripts/e2e-up.sh down"
    $E stop "$SRV" >/dev/null 2>&1
  else
    remove_labelled "$RUN"
    rm -rf "$WORK"
    if [[ -n "$(leftovers "$RUN")" ]]; then fail "containers, volumes or networks of run $RUN are still there"; code=1; else say "removed every container, network and volume of run $RUN"; fi
  fi
  exit "$code"
}
trap teardown EXIT
trap 'exit 130' INT TERM

# ---- the server -------------------------------------------------------------------------------------------------------

server_wait() {
  local got=""
  for _ in $(seq 1 120); do
    got="$($E exec "$SRV" node -e "fetch('http://127.0.0.1:$PORT/api/fleet/health').then(r=>r.json()).then(j=>{process.stdout.write(String(j.serverVersion));process.exit(0)}).catch(()=>process.exit(1))" 2>/dev/null)" && [[ -n "$got" ]] && break
    got=""
    [[ "$($E inspect -f '{{.State.Running}}' "$SRV" 2>/dev/null)" == true ]] || break
    sleep 0.5
  done
  if [[ -z "$got" ]]; then fail "the server did not answer /api/fleet/health"; $E logs --tail 20 "$SRV" 2>&1 | sed "s/$SECRET_RE/[secret]/g" >&2; return 1; fi
  if [[ "$got" != "$VERSION" ]]; then fail "serverVersion is $got but package.json says $VERSION: the image is stale (rebuild without --no-build)"; return 1; fi
}

# A fresh database in a fresh volume, as one container.
server_fresh() {
  $E rm -f "$SRV" >/dev/null 2>&1
  $E volume rm -f "$VOL" >/dev/null 2>&1
  $E volume create --label "$LABEL=$RUN" "$VOL" >/dev/null || return 1
  local -a envs=(--env-file "$WORK/server.env")
  local e
  for e in ${EXTRA_ENV[@]+"${EXTRA_ENV[@]}"}; do envs+=(-e "$e"); done
  $E run -d --name "$SRV" --label "$LABEL=$RUN" --network "$NET" --ip "$SRV_IP" --network-alias "$SRV" "${envs[@]}" -v "$VOL:/data" "$SERVER_IMAGE" >/dev/null || return 1
  server_wait
}

server_seed() {
  # shellcheck disable=SC2086
  $E run --rm --label "$LABEL=$RUN" --network "$NET" --env-file "$WORK/seed.env" -v "$ROOT/scripts:/repo/scripts:ro" -v "$ROOT/package.json:/repo/package.json:ro" -v "$CTL:/ctl" \
    --entrypoint node "$SERVER_IMAGE" /repo/scripts/e2e-seed.mjs --url "$URL" --out /ctl/seed.json ${SEED_ARGS:-} >"$WORK/seed.log" 2>&1 \
    || { fail "the seed failed"; sed "s/$SECRET_RE/[secret]/g" "$WORK/seed.log" >&2; return 1; }
}

# ---- the control channel -----------------------------------------------------------------------------------------------
# A spec asks for a server restart, pause or resume by writing a request file into the mounted folder; this loop does it and
# writes the answer. No port, no engine socket in the Cypress container. Request file: first line the command (restart, pause or
# resume), then optional lines: env=NAME=VALUE, seed=<seed arguments>, noseed=1.
handle() {
  local cmd="" line noseed=0
  EXTRA_ENV=()
  SEED_ARGS=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      env=*) EXTRA_ENV+=("${line#env=}") ;;
      seed=*) SEED_ARGS="${line#seed=}" ;;
      noseed=1) noseed=1 ;;
      "") ;;
      *) [[ -z "$cmd" ]] && cmd="$line" ;;
    esac
  done <"$CTL/cur"
  case "$cmd" in
    restart) server_fresh && { [[ $noseed == 1 ]] || server_seed; } ;;
    pause) $E stop -t 2 "$SRV" >/dev/null 2>&1 ;;
    resume) $E start "$SRV" >/dev/null 2>&1 && server_wait ;;
    *) fail "unknown control command: $cmd"; return 1 ;;
  esac
}

controller() {
  while [[ ! -f "$CTL/stop" ]]; do
    if [[ -f "$CTL/req" ]]; then
      mv "$CTL/req" "$CTL/cur"
      rm -f "$CTL/ack"
      if handle; then echo ok >"$CTL/ack.tmp"; else echo fail >"$CTL/ack.tmp"; fi
      mv "$CTL/ack.tmp" "$CTL/ack"
    fi
    sleep 0.2
  done
}

# ---- run --------------------------------------------------------------------------------------------------------------

if [[ "$BUILD" == 1 ]]; then
  say "building $SERVER_IMAGE from the Containerfile ($E build, cached layers)"
  $E build -q --build-arg PODIUM_BUILD= -t "$SERVER_IMAGE" -f "$ROOT/Containerfile" "$ROOT" >/dev/null || { fail "image build failed"; exit 2; }
fi
$E image inspect "$SERVER_IMAGE" >/dev/null 2>&1 || { fail "$SERVER_IMAGE is not built; run without --no-build"; exit 2; }
if ! $E image inspect "$CYPRESS_IMAGE" >/dev/null 2>&1; then
  say "pulling $CYPRESS_IMAGE (about 2.5 GB the first time)"
  $E pull -q "$CYPRESS_IMAGE" >/dev/null || { fail "could not pull the Cypress image"; exit 2; }
fi

# The server container is recreated by a restart, and the browser (and Cypress's proxy) cache a name's address, so the server keeps a
# fixed address on a network of its own. A /24 is picked at random from 10.200.0.0 to 10.249.255.0 and retried if it is taken.
SRV_IP=""
for _ in 1 2 3 4 5 6 7 8; do
  SUBNET="10.$((200 + RANDOM % 50)).$((RANDOM % 256))"
  if $E network create --label "$LABEL=$RUN" --subnet "$SUBNET.0/24" "$NET" >/dev/null 2>&1; then SRV_IP="$SUBNET.10"; break; fi
done
[[ -n "$SRV_IP" ]] || { fail "could not create the network"; exit 2; }
say "run $RUN: server $SRV, network $NET"
server_fresh || exit 1
server_seed || exit 1
say "server is $VERSION and seeded"

controller &
CTL_PID=$!

say "running Cypress $CYPRESS_IMAGE"
$E run --rm --name "$CYC" --label "$LABEL=$RUN" --network "$NET" --shm-size=1g --env-file "$WORK/cypress.env" \
  -v "$ROOT/e2e:/e2e:ro" -v "$ROOT/scripts:/repo/scripts:ro" -v "$ROOT/package.json:/repo/package.json:ro" \
  -v "$ROOT/node_modules/axe-core/axe.min.js:/repo/axe.min.js:ro" -v "$CTL:/ctl" -v "$OUT:/out" \
  -w /e2e "$CYPRESS_IMAGE" --project . --config-file cypress.config.cjs --browser chrome ${REST[@]+"${REST[@]}"}
code=$?
[[ $code -eq 0 ]] && say "all specs passed" || fail "Cypress exited with $code (screenshots, if any, are in $OUT)"
exit $code
