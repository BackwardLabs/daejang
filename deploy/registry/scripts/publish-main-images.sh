#!/bin/bash

set -Eeuo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
registry_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
runtime_root=${DAEJANG_PUBLISHER_STATE_DIR:-/Users/Shared/DaejangRegistry/publisher}
state_file=$runtime_root/state.json
lock_dir=$runtime_root/run.lock
stage_root=$runtime_root/tmp
cleanup_root=$runtime_root/cleanup
cleanup_queue=$cleanup_root/pending.tsv
publisher_child=${DAEJANG_PUBLISHER_CHILD:-0}
repository=${2:-}

log() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

remove_tree() {
  target=$1
  if [ -n "$target" ] && [ -d "$target" ]; then
    find "$target" -depth -delete
  fi
}

require_commands() {
  for command_name in docker gh jq tar mktemp; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
      echo "Required command not found: $command_name" >&2
      return 2
    fi
  done
}

ensure_runtime() {
  mkdir -p -m 700 "$runtime_root" "$stage_root" "$cleanup_root"
  if [ ! -e "$state_file" ]; then
    state_tmp=$(mktemp "$runtime_root/.state.json.XXXXXX")
    printf '%s\n' '{"schemaVersion":1,"repositories":{}}' > "$state_tmp"
    chmod 600 "$state_tmp"
    mv "$state_tmp" "$state_file"
  fi
  jq -e '.schemaVersion == 1 and (.repositories | type == "object")' "$state_file" >/dev/null
}

queue_replaced_digests() {
  repo_name=$1
  metadata_file=$2
  queue_tmp=$(mktemp "$cleanup_root/.pending.tsv.XXXXXX")
  if [ -s "$cleanup_queue" ]; then
    cat "$cleanup_queue" > "$queue_tmp"
  fi
  old_commit=$(jq -r --arg repository "$repo_name" '.repositories[$repository].commit // empty' "$state_file")
  while IFS=$'\t' read -r image_name _ new_digest _; do
    old_digest=$(jq -r \
      --arg repository "$repo_name" \
      --arg image "$image_name" \
      '.repositories[$repository].images[$image].digest // empty' \
      "$state_file")
    if [ -n "$old_digest" ] && [ "$old_digest" != "$new_digest" ]; then
      printf '%s\t%s\t%s\n' "daejang/$image_name" "$old_digest" "$old_commit" >> "$queue_tmp"
    fi
  done < "$metadata_file"
  sort -u "$queue_tmp" -o "$queue_tmp"
  chmod 600 "$queue_tmp"
  mv "$queue_tmp" "$cleanup_queue"
}

acquire_lock() {
  if mkdir -m 700 "$lock_dir" 2>/dev/null; then
    printf '%s\n' "$$" > "$lock_dir/pid"
    return
  fi

  existing_pid=''
  if [ -f "$lock_dir/pid" ]; then
    existing_pid=$(sed -n '1p' "$lock_dir/pid")
  fi
  if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
    log "Publisher is already running as PID $existing_pid; skipping this interval."
    exit 0
  fi

  log "Removing stale publisher lock."
  remove_tree "$lock_dir"
  mkdir -m 700 "$lock_dir"
  printf '%s\n' "$$" > "$lock_dir/pid"
}

release_lock() {
  if [ -d "$lock_dir" ] && [ -f "$lock_dir/pid" ] && [ "$(sed -n '1p' "$lock_dir/pid")" = "$$" ]; then
    remove_tree "$lock_dir"
  fi
}

find_buildx() {
  if docker buildx version >/dev/null 2>&1; then
    buildx_command=(docker buildx)
  elif [ -x /Applications/Docker.app/Contents/Resources/cli-plugins/docker-buildx ]; then
    buildx_command=(/Applications/Docker.app/Contents/Resources/cli-plugins/docker-buildx)
  else
    echo "Docker Buildx is required." >&2
    return 2
  fi
}

configure_repository() {
  repo_name=$1
  image_names=()
  dockerfiles=()
  targets=()
  secret_flags=()

  case "$repo_name" in
    daejang)
      image_names=(web-api engine pdf-parser)
      dockerfiles=(apps/web-api/Dockerfile services/engine/Dockerfile services/engine/Dockerfile)
      targets=('' engine-runtime parser-runtime)
      secret_flags=(false true true)
      ;;
    daejang-jit-engine)
      image_names=(jit-engine)
      dockerfiles=(Dockerfile)
      targets=('')
      secret_flags=(true)
      ;;
    daejang-posting-service)
      image_names=(posting-service)
      dockerfiles=(Dockerfile)
      targets=('')
      secret_flags=(true)
      ;;
    daejang-tax-engine)
      image_names=(tax-engine tax-engine-dev-e2e)
      dockerfiles=(Dockerfile Dockerfile)
      targets=('' dev-e2e)
      secret_flags=(true true)
      ;;
    daejang-reviewroom)
      # One image carries the API, anchor worker and delivery worker; the
      # deployment selects the workload by command. Dependencies are public npm
      # packages, so the build needs no GitHub token.
      image_names=(reviewroom)
      dockerfiles=(Dockerfile)
      targets=('')
      secret_flags=(false)
      ;;
    *)
      echo "Unsupported repository: $repo_name" >&2
      return 2
      ;;
  esac
}

remote_main_sha() {
  repo_name=$1
  gh api --jq '.sha' "repos/BackwardLabs/$repo_name/commits/main"
}

record_repository_state() {
  repo_name=$1
  commit=$2
  metadata_file=$3
  images_json=$(jq -Rn '
    [inputs | split("\t") | {
      key: .[0],
      value: {tag: .[1], digest: .[2], ref: .[3]}
    }] | from_entries
  ' < "$metadata_file")
  state_tmp=$(mktemp "$runtime_root/.state.json.XXXXXX")
  jq \
    --arg repository "$repo_name" \
    --arg commit "$commit" \
    --arg publishedAt "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    --argjson images "$images_json" \
    '.repositories[$repository] = {commit: $commit, publishedAt: $publishedAt, images: $images}' \
    "$state_file" > "$state_tmp"
  chmod 600 "$state_tmp"
  mv "$state_tmp" "$state_file"
}

latest_matches_commit() {
  repo_name=$1
  commit=$2
  registry_host=$3
  configure_repository "$repo_name"

  for image_name in "${image_names[@]}"; do
    latest_ref=$registry_host/daejang/$image_name:latest
    if ! docker pull "$latest_ref" >/dev/null 2>&1; then
      return 1
    fi
    revision=$(docker image inspect \
      --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
      "$latest_ref" 2>/dev/null || true)
    if [ "$revision" != "$commit" ]; then
      return 1
    fi
  done
}

state_has_immutable_tags() {
  repo_name=$1
  commit=$2
  configure_repository "$repo_name"
  for image_name in "${image_names[@]}"; do
    recorded_tag=$(jq -r \
      --arg repository "$repo_name" \
      --arg image "$image_name" \
      '.repositories[$repository].images[$image].tag // empty' \
      "$state_file")
    case "$recorded_tag" in
      *":sha-$commit") ;;
      *) return 1 ;;
    esac
  done
}

build_repository() {
  repo_name=$1
  commit=$2
  registry_host=$3
  source_dir=$4
  token_file=$5
  metadata_file=$6
  configure_repository "$repo_name"
  : > "$metadata_file"

  immutable_refs=()
  latest_refs=()

  for index in "${!image_names[@]}"; do
    image_name=${image_names[$index]}
    dockerfile=${dockerfiles[$index]}
    target=${targets[$index]}
    needs_secret=${secret_flags[$index]}
    repository_ref=$registry_host/daejang/$image_name
    immutable_ref=$repository_ref:sha-$commit
    latest_ref=$repository_ref:latest
    build_args=(
      "${buildx_command[@]}" build
      --load
      --progress plain
      --pull
      --platform linux/arm64
      --file "$source_dir/$dockerfile"
      --label "org.opencontainers.image.revision=$commit"
      --label "org.opencontainers.image.source=https://github.com/BackwardLabs/$repo_name"
      --tag "$immutable_ref"
    )
    if [ -n "$target" ]; then
      build_args+=(--target "$target")
    fi
    if [ "$needs_secret" = true ]; then
      build_args+=(--secret "id=github_token,src=$token_file")
    fi
    build_args+=("$source_dir")

    log "Building $repo_name/$image_name at $commit."
    "${build_args[@]}"
    immutable_refs+=("$immutable_ref")
    latest_refs+=("$latest_ref")
  done

  # Every image for the repository is built before latest starts moving. Push
  # the immutable SHA tag first so an approved Release can keep using the same
  # digest after latest advances.
  for index in "${!image_names[@]}"; do
    image_name=${image_names[$index]}
    immutable_ref=${immutable_refs[$index]}
    latest_ref=${latest_refs[$index]}
    push_log=$metadata_file.$index.immutable.push
    log "Publishing immutable image $immutable_ref."
    docker push "$immutable_ref" | tee "$push_log"
    digest=$(sed -n 's/^.*digest: \(sha256:[0-9a-f]\{64\}\).*$/\1/p' "$push_log" | tail -n 1)
    if [ -z "$digest" ]; then
      echo "Could not determine pushed digest for $immutable_ref" >&2
      return 1
    fi
    log "Updating $latest_ref."
    docker image tag "$immutable_ref" "$latest_ref"
    docker push "$latest_ref" > "$metadata_file.$index.latest.push"
    printf '%s\t%s\t%s\t%s\n' \
      "$image_name" "$immutable_ref" "$digest" "${immutable_ref%:*}@$digest" >> "$metadata_file"
  done

  for immutable_ref in "${immutable_refs[@]}"; do
    docker image rm "$immutable_ref" >/dev/null 2>&1 || true
  done
}

publish_one_repository() {
  repo_name=$1
  require_commands
  ensure_runtime
  docker info >/dev/null
  gh auth status >/dev/null
  find_buildx

  registry_host=$("$script_dir/registry-endpoint.sh" "$registry_dir/.env")
  commit=$(remote_main_sha "$repo_name")
  if [[ ! "$commit" =~ ^[0-9a-f]{40}$ ]]; then
    echo "GitHub returned an invalid main commit for $repo_name: $commit" >&2
    return 1
  fi

  published_commit=$(jq -r --arg repository "$repo_name" '.repositories[$repository].commit // empty' "$state_file")
  if [ "$published_commit" = "$commit" ] && state_has_immutable_tags "$repo_name" "$commit"; then
    log "$repo_name is unchanged at $commit."
    return
  fi

  if latest_matches_commit "$repo_name" "$commit" "$registry_host"; then
    reconcile_metadata=$(mktemp "$stage_root/$repo_name.reconcile.XXXXXX")
    configure_repository "$repo_name"
    for image_name in "${image_names[@]}"; do
      latest_ref=$registry_host/daejang/$image_name:latest
      immutable_tag=$registry_host/daejang/$image_name:sha-$commit
      immutable_ref=$(docker image inspect \
        --format '{{range .RepoDigests}}{{println .}}{{end}}' "$latest_ref" |
        awk -v prefix="$registry_host/daejang/$image_name@" 'index($0, prefix) == 1 { print; exit }')
      digest=${immutable_ref##*@}
      docker image tag "$latest_ref" "$immutable_tag"
      docker push "$immutable_tag" >/dev/null
      printf '%s\t%s\t%s\t%s\n' \
        "$image_name" "$immutable_tag" "$digest" "$immutable_ref" \
        >> "$reconcile_metadata"
    done
    record_repository_state "$repo_name" "$commit" "$reconcile_metadata"
    find "$reconcile_metadata" -delete
    log "Reconciled existing latest images for $repo_name at $commit."
    return
  fi

  stage_dir=$(mktemp -d "$stage_root/$repo_name.XXXXXX")
  chmod 700 "$stage_dir"
  source_dir=$stage_dir/source
  archive_file=$stage_dir/source.tar.gz
  token_file=$stage_dir/github-token
  metadata_file=$stage_dir/images.tsv
  cleanup_repository() {
    remove_tree "$stage_dir"
  }
  trap cleanup_repository EXIT HUP INT TERM

  mkdir -m 755 "$source_dir"
  gh auth token > "$token_file"
  chmod 600 "$token_file"
  log "Downloading BackwardLabs/$repo_name@$commit."
  gh api "repos/BackwardLabs/$repo_name/tarball/$commit" > "$archive_file"
  tar -xzf "$archive_file" -C "$source_dir" --strip-components=1
  chmod -R a+rX "$source_dir"

  build_repository "$repo_name" "$commit" "$registry_host" "$source_dir" "$token_file" "$metadata_file"
  queue_replaced_digests "$repo_name" "$metadata_file"
  record_repository_state "$repo_name" "$commit" "$metadata_file"
  log "Published $repo_name@$commit."
}

run_publisher() {
  require_commands
  ensure_runtime
  acquire_lock
  trap release_lock EXIT HUP INT TERM

  failures=0
  for repo_name in daejang daejang-jit-engine daejang-posting-service daejang-tax-engine daejang-reviewroom; do
    if DAEJANG_PUBLISHER_CHILD=1 "$0" --repo "$repo_name"; then
      :
    else
      failures=$((failures + 1))
      log "Publish failed for $repo_name; it will be retried next interval."
    fi
  done

  if [ "$failures" -ne 0 ]; then
    log "$failures repository publish operation(s) failed."
    return 1
  fi
  log "Publisher check completed successfully."
}

case "${1:-}" in
  --repo)
    if [ "$publisher_child" != 1 ] || [ -z "$repository" ]; then
      echo "--repo is reserved for the publisher child process." >&2
      exit 2
    fi
    publish_one_repository "$repository"
    ;;
  '')
    run_publisher
    ;;
  *)
    echo "Usage: $0" >&2
    exit 2
    ;;
esac
