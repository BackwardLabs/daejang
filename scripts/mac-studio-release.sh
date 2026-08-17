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
RELEASE_ROOT="${GIWA_RELEASE_ROOT:-$DAEJANG_ROOT/releases}"
PUBLISHER_STATE_FILE="${DAEJANG_PUBLISHER_STATE_FILE:-/Users/Shared/DaejangRegistry/publisher/state.json}"
PROMOTION_LOCK_DIR="$RELEASE_ROOT/.promotion.lock"
MANIFEST_TOOL="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/release-manifest.mjs"
# ReviewRoom 은 production compose 파일 하나에 통합되었다 (#186).
REVIEWROOM_COMPOSE_FILE="${REVIEWROOM_COMPOSE_FILE:-$DAEJANG_ROOT/daejang/deploy/compose.production.yaml}"
# Follow the existing Mac Studio deployment convention: private deployment env
# files live in their ignored locations inside the shared deployment checkout.
# This supplies only Compose interpolation values and paths to the
# least-privilege workload env files; the manifest always supplies
# REVIEWROOM_IMAGE_REF itself.
REVIEWROOM_DEPLOY_ENV_FILE="${REVIEWROOM_DEPLOY_ENV_FILE:-$DAEJANG_ROOT/daejang/deploy/reviewroom.env}"

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
usage: scripts/mac-studio-release.sh <command> [arguments]

  status
      Show Production checkout state and current/previous Release pointers.
  preflight
      Verify clean repositories, expected origins and GitHub access without moving HEAD.
  prepare <release-id> [--publisher-main] [repository=commit ...]
      Create a candidate manifest. Existing Production commits are the baseline.
  verify <release-id>
      Verify immutable images and run the candidate system E2E in temporary worktrees.
  promote <release-id>
      Checkout the approved commits, deploy them and atomically move current/previous.
  rollback
      Restore the source commits and Release pointer captured by the last promotion.

Legacy restart commands deploy-indexer, deploy-backend and deploy never pull main.
The old sync command is intentionally disabled; Production moves only through promote.
EOF
}

docker_compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
    return
  fi
  if command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
    return
  fi
  echo "Docker Compose is required (docker compose or docker-compose)" >&2
  return 1
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
  local name="$1" directory="$2" slug="$3" origin dirty
  git -C "$directory" rev-parse --git-dir >/dev/null 2>&1 \
    || { echo "$name: missing Git checkout at $directory" >&2; return 1; }
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
    || { echo "$name: Production HEAD is not contained in origin/main" >&2; return 1; }
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
  command -v forge >/dev/null
  command -v anvil >/dev/null
  command -v cast >/dev/null
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
  docker_compose version >/dev/null
  [[ -r "$REVIEWROOM_COMPOSE_FILE" ]] \
    || { echo "ReviewRoom Compose file is missing: $REVIEWROOM_COMPOSE_FILE" >&2; return 1; }
  [[ -r "$REVIEWROOM_DEPLOY_ENV_FILE" ]] \
    || { echo "ReviewRoom deployment env file is missing: $REVIEWROOM_DEPLOY_ENV_FILE" >&2; return 1; }
  reviewroom_compose \
    "registry.invalid/daejang/reviewroom@sha256:0000000000000000000000000000000000000000000000000000000000000000" \
    config --quiet
  reviewroom_compose \
    "registry.invalid/daejang/reviewroom@sha256:0000000000000000000000000000000000000000000000000000000000000000" \
    --profile migrate config --quiet
  for_each_repository assert_repository
  for_each_repository fetch_repository
  for_each_repository assert_fast_forward
  echo "preflight passed"
}

sync_sources() {
  echo "sync is disabled: create and promote an explicit Release instead" >&2
  return 2
}

sync_backend_sources() {
  echo "backend source sync is disabled: use an explicit Release" >&2
  return 2
}

sync_indexer_source() {
  echo "indexer source sync is disabled: use an explicit Release" >&2
  return 2
}

release_directory() {
  local release_id="$1"
  [[ "$release_id" =~ ^[0-9]{8}(-[a-z0-9][a-z0-9.-]*)?$ ]] \
    || { echo "invalid Release ID: $release_id" >&2; return 2; }
  printf '%s/%s\n' "$RELEASE_ROOT" "$release_id"
}

current_release_target() {
  local pointer="$RELEASE_ROOT/current"
  if [[ -L "$pointer" ]]; then
    python3 - "$pointer" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
  fi
}

assert_checkouts_match_manifest() {
  local manifest_file="$1" entry name directory slug expected actual
  [[ -r "$manifest_file" ]] || return 0
  for entry in "${repositories[@]}"; do
    IFS='|' read -r name directory slug <<<"$entry"
    expected="$(jq -r --arg name "$name" '.sources[$name] // empty' "$manifest_file")"
    actual="$(git -C "$directory" rev-parse HEAD)"
    [[ -n "$expected" && "$actual" == "$expected" ]] \
      || { echo "$name: Production HEAD $actual does not match current Release $expected" >&2; return 1; }
  done
}

assert_checkouts_match_current_release() {
  local current_target
  current_target="$(current_release_target)"
  [[ -n "$current_target" ]] || return 0
  assert_checkouts_match_manifest "$current_target/release.json"
}

acquire_promotion_lock() {
  mkdir -p "$RELEASE_ROOT"
  if mkdir "$PROMOTION_LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$PROMOTION_LOCK_DIR/pid"
    return
  fi
  local existing_pid=''
  [[ -r "$PROMOTION_LOCK_DIR/pid" ]] && existing_pid="$(sed -n '1p' "$PROMOTION_LOCK_DIR/pid")"
  if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" 2>/dev/null; then
    echo "another Release operation is active as PID $existing_pid" >&2
    return 1
  fi
  find "$PROMOTION_LOCK_DIR" -depth -delete 2>/dev/null || true
  mkdir "$PROMOTION_LOCK_DIR"
  printf '%s\n' "$$" > "$PROMOTION_LOCK_DIR/pid"
}

release_promotion_lock() {
  if [[ -r "$PROMOTION_LOCK_DIR/pid" ]] && [[ "$(sed -n '1p' "$PROMOTION_LOCK_DIR/pid")" == "$$" ]]; then
    find "$PROMOTION_LOCK_DIR" -depth -delete 2>/dev/null || true
  fi
}

prepare_release() {
  local release_id="${1:-}"
  shift || true
  assert_deploy_user
  command -v git >/dev/null
  command -v node >/dev/null
  command -v jq >/dev/null
  [[ -r "$PUBLISHER_STATE_FILE" ]] \
    || { echo "missing Publisher state: $PUBLISHER_STATE_FILE" >&2; return 1; }
  for_each_repository assert_repository
  assert_checkouts_match_current_release
  for_each_repository fetch_repository
  GIWA_DAEJANG_ROOT="$DAEJANG_ROOT" GIWA_RELEASE_ROOT="$RELEASE_ROOT" \
    DAEJANG_PUBLISHER_STATE_FILE="$PUBLISHER_STATE_FILE" \
    node "$MANIFEST_TOOL" prepare "$release_id" "$@"
}

validate_release_images() {
  local release_dir="$1" image_name ref expected_commit revision
  while IFS=$'\t' read -r image_name ref expected_commit; do
    echo "$image_name: pulling $ref"
    docker pull "$ref" >/dev/null
    revision="$(docker image inspect \
      --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
      "$ref")"
    [[ "$revision" == "$expected_commit" ]] \
      || { echo "$image_name: image revision $revision does not match $expected_commit" >&2; return 1; }
  done < <(jq -r '.images | to_entries[] | [.key, .value.ref, .value.commit] | @tsv' \
    "$release_dir/images.lock.json")
}

reviewroom_image_reference() {
  local release_dir="$1" image_ref
  image_ref="$(jq -er '.images.reviewroom.ref' "$release_dir/images.lock.json")" \
    || { echo "ReviewRoom image is missing from $(basename "$release_dir")" >&2; return 1; }
  [[ "$image_ref" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]] \
    || { echo "ReviewRoom image is not an immutable digest reference: $image_ref" >&2; return 1; }
  printf '%s\n' "$image_ref"
}

reviewroom_compose() {
  local image_ref="$1"
  shift
  [[ -r "$REVIEWROOM_COMPOSE_FILE" ]] \
    || { echo "ReviewRoom Compose file is missing: $REVIEWROOM_COMPOSE_FILE" >&2; return 1; }
  [[ -r "$REVIEWROOM_DEPLOY_ENV_FILE" ]] \
    || { echo "ReviewRoom deployment env file is missing: $REVIEWROOM_DEPLOY_ENV_FILE" >&2; return 1; }

  # 통합 compose(#186)는 파일 전체를 인터폴레이션하므로 production env 와
  # 버전(images.env)도 함께 필요하다. 프로젝트도 통합 프로젝트(daejang)다 —
  # 별도 프로젝트명을 쓰면 reviewroom 컨테이너가 이중으로 생긴다.
  # A process environment value takes precedence over --env-file. This keeps a
  # stale or accidental REVIEWROOM_IMAGE_REF in the private file from moving a
  # verified Release to another image.
  local images_env="${DAEJANG_IMAGES_ENV_FILE:-/Users/Shared/DaejangRelease/images.env}"
  [[ -r "$images_env" ]] \
    || { echo "release images env file is missing: $images_env (compose-env.sh 로 생성)" >&2; return 1; }
  REVIEWROOM_IMAGE_REF="$image_ref" docker_compose \
    --env-file "$DAEJANG_ROOT/daejang/deploy/production.env" \
    --env-file "$REVIEWROOM_DEPLOY_ENV_FILE" \
    --env-file "$images_env" \
    --project-directory "$DAEJANG_ROOT/daejang" \
    --project-name daejang \
    --file "$REVIEWROOM_COMPOSE_FILE" "$@"
}

verification_worktree() {
  local release_dir="$1" verify_root="$2" name="$3" entry directory slug commit
  entry="$(find_repository "$name")"
  IFS='|' read -r _ directory slug <<<"$entry"
  commit="$(jq -r --arg name "$name" '.sources[$name]' "$release_dir/release.json")"
  git -C "$directory" worktree add --detach "$verify_root/$name" "$commit" >/dev/null
}

remove_verification_worktrees() {
  local verify_root="$1" name entry directory slug
  for name in daejang daejang-db daejang-jit-engine daejang-posting-service daejang-reviewroom daejang-tax-engine schema; do
    entry="$(find_repository "$name")"
    IFS='|' read -r _ directory slug <<<"$entry"
    if [[ -e "$verify_root/$name/.git" ]]; then
      git -C "$directory" worktree remove --force "$verify_root/$name" >/dev/null 2>&1 || true
    fi
  done
  [[ -d "$verify_root" ]] && find "$verify_root" -depth -delete 2>/dev/null || true
}

allocate_loopback_port() {
  node -e '
    const net = require("node:net")
    const server = net.createServer()
    server.listen(0, "127.0.0.1", () => {
      process.stdout.write(String(server.address().port))
      server.close()
    })
  '
}

run_reviewroom_release_e2e() {
  local reviewroom_dir="$1" runtime_dir postgres_container anvil_log anvil_pid=''
  local postgres_port anvil_port database_url rpc_url
  command -v anvil >/dev/null
  command -v cast >/dev/null
  command -v forge >/dev/null
  [[ -f "$reviewroom_dir/package-lock.json" ]] \
    || { echo "ReviewRoom release worktree is incomplete: $reviewroom_dir" >&2; return 1; }

  runtime_dir="$(mktemp -d "$RELEASE_ROOT/.reviewroom-e2e.XXXXXX")"
  postgres_container="reviewroom-release-e2e-${$}-${RANDOM}"
  anvil_log="$runtime_dir/anvil.log"
  cleanup_reviewroom_release_e2e() {
    local status=$?
    trap - EXIT
    if [[ -n "$anvil_pid" ]] && kill -0 "$anvil_pid" >/dev/null 2>&1; then
      kill "$anvil_pid" >/dev/null 2>&1 || true
      wait "$anvil_pid" >/dev/null 2>&1 || true
    fi
    docker stop "$postgres_container" >/dev/null 2>&1 || true
    find "$runtime_dir" -depth -delete >/dev/null 2>&1 || true
    return "$status"
  }
  trap cleanup_reviewroom_release_e2e EXIT

  docker run --detach --rm --name "$postgres_container" \
    --publish 127.0.0.1::5432 \
    --env POSTGRES_DB=reviewroom \
    --env POSTGRES_USER=reviewroom \
    --env POSTGRES_PASSWORD=reviewroom \
    postgres:18.4-alpine3.24 >/dev/null
  for _ in $(seq 1 30); do
    if docker exec "$postgres_container" pg_isready -U reviewroom -d reviewroom >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  docker exec "$postgres_container" pg_isready -U reviewroom -d reviewroom >/dev/null
  postgres_port="$(docker port "$postgres_container" 5432/tcp | sed -n '1s/.*://p')"
  [[ "$postgres_port" =~ ^[0-9]+$ ]] \
    || { echo "ReviewRoom E2E could not determine the temporary PostgreSQL port" >&2; return 1; }

  anvil_port="$(allocate_loopback_port)"
  anvil --host 127.0.0.1 --port "$anvil_port" >"$anvil_log" 2>&1 &
  anvil_pid=$!
  for _ in $(seq 1 30); do
    if cast chain-id --rpc-url "http://127.0.0.1:$anvil_port" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  if ! cast chain-id --rpc-url "http://127.0.0.1:$anvil_port" >/dev/null 2>&1; then
    cat "$anvil_log" >&2
    return 1
  fi

  database_url="postgres://reviewroom:reviewroom@127.0.0.1:${postgres_port}/reviewroom?sslmode=disable"
  rpc_url="http://127.0.0.1:$anvil_port"
  npm --prefix "$reviewroom_dir" ci
  DATABASE_URL="$database_url" E2E_RPC_URL="$rpc_url" \
    npm --prefix "$reviewroom_dir" run test:e2e:canonical

  trap - EXIT
  cleanup_reviewroom_release_e2e
}

run_release_system_e2e() {
  local release_dir="$1" verify_root posting_ref reviewroom_ref tax_ref tax_fixture_ref registry_host
  verify_root="$(mktemp -d "$RELEASE_ROOT/.verify-$(basename "$release_dir").XXXXXX")"
  cleanup_release_verification() {
    remove_verification_worktrees "$verify_root"
  }
  trap cleanup_release_verification RETURN

  local name
  for name in daejang daejang-db daejang-jit-engine daejang-posting-service daejang-reviewroom daejang-tax-engine schema; do
    verification_worktree "$release_dir" "$verify_root" "$name"
  done

  posting_ref="$(jq -r '.images["posting-service"].ref' "$release_dir/images.lock.json")"
  reviewroom_ref="$(reviewroom_image_reference "$release_dir")"
  tax_ref="$(jq -r '.images["tax-engine"].ref' "$release_dir/images.lock.json")"
  tax_fixture_ref="$(jq -r '.images["tax-engine-dev-e2e"].ref' "$release_dir/images.lock.json")"
  registry_host="${posting_ref%%/*}"

  DAEJANG_POSTING_IMAGE="$posting_ref" \
  DAEJANG_TAX_ENGINE_IMAGE="$tax_ref" \
  DAEJANG_TAX_DEV_E2E_IMAGE="$tax_fixture_ref" \
    make -C "$verify_root/daejang" test \
      DAEJANG_DB_DIR="$verify_root/daejang-db" REGISTRY="$registry_host"

  make -C "$verify_root/daejang-posting-service" test \
    DAEJANG_DB_DIR="$verify_root/daejang-db" REGISTRY="$registry_host"
  make -C "$verify_root/daejang-jit-engine" test \
    DAEJANG_DB_DIR="$verify_root/daejang-db" \
    SCHEMA_DIR="$verify_root/schema" REGISTRY="$registry_host" \
    POSTING_IMAGE="$posting_ref"
  make -C "$verify_root/daejang-tax-engine" test \
    DAEJANG_DB_DIR="$verify_root/daejang-db" REGISTRY="$registry_host" \
    POSTING_IMAGE="$posting_ref"
  echo "ReviewRoom canonical E2E: $reviewroom_ref"
  run_reviewroom_release_e2e "$verify_root/daejang-reviewroom"

  trap - RETURN
  cleanup_release_verification
}

verify_release() {
  local release_id="${1:-}" release_dir manifest_digest temporary
  assert_deploy_user
  command -v docker >/dev/null
  command -v jq >/dev/null
  command -v node >/dev/null
  release_dir="$(release_directory "$release_id")"
  [[ -d "$release_dir" ]] || { echo "Release not found: $release_dir" >&2; return 1; }
  manifest_digest="$(GIWA_DAEJANG_ROOT="$DAEJANG_ROOT" GIWA_RELEASE_ROOT="$RELEASE_ROOT" \
    node "$MANIFEST_TOOL" validate "$release_dir")"
  validate_release_images "$release_dir"
  run_release_system_e2e "$release_dir"

  temporary="$release_dir/.verification.json.$$"
  jq -n \
    --arg verifiedAt "$(date -u +%FT%TZ)" \
    --arg manifestDigest "$manifest_digest" \
    '{schemaVersion: 1, status: "passed", verifiedAt: $verifiedAt,
      manifestDigest: $manifestDigest,
      checks: ["immutable-images", "daejang-system-e2e", "posting-e2e", "jit-e2e", "tax-e2e", "reviewroom-canonical-e2e"]}' \
    > "$temporary"
  chmod 660 "$temporary"
  mv "$temporary" "$release_dir/verification.json"
  echo "Release $release_id verification passed."
}

capture_repository_heads() {
  local target="$1" entry name directory slug
  : > "$target"
  for entry in "${repositories[@]}"; do
    IFS='|' read -r name directory slug <<<"$entry"
    printf '%s\t%s\n' "$name" "$(git -C "$directory" rev-parse HEAD)" >> "$target"
  done
}

checkout_repository_set() {
  local source_file="$1" entry name directory slug commit
  for entry in "${repositories[@]}"; do
    IFS='|' read -r name directory slug <<<"$entry"
    commit="$(jq -r --arg name "$name" '.sources[$name]' "$source_file")"
    [[ "$commit" =~ ^[0-9a-f]{40}$ ]] \
      || { echo "$name: missing commit in $source_file" >&2; return 1; }
    git -C "$directory" cat-file -e "$commit^{commit}"
    git -C "$directory" switch --detach "$commit" >/dev/null
    echo "$name: ${commit:0:12}"
  done
}

restore_repository_heads() {
  local state_file="$1" name commit entry directory slug
  while IFS=$'\t' read -r name commit; do
    entry="$(find_repository "$name")"
    IFS='|' read -r _ directory slug <<<"$entry"
    git -C "$directory" switch --detach "$commit" >/dev/null || return 1
  done < "$state_file"
}

atomic_release_link() {
  local link_name="$1" target="$2" temporary="$RELEASE_ROOT/.$link_name.$$"
  [[ "$target" == "$RELEASE_ROOT/"* ]] \
    || { echo "refusing Release pointer outside $RELEASE_ROOT: $target" >&2; return 1; }
  ln -s "$target" "$temporary"
  mv -f "$temporary" "$RELEASE_ROOT/$link_name"
}

assert_release_verified() {
  local release_dir="$1" expected actual status
  expected="$(GIWA_DAEJANG_ROOT="$DAEJANG_ROOT" GIWA_RELEASE_ROOT="$RELEASE_ROOT" \
    node "$MANIFEST_TOOL" validate "$release_dir")"
  status="$(jq -r '.status // empty' "$release_dir/verification.json")"
  actual="$(jq -r '.manifestDigest // empty' "$release_dir/verification.json")"
  [[ "$status" == passed && "$actual" == "$expected" ]] \
    || { echo "Release verification is missing or stale: $(basename "$release_dir")" >&2; return 1; }
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
  for_each_repository assert_repository
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

deploy_reviewroom() {
  local release_dir="$1" image_ref
  command -v docker >/dev/null
  docker_compose version >/dev/null
  image_ref="$(reviewroom_image_reference "$release_dir")"

  # config is a fail-closed check for the private Compose interpolation file
  # and all workload-specific secret-file paths. It emits no resolved secrets.
  reviewroom_compose "$image_ref" config --quiet
  reviewroom_compose "$image_ref" --profile migrate config --quiet
  reviewroom_compose "$image_ref" pull reviewroom-postgres reviewroom-api reviewroom-anchor-worker reviewroom-delivery-worker
  reviewroom_compose "$image_ref" up --detach reviewroom-postgres
  reviewroom_compose "$image_ref" run --rm reviewroom-migrate
  reviewroom_compose "$image_ref" up --detach --wait reviewroom-api reviewroom-anchor-worker reviewroom-delivery-worker
  reviewroom_compose "$image_ref" ps
}

stop_reviewroom() {
  local release_dir="$1" image_ref
  image_ref="$(reviewroom_image_reference "$release_dir")"
  # Never remove the named database volume during a failed first deployment or
  # a source rollback. Migration/data recovery is a separately approved task.
  # down 금지: 통합 compose 에서 down 은 web-api·engine 까지 전부 내린다.
  reviewroom_compose "$image_ref" stop reviewroom-api reviewroom-anchor-worker reviewroom-delivery-worker reviewroom-postgres
  reviewroom_compose "$image_ref" rm -f reviewroom-api reviewroom-anchor-worker reviewroom-delivery-worker reviewroom-postgres
}

deploy_backend() {
  assert_deploy_user
  for_each_backend_repository assert_repository
  npm --prefix "$DAEJANG_ROOT/daejang" ci
  restart_backend_with_migrations
  record_backend_repository_set "$BACKEND_DEPLOYED_STATE_FILE" deployed_at
}

deploy_all() {
  local release_dir="$1"
  [[ -d "$release_dir" ]] || { echo "Release directory is required for deployment" >&2; return 1; }
  assert_deploy_user
  for_each_repository assert_repository
  npm --prefix "$DAEJANG_ROOT/daejang" ci
  restart_indexer
  restart_backend_with_migrations
  deploy_reviewroom "$release_dir"
  record_deployed_state
}

promote_release() {
  local release_id="${1:-}" release_dir old_heads previous_target rollback_tmp
  local checkout_started=false deployment_started=false
  assert_deploy_user
  command -v git >/dev/null
  command -v jq >/dev/null
  command -v node >/dev/null
  release_dir="$(release_directory "$release_id")"
  [[ -d "$release_dir" ]] || { echo "Release not found: $release_dir" >&2; return 1; }
  assert_release_verified "$release_dir"
  for_each_repository assert_repository
  assert_checkouts_match_current_release
  for_each_repository fetch_repository
  acquire_promotion_lock
  trap release_promotion_lock RETURN

  old_heads="$(mktemp "$RELEASE_ROOT/.pre-promotion-heads.XXXXXX")"
  capture_repository_heads "$old_heads"
  previous_target="$(current_release_target)"
  rollback_tmp="$release_dir/.rollback.json.$$"
  jq -Rn \
    --arg capturedAt "$(date -u +%FT%TZ)" \
    --arg previousTarget "$previous_target" \
    '[inputs | split("\t") | {key: .[0], value: .[1]}] | from_entries |
      {schemaVersion: 1, capturedAt: $capturedAt, previousTarget: $previousTarget, sources: .}' \
    < "$old_heads" > "$rollback_tmp"
  chmod 660 "$rollback_tmp"
  mv "$rollback_tmp" "$release_dir/rollback.json"

  rollback_failed_promotion() {
    local status=$?
    trap - ERR
    if [[ "$checkout_started" == true ]]; then
      echo "Promotion failed; restoring previous Production commits." >&2
      restore_repository_heads "$old_heads" || true
      if [[ "$deployment_started" == true ]]; then
        if [[ -n "$previous_target" ]]; then
          deploy_all "$previous_target" || true
        else
          npm --prefix "$DAEJANG_ROOT/daejang" ci || true
          restart_indexer || true
          restart_backend_with_migrations || true
          stop_reviewroom "$release_dir" || true
        fi
      fi
    fi
    find "$old_heads" -delete 2>/dev/null || true
    release_promotion_lock
    return "$status"
  }
  trap rollback_failed_promotion ERR

  checkout_started=true
  checkout_repository_set "$release_dir/release.json"
  deployment_started=true
  deploy_all "$release_dir"

  if [[ -n "$previous_target" ]]; then
    atomic_release_link previous "$previous_target"
  fi
  atomic_release_link current "$release_dir"
  jq -n \
    --arg deployedAt "$(date -u +%FT%TZ)" \
    --arg deployedBy "$(id -un)" \
    '{schemaVersion: 1, status: "deployed", deployedAt: $deployedAt, deployedBy: $deployedBy}' \
    > "$release_dir/deployment.json"
  chmod 660 "$release_dir/deployment.json"

  trap - ERR
  find "$old_heads" -delete
  release_promotion_lock
  echo "Release $release_id is now Production."
}

rollback_release() {
  local active_dir rollback_file previous_target active_target current_heads
  local checkout_started=false
  assert_deploy_user
  acquire_promotion_lock
  trap release_promotion_lock RETURN
  active_dir="$(current_release_target)"
  [[ -n "$active_dir" ]] || { release_promotion_lock; echo "current Release pointer is missing" >&2; return 1; }
  rollback_file="$active_dir/rollback.json"
  [[ -r "$rollback_file" ]] \
    || { release_promotion_lock; echo "Rollback metadata is missing: $rollback_file" >&2; return 1; }
  previous_target="$(jq -r '.previousTarget // empty' "$rollback_file")"
  [[ -d "$previous_target" && "$previous_target" == "$RELEASE_ROOT/"* ]] \
    || { release_promotion_lock; echo "previous Release target is invalid: $previous_target" >&2; return 1; }
  for_each_repository assert_repository
  assert_checkouts_match_manifest "$active_dir/release.json"
  current_heads="$(mktemp "$RELEASE_ROOT/.pre-rollback-heads.XXXXXX")"
  capture_repository_heads "$current_heads"

  rollback_failed_rollback() {
    local status=$?
    trap - ERR
    if [[ "$checkout_started" == true ]]; then
      echo "Rollback failed; restoring the active Release commits." >&2
      restore_repository_heads "$current_heads" || true
      deploy_all "$active_dir" || true
    fi
    find "$current_heads" -delete 2>/dev/null || true
    release_promotion_lock
    return "$status"
  }
  trap rollback_failed_rollback ERR

  checkout_started=true
  checkout_repository_set "$rollback_file"
  deploy_all "$previous_target"
  active_target="$active_dir"
  atomic_release_link current "$previous_target"
  atomic_release_link previous "$active_target"

  trap - ERR
  find "$current_heads" -delete
  release_promotion_lock
  echo "Production rolled back to $(basename "$previous_target")."
}

show_release_pointers() {
  local pointer target
  echo
  for pointer in current previous; do
    if [[ -L "$RELEASE_ROOT/$pointer" ]]; then
      target="$(python3 - "$RELEASE_ROOT/$pointer" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
)"
      printf '%-10s %s\n' "$pointer" "$target"
    else
      printf '%-10s %s\n' "$pointer" missing
    fi
  done
}

case "${1:-}" in
  status) for_each_repository show_repository; show_release_pointers; show_recorded_state ;;
  preflight) preflight ;;
  sync) sync_sources ;;
  prepare) shift; prepare_release "$@" ;;
  verify) shift; verify_release "$@" ;;
  promote) shift; promote_release "$@" ;;
  rollback) rollback_release ;;
  deploy-indexer) deploy_indexer ;;
  deploy-backend) deploy_backend ;;
  deploy)
    current_release="$(current_release_target)"
    [[ -n "$current_release" ]] || { echo "current Release pointer is missing" >&2; exit 1; }
    deploy_all "$current_release"
    ;;
  *) usage >&2; exit 2 ;;
esac
