#!/usr/bin/env bash
# Type-checks the OpenCode reporter (plugin/opencode/) against OpenCode's plugin API types (#855).
#
# `@opencode/plugin` is supplied by OpenCode at runtime, and its install is large (about 160 MB with its dependencies), so it is not
# a dependency of this repo. This script installs the pinned version once into .build-test/opencode-types/ (git-ignored) and runs
# tsc with plugin/opencode/tsconfig.json, which maps the package there.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/podium-opencode-typecheck.sh

Installs @opencode/plugin (the version pinned in this script) into .build-test/opencode-types/ if it is not there yet, then
type-checks plugin/opencode/ against it. Needs network the first time only.

  -h, --help   Show this help
USAGE
}

case "${1:-}" in -h|--help) usage; exit 0 ;; esac

VERSION="2.2.5"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/.build-test/opencode-types"

if [[ ! -f "$DIR/node_modules/@opencode/plugin/package.json" ]] || ! grep -q "\"version\": \"$VERSION\"" "$DIR/node_modules/@opencode/plugin/package.json"; then
  rm -rf "$DIR"
  mkdir -p "$DIR"
  (cd "$DIR" && npm init -y >/dev/null 2>&1 && npm install --ignore-scripts --legacy-peer-deps --no-audit --no-fund "@opencode/plugin@$VERSION")
fi
node "$ROOT/node_modules/typescript/bin/tsc" -p "$ROOT/plugin/opencode/tsconfig.json"
echo "opencode type-check passed"
