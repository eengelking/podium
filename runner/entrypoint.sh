#!/usr/bin/env bash
# Registers the runner once using the one-hour registration token from
# GitHub's "New self-hosted runner" page, saves its credentials to $STATE_DIR,
# and reuses them on every later start. The token is only needed the first time.
set -euo pipefail

: "${GH_REPO:?set GH_REPO (owner/repo)}"
: "${RUNNER_NAME:?}"
: "${RUNNER_WORKDIR:?}"
: "${STATE_DIR:?}"

RUNNER_TOKEN=${RUNNER_TOKEN:-${GH_TOKEN:-}}  # accept the old variable name
files=(.runner .credentials .credentials_rsaparams)

if [[ -f $STATE_DIR/.runner ]]; then
  for f in "${files[@]}"; do cp -p "$STATE_DIR/$f" "./$f"; done
  echo "Reusing saved registration for ${RUNNER_NAME}"
else
  : "${RUNNER_TOKEN:?no saved registration and RUNNER_TOKEN is not set}"
  # Podman's env-file parser keeps quotes and stray whitespace; strip them.
  token=$(printf '%s' "${RUNNER_TOKEN}" | tr -d '\r\n"'"'"'[:space:]')
  ./config.sh --unattended --replace \
    --url "https://github.com/${GH_REPO}" \
    --token "${token}" \
    --name "${RUNNER_NAME}" \
    --labels "${RUNNER_LABELS:-self-hosted,linux,x64,podman}" \
    --work "${RUNNER_WORKDIR}"
  for f in "${files[@]}"; do cp -p "./$f" "$STATE_DIR/$f"; done
fi

exec ./run.sh
