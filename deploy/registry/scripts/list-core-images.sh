#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
lock_file=$script_dir/../e2e/images.lock.json

if [ ! -s "$lock_file" ]; then
  echo "Core image lock does not exist. Run: make images-publish" >&2
  exit 2
fi

jq -r '.images | to_entries[] | "\(.key)\t\(.value.ref)"' "$lock_file"
