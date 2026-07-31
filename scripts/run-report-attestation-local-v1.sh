#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
repo_root="$(CDPATH= cd -- "$script_dir/.." && pwd)"
contracts_source="${GIWA28_CONTRACTS_TARBALL:-${GIWA28_CONTRACTS_ROOT:-}}"
mode="${1:---test}"

if [[ "$#" -gt 1 ]]; then
  echo "Usage: $0 [--test|--serve]" >&2
  exit 2
fi
case "$mode" in
  --test | --serve) ;;
  *)
    echo "Usage: $0 [--test|--serve]" >&2
    exit 2
    ;;
esac

review_outcome=''
api_port=''
web_port=''
if [[ "$mode" == "--serve" ]]; then
  review_outcome="${GIWA28_REVIEW_OUTCOME:-APPROVE}"
  case "$review_outcome" in
    APPROVE | REJECT | MANUAL_REVIEW) ;;
    *)
      echo "GIWA28_REVIEW_OUTCOME must be APPROVE, REJECT, or MANUAL_REVIEW." >&2
      exit 2
      ;;
  esac

  api_port="${GIWA28_API_PORT:-3000}"
  web_port="${GIWA28_WEB_PORT:-5173}"
  for port_value in "$api_port" "$web_port"; do
    if (
      [[ "$port_value" == *[!0-9]* ]] ||
      [[ "$port_value" -lt 1 ]] ||
      [[ "$port_value" -gt 65535 ]]
    ) 2>/dev/null; then
      echo "GIWA28_API_PORT and GIWA28_WEB_PORT must be ports from 1 to 65535." >&2
      exit 2
    fi
  done
  if [[ "$api_port" == "$web_port" ]]; then
    echo "GIWA28_API_PORT and GIWA28_WEB_PORT must be different." >&2
    exit 2
  fi
fi

if [[ -z "$contracts_source" ]]; then
  echo "Set GIWA28_CONTRACTS_ROOT to a contracts package directory or .tgz file." >&2
  exit 2
fi
if [[ "${GIWA28_CONTRACTS_ROOT:-}" != "" && "${GIWA28_CONTRACTS_TARBALL:-}" != "" ]]; then
  echo "Set only one of GIWA28_CONTRACTS_ROOT or GIWA28_CONTRACTS_TARBALL." >&2
  exit 2
fi
if [[ "$contracts_source" != /* ]]; then
  source_parent="$(CDPATH= cd -- "$(dirname -- "$contracts_source")" && pwd)"
  contracts_source="$source_parent/$(basename -- "$contracts_source")"
fi
case "$mode" in
  --test)
    if [[ ! -x "$repo_root/node_modules/.bin/vitest" ]]; then
      echo "Install the Daejang workspace dependencies before running this check." >&2
      exit 2
    fi
    ;;
  --serve)
    if [[ ! -f "$repo_root/node_modules/tsx/dist/loader.mjs" || ! -f "$repo_root/node_modules/vite/bin/vite.js" ]]; then
      echo "Install the Daejang workspace dependencies before running the local demo." >&2
      exit 2
    fi
    if ! command -v curl >/dev/null 2>&1; then
      echo "curl is required to check the local demo processes." >&2
      exit 2
    fi
    ;;
esac

package_namespace="$repo_root/node_modules/@backward-labs"
package_link="$package_namespace/daejang-contracts"
temporary_parent="${TMPDIR:-/tmp}"
temporary_parent="${temporary_parent%/}"
temporary_parent="$(CDPATH= cd -- "$temporary_parent" && pwd -P)"

recover_stale_package_link() {
  if [[ ! -L "$package_link" ]]; then
    if [[ -e "$package_link" ]]; then
      echo "Refusing to replace an existing @backward-labs/daejang-contracts package." >&2
      exit 2
    fi
    return
  fi

  link_target="$(readlink "$package_link")"
  if [[ ! -e "$link_target" ]]; then
    echo "Refusing to remove an unrecognized broken contracts symlink." >&2
    exit 2
  fi
  resolved_target="$(
    CDPATH= cd -- "$(dirname -- "$link_target")" &&
      printf '%s/%s\n' "$(pwd -P)" "$(basename -- "$link_target")"
  )"
  stale_root="${resolved_target%/consumer/node_modules/@backward-labs/daejang-contracts}"
  if (
    [[ "$stale_root" == "$resolved_target" ]] ||
    [[ "$(dirname -- "$stale_root")" != "$temporary_parent" ]] ||
    [[ "$(basename -- "$stale_root")" != giwa28-local-v1.* ]]
  ); then
    echo "Refusing to replace an unrecognized contracts symlink." >&2
    exit 2
  fi

  owner_pid=''
  if [[ -f "$stale_root/owner.pid" ]]; then
    owner_pid="$(sed -n '1p' "$stale_root/owner.pid")"
  fi
  if (
    [[ "$owner_pid" != '' ]] &&
    [[ "$owner_pid" != *[!0-9]* ]] &&
    kill -0 "$owner_pid" 2>/dev/null
  ); then
    echo "Another GIWA-28 local runner still owns the contracts package." >&2
    exit 2
  fi

  unlink "$package_link"
  rm -rf "$stale_root"
  echo "Recovered a stale GIWA-28 local contracts package."
}

recover_stale_package_link

temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/giwa28-local-v1.XXXXXX")"
printf '%s\n' "$$" > "$temporary_root/owner.pid"
before_pids="$temporary_root/anvil-before.txt"
after_pids="$temporary_root/anvil-after.txt"
expected_link_target=''
namespace_created=0
before_snapshot_ready=0
api_pid=''
web_pid=''

snapshot_anvil_pids() {
  ps -axo pid=,command= | awk '$0 ~ /[a]nvil/ { print $1 }' | sort -n
}

child_is_alive() {
  if [[ -z "$1" ]] || ! kill -0 "$1" 2>/dev/null; then
    return 1
  fi
  child_state="$(ps -p "$1" -o stat= 2>/dev/null | awk '{ print $1 }')"
  [[ -n "$child_state" && "$child_state" != Z* ]]
}

terminate_children() {
  forced=0
  for child_pid in "$api_pid" "$web_pid"; do
    if child_is_alive "$child_pid"; then
      kill -TERM "$child_pid" 2>/dev/null || true
    fi
  done

  attempts=0
  while [[ "$attempts" -lt 50 ]]; do
    if ! child_is_alive "$api_pid" && ! child_is_alive "$web_pid"; then
      break
    fi
    sleep 0.1
    attempts=$((attempts + 1))
  done

  for child_pid in "$api_pid" "$web_pid"; do
    if child_is_alive "$child_pid"; then
      kill -KILL "$child_pid" 2>/dev/null || true
      forced=1
    fi
    if [[ -n "$child_pid" ]]; then
      wait "$child_pid" 2>/dev/null || true
    fi
  done
  return "$forced"
}

cleanup() {
  result=$?
  trap - EXIT HUP INT QUIT TERM
  set +e
  if ! terminate_children; then
    echo "A local demo child required forced termination." >&2
    result=1
  fi
  if [[ -L "$package_link" ]]; then
    actual_link_target="$(readlink "$package_link")"
    if [[ -n "$expected_link_target" && "$actual_link_target" == "$expected_link_target" ]]; then
      rm "$package_link"
    else
      echo "Temporary contracts symlink target changed; refusing to remove it." >&2
      result=1
    fi
  elif [[ -e "$package_link" ]]; then
    echo "Temporary contracts symlink was replaced; refusing to remove the replacement." >&2
    result=1
  fi
  if [[ "$namespace_created" == "1" ]]; then
    rmdir "$package_namespace" 2>/dev/null || true
  fi
  if [[ "$before_snapshot_ready" == "1" ]]; then
    sleep 1
    snapshot_anvil_pids > "$after_pids"
    orphan_pids="$(comm -13 "$before_pids" "$after_pids")"
    if [[ -n "$orphan_pids" ]]; then
      echo "New Anvil process remained after app.close(): $orphan_pids" >&2
      result=1
    fi
  fi
  rm -rf "$temporary_root"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 131' QUIT
trap 'exit 143' TERM

snapshot_anvil_pids > "$before_pids"
before_snapshot_ready=1

if [[ -d "$contracts_source" ]]; then
  if [[ ! -f "$contracts_source/package.json" ]]; then
    echo "GIWA28_CONTRACTS_ROOT must contain package.json." >&2
    exit 2
  fi
  contracts_stage="$temporary_root/contracts-source"
  mkdir -p "$contracts_stage"
  rsync -a \
    --exclude '.git' \
    --exclude 'node_modules' \
    --exclude 'dist' \
    --exclude 'out' \
    --exclude 'cache' \
    --exclude 'broadcast' \
    --exclude '.env' \
    --exclude '.env.*' \
    "$contracts_source/" "$contracts_stage/"
  (
    cd "$contracts_stage"
    npm ci --ignore-scripts
  )
  pack_name="$(
    cd "$contracts_stage"
    npm pack --pack-destination "$temporary_root"
  )"
  contracts_tarball="$temporary_root/$(printf '%s\n' "$pack_name" | tail -n 1)"
elif [[ -f "$contracts_source" && "$contracts_source" == *.tgz ]]; then
  contracts_tarball="$contracts_source"
else
  echo "Contracts input must be a package directory or .tgz file." >&2
  exit 2
fi

consumer_root="$temporary_root/consumer"
mkdir -p "$consumer_root"
(
  cd "$consumer_root"
  npm init --yes >/dev/null
  npm install \
    --no-save \
    --package-lock=false \
    --ignore-scripts \
    "$contracts_tarball"
)
installed_package="$consumer_root/node_modules/@backward-labs/daejang-contracts"
if [[ ! -f "$installed_package/package.json" ]]; then
  echo "Packed contracts package was not installed in the temporary consumer." >&2
  exit 1
fi

if [[ ! -d "$package_namespace" ]]; then
  namespace_created=1
  mkdir -p "$package_namespace"
fi
expected_link_target="$installed_package"
ln -s "$installed_package" "$package_link"

cd "$repo_root"
if [[ "$mode" == "--test" ]]; then
  for review_outcome in APPROVE REJECT; do
    echo
    echo "=== GIWA-28 $review_outcome scenario ==="
    GIWA28_RUN_LOCAL_CONTRACTS_INTEGRATION=1 \
      GIWA28_REVIEW_OUTCOME="$review_outcome" \
      REPORTS_UI_MODE=giwa28-demo \
      npm run test --workspace @daejang/web-api -- \
        --run src/report-attestations/local-v1.integration.test.ts
  done
  exit 0
fi

api_origin="http://127.0.0.1:$api_port"
web_origin="http://127.0.0.1:$web_port"
demo_user_id='00000000-0000-4000-8000-000000000028'
demo_display_name='Giwa Local Demo'

(
  cd "$repo_root"
  exec env \
    -u DATABASE_URL \
    -u ENGINE_GRPC_TARGET \
    -u ENGINE_GRPC_CA_PATH \
    -u ENGINE_GRPC_CERT_PATH \
    -u ENGINE_GRPC_KEY_PATH \
    -u ENGINE_GRPC_SERVER_NAME \
    -u ENGINE_GRPC_INSECURE_TARGET \
    -u PRIVATE_OBJECT_ROOT \
    NODE_ENV=development \
    HOST=127.0.0.1 \
    PORT="$api_port" \
    PUBLIC_ORIGIN="$web_origin" \
    TRUST_PROXY_HOPS=0 \
    REPORTS_UI_MODE=giwa28-demo \
    GIWA28_DEMO_USER_ID="$demo_user_id" \
    GIWA28_DEMO_DISPLAY_NAME="$demo_display_name" \
    GIWA28_REVIEW_OUTCOME="$review_outcome" \
    node --import tsx scripts/run-report-attestation-dev-server.mts
) &
api_pid=$!

(
  cd "$repo_root/apps/web"
  exec env \
    NODE_ENV=development \
    VITE_API_PROXY_TARGET="$api_origin" \
    VITE_WEB_API_BASE_URL=/api/v1 \
    VITE_REPORTS_UI_MODE=giwa28-demo \
    VITE_GIWA28_LOCAL_DEMO=true \
    node "$repo_root/node_modules/vite/bin/vite.js" \
      --host 127.0.0.1 \
      --port "$web_port" \
      --strictPort
) &
web_pid=$!

wait_for_http() {
  url="$1"
  attempts=0
  while [[ "$attempts" -lt 120 ]]; do
    if curl --fail --silent --show-error --max-time 1 "$url" >/dev/null 2>&1; then
      sleep 0.25
      if (
        child_is_alive "$api_pid" &&
        child_is_alive "$web_pid" &&
        curl --fail --silent --show-error --max-time 1 "$url" >/dev/null 2>&1
      ); then
        return 0
      fi
    fi
    if ! child_is_alive "$api_pid" || ! child_is_alive "$web_pid"; then
      return 1
    fi
    sleep 0.25
    attempts=$((attempts + 1))
  done
  return 1
}

if ! wait_for_http "$api_origin/healthz" || ! wait_for_http "$web_origin/"; then
  echo "Local report-attestation demo failed to become ready." >&2
  exit 1
fi

echo "Local report-attestation demo is ready."
echo "Web: $web_origin/reports"
echo "API: $api_origin/"
echo "Review outcome: $review_outcome"
echo "Press Ctrl-C to stop both processes."

while child_is_alive "$api_pid" && child_is_alive "$web_pid"; do
  sleep 0.25
done

if ! child_is_alive "$api_pid"; then
  if wait "$api_pid"; then
    api_status=0
  else
    api_status=$?
  fi
  api_pid=''
  echo "Web API exited unexpectedly with status $api_status." >&2
else
  if wait "$web_pid"; then
    web_status=0
  else
    web_status=$?
  fi
  web_pid=''
  echo "Vite web exited unexpectedly with status $web_status." >&2
fi
exit 1
