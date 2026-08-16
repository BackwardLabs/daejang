#!/bin/sh

set -eu

env_file=${1:-.env}

if [ ! -f "$env_file" ]; then
  echo "Missing $env_file. Run: make init" >&2
  exit 2
fi

set -a
# The file is local operator input and must contain shell-compatible KEY=VALUE lines.
# shellcheck disable=SC1090
. "$env_file"
set +a

: "${REGISTRY_DATA_DIR:?REGISTRY_DATA_DIR is required in $env_file}"
: "${REGISTRY_AUTH_DIR:?REGISTRY_AUTH_DIR is required in $env_file}"
: "${REGISTRY_LOOPBACK_PORT:=5050}"
: "${TAILSCALE_CLI:=}"

export REGISTRY_DATA_DIR REGISTRY_AUTH_DIR REGISTRY_LOOPBACK_PORT TAILSCALE_CLI
