#!/usr/bin/env bash
# Runs the server suite with the PostgreSQL tests on, against a throwaway PostgreSQL container, then removes it (#891).
#   scripts/test-pg.sh [vitest args...]     e.g. scripts/test-pg.sh src/storage/postgres/people.test.ts
# Needs podman (or docker, set CONTAINER_ENGINE=docker). The server is a placeholder-password container on a free local port.
set -euo pipefail
if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then sed -n "2,4p" "$0" | sed 's/^# \{0,1\}//'; exit 0; fi
engine="${CONTAINER_ENGINE:-podman}"
name="podium-test-pg-$$"
cd "$(dirname "$0")/../server"
cleanup() { "$engine" rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
"$engine" run -d --name "$name" -e POSTGRES_PASSWORD=change-me -p 127.0.0.1::5432 docker.io/library/postgres:17 >/dev/null
port="$("$engine" port "$name" 5432/tcp | head -n1 | sed 's/.*://')"
for _ in $(seq 1 60); do
  "$engine" exec "$name" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
export PODIUM_TEST_PG="postgres://postgres:change-me@127.0.0.1:${port}/postgres"
echo "PostgreSQL test server: 127.0.0.1:${port}"
npx vitest run "$@"
