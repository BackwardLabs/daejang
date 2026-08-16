#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=load-env.sh
. "$script_dir/load-env.sh" "${1:-.env}"

runtime_group=$(id -gn)
data_parent=$(dirname -- "$REGISTRY_DATA_DIR")
auth_parent=$(dirname -- "$REGISTRY_AUTH_DIR")

mkdir -p "$data_parent" "$auth_parent"
chgrp "$runtime_group" "$data_parent" "$auth_parent"
chmod 750 "$data_parent" "$auth_parent"

mkdir -p "$REGISTRY_DATA_DIR" "$REGISTRY_AUTH_DIR"
chgrp "$runtime_group" "$REGISTRY_DATA_DIR" "$REGISTRY_AUTH_DIR"
chmod 770 "$REGISTRY_DATA_DIR"
chmod 750 "$REGISTRY_AUTH_DIR"

if [ ! -e "$REGISTRY_AUTH_DIR/htpasswd" ]; then
  : > "$REGISTRY_AUTH_DIR/htpasswd"
fi
chgrp "$runtime_group" "$REGISTRY_AUTH_DIR/htpasswd"
chmod 640 "$REGISTRY_AUTH_DIR/htpasswd"

echo "Runtime directories are ready."
echo "Next: make user USER=<name>"
