#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=load-env.sh
. "$script_dir/load-env.sh" "${1:-.env}"

auth_file="$REGISTRY_AUTH_DIR/htpasswd"
if [ ! -s "$auth_file" ]; then
  echo "No Registry user exists. Run: make user USER=<name>" >&2
  exit 2
fi

if ! grep -Eq '^[A-Za-z0-9._-]+:\$2[aby]\$' "$auth_file"; then
  echo "The htpasswd file has no bcrypt entry; refusing to start." >&2
  exit 2
fi
