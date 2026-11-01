#!/usr/bin/env bash
# Run a test command up to 3 times in CI, so one flaky failure (a timeout on a loaded runner) does not fail the PR.
#
# Usage: scripts/ci-retry.sh [--name STEP] [--timeout DURATION] [--attempts N] -- COMMAND [ARGS...]
#   --name      the step's name, quoted in the warning and the summary (default: the command)
#   --timeout   per-attempt limit, as `timeout` takes it (default: 10m)
#   --attempts  attempts in total, the first plus the retries (default: 3)
#
# Each attempt's output stays in the log. A failed attempt that another follows prints a ::warning:: with the last lines of its
# output. A pass after a retry writes a line to $GITHUB_STEP_SUMMARY. The last attempt's failure fails the run with its exit code.
set -o pipefail

name="" limit="10m" attempts=3
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --name) name="$2"; shift 2 ;;
    --timeout) limit="$2"; shift 2 ;;
    --attempts) attempts="$2"; shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
if [ $# -eq 0 ]; then echo "ci-retry: no command given (see --help)" >&2; exit 2; fi
name="${name:-$*}"

log="$(mktemp)"
trap 'rm -f "$log"' EXIT

attempt=1
while :; do
  echo "::group::$name, attempt $attempt of $attempts"
  timeout "$limit" "$@" 2>&1 | tee "$log"
  code=$?
  echo "::endgroup::"
  if [ "$code" -eq 0 ]; then
    if [ "$attempt" -gt 1 ] && [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
      echo "$name: passed on attempt $attempt of $attempts — a retry hid a failure, see the warning above" >> "$GITHUB_STEP_SUMMARY"
    fi
    exit 0
  fi
  if [ "$attempt" -ge "$attempts" ]; then
    echo "::error::$name failed on attempt $attempt of $attempts (exit $code)"
    exit "$code"
  fi
  # Workflow commands are one line: fold the last 5 lines of output into it.
  tail5="$(tail -n 5 "$log" | tr -d '\r' | tr '\n' '|')"
  echo "::warning title=Retried $name::Attempt $attempt of $attempts failed (exit $code), retrying. Last output: $tail5"
  attempt=$((attempt + 1))
done
