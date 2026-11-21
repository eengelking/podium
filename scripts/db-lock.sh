#!/usr/bin/env bash
# The machine's database lock (#1284): only one heavy database job runs at a time per user, because two at once (throwaway
# PostgreSQL and MariaDB containers, a whole vitest run, e2e runs with their own servers and Chrome) slow each other until
# timing-sensitive tests fail for reasons that have nothing to do with the code.
#
# Source it from a script, then call the functions:
#   source "$ROOT/scripts/db-lock.sh"
#   db_lock_acquire "test-db"        # waits for its turn; the name is only for messages
#   ... the work ...                 # the lock is released when the script exits (EXIT, INT, TERM, HUP)
# A script that sets its own EXIT trap after acquiring must call db_lock_release in it, because a new EXIT trap replaces ours.
# Run directly, it only answers --help.
#
# How it works: the lock is the directory ${TMPDIR:-/tmp}/podium-db-lock-<uid>, made with mkdir (atomic, and macOS has no flock).
# The holder writes its pid into it. A waiter whose holder's pid is dead takes the lock over. A holder exports
# PODIUM_DB_LOCK_HELD=<its pid>, so a script it starts (test-db.sh, e2e-fast.mjs -> e2e-all.sh -> e2e-up.sh) sees that its parent
# holds the lock and does not wait for it: only the outermost script waits.
#
# Environment:
#   CI=<anything>               No lock (a CI runner has one job). The reason is printed once.
#   PODIUM_DB_LOCK=off          No lock. The reason is printed once. Use it only when you know nothing else is running.
#   PODIUM_DB_LOCK_TIMEOUT_S    Give up after this many seconds of waiting and exit 3 (default: wait without limit).
#   PODIUM_DB_LOCK_POLL_S       Seconds between tries (default 5).
# Exit code of a waiter that gave up: 3.

db_lock_usage() {
  sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

db_lock_dir() { printf '%s/podium-db-lock-%s' "${TMPDIR:-/tmp}" "$(id -u)"; }

# 0 when this script (or a script above it) holds the lock.
db_lock_held() {
  local dir holder
  dir="$(db_lock_dir)"
  [[ -n "${PODIUM_DB_LOCK_HELD:-}" ]] || return 1
  holder="$(cat "$dir/pid" 2>/dev/null)"
  [[ "$holder" == "$PODIUM_DB_LOCK_HELD" ]] && kill -0 "$holder" 2>/dev/null
}

# Releases the lock if this script's own process holds it. Safe to call more than once, and when it holds nothing.
db_lock_release() {
  local dir
  dir="$(db_lock_dir)"
  if [[ "$(cat "$dir/pid" 2>/dev/null)" == "$$" ]]; then rm -rf "$dir"; fi
  return 0
}

db_lock_acquire() {
  local name="${1:-database job}" dir holder waited=0 last=-60 start poll stale
  if [[ -n "${CI:-}" ]]; then
    [[ -n "${PODIUM_DB_LOCK_NOTE:-}" ]] || echo "db-lock: no lock, CI is set" >&2
    export PODIUM_DB_LOCK_NOTE=1
    return 0
  fi
  if [[ "${PODIUM_DB_LOCK:-}" == off ]]; then
    [[ -n "${PODIUM_DB_LOCK_NOTE:-}" ]] || echo "db-lock: no lock, PODIUM_DB_LOCK=off" >&2
    export PODIUM_DB_LOCK_NOTE=1
    return 0
  fi
  db_lock_held && return 0
  dir="$(db_lock_dir)"
  poll="${PODIUM_DB_LOCK_POLL_S:-5}"
  start=$SECONDS
  while ! mkdir "$dir" 2>/dev/null; do
    holder="$(cat "$dir/pid" 2>/dev/null)"
    stale=0
    if [[ -n "$holder" ]]; then
      kill -0 "$holder" 2>/dev/null || stale=1
    elif [[ ! -d "$dir" ]] || [[ -n "$(find "$dir" -maxdepth 0 -mmin +1 2>/dev/null)" ]]; then
      stale=1  # gone already, or made a minute ago by a holder that never wrote its pid
    fi
    if ((stale)); then
      # Rename first: only one waiter wins the rename, and it checks it took the dead lock, not a new one.
      if mv "$dir" "$dir.stale.$$" 2>/dev/null; then
        if [[ "$(cat "$dir.stale.$$/pid" 2>/dev/null)" == "$holder" ]]; then
          echo "db-lock: the holder (pid ${holder:-none}) is gone, taking the lock over" >&2
          rm -rf "$dir.stale.$$"
        else
          mv "$dir.stale.$$" "$dir" 2>/dev/null || rm -rf "$dir.stale.$$"
        fi
      fi
      continue
    fi
    waited=$((SECONDS - start))
    if [[ -n "${PODIUM_DB_LOCK_TIMEOUT_S:-}" ]] && ((waited >= PODIUM_DB_LOCK_TIMEOUT_S)); then
      echo "db-lock: gave up after ${waited}s waiting for the database test lock held by pid ${holder:-?} ($name). Set PODIUM_DB_LOCK_TIMEOUT_S higher, or wait." >&2
      exit 3
    fi
    if ((waited - last >= 60)); then
      echo "db-lock: waiting for the database test lock (held by pid ${holder:-?}, waited ${waited}s) for $name" >&2
      last=$waited
    fi
    sleep "$poll"
  done
  echo $$ >"$dir/pid"
  export PODIUM_DB_LOCK_HELD=$$
  trap 'db_lock_release' EXIT
  trap 'db_lock_release; exit 130' INT
  trap 'db_lock_release; exit 143' TERM
  trap 'db_lock_release; exit 129' HUP
  if ((SECONDS - start > 0)); then echo "db-lock: got the lock after $((SECONDS - start))s for $name" >&2; fi
  return 0
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  case "${1:-}" in
    ""|-h|--help) db_lock_usage; exit 0 ;;
    *) echo "db-lock: source this file; it takes no command (see --help)" >&2; exit 2 ;;
  esac
fi
