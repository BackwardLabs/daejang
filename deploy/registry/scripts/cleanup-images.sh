#!/bin/bash

set -Eeuo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
registry_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
runtime_root=${DAEJANG_PUBLISHER_STATE_DIR:-/Users/Shared/DaejangRegistry/publisher}
lock_dir=$runtime_root/run.lock
cleanup_root=$runtime_root/cleanup
cleanup_queue=$cleanup_root/pending.tsv
release_root=${GIWA_RELEASE_ROOT:-/Users/Shared/Projects/01_Daejang/releases}
compose_command=${COMPOSE:-docker-compose}
dry_run=false
registry_stopped=false
temp_dir=''

log() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

remove_tree() {
  target=$1
  if [ -n "$target" ] && [ -d "$target" ]; then
    find "$target" -depth -delete
  fi
}

release_lock() {
  if [ -d "$lock_dir" ] && [ -f "$lock_dir/pid" ] && [ "$(sed -n '1p' "$lock_dir/pid")" = "$$" ]; then
    remove_tree "$lock_dir"
  fi
}

cleanup_exit() {
  status=$?
  if [ "$registry_stopped" = true ]; then
    "$compose_command" --env-file "$registry_dir/.env" -f "$registry_dir/compose.yaml" up -d registry >/dev/null || true
  fi
  remove_tree "$temp_dir"
  release_lock
  exit "$status"
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
    log "Publisher or cleaner is already running as PID $existing_pid; skipping cleanup."
    exit 0
  fi
  log "Removing stale publisher lock."
  remove_tree "$lock_dir"
  mkdir -m 700 "$lock_dir"
  printf '%s\n' "$$" > "$lock_dir/pid"
}

case "${1:-}" in
  '') ;;
  --dry-run) dry_run=true ;;
  *) echo "Usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

for command_name in "$compose_command" curl docker grep jq; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command not found: $command_name" >&2
    exit 2
  fi
done

# shellcheck source=load-env.sh
. "$script_dir/load-env.sh" "$registry_dir/.env"
mkdir -p -m 700 "$runtime_root" "$cleanup_root"
acquire_lock
trap cleanup_exit EXIT HUP INT TERM

if [ -z "$("$compose_command" --env-file "$registry_dir/.env" -f "$registry_dir/compose.yaml" ps --status running -q registry)" ]; then
  echo "Registry is not running; cleanup was not started." >&2
  exit 1
fi

user_name=$(id -un)
user_home=$(dscl . -read "/Users/$user_name" NFSHomeDirectory | awk '{print $2}')
docker_config=${DOCKER_CONFIG:-$user_home/.docker}
registry_host=$("$script_dir/registry-endpoint.sh" "$registry_dir/.env")
registry_auth=$(jq -r --arg host "$registry_host" '.auths[$host].auth // empty' "$docker_config/config.json")
if [ -z "$registry_auth" ]; then
  echo "Docker login for $registry_host is required before cleanup." >&2
  exit 1
fi

temp_dir=$(mktemp -d "$cleanup_root/run.XXXXXX")
chmod 700 "$temp_dir"
curl_config=$temp_dir/curl.conf
{
  printf '%s\n' 'silent' 'show-error' 'fail-with-body'
  printf 'header = "Authorization: Basic %s"\n' "$registry_auth"
  printf '%s\n' 'header = "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"'
} > "$curl_config"
chmod 600 "$curl_config"

registry_url=http://127.0.0.1:${REGISTRY_LOOPBACK_PORT:-5050}
delete_digests=$temp_dir/delete-digests
: > "$delete_digests"
retained_queue=$temp_dir/retained-pending
: > "$retained_queue"
protected_digests=$temp_dir/protected-digests
: > "$protected_digests"

for release_pointer in current previous; do
  image_lock=$release_root/$release_pointer/images.lock.json
  if [ -r "$image_lock" ]; then
    jq -r '.images[]?.digest // empty' "$image_lock" >> "$protected_digests"
  fi
done
sort -u "$protected_digests" -o "$protected_digests"

is_protected_digest() {
  digest=$1
  grep -Fqx "$digest" "$protected_digests"
}

manifest_digest() {
  repository_name=$1
  reference=$2
  headers_file=$temp_dir/headers
  : > "$headers_file"
  if ! curl --config "$curl_config" --head --dump-header "$headers_file" --output /dev/null \
    "$registry_url/v2/$repository_name/manifests/$reference"; then
    return 1
  fi
  awk 'BEGIN { IGNORECASE=1 } /^Docker-Content-Digest:/ { gsub("\\r", "", $2); print $2; exit }' "$headers_file"
}

if [ -s "$cleanup_queue" ]; then
  while IFS=$'\t' read -r repository_name digest commit; do
    if is_protected_digest "$digest"; then
      printf '%s\t%s\t%s\n' "$repository_name" "$digest" "$commit" >> "$retained_queue"
      log "Keeping Release-protected digest $repository_name@$digest."
    elif latest_digest=$(manifest_digest "$repository_name" latest) && [ "$digest" != "$latest_digest" ]; then
      printf '%s\t%s\t%s\n' "$repository_name" "replaced-$commit" "$digest" >> "$delete_digests"
    else
      printf '%s\t%s\t%s\n' "$repository_name" "$digest" "$commit" >> "$retained_queue"
    fi
  done < "$cleanup_queue"
fi

for image_name in web-api engine pdf-parser jit-engine posting-service tax-engine reviewroom; do
  repository_name=daejang/$image_name
  if ! latest_digest=$(manifest_digest "$repository_name" latest); then
    log "$repository_name has no readable latest manifest; legacy tag cleanup was skipped."
    continue
  fi
  tags_json=$(curl --config "$curl_config" "$registry_url/v2/$repository_name/tags/list?n=10000")
  while IFS= read -r tag; do
    [ -n "$tag" ] || continue
    if digest=$(manifest_digest "$repository_name" "$tag") && [ "$digest" != "$latest_digest" ]; then
      if is_protected_digest "$digest"; then
        log "Keeping Release-protected tag $repository_name:$tag at $digest."
      else
        printf '%s\t%s\t%s\n' "$repository_name" "$tag" "$digest" >> "$delete_digests"
      fi
    fi
  done < <(jq -r '.tags[]? | select(startswith("sha-"))' <<< "$tags_json")
done

sort -u -k1,1 -k3,3 "$delete_digests" -o "$delete_digests"
if [ -s "$delete_digests" ]; then
  while IFS=$'\t' read -r repository_name tag digest; do
    if [ "$dry_run" = true ]; then
      log "Would delete legacy tag $repository_name:$tag at $digest."
    else
      log "Deleting legacy tag $repository_name:$tag at $digest."
      curl --config "$curl_config" --request DELETE --output /dev/null \
        "$registry_url/v2/$repository_name/manifests/$digest"
    fi
  done < "$delete_digests"
else
  log "No legacy sha manifest is eligible for deletion."
fi

if [ "$dry_run" = false ]; then
  queue_tmp=$(mktemp "$cleanup_root/.pending.tsv.XXXXXX")
  if [ -s "$retained_queue" ]; then
    sort -u "$retained_queue" > "$queue_tmp"
  else
    : > "$queue_tmp"
  fi
  chmod 600 "$queue_tmp"
  mv "$queue_tmp" "$cleanup_queue"
fi

before_kib=$(du -sk "$REGISTRY_DATA_DIR" | awk '{print $1}')
if [ "$dry_run" = true ]; then
  log "Running garbage collection dry-run."
  "$compose_command" --env-file "$registry_dir/.env" -f "$registry_dir/compose.yaml" \
    exec -T registry registry garbage-collect --dry-run /etc/distribution/config.yml
  log "Cleanup dry-run completed; no data was deleted."
  exit 0
fi

log "Stopping the Registry for garbage collection."
"$compose_command" --env-file "$registry_dir/.env" -f "$registry_dir/compose.yaml" stop registry >/dev/null
registry_stopped=true
"$compose_command" --env-file "$registry_dir/.env" -f "$registry_dir/compose.yaml" \
  run --rm --no-deps registry garbage-collect /etc/distribution/config.yml
"$compose_command" --env-file "$registry_dir/.env" -f "$registry_dir/compose.yaml" up -d registry >/dev/null
registry_stopped=false
after_kib=$(du -sk "$REGISTRY_DATA_DIR" | awk '{print $1}')
log "Cleanup completed: ${before_kib} KiB before, ${after_kib} KiB after."
