#!/bin/sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
lock_file=$script_dir/../e2e/images.lock.json

if [ ! -s "$lock_file" ]; then
  echo "Core image lock does not exist. Run: make images-publish" >&2
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required to read $lock_file" >&2
  exit 2
fi

expected_platform=$(jq -r '.platform' "$lock_file")

jq -r '.images | to_entries[] | [.key, .value.ref] | @tsv' "$lock_file" |
while IFS="$(printf '\t')" read -r image_name image_ref; do
  echo "Pulling $image_name"
  docker pull "$image_ref"
  image_platform=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image_ref")
  if [ "$image_platform" != "$expected_platform" ]; then
    echo "$image_name has platform $image_platform; expected $expected_platform" >&2
    exit 1
  fi
  echo "Verified $image_name -> $image_ref"
done
