#!/bin/bash

set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
registry_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
daejang_repo=$(CDPATH= cd -- "$registry_dir/../.." && pwd)
workspace_root=$(CDPATH= cd -- "$daejang_repo/.." && pwd)

# shellcheck source=load-env.sh
. "$script_dir/load-env.sh" "${1:-.env}"
# shellcheck source=tailscale-common.sh
. "$script_dir/tailscale-common.sh"

for command_name in docker git gh jq; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command not found: $command_name" >&2
    exit 2
  fi
done

if docker buildx version >/dev/null 2>&1; then
  buildx_command=(docker buildx)
elif [ -x /Applications/Docker.app/Contents/Resources/cli-plugins/docker-buildx ]; then
  # Docker Desktop can be installed for another macOS account while this
  # shared checkout is used from the current account. In that case the CLI
  # plugin is not discovered automatically, but the bundled plugin still
  # talks to the same Docker Engine.
  buildx_command=(/Applications/Docker.app/Contents/Resources/cli-plugins/docker-buildx)
else
  echo "Docker Buildx is required to pass private dependency credentials as BuildKit secrets." >&2
  exit 2
fi

tailscale_cli=$(find_tailscale_cli)
registry_host=$(tailscale_dns_name "$tailscale_cli")
lock_dir="$registry_dir/e2e"
lock_file="$lock_dir/images.lock.json"
stage_dir=$(mktemp -d /tmp/daejang-core-images.XXXXXX)
chmod 755 "$stage_dir"
token_file=${GITHUB_TOKEN_FILE:-$stage_dir/github-token}
metadata_file=$stage_dir/images.tsv

cleanup() {
  if [ -z "${GITHUB_TOKEN_FILE:-}" ] && [ -f "$token_file" ]; then
    chmod 600 "$token_file" 2>/dev/null || true
  fi
  if [ -d "$stage_dir" ]; then
    find "$stage_dir" -depth -delete
  fi
}
trap cleanup EXIT HUP INT TERM

if [ -z "${GITHUB_TOKEN_FILE:-}" ]; then
  gh auth token > "$token_file"
  chmod 600 "$token_file"
elif [ ! -s "$token_file" ]; then
  echo "GITHUB_TOKEN_FILE does not exist or is empty: $token_file" >&2
  exit 2
fi

clone_at_head() {
  local repo_name=$1
  local source_repo=$workspace_root/$repo_name
  local checkout=$stage_dir/$repo_name
  local commit

  if [ ! -d "$source_repo/.git" ]; then
    echo "Source repository not found: $source_repo" >&2
    exit 2
  fi

  commit=$(git -c safe.directory="$source_repo" -C "$source_repo" rev-parse HEAD)
  echo "Preparing $repo_name@$commit"
  git \
    -c safe.directory="$source_repo" \
    -c safe.directory="$source_repo/.git" \
    clone --quiet --no-hardlinks --no-checkout "$source_repo" "$checkout"
  git -C "$checkout" checkout --quiet --detach "$commit"
  chmod -R a+rX "$checkout"
}

for repo_name in daejang daejang-jit-engine daejang-posting-service daejang-tax-engine daejang-reviewroom; do
  clone_at_head "$repo_name"
done

stage_report_attestation_runtime() {
  local source_runtime=$daejang_repo/node_modules/@backward-labs/daejang-contracts
  local source_entry=$source_runtime/dist/public/giwaSepoliaV1.js
  local target_runtime=$stage_dir/daejang/.docker-runtime/daejang-contracts
  local expected_entry_sha256=d7a29f3ed606ed24897f6a7c292bfa7294be760466fba23d834b6c896f112acb
  local actual_entry_sha256

  if [ ! -f "$source_entry" ] || [ -L "$source_runtime" ]; then
    echo "Verified GIWA report attestation runtime is not installed: $source_runtime" >&2
    exit 2
  fi
  if find "$source_runtime" -type l -print -quit | grep -q .; then
    echo "GIWA report attestation runtime contains a symbolic link" >&2
    exit 2
  fi
  actual_entry_sha256=$(shasum -a 256 "$source_entry" | awk '{print $1}')
  if [ "$actual_entry_sha256" != "$expected_entry_sha256" ]; then
    echo "GIWA report attestation runtime entry digest does not match the verified release" >&2
    exit 2
  fi

  mkdir -p "$target_runtime"
  find "$target_runtime" -mindepth 1 -delete
  COPYFILE_DISABLE=1 cp -R "$source_runtime"/. "$target_runtime"/
  chmod -R a+rX "$target_runtime"
}

stage_report_attestation_runtime

build_and_push() {
  local key=$1
  local repo_name=$2
  local image_name=$3
  local dockerfile=$4
  local target=$5
  local needs_secret=$6
  local checkout=$stage_dir/$repo_name
  local commit
  local tag_ref
  local repository_ref
  local push_log
  local digest
  local immutable_ref
  local -a build_args

  commit=$(git -C "$checkout" rev-parse HEAD)
  repository_ref=$registry_host/daejang/$image_name
  tag_ref=$repository_ref:sha-$commit
  push_log=$stage_dir/push-$key.log

  build_args=(
    "${buildx_command[@]}" build
    --load
    --progress plain
    --pull
    --platform linux/arm64
    --file "$checkout/$dockerfile"
    --label "org.opencontainers.image.revision=$commit"
    --label "org.opencontainers.image.source=https://github.com/BackwardLabs/$repo_name"
    --tag "$tag_ref"
  )
  if [ -n "$target" ]; then
    build_args+=(--target "$target")
  fi
  if [ "$needs_secret" = true ]; then
    build_args+=(--secret "id=github_token,src=$token_file")
  fi
  if [ "$key" = web-api ]; then
    build_args+=(--build-arg GIWA_REPORT_ATTESTATION_RUNTIME_REQUIRED=true)
  fi
  build_args+=("$checkout")

  echo
  echo "Building $key -> $tag_ref"
  "${build_args[@]}"

  echo "Pushing $tag_ref"
  docker push "$tag_ref" | tee "$push_log"
  digest=$(sed -n 's/^.*digest: \(sha256:[0-9a-f]\{64\}\).*$/\1/p' "$push_log" | tail -n 1)
  if [ -z "$digest" ]; then
    echo "Could not determine pushed digest for $tag_ref" >&2
    exit 1
  fi

  immutable_ref=$repository_ref@$digest
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$key" "$repo_name" "$commit" "$tag_ref" "$digest" "$immutable_ref" >> "$metadata_file"
  echo "Published $immutable_ref"
}

: > "$metadata_file"
build_and_push web-api daejang web-api apps/web-api/Dockerfile '' false
build_and_push engine daejang engine services/engine/Dockerfile engine-runtime true
build_and_push pdf-parser daejang pdf-parser services/engine/Dockerfile parser-runtime true
build_and_push jit-engine daejang-jit-engine jit-engine Dockerfile '' true
build_and_push posting-service daejang-posting-service posting-service Dockerfile '' true
build_and_push tax-engine daejang-tax-engine tax-engine Dockerfile '' true
build_and_push tax-engine-dev-e2e daejang-tax-engine tax-engine-dev-e2e Dockerfile dev-e2e true
build_and_push reviewroom daejang-reviewroom reviewroom Dockerfile '' false

mkdir -p "$lock_dir"
lock_tmp=$(mktemp "$lock_dir/.images.lock.json.XXXXXX")
generated_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
jq -n \
  --arg registry "$registry_host" \
  --arg generatedAt "$generated_at" \
  '{schemaVersion: 1, registry: $registry, platform: "linux/arm64", generatedAt: $generatedAt, images: {}}' \
  > "$lock_tmp"

while IFS=$'\t' read -r key repo_name commit tag_ref digest immutable_ref; do
  next_lock=$(mktemp "$lock_dir/.images.lock.json.XXXXXX")
  jq \
    --arg key "$key" \
    --arg repository "$repo_name" \
    --arg commit "$commit" \
    --arg tag "$tag_ref" \
    --arg digest "$digest" \
    --arg ref "$immutable_ref" \
    '.images[$key] = {sourceRepository: $repository, commit: $commit, tag: $tag, digest: $digest, ref: $ref}' \
    "$lock_tmp" > "$next_lock"
  mv "$next_lock" "$lock_tmp"
done < "$metadata_file"

chmod 644 "$lock_tmp"
mv "$lock_tmp" "$lock_file"

echo
echo "Core E2E images published."
echo "Lock file: $lock_file"
jq -r '.images | to_entries[] | "\(.key): \(.value.ref)"' "$lock_file"
