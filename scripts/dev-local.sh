#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_DIR="${ROOT_DIR}/services/engine"
DB_HOST="${GIWA_LOCAL_DB_HOST:-}"
DB_PORT="${GIWA_LOCAL_DB_PORT:-}"
DB_NAME="${GIWA_LOCAL_DB_NAME:-}"
WEB_PORT="${GIWA_WEB_PORT:-5173}"
API_PORT="${GIWA_API_PORT:-3000}"
ENGINE_PORT="${GIWA_ENGINE_PORT:-50051}"
START_TIMEOUT_SECONDS="${GIWA_DEV_START_TIMEOUT_SECONDS:-90}"
ARTIFACT_BASE="${GIWA_REVIEW_ARTIFACT_BASE:-${TMPDIR:-/tmp}/giwa-final-review-artifacts}"
SOURCE_ARTIFACT_BASE="${GIWA_SOURCE_ARTIFACT_BASE:-${TMPDIR:-/tmp}/giwa-source-artifacts}"
PDF_PARSER_PYTHON="${GIWA_PDF_PARSER_PYTHON_PATH:-${ENGINE_DIR}/.venv-pdf-parser/bin/python}"
PDF_PARSER_RUNTIME_BASE="${GIWA_PDF_PARSER_RUNTIME_BASE:-${TMPDIR:-/tmp}/giwa-pdf-parser-runtime}"
PDF_PARSER_SOCKET="${PDF_PARSER_RUNTIME_BASE}/parser.sock"
START_ENGINE=0
CHECK_ONLY=0

WEB_DATABASE_URL="${GIWA_WEB_DATABASE_URL:-${DATABASE_URL:-}}"
SOURCE_DATABASE_URL="${GIWA_SOURCE_DATABASE_URL:-}"
QUERY_DATABASE_URL="${GIWA_QUERY_DATABASE_URL:-}"
EVENT_DATABASE_URL="${GIWA_EVENT_DATABASE_URL:-}"
REVIEW_DATABASE_URL="${GIWA_REVIEW_DATABASE_URL:-}"

PIDS=()
LABELS=()
CLEANED_UP=0
LAST_STARTED_PID=""

usage() {
  cat <<'EOF'
Usage:
  ./scripts/dev-local.sh
  ./scripts/dev-local.sh --check
  ./scripts/dev-local.sh --with-engine
  ./scripts/dev-local.sh --with-engine --check

Starts the local Web API and frontend together. PostgreSQL must already be
running. Press Ctrl+C once to stop both processes.

--with-engine also starts the local Engine. ReviewService stays disabled unless
GIWA_REVIEW_DATABASE_URL is provided.

Web API database URL lookup order:
  GIWA_WEB_DATABASE_URL
  DATABASE_URL
  DATABASE_URL from apps/web-api/.env

Required with --with-engine:
  GIWA_SOURCE_DATABASE_URL
  GIWA_QUERY_DATABASE_URL
  GIWA_EVENT_DATABASE_URL

Optional overrides:
  GIWA_LOCAL_DB_HOST
  GIWA_LOCAL_DB_PORT
  GIWA_LOCAL_DB_NAME
  GIWA_WEB_PORT
  GIWA_API_PORT
  GIWA_ENGINE_PORT
  GIWA_LOCAL_EMAIL_AUTH_ENABLED
  GIWA_LOCAL_RESEND_API_KEY
  GIWA_LOCAL_EMAIL_FROM
  GIWA_LOCAL_OAUTH_ENABLED_PROVIDERS
  GIWA_LOCAL_OAUTH_TRANSACTION_ENCRYPTION_KEY
  GIWA_DEV_START_TIMEOUT_SECONDS
  GIWA_REVIEW_ARTIFACT_BASE
  GIWA_SOURCE_ARTIFACT_BASE
  GIWA_PDF_PARSER_PYTHON_PATH
  GIWA_PDF_PARSER_RUNTIME_BASE
  GIWA_WEB_DATABASE_URL
  DATABASE_URL
  GIWA_SOURCE_DATABASE_URL
  GIWA_QUERY_DATABASE_URL
  GIWA_EVENT_DATABASE_URL
  GIWA_REVIEW_DATABASE_URL
EOF
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

require_file() {
  [[ -s "$1" ]] || fail "Required file is missing or empty: $1"
}

load_web_database_url() {
  local env_file="${ROOT_DIR}/apps/web-api/.env"

  if [[ -n "$WEB_DATABASE_URL" || ! -f "$env_file" ]]; then
    return 0
  fi
  WEB_DATABASE_URL="$(
    node --env-file-if-exists="$env_file" \
      -e 'if (process.env.DATABASE_URL) process.stdout.write(process.env.DATABASE_URL)'
  )"
}

resolve_database_target() {
  local parsed_target

  parsed_target="$(
    DATABASE_URL="$WEB_DATABASE_URL" node -e '
      try {
        const url = new URL(process.env.DATABASE_URL)
        const database = url.pathname.slice(1) || decodeURIComponent(url.username)
        process.stdout.write([url.hostname, url.port || "5432", database].join("\t"))
      } catch {
        process.exitCode = 1
      }
    '
  )" || fail "Web API DATABASE_URL is not a valid PostgreSQL URL"

  local parsed_host
  local parsed_port
  local parsed_name
  IFS=$'\t' read -r parsed_host parsed_port parsed_name <<<"$parsed_target"
  DB_HOST="${DB_HOST:-$parsed_host}"
  DB_PORT="${DB_PORT:-$parsed_port}"
  DB_NAME="${DB_NAME:-$parsed_name}"
}

validate_port() {
  local label="$1"
  local port="$2"

  [[ "$port" =~ ^[0-9]+$ ]] || fail "${label} must be a number: ${port}"
  ((port >= 1 && port <= 65535)) || fail "${label} is outside 1-65535: ${port}"
}

port_is_open() {
  nc -z "$1" "$2" >/dev/null 2>&1
}

require_free_port() {
  local label="$1"
  local port="$2"

  if lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1; then
    printf 'ERROR: %s port %s is already in use.\n' "$label" "$port" >&2
    lsof -nP -iTCP:"${port}" -sTCP:LISTEN >&2 || true
    exit 1
  fi
}

preflight() {
  require_command curl
  require_command lsof
  require_command nc
  require_command node
  require_command npm
  require_command pgrep
  if ((START_ENGINE == 1)); then
    require_command go
    require_file "$PDF_PARSER_PYTHON"
    require_file "${ENGINE_DIR}/python/pdf_parser_server.py"
  fi

  [[ -d "${ROOT_DIR}/node_modules" ]] || fail "node_modules is missing. Run: cd ${ROOT_DIR} && npm ci"
  load_web_database_url
  [[ -n "$WEB_DATABASE_URL" ]] || fail "Web API DATABASE_URL was not found in GIWA_WEB_DATABASE_URL, DATABASE_URL, or apps/web-api/.env. Use the daejang_web_app connection URL from ../daejang-db/docs/operations.md"
  resolve_database_target
  if ((START_ENGINE == 1)); then
    [[ -n "$SOURCE_DATABASE_URL" ]] || fail "GIWA_SOURCE_DATABASE_URL is required with --with-engine"
    [[ -n "$QUERY_DATABASE_URL" ]] || fail "GIWA_QUERY_DATABASE_URL is required with --with-engine"
    [[ -n "$EVENT_DATABASE_URL" ]] || fail "GIWA_EVENT_DATABASE_URL is required with --with-engine"
  fi

  validate_port "GIWA_LOCAL_DB_PORT" "$DB_PORT"
  validate_port "GIWA_WEB_PORT" "$WEB_PORT"
  validate_port "GIWA_API_PORT" "$API_PORT"
  validate_port "GIWA_ENGINE_PORT" "$ENGINE_PORT"

  if ((START_ENGINE == 1)); then
    require_free_port "Engine" "$ENGINE_PORT"
  fi
  require_free_port "Web API" "$API_PORT"
  require_free_port "Frontend" "$WEB_PORT"

  if ! port_is_open "$DB_HOST" "$DB_PORT"; then
    fail "PostgreSQL is not reachable at ${DB_HOST}:${DB_PORT}. Start giwa-final-local first."
  fi

  if ((START_ENGINE == 1)); then
    mkdir -p "${ARTIFACT_BASE}/objects" "${ARTIFACT_BASE}/tmp" \
      "${SOURCE_ARTIFACT_BASE}/objects" "${SOURCE_ARTIFACT_BASE}/tmp" \
      "$PDF_PARSER_RUNTIME_BASE"
  fi

  printf 'Preflight passed\n'
  printf '  PostgreSQL: %s:%s/%s\n' "$DB_HOST" "$DB_PORT" "$DB_NAME"
  if ((START_ENGINE == 1)); then
    printf '  Engine:     127.0.0.1:%s\n' "$ENGINE_PORT"
  else
    printf '  Engine:     disabled (use --with-engine to enable)\n'
  fi
  printf '  Web API:    http://127.0.0.1:%s\n' "$API_PORT"
  printf '  Frontend:   http://localhost:%s\n' "$WEB_PORT"
}

start_pdf_parser() {
  printf 'Starting isolated PDF parser sidecar...\n'
  (
    exec "$PDF_PARSER_PYTHON" -I -B "${ENGINE_DIR}/python/pdf_parser_server.py" \
      --socket "$PDF_PARSER_SOCKET" \
      --request-timeout-seconds 25
  ) &
  LAST_STARTED_PID="$!"
  PIDS+=("$LAST_STARTED_PID")
  LABELS+=("PDF parser")
}

terminate_tree() {
  local pid="$1"
  local child

  while IFS= read -r child; do
    [[ -n "$child" ]] && terminate_tree "$child"
  done < <(pgrep -P "$pid" 2>/dev/null || true)

  kill -TERM "$pid" 2>/dev/null || true
}

cleanup() {
  local pid

  ((CLEANED_UP == 0)) || return
  CLEANED_UP=1
  trap - EXIT INT TERM HUP

  if [[ -n "$LAST_STARTED_PID" ]]; then
    printf '\nStopping local services...\n'
  fi

  for pid in "${PIDS[@]:-}"; do
    [[ -n "$pid" ]] || continue
    if kill -0 "$pid" 2>/dev/null; then
      terminate_tree "$pid"
    fi
  done

  for pid in "${PIDS[@]:-}"; do
    [[ -n "$pid" ]] || continue
    wait "$pid" 2>/dev/null || true
  done
}

on_signal() {
  cleanup
  exit 130
}

start_engine() {
  local review_artifact_database_url=""
  local review_artifact_root=""
  local review_artifact_temp=""
  if [[ -n "$REVIEW_DATABASE_URL" ]]; then
    review_artifact_database_url="$SOURCE_DATABASE_URL"
    review_artifact_root="${ARTIFACT_BASE}/objects"
    review_artifact_temp="${ARTIFACT_BASE}/tmp"
  fi

  printf 'Starting Engine...\n'
  (
    cd "$ENGINE_DIR"
    exec env \
      ENGINE_LISTEN="127.0.0.1:${ENGINE_PORT}" \
      ENGINE_ALLOW_INSECURE_LOOPBACK=true \
      DAEJANG_SOURCE_DATABASE_URL="$SOURCE_DATABASE_URL" \
      DAEJANG_SOURCE_ARTIFACT_DATABASE_URL="$SOURCE_DATABASE_URL" \
      DAEJANG_SOURCE_ARTIFACT_ROOT="${SOURCE_ARTIFACT_BASE}/objects" \
      DAEJANG_SOURCE_ARTIFACT_TEMP="${SOURCE_ARTIFACT_BASE}/tmp" \
      DAEJANG_QUERY_DATABASE_URL="$QUERY_DATABASE_URL" \
      DAEJANG_REPORT_DATABASE_URL="$EVENT_DATABASE_URL" \
      DAEJANG_REVIEW_DATABASE_URL="$REVIEW_DATABASE_URL" \
      DAEJANG_REVIEW_ARTIFACT_DATABASE_URL="$review_artifact_database_url" \
      DAEJANG_REVIEW_ARTIFACT_ROOT="$review_artifact_root" \
      DAEJANG_REVIEW_ARTIFACT_TEMP="$review_artifact_temp" \
      ENGINE_PDF_PARSER_SOCKET_PATH="$PDF_PARSER_SOCKET" \
      go run ./cmd/engine-api
  ) &
  LAST_STARTED_PID="$!"
  PIDS+=("$LAST_STARTED_PID")
  LABELS+=("Engine")
}

start_api() {
  local engine_grpc_target=""
  if ((START_ENGINE == 1)); then
    engine_grpc_target="127.0.0.1:${ENGINE_PORT}"
  fi

  local api_environment=(
    "NODE_ENV=development"
    "HOST=127.0.0.1"
    "PORT=${API_PORT}"
    "PUBLIC_ORIGIN=http://localhost:${WEB_PORT}"
    "DATABASE_URL=${WEB_DATABASE_URL}"
    "SIGNUP_ENABLED=true"
    "IDENTITY_VERIFICATION_MODE=disabled"
    "EMAIL_AUTH_ENABLED=${GIWA_LOCAL_EMAIL_AUTH_ENABLED:-true}"
    "UPBIT_PDF_IMPORT_ENABLED=true"
    "ENGINE_ALLOW_INSECURE_LOOPBACK=true"
    "ENGINE_GRPC_INSECURE_TARGET=${engine_grpc_target}"
  )
  if [[ -n "${GIWA_LOCAL_RESEND_API_KEY:-}" ]]; then
    api_environment+=(
      "RESEND_API_KEY=${GIWA_LOCAL_RESEND_API_KEY}"
    )
  fi
  if [[ -n "${GIWA_LOCAL_EMAIL_FROM:-}" ]]; then
    api_environment+=(
      "EMAIL_FROM=${GIWA_LOCAL_EMAIL_FROM}"
    )
  fi
  if [[ -n "${GIWA_LOCAL_OAUTH_ENABLED_PROVIDERS:-}" ]]; then
    api_environment+=(
      "OAUTH_ENABLED_PROVIDERS=${GIWA_LOCAL_OAUTH_ENABLED_PROVIDERS}"
    )
  fi
  if [[ -n "${GIWA_LOCAL_OAUTH_TRANSACTION_ENCRYPTION_KEY:-}" ]]; then
    api_environment+=(
      "OAUTH_TRANSACTION_ENCRYPTION_KEY=${GIWA_LOCAL_OAUTH_TRANSACTION_ENCRYPTION_KEY}"
    )
  fi

  printf 'Starting Web API...\n'
  (
    cd "$ROOT_DIR"
    exec env "${api_environment[@]}" npm run dev:api
  ) &
  LAST_STARTED_PID="$!"
  PIDS+=("$LAST_STARTED_PID")
  LABELS+=("Web API")
}

start_web() {
  printf 'Starting frontend...\n'
  (
    cd "$ROOT_DIR"
    exec env \
      VITE_WEB_API_BASE_URL=/api/v1 \
      VITE_API_PROXY_TARGET="http://127.0.0.1:${API_PORT}" \
      npm run dev --workspace @daejang/web -- \
        --host 127.0.0.1 \
        --port "$WEB_PORT" \
        --strictPort
  ) &
  LAST_STARTED_PID="$!"
  PIDS+=("$LAST_STARTED_PID")
  LABELS+=("Frontend")
}

wait_for_port() {
  local label="$1"
  local host="$2"
  local port="$3"
  local pid="$4"
  local elapsed=0

  while ((elapsed < START_TIMEOUT_SECONDS)); do
    if port_is_open "$host" "$port"; then
      printf '%s is ready on %s:%s\n' "$label" "$host" "$port"
      return
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" 2>/dev/null || true
      fail "${label} exited before opening ${host}:${port}"
    fi
    sleep 1
    ((elapsed += 1))
  done

  fail "${label} did not open ${host}:${port} within ${START_TIMEOUT_SECONDS}s"
}

wait_for_socket() {
  local label="$1"
  local path="$2"
  local pid="$3"
  local elapsed=0

  while ((elapsed < START_TIMEOUT_SECONDS)); do
    if [[ -S "$path" ]]; then
      printf '%s is ready at %s\n' "$label" "$path"
      return
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" 2>/dev/null || true
      fail "${label} exited before creating ${path}"
    fi
    sleep 1
    ((elapsed += 1))
  done

  fail "${label} did not create ${path} within ${START_TIMEOUT_SECONDS}s"
}

wait_for_http() {
  local label="$1"
  local url="$2"
  local pid="$3"
  local elapsed=0

  while ((elapsed < START_TIMEOUT_SECONDS)); do
    if curl --silent --show-error --fail --max-time 2 "$url" >/dev/null 2>&1; then
      printf '%s is ready at %s\n' "$label" "$url"
      return
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" 2>/dev/null || true
      fail "${label} exited before ${url} became ready"
    fi
    sleep 1
    ((elapsed += 1))
  done

  fail "${label} did not become ready within ${START_TIMEOUT_SECONDS}s: ${url}"
}

monitor_services() {
  local index
  local pid
  local status
  local api_health_failures=0

  while true; do
    for index in "${!PIDS[@]}"; do
      pid="${PIDS[$index]}"
      if ! kill -0 "$pid" 2>/dev/null; then
        set +e
        wait "$pid"
        status=$?
        set -e
        printf 'ERROR: %s exited with status %s\n' "${LABELS[$index]}" "$status" >&2
        exit "$status"
      fi
    done
    if curl --silent --show-error --fail --max-time 2 \
      "http://127.0.0.1:${API_PORT}/readyz" >/dev/null 2>&1; then
      api_health_failures=0
    else
      ((api_health_failures += 1))
      if ((api_health_failures >= 5)); then
        printf 'ERROR: Web API has been unavailable for %s consecutive checks\n' \
          "$api_health_failures" >&2
        exit 1
      fi
    fi
    sleep 1
  done
}

main() {
  local argument
  for argument in "$@"; do
    case "$argument" in
      --check)
        CHECK_ONLY=1
        ;;
      --with-engine)
        START_ENGINE=1
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        usage >&2
        exit 2
        ;;
    esac
  done

  if ((CHECK_ONLY == 1)); then
    preflight
    exit 0
  fi

  trap cleanup EXIT
  trap on_signal INT TERM HUP

  preflight

  if ((START_ENGINE == 1)); then
    start_pdf_parser
    wait_for_socket "PDF parser" "$PDF_PARSER_SOCKET" "$LAST_STARTED_PID"
    start_engine
    wait_for_port "Engine" 127.0.0.1 "$ENGINE_PORT" "$LAST_STARTED_PID"
  fi

  start_api
  wait_for_http "Web API" "http://127.0.0.1:${API_PORT}/readyz" "$LAST_STARTED_PID"

  start_web
  wait_for_http "Frontend" "http://127.0.0.1:${WEB_PORT}" "$LAST_STARTED_PID"

  printf '\nLocal GIWA stack is ready\n'
  printf '  Open: http://localhost:%s\n' "$WEB_PORT"
  printf '  Stop: Ctrl+C\n\n'

  monitor_services
}

main "$@"
