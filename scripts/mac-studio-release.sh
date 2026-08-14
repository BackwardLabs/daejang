#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

DAEJANG_ROOT="${GIWA_DAEJANG_ROOT:-/Users/Shared/Projects/01_Daejang}"
INDEXER_DIR="${GIWA_EVM_INDEXER_DIR:-/Users/Shared/Projects/01_Daejang/evm-indexer}"
DEPLOY_USER="${GIWA_DEPLOY_USER:-backwardlabs}"
RUNTIME_ROOT="${GIWA_RUNTIME_ROOT:-$HOME/Library/Application Support/GIWA/production}"
SOURCE_STATE_FILE="$RUNTIME_ROOT/source-checkouts.tsv"
DEPLOYED_STATE_FILE="$RUNTIME_ROOT/deployed-release.tsv"
BACKEND_SOURCE_STATE_FILE="$RUNTIME_ROOT/backend-source-checkouts.tsv"
BACKEND_DEPLOYED_STATE_FILE="$RUNTIME_ROOT/backend-deployed-release.tsv"
INDEXER_STATE_FILE="$RUNTIME_ROOT/evm-indexer-deployed.tsv"

repositories=(
  "evm-indexer|$INDEXER_DIR|BackwardLabs/daejang-evm-indexer"
  "DeFi-Label|$DAEJANG_ROOT/DeFi-Label|BackwardLabs/DeFi-Label"
  "daejang|$DAEJANG_ROOT/daejang|BackwardLabs/daejang"
  "daejang-db|$DAEJANG_ROOT/daejang-db|BackwardLabs/daejang-db"
  "daejang-jit-engine|$DAEJANG_ROOT/daejang-jit-engine|BackwardLabs/daejang-jit-engine"
  "daejang-posting-service|$DAEJANG_ROOT/daejang-posting-service|BackwardLabs/daejang-posting-service"
  "daejang-reviewroom|$DAEJANG_ROOT/daejang-reviewroom|BackwardLabs/daejang-reviewroom"
  "daejang-tax-engine|$DAEJANG_ROOT/daejang-tax-engine|BackwardLabs/daejang-tax-engine"
  "pdf-parser|$DAEJANG_ROOT/pdf-parser|BackwardLabs/pdf-parser"
  "schema|$DAEJANG_ROOT/schema|BackwardLabs/schema"
)

usage() {
  cat <<'EOF'
usage: scripts/mac-studio-release.sh status|preflight|sync|deploy-indexer|deploy-backend|deploy

  status          Show checkout state and the last recorded deployed release.
  preflight       Verify deploy user, repository identity, main branch, clean state and GitHub access.
  sync            Fast-forward every deployment checkout to GitHub main and record exact commits.
  deploy-indexer  Sync, build and restart only the EVM bulk indexer.
  deploy-backend  Sync and restart only the Daejang backend, leaving an in-progress indexer checkout untouched.
  deploy          Sync, deploy the indexer, restart the Daejang backend and print final status.
EOF
}

for_each_repository() {
  local callback="$1" entry name directory slug
  for entry in "${repositories[@]}"; do
    IFS='|' read -r name directory slug <<<"$entry"
    "$callback" "$name" "$directory" "$slug"
  done
}

for_each_backend_repository() {
  local callback="$1" entry name directory slug
  for entry in "${repositories[@]}"; do
    IFS='|' read -r name directory slug <<<"$entry"
    [[ "$name" == evm-indexer ]] && continue
    "$callback" "$name" "$directory" "$slug"
  done
}

assert_deploy_user() {
  if [[ "$(id -un)" != "$DEPLOY_USER" ]]; then
    echo "run as deploy user $DEPLOY_USER, not $(id -un)" >&2
    exit 1
  fi
}

assert_repository() {
  local name="$1" directory="$2" slug="$3" branch origin dirty
  [[ -d "$directory/.git" ]] || { echo "$name: missing clone at $directory" >&2; return 1; }
  branch="$(git -C "$directory" branch --show-current)"
  [[ "$branch" == main ]] || { echo "$name: deployment checkout must stay on main (found $branch)" >&2; return 1; }
  dirty="$(git -C "$directory" status --porcelain --untracked-files=normal)"
  [[ -z "$dirty" ]] || { echo "$name: deployment checkout is dirty" >&2; return 1; }
  origin="$(git -C "$directory" remote get-url origin)"
  case "$origin" in
    "https://github.com/$slug"|"https://github.com/$slug.git"|"git@github.com:$slug"|"git@github.com:$slug.git") ;;
    *) echo "$name: unexpected origin $origin" >&2; return 1 ;;
  esac
}

show_repository() {
  local name="$1" directory="$2" slug="$3" branch head state
  if [[ ! -d "$directory/.git" ]]; then
    printf '%-26s missing  %s\n' "$name" "$directory"
    return
  fi
  branch="$(git -C "$directory" branch --show-current)"
  head="$(git -C "$directory" rev-parse --short=12 HEAD)"
  state=clean
  [[ -z "$(git -C "$directory" status --porcelain --untracked-files=normal)" ]] || state=dirty
  printf '%-26s %-12s branch=%-12s state=%s\n' "$name" "$head" "${branch:-detached}" "$state"
}

fetch_repository() {
  local name="$1" directory="$2" slug="$3"
  echo "$name: fetching origin/main"
  GIT_TERMINAL_PROMPT=0 git -C "$directory" fetch --prune origin main
}

find_repository() {
  local wanted="$1" entry name directory slug
  for entry in "${repositories[@]}"; do
    IFS='|' read -r name directory slug <<<"$entry"
    if [[ "$name" == "$wanted" ]]; then
      printf '%s|%s|%s\n' "$name" "$directory" "$slug"
      return 0
    fi
  done
  echo "unknown repository: $wanted" >&2
  return 1
}

assert_fast_forward() {
  local name="$1" directory="$2" slug="$3"
  git -C "$directory" show-ref --verify --quiet refs/remotes/origin/main \
    || { echo "$name: origin/main was not fetched" >&2; return 1; }
  git -C "$directory" merge-base --is-ancestor HEAD origin/main \
    || { echo "$name: local main diverged from origin/main; refusing deployment" >&2; return 1; }
}

merge_repository() {
  local name="$1" directory="$2" slug="$3"
  git -C "$directory" merge --ff-only origin/main >/dev/null
  echo "$name: $(git -C "$directory" rev-parse --short=12 HEAD)"
}

record_repository_set() {
  local target="$1" timestamp_label="$2" temporary="$1.tmp.$$" entry name directory slug
  mkdir -p "$RUNTIME_ROOT"
  umask 077
  {
    printf '%s\t%s\n' "$timestamp_label" "$(date -u +%FT%TZ)"
    for entry in "${repositories[@]}"; do
      IFS='|' read -r name directory slug <<<"$entry"
      printf '%s\t%s\n' "$name" "$(git -C "$directory" rev-parse HEAD)"
    done
  } >"$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$target"
  echo "repository state recorded at $target"
}

record_source_state() {
  record_repository_set "$SOURCE_STATE_FILE" recorded_at
}

record_deployed_state() {
  record_repository_set "$DEPLOYED_STATE_FILE" deployed_at
}

record_backend_repository_set() {
  local target="$1" timestamp_label="$2" temporary="$1.tmp.$$" entry name directory slug
  mkdir -p "$RUNTIME_ROOT"
  umask 077
  {
    printf '%s\t%s\n' "$timestamp_label" "$(date -u +%FT%TZ)"
    for entry in "${repositories[@]}"; do
      IFS='|' read -r name directory slug <<<"$entry"
      [[ "$name" == evm-indexer ]] && continue
      printf '%s\t%s\n' "$name" "$(git -C "$directory" rev-parse HEAD)"
    done
  } >"$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$target"
  echo "backend repository state recorded at $target"
}

record_component_deployment() {
  local name="$1" directory="$2" target="$3" temporary="$3.tmp.$$"
  mkdir -p "$RUNTIME_ROOT"
  umask 077
  {
    printf 'deployed_at\t%s\n' "$(date -u +%FT%TZ)"
    printf '%s\t%s\n' "$name" "$(git -C "$directory" rev-parse HEAD)"
  } >"$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$target"
  echo "deployed release recorded at $target"
}

show_recorded_state() {
  local state_file
  for state_file in "$SOURCE_STATE_FILE" "$DEPLOYED_STATE_FILE" "$BACKEND_SOURCE_STATE_FILE" "$BACKEND_DEPLOYED_STATE_FILE" "$INDEXER_STATE_FILE"; do
    if [[ -r "$state_file" ]]; then
      echo
      echo "record: $state_file"
      sed 's/^/  /' "$state_file"
    fi
  done
}

preflight_backend() {
  assert_deploy_user
  command -v git >/dev/null
  command -v node >/dev/null
  command -v npm >/dev/null
  command -v go >/dev/null
  command -v docker >/dev/null
  for_each_backend_repository assert_repository
  for_each_backend_repository fetch_repository
  for_each_backend_repository assert_fast_forward
  echo "backend preflight passed"
}

preflight() {
  assert_deploy_user
  command -v git >/dev/null
  command -v node >/dev/null
  command -v npm >/dev/null
  command -v go >/dev/null
  command -v docker >/dev/null
  for_each_repository assert_repository
  for_each_repository fetch_repository
  for_each_repository assert_fast_forward
  echo "preflight passed"
}

sync_sources() {
  preflight
  for_each_repository merge_repository
  record_source_state
}

sync_backend_sources() {
  preflight_backend
  for_each_backend_repository merge_repository
  record_backend_repository_set "$BACKEND_SOURCE_STATE_FILE" recorded_at
}

sync_indexer_source() {
  local entry name directory slug
  entry="$(find_repository evm-indexer)"
  IFS='|' read -r name directory slug <<<"$entry"
  assert_repository "$name" "$directory" "$slug"
  fetch_repository "$name" "$directory" "$slug"
  assert_fast_forward "$name" "$directory" "$slug"
  merge_repository "$name" "$directory" "$slug"
}

restart_indexer() {
  local next="$INDEXER_DIR/bin/evm-indexer.next"
  local current="$INDEXER_DIR/bin/evm-indexer"
  local previous="$INDEXER_DIR/bin/evm-indexer.previous"
  local env_file="${EVM_ENV_FILE:-$INDEXER_DIR/configs/local-nodes.env}"
  local launchd_domain="gui/$(id -u)"
  local launchd_label="io.backwardlabs.evm-indexer-bulk"
  local launchd_plist="$HOME/Library/LaunchAgents/$launchd_label.plist"
  local launchd_was_loaded=0

  start_bulk_runtime() {
    if (( launchd_was_loaded )); then
      launchctl bootstrap "$launchd_domain" "$launchd_plist"
      launchctl print "$launchd_domain/$launchd_label" >/dev/null
      echo "bulk supervisor restored through launchd"
      return
    fi
    "$INDEXER_DIR/scripts/start-bulk-runtime.sh"
  }

  [[ -r "$env_file" ]] || { echo "missing EVM environment: $env_file" >&2; return 1; }
  set -a
  source "$env_file"
  set +a
  export EVM_BULK_INDEX_DIR="${EVM_BULK_INDEX_DIR:-$(dirname "${EVM_INDEXER_DATA_DIR:?set EVM_INDEXER_DATA_DIR}")/index-bulk}"
  (cd "$INDEXER_DIR" && go build -trimpath -o "$next" ./cmd/evm-indexer)
  "$next" profile --config "$INDEXER_DIR/configs/bulk-portal.json" --chain optimism-mainnet-bulk-bedrock >/dev/null
  if [[ -r "$launchd_plist" ]] && launchctl print "$launchd_domain/$launchd_label" >/dev/null 2>&1; then
    launchctl bootout "$launchd_domain" "$launchd_plist"
    launchd_was_loaded=1
    echo "bulk launchd agent stopped for binary replacement"
  fi
  "$INDEXER_DIR/scripts/stop-secret-proxy.sh"
  "$INDEXER_DIR/scripts/stop-bulk-runtime.sh"
  if [[ -x "$current" ]]; then
    mv "$current" "$previous"
  fi
  mv "$next" "$current"
  if ! "$INDEXER_DIR/scripts/start-secret-proxy.sh" || ! start_bulk_runtime; then
    echo "new EVM indexer failed to start; restoring previous binary" >&2
    "$INDEXER_DIR/scripts/stop-secret-proxy.sh" || true
    "$INDEXER_DIR/scripts/stop-bulk-runtime.sh" || true
    if [[ -x "$previous" ]]; then
      mv "$previous" "$current"
      "$INDEXER_DIR/scripts/start-secret-proxy.sh" || true
      start_bulk_runtime || true
    fi
    return 1
  fi
  "$INDEXER_DIR/scripts/status.sh"
  record_component_deployment evm-indexer "$INDEXER_DIR" "$INDEXER_STATE_FILE"
}

deploy_indexer() {
  assert_deploy_user
  command -v git >/dev/null
  command -v go >/dev/null
  sync_indexer_source
  restart_indexer
}

restart_backend_with_migrations() {
  local application="$DAEJANG_ROOT/daejang"
  local database="$DAEJANG_ROOT/daejang-db"

  npm --prefix "$application" run backend:stop
  (cd "$database" && make database-up)
  npm --prefix "$application" run backend:start
  npm --prefix "$application" run backend:status
}

deploy_backend() {
  sync_backend_sources
  npm --prefix "$DAEJANG_ROOT/daejang" ci
  restart_backend_with_migrations
  record_backend_repository_set "$BACKEND_DEPLOYED_STATE_FILE" deployed_at
}

deploy_all() {
  sync_sources
  npm --prefix "$DAEJANG_ROOT/daejang" ci
  restart_indexer
  restart_backend_with_migrations
  record_deployed_state
}

case "${1:-}" in
  status) for_each_repository show_repository; show_recorded_state ;;
  preflight) preflight ;;
  sync) sync_sources ;;
  deploy-indexer) deploy_indexer ;;
  deploy-backend) deploy_backend ;;
  deploy) deploy_all ;;
  *) usage >&2; exit 2 ;;
esac
