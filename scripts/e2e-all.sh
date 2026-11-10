#!/usr/bin/env bash
# Runs the whole end-to-end suite once on every registered database, together, as ONE command that ends when the last run ends.
# An agent (podium-e2e-keeper) starts this once in the background and waits for its exit: no Monitor, no timer, no second command.
# Each database is one `E2E_DB=<kind> bash scripts/e2e-up.sh run`, with its own --out folder, log and containers (e2e-up.sh).
# With --shards N (#1130) each database is N such runs side by side, each on a disjoint group of the spec files that
# scripts/e2e-shards.mjs computes from the files on disk. A run's server, database and control folder are its own, so a spec that
# restarts the server or drops the database touches only its own shard.
set -uo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/e2e-all.sh [--out DIR] [--no-build] [--databases "sqlite postgres"] [--shards N] [-- <cypress run arguments>]

Runs the whole suite once per database, all at once, waits for every run, and prints one last line:
  E2E RESULT: PASS|FAIL sqlite=PASS postgres=FAIL(1) ...                     (one shard, the default)
  E2E RESULT: PASS|FAIL sqlite.1=PASS sqlite.2=FAIL(1) ... postgres.3=PASS   (--shards 3)
In FAIL(n), n is the run's exit code (1 a spec failed, 2 it could not run), not a count of failing tests.
Exit code: 0 every run passed, 1 any run failed, 2 a setup error: the image build, the spec groups, or a run that could not start
(for example no memory for another container). A setup error is never a pass.

Options:
  --out DIR          Folder for each run's log (<run>.log) and results (<run>/), where <run> is the database (sqlite) or, with
                     shards, the database and shard (sqlite.2). Default: a new folder under $TMPDIR, outside the repo.
  --no-build         Use the image of this checkout as already built (otherwise it is built once, before the runs; build.log).
                     Either way the images are checked, and a missing Cypress image pulled, once before the runs.
  --databases LIST   Space-separated kinds. Default: the list in .github/workflows/e2e.yml (DATABASES), never a list from memory.
  --shards N         Split each database's run into N runs at once, each with its own server, database, Cypress container and a
                     disjoint group of the spec files (default 1). The groups are computed from the files on disk each time
                     (scripts/e2e-shards.mjs), so every spec runs exactly once per database. They are balanced by the seconds
                     each spec took in a recorded run (e2e/spec-times.json), and each group's spec count and seconds are printed
                     before the runs start.
  -h, --help         Show this help.
Anything after -- goes to `cypress run` in every run. With --shards above 1 it may not hold --spec: the groups set it.

Choosing --shards. Runs at once = shards x databases, and each is a server, a Chrome and, for postgres, a PostgreSQL, about 1.1 GB
of memory as measured. Keep that number at most the engine's CPUs and at most its memory in GB divided by 2 (`podman machine inspect`
shows both; a GitHub runner is 2 CPUs and 7 GB). On a 6-CPU, 16 GB podman machine with two databases, use --shards 3: the whole
suite took about 7m20s against 16m40s with one shard. --shards 4 took about 8 minutes there, no faster, with 8 runs on 6 CPUs, and
one such run had a shard hang for 15 minutes (the cause is not known), so 4 is not the setting to use. Past the CPUs every run
slows down, and a run that cannot get its containers is a setup error. The script warns when shards x databases is more than the
engine's CPUs. The floor is a few specs that wait on real timers (about 5 minutes of the suite), so more shards stop helping.

The groups come out even only if the recorded times are current. After specs are added or changed a lot, refresh them from the
logs of a whole run: node scripts/e2e-shards.mjs --record <out>/sqlite*.log <out>/postgres*.log (a spec with no recorded time is
weighed at the median, and the script names it).

On a run of the whole suite (no --spec after --) each database's specs, added over its shards, must equal the spec files on disk,
or that database fails. The spec and test counts of each database are printed before the last line.

On INT or TERM it stops its runs (each run's own script removes its containers, network and volume when it exits).
USAGE
}

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHARDS_JS="$ROOT/scripts/e2e-shards.mjs"
OUT="" ; BUILD=1 ; DBS="" ; SHARDS=1 ; EXTRA=()
while (($#)); do
  # An option that takes a value and has none would make `shift 2` fail without shifting, and the loop would never end.
  case "$1" in --out|--databases|--shards) (($# >= 2)) || { echo "$1 needs a value (see --help)" >&2; exit 2; } ;; esac
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    --no-build) BUILD=0; shift ;;
    --databases) DBS="${2:-}"; shift 2 ;;
    --shards) SHARDS="${2:-}"; shift 2 ;;
    --) shift; EXTRA=("$@"); break ;;
    *) echo "unknown option $1 (see --help)" >&2; exit 2 ;;
  esac
done

[[ "$SHARDS" =~ ^[1-9][0-9]*$ ]] || { echo "--shards needs a whole number of 1 or more, not \"$SHARDS\"" >&2; exit 2; }
FULL=1
for a in ${EXTRA[@]+"${EXTRA[@]}"}; do
  case "$a" in -s|--spec|--spec=*) FULL=0 ;; esac
done
if ((SHARDS > 1 && FULL == 0)); then echo "--shards $SHARDS sets --spec for each run; leave --spec out of the cypress arguments" >&2; exit 2; fi

if [[ -z "$DBS" ]]; then
  DBS="$(sed -n "s/.*DATABASES: \${{ inputs.databases || '\([^']*\)' }}.*/\1/p" "$ROOT/.github/workflows/e2e.yml" | head -n 1)"
fi
# A setup error after the arguments are read still ends with the result line, so a reader of the last line never sees nothing.
setup_fail() { echo "e2e-all: $1" >&2; echo "E2E RESULT: FAIL setup=FAIL(2)"; exit 2; }
[[ -n "$DBS" ]] || setup_fail "could not read DATABASES from .github/workflows/e2e.yml; pass --databases"
[[ -n "$OUT" ]] || OUT="$(mktemp -d "${TMPDIR:-/tmp}/podium-e2e-all.XXXXXX")"
case "$(cd "$OUT" 2>/dev/null && pwd)" in "$ROOT"|"$ROOT"/*) setup_fail "--out must be outside the repo" ;; esac
mkdir -p "$OUT"

# The spec groups, one comma-separated --spec list per shard, and the number of spec files on disk for the count check.
SPEC_GROUPS=() ; ON_DISK=""
if ((SHARDS > 1)); then
  # --explain prints each group's spec count and seconds on stderr (and a note naming any spec with no recorded time); stdout is the groups.
  groups_out="$(node "$SHARDS_JS" --shards "$SHARDS" --explain)" || setup_fail "the spec groups could not be made (above); nothing was started"
  while IFS= read -r line; do SPEC_GROUPS+=("$line"); done <<<"$groups_out"
  ((${#SPEC_GROUPS[@]} == SHARDS)) || setup_fail "expected $SHARDS spec groups, got ${#SPEC_GROUPS[@]}"
fi
if ((FULL)); then
  ON_DISK="$(node "$SHARDS_JS" --list | wc -l | tr -d ' ')" || setup_fail "could not list the spec files"
fi

ndb=0; for _ in $DBS; do ndb=$((ndb + 1)); done
runs=$((SHARDS * ndb))
ENGINE="${E2E_ENGINE:-}"
if [[ -z "$ENGINE" ]]; then
  if command -v podman >/dev/null 2>&1; then ENGINE=podman; elif command -v docker >/dev/null 2>&1; then ENGINE=docker; fi
fi
case "$ENGINE" in
  podman) cpus="$(podman info --format '{{.Host.CPUs}}' 2>/dev/null)" ;;
  docker) cpus="$(docker info --format '{{.NCPU}}' 2>/dev/null)" ;;
  *) cpus="" ;;
esac
if [[ "$cpus" =~ ^[0-9]+$ ]] && ((runs > cpus)); then
  echo "e2e-all: warning: $runs runs at once on an engine with $cpus CPUs; each will be slower (see --help, Choosing --shards)"
fi

PIDS=() ; NAMES=() ; DBOF=()
stop() { for p in ${PIDS[@]+"${PIDS[@]}"}; do kill "$p" 2>/dev/null; done; }
trap 'stop; wait; exit 130' INT TERM

# One build for every run: parallel runs building the same image tag at once only slow each other down. With --no-build it still
# runs once, to check the server image is there and pull a missing Cypress image once rather than in every run at the same time.
if ((BUILD)); then
  echo "e2e-all: building the image once (log in $OUT/build.log)"
  build_args=(build)
else
  echo "e2e-all: checking the images once (log in $OUT/build.log)"
  build_args=(build --no-build)
fi
# In the background with a wait, so an INT or TERM stops it now and not when the build ends (bash holds a trap until a foreground child exits).
bash "$ROOT/scripts/e2e-up.sh" "${build_args[@]}" > "$OUT/build.log" 2>&1 &
PIDS=("$!")
wait "${PIDS[0]}" || { echo "e2e-all: the image build failed:"; tail -n 12 "$OUT/build.log"; echo "E2E RESULT: FAIL build=FAIL(2)"; exit 2; }
PIDS=()

echo "e2e-all: databases: $DBS; shards: $SHARDS; logs in $OUT"
for db in $DBS; do
  for ((k = 1; k <= SHARDS; k++)); do
    if ((SHARDS == 1)); then
      name="$db" ; args=(${EXTRA[@]+"${EXTRA[@]}"})
    else
      name="$db.$k" ; args=(--spec "${SPEC_GROUPS[k - 1]}" ${EXTRA[@]+"${EXTRA[@]}"})
    fi
    E2E_DB="$db" bash "$ROOT/scripts/e2e-up.sh" run --no-build --out "$OUT/$name" ${args[@]+-- "${args[@]}"} > "$OUT/$name.log" 2>&1 &
    PIDS+=("$!") ; NAMES+=("$name") ; DBOF+=("$db")
  done
done

fail=0 ; setup=0 ; summary="" ; CODES=()
for i in "${!PIDS[@]}"; do
  wait "${PIDS[$i]}"; code=$?
  CODES+=("$code")
  name="${NAMES[$i]}"
  if ((code == 0)); then summary+=" $name=PASS"; else summary+=" $name=FAIL($code)"; fail=1; fi
  # e2e-up.sh exits 1 for a spec failure and 2 for a run that could not start; any other code did not get as far as a result either.
  ((code != 0 && code != 1)) && setup=1
  echo "--- $name (exit $code), last lines of $OUT/$name.log:"
  tail -n 12 "$OUT/$name.log"
done

# The counts of each database, added over its shards, and the check that every spec file ran once.
for db in $DBS; do
  logs=() ; passed=1
  for i in "${!NAMES[@]}"; do
    [[ "${DBOF[$i]}" == "$db" ]] || continue
    logs+=("$OUT/${NAMES[$i]}.log")
    ((CODES[i] == 0)) || passed=0
  done
  s=0 ; t=0 ; p=0 ; f=0 ; known=1
  while IFS= read -r line; do
    if [[ "$line" =~ ^specs=([0-9]+)\ tests=([0-9]+)\ passing=([0-9]+)\ failing=([0-9]+)$ ]]; then
      s=$((s + BASH_REMATCH[1])) ; t=$((t + BASH_REMATCH[2])) ; p=$((p + BASH_REMATCH[3])) ; f=$((f + BASH_REMATCH[4]))
    else
      known=0
    fi
  done < <(node "$SHARDS_JS" --counts "${logs[@]}" 2>/dev/null)
  if ((known)); then
    echo "e2e-all: $db: $s specs, $t tests ($p passing, $f failing) over $SHARDS shard(s)"
  else
    echo "e2e-all: $db: counts not read from every log (a run with no Cypress summary); at least $s specs, $t tests"
  fi
  if ((FULL && passed)); then
    if ((!known)); then
      echo "e2e-all: $db: every run passed but a log has no Cypress summary, so the spec count cannot be checked"
      summary+=" $db.specs=FAIL(unread)"; fail=1
    elif ((s != ON_DISK)); then
      echo "e2e-all: $db ran $s specs, but there are $ON_DISK spec files"
      summary+=" $db.specs=FAIL($s/$ON_DISK)"; fail=1
    fi
  fi
done

echo "e2e-all: finished in $((SECONDS / 60))m$((SECONDS % 60))s"
if ((fail)); then echo "E2E RESULT: FAIL$summary"; else echo "E2E RESULT: PASS$summary"; fi
if ((setup)); then exit 2; fi
exit "$fail"
