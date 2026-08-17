#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
db_dir=${DAEJANG_DB_DIR:-"$repo_root/../daejang-db"}
reviewroom_dir=${DAEJANG_REVIEWROOM_DIR:-"$repo_root/../daejang-reviewroom"}
jit_engine_dir=${DAEJANG_JIT_ENGINE_DIR:-"$repo_root/../daejang-jit-engine"}
# 공유 Docker 데몬이 개인 checkout을 bind-mount할 수 없어 schema는 공용 read-only
# checkout을 기본값으로 사용한다.
schema_dir=${SCHEMA_DIR:-/Users/Shared/Projects/01_Daejang/schema}
wallet_lane=${DAEJANG_DEV_E2E_WALLET:-0}
# 지갑 lane fixture가 selection을 materialize할 주소. 기본값은 hardhat 테스트 키
# #0의 주소이며, 본인 지갑으로 UI 테스트를 하려면 그 주소로 덮어쓴다.
wallet_address=$(printf '%s' "${DAEJANG_DEV_E2E_WALLET_ADDRESS:-0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266}" | LC_ALL=C tr '[:upper:]' '[:lower:]')
registry=${REGISTRY:-backwardlabss-mac-studio.tail344fa1.ts.net}
web_port=${DAEJANG_DEV_E2E_WEB_PORT:-15173}
tax_db_migration_version=${DAEJANG_TAXD_DB_MIGRATION_VERSION:-92}
e2e_suffix=${DAEJANG_E2E_SUFFIX:-}
e2e_subject_id=00000000-0000-4000-8000-00000000e2e1
compose_file="$repo_root/deploy/compose.dev-e2e.yaml"
state_dir=${DAEJANG_DEV_E2E_STATE_DIR:-"$repo_root/.runtime/dev-e2e"}
state_file="$state_dir/state.env"

safe_segment() {
    printf '%s' "$1" | LC_ALL=C tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-'
}

user_segment=$(safe_segment "$(id -un)")
user_segment=${user_segment#-}
user_segment=${user_segment%-}
[[ -n "$user_segment" ]] || user_segment=developer

web_test_image="daejang-web-api:dev-e2e-test-$user_segment"
web_candidate_image="daejang-web-api:dev-e2e-$user_segment"
web_ui_candidate_image="daejang-web-ui:dev-e2e-$user_segment"
engine_candidate_image="daejang-engine:dev-e2e-$user_segment"
parser_candidate_image="daejang-pdf-parser:dev-e2e-$user_segment"
jit_candidate_image="daejang-jit-engine:dev-e2e-$user_segment"
jit_test_image="daejang-jit-engine:dev-e2e-test-$user_segment"
posting_image=${DAEJANG_POSTING_IMAGE:-"$registry/daejang/posting-service:latest"}
tax_engine_image=${DAEJANG_TAX_ENGINE_IMAGE:-"$registry/daejang/tax-engine:latest"}
tax_dev_e2e_image=${DAEJANG_TAX_DEV_E2E_IMAGE:-"$registry/daejang/tax-engine-dev-e2e:latest"}
# main Web 빌드와 같은 팀의 공개 Reown Project ID를 기본값으로 사용한다.
# 다른 Reown 프로젝트를 검증할 때는 DAEJANG_DEV_E2E_REOWN_PROJECT_ID로 덮어쓴다.
reown_project_id=${DAEJANG_DEV_E2E_REOWN_PROJECT_ID:-c5f8295da4fda205b905f32fd523f4c9}

require_command() {
    command -v "$1" >/dev/null 2>&1 || {
        printf '%s 명령을 찾을 수 없습니다.\n' "$1" >&2
        exit 2
    }
}

docker_host_dsn() {
    printf '%s' "$1" | sed 's/@127\.0\.0\.1:/@host.docker.internal:/'
}

docker_host_url() {
    printf '%s' "$1" | sed \
        -e 's#://127\.0\.0\.1:#://host.docker.internal:#' \
        -e 's#://localhost:#://host.docker.internal:#'
}

state_value() {
    local name=$1 line value='' matches=0
    [[ -f "$state_file" ]] || return 0
    while IFS= read -r line || [[ -n "$line" ]]; do
        if [[ "$line" == "$name="* ]]; then
            value=${line#*=}
            matches=$((matches + 1))
        fi
    done < "$state_file"
    if (( matches != 1 )); then
        printf '상태 파일의 %s 값이 없거나 중복되었습니다: %s\n' "$name" "$state_file" >&2
        exit 2
    fi
    printf '%s' "$value"
}

require_state() {
    [[ -f "$state_file" ]] || {
        printf '%s\n' '유지 중인 dev E2E 환경이 없습니다. 먼저 make dev-e2e-up을 실행하세요.' >&2
        exit 2
    }
}

app_compose_from_state() {
    local app_env app_project
    app_env=$(state_value APP_ENV_FILE)
    app_project=$(state_value APP_PROJECT_NAME)
    # wallet profile을 항상 활성화해 down이 wallet lane 컨테이너까지 정리하게 한다.
    # up은 서비스를 명시적으로 지정하므로 wallet 미사용 실행에는 영향이 없다.
    "${compose_command[@]}" --env-file "$app_env" --project-directory "$repo_root" \
        --file "$compose_file" --project-name "$app_project" --profile wallet "$@"
}

db_compose_from_state() {
    local db_env db_project db_root
    db_env=$(state_value DB_ENV_FILE)
    db_project=$(state_value DB_PROJECT_NAME)
    db_root=$(state_value DB_REPO_ROOT)
    "${compose_command[@]}" --env-file "$db_env" --project-directory "$db_root" \
        --file "$db_root/compose.yaml" --project-name "$db_project" "$@"
}

action=${1:-test}
case "$action" in
    test|test-review-giwa|up|run-tests|down|status|logs) ;;
    --run-container-tests|--run-review-container-tests|--run-persistent) ;;
    *)
        printf 'usage: %s {test|test-review-giwa|up|run-tests|down|status|logs}\n' "$0" >&2
        exit 2
        ;;
esac

require_command docker
require_command python3
if docker compose version >/dev/null 2>&1; then
    compose_command=(docker compose)
elif [[ -x /Applications/Docker.app/Contents/Resources/cli-plugins/docker-compose ]]; then
    compose_command=(/Applications/Docker.app/Contents/Resources/cli-plugins/docker-compose)
else
    printf '%s\n' 'Docker Compose를 찾을 수 없습니다.' >&2
    exit 2
fi

if [[ "$action" == down ]]; then
    require_state
    cleanup_status=0
    app_compose_from_state down --volumes --remove-orphans || cleanup_status=1
    db_compose_from_state down --volumes --remove-orphans || cleanup_status=1
    if (( cleanup_status == 0 )); then
        app_env=$(state_value APP_ENV_FILE)
        db_env=$(state_value DB_ENV_FILE)
        db_run_dir=$(dirname -- "$db_env")
        rm -f "$app_env" "$state_file" "$db_env"
        rmdir "$state_dir" "$db_run_dir" 2>/dev/null || true
        printf '%s\n' 'dev E2E의 컨테이너, network, 일회용 DB volume을 제거했습니다.'
    else
        printf '일부 환경을 정리하지 못했습니다. 상태 파일을 유지합니다: %s\n' "$state_file" >&2
        exit 1
    fi
    exit 0
fi

if [[ "$action" == status ]]; then
    require_state
    printf '%s\n' '[application]'
    app_compose_from_state ps
    printf '%s\n' '[database]'
    db_compose_from_state ps
    printf 'Web UI: http://localhost:%s\n' "$(state_value WEB_PORT)"
    exit 0
fi

if [[ "$action" == logs ]]; then
    require_state
    app_compose_from_state logs --follow --tail=200 web-ui web-api engine pdf-parser posting-worker tax-engine
    exit 0
fi

if [[ "$action" == run-tests ]]; then
    require_state
    app_compose_from_state run --rm --no-deps pipeline-verify
    app_compose_from_state run --rm --no-deps web-api-tests
    printf '%s\n' 'PDF → Posting → Ledger → Tax → Report와 Web API 테스트가 통과했습니다. 실행 환경과 일회용 DB는 그대로 유지합니다.'
    exit 0
fi

if [[ "$action" == --run-container-tests || "$action" == --run-review-container-tests || "$action" == --run-persistent ]]; then
    required_variables=(
        DAEJANG_E2E_OWNER_DATABASE_URL DAEJANG_E2E_WEB_DATABASE_URL
        DAEJANG_E2E_SOURCE_DATABASE_URL DAEJANG_E2E_QUERY_DATABASE_URL
        DAEJANG_E2E_REPORT_DATABASE_URL DAEJANG_E2E_EVENT_DATABASE_URL
        DAEJANG_E2E_TAX_DATABASE_URL
    )
    if [[ "$wallet_lane" == 1 ]]; then
        required_variables+=(DAEJANG_E2E_JIT_DATABASE_URL)
    fi
    for required_variable in "${required_variables[@]}"; do
        [[ -n "${!required_variable:-}" ]] || {
            printf '%s is required.\n' "$required_variable" >&2
            exit 2
        }
    done

    if [[ "$action" == --run-container-tests || "$action" == --run-review-container-tests ]]; then
        runtime_dir=$(mktemp -d "${TMPDIR:-/tmp}/daejang-dev-e2e.XXXXXX")
        env_file="$runtime_dir/compose.env"
        project_name="daejang-$user_segment-dev-e2e-$$"
    else
        for required_variable in \
            DAEJANG_DB_DISPOSABLE_PROJECT DAEJANG_DB_ENV_FILE DAEJANG_DB_REPO_ROOT
        do
            [[ -n "${!required_variable:-}" ]] || {
                printf '%s is required.\n' "$required_variable" >&2
                exit 2
            }
        done
        [[ ! -e "$state_file" ]] || {
            printf '이미 유지 중인 dev E2E 환경이 있습니다: %s\n' "$state_file" >&2
            exit 2
        }
        mkdir -p -m 700 "$state_dir"
        chmod 700 "$state_dir"
        runtime_dir=$state_dir
        env_file="$state_dir/compose.env"
        project_name="daejang-$user_segment-dev-ui-$$"
    fi

    umask 077
    {
        printf 'DAEJANG_WEB_API_TEST_IMAGE=%s\n' "$web_test_image"
        printf 'DAEJANG_WEB_API_CANDIDATE_IMAGE=%s\n' "$web_candidate_image"
        printf 'DAEJANG_WEB_UI_CANDIDATE_IMAGE=%s\n' "$web_ui_candidate_image"
        printf 'DAEJANG_ENGINE_CANDIDATE_IMAGE=%s\n' "$engine_candidate_image"
        printf 'DAEJANG_PDF_PARSER_CANDIDATE_IMAGE=%s\n' "$parser_candidate_image"
        printf 'DAEJANG_POSTING_IMAGE=%s\n' "$posting_image"
        printf 'DAEJANG_TAX_ENGINE_IMAGE=%s\n' "$tax_engine_image"
        printf 'DAEJANG_TAX_DEV_E2E_IMAGE=%s\n' "$tax_dev_e2e_image"
        printf 'DAEJANG_TAXD_DB_MIGRATION_VERSION=%s\n' "$tax_db_migration_version"
        printf 'DAEJANG_DEV_E2E_WEB_PORT=%s\n' "$web_port"
        printf 'DAEJANG_E2E_SUBJECT_ID=%s\n' "$e2e_subject_id"
        printf 'DAEJANG_E2E_SUFFIX=%s\n' "$e2e_suffix"
        printf 'RUN_REVIEW_RESOLUTION_E2E_TESTS=%s\n' "${RUN_REVIEW_RESOLUTION_E2E_TESTS:-0}"
        printf 'REVIEWROOM_INTERNAL_API_URL=%s\n' "$REVIEWROOM_INTERNAL_API_URL"
        printf 'REVIEWROOM_APPLICATION_RECEIPT_TOKEN=%s\n' "$REVIEWROOM_APPLICATION_RECEIPT_TOKEN"
        printf 'REVIEWROOM_APPLICATION_RECEIPT_HTTP_TIMEOUT=%s\n' "$REVIEWROOM_APPLICATION_RECEIPT_HTTP_TIMEOUT"
        printf 'REVIEWROOM_DELIVERY_ALLOW_INSECURE_HTTP=%s\n' "$REVIEWROOM_DELIVERY_ALLOW_INSECURE_HTTP"
        printf 'REVIEWROOM_PROOF_VECTOR_TOKEN=%s\n' "${REVIEWROOM_PROOF_VECTOR_TOKEN:-}"
        printf 'ACTIVATION_SHA256=%064d\n' 0
        printf 'PUBLICATION_TRUST_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n'
        printf 'EVM_PUBLICATION_TRUST_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n'
        printf 'DAEJANG_JIT_CANDIDATE_IMAGE=%s\n' "$jit_candidate_image"
        printf 'DAEJANG_JIT_TEST_IMAGE=%s\n' "$jit_test_image"
        printf 'DAEJANG_SCHEMA_DIR=%s\n' "$schema_dir"
        printf 'JIT_DATABASE_URL=%s\n' "$(docker_host_dsn "${DAEJANG_E2E_JIT_DATABASE_URL:-}")"
        printf 'DAEJANG_JIT_DEV_E2E_FROM_ADDRESS=%s\n' "$wallet_address"
        printf 'RUN_EVM_PIPELINE_E2E_TESTS=%s\n' "${RUN_EVM_PIPELINE_E2E_TESTS:-0}"
        printf 'OWNER_DATABASE_URL=%s\n' "$(docker_host_dsn "$DAEJANG_E2E_OWNER_DATABASE_URL")"
        printf 'WEB_DATABASE_URL=%s\n' "$(docker_host_dsn "$DAEJANG_E2E_WEB_DATABASE_URL")"
        printf 'SOURCE_DATABASE_URL=%s\n' "$(docker_host_dsn "$DAEJANG_E2E_SOURCE_DATABASE_URL")"
        printf 'SOURCE_ARTIFACT_DATABASE_URL=%s\n' "$(docker_host_dsn "$DAEJANG_E2E_SOURCE_DATABASE_URL")"
        printf 'QUERY_DATABASE_URL=%s\n' "$(docker_host_dsn "$DAEJANG_E2E_QUERY_DATABASE_URL")"
        printf 'REPORT_DATABASE_URL=%s\n' "$(docker_host_dsn "$DAEJANG_E2E_REPORT_DATABASE_URL")"
        printf 'EVENT_DATABASE_URL=%s\n' "$(docker_host_dsn "$DAEJANG_E2E_EVENT_DATABASE_URL")"
        printf 'TAX_DATABASE_URL=%s\n' "$(docker_host_dsn "$DAEJANG_E2E_TAX_DATABASE_URL")"
    } > "$env_file"

    current_compose=(
        "${compose_command[@]}" --env-file "$env_file" --project-directory "$repo_root"
        --file "$compose_file" --project-name "$project_name"
    )
    if [[ "$wallet_lane" == 1 ]]; then
        current_compose+=(--profile wallet)
    fi

    reviewroom_delivery_pid=''
    reviewroom_delivery_log=''
    cleanup_compose() {
        exit_status=$?
        trap - EXIT
        if [[ -n "$reviewroom_delivery_pid" ]]; then
            kill "$reviewroom_delivery_pid" >/dev/null 2>&1 || true
            wait "$reviewroom_delivery_pid" >/dev/null 2>&1 || true
        fi
        if (( exit_status != 0 )); then
            "${compose_command[@]}" --env-file "$env_file" --project-directory "$repo_root" \
                --file "$compose_file" --project-name "$project_name" \
                logs --no-color --tail=200 posting-worker tax-engine engine web-api || true
            if [[ "$wallet_lane" == 1 ]]; then
                "${compose_command[@]}" --env-file "$env_file" --project-directory "$repo_root" \
                    --file "$compose_file" --project-name "$project_name" --profile wallet \
                    logs --no-color --tail=200 jit-rpc jitd sync-worker posting-evm || true
            fi
            if [[ -n "$reviewroom_delivery_log" && -f "$reviewroom_delivery_log" ]]; then
                printf '%s\n' '[ReviewRoom delivery worker]'
                tail -n 100 "$reviewroom_delivery_log" || true
            fi
        fi
        "${compose_command[@]}" --env-file "$env_file" --project-directory "$repo_root" \
            --file "$compose_file" --project-name "$project_name" --profile wallet \
            down --volumes --remove-orphans >/dev/null 2>&1 || true
        rm -f "$env_file"
        [[ -z "$reviewroom_delivery_log" ]] || rm -f "$reviewroom_delivery_log"
        if [[ "$action" == --run-persistent ]]; then
            rm -f "$state_file"
        fi
        rmdir "$runtime_dir" 2>/dev/null || true
        exit "$exit_status"
    }
    trap cleanup_compose EXIT

    printf '%s\n' '고정 2025 거래와 Posting/Tax runtime 설정을 준비합니다.'
    "${current_compose[@]}" run --rm --no-deps pipeline-permissions
    fixture_state=$("${current_compose[@]}" run --rm --no-deps pipeline-fixture)
    activation_sha=$(printf '%s\n' "$fixture_state" | python3 -c 'import json,sys; print(json.load(sys.stdin)["activationSha256"])')
    publication_trust_key=$(printf '%s\n' "$fixture_state" | python3 -c 'import json,sys; print(json.load(sys.stdin)["publicationTrustKey"])')
    {
        printf 'ACTIVATION_SHA256=%s\n' "$activation_sha"
        printf 'PUBLICATION_TRUST_KEY=%s\n' "$publication_trust_key"
    } >> "$env_file"

    if [[ "$action" == --run-review-container-tests ]]; then
        reviewroom_delivery_log="$runtime_dir/reviewroom-delivery.log"
        printf '%s\n' '일회용 중앙 DB의 ReviewRoom delivery worker를 시작합니다.'
        DOTENV_CONFIG_PATH=/dev/null \
        DOTENV_CONFIG_QUIET=true \
        DAEJANG_DATABASE_URL="$DAEJANG_E2E_EVENT_DATABASE_URL" \
        REVIEWROOM_INTERNAL_API_URL="$REVIEWROOM_DELIVERY_API_URL" \
        REVIEWROOM_RESOLUTION_INGEST_TOKEN="$REVIEWROOM_RESOLUTION_INGEST_TOKEN" \
        REVIEWROOM_DELIVERY_ALLOW_INSECURE_HTTP="$REVIEWROOM_DELIVERY_ALLOW_INSECURE_HTTP" \
        "$reviewroom_dir/node_modules/.bin/tsx" \
            "$reviewroom_dir/src/deliveryWorker.ts" \
            >"$reviewroom_delivery_log" 2>&1 &
        reviewroom_delivery_pid=$!
        sleep 1
        if ! kill -0 "$reviewroom_delivery_pid" >/dev/null 2>&1; then
            wait "$reviewroom_delivery_pid" >/dev/null 2>&1 || true
            printf '%s\n' 'ReviewRoom delivery worker가 시작되지 않았습니다.' >&2
            exit 1
        fi
    fi

    app_services=(web-api posting-worker tax-engine)
    if [[ "$action" == --run-persistent ]]; then
        app_services=(web-ui posting-worker tax-engine)
    fi
    "${current_compose[@]}" up --detach --wait "${app_services[@]}"
    "${current_compose[@]}" run --rm --no-deps pipeline-verify

    if [[ "$wallet_lane" == 1 ]]; then
        printf '%s\n' '지갑(EVM) lane을 준비합니다: jitd fixture selection과 JIT claim policy를 만듭니다.'
        jit_fixture_state=$("${current_compose[@]}" run --rm --no-deps jit-fixture)
        evm_publication_trust_key=$(printf '%s\n' "$jit_fixture_state" | python3 -c 'import json,sys; print(json.load(sys.stdin)["evmPublicationTrustKey"])')
        printf 'EVM_PUBLICATION_TRUST_KEY=%s\n' "$evm_publication_trust_key" >> "$env_file"
        "${current_compose[@]}" run --rm --no-deps jit-permissions
        "${current_compose[@]}" up --detach --wait jit-rpc jitd sync-worker posting-evm
    fi

    if [[ "$action" == --run-container-tests || "$action" == --run-review-container-tests ]]; then
        "${current_compose[@]}" run --rm --no-deps web-api-tests
        exit 0
    fi

    {
        printf 'APP_PROJECT_NAME=%s\n' "$project_name"
        printf 'APP_ENV_FILE=%s\n' "$env_file"
        printf 'DB_PROJECT_NAME=%s\n' "$DAEJANG_DB_DISPOSABLE_PROJECT"
        printf 'DB_ENV_FILE=%s\n' "$DAEJANG_DB_ENV_FILE"
        printf 'DB_REPO_ROOT=%s\n' "$DAEJANG_DB_REPO_ROOT"
        printf 'WEB_PORT=%s\n' "$web_port"
    } > "$state_file"
    trap - EXIT

    printf '\nWeb UI를 계속 실행합니다: http://localhost:%s\n' "$web_port"
    printf '%s\n' '테스트 계정: test@example.test / test1234!'
    printf '%s\n' '2025년 고정 거래의 Posting, Tax, Report 결과가 준비되었습니다.'
    printf '%s\n' '종료할 때만 make dev-e2e-down을 실행하세요.'
    exit 0
fi

require_command gh
[[ -x "$db_dir/scripts/with-disposable-postgres.sh" ]] || {
    printf '일회용 DB 실행기를 찾을 수 없습니다: %s\n' "$db_dir/scripts/with-disposable-postgres.sh" >&2
    exit 2
}
if [[ "$action" == up && -e "$state_file" ]]; then
    printf '%s\n' '이미 유지 중인 dev E2E 환경이 있습니다. make dev-e2e-status로 확인하거나 make dev-e2e-down으로 제거하세요.' >&2
    exit 2
fi
if [[ ! "$tax_db_migration_version" =~ ^[1-9][0-9]*$ ]]; then
    printf '%s\n' 'DAEJANG_TAXD_DB_MIGRATION_VERSION은 양의 정수여야 합니다.' >&2
    exit 2
fi
if [[ ! "$web_port" =~ ^[0-9]+$ ]] || (( web_port < 1 || web_port > 65535 )); then
    printf 'DAEJANG_DEV_E2E_WEB_PORT가 올바른 포트가 아닙니다: %s\n' "$web_port" >&2
    exit 2
fi

if [[ "$action" == test-review-giwa ]]; then
    e2e_suffix=${e2e_suffix:-"review-giwa-$(date -u +%Y%m%d%H%M%S)-$$-$(python3 -c 'import secrets; print(secrets.token_hex(4), end="")')"}
    for required_variable in \
        REVIEWROOM_INTERNAL_API_URL REVIEWROOM_APPLICATION_RECEIPT_TOKEN \
        REVIEWROOM_RESOLUTION_INGEST_TOKEN REVIEWROOM_PROOF_VECTOR_TOKEN
    do
        [[ -n "${!required_variable:-}" ]] || {
            printf '%s is required for test-review-giwa.\n' "$required_variable" >&2
            exit 2
        }
        required_value=${!required_variable}
        if [[ "$required_variable" != REVIEWROOM_INTERNAL_API_URL && ${#required_value} -lt 32 ]]; then
            printf '%s must contain at least 32 characters.\n' "$required_variable" >&2
            exit 2
        fi
    done
    [[ -x "$reviewroom_dir/node_modules/.bin/tsx" && -f "$reviewroom_dir/src/deliveryWorker.ts" ]] || {
        printf '%s\n' 'DAEJANG_REVIEWROOM_DIR에 실행 가능한 ReviewRoom checkout이 필요합니다.' >&2
        exit 2
    }
    require_command curl
    REVIEWROOM_DELIVERY_API_URL=${REVIEWROOM_DELIVERY_API_URL:-$REVIEWROOM_INTERNAL_API_URL}
    REVIEWROOM_DELIVERY_ALLOW_INSECURE_HTTP=${REVIEWROOM_DELIVERY_ALLOW_INSECURE_HTTP:-false}
    if ! curl --fail --silent --max-time 5 \
        "${REVIEWROOM_DELIVERY_API_URL%/}/health" >/dev/null 2>&1
    then
        printf '%s\n' 'ReviewRoom API health check에 실패했습니다.' >&2
        exit 2
    fi
    RUN_REVIEW_RESOLUTION_E2E_TESTS=1
else
    e2e_suffix=${e2e_suffix:-web-account}
    REVIEWROOM_INTERNAL_API_URL=${REVIEWROOM_INTERNAL_API_URL:-http://127.0.0.1:65535}
    REVIEWROOM_APPLICATION_RECEIPT_TOKEN=${REVIEWROOM_APPLICATION_RECEIPT_TOKEN:-$(python3 -c 'import secrets; print(secrets.token_urlsafe(32), end="")')}
    REVIEWROOM_DELIVERY_ALLOW_INSECURE_HTTP=${REVIEWROOM_DELIVERY_ALLOW_INSECURE_HTTP:-true}
    REVIEWROOM_DELIVERY_API_URL=${REVIEWROOM_DELIVERY_API_URL:-$REVIEWROOM_INTERNAL_API_URL}
    RUN_REVIEW_RESOLUTION_E2E_TESTS=${RUN_REVIEW_RESOLUTION_E2E_TESTS:-0}
fi
if [[ ! "$e2e_suffix" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]]; then
    printf '%s\n' 'DAEJANG_E2E_SUFFIX는 1~63자의 소문자 영숫자 및 하이픈만 사용할 수 있습니다.' >&2
    exit 2
fi
REVIEWROOM_APPLICATION_RECEIPT_HTTP_TIMEOUT=${REVIEWROOM_APPLICATION_RECEIPT_HTTP_TIMEOUT:-10s}
REVIEWROOM_INTERNAL_API_URL=$(docker_host_url "$REVIEWROOM_INTERNAL_API_URL")
case "$REVIEWROOM_DELIVERY_ALLOW_INSECURE_HTTP" in
    true|false) ;;
    *)
        printf '%s\n' 'REVIEWROOM_DELIVERY_ALLOW_INSECURE_HTTP는 true 또는 false여야 합니다.' >&2
        exit 2
        ;;
esac
case "$wallet_lane" in
    0|1) ;;
    *)
        printf '%s\n' 'DAEJANG_DEV_E2E_WALLET은 0 또는 1이어야 합니다.' >&2
        exit 2
        ;;
esac
if [[ ! "$wallet_address" =~ ^0x[0-9a-f]{40}$ ]]; then
    printf 'DAEJANG_DEV_E2E_WALLET_ADDRESS가 올바른 EVM 주소가 아닙니다: %s\n' "$wallet_address" >&2
    exit 2
fi
export DAEJANG_DEV_E2E_WALLET_ADDRESS="$wallet_address"
export DAEJANG_DEV_E2E_WALLET="$wallet_lane"
export RUN_EVM_PIPELINE_E2E_TESTS="${RUN_EVM_PIPELINE_E2E_TESTS:-0}"
export DAEJANG_TAXD_DB_MIGRATION_VERSION="$tax_db_migration_version"
export DAEJANG_REVIEWROOM_DIR="$reviewroom_dir"
export DAEJANG_E2E_SUFFIX="$e2e_suffix"
export REVIEWROOM_INTERNAL_API_URL REVIEWROOM_APPLICATION_RECEIPT_TOKEN
export REVIEWROOM_APPLICATION_RECEIPT_HTTP_TIMEOUT REVIEWROOM_DELIVERY_ALLOW_INSECURE_HTTP
export REVIEWROOM_DELIVERY_API_URL RUN_REVIEW_RESOLUTION_E2E_TESTS
export REVIEWROOM_RESOLUTION_INGEST_TOKEN REVIEWROOM_PROOF_VECTOR_TOKEN
if [[ "$action" == up && ! "$reown_project_id" =~ ^[[:xdigit:]]{32}$ ]]; then
    printf '%s\n' 'DAEJANG_DEV_E2E_REOWN_PROJECT_ID는 Reown의 32자리 Project ID여야 합니다.' >&2
    exit 2
fi

runtime_dir=$(mktemp -d "${TMPDIR:-/tmp}/daejang-dev-e2e-build.XXXXXX")
token_file="$runtime_dir/github-token"
plugin_config="$runtime_dir/docker-config"
cleanup_build() {
    exit_status=$?
    trap - EXIT
    rm -rf "$runtime_dir"
    exit "$exit_status"
}
trap cleanup_build EXIT
umask 077
gh auth token > "$token_file"

dependency_images=("$posting_image" "$tax_engine_image" "$tax_dev_e2e_image")
case "${DAEJANG_E2E_SKIP_BASELINE_PULL:-0}" in
    0)
        dependency_images=(
            "$registry/daejang/web-api:latest"
            "$registry/daejang/engine:latest"
            "$registry/daejang/pdf-parser:latest"
            "$registry/daejang/jit-engine:latest"
            "${dependency_images[@]}"
        )
        ;;
    1)
        printf '%s\n' 'Registry 기준 image pull을 생략하고 로컬 후보 및 실행 의존 image만 검증합니다.'
        ;;
    *)
        printf '%s\n' 'DAEJANG_E2E_SKIP_BASELINE_PULL은 0 또는 1이어야 합니다.' >&2
        exit 2
        ;;
esac
printf 'Registry 또는 지정된 최신 기준 이미지 %d개를 확인합니다.\n' "${#dependency_images[@]}"
for full_image in "${dependency_images[@]}"; do
    if [[ "$full_image" == "$registry/"* ]]; then
        docker pull "$full_image"
    else
        docker image inspect "$full_image" >/dev/null
    fi
    digest=$(docker image inspect --format '{{join .RepoDigests " "}}' "$full_image")
    [[ -n "$digest" ]] || digest=$(docker image inspect --format '{{.Id}}' "$full_image")
    printf '  %-64s %s\n' "$full_image" "$digest"
done

if docker buildx version >/dev/null 2>&1; then
    buildx=(docker buildx)
elif [[ -x /Applications/Docker.app/Contents/Resources/cli-plugins/docker-buildx ]]; then
    buildx=(/Applications/Docker.app/Contents/Resources/cli-plugins/docker-buildx)
else
    printf '%s\n' 'Docker Buildx를 찾을 수 없습니다.' >&2
    exit 2
fi

printf '%s\n' '현재 daejang checkout으로 후보 이미지를 만듭니다.'
if [[ "$action" == test || "$action" == test-review-giwa || "$action" == up ]]; then
    "${buildx[@]}" build --load --secret "id=github_token,src=$token_file" \
        --file "$repo_root/apps/web-api/Dockerfile" --target test \
        --tag "$web_test_image" "$repo_root"
fi
"${buildx[@]}" build --load --secret "id=github_token,src=$token_file" \
    --file "$repo_root/apps/web-api/Dockerfile" --target runtime \
    --tag "$web_candidate_image" "$repo_root"
"${buildx[@]}" build --load --secret "id=github_token,src=$token_file" \
    --file "$repo_root/services/engine/Dockerfile" --target engine-runtime \
    --tag "$engine_candidate_image" "$repo_root"
"${buildx[@]}" build --load --secret "id=github_token,src=$token_file" \
    --file "$repo_root/services/engine/Dockerfile" --target parser-runtime \
    --tag "$parser_candidate_image" "$repo_root"
if [[ "$wallet_lane" == 1 ]]; then
    [[ -f "$jit_engine_dir/Dockerfile" ]] || {
        printf 'daejang-jit-engine checkout을 찾을 수 없습니다: %s\n' "$jit_engine_dir" >&2
        printf 'DAEJANG_JIT_ENGINE_DIR=/path/to/owned/daejang-jit-engine 으로 지정하세요.\n' >&2
        exit 2
    }
    [[ -d "$schema_dir/cue.mod" ]] || {
        printf 'schema checkout을 찾을 수 없습니다: %s\n' "$schema_dir" >&2
        printf 'SCHEMA_DIR=/path/to/schema 로 지정하세요.\n' >&2
        exit 2
    }
    "${buildx[@]}" build --load --secret "id=github_token,src=$token_file" \
        --file "$jit_engine_dir/Dockerfile" --target test \
        --tag "$jit_test_image" "$jit_engine_dir"
    "${buildx[@]}" build --load --secret "id=github_token,src=$token_file" \
        --file "$jit_engine_dir/Dockerfile" \
        --tag "$jit_candidate_image" "$jit_engine_dir"
fi
if [[ "$action" == up ]]; then
    "${buildx[@]}" build --load \
        --build-arg "VITE_REOWN_PROJECT_ID=$reown_project_id" \
        --file "$repo_root/apps/web/Dockerfile" --target preview \
        --tag "$web_ui_candidate_image" "$repo_root"
fi

if ! docker compose version >/dev/null 2>&1; then
    compose_plugin=/Applications/Docker.app/Contents/Resources/cli-plugins/docker-compose
    [[ -x "$compose_plugin" ]] || {
        printf '%s\n' 'Docker Compose를 찾을 수 없습니다.' >&2
        exit 2
    }
    mkdir -p "$plugin_config/cli-plugins"
    ln -s "$compose_plugin" "$plugin_config/cli-plugins/docker-compose"
    export DOCKER_CONFIG="$plugin_config"
fi

printf '%s\n' '현재 후보 Web/API와 최신 Posting/Tax를 같은 일회용 DB에 연결합니다.'
db_args=(
    --seed-web-test-account
    --role-env DAEJANG_E2E_OWNER_DATABASE_URL=owner
    --role-env DAEJANG_E2E_WEB_DATABASE_URL=web
    --role-env DAEJANG_E2E_SOURCE_DATABASE_URL=source
    --role-env DAEJANG_E2E_QUERY_DATABASE_URL=query
    --role-env DAEJANG_E2E_REPORT_DATABASE_URL=event
    --role-env DAEJANG_E2E_EVENT_DATABASE_URL=event
    --role-env DAEJANG_E2E_TAX_DATABASE_URL=tax
)
if [[ "$wallet_lane" == 1 ]]; then
    db_args+=(--role-env DAEJANG_E2E_JIT_DATABASE_URL=jit)
fi
if [[ "$action" == up ]]; then
    db_args=(--keep "${db_args[@]}")
fi

case "$action" in
    up) container_action=--run-persistent ;;
    test-review-giwa) container_action=--run-review-container-tests ;;
    *) container_action=--run-container-tests ;;
esac

DAEJANG_LOCAL_TEST_NAME=daejang-dev-e2e \
"$db_dir/scripts/with-disposable-postgres.sh" \
    "${db_args[@]}" \
    -- "$repo_root/scripts/dev-e2e.sh" \
    "$container_action"

if [[ "$action" == test ]]; then
    printf '%s\n' 'daejang dev E2E가 통과했습니다.'
elif [[ "$action" == test-review-giwa ]]; then
    printf '%s\n' '사용자 Review 선택부터 GIWA testnet proof 검증까지 통과했습니다.'
fi
